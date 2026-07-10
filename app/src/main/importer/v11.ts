// The v11 → v12 importer (Pillar 4 §5). Carries Pierre's (and Dad's) real JAT v11 data into the v12
// schema so NOTHING of forward value is lost, while structurally refusing to carry v11's mistakes:
// stale in-flight tasks, untrusted "success" claims, sensitive/demographic answers, and secrets.
//
// Design laws (why this is NOT the per-row DALs):
//   1. PRESERVE ids. Jobs/profiles/answers/documents/emails keep their v11 ids; applications and runs
//      get DETERMINISTIC derived ids (`appl_v11_<jobId>`, `run_v11_<taskId>`). That is what makes a
//      re-run idempotent — INSERT OR IGNORE / ON CONFLICT DO NOTHING on a known key touches nothing
//      already present (a v12 edit made after the first import is never clobbered).
//   2. The SOURCE is opened READ-ONLY (`{ readonly: true, fileMustExist: true }`) — never written.
//   3. The v12 SCHEMA enforces truth. We map honestly to the exact column names + CHECK vocabularies;
//      if a mapping is dishonest (e.g. calling an unverified apply "submitted") the INSERT throws —
//      so we pre-clamp/pre-map to the schema's vocabulary and let the CHECK be the backstop.
//   4. Every table/column is FEATURE-DETECTED (PRAGMA table_info). A missing column degrades
//      gracefully (the field is skipped/defaulted) — it NEVER throws. Only a genuinely absent source
//      file or a held lock is a hard refusal.
//   5. Zero hardcoded user paths. The caller passes the source path; shape is all runtime-detected.

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normKey, normJobUrl, normQuestion } from '@jat13/shared/norm';
import { isSensitiveKey } from '../db/dal/answers.js';

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
  settings: { imported: string[]; defaulted: string };
  blocklist: SectionCount;
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
  reason: 256,
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
  // Validate; on invalid JSON fall back to the default (never let a bad string reach json_valid).
  try {
    JSON.parse(s);
  } catch {
    return def;
  }
  if (s.length > max) return def; // an oversized-but-valid JSON blob is dropped, not truncated (truncation breaks JSON).
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

/** SELECT only the columns that exist, from the ones we care about. */
function selectExisting(db: DB, table: string, shape: TableShape): Record<string, unknown>[] {
  if (!shape.exists) return [];
  return db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Record<string, unknown>[];
}

// ---- status vocabulary maps (v11 → v12 CHECK vocab) -----------------------------------------------

const V12_APPLICATION_STATUSES = new Set([
  'tracked', 'submitted', 'acknowledged', 'assessment',
  'interview_1', 'interview_2', 'interview_final',
  'offer', 'hired', 'rejected', 'withdrawn', 'ghosted',
]);

/** v11 lifecycle status → v12 status. Unknown → 'tracked' (never throw on an unrecognized status). */
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
  return V12_APPLICATION_STATUSES.has(s) ? s : 'tracked';
}

/** Pre-submit statuses that a recorded submit must override — a job with a real submitted_at can't
 *  keep showing as "Saved". v11 often stored the applied timestamp but left the status pre-submit;
 *  this reconciles the two so the Applications list + the funnel agree. */
const PRE_SUBMIT = new Set(['tracked']);
function reconcileStatus(mapped: string, submittedAt: number | null): string {
  if (submittedAt != null && PRE_SUBMIT.has(mapped)) return 'submitted';
  return mapped;
}

// ---- evidence trust test (ported from v11's isTrustworthyEvidence quarantine logic) ---------------

const V12_EVIDENCE_KINDS = new Set([
  'text_became_success', 'new_confirmation_node', 'confirm_signal',
  'url_confirmation', 'modal_close_confirmed', 'manual_confirmed',
]); // NB: 'legacy_untrusted' is deliberately excluded — it can never gate a 'submitted' state.

/**
 * Map v11 submission_evidence → a trustworthy v12 evidence_kind, or null if the evidence does not
 * clear the bar. v11 stored evidence either as a JSON object ({ type, detail, ... }) or a bare string.
 * The CHECK forbids state='submitted' unless the evidence_kind is trustworthy — so a done task whose
 * evidence we cannot vouch for becomes a PARKED 'awaiting_review' run tagged 'legacy_untrusted'.
 */
function mapEvidenceKind(evidence: unknown): string | null {
  if (evidence == null || evidence === '') return null;
  let type = '';
  let detail = '';
  if (typeof evidence === 'string') {
    // Could be a JSON string or a bare label.
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
  // Direct named kinds first.
  if (V12_EVIDENCE_KINDS.has(type)) return type;
  // Mapped phrases (from the plan's evidence table).
  if (hay.includes('text-became-success') || hay.includes('text_became_success')) return 'text_became_success';
  if (hay.includes('new-confirmation-node') || hay.includes('new_confirmation_node')) return 'new_confirmation_node';
  if (hay.includes('confirm-signal') || hay.includes('confirm_signal')) return 'confirm_signal';
  if (hay.includes('modal-close') || hay.includes('modal_close')) return 'modal_close_confirmed';
  if (hay.includes('manual')) return 'manual_confirmed';
  // Indeed 'type:verified detail:confirmation' and url/confirmation → url_confirmation.
  if (type === 'url' || hay.includes('url') || hay.includes('confirmation')) return 'url_confirmation';
  if (type === 'verified' || hay.includes('verified')) {
    // 'verified:text' → text; a bare 'verified' with a confirmation detail → url_confirmation.
    if (hay.includes('text')) return 'text_became_success';
    return 'url_confirmation';
  }
  return null;
}

/** v11 park_reason keyword → v12 park_kind vocabulary. */
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

/** v11 apply_route → v12 route vocabulary (null if unmappable). */
function mapRoute(route: unknown): string | null {
  const s = String(route ?? '').toLowerCase().replace(/-/g, '_');
  if (s === 'easy_apply' || s === 'easyapply') return 'easy_apply';
  if (s === 'smartapply' || s === 'smart_apply') return 'smartapply';
  if (s === 'ats_form' || s === 'ats' || s === 'form') return 'ats_form';
  if (s === 'external') return 'external';
  return null;
}

/** Pick a v12 lane from source/route (CHECK: linkedin|indeed|ats). */
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
const V12_FIELD_TYPES = new Set(['text', 'textarea', 'select', 'radio', 'checkbox', 'number', 'date', 'file']);
function mapFieldType(ft: unknown): string | null {
  if (ft == null || ft === '') return null;
  const s = String(ft).toLowerCase();
  return V12_FIELD_TYPES.has(s) ? s : 'text';
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
// Each entry: v11 section.key (dot path in the v11 settings/kv shape) → v12 (section, key).
const SETTINGS_ALLOW: { v11Section: string; v11Key: string; v12Section: string; v12Key: string }[] = [
  { v11Section: 'autoApply', v11Key: 'keywords', v12Section: 'autoApply', v12Key: 'keywords' },
  { v11Section: 'autoApply', v11Key: 'locations', v12Section: 'autoApply', v12Key: 'locations' },
  { v11Section: 'autoApply', v11Key: 'workModes', v12Section: 'autoApply', v12Key: 'workModes' },
  { v11Section: 'autoApply', v11Key: 'country', v12Section: 'autoApply', v12Key: 'country' },
  { v11Section: 'autoApply', v11Key: 'seniorityMax', v12Section: 'autoApply', v12Key: 'seniorityMax' },
  { v11Section: 'autoApply', v11Key: 'easyApplyOnly', v12Section: 'autoApply', v12Key: 'easyApplyOnly' },
  { v11Section: 'autoApply', v11Key: 'maxPerDay', v12Section: 'autoApply', v12Key: 'maxPerDay' },
  { v11Section: 'autoApply', v11Key: 'maxPerHour', v12Section: 'autoApply', v12Key: 'maxPerHour' },
  { v11Section: 'appearance', v11Key: 'theme', v12Section: 'appearance', v12Key: 'theme' },
];
/** notifications.* is a whole-section allow (any key under it, minus obvious secret-shaped keys). */
const SETTINGS_ALLOW_SECTIONS = new Set(['notifications']);
/** Keys that look like secrets and are dropped even inside an allowed section. */
const SECRET_KEY_RX = /(apikey|api_key|secret|token|password|clientsecret|oauth|refresh|access_token)/i;

// ==================================================================================================
//  SHAPE READ — one read-only pass that both plan() and execute() build on. Zero v12 writes.
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

/** Open the SOURCE v11 db read-only, after the lock gate. Feature-detect every table we touch. */
function openSource(sourcePath: string): SourceHandle {
  if (!existsSync(sourcePath)) {
    throw new ImportError('NOT_FOUND', `No JAT v11 database at ${sourcePath}.`);
  }
  // Lock gate: `jat.db.lock` is a DIRECTORY (node-sqlite3-wasm mkdir-lock) sitting next to the source.
  const lockDir = join(dirname(sourcePath), 'jat.db.lock');
  if (existsSync(lockDir) && statSync(lockDir).isDirectory()) {
    throw new ImportError(
      'V11_LOCK_PRESENT',
      'JAT v11 is running or crashed while holding its lock. Quit v11 (or delete the stale jat.db.lock folder if v11 is certainly not running) and retry.',
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
 * Resolve the v12 profile_id for a v11 job/application. v11 assigned sources to profiles via
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
    // source_assignments is a JSON array of source keys (or of {source} objects) owned by this profile.
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
//  PLAN (dry run) — read-only over the source; touches NOTHING in v12.
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
//  EXECUTE — one transaction PER SECTION into the migrated v12 db. Idempotent. Writes an audit row.
// ==================================================================================================

export function executeImport(v12db: DB, sourcePath: string, opts: ExecuteOptions = {}): ExecuteResult {
  const now = opts.now ?? (() => Date.now());
  const newId = opts.newId ?? ((prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);

  const src = openSource(sourcePath);
  const sectionErrors: { section: string; error: string }[] = [];
  let report: ImportReport;

  try {
    // Build the plan report first (counts drive both the dry-run parity and the audit row). Then the
    // execute passes mutate v12 section-by-section, each in its own transaction. A failing section
    // rolls back only itself, is recorded, and earlier committed sections stay (they re-run clean).
    report = buildReport(src, v12db);
  } catch (e) {
    src.db.close();
    throw e;
  }

  const startedAt = now();
  const importRunId = newId('import');

  // A section runner: wrap the writes in a transaction; on failure record + continue.
  function section(name: string, fn: () => void): void {
    try {
      const tx = v12db.transaction(fn);
      tx();
    } catch (e) {
      sectionErrors.push({ section: name, error: (e as Error).message });
    }
  }

  const ctx: WriteCtx = { v12db, src, now, newId };

  section('jobs', () => importJobsAndApplications(ctx));
  section('answers', () => importAnswers(ctx));
  section('documents', () => importDocuments(ctx));
  section('emails', () => importEmails(ctx));
  section('events', () => importEvents(ctx));
  section('runs', () => importRuns(ctx));
  section('settings', () => importSettings(ctx));
  section('blocklist', () => importBlocklist(ctx));

  const status: ExecuteResult['status'] =
    sectionErrors.length === 0 ? 'ok' : sectionErrors.length >= 8 ? 'failed' : 'partial';

  // Audit row (its own write; report_json capped at the CHECK's 256KB — trim missingList if huge).
  const finishedAt = now();
  writeAuditRow(v12db, {
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
  v12db: DB;
  src: SourceHandle;
  now: () => number;
  newId: (prefix: string) => string;
}

// ==================================================================================================
//  REPORT BUILDER — computes the counts. When v12db is passed we also learn what already exists so the
//  counts honestly say toCreate vs skippedExisting (idempotency reflected in the numbers).
// ==================================================================================================

function existsInV12(v12db: DB | null, sql: string, param: string): boolean {
  if (!v12db) return false;
  return v12db.prepare(sql).get(param) !== undefined;
}

function buildReport(src: SourceHandle, v12db: DB | null): ImportReport {
  const { db, shapes } = src;
  const warnings = [...src.warnings];

  // ---- profiles
  const profileRows = selectExisting(db, 'profiles', shapes.profiles!);
  let profilesToCreate = 0;
  let profilesExisting = 0;
  for (const p of profileRows) {
    const id = String(col(p, shapes.profiles!, 'id') ?? '');
    if (!id) continue;
    if (existsInV12(v12db, 'SELECT 1 FROM profiles WHERE id = ?', id)) profilesExisting++;
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
    const jobExists = existsInV12(v12db, 'SELECT 1 FROM jobs WHERE id = ?', id);
    if (jobExists) jobsExisting++;
    else {
      // merge-dedup: a native v12 job with the same norm_key/url_norm already exists under a diff id.
      const jobUrl = String(col(j, shapes.jobs!, 'job_url') ?? '');
      const urlNorm = normJobUrl(jobUrl);
      if (v12db && urlNorm && v12db.prepare('SELECT 1 FROM jobs WHERE job_url_norm = ? AND id <> ?').get(urlNorm, id)) {
        mergeDedup++;
      } else {
        jobsToCreate++;
      }
    }
    // one application per job (unless it already exists)
    const applId = `appl_v11_${id}`;
    if (!existsInV12(v12db, 'SELECT 1 FROM applications WHERE id = ?', applId)) {
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
    if (v12db && v12db.prepare('SELECT 1 FROM learned_answers WHERE profile_id=? AND kind=? AND key_norm=?').get(profileId, 'field', keyNorm)) fieldsExisting++;
    else fieldsCreate++;
  }

  const qaRows = selectExisting(db, 'qa', shapes.qa!);
  let qaCreate = 0, qaExisting = 0, qaSensitive = 0;
  for (const q of qaRows) {
    const question = String(col(q, shapes.qa!, 'question') ?? '');
    const keyNorm = String(col(q, shapes.qa!, 'question_norm') ?? normQuestion(question));
    if (isSensitiveKey(keyNorm)) { qaSensitive++; continue; }
    const profileId = String(col(q, shapes.qa!, 'profile_id') ?? '');
    if (v12db && v12db.prepare('SELECT 1 FROM learned_answers WHERE profile_id=? AND kind=? AND key_norm=?').get(profileId, 'qa', keyNorm)) qaExisting++;
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
    if (existsInV12(v12db, 'SELECT 1 FROM documents WHERE id = ?', id)) { docsExisting++; continue; }
    const filePath = String(col(d, shapes.documents!, 'file_path') ?? '');
    const name = String(col(d, shapes.documents!, 'name') ?? 'document');
    if (filePath && existsSync(filePath)) {
      const sha = createHash('sha256').update(readFileSync(filePath)).digest('hex');
      if (seenSha.has(sha) || (v12db && v12db.prepare('SELECT 1 FROM documents WHERE sha256 = ?').get(sha))) {
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
    if (existsInV12(v12db, 'SELECT 1 FROM emails WHERE id = ?', id)) emailsExisting++;
    else emailsCreate++;
    const matchedJobId = col(e, shapes.emails!, 'matched_job_id');
    if (matchedJobId != null && matchedJobId !== '') {
      const jid = String(matchedJobId);
      // job must import (be present in the v11 job set OR already in v12)
      const jobPresent = jobIdSet.has(jid) || existsInV12(v12db, 'SELECT 1 FROM jobs WHERE id = ?', jid);
      if (jobPresent) matchesToCreate++;
      else matchesDroppedNoJob++;
    }
  }

  // ---- events (filtered by v12 kind vocabulary)
  const eventRows = selectExisting(db, 'events', shapes.events!);
  let eventsCreate = 0;
  const droppedKinds: Record<string, number> = {};
  for (const ev of eventRows) {
    // v11 events column is `type`, not `kind` — the plan must read the SAME fallback execute uses,
    // else the dry-run report falsely says every event will be dropped as 'unknown'.
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
    if (existsInV12(v12db, 'SELECT 1 FROM apply_runs WHERE id = ?', runId)) continue; // skippedExisting
    runsCreate++;
    if (decision.state === 'submitted') submittedVerified++;
    else if (decision.state === 'parked' && decision.evidenceKind === 'legacy_untrusted') quarantinedLegacy++;
    else if (decision.state === 'parked') parked++;
    else if (decision.state === 'failed') failed++;
    else if (decision.state === 'skipped') skipped++;
  }

  // ---- settings (allow-map)
  const importedSettings = computeSettingsPlan(src).map((s) => `${s.section}.${s.key}`);

  // ---- blocklist (punishments)
  const punishmentRows = selectExisting(db, 'punishments', shapes.punishments!);
  let blockCreate = 0, blockExisting = 0;
  for (const p of punishmentRows) {
    const id = blocklistIdFor(p, shapes.punishments!);
    if (existsInV12(v12db, 'SELECT 1 FROM blocklist WHERE id = ?', id)) blockExisting++;
    else blockCreate++;
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
    settings: { imported: importedSettings, defaulted: 'everything else' },
    blocklist: { found: punishmentRows.length, toCreate: blockCreate, skippedExisting: blockExisting },
    sensitiveDropped,
    willImport: true,
  };
}

// ---- events kind filter ---------------------------------------------------------------------------
const V12_EVENT_KINDS = new Set(['status_change', 'submitted', 'park', 'email_matched', 'note', 'imported', 'created', 'document_attached']);
function mapEventKind(kind: unknown): string | null {
  const s = String(kind ?? '').toLowerCase();
  if (V12_EVENT_KINDS.has(s)) return s;
  // a couple of v11 synonyms (v11 events.type = created | status_changed | progressing | …)
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

/** Return the terminal v12 run decision, or null when the task is stale in-flight (NOT imported). */
function decideRunState(task: Record<string, unknown>, shape: TableShape): RunDecision | null {
  // v11 auto_apply_tasks column is `state` (not `status`) — try both for forward-compat.
  const status = String(col(task, shape, 'state') ?? col(task, shape, 'status') ?? '').toLowerCase();

  // In-flight / not-yet-run states are stale — the v12 scheduler starts clean.
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

// ---- blocklist id (deterministic from company+title so re-runs dedup) -----------------------------
function blocklistIdFor(p: Record<string, unknown>, shape: TableShape): string {
  const company = normKey(String(col(p, shape, 'company') ?? col(p, shape, 'company_key') ?? ''));
  const title = String(col(p, shape, 'title') ?? col(p, shape, 'title_rx') ?? '');
  const hash = createHash('sha256').update(`${company}|${title}`).digest('hex').slice(0, 16);
  return `block_v11_${hash}`;
}

// ==================================================================================================
//  SECTION IMPORTERS — each is called inside its own transaction. Parameterized SQL only.
// ==================================================================================================

function importJobsAndApplications(ctx: WriteCtx): void {
  const { v12db, src, now } = ctx;
  const shapes = src.shapes;
  const jobShape = shapes.jobs!;

  // First: profiles (applications need them; FK). Preserve id/is_default/assignments/data verbatim.
  const profileRows = selectExisting(src.db, 'profiles', shapes.profiles!);
  const resolver = buildProfileResolver(profileRows, shapes.profiles!);

  const insProfile = v12db.prepare(
    `INSERT INTO profiles (id, name, is_default, source_assignments_json, data_json, created_at, updated_at)
     VALUES (@id, @name, @is_default, @source_assignments_json, @data_json, @created_at, @updated_at)
     ON CONFLICT(id) DO NOTHING`,
  );
  // Ensure a default profile exists even if v11 had none (needed by the resolver / applications).
  let defaultProfileId = resolver.defaultProfileId;
  for (const p of profileRows) {
    const id = String(col(p, shapes.profiles!, 'id') ?? '');
    if (!id) continue;
    const created = toEpochMs(col(p, shapes.profiles!, 'created_at')) ?? toEpochMs(col(p, shapes.profiles!, 'updated_at')) ?? now();
    const updated = toEpochMs(col(p, shapes.profiles!, 'updated_at')) ?? created;
    // Only ONE row may have is_default=1 (partial unique index). Honor v11's default; others → 0.
    const isDefault = id === defaultProfileId ? 1 : 0;
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
    const existingDefault = v12db.prepare('SELECT id FROM profiles WHERE is_default = 1').get() as { id: string } | undefined;
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

  const insJob = v12db.prepare(
    `INSERT INTO jobs (id, source, external_id, title, company, company_key, location, work_mode,
        employment_type, compensation, job_url, job_url_norm, norm_key, apply_capability, fit_score,
        tags_json, posting_state, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (@id, @source, @external_id, @title, @company, @company_key, @location, @work_mode,
        @employment_type, @compensation, @job_url, @job_url_norm, @norm_key, @apply_capability, @fit_score,
        @tags_json, @posting_state, @first_seen_at, @last_seen_at, @created_at, @updated_at)
     ON CONFLICT(id) DO NOTHING`,
  );
  const insDetails = v12db.prepare(
    `INSERT INTO job_details (job_id, description, fit_json, raw_json)
     VALUES (@job_id, @description, @fit_json, @raw_json)
     ON CONFLICT(job_id) DO NOTHING`,
  );
  const insAppl = v12db.prepare(
    `INSERT INTO applications (id, job_id, profile_id, status, via, submitted_at, answers_json,
        attachments_json, notes, next_action, due_at, needs_review, created_at, updated_at)
     VALUES (@id, @job_id, @profile_id, @status, @via, @submitted_at, @answers_json,
        @attachments_json, @notes, @next_action, @due_at, @needs_review, @created_at, @updated_at)
     ON CONFLICT(id) DO NOTHING`,
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

    // details (description + fit) — only if the job row inserted or already present
    insDetails.run({
      job_id: id,
      description: clampStr(col(j, jobShape, 'description') ?? '', CAP.description),
      fit_json: jsonOrNull(col(j, jobShape, 'fit_data') ?? col(j, jobShape, 'fit'), CAP.fitJson),
      raw_json: jsonOrNull(col(j, jobShape, 'raw') ?? col(j, jobShape, 'raw_json'), 131072),
    });

    // one application per job
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
  const { v12db, src, now } = ctx;
  const shapes = src.shapes;

  const insAnswer = v12db.prepare(
    `INSERT INTO learned_answers (id, profile_id, kind, key_norm, label, locale, field_type, value,
        options_json, confidence, provenance, locked, seen_count, used_count, last_used_at,
        source_host, source_job_id, created_at, updated_at)
     VALUES (@id, @profile_id, @kind, @key_norm, @label, @locale, @field_type, @value,
        @options_json, @confidence, @provenance, @locked, @seen_count, @used_count, @last_used_at,
        @source_host, @source_job_id, @created_at, @updated_at)
     ON CONFLICT(profile_id, kind, key_norm) DO NOTHING`,
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
  const { v12db, src, now } = ctx;
  const shape = src.shapes.documents!;

  const insDoc = v12db.prepare(
    `INSERT INTO documents (id, profile_id, name, role, label, mime, size_bytes, sha256, is_default,
        source, origin_path, missing_file, created_at, updated_at)
     VALUES (@id, @profile_id, @name, @role, @label, @mime, @size_bytes, @sha256, @is_default,
        @source, @origin_path, @missing_file, @created_at, @updated_at)
     ON CONFLICT(id) DO NOTHING`,
  );
  const insBlob = v12db.prepare(
    `INSERT INTO document_blobs (document_id, bytes) VALUES (@document_id, @bytes)
     ON CONFLICT(document_id) DO NOTHING`,
  );
  const insText = v12db.prepare(
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
    const profileId = valueOrNull(col(d, shape, 'profile_id'));

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
      const dup = v12db.prepare('SELECT 1 FROM documents WHERE sha256 = ? AND id <> ?').get(sha, id);
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
  const { v12db, src, now } = ctx;
  const shape = src.shapes.emails!;
  const rows = selectExisting(src.db, 'emails', shape);
  if (rows.length === 0) return;

  // One synthetic 'imported' account holds all carried-over mail.
  const accountId = 'acct_v11_imported';
  v12db.prepare(
    `INSERT INTO email_accounts (id, kind, email, label, enabled, token_state, created_at, updated_at)
     VALUES (@id, 'imported', @email, 'Imported from v11', 1, 'unauthorized', @t, @t)
     ON CONFLICT(id) DO NOTHING`,
  ).run({ id: accountId, email: '', t: now() });

  const insEmail = v12db.prepare(
    `INSERT INTO emails (id, account_id, provider, provider_msg_id, message_id, thread_id, from_addr,
        from_name, to_addr, subject, snippet, body, sent_at, category, classified_by, created_at)
     VALUES (@id, @account_id, 'imported', @provider_msg_id, @message_id, @thread_id, @from_addr,
        @from_name, @to_addr, @subject, @snippet, @body, @sent_at, @category, @classified_by, @created_at)
     ON CONFLICT(id) DO NOTHING`,
  );
  const insMatch = v12db.prepare(
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
      const jobPresent = v12db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(jid) !== undefined;
      if (jobPresent) {
        const applId = `appl_v11_${jid}`;
        const applPresent = v12db.prepare('SELECT 1 FROM applications WHERE id = ?').get(applId) !== undefined;
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
  const { v12db, src, now } = ctx;
  const shape = src.shapes.events!;
  if (!shape.exists) return;

  const insEvent = v12db.prepare(
    `INSERT INTO events (id, at, kind, job_id, application_id, run_id, email_id, source, summary, data_json)
     VALUES (@id, @at, @kind, @job_id, @application_id, @run_id, @email_id, @source, @summary, @data_json)
     ON CONFLICT(id) DO NOTHING`,
  );

  for (const ev of selectExisting(src.db, 'events', shape)) {
    const kind = mapEventKind(col(ev, shape, 'kind') ?? col(ev, shape, 'type')); // v11 col is `type`
    if (!kind) continue; // dropped kind
    const id = String(col(ev, shape, 'id') ?? ctx.newId('evt'));
    const jobId = valueOrNull(col(ev, shape, 'job_id'));
    // application only if it exists (derive from the deterministic id; FK is ON)
    let applId: string | null = null;
    if (jobId) {
      const cand = `appl_v11_${jobId}`;
      if (v12db.prepare('SELECT 1 FROM applications WHERE id = ?').get(cand)) applId = cand;
    }
    // job FK is ON — only reference a job that actually imported
    const jobRef = jobId && v12db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(jobId) ? jobId : null;
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
  const { v12db, src, now } = ctx;
  const shape = src.shapes.auto_apply_tasks!;
  if (!shape.exists) return;

  const insRun = v12db.prepare(
    `INSERT INTO apply_runs (id, application_id, job_id, profile_id, source, lane, state, mode, route,
        attempt, park_kind, park_detail, pending_questions_json, error, evidence_kind, evidence_json,
        steps_count, queued_at, started_at, finished_at, updated_at)
     VALUES (@id, @application_id, @job_id, @profile_id, @source, @lane, @state, 'auto', @route,
        @attempt, @park_kind, @park_detail, @pending_questions_json, @error, @evidence_kind, @evidence_json,
        0, @queued_at, @started_at, @finished_at, @updated_at)
     ON CONFLICT(id) DO NOTHING`,
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
    const appl = v12db.prepare('SELECT profile_id FROM applications WHERE id = ?').get(applId) as { profile_id: string } | undefined;
    if (!appl) continue; // no application (job didn't import) → skip the run rather than orphan it.

    const route = mapRoute(col(t, shape, 'apply_route') ?? col(t, shape, 'route'));
    const created = toEpochMs(col(t, shape, 'created_at') ?? col(t, shape, 'queued_at')) ?? now();
    const finished = toEpochMs(col(t, shape, 'finished_at') ?? col(t, shape, 'updated_at')) ?? created;
    // v11 auto_apply_tasks has NO source column — source lives on the joined job. Deriving it from the
    // task row silently stamped every Indeed/ATS run as 'linkedin'; read the authoritative job source.
    const jobSource = (v12db.prepare('SELECT source FROM jobs WHERE id = ?').get(jobId) as { source?: string } | undefined)?.source
      ?? (col(t, shape, 'source') as string | undefined);

    insRun.run({
      id: `run_v11_${taskId}`,
      application_id: applId,
      job_id: jobId,
      profile_id: appl.profile_id,
      source: clampStr(jobSource ?? 'linkedin', 64) || 'linkedin',
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
  }
}

function importSettings(ctx: WriteCtx): void {
  const { v12db, src, now } = ctx;
  const plan = computeSettingsPlan(src);
  const insSetting = v12db.prepare(
    `INSERT INTO settings (section, key, value_json, schema_version, updated_at)
     VALUES (@section, @key, @value_json, 1, @updated_at)
     ON CONFLICT(section, key) DO NOTHING`,
  );
  for (const s of plan) {
    insSetting.run({ section: s.section, key: s.key, value_json: s.valueJson, updated_at: now() });
  }
}

function importBlocklist(ctx: WriteCtx): void {
  const { v12db, src, now } = ctx;
  const shape = src.shapes.punishments!;
  if (!shape.exists) return;

  const insBlock = v12db.prepare(
    `INSERT INTO blocklist (id, company_key, title_rx, reason, created_at)
     VALUES (@id, @company_key, @title_rx, @reason, @created_at)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const p of selectExisting(src.db, 'punishments', shape)) {
    const company = col(p, shape, 'company') ?? col(p, shape, 'company_key');
    const title = col(p, shape, 'title') ?? col(p, shape, 'title_rx');
    insBlock.run({
      id: blocklistIdFor(p, shape),
      company_key: company != null ? clampStr(normKey(String(company)), CAP.reason) : null,
      title_rx: clampOrNull(title, CAP.reason),
      reason: clampOrNull(col(p, shape, 'reason'), CAP.reason),
      created_at: toEpochMs(col(p, shape, 'created_at')) ?? now(),
    });
  }
}

// ==================================================================================================
//  SETTINGS PLAN — the curated allow-map, computed once (used by both report + execute).
// ==================================================================================================

interface SettingWrite {
  section: string;
  key: string;
  valueJson: string;
}

function computeSettingsPlan(src: SourceHandle): SettingWrite[] {
  const shape = src.shapes.settings;
  if (!shape || !shape.exists) return [];
  const rows = selectExisting(src.db, 'settings', shape);

  // v11 settings shape is flexible: it may be (section,key,value) rows, or (key,value) rows where the
  // key is a dot-path. Build a lookup of section.key → value, whichever shape is present.
  const flat = new Map<string, unknown>();
  for (const r of rows) {
    const section = shape.cols.has('section') ? String(r.section ?? '') : '';
    const rawKey = String(r.key ?? '');
    const value = r.value ?? r.value_json ?? r.data;
    if (section) flat.set(`${section}.${rawKey}`, value);
    else flat.set(rawKey, value); // rawKey is already a dot-path
  }

  const out: SettingWrite[] = [];
  const emitted = new Set<string>();

  // explicit allow entries
  for (const a of SETTINGS_ALLOW) {
    const dot = `${a.v11Section}.${a.v11Key}`;
    if (!flat.has(dot)) continue;
    const value = flat.get(dot);
    if (value == null || value === '') continue;
    const valueJson = coerceSettingJson(value);
    if (valueJson == null) continue;
    const tag = `${a.v12Section}.${a.v12Key}`;
    if (emitted.has(tag)) continue;
    emitted.add(tag);
    out.push({ section: a.v12Section, key: a.v12Key, valueJson });
  }

  // whole-section allow (notifications.*), minus secret-shaped keys
  for (const [dot, value] of flat) {
    const dotIdx = dot.indexOf('.');
    if (dotIdx < 0) continue;
    const section = dot.slice(0, dotIdx);
    const key = dot.slice(dotIdx + 1);
    if (!SETTINGS_ALLOW_SECTIONS.has(section)) continue;
    if (SECRET_KEY_RX.test(key)) continue; // never import secret-shaped keys
    if (value == null || value === '') continue;
    const valueJson = coerceSettingJson(value);
    if (valueJson == null) continue;
    const tag = `${section}.${key}`;
    if (emitted.has(tag)) continue;
    emitted.add(tag);
    out.push({ section, key, valueJson });
  }

  return out;
}

/** Coerce a v11 setting value into a valid, capped JSON string for value_json. null → skip. */
function coerceSettingJson(value: unknown): string | null {
  let json: string;
  if (typeof value === 'string') {
    // Might already be JSON; if not, wrap it as a JSON string.
    const t = value.trim();
    if ((t.startsWith('{') || t.startsWith('[') || t.startsWith('"') || t === 'true' || t === 'false' || /^-?\d/.test(t))) {
      try {
        JSON.parse(t);
        json = t;
      } catch {
        json = JSON.stringify(value);
      }
    } else {
      json = JSON.stringify(value);
    }
  } else {
    try {
      json = JSON.stringify(value);
    } catch {
      return null;
    }
  }
  if (json.length > 16384) return null;
  return json;
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

function writeAuditRow(v12db: DB, a: AuditInput): void {
  // report_json is CHECK-capped at 256KB. Trim the missingList (the only unbounded field) if needed.
  let report = a.report;
  let reportJson = JSON.stringify(report);
  if (reportJson.length > 262_144) {
    report = { ...report, documents: { ...report.documents, missingList: report.documents.missingList.slice(0, 10) } };
    reportJson = JSON.stringify(report);
    if (reportJson.length > 262_144) reportJson = JSON.stringify({ trimmed: true, status: a.status });
  }
  v12db.prepare(
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

/** Merge v11 tags (array or comma-string) + the 'imported-v11' marker → a JSON array string source. */
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
