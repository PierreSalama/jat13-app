// fit_scores DAL — the queue-ordering authority (table: fit_scores, migration 001). ONE row per
// (job_id, profile_id): the PK is (job_id, profile_id) WITHOUT ROWID, so a later AI score OVERWRITES
// the deterministic one for the same job+profile — there is never a duplicate, `scorer` records who
// last wrote it. jobs.fit_score is the denormalized cache the list projection ships; the fit SERVICE
// (engine/fit.ts) keeps it in sync via dal.jobs.patch — this DAL owns ONLY the fit_scores table.
//
// INTEGRATION NOTE (deliberate): makeFitDal is NOT added to makeDal()/the Dal aggregate. The fit
// SERVICE constructs it from the shared ctx (makeFitDal(dal.ctx)); wiring it into the aggregate is the
// integrator's call. Kept out so the read/import DAL surface (Stage 1) doesn't grow an engine table.
//
// Ported to the v1 (migration 001) columns verbatim: score 0-100 (CHECK), scorer in
// ('deterministic','ai'), backend in ('claude','codex') for AI scores only, reasons_json <= 8192,
// floor_decision in ('pass','skip'), floor_value 0-100 nullable, scored_at epoch-ms.

import type { DalContext, DomainEvent } from './index.js';
import { makeStmtCache } from './index.js';

// ---- vocabularies (bind to the fit_scores CHECKs) -------------------------------------------------
export type FitScorer = 'deterministic' | 'ai';
export type FitBackend = 'claude' | 'codex';
export type FloorDecision = 'pass' | 'skip';

// ---- caps (mirror the migration-001 CHECKs; clamp/validate BEFORE SQLite rejects opaquely) --------
const MAX_REASONS_JSON = 8192;

/** A hydrated fit_scores row (reasons_json parsed). */
export interface FitScore {
  job_id: string;
  profile_id: string;
  score: number;
  scorer: FitScorer;
  backend: FitBackend | null;
  reasons: string[];
  floor_decision: FloorDecision;
  floor_value: number | null;
  scored_at: number;
}

/** Everything upsert() needs. `scorer` is 'deterministic' at Stage 3; 'ai' + a backend arrives Stage 4. */
export interface UpsertFitInput {
  score: number;
  scorer: FitScorer;
  reasons: string[];
  floorDecision: FloorDecision;
  /** the floor the score was compared against (for the "why skipped" UI); NULL when floor disabled. */
  floorValue?: number | null;
  /** which CLI produced an AI score; MUST be null/omitted for deterministic. */
  backend?: FitBackend | null;
}

const COLS = 'job_id, profile_id, score, scorer, backend, reasons_json, floor_decision, floor_value, scored_at';

interface FitRow {
  job_id: string;
  profile_id: string;
  score: number;
  scorer: FitScorer;
  backend: FitBackend | null;
  reasons_json: string;
  floor_decision: FloorDecision;
  floor_value: number | null;
  scored_at: number;
}

/** Defensive parse — the CHECK guarantees valid JSON on write, but a read must never crash. */
function parseReasons(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function hydrate(row: FitRow): FitScore {
  return {
    job_id: row.job_id,
    profile_id: row.profile_id,
    score: row.score,
    scorer: row.scorer,
    backend: row.backend,
    reasons: parseReasons(row.reasons_json),
    floor_decision: row.floor_decision,
    floor_value: row.floor_value,
    scored_at: row.scored_at,
  };
}

/** Serialize reasons into reasons_json, dropping TRAILING (weaker) entries until it fits the cap —
 *  the leading reasons are the strongest signals, so the head survives. Never rejects. */
function serializeReasons(reasons: string[]): string {
  let arr = reasons.filter((r) => typeof r === 'string');
  let json = JSON.stringify(arr);
  while (json.length > MAX_REASONS_JSON && arr.length > 0) {
    arr = arr.slice(0, -1);
    json = JSON.stringify(arr);
  }
  return json.length > MAX_REASONS_JSON ? '[]' : json;
}

/** Clamp a score into the CHECK band; round to an int (the column is INTEGER). */
function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Clamp an optional floor value to the 0-100 band, or null. */
function clampFloor(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function makeFitDal(ctx: DalContext) {
  const stmt = makeStmtCache(ctx.db);

  function getRaw(jobId: string, profileId: string): FitRow | undefined {
    return stmt(`SELECT ${COLS} FROM fit_scores WHERE job_id = ? AND profile_id = ?`).get(
      jobId,
      profileId,
    ) as FitRow | undefined;
  }

  /** The current fit score for a job+profile, or null when never scored. */
  function get(jobId: string, profileId: string): FitScore | null {
    const row = getRaw(jobId, profileId);
    return row ? hydrate(row) : null;
  }

  /**
   * Upsert THE fit score for (jobId, profileId). Overwrites any prior row (the PK collapses
   * deterministic + ai to one row; `scorer` says who won). Validates the vocab + clamps numbers
   * loudly-in-TS before the CHECKs fire. Emits a lean patch. Returns the stored row.
   */
  function upsert(jobId: string, profileId: string, input: UpsertFitInput): FitScore {
    if (input.scorer !== 'deterministic' && input.scorer !== 'ai') {
      throw new Error(`fit_scores.scorer must be 'deterministic' | 'ai' (got ${String(input.scorer)})`);
    }
    if (input.floorDecision !== 'pass' && input.floorDecision !== 'skip') {
      throw new Error(`fit_scores.floor_decision must be 'pass' | 'skip' (got ${String(input.floorDecision)})`);
    }
    // backend is meaningful only for AI scores; a deterministic score never carries one.
    const backend =
      input.scorer === 'ai'
        ? input.backend === 'claude' || input.backend === 'codex'
          ? input.backend
          : null
        : null;

    const row = {
      job_id: jobId,
      profile_id: profileId,
      score: clampScore(input.score),
      scorer: input.scorer,
      backend,
      reasons_json: serializeReasons(input.reasons ?? []),
      floor_decision: input.floorDecision,
      floor_value: clampFloor(input.floorValue),
      scored_at: ctx.now(),
    };

    stmt(
      `INSERT INTO fit_scores (${COLS})
         VALUES (@job_id, @profile_id, @score, @scorer, @backend, @reasons_json, @floor_decision, @floor_value, @scored_at)
       ON CONFLICT(job_id, profile_id) DO UPDATE SET
         score = excluded.score,
         scorer = excluded.scorer,
         backend = excluded.backend,
         reasons_json = excluded.reasons_json,
         floor_decision = excluded.floor_decision,
         floor_value = excluded.floor_value,
         scored_at = excluded.scored_at`,
    ).run(row);

    const stored = hydrate(getRaw(jobId, profileId)!);
    const evt: DomainEvent = {
      table: 'fit_scores',
      op: 'update',
      id: `${jobId}:${profileId}`,
      patch: {
        job_id: stored.job_id,
        profile_id: stored.profile_id,
        score: stored.score,
        scorer: stored.scorer,
        floor_decision: stored.floor_decision,
        scored_at: stored.scored_at,
      },
    };
    ctx.emit(evt);
    return stored;
  }

  /**
   * Fit scores for a set of job ids — the queue view's batch read (one row per job when profileId is
   * given, since the PK is job+profile). Bounded by the caller's id list; empty in → empty out.
   */
  function listForJobs(jobIds: string[], profileId?: string): FitScore[] {
    if (!Array.isArray(jobIds) || jobIds.length === 0) return [];
    // Cap the IN-list so a pathological caller can't build a giant statement; the queue reads pages.
    const ids = jobIds.slice(0, 1000);
    const placeholders = ids.map(() => '?').join(',');
    const where =
      profileId !== undefined
        ? `WHERE job_id IN (${placeholders}) AND profile_id = ?`
        : `WHERE job_id IN (${placeholders})`;
    const args = profileId !== undefined ? [...ids, profileId] : ids;
    const rows = stmt(`SELECT ${COLS} FROM fit_scores ${where}`).all(...args) as FitRow[];
    return rows.map(hydrate);
  }

  return { get, upsert, listForJobs };
}

export type FitDal = ReturnType<typeof makeFitDal>;
