// service.ts — the discovery service across ALL FIVE lanes. Per-lane ticks: linkedin | indeed via the
// jobspy subprocess (jobspy.ts); greenhouse | lever | ashby via the public JSON boards (ats-boards.ts).
// Every candidate — from either path — funnels through the ONE ingest chokepoint (ingest.ts), so the
// is-a-job gate + the permanent-dismiss check + dedup happen in exactly one place.
//
// The anti-starvation scars from engine-knowledge.md, all encoded here:
//   • SOURCE-SCOPED refill + pacing (v11.83): each lane owns its own discovery_sources row — its own
//     next_earliest_at pacing gate, its own cooldown_until breaker, its own cursor. The refill gate reads
//     ONLY that lane's queued-run depth, so the ATS feed can NEVER starve the LinkedIn lane. A wedged lane
//     sets its OWN cooldown; the others keep running (a per-lane inFlight guard makes them independent).
//   • FRESHNESS RAMP wired into EVERY jobspy path (§1.3): a combo starts at the 72h floor and widens one
//     tier per dry scan (7d→14d→30d), resetting to 72h on a fresh accept — and a SATURATED combo (scanned
//     but no new accept) JUMPS straight to the 30d window (§1.4), never creeping.
//   • SATURATION de-prioritization (§1.4, v11.80): a fully-saturated combo is let through only 1-in-4
//     planner visits (pure reordering — it still runs eventually; effort concentrates on productive combos).
//   • YIELD-ONLY telemetry (§1.13): an empty scan records NOTHING (the discovery_batches CHECK forbids a
//     zero-yield 'ok' batch too); only a rate-limit/error writes a diagnostic row.
//   • Positive keyword + location gates on the ATS boards (§1.11) so a worldwide board can't flood the queue.
//
// jobspy + fetch are injected so the whole service is testable with canned data (no real python, no net).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Dal } from '../db/dal/index.js';
import type { DiscoveryDal, Board, TokenInput } from '../db/dal/discovery.js';
import { ALL_BOARDS } from '../db/dal/discovery.js';
import type { Registry } from '../adapters/registry.js';
import type { Ingest, IngestCandidate } from './ingest.js';
import {
  fetchBoard,
  parseBoard,
  applyGates,
  defaultFetch,
  type Ats,
  type AtsPosting,
  type FetchImpl,
  type Gate,
} from './ats-boards.js';
import { makeJobSpy, type JobSpyRunner, type JobSpyJob } from './jobspy.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- freshness-ramp + saturation constants (ported verbatim from v11 discovery/index.js) ------------

const DAY_MS = 86_400_000;
export const FRESH_BASE_SEC = 259_200; // 72h floor (the prior static behavior)
const FRESH_WIDE_TIERS = [259_200, 604_800, 1_209_600, 2_592_000]; // 72h → 7d → 14d → 30d
export const FRESH_WIDEST_SEC = FRESH_WIDE_TIERS[FRESH_WIDE_TIERS.length - 1]!; // 30d
const SATURATION_WINDOW_MS = 6 * 3600 * 1000; // no NEW accept in 6h ⇒ saturated
export const SKIP_EVERY_N = 4; // a saturated combo is scanned on 1-in-4 visits instead of every visit

/** the next wider freshness tier (caps at 30d). */
export function widerFreshTier(sec: number): number {
  const i = FRESH_WIDE_TIERS.indexOf(Number(sec));
  if (i === -1) return FRESH_BASE_SEC;
  return FRESH_WIDE_TIERS[Math.min(i + 1, FRESH_WIDE_TIERS.length - 1)]!;
}

/** the EFFECTIVE scan window for a combo this tick: never-scanned → 72h floor (newest-first); SATURATED
 *  (scanned but no new accept in >6h) → JUMP straight to 30d; recently-productive → keep its climbed tier. */
export function effectiveFreshTier(
  storedSec: number | null | undefined,
  lastNewAtMs: number | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (storedSec == null) return FRESH_BASE_SEC; // never scanned → newest-first
  if (!lastNewAtMs || nowMs - Number(lastNewAtMs) > SATURATION_WINDOW_MS) return FRESH_WIDEST_SEC; // saturated → widest
  return Number(storedSec) || FRESH_BASE_SEC; // recently productive → keep climbing
}

/** True when a combo has climbed to the widest tier on EVERY board it'd scan on AND none found new work
 *  in the saturation window. (Kept in the v11 shape for test fidelity; the service uses the single-board
 *  form since each jobspy lane is exactly one board.) */
export function isComboSaturated(
  getTierAndLastNew: (source: string, keyword: string, location: string) => { storedSec?: number | null; lastNewAtMs?: number | null } | undefined,
  boards: readonly string[],
  keyword: string,
  location: string,
  nowMs: number = Date.now(),
): boolean {
  const list = boards.filter(Boolean);
  if (!list.length) return false;
  return list.every((source) => {
    const t = getTierAndLastNew(source, keyword, location) ?? {};
    return effectiveFreshTier(t.storedSec, t.lastNewAtMs, nowMs) === FRESH_WIDEST_SEC;
  });
}

/** Given the combo's current down-weight counter, should this tick SKIP a saturated combo? Non-saturated
 *  combos are never skipped. */
export function shouldSkipSaturatedCombo(saturated: boolean, counter: number): boolean {
  if (!saturated) return false;
  return (Number(counter) || 0) + 1 < SKIP_EVERY_N;
}

/** v11 planner: round-robin the FULL keyword×location combo space by a persistent index. */
export function plannerSlot(
  keywords: string[],
  locations: string[],
  index: number,
): { keyword: string; location: string; nextIndex: number } | null {
  const kw = keywords.map((k) => k.trim()).filter(Boolean);
  if (!kw.length) return null;
  const locs = (locations.map((l) => l.trim()).filter(Boolean).length ? locations.map((l) => l.trim()).filter(Boolean) : ['']);
  const total = kw.length * locs.length;
  const slot = (((Number(index) || 0) % total) + total) % total;
  return {
    keyword: kw[Math.floor(slot / locs.length)] ?? '',
    location: locs[slot % locs.length] ?? '',
    nextIndex: (slot + 1) % total,
  };
}

// ---- lane taxonomy --------------------------------------------------------------------------------

const JOBSPY_LANES = ['linkedin', 'indeed'] as const satisfies readonly Board[];
const ATS_LANES = ['greenhouse', 'lever', 'ashby'] as const satisfies readonly Ats[];

function isAts(board: Board): board is Ats {
  return board === 'greenhouse' || board === 'lever' || board === 'ashby';
}
function isJobSpy(board: Board): boolean {
  return board === 'linkedin' || board === 'indeed';
}
/** apply_runs.lane the discovery board's supply feeds (for the source-scoped refill gate). */
function laneOf(board: Board): 'linkedin' | 'indeed' | 'ats' {
  if (board === 'linkedin') return 'linkedin';
  if (board === 'indeed') return 'indeed';
  return 'ats';
}

// ---- config (defensive: unregistered autoApply/discovery keys fall through to code defaults) --------

export interface DiscoveryConfig {
  keywords: string[];
  locations: string[];
  country: string;
  easyApplyOnly: boolean;
  boards: string[]; // which jobspy boards the user enabled
  remote: boolean;
  perRunLimit: number;
  distanceMiles: number;
  combosPerTick: number;
  tokensPerTick: number;
  refillBelow: number;
  intervalMinutes: number;
  enabled: boolean; // discovery master switch (gates scheduled ticks; runOnce/runLane bypass)
}

// ---- cursor bookkeeping (per-jobspy-source, stored in discovery_sources.cursor_json) ---------------

interface ComboEntry {
  tier: number; // stored freshness tier (climbs on dry scans)
  lastNew: number; // ms of the last NEW accept (0 = never)
  skip: number; // saturation down-weight counter
  touched: number; // ms last visited (for pruning)
}
interface JobSpyCursor {
  plannerIndex: number;
  combos: Record<string, ComboEntry>;
}
const MAX_COMBOS_TRACKED = 150; // keep cursor_json under the 16KB CHECK

// ---- results ---------------------------------------------------------------------------------------

export type LaneSkip = 'disabled' | 'cooldown' | 'busy' | 'well_supplied' | 'no_keywords' | 'board_off';

export interface LaneResult {
  board: Board;
  sourceId: string;
  scanned: number; // tokens (ats) / combos (jobspy) attempted
  found: number; // real postings ingested (accepted + duplicate)
  accepted: number; // newly-inserted jobs
  duplicate: number; // re-sighted jobs
  rejected: number; // gate-rejected + dismissed + gate-filtered
  batches: number; // telemetry rows written
  breaker?: string; // set when this tick tripped the lane breaker
  skipped?: LaneSkip;
}

export interface RunOnceResult {
  ranAt: number;
  lanes: LaneResult[];
}

export interface DiscoveryStatus {
  running: boolean;
  lanes: ReturnType<DiscoveryDal['stats']>;
}

export interface DiscoveryService {
  /** scan every enabled lane once (sequentially), bypassing the master switch — the "run now" path. */
  runOnce(): Promise<RunOnceResult>;
  /** scan ONE lane once (enabled + cooldown + refill still respected). */
  runLane(board: Board): Promise<LaneResult>;
  /** start the per-lane scheduler (each tick self-gates on master switch + next_earliest_at + cooldown). */
  start(): void;
  stop(): void;
  status(): DiscoveryStatus;
  isRunning(): boolean;
}

export interface DiscoveryServiceDeps {
  dal: Dal;
  discoveryDal: DiscoveryDal;
  registry: Registry;
  ingest: Ingest;
  /** ms between sequential fetches/scrapes within a lane — politeness pacing (default 0; prod ~1500). */
  spacingMs?: number;
  log?: (msg: string) => void;
  now?: () => number;
  /** the jobspy runner (default = real subprocess wrapper; tests inject a fake). */
  jobspy?: JobSpyRunner;
  /** the ATS board fetch impl (default = platform fetch; tests inject canned JSON). */
  fetchImpl?: FetchImpl;
  /** explicit dir the worker .py + seed .json ship in (packaged: resourceDir('discovery')). */
  discoveryDir?: string;
  /** override the seed token set (tests inject a tiny list). */
  seedTokens?: readonly TokenInput[];
  /** override the settings-derived config (tests inject a fixed config). */
  readConfig?: () => DiscoveryConfig;
  /** how often the scheduler checks lanes for readiness (default 60s). */
  schedulerPollMs?: number;
  /** delay before the first scheduled tick after start() (default 8s). */
  warmupMs?: number;
}

const COOLDOWN_MS = {
  ats_rate: 30 * 60 * 1000, // 30-min lane breaker after a 429/403 (v11)
  jobspy_env: 60 * 60 * 1000, // python/jobspy missing — won't self-heal quickly
  jobspy_block: 30 * 60 * 1000, // rate-limit / captcha
  jobspy_timeout: 10 * 60 * 1000,
  jobspy_other: 15 * 60 * 1000,
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 1024);
}
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asBool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const clampN = (v: unknown, d: number, lo: number, hi: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d;
  return Math.min(Math.max(n, lo), hi);
};

export function makeDiscoveryService(deps: DiscoveryServiceDeps): DiscoveryService {
  const { dal, discoveryDal, ingest } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const spacingMs = deps.spacingMs ?? 0;
  const schedulerPollMs = deps.schedulerPollMs ?? 60_000;
  const warmupMs = deps.warmupMs ?? 8_000;
  const jobspy: JobSpyRunner =
    deps.jobspy ?? makeJobSpy({ ...(deps.discoveryDir ? { discoveryDir: deps.discoveryDir } : {}), log });
  const fetchImpl: FetchImpl = deps.fetchImpl ?? defaultFetch;

  const inFlight = new Set<Board>();
  let seeded = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let warmup: ReturnType<typeof setTimeout> | null = null;
  let seedCache: TokenInput[] | null = null;

  // ---- config -------------------------------------------------------------------------------------

  function setting<T>(section: string, key: string, fallback: T): T {
    try {
      const v = dal.settings.getKey(section, key);
      return v === undefined || v === null ? fallback : (v as T);
    } catch {
      return fallback; // key not registered yet — code default holds (settings owner registers it later)
    }
  }

  function defaultConfig(): DiscoveryConfig {
    return {
      keywords: strArr(setting('autoApply', 'keywords', [])),
      locations: strArr(setting('autoApply', 'locations', [])),
      country: asStr(setting('autoApply', 'country', 'Canada')) || 'Canada',
      easyApplyOnly: asBool(setting('autoApply', 'easyApplyOnly', true), true),
      boards: strArr(setting('autoApply', 'boards', ['linkedin', 'indeed'])),
      remote: strArr(setting('autoApply', 'workModes', [])).includes('remote'),
      perRunLimit: clampN(setting('discovery', 'perRunLimit', 25), 25, 10, 50),
      distanceMiles: clampN(setting('discovery', 'distanceMiles', 0), 0, 0, 100),
      combosPerTick: clampN(setting('discovery', 'combosPerTick', 1), 1, 1, 5),
      tokensPerTick: clampN(setting('discovery', 'tokensPerTick', 10), 10, 1, 50),
      refillBelow: clampN(setting('discovery', 'refillBelow', 20), 20, 0, 1000),
      intervalMinutes: clampN(setting('discovery', 'intervalMinutes', 15), 15, 1, 240),
      enabled: asBool(setting('discovery', 'enabled', true), true),
    };
  }
  const readConfig = deps.readConfig ?? defaultConfig;

  // ---- seeding ------------------------------------------------------------------------------------

  function resolveSeedPath(): string {
    const candidates = [
      process.env.JAT_ATS_SEED,
      deps.discoveryDir ? join(deps.discoveryDir, 'ats-seed-companies.json') : undefined,
      join(HERE, 'ats-seed-companies.json'), // source layout (dev / vitest)
      join(HERE, 'discovery', 'ats-seed-companies.json'), // bundled layout (HERE = dist/main)
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
    for (const p of candidates) {
      try {
        if (existsSync(p)) return p;
      } catch {
        /* try next */
      }
    }
    return join(HERE, 'ats-seed-companies.json');
  }

  function loadSeeds(): TokenInput[] {
    if (deps.seedTokens) return [...deps.seedTokens];
    if (seedCache) return seedCache;
    try {
      const raw: unknown = JSON.parse(readFileSync(resolveSeedPath(), 'utf8'));
      const list = Array.isArray(raw) ? raw : [];
      seedCache = list
        .filter((t): t is { ats: string; token: string } => !!t && typeof t === 'object' && typeof (t as { token?: unknown }).token === 'string')
        .filter((t) => t.ats === 'greenhouse' || t.ats === 'lever' || t.ats === 'ashby')
        .map((t) => ({ ats: t.ats as Ats, token: t.token }));
    } catch (e) {
      log(`discovery: seed load failed (${errMsg(e)}) — ATS lanes start with no tokens`);
      seedCache = [];
    }
    return seedCache;
  }

  /** idempotent: ensure the 5 lane rows exist and the ATS seed tokens are loaded. */
  function ensureSeeded(): void {
    if (seeded) return;
    for (const b of ALL_BOARDS) if (!discoveryDal.sourceGet(b)) discoveryDal.sourceUpsert(b);
    const inserted = discoveryDal.seedTokens(loadSeeds());
    if (inserted > 0) log(`discovery: seeded ${inserted} company token(s)`);
    seeded = true;
  }

  // ---- source-scoped refill gate (reads ONLY this lane's own queued depth — kills v11.83) ----------

  const SLOT_STATES = "('queued','leased','navigating','classifying','driving','verifying','waiting_page')";
  function laneQueuedDepth(board: Board): number {
    const lane = laneOf(board);
    return (
      dal.ctx.db
        .prepare(`SELECT COUNT(*) AS c FROM apply_runs WHERE lane = ? AND state IN ${SLOT_STATES}`)
        .get(lane) as { c: number }
    ).c;
  }

  // ---- candidate mappers --------------------------------------------------------------------------

  function atsToCandidate(p: AtsPosting): IngestCandidate {
    return {
      source: p.source,
      job_url: p.job_url,
      title: p.title,
      company: p.company,
      location: p.location,
      work_mode: p.work_mode,
      employment_type: p.employment_type,
      apply_capability: 'ats_form',
      external_id: p.external_id,
      description: p.description,
    };
  }
  function jobspyToCandidate(j: JobSpyJob, board: Board): IngestCandidate {
    return {
      source: board,
      job_url: j.job_url,
      title: j.title,
      company: j.company,
      location: j.location,
      work_mode: j.remote ? 'remote' : null,
      employment_type: j.employment_type,
      apply_capability: 'unknown', // JobSpy's easy-apply flag is unreliable — verified at apply time
      description: j.description,
    };
  }

  function readGate(cfg: DiscoveryConfig): Gate {
    return { keywords: cfg.keywords, locations: cfg.locations, country: cfg.country };
  }

  function skip(board: Board, sourceId: string, reason: LaneSkip): LaneResult {
    return { board, sourceId, scanned: 0, found: 0, accepted: 0, duplicate: 0, rejected: 0, batches: 0, skipped: reason };
  }

  // ---- ATS lane -----------------------------------------------------------------------------------

  async function runAtsLane(board: Ats, cfg: DiscoveryConfig): Promise<LaneResult> {
    const source = discoveryDal.sourceGet(board) ?? discoveryDal.sourceUpsert(board);
    const gate = readGate(cfg);
    const due = discoveryDal.tokensDue(board, cfg.tokensPerTick);
    let scanned = 0, found = 0, accepted = 0, duplicate = 0, rejected = 0, batches = 0;
    let breaker: string | undefined;

    for (let i = 0; i < due.length; i++) {
      const tok = due[i]!;
      if (i > 0 && spacingMs > 0) await sleep(spacingMs);
      scanned += 1;

      let res;
      try {
        res = await fetchBoard(board, tok.token, fetchImpl);
      } catch (e) {
        discoveryDal.recordBatch({ sourceId: source.id, companyTokenId: tok.id, keyword: tok.token, status: 'error', error: errMsg(e) });
        batches += 1;
        continue; // a network throw is a diagnostic row; the lane keeps going
      }

      if (res.status === 429 || res.status === 403) {
        discoveryDal.recordBatch({ sourceId: source.id, companyTokenId: tok.id, keyword: tok.token, status: 'rate_limited', error: `HTTP ${res.status}` });
        batches += 1;
        breaker = `rate_limited HTTP ${res.status}`;
        break; // trip THIS lane's breaker; the others are unaffected
      }
      if (!res.ok) {
        discoveryDal.tokenScanned(tok.id, { yielded: false }); // 404/5xx = dead scan → dead_count++
        continue;
      }

      const parsed = parseBoard(res.records, board, tok.token);
      const gated = applyGates(parsed, gate);
      if (gated.length === 0) {
        discoveryDal.tokenScanned(tok.id, { yielded: false }); // yield-only: an empty/no-match scan writes nothing
        continue;
      }

      const r = ingest.ingestBatch(gated.map(atsToCandidate), { sourceId: source.id });
      const laneFound = r.accepted + r.duplicate;
      if (laneFound > 0) {
        discoveryDal.recordBatch({
          sourceId: source.id,
          companyTokenId: tok.id,
          keyword: tok.token,
          location: cfg.country,
          status: 'ok',
          found: laneFound,
          accepted: r.accepted,
          duplicate: r.duplicate,
          rejected: parsed.length - gated.length + r.rejected + r.dismissed,
        });
        batches += 1;
        found += laneFound; accepted += r.accepted; duplicate += r.duplicate;
        rejected += parsed.length - gated.length + r.rejected + r.dismissed;
        discoveryDal.tokenScanned(tok.id, { yielded: true });
      } else {
        // everything gated was dismissed/rejected → no real yield → yield-only: record nothing.
        discoveryDal.tokenScanned(tok.id, { yielded: false });
      }
    }

    finishLane(board, source.id, breaker, cfg);
    log(`discovery[${board}] scanned=${scanned} found=${found} accepted=${accepted} dup=${duplicate}`);
    const out: LaneResult = { board, sourceId: source.id, scanned, found, accepted, duplicate, rejected, batches };
    if (breaker) out.breaker = breaker;
    return out;
  }

  // ---- JobSpy lane --------------------------------------------------------------------------------

  function parseCursor(raw: Record<string, unknown>): JobSpyCursor {
    const combosRaw = raw.combos && typeof raw.combos === 'object' ? (raw.combos as Record<string, unknown>) : {};
    const combos: Record<string, ComboEntry> = {};
    for (const [k, v] of Object.entries(combosRaw)) {
      if (v && typeof v === 'object') {
        const e = v as Record<string, unknown>;
        combos[k] = {
          tier: typeof e.tier === 'number' ? e.tier : FRESH_BASE_SEC,
          lastNew: typeof e.lastNew === 'number' ? e.lastNew : 0,
          skip: typeof e.skip === 'number' ? e.skip : 0,
          touched: typeof e.touched === 'number' ? e.touched : 0,
        };
      }
    }
    return { plannerIndex: typeof raw.plannerIndex === 'number' ? raw.plannerIndex : 0, combos };
  }

  /** cap the tracked combo map so cursor_json stays under the 16KB CHECK (drop least-recently-touched). */
  function pruneCombos(combos: Record<string, ComboEntry>): Record<string, ComboEntry> {
    const keys = Object.keys(combos);
    if (keys.length <= MAX_COMBOS_TRACKED) return combos;
    const sorted = keys.sort((a, b) => (combos[a]!.touched) - (combos[b]!.touched));
    const out: Record<string, ComboEntry> = {};
    for (const k of sorted.slice(keys.length - MAX_COMBOS_TRACKED)) out[k] = combos[k]!;
    return out;
  }

  async function runJobSpyLane(board: Board, cfg: DiscoveryConfig): Promise<LaneResult> {
    const source = discoveryDal.sourceGet(board) ?? discoveryDal.sourceUpsert(board);
    // board must be a user-enabled jobspy board (easyApplyOnly keeps linkedin+indeed — v11.60).
    const enabledBoards = cfg.boards.map((b) => b.toLowerCase());
    if (enabledBoards.length && !enabledBoards.includes(board)) return skip(board, source.id, 'board_off');
    if (!cfg.keywords.length) return skip(board, source.id, 'no_keywords');

    const cursor = parseCursor(source.cursor);
    const combos = { ...cursor.combos };
    let plannerIndex = cursor.plannerIndex;

    // --- select up to combosPerTick combos, down-weighting saturated ones (§1.4) ---
    const chosen: { keyword: string; location: string }[] = [];
    const seen = new Set<string>();
    const maxWalk = Math.max(cfg.combosPerTick, Math.min(200, cfg.combosPerTick * SKIP_EVERY_N * 2));
    let staleKey: { keyword: string; location: string } | null = null;
    let staleCounter = -1;
    for (let w = 0; w < maxWalk && chosen.length < cfg.combosPerTick; w++) {
      const q = plannerSlot(cfg.keywords, cfg.locations, plannerIndex);
      if (!q) break;
      const key = `${q.keyword}|${q.location}`;
      if (seen.has(key)) break; // wrapped the whole combo space
      seen.add(key);
      plannerIndex = q.nextIndex;
      const entry = combos[key];
      const saturated = entry != null && effectiveFreshTier(entry.tier, entry.lastNew, now()) === FRESH_WIDEST_SEC;
      const counter = entry?.skip ?? 0;
      if (shouldSkipSaturatedCombo(saturated, counter)) {
        combos[key] = { tier: entry?.tier ?? FRESH_BASE_SEC, lastNew: entry?.lastNew ?? 0, skip: counter + 1, touched: entry?.touched ?? now() };
        if (counter > staleCounter) { staleKey = { keyword: q.keyword, location: q.location }; staleCounter = counter; }
        continue;
      }
      if (saturated && entry) combos[key] = { ...entry, skip: 0 };
      chosen.push({ keyword: q.keyword, location: q.location });
    }
    if (!chosen.length && staleKey) {
      const k = `${staleKey.keyword}|${staleKey.location}`;
      if (combos[k]) combos[k] = { ...combos[k]!, skip: 0 };
      chosen.push(staleKey);
    }

    let scanned = 0, found = 0, accepted = 0, duplicate = 0, rejected = 0, batches = 0;
    let breaker: string | undefined;

    for (let i = 0; i < chosen.length; i++) {
      const combo = chosen[i]!;
      if (i > 0 && spacingMs > 0) await sleep(spacingMs);
      scanned += 1;
      const key = `${combo.keyword}|${combo.location}`;
      const entry = combos[key];
      const tierSec = effectiveFreshTier(entry?.tier, entry?.lastNew ?? 0, now());
      const geo = combo.location.trim() || cfg.country;
      const easyApply = cfg.easyApplyOnly && (board === 'linkedin' || board === 'indeed');

      const res = await jobspy.run({
        source: board,
        keyword: combo.keyword,
        location: geo,
        limit: cfg.perRunLimit,
        hoursOld: Math.round(tierSec / 3600),
        country: cfg.country,
        remote: cfg.remote,
        easyApply,
        distance: cfg.distanceMiles,
      });

      if (!res.ok) {
        // typed failure → a diagnostic batch + THIS lane's breaker (cooldown chosen by the reason).
        const status = res.reason === 'rate_limited' || res.reason === 'blocked' ? 'rate_limited' : 'error';
        discoveryDal.recordBatch({ sourceId: source.id, keyword: combo.keyword, location: geo, status, error: `${res.reason}: ${res.error}`.slice(0, 1024) });
        batches += 1;
        breaker = `${res.reason}: ${res.error}`.slice(0, 200);
        // NOTE: no freshness ramp on an errored scan (v11 rule — a provider error is not a dry scan).
        break;
      }

      const r = ingest.ingestBatch(res.jobs.map((j) => jobspyToCandidate(j, board)), { sourceId: source.id });
      const laneFound = r.accepted + r.duplicate;
      if (laneFound > 0) {
        discoveryDal.recordBatch({
          sourceId: source.id,
          keyword: combo.keyword,
          location: geo,
          status: 'ok',
          found: laneFound,
          accepted: r.accepted,
          duplicate: r.duplicate,
          rejected: r.rejected + r.dismissed,
        });
        batches += 1;
        found += laneFound; accepted += r.accepted; duplicate += r.duplicate; rejected += r.rejected + r.dismissed;
      }
      // freshness ramp AFTER a NON-errored scan: fresh accept → reset to 72h + stamp lastNew; dry → widen.
      const priorTier = entry?.tier ?? FRESH_BASE_SEC;
      combos[key] = {
        tier: r.accepted > 0 ? FRESH_BASE_SEC : widerFreshTier(priorTier),
        lastNew: r.accepted > 0 ? now() : (entry?.lastNew ?? 0),
        skip: 0,
        touched: now(),
      };
    }

    // persist cursor + pacing; clear the breaker on a clean pass (never the one just set this tick).
    finishLane(board, source.id, breaker, cfg, { plannerIndex, combos: pruneCombos(combos) });
    log(`discovery[${board}] scanned=${scanned} found=${found} accepted=${accepted} dup=${duplicate}`);
    const out: LaneResult = { board, sourceId: source.id, scanned, found, accepted, duplicate, rejected, batches };
    if (breaker) out.breaker = breaker;
    return out;
  }

  // ---- shared lane epilogue (pacing + breaker) ----------------------------------------------------

  function finishLane(board: Board, _sourceId: string, breaker: string | undefined, cfg: DiscoveryConfig, cursor?: JobSpyCursor): void {
    const ts = now();
    const intervalMs = cfg.intervalMinutes * 60_000;
    const patch: Parameters<DiscoveryDal['sourceUpsert']>[1] = {
      last_tick_at: ts,
      next_earliest_at: ts + intervalMs, // per-source pacing gate (source-scoped — never shared)
    };
    if (cursor) patch.cursor = { plannerIndex: cursor.plannerIndex, combos: cursor.combos };
    if (breaker) {
      patch.cooldown_until = ts + cooldownForBreaker(board, breaker);
      patch.breaker_reason = breaker;
    } else {
      patch.cooldown_until = null; // clear an EXPIRED breaker on a clean pass
      patch.breaker_reason = null;
    }
    discoveryDal.sourceUpsert(board, patch);
  }

  function cooldownForBreaker(board: Board, reason: string): number {
    if (isAts(board)) return COOLDOWN_MS.ats_rate;
    const r = reason.toLowerCase();
    if (r.startsWith('python_missing') || r.startsWith('jobspy_missing') || r.startsWith('unavailable')) return COOLDOWN_MS.jobspy_env;
    if (r.startsWith('rate_limited') || r.startsWith('blocked')) return COOLDOWN_MS.jobspy_block;
    if (r.startsWith('timeout')) return COOLDOWN_MS.jobspy_timeout;
    return COOLDOWN_MS.jobspy_other;
  }

  // ---- lane entry (gates: enabled → cooldown → busy → refill) --------------------------------------

  async function runLane(board: Board): Promise<LaneResult> {
    ensureSeeded();
    const source = discoveryDal.sourceGet(board) ?? discoveryDal.sourceUpsert(board);
    if (source.enabled !== 1) return skip(board, source.id, 'disabled');
    const t = now();
    if (source.cooldown_until !== null && source.cooldown_until > t) return skip(board, source.id, 'cooldown');
    if (inFlight.has(board)) return skip(board, source.id, 'busy');

    const cfg = readConfig();
    // SOURCE-SCOPED refill gate: reads ONLY this lane's queued depth (the ATS feed can't starve LinkedIn).
    if (laneQueuedDepth(board) >= cfg.refillBelow) return skip(board, source.id, 'well_supplied');

    inFlight.add(board);
    try {
      if (isAts(board)) return await runAtsLane(board, cfg);
      if (isJobSpy(board)) return await runJobSpyLane(board, cfg);
      return skip(board, source.id, 'disabled');
    } finally {
      inFlight.delete(board);
    }
  }

  async function runOnce(): Promise<RunOnceResult> {
    ensureSeeded();
    const lanes: LaneResult[] = [];
    for (const board of ALL_BOARDS) {
      try {
        lanes.push(await runLane(board));
      } catch (e) {
        log(`discovery[${board}] tick error: ${errMsg(e)}`); // a lane body should never throw; if it does, the others still run
      }
    }
    return { ranAt: now(), lanes };
  }

  // ---- scheduler (per-lane readiness; independent; master-switch-gated) ----------------------------

  function schedulerTick(): void {
    const cfg = readConfig();
    if (!cfg.enabled) return; // master switch gates SCHEDULED ticks only (runOnce/runLane bypass)
    const t = now();
    for (const board of ALL_BOARDS) {
      const s = discoveryDal.sourceGet(board);
      if (!s || s.enabled !== 1) continue;
      if (inFlight.has(board)) continue;
      if (s.cooldown_until !== null && s.cooldown_until > t) continue;
      if (s.next_earliest_at !== null && s.next_earliest_at > t) continue;
      // fire-and-forget so lanes run INDEPENDENTLY (each self-guards on inFlight); one hang can't block others.
      void runLane(board).catch((e: unknown) => log(`discovery[${board}] scheduled tick failed: ${errMsg(e)}`));
    }
  }

  function start(): void {
    if (timer) return;
    ensureSeeded();
    warmup = setTimeout(() => schedulerTick(), warmupMs); // start shortly after boot (§1.10)
    timer = setInterval(() => schedulerTick(), schedulerPollMs);
    log(`discovery: scheduler started (poll ${schedulerPollMs}ms, warmup ${warmupMs}ms)`);
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    if (warmup) clearTimeout(warmup);
    timer = null;
    warmup = null;
  }

  function status(): DiscoveryStatus {
    return { running: timer !== null, lanes: discoveryDal.stats() };
  }

  return { runOnce, runLane, start, stop, status, isRunning: () => timer !== null };
}
