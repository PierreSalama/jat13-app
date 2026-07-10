// The v11 → v13 importer (Stage 1 — 00-MASTER-PLAN §5/§6). Carries Pierre's (and Dad's) real JAT v11
// data into the v13 schema so NOTHING of forward value is lost, while structurally refusing to carry
// v11's mistakes: stale in-flight tasks, untrusted "success" claims, sensitive/demographic answers,
// and secrets. This file is the cb25d19 importer — which already contains the 13.0.1 fidelity fixes
// (engine-knowledge §14.5) — re-homed onto migration 001_init.sql. Every fidelity rule is KEPT:
//   • reconcileStatus: a job with a real submitted_at can never keep showing pre-submit ("Saved").
//   • run source/lane derived from the JOB row (v11 auto_apply_tasks has NO source column — deriving
//     from the task stamped every Indeed/ATS run 'linkedin').
//   • event kind fallback kind||type (v11's column is `type`), 'email'→email_matched,
//     'resume_tailored'→note.
//   • created_at falls back to updated_at (profiles/fields/qa) — never fabricated as now().
//   • sensitive-key drop (EEO/SSN/DOB/salary-history) on every memory write.
//   • deterministic derived ids (`appl_v11_<jobId>`, `run_v11_<taskId>`) → idempotent re-runs.
//   • evidence-trust quarantine: done-without-trustworthy-evidence → parked/awaiting_review/
//     legacy_untrusted (the schema CHECK makes a dishonest 'submitted' physically unwritable).
//   • plan() and execute() share every decision function, so their counts can never diverge.
//
// Design laws (why this is NOT the per-row DALs — bulk import is the one sanctioned raw-SQL writer
// outside db/dal/, exactly as in the old tree; it runs section-transactional against the same single
// writer handle):
//   1. PRESERVE ids. Jobs/profiles/answers/documents/emails keep their v11 ids; applications and runs
//      get DETERMINISTIC derived ids. INSERT ... ON CONFLICT DO NOTHING on a known key touches nothing
//      already present (a v13 edit made after the first import is never clobbered).
//   2. The SOURCE is never the live file. v11 is LIVE at :7744 — callers snapshot db+wal+shm to a
//      temp dir via `snapshotV11()` and import from the COPY. Belt-and-suspenders: the copy (or any
//      path) is still opened `{ readonly, fileMustExist }` + `query_only = ON`, and a v11 lock
//      directory next to the source is a hard refusal.
//   3. The v13 SCHEMA enforces truth. We pre-clamp/pre-map to the CHECK vocabularies and let the
//      CHECK be the backstop.
//   4. Every table/column is FEATURE-DETECTED (PRAGMA table_info). A missing column degrades
//      gracefully — it NEVER throws.
//   5. Zero hardcoded user paths. The caller passes the source path.
//
// NEW-SCHEMA DELTAS vs the cb25d19 version (adapting, not regressing):
//   • settings: rows are written ONLY through the registry-gated settings DAL, per (section,key),
//     and ONLY for keys registered in SETTINGS_REGISTRY. Unregistered allow-map entries are counted
//     as skipped — they land automatically on a re-import once their stage registers the key.
//   • documents keep BYTES (document_blobs) — a disk restore already cost one library.
//   • apply_ledger: imported VERIFIED submits also write a ledger row (dedup by run_id) so the cap
//     authority stays honest across cutover day — v13 must never re-spend a LinkedIn cap v11 already
//     spent within the window.
//   • fit_scores / autopsies / interviews / ai_calls receive NOTHING from v11: these tables are new
//     v13 concepts (AI fit scoring, run post-mortems, interview pipeline, CLI-call ledger) with no
//     honest v11 counterpart — importing fabricated rows would poison the very features they power.
//   • apply_run_steps receives NOTHING: v11 transcripts are unbounded prose strings; the v13 step
//     table is typed + capped. There is no honest mapping, so imported runs carry steps_count=0.
//   • v11 `punishments` are NOT carried: v13 has no blocklist table — the autopsy pattern-miner +
//     fit floor supersede that mechanism. A source warning records the dropped count.

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeSettingsDal, getSpec, validate } from '../db/dal/settings.js';
import type { DalContext } from '../db/dal/index.js';

// ==================================================================================================
//  normalizers + sensitive-key law — ported VERBATIM from v11 db.js via the old shared/norm.ts and
//  dal/answers.ts (cb25d19), so the v11 dedup keys (job-url hash, per-profile question_norm) map 1:1
//  and ask-once-ever memory survives the cutover. Inlined here because Stage 1 assigns this agent
//  ONLY the importer files; when shared/norm.ts + the answers DAL land, consolidate there and import.
// ==================================================================================================

/** loose slug: lowercase, non-alphanumerics → single spaces. Used for company/label keys. */
export function normKey(s: string | null | undefined): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** query params that identify the posting and must survive URL normalization (id-in-query sites). */
const KEEP_PARAMS = new Set(['currentjobid', 'jk', 'gh_jid', 'gh_src', 'lever-source', 'id']);

/** canonical job URL for dedup: origin+path (no trailing slash), only id-bearing query params kept. */
export function normJobUrl(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (KEEP_PARAMS.has(k.toLowerCase())) keep.set(k.toLowerCase(), v);
    }
    const q = keep.toString();
    return (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase() + (q ? `?${q}` : '');
  } catch {
    return String(raw).toLowerCase();
  }
}

// EN/FR token canonicalization + fillers so "years of experience" == "annees experience", and
// word order / language don't fork the learned-answer key. Ported from v11 db.js QA_CANON/QA_FILLERS.
const QA_CANON: Record<string, string> = {
  francais: 'french', anglais: 'english', espagnol: 'spanish', allemand: 'german',
  annee: 'years', annees: 'years', ans: 'years', an: 'years',
  experiences: 'experience',
  courriel: 'email', mail: 'email', adresse: 'address',
  prenom: 'firstname', telephone: 'phone', tel: 'phone', portable: 'phone',
  ville: 'city', pays: 'country', langue: 'language', langues: 'language',
  numero: 'number', mois: 'months', semaine: 'weeks', semaines: 'weeks',
  niveau: 'level', nom: 'name', noms: 'name',
  parlez: 'speak', parler: 'speak', parle: 'speak', parlons: 'speak',
  salaire: 'salary', remuneration: 'salary', poste: 'position',
  diplome: 'degree', formation: 'education',
  competence: 'skill', competences: 'skill',
  autorisation: 'authorization', autorise: 'authorized',
  travail: 'work', travailler: 'work', travaille: 'work', emploi: 'work',
  disponibilite: 'availability', disponible: 'available', preavis: 'notice',
};

const QA_FILLERS = new Set(
  (
    'please kindly select choose enter provide specify the a an your you do did does ' +
    'are is have has had will would can could how many much what which with in for of to at on ' +
    'veuillez selectionnez choisissez entrez indiquez precisez votre vos le la les un une des du de ' +
    'est sont avez quel quelle quels quelles combien dans pour sur au aux et ou si vous tu ton ta tes'
  ).split(/\s+/),
);

/** bag-of-words key for a screening question: fold diacritics, canonicalize EN/FR, drop fillers,
 *  dedup + SORT so word order and language don't fork the key. Caps at 120 chars. */
export function normQuestion(q: string | null | undefined): string {
  const folded = String(q || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const toks = new Set<string>();
  for (let t of folded.split(/[^a-z0-9]+/)) {
    if (!t) continue;
    t = QA_CANON[t] || t;
    if (QA_FILLERS.has(t)) continue;
    toks.add(t);
  }
  return [...toks].sort().join(' ').slice(0, 120);
}

// SECURITY: protected/demographic/regulated attributes are NEVER imported into learned memory
// (v11.14 SENSITIVE_RX + P0 credential-rail law — engine-knowledge §9.1).
const SENSITIVE_TOKENS = new Set([
  'gender', 'race', 'ethnic', 'ethnicity', 'disability', 'disabled', 'veteran',
  'ssn', 'dob', 'criminal', 'felony', 'felon',
]);
/** Substrings that flag a token (covers folded variants like "disabilities", "ethnicities"). */
const SENSITIVE_FRAGMENTS = ['ethnic', 'disab', 'veteran', 'felon'];
/** Concepts sensitive only when BOTH tokens co-occur (order-independent — normQuestion sorts). */
const SENSITIVE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['salary', 'history'],
  ['social', 'security'],
  ['birth', 'date'],
  ['sexual', 'orientation'],
];

/** True if a normalized key names a protected/demographic/regulated attribute we refuse to store. */
export function isSensitiveKey(keyNorm: string): boolean {
  const norm = String(keyNorm || '').toLowerCase();
  const tokens = norm.split(/[^a-z0-9]+/).filter(Boolean);
  const tokenSet = new Set(tokens);
  for (const t of tokens) {
    if (SENSITIVE_TOKENS.has(t)) return true;
    for (const frag of SENSITIVE_FRAGMENTS) if (t.includes(frag)) return true;
  }
  for (const [a, b] of SENSITIVE_PAIRS) {
    if (tokenSet.has(a) && tokenSet.has(b)) return true;
  }
  // "orientation" alone (sexual-orientation questions frequently drop the "sexual" filler token).
  if (tokenSet.has('orientation')) return true;
  return false;
}

// ==================================================================================================
//  copy-based snapshot — v11 is LIVE at :7744; its jat.db must NEVER be opened directly. Copy
//  db + -wal + -shm to a fresh temp dir and import from the copy (a running v11 can't tear the read).
// ==================================================================================================

export interface V11Snapshot {
  /** path of the snapshot jat.db to hand to planImport/executeImport. */
  path: string;
  /** the temp directory holding the snapshot (caller may rm -rf when done). */
  dir: string;
}

export function snapshotV11(sourcePath: string): V11Snapshot {
  if (!existsSync(sourcePath)) {
    throw new ImportError('NOT_FOUND', `No JAT v11 database at ${sourcePath}.`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'jat11-snap-'));
  const path = join(dir, 'jat.db');
  copyFileSync(sourcePath, path);
  for (const suffix of ['-wal', '-shm'] as const) {
    if (existsSync(sourcePath + suffix)) copyFileSync(sourcePath + suffix, path + suffix);
  }
  return { path, dir };
}

// ---- typed refusals (the UI renders `code`; each is a precondition failure, not a bug) ------------

export type ImportErrorCode =
  | 'V11_LOCK_PRESENT'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_VERSION'
  | 'OPEN_FAILED';

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

// ---- report shape (the dry-run screen renders this; execute returns the same shape with real counts)

export interface SectionCount {
  found: number;
  toCreate: number;
  skippedExisting: number;
}

export interface SettingSkip {
  /** "section.key" of the entry that did not import. */
  key: string;
  reason: 'unregistered' | 'invalid' | 'secret_shaped' | 'already_set';
}

export interface ImportReport {
  source: { path: string; sha256: string; v11_user_version: number; file_bytes: number; warnings: string[] };
  profiles: SectionCount;
  jobs: SectionCount & { mergeDedup: number };
  applications: { toCreate: number; byStatus: Record<string, number> };
  answers: {
    fields: SectionCount & { droppedSensitive: number };
    qa: SectionCount & { droppedSensitive: number };
  };
  documents: SectionCount & { missingFile: number; duplicateSha: number; missingList: { name: string; path: string }[] };
  emails: SectionCount & { matchesToCreate: number; matchesDroppedNoJob: number };
  events: SectionCount & { droppedKinds: Record<string, number> };
  runs: SectionCount & {
    submittedVerified: number;
    quarantinedLegacy: number;
    parked: number;
    failed: number;
    skipped: number;
    droppedInFlight: number;
  };
  settings: { imported: string[]; skipped: SettingSkip[]; defaulted: string };
  sensitiveDropped: number;
  willImport: boolean;
}

export interface ExecuteResult {
  importRunId: string;
  status: 'ok' | 'partial' | 'failed';
  report: ImportReport;
  sectionErrors: { section: string; error: string }[];
}

export interface ExecuteOptions {
  /** epoch-ms clock; injectable so tests are deterministic. */
  now?: () => number;
  /** id source for the import_runs audit row. */
  newId?: (prefix: string) => string;
}

// ---- caps (mirror the migration CHECK constraints — clamp BEFORE the insert so we never throw) ----
const CAP = {
  description: 262_144,
  fitJson: 16_384,
  answersJson: 32_768,
  attachmentsJson: 4_096,
  value: 8_192,
  label: 512,
  docText: 524_288,
  keywordsJson: 4_096,
  emailBody: 65_536,
  error: 2_048,
  parkDetail: 2_048,
  pendingQuestionsJson: 16_384,
  eventData: 4_096,
} as const;

function clampStr(s: unknown, max: number): string {
  const v = s == null ? '' : String(s);
  return v.length > max ? v.slice(0, max) : v;
}

function clampOrNull(s: unknown, max: number): string | null {
  if (s == null) return null;
  const v = String(s);
  return v.length > max ? v.slice(0, max) : v;
}

// ---- ISO / mixed timestamp → epoch-ms (v11 stored ISO strings AND epoch numbers in places) --------
function toEpochMs(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Heuristic: seconds vs ms. Anything below ~ year 2001 in ms is almost certainly seconds.
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  const s = String(v);
  const n = Number(s);
  if (Number.isFinite(n) && /^\d+$/.test(s.trim())) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---- JSON coercion: keep a valid-JSON string (the CHECK is json_valid), else a safe default -------
function jsonOrDefault(raw: unknown, def: string, max: number): string {
  if (raw == null) return def;
  let s: string;
  if (typeof raw === 'string') {
    s = raw;
  } else {
    try {
      s = JSON.stringify(raw);
    } catch {
      return def;
    }
  }
  try {
    JSON.parse(s);
  } catch {
    return def;
  }
  if (s.length > max) return def; // oversized-but-valid JSON is dropped, not truncated (truncation breaks JSON).
  return s;
}

// ---- feature detection -----------------------------------------------------------------------------
interface TableShape {
  exists: boolean;
  cols: Set<string>;
}

function tableShape(db: DB, table: string): TableShape {
  // table_info returns [] for a nonexistent table (never throws). Identifier is a literal, not user input.
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[];
  return { exists: rows.length > 0, cols: new Set(rows.map((r) => r.name)) };
}

/** Quote a SQLite identifier for a PRAGMA (defence-in-depth; table names here are all literals). */
function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/** Read a column from a row only if the source table actually has it (graceful degrade). */
function col(row: Record<string, unknown>, shape: TableShape, name: string): unknown {
  return shape.cols.has(name) ? row[name] : undefined;
}

function selectExisting(db: DB, table: string, shape: TableShape): Record<string, unknown>[] {
  if (!shape.exists) return [];
  return db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Record<string, unknown>[];
}

// ---- status vocabulary maps (v11 → the 001_init CHECK vocab) --------------------------------------

const V13_APPLICATION_STATUSES = new Set([
  'tracked', 'submitted', 'acknowledged', 'assessment',
  'interview_1', 'interview_2', 'interview_final',
  'offer', 'hired', 'rejected', 'withdrawn', 'ghosted',
]);

/** v11 lifecycle status → v13 status. Unknown → 'tracked' (never throw on an unrecognized status). */
function mapApplicationStatus(v11: unknown): string {
  const s = String(v11 ?? '').trim().toLowerCase();
  const explicit: Record<string, string> = {
    started: 'tracked',
    contacted: 'acknowledged',
    applied: 'submitted',
    submitted: 'submitted',
    new: 'tracked',
    tracked: 'tracked',
    saved: 'tracked',
    acknowledged: 'acknowledged',
    assessment: 'assessment',
    interview: 'interview_1',
    interview_1: 'interview_1',
    interview_2: 'interview_2',
    interview_final: 'interview_final',
    offer: 'offer',
    hired: 'hired',
    rejected: 'rejected',
    withdrawn: 'withdrawn',
    ghosted: 'ghosted',
  };
  if (explicit[s]) return explicit[s]!;
  return V13_APPLICATION_STATUSES.has(s) ? s : 'tracked';
}

/** Pre-submit statuses that a recorded submit must override — a job with a real submitted_at can't
 *  keep showing as "Saved" (13.0.1 scar 14.5). v11 often stored the applied timestamp but left the
 *  status pre-submit; this reconciles the two so the Applications list + the funnel agree. */
const PRE_SUBMIT = new Set(['tracked']);
export function reconcileStatus(mapped: string, submittedAt: number | null): string {
  if (submittedAt != null && PRE_SUBMIT.has(mapped)) return 'submitted';
  return mapped;
}

// ---- evidence trust test (ported from v11's isTrustworthyEvidence quarantine logic) ---------------

const V13_EVIDENCE_KINDS = new Set([
  'text_became_success', 'new_confirmation_node', 'confirm_signal',
  'url_confirmation', 'modal_close_confirmed', 'manual_confirmed',
]); // NB: 'legacy_untrusted' is deliberately excluded — it can never gate a 'submitted' state.

/**
 * Map v11 submission_evidence → a trustworthy v13 evidence_kind, or null if the evidence does not
 * clear the bar. v11 stored evidence either as a JSON object ({ type, detail, ... }) or a bare string.
 * The 001_init CHECK forbids state='submitted' unless the evidence_kind is trustworthy — so a done
 * task whose evidence we cannot vouch for becomes a PARKED 'awaiting_review' run tagged 'legacy_untrusted'.
 */
function mapEvidenceKind(evidence: unknown): string | null {
  if (evidence == null || evidence === '') return null;
  let type = '';
  let detail = '';
  if (typeof evidence === 'string') {
    const trimmed = evidence.trim();
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        type = String(obj.type ?? obj.kind ?? '').toLowerCase();
        detail = String(obj.detail ?? obj.reason ?? '').toLowerCase();
      } catch {
        type = trimmed.toLowerCase();
      }
    } else {
      type = trimmed.toLowerCase();
    }
  } else if (typeof evidence === 'object') {
    const obj = evidence as Record<string, unknown>;
    type = String(obj.type ?? obj.kind ?? '').toLowerCase();
    detail = String(obj.detail ?? obj.reason ?? '').toLowerCase();
  }

  const hay = `${type} ${detail}`;
  if (V13_EVIDENCE_KINDS.has(type)) return type;
  if (hay.includes('text-became-success') || hay.includes('text_became_success')) return 'text_became_success';
  if (hay.includes('new-confirmation-node') || hay.includes('new_confirmation_node')) return 'new_confirmation_node';
  if (hay.includes('confirm-signal') || hay.includes('confirm_signal')) return 'confirm_signal';
  if (hay.includes('modal-close') || hay.includes('modal_close')) return 'modal_close_confirmed';
  if (hay.includes('manual')) return 'manual_confirmed';
  // Indeed 'type:verified detail:confirmation' and url/confirmation → url_confirmation.
  if (type === 'url' || hay.includes('url') || hay.includes('confirmation')) return 'url_confirmation';
  if (type === 'verified' || hay.includes('verified')) {
    if (hay.includes('text')) return 'text_became_success';
    return 'url_confirmation';
  }
  return null;
}

/** v11 park_reason keyword → v13 park_kind vocabulary. */
function mapParkKind(reason: unknown): string {
  const s = String(reason ?? '').toLowerCase();
  if (s.includes('captcha')) return 'captcha';
  if (s.includes('cloudflare')) return 'cloudflare';
  if (s.includes('login') || s.includes('signin') || s.includes('sign-in')) return 'login';
  if (s.includes('wall') || s.includes('account')) return 'account_wall';
  if (s.includes('resume') || s.includes('cv')) return 'resume_required';
  if (s.includes('answer') || s.includes('question')) return 'needs_answer';
  if (s.includes('review')) return 'awaiting_review';
  if (s.includes('redirect') || s.includes('external')) return 'external_redirect';
  if (s.includes('rate') || s.includes('throttl')) return 'rate_limited';
  return 'other';
}

/** v11 apply_route → v13 route vocabulary (null if unmappable). */
function mapRoute(route: unknown): string | null {
  const s = String(route ?? '').toLowerCase().replace(/-/g, '_');
  if (s === 'easy_apply' || s === 'easyapply') return 'easy_apply';
  if (s === 'smartapply' || s === 'smart_apply') return 'smartapply';
  if (s === 'ats_form' || s === 'ats' || s === 'form') return 'ats_form';
  if (s === 'external') return 'external';
  return null;
}

/** Pick a v13 lane from the JOB's source + route (CHECK: linkedin|indeed|ats). */
function mapLane(source: unknown, route: string | null): string {
  const s = String(source ?? '').toLowerCase();
  if (s.includes('linkedin')) return 'linkedin';
  if (s.includes('indeed')) return 'indeed';
  if (route === 'ats_form' || route === 'external' || route === 'smartapply') return 'ats';
  return 'linkedin';
}

/** documents.role mapping (v11 used camelCase 'coverLetter'). */
function mapDocRole(role: unknown): string {
  const s = String(role ?? 'resume').toLowerCase().replace(/[^a-z]/g, '');
  if (s === 'coverletter' || s === 'cover') return 'cover_letter';
  if (s === 'resume' || s === 'cv') return 'resume';
  if (s === 'portfolio') return 'portfolio';
  if (s === 'transcript') return 'transcript';
  return 'other';
}

/** learned_answers.field_type normalization (unknown → 'text'; null stays null). */
const V13_FIELD_TYPES = new Set(['text', 'textarea', 'select', 'radio', 'checkbox', 'number', 'date', 'file']);
function mapFieldType(ft: unknown): string | null {
  if (ft == null || ft === '') return null;
  const s = String(ft).toLowerCase();
  return V13_FIELD_TYPES.has(s) ? s : 'text';
}

/** email_matches.source vocabulary. */
function mapMatchSource(src: unknown): string {
  const s = String(src ?? 'auto').toLowerCase();
  if (s === 'manual') return 'manual';
  if (s === 'suggested') return 'suggested';
  if (s === 'dismissed') return 'dismissed';
  return 'auto';
}

// ---- settings allow-map (never a blind copy; secrets NEVER imported) ------------------------------
// Each entry: v11 section.key → v13 (section, key). The REGISTRY is the second gate: only entries
// whose v13 (section,key) is registered in SETTINGS_REGISTRY actually write — the rest are counted
// skipped/unregistered and land automatically on a re-import once their stage registers the key
// (Stage 3 registers autoApply.*; Stage 5 registers gmail.*).
const SETTINGS_ALLOW: { v11Section: string; v11Key: string; v13Section: string; v13Key: string }[] = [
  { v11Section: 'autoApply', v11Key: 'keywords', v13Section: 'autoApply', v13Key: 'keywords' },
  { v11Section: 'autoApply', v11Key: 'locations', v13Section: 'autoApply', v13Key: 'locations' },
  { v11Section: 'autoApply', v11Key: 'workModes', v13Section: 'autoApply', v13Key: 'workModes' },
  { v11Section: 'autoApply', v11Key: 'country', v13Section: 'autoApply', v13Key: 'country' },
  { v11Section: 'autoApply', v11Key: 'seniorityMax', v13Section: 'autoApply', v13Key: 'seniorityMax' },
  { v11Section: 'autoApply', v11Key: 'easyApplyOnly', v13Section: 'autoApply', v13Key: 'easyApplyOnly' },
  { v11Section: 'autoApply', v11Key: 'maxPerDay', v13Section: 'autoApply', v13Key: 'maxPerDay' },
  { v11Section: 'autoApply', v11Key: 'maxPerHour', v13Section: 'autoApply', v13Key: 'maxPerHour' },
  // v11 'appearance.theme' is deliberately NOT mapped onto v13 'appearance.themeId' — different
  // vocabularies (v11 theme names vs the Atelier theme registry); the registry gate skips it.
  { v11Section: 'appearance', v11Key: 'theme', v13Section: 'appearance', v13Key: 'theme' },
];
/** notifications.* is a whole-section allow (any key under it, minus obvious secret-shaped keys). */
const SETTINGS_ALLOW_SECTIONS = new Set(['notifications']);
/** Keys that look like secrets and are dropped even inside an allowed section. */
const SECRET_KEY_RX = /(apikey|api_key|secret|token|password|clientsecret|oauth|refresh|access_token)/i;

// ==================================================================================================
//  SHAPE READ — one read-only pass that both plan() and execute() build on. Zero v13 writes.
// ==================================================================================================

interface SourceHandle {
  db: DB;
  sha256: string;
  userVersion: number;
  fileBytes: number;
  path: string;
  warnings: string[];
  shapes: Record<string, TableShape>;
}

const SUPPORTED_MIN_VERSION = 6;

/** Open the SOURCE v11 db (a snapshot copy) read-only, after the lock gate. Feature-detect tables. */
function openSource(sourcePath: string): SourceHandle {
  if (!existsSync(sourcePath)) {
    throw new ImportError('NOT_FOUND', `No JAT v11 database at ${sourcePath}.`);
  }
  // Lock gate: `jat.db.lock` is a DIRECTORY (node-sqlite3-wasm mkdir-lock) sitting next to the source.
  // A snapshot copy never has one — this only trips when someone points directly at the live file.
  const lockDir = join(dirname(sourcePath), 'jat.db.lock');
  if (existsSync(lockDir) && statSync(lockDir).isDirectory()) {
    throw new ImportError(
      'V11_LOCK_PRESENT',
      'That looks like the LIVE v11 database (its jat.db.lock is present). Import from a snapshot copy (snapshotV11) instead — the live file is never opened.',
    );
  }

  const bytes = readFileSync(sourcePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fileBytes = bytes.length;

  let db: DB;
  try {
    db = new Database(sourcePath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON'); // belt-and-suspenders: the handle physically cannot write.
  } catch (e) {
    throw new ImportError('OPEN_FAILED', `Could not open the v11 database read-only: ${(e as Error).message}`);
  }

  const userVersion = db.pragma('user_version', { simple: true }) as number;
  const warnings: string[] = [];
  if (userVersion < SUPPORTED_MIN_VERSION) {
    db.close();
    throw new ImportError(
      'UNSUPPORTED_VERSION',
      `This v11 database (schema v${userVersion}) predates per-profile memory (needs v${SUPPORTED_MIN_VERSION}+). Update v11 and re-open it once before importing.`,
    );
  }

  const tables = [
    'profiles', 'jobs', 'profile_fields', 'qa', 'documents', 'emails', 'events',
    'auto_apply_tasks', 'settings', 'kv', 'punishments',
  ];
  const shapes: Record<string, TableShape> = {};
  for (const t of tables) shapes[t] = tableShape(db, t);

  return { db, sha256, userVersion, fileBytes, path: sourcePath, warnings, shapes };
}

// ---- profile resolver ------------------------------------------------------------------------------
/**
 * Resolve the v13 profile_id for a v11 job/application. v11 assigned sources to profiles via
 * `source_assignments`; if a source is unassigned (or there's only one profile) it falls to the
 * default profile. Built once from the profiles the import will create.
 */
interface ProfileResolver {
  defaultProfileId: string;
  resolve: (source: unknown) => string;
}

function buildProfileResolver(profileRows: Record<string, unknown>[], shape: TableShape): ProfileResolver {
  let defaultId = '';
  const sourceToProfile = new Map<string, string>();

  for (const p of profileRows) {
    const id = String(col(p, shape, 'id') ?? '');
    if (!id) continue;
    const isDefault = Number(col(p, shape, 'is_default') ?? 0) === 1;
    if (isDefault && !defaultId) defaultId = id;
    const rawAssign = col(p, shape, 'source_assignments');
    if (rawAssign != null) {
      try {
        const parsed: unknown = typeof rawAssign === 'string' ? JSON.parse(rawAssign) : rawAssign;
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            const key = typeof entry === 'string' ? entry : String((entry as Record<string, unknown>)?.source ?? '');
            if (key) sourceToProfile.set(key.toLowerCase(), id);
          }
        }
      } catch {
        /* malformed assignments → ignore, fall back to default */
      }
    }
  }

  // If no profile flagged default, adopt the first profile as default (v11 single-profile installs).
  if (!defaultId && profileRows.length > 0) {
    defaultId = String(col(profileRows[0]!, shape, 'id') ?? '');
  }

  return {
    defaultProfileId: defaultId,
    resolve: (source: unknown) => {
      const key = String(source ?? '').toLowerCase();
      return sourceToProfile.get(key) ?? defaultId;
    },
  };
}

// ==================================================================================================
//  PLAN (dry run) — read-only over the source; touches NOTHING in v13.
// ==================================================================================================

export function planImport(sourcePath: string): ImportReport {
  const src = openSource(sourcePath);
  try {
    return buildReport(src, null);
  } finally {
    src.db.close();
  }
}

// ==================================================================================================
//  EXECUTE — one transaction PER SECTION into the migrated v13 db. Idempotent. Writes an audit row.
// ==================================================================================================

export function executeImport(v13db: DB, sourcePath: string, opts: ExecuteOptions = {}): ExecuteResult {
  const now = opts.now ?? (() => Date.now());
  const newId = opts.newId ?? ((prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);

  const src = openSource(sourcePath);
  const sectionErrors: { section: string; error: string }[] = [];
  let report: ImportReport;

  try {
    // Build the plan report first (counts drive both the dry-run parity and the audit row). Then the
    // execute passes mutate v13 section-by-section, each in its own transaction. A failing section
    // rolls back only itself, is recorded, and earlier committed sections stay (they re-run clean).
    report = buildReport(src, v13db);
  } catch (e) {
    src.db.close();
    throw e;
  }

  const startedAt = now();
  const importRunId = newId('import');

  function section(name: string, fn: () => void): void {
    try {
      const tx = v13db.transaction(fn);
      tx();
    } catch (e) {
      sectionErrors.push({ section: name, error: (e as Error).message });
    }
  }

  const ctx: WriteCtx = { v13db, src, now, newId };

  const SECTION_TOTAL = 7;
  section('jobs', () => importJobsAndApplications(ctx));
  section('answers', () => importAnswers(ctx));
  section('documents', () => importDocuments(ctx));
  section('emails', () => importEmails(ctx));
  section('events', () => importEvents(ctx));
  section('runs', () => importRuns(ctx));
  section('settings', () => importSettings(ctx));
  // NO section for: fit_scores, autopsies, interviews, ai_calls, apply_run_steps (see file header —
  // new v13 concepts with no honest v11 counterpart), and punishments (no blocklist table in v13).

  const status: ExecuteResult['status'] =
    sectionErrors.length === 0 ? 'ok' : sectionErrors.length >= SECTION_TOTAL ? 'failed' : 'partial';

  const finishedAt = now();
  writeAuditRow(v13db, {
    id: importRunId,
    sourcePath: src.path,
    sha256: src.sha256,
    userVersion: src.userVersion,
    dryRun: 0,
    status,
    report,
    startedAt,
    finishedAt,
  });

  src.db.close();
  return { importRunId, status, report, sectionErrors };
}

// ---- write context threaded through every section importer ----------------------------------------
interface WriteCtx {
  v13db: DB;
  src: SourceHandle;
  now: () => number;
  newId: (prefix: string) => string;
}

// ==================================================================================================
//  REPORT BUILDER — computes the counts. When v13db is passed we also learn what already exists so
//  the counts honestly say toCreate vs skippedExisting (idempotency reflected in the numbers).
// ==================================================================================================

function existsInV13(v13db: DB | null, sql: string, param: string): boolean {
  if (!v13db) return false;
  return v13db.prepare(sql).get(param) !== undefined;
}

function buildReport(src: SourceHandle, v13db: DB | null): ImportReport {
  const { db, shapes } = src;
  const warnings = [...src.warnings];

  // ---- profiles
  const profileRows = selectExisting(db, 'profiles', shapes.profiles!);
  let profilesToCreate = 0;
  let profilesExisting = 0;
  for (const p of profileRows) {
    const id = String(col(p, shapes.profiles!, 'id') ?? '');
    if (!id) continue;
    if (existsInV13(v13db, 'SELECT 1 FROM profiles WHERE id = ?', id)) profilesExisting++;
    else profilesToCreate++;
  }

  // ---- jobs + applications
  const jobRows = selectExisting(db, 'jobs', shapes.jobs!);
  let jobsToCreate = 0;
  let jobsExisting = 0;
  let mergeDedup = 0;
  const byStatus: Record<string, number> = {};
  let applToCreate = 0;
  for (const j of jobRows) {
    const id = String(col(j, shapes.jobs!, 'id') ?? '');
    if (!id) continue;
    const jobExists = existsInV13(v13db, 'SELECT 1 FROM jobs WHERE id = ?', id);
    if (jobExists) jobsExisting++;
    else {
      // merge-dedup: a native v13 job with the same url_norm already exists under a different id.
      const jobUrl = String(col(j, shapes.jobs!, 'job_url') ?? '');
      const urlNorm = normJobUrl(jobUrl);
      if (v13db && urlNorm && v13db.prepare('SELECT 1 FROM jobs WHERE job_url_norm = ? AND id <> ?').get(urlNorm, id)) {
        mergeDedup++;
      } else {
        jobsToCreate++;
      }
    }
    const applId = `appl_v11_${id}`;
    if (!existsInV13(v13db, 'SELECT 1 FROM applications WHERE id = ?', applId)) {
      applToCreate++;
      const st = reconcileStatus(mapApplicationStatus(col(j, shapes.jobs!, 'status')), toEpochMs(col(j, shapes.jobs!, 'submitted_at')));
      byStatus[st] = (byStatus[st] ?? 0) + 1;
    }
  }

  // ---- answers (fields + qa), sensitive drops counted
  const fieldRows = selectExisting(db, 'profile_fields', shapes.profile_fields!);
  let fieldsCreate = 0, fieldsExisting = 0, fieldsSensitive = 0;
  for (const f of fieldRows) {
    const keyNorm = String(col(f, shapes.profile_fields!, 'key_norm') ?? normKey(String(col(f, shapes.profile_fields!, 'label') ?? '')));
    if (isSensitiveKey(keyNorm)) { fieldsSensitive++; continue; }
    const profileId = String(col(f, shapes.profile_fields!, 'profile_id') ?? '');
    if (v13db && v13db.prepare('SELECT 1 FROM learned_answers WHERE profile_id=? AND kind=? AND key_norm=?').get(profileId, 'field', keyNorm)) fieldsExisting++;
    else fieldsCreate++;
  }

  const qaRows = selectExisting(db, 'qa', shapes.qa!);
  let qaCreate = 0, qaExisting = 0, qaSensitive = 0;
  for (const q of qaRows) {
    const question = String(col(q, shapes.qa!, 'question') ?? '');
    const keyNorm = String(col(q, shapes.qa!, 'question_norm') ?? normQuestion(question));
    if (isSensitiveKey(keyNorm)) { qaSensitive++; continue; }
    const profileId = String(col(q, shapes.qa!, 'profile_id') ?? '');
    if (v13db && v13db.prepare('SELECT 1 FROM learned_answers WHERE profile_id=? AND kind=? AND key_norm=?').get(profileId, 'qa', keyNorm)) qaExisting++;
    else qaCreate++;
  }

  // ---- documents
  const docRows = selectExisting(db, 'documents', shapes.documents!);
  let docsCreate = 0, docsExisting = 0, docsMissing = 0, docsDupSha = 0;
  const missingList: { name: string; path: string }[] = [];
  const seenSha = new Set<string>();
  for (const d of docRows) {
    const id = String(col(d, shapes.documents!, 'id') ?? '');
    if (!id) continue;
    if (existsInV13(v13db, 'SELECT 1 FROM documents WHERE id = ?', id)) { docsExisting++; continue; }
    const filePath = String(col(d, shapes.documents!, 'file_path') ?? '');
    const name = String(col(d, shapes.documents!, 'name') ?? 'document');
    if (filePath && existsSync(filePath)) {
      const sha = createHash('sha256').update(readFileSync(filePath)).digest('hex');
      if (seenSha.has(sha) || (v13db && v13db.prepare('SELECT 1 FROM documents WHERE sha256 = ?').get(sha))) {
        docsDupSha++;
        continue; // duplicate bytes → skip whole row
      }
      seenSha.add(sha);
      docsCreate++;
    } else {
      docsMissing++;
      docsCreate++; // still a metadata row with missing_file=1
      if (missingList.length < 50) missingList.push({ name, path: filePath });
    }
  }

  // ---- emails + matches
  const emailRows = selectExisting(db, 'emails', shapes.emails!);
  const jobIdSet = new Set(jobRows.map((j) => String(col(j, shapes.jobs!, 'id') ?? '')).filter(Boolean));
  let emailsCreate = 0, emailsExisting = 0, matchesToCreate = 0, matchesDroppedNoJob = 0;
  for (const e of emailRows) {
    const id = String(col(e, shapes.emails!, 'id') ?? '');
    if (!id) continue;
    if (existsInV13(v13db, 'SELECT 1 FROM emails WHERE id = ?', id)) emailsExisting++;
    else emailsCreate++;
    const matchedJobId = col(e, shapes.emails!, 'matched_job_id');
    if (matchedJobId != null && matchedJobId !== '') {
      const jid = String(matchedJobId);
      const jobPresent = jobIdSet.has(jid) || existsInV13(v13db, 'SELECT 1 FROM jobs WHERE id = ?', jid);
      if (jobPresent) matchesToCreate++;
      else matchesDroppedNoJob++;
    }
  }

  // ---- events (filtered by the v13 kind mapping)
  const eventRows = selectExisting(db, 'events', shapes.events!);
  let eventsCreate = 0;
  const droppedKinds: Record<string, number> = {};
  for (const ev of eventRows) {
    // v11 events column is `type`, not `kind` — the plan must read the SAME fallback execute uses,
    // else the dry-run report falsely says every event will be dropped as 'unknown' (scar 14.5).
    const rawKind = col(ev, shapes.events!, 'kind') ?? col(ev, shapes.events!, 'type');
    const kind = mapEventKind(rawKind);
    if (kind) eventsCreate++;
    else {
      const k = String(rawKind ?? 'unknown');
      droppedKinds[k] = (droppedKinds[k] ?? 0) + 1;
    }
  }

  // ---- runs (terminal history only)
  const taskRows = selectExisting(db, 'auto_apply_tasks', shapes.auto_apply_tasks!);
  let runsCreate = 0, submittedVerified = 0, quarantinedLegacy = 0, parked = 0, failed = 0, skipped = 0, droppedInFlight = 0;
  for (const t of taskRows) {
    const decision = decideRunState(t, shapes.auto_apply_tasks!);
    if (!decision) { droppedInFlight++; continue; }
    const runId = `run_v11_${String(col(t, shapes.auto_apply_tasks!, 'id') ?? '')}`;
    if (existsInV13(v13db, 'SELECT 1 FROM apply_runs WHERE id = ?', runId)) continue; // skippedExisting
    runsCreate++;
    if (decision.state === 'submitted') submittedVerified++;
    else if (decision.state === 'parked' && decision.evidenceKind === 'legacy_untrusted') quarantinedLegacy++;
    else if (decision.state === 'parked') parked++;
    else if (decision.state === 'failed') failed++;
    else if (decision.state === 'skipped') skipped++;
  }

  // ---- settings (allow-map + registry gate; plan and execute share computeSettingsPlan)
  const settingsPlan = computeSettingsPlan(src, v13db);
  const importedSettings = settingsPlan.writes.map((s) => `${s.section}.${s.key}`);

  // ---- punishments: NOT carried (no blocklist table in v13 — autopsy pattern-miner supersedes it)
  const punishmentRows = selectExisting(db, 'punishments', shapes.punishments!);
  if (punishmentRows.length > 0) {
    warnings.push(
      `${punishmentRows.length} v11 punishment/blocklist row(s) not carried: v13 has no blocklist table; ` +
      'the autopsy pattern-miner + fit floor supersede that mechanism.',
    );
  }

  const sensitiveDropped = fieldsSensitive + qaSensitive;

  return {
    source: {
      path: src.path, sha256: src.sha256, v11_user_version: src.userVersion,
      file_bytes: src.fileBytes, warnings,
    },
    profiles: { found: profileRows.length, toCreate: profilesToCreate, skippedExisting: profilesExisting },
    jobs: { found: jobRows.length, toCreate: jobsToCreate, skippedExisting: jobsExisting, mergeDedup },
    applications: { toCreate: applToCreate, byStatus },
    answers: {
      fields: { found: fieldRows.length, toCreate: fieldsCreate, skippedExisting: fieldsExisting, droppedSensitive: fieldsSensitive },
      qa: { found: qaRows.length, toCreate: qaCreate, skippedExisting: qaExisting, droppedSensitive: qaSensitive },
    },
    documents: { found: docRows.length, toCreate: docsCreate, skippedExisting: docsExisting, missingFile: docsMissing, duplicateSha: docsDupSha, missingList },
    emails: { found: emailRows.length, toCreate: emailsCreate, skippedExisting: emailsExisting, matchesToCreate, matchesDroppedNoJob },
    events: { found: eventRows.length, toCreate: eventsCreate, skippedExisting: 0, droppedKinds },
    runs: {
      found: taskRows.length, toCreate: runsCreate, skippedExisting: 0,
      submittedVerified, quarantinedLegacy, parked, failed, skipped, droppedInFlight,
    },
    settings: { imported: importedSettings, skipped: settingsPlan.skipped, defaulted: 'everything else' },
    sensitiveDropped,
    willImport: true,
  };
}

// ---- events kind filter ---------------------------------------------------------------------------
// Direct-accept set = kinds v11 could legitimately emit that exist verbatim in the 001_init CHECK.
// The synonym maps below it are the 13.0.1 fidelity rules and MUST run for v11's own vocabulary:
// v11 gmail.js emits type:'email' (meaning "an email was matched") → 'email_matched'; v11's AI
// resume-tailor timeline entry 'resume_tailored' → 'note' (v13's own resume_tailored events carry
// structured doc lineage; a v11 prose entry doesn't qualify).
const V13_EVENT_KINDS = new Set(['status_change', 'submitted', 'park', 'email_matched', 'note', 'imported', 'created', 'document_attached']);
function mapEventKind(kind: unknown): string | null {
  const s = String(kind ?? '').toLowerCase();
  if (V13_EVENT_KINDS.has(s)) return s;
  // v11 synonyms (v11 events.type = created | status_changed | progressing | email | …)
  if (s === 'status' || s === 'statuschange' || s === 'status_changed') return 'status_change';
  if (s === 'progressing' || s === 'progress') return null; // internal churn, not a user-facing event
  if (s === 'apply' || s === 'submit' || s === 'submitted') return 'submitted';
  if (s === 'import') return 'imported';
  if (s === 'matched' || s === 'emailmatch' || s === 'email') return 'email_matched'; // v11 gmail.js emits type:'email'
  if (s === 'resume_tailored' || s === 'resume' || s === 'tailored') return 'note'; // v11 AI resume-tailoring timeline entry
  return null;
}

// ---- run-state decision (shared by report + execute so counts and writes never diverge) -----------
interface RunDecision {
  state: 'submitted' | 'parked' | 'failed' | 'skipped';
  parkKind: string | null;
  evidenceKind: string | null;
}

/** Return the terminal v13 run decision, or null when the task is stale in-flight (NOT imported). */
function decideRunState(task: Record<string, unknown>, shape: TableShape): RunDecision | null {
  // v11 auto_apply_tasks column is `state` (not `status`) — try both for forward-compat.
  const status = String(col(task, shape, 'state') ?? col(task, shape, 'status') ?? '').toLowerCase();

  // In-flight / not-yet-run states are stale — the v13 scheduler starts clean.
  if (status === 'queued' || status === 'scheduled' || status === 'running' || status === 'pending' || status === 'claimed') {
    return null;
  }

  if (status === 'done' || status === 'completed' || status === 'submitted' || status === 'success') {
    const evidenceKind = mapEvidenceKind(col(task, shape, 'submission_evidence'));
    if (evidenceKind) {
      return { state: 'submitted', parkKind: null, evidenceKind };
    }
    // done but no trustworthy evidence → quarantine as parked/awaiting_review/legacy_untrusted.
    return { state: 'parked', parkKind: 'awaiting_review', evidenceKind: 'legacy_untrusted' };
  }

  if (status === 'failed' || status === 'error') {
    return { state: 'failed', parkKind: null, evidenceKind: null };
  }

  if (status === 'skipped' || status === 'skip') {
    return { state: 'skipped', parkKind: null, evidenceKind: null };
  }

  if (status.startsWith('park') || status.startsWith('awaiting')) {
    return { state: 'parked', parkKind: mapParkKind(col(task, shape, 'park_reason') ?? status), evidenceKind: null };
  }

  // Unknown terminal-ish status → park as 'other' rather than fabricate success or drop silently.
  return { state: 'parked', parkKind: 'other', evidenceKind: null };
}

// ==================================================================================================
//  SECTION IMPORTERS — each is called inside its own transaction. Parameterized SQL only.
// ==================================================================================================

function importJobsAndApplications(ctx: WriteCtx): void {
  const { v13db, src, now } = ctx;
  const shapes = src.shapes;
  const jobShape = shapes.jobs!;

  // First: profiles (applications need them; FK). Preserve id/is_default/assignments/data verbatim.
  const profileRows = selectExisting(src.db, 'profiles', shapes.profiles!);
  const resolver = buildProfileResolver(profileRows, shapes.profiles!);

  const insProfile = v13db.prepare(
    `INSERT INTO profiles (id, name, is_default, source_assignments_json, data_json, created_at, updated_at)
     VALUES (@id, @name, @is_default, @source_assignments_json, @data_json, @created_at, @updated_at)
     ON CONFLICT DO NOTHING`,
  );
  // Only ONE row may have is_default=1 (partial unique index). If v13 already has a default profile
  // (a fresh install seeds one), every imported profile lands with is_default=0 — never a constraint
  // bomb that silently drops the whole profile row.
  const v13HasDefault = v13db.prepare('SELECT 1 FROM profiles WHERE is_default = 1').get() !== undefined;
  let defaultProfileId = resolver.defaultProfileId;
  for (const p of profileRows) {
    const id = String(col(p, shapes.profiles!, 'id') ?? '');
    if (!id) continue;
    // 13.0.1 fidelity: created_at falls back to updated_at, NEVER fabricated as now() (scar 14.5).
    const created = toEpochMs(col(p, shapes.profiles!, 'created_at')) ?? toEpochMs(col(p, shapes.profiles!, 'updated_at')) ?? now();
    const updated = toEpochMs(col(p, shapes.profiles!, 'updated_at')) ?? created;
    const isDefault = !v13HasDefault && id === defaultProfileId ? 1 : 0;
    insProfile.run({
      id,
      name: clampStr(col(p, shapes.profiles!, 'name') ?? 'Profile', 256),
      is_default: isDefault,
      source_assignments_json: jsonOrDefault(col(p, shapes.profiles!, 'source_assignments'), '[]', 2048),
      data_json: jsonOrDefault(col(p, shapes.profiles!, 'data'), '{}', 262144),
      created_at: created,
      updated_at: updated,
    });
  }
  // If v11 had no profiles at all, synthesize a default so applications have a home.
  if (!defaultProfileId) {
    const existingDefault = v13db.prepare('SELECT id FROM profiles WHERE is_default = 1').get() as { id: string } | undefined;
    if (existingDefault) {
      defaultProfileId = existingDefault.id;
    } else {
      defaultProfileId = 'prof_v11_default';
      const t = now();
      insProfile.run({
        id: defaultProfileId, name: 'Imported', is_default: 1,
        source_assignments_json: '[]', data_json: '{}', created_at: t, updated_at: t,
      });
    }
    resolver.defaultProfileId = defaultProfileId;
  }

  const insJob = v13db.prepare(
    `INSERT INTO jobs (id, source, external_id, title, company, company_key, location, work_mode,
        employment_type, compensation, job_url, job_url_norm, norm_key, apply_capability, fit_score,
        tags_json, posting_state, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (@id, @source, @external_id, @title, @company, @company_key, @location, @work_mode,
        @employment_type, @compensation, @job_url, @job_url_norm, @norm_key, @apply_capability, @fit_score,
        @tags_json, @posting_state, @first_seen_at, @last_seen_at, @created_at, @updated_at)
     ON CONFLICT(id) DO NOTHING`,
  );
  const insDetails = v13db.prepare(
    `INSERT INTO job_details (job_id, description, fit_json, raw_json)
     VALUES (@job_id, @description, @fit_json, @raw_json)
     ON CONFLICT(job_id) DO NOTHING`,
  );
  const insAppl = v13db.prepare(
    `INSERT INTO applications (id, job_id, profile_id, status, via, submitted_at, answers_json,
        attachments_json, notes, next_action, due_at, needs_review, created_at, updated_at)
     VALUES (@id, @job_id, @profile_id, @status, @via, @submitted_at, @answers_json,
        @attachments_json, @notes, @next_action, @due_at, @needs_review, @created_at, @updated_at)
     ON CONFLICT DO NOTHING`,
  );

  const jobRows = selectExisting(src.db, 'jobs', jobShape);
  for (const j of jobRows) {
    const id = String(col(j, jobShape, 'id') ?? '');
    if (!id) continue;
    const created = toEpochMs(col(j, jobShape, 'created_at')) ?? now();
    const company = String(col(j, jobShape, 'company') ?? '');
    const jobUrl = clampStr(col(j, jobShape, 'job_url') ?? '', 2048);
    const tags = mergeTags(col(j, jobShape, 'tags'));

    insJob.run({
      id,
      source: clampStr(col(j, jobShape, 'source') ?? 'unknown', 64) || 'unknown',
      external_id: clampOrNull(col(j, jobShape, 'external_id'), 256),
      title: clampStr(col(j, jobShape, 'title') ?? '', 512),
      company: clampStr(company, 256),
      company_key: normKey(company),
      location: clampStr(col(j, jobShape, 'location') ?? '', 256),
      work_mode: mapWorkMode(col(j, jobShape, 'work_mode')),
      employment_type: clampOrNull(col(j, jobShape, 'employment_type'), 64),
      compensation: clampOrNull(col(j, jobShape, 'compensation'), 256),
      job_url: jobUrl,
      job_url_norm: normJobUrl(jobUrl),
      norm_key: normKey(`${company} ${String(col(j, jobShape, 'title') ?? '')}`),
      apply_capability: mapApplyCapability(col(j, jobShape, 'apply_capability') ?? col(j, jobShape, 'capability')),
      fit_score: clampFitScore(col(j, jobShape, 'fit_score')),
      tags_json: jsonOrDefault(tags, '[]', 1024),
      posting_state: mapPostingState(col(j, jobShape, 'posting_state') ?? col(j, jobShape, 'state')),
      first_seen_at: created,
      last_seen_at: created,
      created_at: created,
      updated_at: toEpochMs(col(j, jobShape, 'updated_at')) ?? created,
    });

    // details (heavy text quarantined by table design — descriptions never travel in list payloads)
    insDetails.run({
      job_id: id,
      description: clampStr(col(j, jobShape, 'description') ?? '', CAP.description),
      fit_json: jsonOrNull(col(j, jobShape, 'fit_data') ?? col(j, jobShape, 'fit'), CAP.fitJson),
      raw_json: jsonOrNull(col(j, jobShape, 'raw') ?? col(j, jobShape, 'raw_json'), 131072),
    });

    // one application per job — deterministic id; status reconciled against submitted_at (scar 14.5)
    const applId = `appl_v11_${id}`;
    const submittedAt = toEpochMs(col(j, jobShape, 'submitted_at'));
    insAppl.run({
      id: applId,
      job_id: id,
      profile_id: resolver.resolve(col(j, jobShape, 'source')),
      status: reconcileStatus(mapApplicationStatus(col(j, jobShape, 'status')), submittedAt),
      via: 'import',
      submitted_at: submittedAt,
      answers_json: jsonOrDefault(col(j, jobShape, 'answers'), '[]', CAP.answersJson),
      attachments_json: jsonOrDefault(col(j, jobShape, 'attachments'), '[]', CAP.attachmentsJson),
      notes: clampOrNull(col(j, jobShape, 'notes'), 16384),
      next_action: clampOrNull(col(j, jobShape, 'next_action'), 512),
      due_at: toEpochMs(col(j, jobShape, 'due_at')),
      needs_review: Number(col(j, jobShape, 'needs_review') ?? 0) === 1 ? 1 : 0,
      created_at: created,
      updated_at: toEpochMs(col(j, jobShape, 'updated_at')) ?? created,
    });
  }
}

function importAnswers(ctx: WriteCtx): void {
  const { v13db, src, now } = ctx;
  const shapes = src.shapes;

  const insAnswer = v13db.prepare(
    `INSERT INTO learned_answers (id, profile_id, kind, key_norm, label, locale, field_type, value,
        options_json, confidence, provenance, locked, seen_count, used_count, last_used_at,
        source_host, source_job_id, created_at, updated_at)
     VALUES (@id, @profile_id, @kind, @key_norm, @label, @locale, @field_type, @value,
        @options_json, @confidence, @provenance, @locked, @seen_count, @used_count, @last_used_at,
        @source_host, @source_job_id, @created_at, @updated_at)
     ON CONFLICT DO NOTHING`,
  );

  // profile_fields → kind='field'
  const fieldShape = shapes.profile_fields!;
  for (const f of selectExisting(src.db, 'profile_fields', fieldShape)) {
    const label = clampStr(col(f, fieldShape, 'label') ?? col(f, fieldShape, 'key') ?? '', CAP.label);
    const keyNorm = String(col(f, fieldShape, 'key_norm') ?? normKey(label));
    if (isSensitiveKey(keyNorm)) continue; // SECURITY: never import EEO/SSN/DOB/salary-history.
    const profileId = String(col(f, fieldShape, 'profile_id') ?? '');
    if (!profileId) continue;
    const locked = Number(col(f, fieldShape, 'locked') ?? 0) === 1 ? 1 : 0;
    // 13.0.1 fidelity: created_at ?? updated_at ?? now() — timelines are never fabricated.
    const created = toEpochMs(col(f, fieldShape, 'created_at')) ?? toEpochMs(col(f, fieldShape, 'updated_at')) ?? now();
    insAnswer.run({
      id: String(col(f, fieldShape, 'id') ?? ctx.newId('ans')),
      profile_id: profileId,
      kind: 'field',
      key_norm: keyNorm,
      label,
      locale: clampStr(col(f, fieldShape, 'locale') ?? 'en', 16) || 'en',
      field_type: mapFieldType(col(f, fieldShape, 'field_type')),
      value: clampOrNull(col(f, fieldShape, 'value'), CAP.value),
      options_json: jsonOrNull(col(f, fieldShape, 'options'), 4096),
      confidence: clampConfidence(col(f, fieldShape, 'confidence'), 0.6),
      provenance: locked === 1 ? 'user' : 'import_v11',
      locked,
      seen_count: intOr(col(f, fieldShape, 'seen_count'), 1),
      used_count: intOr(col(f, fieldShape, 'used_count'), 0),
      last_used_at: toEpochMs(col(f, fieldShape, 'last_used_at')),
      source_host: clampOrNull(col(f, fieldShape, 'source') ?? col(f, fieldShape, 'source_host'), 128),
      source_job_id: valueOrNull(col(f, fieldShape, 'source_job_id')),
      created_at: created,
      updated_at: toEpochMs(col(f, fieldShape, 'updated_at')) ?? created,
    });
  }

  // qa → kind='qa' (question→label, answer→value, confidence 0.7)
  const qaShape = shapes.qa!;
  for (const q of selectExisting(src.db, 'qa', qaShape)) {
    const question = clampStr(col(q, qaShape, 'question') ?? '', CAP.label);
    const keyNorm = String(col(q, qaShape, 'question_norm') ?? normQuestion(question));
    if (isSensitiveKey(keyNorm)) continue;
    const profileId = String(col(q, qaShape, 'profile_id') ?? '');
    if (!profileId) continue;
    const created = toEpochMs(col(q, qaShape, 'created_at')) ?? toEpochMs(col(q, qaShape, 'updated_at')) ?? now();
    insAnswer.run({
      id: String(col(q, qaShape, 'id') ?? ctx.newId('ans')),
      profile_id: profileId,
      kind: 'qa',
      key_norm: keyNorm,
      label: question || keyNorm || 'question',
      locale: clampStr(col(q, qaShape, 'locale') ?? 'en', 16) || 'en',
      field_type: mapFieldType(col(q, qaShape, 'field_type')),
      value: clampOrNull(col(q, qaShape, 'answer'), CAP.value),
      options_json: jsonOrNull(col(q, qaShape, 'options'), 4096),
      confidence: 0.7,
      provenance: 'import_v11',
      locked: 0,
      seen_count: intOr(col(q, qaShape, 'seen_count'), 1),
      used_count: intOr(col(q, qaShape, 'used_count'), 0),
      last_used_at: toEpochMs(col(q, qaShape, 'last_used_at')),
      source_host: clampOrNull(col(q, qaShape, 'source') ?? col(q, qaShape, 'source_host'), 128),
      source_job_id: valueOrNull(col(q, qaShape, 'source_job_id')),
      created_at: created,
      updated_at: toEpochMs(col(q, qaShape, 'updated_at')) ?? created,
    });
  }
}

function importDocuments(ctx: WriteCtx): void {
  const { v13db, src, now } = ctx;
  const shape = src.shapes.documents!;

  const insDoc = v13db.prepare(
    `INSERT INTO documents (id, profile_id, name, role, label, mime, size_bytes, sha256, is_default,
        source, origin_path, missing_file, created_at, updated_at)
     VALUES (@id, @profile_id, @name, @role, @label, @mime, @size_bytes, @sha256, @is_default,
        @source, @origin_path, @missing_file, @created_at, @updated_at)
     ON CONFLICT DO NOTHING`,
  );
  // documents keep BYTES: the library lives IN the database (a disk restore already cost one library).
  const insBlob = v13db.prepare(
    `INSERT INTO document_blobs (document_id, bytes) VALUES (@document_id, @bytes)
     ON CONFLICT(document_id) DO NOTHING`,
  );
  const insText = v13db.prepare(
    `INSERT INTO document_text (document_id, text, keywords_json, indexed_at)
     VALUES (@document_id, @text, @keywords_json, @indexed_at)
     ON CONFLICT(document_id) DO NOTHING`,
  );

  for (const d of selectExisting(src.db, 'documents', shape)) {
    const id = String(col(d, shape, 'id') ?? '');
    if (!id) continue;
    const name = clampStr(col(d, shape, 'name') ?? 'document', 256) || 'document';
    const filePath = String(col(d, shape, 'file_path') ?? '');
    const created = toEpochMs(col(d, shape, 'created_at')) ?? now();
    // documents.profile_id is nullable (ON DELETE SET NULL) — only reference a profile that exists,
    // else one orphan pointer rolls back the whole documents section on the FK.
    let profileId = valueOrNull(col(d, shape, 'profile_id'));
    if (profileId && v13db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profileId) === undefined) {
      profileId = null;
    }

    let bytes: Buffer | null = null;
    let sha: string | null = null;
    let missing = 1;
    let sizeBytes = 0;
    if (filePath && existsSync(filePath)) {
      try {
        bytes = readFileSync(filePath);
        if (bytes.length <= 26_214_400) {
          sha = createHash('sha256').update(bytes).digest('hex');
          sizeBytes = bytes.length;
          missing = 0;
        } else {
          bytes = null; // over the 25MB cap → keep metadata, drop bytes, mark missing-ish
          missing = 1;
        }
      } catch {
        bytes = null;
        missing = 1;
      }
    }

    // sha dedup: if another document already owns these bytes, skip the WHOLE row.
    if (sha) {
      const dup = v13db.prepare('SELECT 1 FROM documents WHERE sha256 = ? AND id <> ?').get(sha, id);
      if (dup) continue;
    }

    const info = insDoc.run({
      id,
      profile_id: profileId,
      name,
      role: mapDocRole(col(d, shape, 'role')),
      label: clampOrNull(col(d, shape, 'label'), 128),
      mime: clampOrNull(col(d, shape, 'mime') ?? col(d, shape, 'content_type'), 128),
      size_bytes: sizeBytes,
      sha256: sha,
      is_default: Number(col(d, shape, 'is_default') ?? 0) === 1 ? 1 : 0,
      source: 'import_v11',
      origin_path: clampOrNull(filePath, 1024),
      missing_file: missing,
      created_at: created,
      updated_at: toEpochMs(col(d, shape, 'updated_at')) ?? created,
    });

    // Only attach blob/text if the doc row was actually inserted (idempotent re-run skips both).
    if (info.changes > 0) {
      if (bytes && sha) {
        insBlob.run({ document_id: id, bytes });
      }
      const text = col(d, shape, 'text_content') ?? col(d, shape, 'text');
      if (text != null && String(text) !== '') {
        insText.run({
          document_id: id,
          text: clampStr(text, CAP.docText),
          keywords_json: jsonOrDefault(col(d, shape, 'keywords'), '[]', CAP.keywordsJson),
          indexed_at: created,
        });
      }
    }
  }
}

function importEmails(ctx: WriteCtx): void {
  const { v13db, src, now } = ctx;
  const shape = src.shapes.emails!;
  const rows = selectExisting(src.db, 'emails', shape);
  if (rows.length === 0) return;

  // One synthetic 'imported' account holds all carried-over mail.
  const accountId = 'acct_v11_imported';
  v13db.prepare(
    `INSERT INTO email_accounts (id, kind, email, label, enabled, token_state, created_at, updated_at)
     VALUES (@id, 'imported', @email, 'Imported from v11', 1, 'unauthorized', @t, @t)
     ON CONFLICT(id) DO NOTHING`,
  ).run({ id: accountId, email: '', t: now() });

  const insEmail = v13db.prepare(
    `INSERT INTO emails (id, account_id, provider, provider_msg_id, message_id, thread_id, from_addr,
        from_name, to_addr, subject, snippet, body, sent_at, category, classified_by, created_at)
     VALUES (@id, @account_id, 'imported', @provider_msg_id, @message_id, @thread_id, @from_addr,
        @from_name, @to_addr, @subject, @snippet, @body, @sent_at, @category, @classified_by, @created_at)
     ON CONFLICT DO NOTHING`,
  );
  const insMatch = v13db.prepare(
    `INSERT INTO email_matches (email_id, application_id, job_id, confidence, source, match_via, decided_at)
     VALUES (@email_id, @application_id, @job_id, @confidence, @source, 'import', @decided_at)
     ON CONFLICT(email_id) DO NOTHING`,
  );

  for (const e of rows) {
    const id = String(col(e, shape, 'id') ?? '');
    if (!id) continue;
    const created = toEpochMs(col(e, shape, 'created_at')) ?? now();
    insEmail.run({
      id,
      account_id: accountId,
      provider_msg_id: String(col(e, shape, 'provider_msg_id') ?? id), // the v11 email id is the msg id
      message_id: valueOrNull(col(e, shape, 'message_id')),
      thread_id: valueOrNull(col(e, shape, 'thread_id')),
      from_addr: clampStr(col(e, shape, 'from_addr') ?? col(e, shape, 'from') ?? '', 320),
      from_name: clampStr(col(e, shape, 'from_name') ?? '', 256),
      to_addr: clampStr(col(e, shape, 'to_addr') ?? col(e, shape, 'to') ?? '', 320),
      subject: clampStr(col(e, shape, 'subject') ?? '', 998),
      snippet: clampStr(col(e, shape, 'snippet') ?? '', 512),
      body: clampOrNull(col(e, shape, 'body'), CAP.emailBody),
      sent_at: toEpochMs(col(e, shape, 'sent_at') ?? col(e, shape, 'date')),
      category: mapEmailCategory(col(e, shape, 'category')),
      classified_by: mapClassifiedBy(col(e, shape, 'classified_by')),
      created_at: created,
    });

    // match row (only if the matched job exists post-import)
    const matchedJobId = col(e, shape, 'matched_job_id');
    if (matchedJobId != null && matchedJobId !== '') {
      const jid = String(matchedJobId);
      const jobPresent = v13db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(jid) !== undefined;
      if (jobPresent) {
        const applId = `appl_v11_${jid}`;
        const applPresent = v13db.prepare('SELECT 1 FROM applications WHERE id = ?').get(applId) !== undefined;
        insMatch.run({
          email_id: id,
          application_id: applPresent ? applId : null,
          job_id: jid,
          confidence: clampConfidence(col(e, shape, 'match_confidence'), 0.5),
          source: mapMatchSource(col(e, shape, 'match_source')),
          decided_at: created,
        });
      }
    }
  }
}

function importEvents(ctx: WriteCtx): void {
  const { v13db, src, now } = ctx;
  const shape = src.shapes.events!;
  if (!shape.exists) return;

  const insEvent = v13db.prepare(
    `INSERT INTO events (id, at, kind, job_id, application_id, run_id, email_id, source, summary, data_json)
     VALUES (@id, @at, @kind, @job_id, @application_id, @run_id, @email_id, @source, @summary, @data_json)
     ON CONFLICT(id) DO NOTHING`,
  );

  for (const ev of selectExisting(src.db, 'events', shape)) {
    // 13.0.1 fidelity: v11's column is `type` — the kind||type fallback keeps email/resume_tailored
    // history instead of dropping it (scar 14.5).
    const kind = mapEventKind(col(ev, shape, 'kind') ?? col(ev, shape, 'type'));
    if (!kind) continue; // dropped kind
    const id = String(col(ev, shape, 'id') ?? ctx.newId('evt'));
    const jobId = valueOrNull(col(ev, shape, 'job_id'));
    // application only if it exists (derive from the deterministic id; FK is ON)
    let applId: string | null = null;
    if (jobId) {
      const cand = `appl_v11_${jobId}`;
      if (v13db.prepare('SELECT 1 FROM applications WHERE id = ?').get(cand)) applId = cand;
    }
    // job FK is ON — only reference a job that actually imported
    const jobRef = jobId && v13db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(jobId) ? jobId : null;
    insEvent.run({
      id,
      at: toEpochMs(col(ev, shape, 'at') ?? col(ev, shape, 'created_at') ?? col(ev, shape, 'timestamp')) ?? now(),
      kind,
      job_id: jobRef,
      application_id: applId,
      run_id: valueOrNull(col(ev, shape, 'run_id')),
      email_id: valueOrNull(col(ev, shape, 'email_id')),
      source: clampOrNull(col(ev, shape, 'source'), 64),
      summary: clampOrNull(col(ev, shape, 'summary') ?? col(ev, shape, 'message'), 512),
      data_json: jsonOrNull(col(ev, shape, 'data'), CAP.eventData),
    });
  }
}

function importRuns(ctx: WriteCtx): void {
  const { v13db, src, now } = ctx;
  const shape = src.shapes.auto_apply_tasks!;
  if (!shape.exists) return;

  // NOTE: apply_run_steps receives NOTHING — v11 transcripts are unbounded prose; the v13 step table
  // is typed+capped and there is no honest mapping. Imported runs carry steps_count=0.
  const insRun = v13db.prepare(
    `INSERT INTO apply_runs (id, application_id, job_id, profile_id, source, lane, state, mode, route,
        attempt, park_kind, park_detail, pending_questions_json, error, evidence_kind, evidence_json,
        steps_count, queued_at, started_at, finished_at, updated_at)
     VALUES (@id, @application_id, @job_id, @profile_id, @source, @lane, @state, 'auto', @route,
        @attempt, @park_kind, @park_detail, @pending_questions_json, @error, @evidence_kind, @evidence_json,
        0, @queued_at, @started_at, @finished_at, @updated_at)
     ON CONFLICT(id) DO NOTHING`,
  );
  // Cap-authority fidelity (§9: apply_ledger is the ONLY cap authority): a VERIFIED historical submit
  // also writes a ledger row, so a same-day cutover import can never let v13 re-spend a per-source cap
  // v11 already spent inside the window. NOT EXISTS on run_id keeps re-imports idempotent
  // (apply_ledger's id is AUTOINCREMENT, so ON CONFLICT can't do the dedup).
  const insLedger = v13db.prepare(
    `INSERT INTO apply_ledger (run_id, source, account_key, submitted_at)
     SELECT @run_id, @source, 'default', @submitted_at
     WHERE NOT EXISTS (SELECT 1 FROM apply_ledger WHERE run_id = @run_id)`,
  );

  for (const t of selectExisting(src.db, 'auto_apply_tasks', shape)) {
    const decision = decideRunState(t, shape);
    if (!decision) continue; // stale in-flight → not imported

    const taskId = String(col(t, shape, 'id') ?? '');
    if (!taskId) continue;
    const jobId = String(col(t, shape, 'job_id') ?? '');
    if (!jobId) continue;

    // The run needs an application to hang off (FK). Use the deterministic appl id if it imported.
    const applId = `appl_v11_${jobId}`;
    const appl = v13db.prepare('SELECT profile_id FROM applications WHERE id = ?').get(applId) as { profile_id: string } | undefined;
    if (!appl) continue; // no application (job didn't import) → skip the run rather than orphan it.

    const route = mapRoute(col(t, shape, 'apply_route') ?? col(t, shape, 'route'));
    const created = toEpochMs(col(t, shape, 'created_at') ?? col(t, shape, 'queued_at')) ?? now();
    const finished = toEpochMs(col(t, shape, 'finished_at') ?? col(t, shape, 'updated_at')) ?? created;
    // 13.0.1 fidelity (scar 14.5): v11 auto_apply_tasks has NO source column — source lives on the
    // JOB. Deriving it from the task row silently stamped every Indeed/ATS run as 'linkedin'; read
    // the authoritative job source, and derive the lane from THAT.
    const jobSource = (v13db.prepare('SELECT source FROM jobs WHERE id = ?').get(jobId) as { source?: string } | undefined)?.source
      ?? (col(t, shape, 'source') as string | undefined);

    const runId = `run_v11_${taskId}`;
    const source = clampStr(jobSource ?? 'linkedin', 64) || 'linkedin';
    insRun.run({
      id: runId,
      application_id: applId,
      job_id: jobId,
      profile_id: appl.profile_id,
      source,
      lane: mapLane(jobSource, route),
      state: decision.state,
      route,
      attempt: intOr(col(t, shape, 'attempts') ?? col(t, shape, 'attempt'), 1),
      park_kind: decision.parkKind,
      park_detail: clampOrNull(col(t, shape, 'last_error') ?? col(t, shape, 'park_reason'), CAP.parkDetail),
      pending_questions_json: jsonOrDefault(col(t, shape, 'pending_questions'), '[]', CAP.pendingQuestionsJson),
      error: clampOrNull(col(t, shape, 'last_error'), CAP.error),
      evidence_kind: decision.evidenceKind,
      evidence_json: jsonOrNull(col(t, shape, 'submission_evidence'), 8192),
      queued_at: created,
      started_at: toEpochMs(col(t, shape, 'started_at')),
      finished_at: finished,
      updated_at: toEpochMs(col(t, shape, 'updated_at')) ?? finished,
    });

    if (decision.state === 'submitted') {
      insLedger.run({ run_id: runId, source, submitted_at: finished });
    }
  }
}

function importSettings(ctx: WriteCtx): void {
  const { v13db, src, now, newId } = ctx;
  // Writes go through the registry-gated settings DAL — the ONLY writer of the settings table.
  // computeSettingsPlan already filtered to registered+valid+not-already-set keys, so set() cannot
  // throw on vocabulary; the try/catch is a backstop for the serialized-size cap.
  const dalCtx: DalContext = { db: v13db, now, newId, emit: () => {} };
  const settings = makeSettingsDal(dalCtx);
  const plan = computeSettingsPlan(src, v13db);
  for (const w of plan.writes) {
    try {
      settings.set(w.section, w.key, w.value);
    } catch {
      /* oversized/edge value — skip silently; the plan already reported the intent */
    }
  }
}

// ==================================================================================================
//  SETTINGS PLAN — allow-map ∩ registry, computed identically by plan + execute (counts never diverge).
// ==================================================================================================

interface SettingsPlanResult {
  writes: { section: string; key: string; value: unknown }[];
  skipped: SettingSkip[];
}

function computeSettingsPlan(src: SourceHandle, v13db: DB | null): SettingsPlanResult {
  const shape = src.shapes.settings;
  const out: SettingsPlanResult = { writes: [], skipped: [] };
  if (!shape || !shape.exists) return out;
  const rows = selectExisting(src.db, 'settings', shape);

  // v11 settings shape is flexible: (section,key,value) rows, or (key,value) rows where the key is
  // a dot-path, or (section, value-blob). Build a lookup of section.key → value.
  const flat = new Map<string, unknown>();
  for (const r of rows) {
    const section = shape.cols.has('section') ? String(r.section ?? '') : '';
    const rawKey = String(r.key ?? '');
    const value = r.value ?? r.value_json ?? r.data;
    if (section && rawKey) flat.set(`${section}.${rawKey}`, value);
    else if (section && !shape.cols.has('key') && value != null) {
      // whole-section JSON blob (real v11 db.js shape) → explode into per-key entries
      try {
        const obj = JSON.parse(String(value)) as Record<string, unknown>;
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          for (const [k, v] of Object.entries(obj)) flat.set(`${section}.${k}`, v);
        }
      } catch {
        /* not a JSON blob — ignore */
      }
    } else if (rawKey) {
      flat.set(rawKey, value); // rawKey is already a dot-path
    }
  }

  const emitted = new Set<string>();

  function consider(v13Section: string, v13Key: string, rawValue: unknown): void {
    const tag = `${v13Section}.${v13Key}`;
    if (emitted.has(tag)) return;
    emitted.add(tag);
    if (SECRET_KEY_RX.test(v13Key)) {
      out.skipped.push({ key: tag, reason: 'secret_shaped' });
      return;
    }
    if (rawValue == null || rawValue === '') return;
    // REGISTRY GATE (new-schema delta): only registered (section,key) pairs ever write.
    if (!getSpec(v13Section, v13Key)) {
      out.skipped.push({ key: tag, reason: 'unregistered' });
      return;
    }
    const value = jsonMaybeParse(rawValue);
    const check = validate(v13Section, v13Key, value);
    if (!check.ok) {
      out.skipped.push({ key: tag, reason: 'invalid' });
      return;
    }
    // Never clobber a v13 value set after a previous import — imports only fill gaps.
    if (v13db && v13db.prepare('SELECT 1 FROM settings WHERE section = ? AND key = ?').get(v13Section, v13Key)) {
      out.skipped.push({ key: tag, reason: 'already_set' });
      return;
    }
    out.writes.push({ section: v13Section, key: v13Key, value: check.value });
  }

  // explicit allow entries
  for (const a of SETTINGS_ALLOW) {
    const dot = `${a.v11Section}.${a.v11Key}`;
    if (!flat.has(dot)) continue;
    consider(a.v13Section, a.v13Key, flat.get(dot));
  }

  // whole-section allow (notifications.*), minus secret-shaped keys
  for (const [dot, value] of flat) {
    const dotIdx = dot.indexOf('.');
    if (dotIdx < 0) continue;
    const section = dot.slice(0, dotIdx);
    const key = dot.slice(dotIdx + 1);
    if (!SETTINGS_ALLOW_SECTIONS.has(section)) continue;
    consider(section, key, value);
  }

  return out;
}

/** A stored setting value may itself be JSON ('"a"' / 'true' / '[..]') — parse to a JS value if so. */
function jsonMaybeParse(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t) return v;
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"') || t === 'true' || t === 'false' || t === 'null' || /^-?\d/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

// ==================================================================================================
//  AUDIT ROW
// ==================================================================================================

interface AuditInput {
  id: string;
  sourcePath: string;
  sha256: string;
  userVersion: number;
  dryRun: 0 | 1;
  status: 'ok' | 'partial' | 'failed';
  report: ImportReport;
  startedAt: number;
  finishedAt: number;
}

function writeAuditRow(v13db: DB, a: AuditInput): void {
  // report_json is CHECK-capped at 256KB. Trim the missingList (the only unbounded field) if needed.
  let report = a.report;
  let reportJson = JSON.stringify(report);
  if (reportJson.length > 262_144) {
    report = { ...report, documents: { ...report.documents, missingList: report.documents.missingList.slice(0, 10) } };
    reportJson = JSON.stringify(report);
    if (reportJson.length > 262_144) reportJson = JSON.stringify({ trimmed: true, status: a.status });
  }
  v13db.prepare(
    `INSERT INTO import_runs (id, source_path, source_sha256, v11_user_version, dry_run, status,
        report_json, started_at, finished_at)
     VALUES (@id, @source_path, @source_sha256, @v11_user_version, @dry_run, @status,
        @report_json, @started_at, @finished_at)`,
  ).run({
    id: a.id,
    source_path: a.sourcePath,
    source_sha256: a.sha256,
    v11_user_version: a.userVersion,
    dry_run: a.dryRun,
    status: a.status,
    report_json: reportJson,
    started_at: a.startedAt,
    finished_at: a.finishedAt,
  });
}

// ==================================================================================================
//  small value coercers
// ==================================================================================================

function valueOrNull(v: unknown): string | null {
  if (v == null || v === '') return null;
  return String(v);
}

function jsonOrNull(raw: unknown, max: number): string | null {
  if (raw == null || raw === '') return null;
  const s = jsonOrDefault(raw, '__INVALID__', max);
  return s === '__INVALID__' ? null : s;
}

function intOr(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : def;
}

function clampConfidence(v: unknown, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(1, Math.max(0, n));
}

function clampFitScore(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function mapWorkMode(v: unknown): string | null {
  const s = String(v ?? '').toLowerCase();
  if (s === 'remote') return 'remote';
  if (s === 'hybrid') return 'hybrid';
  if (s === 'onsite' || s === 'on-site' || s === 'office') return 'onsite';
  return null;
}

function mapApplyCapability(v: unknown): string {
  const s = String(v ?? '').toLowerCase().replace(/[- ]/g, '_');
  const ok = new Set(['easy_apply', 'smartapply', 'ats_form', 'external', 'account_wall', 'unknown']);
  if (ok.has(s)) return s;
  if (s === 'easyapply') return 'easy_apply';
  if (s === 'accountwall' || s === 'wall') return 'account_wall';
  return 'unknown';
}

function mapPostingState(v: unknown): string {
  const s = String(v ?? '').toLowerCase();
  if (s === 'stale') return 'stale';
  if (s === 'removed' || s === 'closed' || s === 'expired') return 'removed';
  return 'active';
}

function mapEmailCategory(v: unknown): string | null {
  const s = String(v ?? '').toLowerCase();
  const ok = new Set(['application_confirmation', 'recruiter', 'assessment', 'interview', 'offer', 'rejection', 'other']);
  if (ok.has(s)) return s;
  if (s === 'confirmation' || s === 'applied') return 'application_confirmation';
  if (s === 'reject' || s === 'rejected') return 'rejection';
  return null;
}

function mapClassifiedBy(v: unknown): string | null {
  const s = String(v ?? '').toLowerCase();
  if (s === 'rules' || s === 'ai' || s === 'manual') return s;
  return null;
}

/** Merge v11 tags (array or comma-string) + the 'imported-v11' marker → a string array. */
function mergeTags(raw: unknown): string[] {
  const out = new Set<string>();
  if (Array.isArray(raw)) {
    for (const t of raw) if (t != null) out.add(String(t));
  } else if (typeof raw === 'string' && raw.trim()) {
    const t = raw.trim();
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) for (const x of parsed) if (x != null) out.add(String(x));
      } catch {
        for (const x of t.split(',')) if (x.trim()) out.add(x.trim());
      }
    } else {
      for (const x of t.split(',')) if (x.trim()) out.add(x.trim());
    }
  }
  out.add('imported-v11');
  return [...out];
}
