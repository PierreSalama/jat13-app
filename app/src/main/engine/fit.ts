// The DETERMINISTIC fit scorer — Stage 3. Scores a job against the active profile with pure,
// explainable arithmetic (zero AI, zero network): keyword/title overlap, location/country match,
// seniority fit, work-mode match, and an apply-capability bonus. The result orders the auto-apply
// queue (best-first) and gates it against a tunable skip floor (default 30). It CACHES every score
// into fit_scores (scorer='deterministic') and syncs the jobs.fit_score cache, so the queue read is
// a cheap ORDER BY and the "why skipped" reasons are already computed.
//
// Ported from v11's proven token-overlap scorer (app/src/fit.js + ai/deterministic.js), reshaped into
// the additive, human-reasoned model the mission-control queue needs (skips must be visible WITH a
// reason — locked decision §2.6). It NEVER throws: a job with no signal scores low with a reason, not
// an error (a broken score must never wedge the pump).
//
// ENGINE-KNOWLEDGE LAW encoded here (research/engine-knowledge.md):
//   • §1 / seniority: over-restrictive seniority was the DOMINANT throughput loss. The seniority
//     penalty is deliberately GENEROUS (a moderate nudge, capped) and always explained in reasons —
//     it lowers a job's rank, it does not hard-drop it. The floor is the user's tunable gate, not this.
//   • §1.11: company-board feeds flood with off-country / off-role postings → positive country + title
//     signals are rewarded, clear off-country is penalized, unknown location stays neutral.
//
// AI SCORER SEAM (Stage 4): fit_scores.scorer already allows 'ai' + a backend column. A future
// makeAiFitService will wrap THIS service — deterministic stays the floor/fallback (no model ⇒ this
// still works, the Dad's-laptop rule), the AI rung refines on demand and writes the same row. The seam
// is this comment + the scorer/backend columns; nothing here calls a CLI.

import type { Dal } from '../db/dal/index.js';
import { makeFitDal, type FloorDecision } from '../db/dal/fit.js';
import type { WorkMode, ApplyCapability } from '../db/dal/jobs.js';

// ---- the settings seam (agent E registers these under section 'autoApply') ------------------------
// KEYS RELIED ON: autoApply.fitFloor (number, default 30), .country (string), .locations (string[]),
// .keywords (string[]), .seniorityMax (string label), .workModes (WorkMode[]). They resolve via
// dal.settings.get('autoApply'). Until that section is registered, every read falls through to a code
// default here (guarded — an unregistered section throws in the settings DAL, which we swallow).
export interface FitSettingsSource {
  /** Nested {key: value} view of a section (the settings DAL's get()). Throws on an unknown section. */
  get(section: string): Record<string, unknown>;
}

/** The normalized, defaulted autoApply knobs this scorer reads. */
interface AutoApplyFit {
  fitFloor: number;
  country: string;
  locations: string[];
  keywords: string[];
  seniorityMax: string;
  workModes: string[];
}

const DEFAULT_FLOOR = 30;

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}
function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ---- scoring constants (one place; tuned so a strong match clamps to ~100 and a clearly off-target
// job lands well under the default floor of 30 — see the header math in the test) -------------------
const BASELINE = 50;
const TITLE_FIRST = 22; // first keyword found in the TITLE — the dominant positive signal
const TITLE_EXTRA = 4; // each additional title keyword
const TITLE_EXTRA_CAP = 12;
const DESC_EACH = 3; // each keyword found only in the description
const DESC_CAP = 9;
const NO_OVERLAP = -28; // keywords configured but ZERO overlap → a strong relevance miss
const COUNTRY_MATCH = 12;
const REMOTE_BONUS = 6;
const COUNTRY_MISMATCH = -30; // clearly a different country and not remote (the flood §1.11)
const LOCATION_CITY_MATCH = 6;
const WORKMODE_MATCH = 8;
const WORKMODE_MISMATCH = -10;
const SENIORITY_FIT = 4;
const SENIORITY_OVER_1 = -15; // one level over the ceiling — GENEROUS (a nudge, not a drop)
const SENIORITY_OVER_2 = -22; // two+ levels over — capped so seniority never dominates the score
const CAP_EASY = 10; // easy_apply / smartapply
const CAP_ATS = 8; // ats_form
const CAP_EXTERNAL = -4;
const CAP_ACCOUNT_WALL = -16;

// ---- text normalization + phrase matching ---------------------------------------------------------
/** lowercase; keep + # . (c++, c#, node.js); everything else → space; collapse. */
function normText(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
/** space-padded normalized text so ` phrase ` membership is a clean word/phrase test. */
function padded(s: unknown): string {
  const n = normText(s);
  return n ? ` ${n} ` : ' ';
}
/** True when `phrase` (already normalized) occurs as a whole word/phrase in a padded haystack. */
function phraseHit(paddedHaystack: string, phrase: string): boolean {
  if (!phrase) return false;
  return paddedHaystack.includes(` ${phrase} `);
}

// role/JD boilerplate that must never count as a candidate keyword (mirrors v11 fit.js STOP).
const STOP = new Set(
  (
    'a an and are as at be by for from has have in is it of on or our the to was we will with you your ' +
    'this that they their than then there what when where who how why job role team work experience ' +
    'years skills required preferred responsibilities qualifications engineer developer'
  ).split(' '),
);

/** Build the candidate keyword set: configured keywords + profile keywords/skills (as phrases) +
 *  role-word tokens from the profile's headline/title (as single tokens). All normalized + deduped. */
function candidateKeywords(profileData: Record<string, unknown>, cfg: AutoApplyFit): Set<string> {
  const out = new Set<string>();
  const addPhrase = (raw: unknown): void => {
    const n = normText(raw);
    if (n && !STOP.has(n)) out.add(n);
  };
  const addTokens = (raw: unknown): void => {
    for (const t of normText(raw).split(' ')) {
      if (t.length >= 2 && !STOP.has(t)) out.add(t);
    }
  };
  // configured keywords are authoritative phrases
  for (const k of cfg.keywords) addPhrase(k);
  // profile arrays: keywords / skills as phrases
  for (const key of ['keywords', 'skills'] as const) {
    const v = profileData[key];
    if (Array.isArray(v)) for (const item of v) addPhrase(item);
    else if (typeof v === 'string') for (const item of v.split(',')) addPhrase(item);
  }
  // role words: headline / title / current role → single tokens (noisier, so token-level)
  for (const key of ['headline', 'title', 'currentTitle', 'current_title', 'role', 'summary']) {
    addTokens(profileData[key]);
  }
  return out;
}

// ---- seniority ranks ------------------------------------------------------------------------------
const RANK_LABEL = ['intern', 'entry', 'mid', 'senior', 'lead/principal', 'director', 'executive'];
/** Map a seniorityMax setting label → a ceiling rank. Unknown/blank ⇒ 6 (no ceiling → be generous). */
const SENIORITY_CEILING: Readonly<Record<string, number>> = {
  intern: 0, internship: 0, coop: 0, 'co-op': 0, trainee: 0,
  entry: 1, junior: 1, jr: 1, graduate: 1, grad: 1, associate: 1, assistant: 1,
  mid: 2, midlevel: 2, 'mid-level': 2, intermediate: 2, ic: 2,
  senior: 3, sr: 3,
  lead: 4, staff: 4, principal: 4, manager: 4,
  director: 5, head: 5, vp: 5,
  executive: 6, exec: 6, chief: 6, clevel: 6, 'c-level': 6,
};
/** Ordered high→low so the FIRST match on a title is the strongest marker present. */
const SENIORITY_PATTERNS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(chief|c[- ]?level|cto|ceo|cfo|coo)\b/, 6],
  [/\b(vp|vice[- ]president|director|head[- ]of|head)\b/, 5],
  [/\b(principal|staff|lead|manager)\b/, 4],
  [/\b(senior|sr)\b/, 3],
  [/\b(mid|intermediate)\b/, 2],
  [/\b(junior|jr|entry|graduate|associate|assistant)\b/, 1],
  [/\b(intern|internship|co-?op|trainee)\b/, 0],
];
/** The seniority rank a job title advertises, or null when it carries no marker. */
function jobSeniority(title: string): number | null {
  const t = normText(title);
  for (const [rx, rank] of SENIORITY_PATTERNS) if (rx.test(t)) return rank;
  return null;
}
function ceilingFor(cfg: AutoApplyFit): number {
  const key = normText(cfg.seniorityMax).replace(/\s+/g, '');
  if (!key) return 6;
  return SENIORITY_CEILING[key] ?? SENIORITY_CEILING[normText(cfg.seniorityMax)] ?? 6;
}

// ---- country markers (home vs foreign) ------------------------------------------------------------
// Compact + extensible. Home is resolved from cfg.country; a location matching a NON-home country's
// markers (and not remote) is a clear off-country miss. Two-letter codes that collide with English
// words (ca/on/ny) are deliberately OMITTED — false positives here would mis-penalize.
const COUNTRY_MARKERS: Readonly<Record<string, readonly string[]>> = {
  canada: [
    'canada', 'canadian', 'ontario', 'quebec', 'québec', 'alberta', 'manitoba', 'saskatchewan',
    'british columbia', 'nova scotia', 'new brunswick', 'newfoundland', 'toronto', 'montreal',
    'montréal', 'vancouver', 'ottawa', 'calgary', 'edmonton', 'winnipeg', 'halifax', 'mississauga',
    'hamilton', 'kitchener', 'waterloo', 'gatineau', 'laval', 'burnaby',
  ],
  'united states': [
    'united states', 'usa', 'u.s.', 'u.s.a', 'california', 'new york', 'texas', 'florida',
    'washington', 'massachusetts', 'illinois', 'georgia', 'colorado', 'san francisco', 'seattle',
    'austin', 'boston', 'chicago', 'los angeles', 'new york city', 'nyc', 'atlanta', 'denver',
    'palo alto', 'mountain view', 'sunnyvale',
  ],
  'united kingdom': ['united kingdom', 'uk', 'england', 'london', 'manchester', 'edinburgh', 'scotland', 'wales', 'bristol'],
  india: ['india', 'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai', 'noida', 'gurgaon'],
  germany: ['germany', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt'],
  france: ['france', 'paris', 'lyon', 'toulouse'],
  australia: ['australia', 'sydney', 'melbourne', 'brisbane'],
  singapore: ['singapore'],
  ireland: ['ireland', 'dublin'],
};
const COUNTRY_ALIAS: Readonly<Record<string, string>> = {
  canada: 'canada', ca: 'canada', can: 'canada',
  'united states': 'united states', usa: 'united states', us: 'united states', 'u.s.': 'united states', america: 'united states',
  uk: 'united kingdom', 'united kingdom': 'united kingdom', england: 'united kingdom', britain: 'united kingdom',
  india: 'india', germany: 'germany', france: 'france', australia: 'australia', singapore: 'singapore', ireland: 'ireland',
};
/** Resolve a configured country string to a marker-set key (or the raw normalized string). */
function homeCountryKey(country: string): string {
  const n = normText(country);
  return COUNTRY_ALIAS[n] ?? n;
}

// ---- the scorer -----------------------------------------------------------------------------------
export interface FitJobInput {
  title: string;
  description?: string;
  location?: string;
  work_mode?: WorkMode | null;
  apply_capability?: ApplyCapability;
}

export interface DeterministicResult {
  score: number;
  reasons: string[];
}

/** Quote up to `n` matched terms for a human reason string: ['react','node'] → "'react','node'". */
function quoteSome(terms: string[], n: number): string {
  return terms.slice(0, n).map((t) => `'${t}'`).join(',');
}

/**
 * The pure deterministic fit computation — no DB, no settings I/O, never throws. Exported so it can be
 * unit-tested in isolation and reused by the AI seam (which blends its signal with this floor).
 */
export function scoreDeterministic(
  job: FitJobInput,
  profileData: Record<string, unknown>,
  cfg: AutoApplyFit,
): DeterministicResult {
  const reasons: string[] = [];
  let score = BASELINE;

  const title = job.title ?? '';
  const paddedTitle = padded(title);
  const paddedDesc = padded(job.description ?? '');

  // 1) KEYWORD / TITLE OVERLAP — the dominant relevance signal.
  const candidates = candidateKeywords(profileData, cfg);
  if (candidates.size === 0) {
    reasons.push('no keywords configured — keyword signal skipped');
  } else {
    const titleMatched: string[] = [];
    const descOnly: string[] = [];
    for (const kw of candidates) {
      if (phraseHit(paddedTitle, kw)) titleMatched.push(kw);
      else if (phraseHit(paddedDesc, kw)) descOnly.push(kw);
    }
    if (titleMatched.length > 0) {
      const extra = Math.min((titleMatched.length - 1) * TITLE_EXTRA, TITLE_EXTRA_CAP);
      score += TITLE_FIRST + extra;
      reasons.push(`+ title matches ${quoteSome(titleMatched, 4)}`);
    }
    if (descOnly.length > 0) {
      score += Math.min(descOnly.length * DESC_EACH, DESC_CAP);
      reasons.push(`+ keywords in description ${quoteSome(descOnly, 3)}`);
    }
    if (titleMatched.length === 0 && descOnly.length === 0) {
      score += NO_OVERLAP;
      reasons.push(`− no overlap with your keywords ${quoteSome([...candidates], 4)}`);
    }
  }

  // 2) LOCATION / COUNTRY.
  const paddedLoc = padded(job.location ?? '');
  const isRemote = job.work_mode === 'remote' || phraseHit(paddedLoc, 'remote') || phraseHit(paddedLoc, 'anywhere');
  if (cfg.country.trim() !== '') {
    const home = homeCountryKey(cfg.country);
    const homeMarkers = COUNTRY_MARKERS[home] ?? [home];
    const homeMatch = homeMarkers.some((m) => phraseHit(paddedLoc, m));
    let foreign = '';
    for (const [key, markers] of Object.entries(COUNTRY_MARKERS)) {
      if (key === home) continue;
      if (markers.some((m) => phraseHit(paddedLoc, m))) {
        foreign = key;
        break;
      }
    }
    if (homeMatch) {
      score += COUNTRY_MATCH;
      reasons.push(`+ location in your target country (${cfg.country})`);
    } else if (isRemote) {
      score += REMOTE_BONUS;
      reasons.push('+ remote-friendly');
    } else if (foreign !== '') {
      score += COUNTRY_MISMATCH;
      reasons.push(`− off-country: appears to be in ${foreign}, not your ${cfg.country}`);
    }
    // else: unknown/blank location → neutral (no signal, no penalty).
  } else if (isRemote) {
    score += REMOTE_BONUS;
    reasons.push('+ remote-friendly');
  }

  // configured target cities/regions (independent of the country lexicon).
  if (cfg.locations.length > 0) {
    const hit = cfg.locations.find((loc) => phraseHit(paddedLoc, normText(loc)));
    if (hit) {
      score += LOCATION_CITY_MATCH;
      reasons.push(`+ location matches your target '${hit}'`);
    }
  }

  // 3) SENIORITY FIT — generous by design (§1: over-restriction was the dominant throughput loss).
  const ceiling = ceilingFor(cfg);
  const jobLevel = jobSeniority(title);
  const effectiveLevel = jobLevel ?? 2; // no marker ⇒ assume mid-level IC
  if (effectiveLevel > ceiling) {
    const over = effectiveLevel - ceiling;
    score += over >= 2 ? SENIORITY_OVER_2 : SENIORITY_OVER_1;
    const jobLabel = jobLevel === null ? 'mid-level' : RANK_LABEL[Math.min(jobLevel, 6)];
    const ceilLabel = cfg.seniorityMax.trim() !== '' ? cfg.seniorityMax : RANK_LABEL[Math.min(ceiling, 6)];
    reasons.push(`− seniority: ${jobLabel} above your ${ceilLabel} ceiling`);
  } else if (jobLevel !== null && ceiling < 6) {
    score += SENIORITY_FIT;
    reasons.push(`+ seniority (${RANK_LABEL[Math.min(jobLevel, 6)]}) within your ceiling`);
  }

  // 4) WORK MODE.
  if (cfg.workModes.length > 0 && job.work_mode) {
    if (cfg.workModes.includes(job.work_mode)) {
      score += WORKMODE_MATCH;
      reasons.push(`+ ${job.work_mode} matches your work modes`);
    } else {
      score += WORKMODE_MISMATCH;
      reasons.push(`− ${job.work_mode} not in your work modes`);
    }
  }

  // 5) APPLY-CAPABILITY BONUS — easier/own-flow apply paths rank above walls/externals.
  switch (job.apply_capability) {
    case 'easy_apply':
    case 'smartapply':
      score += CAP_EASY;
      reasons.push(`+ ${job.apply_capability} (fast, hands-off)`);
      break;
    case 'ats_form':
      score += CAP_ATS;
      reasons.push('+ direct ATS form');
      break;
    case 'external':
      score += CAP_EXTERNAL;
      reasons.push('− external application (harder to auto-apply)');
      break;
    case 'account_wall':
      score += CAP_ACCOUNT_WALL;
      reasons.push('− account wall (likely needs a login)');
      break;
    default:
      break; // unknown → no signal
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

// ---- the service ----------------------------------------------------------------------------------
export interface FitResult {
  score: number;
  reasons: string[];
  floorDecision: FloorDecision;
  /** the floor the score was compared against (surfaced so the queue can show "skipped: 22 < 30"). */
  floorValue: number;
}

export interface FitServiceDeps {
  dal: Dal;
  settings: FitSettingsSource;
}

export interface ScoreEligibleResult {
  profileId: string | null;
  scored: number;
  passed: number;
  skipped: number;
}

export interface FitService {
  /** Compute + CACHE the deterministic fit for one job against a profile. Never throws. */
  scoreFor(jobId: string, profileId: string): FitResult;
  /** The current skip floor (autoApply.fitFloor, default 30). The queue gate reads this. */
  floor(): number;
  /** Batch-score every UNSCORED eligible job for a profile (the pump calls this each tick). */
  scoreEligible(opts?: { profileId?: string; limit?: number }): ScoreEligibleResult;
}

export function makeFitService(deps: FitServiceDeps): FitService {
  const { dal, settings } = deps;
  // The fit DAL is constructed here from the shared ctx — it is deliberately NOT in the Dal aggregate
  // (see db/dal/fit.ts header). Same db handle, same clock, same emit — one writer path preserved.
  const fitDal = makeFitDal(dal.ctx);

  /** Read + default the autoApply knobs; an unregistered section (agent E not wired yet) → defaults. */
  function readAutoApply(): AutoApplyFit {
    let raw: Record<string, unknown> = {};
    try {
      raw = settings.get('autoApply');
    } catch {
      raw = {}; // section not registered yet → every field falls to its code default below.
    }
    return {
      fitFloor: Math.max(0, Math.min(100, asNumber(raw.fitFloor, DEFAULT_FLOOR))),
      country: asString(raw.country),
      locations: asStringArray(raw.locations),
      keywords: asStringArray(raw.keywords),
      seniorityMax: asString(raw.seniorityMax),
      workModes: asStringArray(raw.workModes),
    };
  }

  function floor(): number {
    return readAutoApply().fitFloor;
  }

  function scoreFor(jobId: string, profileId: string): FitResult {
    const floorValue = floor();
    try {
      const cfg = readAutoApply();
      const detail = dal.jobs.getDetail(jobId);
      if (!detail) {
        // No such job — can't cache (FK), return a low honest score with a reason. Never throw.
        return { score: 0, reasons: ['− job not found'], floorDecision: 'skip', floorValue };
      }
      const profile = dal.profiles.get(profileId);
      const profileData = profile?.data ?? {};

      const { score, reasons } = scoreDeterministic(
        {
          title: detail.title,
          description: detail.description,
          location: detail.location,
          work_mode: detail.work_mode,
          apply_capability: detail.apply_capability,
        },
        profileData,
        cfg,
      );
      const floorDecision: FloorDecision = score >= floorValue ? 'pass' : 'skip';

      // CACHE: fit_scores is the queue-ordering authority; jobs.fit_score is the denormalized cache the
      // list projection ships. Only cache when the profile exists (fit_scores FKs profiles).
      if (profile) {
        fitDal.upsert(jobId, profileId, {
          score,
          scorer: 'deterministic',
          reasons,
          floorDecision,
          floorValue,
        });
        dal.jobs.patch(jobId, { fit_score: score });
      }
      return { score, reasons, floorDecision, floorValue };
    } catch (e) {
      // A scoring/caching failure must never wedge the pump — degrade to a low, explained skip.
      const msg = e instanceof Error ? e.message : String(e);
      return { score: 0, reasons: [`− scoring error: ${msg}`], floorDecision: 'skip', floorValue };
    }
  }

  function scoreEligible(opts: { profileId?: string; limit?: number } = {}): ScoreEligibleResult {
    const profileId = opts.profileId ?? dal.profiles.getDefault()?.id;
    if (!profileId) return { profileId: null, scored: 0, passed: 0, skipped: 0 };

    const rawLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 200;
    const limit = Math.min(Math.max(rawLimit, 1), 1000);

    // Engine-layer read (consistent with run-service's raw reads): UNSCORED, live, non-dismissed jobs
    // for this profile, freshest first. dismissed_at IS NULL respects Pierre's permanent-dismiss scar
    // at the fit layer too — a dismissed posting is never even scored. Re-scoring STALE scores (an
    // adapter/profile change) is a later concern; this only fills gaps (f.job_id IS NULL).
    const rows = dal.ctx.db
      .prepare(
        `SELECT j.id AS id
           FROM jobs j
           LEFT JOIN fit_scores f ON f.job_id = j.id AND f.profile_id = @pid
          WHERE j.dismissed_at IS NULL
            AND j.posting_state = 'active'
            AND f.job_id IS NULL
          ORDER BY j.last_seen_at DESC
          LIMIT @limit`,
      )
      .all({ pid: profileId, limit }) as Array<{ id: string }>;

    let passed = 0;
    let skipped = 0;
    for (const r of rows) {
      const res = scoreFor(r.id, profileId);
      if (res.floorDecision === 'pass') passed++;
      else skipped++;
    }
    return { profileId, scored: rows.length, passed, skipped };
  }

  return { scoreFor, floor, scoreEligible };
}
