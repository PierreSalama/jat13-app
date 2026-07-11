// autopsies DAL — the per-run post-mortem store (table: autopsies). Every TERMINAL apply_run gets one
// structured post-mortem (what happened, where it stopped, a condensed step trail, the blocking
// control) written by engine/autopsy.ts. A `signature` groups recurring failures ("same failure ×N")
// so the Autopsies page can render pattern cards and (Stage 6) propose a one-click remedy.
//
// run_id is UNIQUE — record() is idempotent (a terminal run writes exactly one autopsy; a re-attempt
// returns the existing row rather than throwing). Lists are LEAN (no step_trail_json / proposal_json
// blobs — payload law); get() hydrates the JSON columns for the one-row detail read.

import type { DalContext, DomainEvent, LeanPage } from './index.js';
import { makeStmtCache, clampLimit, clampOffset } from './index.js';
import type { RunLane, ParkKind } from './runs.js';

// ---- vocabularies (bind to the autopsies CHECKs in migration 001) ----------

/** Terminal states only — needs_human is NOT terminal (it released its slot awaiting the human), so a
 *  paused run never writes an autopsy. Mirrors the autopsies.final_state CHECK. */
export type AutopsyFinalState = 'submitted' | 'ready_for_review' | 'parked' | 'skipped' | 'failed';

export type ProposalState = 'none' | 'proposed' | 'applied' | 'dismissed';

// ---- caps (mirror the migration-001 CHECKs; clamp BEFORE SQLite rejects) ---
const MAX_PAGE_KEY = 128;
const MAX_BLOCKING = 256;
const MAX_SUMMARY = 4096;
const MAX_SIGNATURE = 256;
const MAX_STEP_TRAIL = 16384;
const MAX_PROPOSAL = 8192;

// ---- row shapes -------------------------------------------------------------

/** Full autopsy row (step_trail_json / proposal_json parsed defensively). */
export interface Autopsy {
  id: string;
  run_id: string;
  application_id: string | null;
  job_id: string | null;
  lane: RunLane;
  final_state: AutopsyFinalState;
  park_kind: ParkKind | null;
  page_key: string | null;
  blocking_control: string | null;
  step_trail: unknown[];
  summary: string | null;
  signature: string;
  proposal: unknown;
  proposal_state: ProposalState;
  created_at: number;
}

/** Lean list row — NO step_trail_json / proposal_json blobs (payload law). */
export interface AutopsyLean {
  id: string;
  run_id: string;
  application_id: string | null;
  job_id: string | null;
  lane: RunLane;
  final_state: AutopsyFinalState;
  park_kind: ParkKind | null;
  page_key: string | null;
  blocking_control: string | null;
  summary: string | null;
  signature: string;
  proposal_state: ProposalState;
  created_at: number;
}

/** Input to record(). `runId` is the first positional arg; the engine writer supplies the context
 *  (lane/application/job come from the run row). `signature` is derived from the failure shape when
 *  omitted so recurring failures group. */
export interface RecordAutopsyInput {
  applicationId?: string | null;
  jobId?: string | null;
  lane: RunLane;
  finalState: AutopsyFinalState;
  parkKind?: ParkKind | null;
  /** last classified page key. */
  lastPageClass?: string | null;
  blockingControl?: string | null;
  /** condensed step trail (small array of {phase,action,target}); serialized to step_trail_json. */
  stepTrail?: unknown[];
  summary?: string | null;
  /** pattern-miner group key; derived from lane|final|park|page when omitted. */
  signature?: string;
  /** optional remedy proposal (adapter patch / learned answer / setting); serialized to proposal_json. */
  proposal?: unknown;
}

export interface ListRecentInput {
  signature?: string;
  lane?: RunLane;
  finalState?: AutopsyFinalState;
  limit?: number;
  offset?: number;
}

// ---- column lists (explicit — never SELECT *) -------------------------------

const FULL_COLS =
  'id, run_id, application_id, job_id, lane, final_state, park_kind, page_key, blocking_control, ' +
  'step_trail_json, summary, signature, proposal_json, proposal_state, created_at';

const LEAN_COLS =
  'id, run_id, application_id, job_id, lane, final_state, park_kind, page_key, blocking_control, ' +
  'summary, signature, proposal_state, created_at';

// ---- raw row types (before defensive JSON parse) ---------------------------

interface FullRow {
  id: string; run_id: string; application_id: string | null; job_id: string | null; lane: RunLane;
  final_state: AutopsyFinalState; park_kind: ParkKind | null; page_key: string | null;
  blocking_control: string | null; step_trail_json: string; summary: string | null;
  signature: string; proposal_json: string | null; proposal_state: ProposalState; created_at: number;
}

/** Truncate a string to `max` chars (defensive — the DDL CHECK would reject an oversized value). */
function clampText(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/** Serialize the step trail into step_trail_json, trimming OLDEST entries until it fits the cap. */
function serializeStepTrail(trail: unknown[] | undefined): string {
  if (!trail || trail.length === 0) return '[]';
  let arr = trail.slice();
  let json = JSON.stringify(arr);
  while (json.length > MAX_STEP_TRAIL && arr.length > 0) {
    arr = arr.slice(1); // drop the oldest step; keep the trail that ends where the run stopped
    json = JSON.stringify(arr);
  }
  return json.length > MAX_STEP_TRAIL ? '[]' : json;
}

/** Serialize an optional proposal into proposal_json, or null when absent/oversized. */
function serializeProposal(proposal: unknown): string | null {
  if (proposal === undefined || proposal === null) return null;
  const json = JSON.stringify(proposal);
  if (json === undefined) return null;
  return json.length > MAX_PROPOSAL ? null : json;
}

/** Parse a JSON column defensively — malformed/legacy text degrades to a fallback, never throws. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function hydrate(row: FullRow): Autopsy {
  return {
    id: row.id,
    run_id: row.run_id,
    application_id: row.application_id,
    job_id: row.job_id,
    lane: row.lane,
    final_state: row.final_state,
    park_kind: row.park_kind,
    page_key: row.page_key,
    blocking_control: row.blocking_control,
    step_trail: parseJson<unknown[]>(row.step_trail_json, []),
    summary: row.summary,
    signature: row.signature,
    proposal: parseJson<unknown>(row.proposal_json, null),
    proposal_state: row.proposal_state,
    created_at: row.created_at,
  };
}

function leanOf(a: Autopsy): AutopsyLean & Record<string, unknown> {
  return {
    id: a.id,
    run_id: a.run_id,
    application_id: a.application_id,
    job_id: a.job_id,
    lane: a.lane,
    final_state: a.final_state,
    park_kind: a.park_kind,
    page_key: a.page_key,
    blocking_control: a.blocking_control,
    summary: a.summary,
    signature: a.signature,
    proposal_state: a.proposal_state,
    created_at: a.created_at,
  };
}

/** The pattern-miner group key: lane | final_state | park_kind | page_key. Recurring failures share it
 *  ("same failure ×N"), which is how the Autopsies page proposes one fix for a whole cluster. */
function deriveSignature(input: RecordAutopsyInput): string {
  const park = input.parkKind ?? '-';
  const page = input.lastPageClass ?? '-';
  return `${input.lane}|${input.finalState}|${park}|${page}`.slice(0, MAX_SIGNATURE);
}

export function makeAutopsiesDal(ctx: DalContext) {
  const stmt = makeStmtCache(ctx.db);

  function getRaw(id: string): FullRow | undefined {
    return stmt(`SELECT ${FULL_COLS} FROM autopsies WHERE id = ?`).get(id) as FullRow | undefined;
  }

  function getByRunRaw(runId: string): FullRow | undefined {
    return stmt(`SELECT ${FULL_COLS} FROM autopsies WHERE run_id = ?`).get(runId) as
      | FullRow
      | undefined;
  }

  /** One autopsy, JSON columns hydrated — the Autopsies detail read. */
  function get(id: string): Autopsy | null {
    const row = getRaw(id);
    return row ? hydrate(row) : null;
  }

  /** The autopsy for a run (idempotency check + the Applications drawer's autopsy link). */
  function getByRun(runId: string): Autopsy | null {
    const row = getByRunRaw(runId);
    return row ? hydrate(row) : null;
  }

  /**
   * Record a terminal run's post-mortem. Idempotent on run_id: if an autopsy already exists for this
   * run, return it unchanged (a terminal run writes exactly one). Otherwise insert and emit.
   */
  function record(runId: string, input: RecordAutopsyInput): Autopsy {
    const existing = getByRunRaw(runId);
    if (existing) return hydrate(existing);

    const id = ctx.newId('autopsy');
    const now = ctx.now();
    const signature = clampText(input.signature ?? deriveSignature(input), MAX_SIGNATURE) ?? '';

    stmt(
      `INSERT INTO autopsies
         (id, run_id, application_id, job_id, lane, final_state, park_kind, page_key,
          blocking_control, step_trail_json, summary, signature, proposal_json, proposal_state, created_at)
       VALUES
         (@id, @run_id, @application_id, @job_id, @lane, @final_state, @park_kind, @page_key,
          @blocking_control, @step_trail_json, @summary, @signature, @proposal_json, @proposal_state, @created_at)`,
    ).run({
      id,
      run_id: runId,
      application_id: input.applicationId ?? null,
      job_id: input.jobId ?? null,
      lane: input.lane,
      final_state: input.finalState,
      park_kind: input.parkKind ?? null,
      page_key: clampText(input.lastPageClass, MAX_PAGE_KEY),
      blocking_control: clampText(input.blockingControl, MAX_BLOCKING),
      step_trail_json: serializeStepTrail(input.stepTrail),
      summary: clampText(input.summary, MAX_SUMMARY),
      signature,
      proposal_json: serializeProposal(input.proposal),
      proposal_state: 'none',
      created_at: now,
    });

    const autopsy = hydrate(getRaw(id)!);
    const dEvt: DomainEvent = { table: 'autopsies', op: 'insert', id, patch: leanOf(autopsy) };
    ctx.emit(dEvt);
    return autopsy;
  }

  /** Recent autopsies (LEAN, newest first), optionally filtered by signature / lane / final_state. */
  function listRecent(input: ListRecentInput = {}): LeanPage<AutopsyLean> {
    const limit = clampLimit(input.limit, 100);
    const offset = clampOffset(input.offset);

    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (input.signature !== undefined) {
      where.push('signature = @signature');
      params.signature = input.signature;
    }
    if (input.lane !== undefined) {
      where.push('lane = @lane');
      params.lane = input.lane;
    }
    if (input.finalState !== undefined) {
      where.push('final_state = @finalState');
      params.finalState = input.finalState;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      stmt(`SELECT COUNT(*) AS c FROM autopsies ${clause}`).get(params) as { c: number }
    ).c;
    const rows = stmt(
      `SELECT ${LEAN_COLS} FROM autopsies ${clause} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`,
    ).all({ ...params, limit, offset }) as AutopsyLean[];
    return { rows, total };
  }

  return { record, listRecent, get, getByRun };
}

export type AutopsiesDal = ReturnType<typeof makeAutopsiesDal>;
