// runs DAL — Stage-1 READ surface over apply_runs + apply_run_steps (imported v11 history + the
// Applications drawer's run-history panel). Lists are LEAN (no evidence_json / pending_questions_json
// blobs — payload law); `get` hydrates the JSON columns for the one-row detail read.
//
// DELIBERATELY ABSENT until Stage 2 (the engine): enqueue / transition / recordSubmitted / patch /
// addStep / slotCount / reclaimStranded. Those are respec'd VERBATIM from cb25d19 runs.ts + run-fsm.ts
// (the guarded writer + assertTransition graph proven by the survival test) when the runner lands —
// Stage 1 writes runs ONLY via the importer, and the schema CHECK (submitted requires trustworthy
// evidence_kind) is already law at the row level.

import type { DalContext, LeanPage } from './index.js';
import { makeStmtCache, clampLimit, clampOffset } from './index.js';

// ---- vocabularies (bind to the apply_runs CHECKs in migration 001) ---------

/** The 13-state FSM as data. Slot-holding = leased|navigating|classifying|driving|verifying|
 *  waiting_page; terminal = submitted|ready_for_review|parked|skipped|failed. */
export type RunState =
  | 'queued' | 'leased' | 'navigating' | 'classifying' | 'driving' | 'verifying'
  | 'waiting_page' | 'needs_human' | 'submitted' | 'ready_for_review'
  | 'parked' | 'skipped' | 'failed';

export type RunLane = 'linkedin' | 'indeed' | 'ats';
export type RunMode = 'auto' | 'review' | 'teach';
export type RunRoute = 'easy_apply' | 'smartapply' | 'ats_form' | 'external';
export type EvidenceKind =
  | 'text_became_success' | 'new_confirmation_node' | 'confirm_signal'
  | 'url_confirmation' | 'modal_close_confirmed' | 'manual_confirmed' | 'legacy_untrusted';
export type ParkKind =
  | 'captcha' | 'cloudflare' | 'login' | 'account_wall' | 'resume_required'
  | 'needs_answer' | 'awaiting_review' | 'external_redirect' | 'rate_limited' | 'other';
export type StepPhase =
  | 'open' | 'navigate' | 'classify' | 'detect' | 'fill' | 'answer' | 'upload'
  | 'advance' | 'verify' | 'park' | 'resume' | 'finish';

// ---- row shapes -------------------------------------------------------------

/** Full apply_runs row (evidence_json/pending_questions_json parsed defensively). */
export interface Run {
  id: string;
  application_id: string;
  job_id: string;
  profile_id: string;
  source: string;
  lane: RunLane;
  adapter_id: string | null;
  adapter_version: number | null;
  state: RunState;
  mode: RunMode;
  route: RunRoute | null;
  attempt: number;
  page_key: string | null;
  step_seq: number;
  cmd_seq: number;
  resume_count: number;
  tab_epoch: number | null;
  park_kind: ParkKind | null;
  park_detail: string | null;
  pending_questions: unknown[];
  error: string | null;
  evidence_kind: EvidenceKind | null;
  evidence: unknown;
  steps_count: number;
  queued_at: number;
  dispatched_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

/** Lean projection for lists — NO evidence_json / pending_questions_json blobs (payload law). */
export interface RunLean {
  id: string;
  application_id: string;
  job_id: string;
  profile_id: string;
  source: string;
  lane: RunLane;
  state: RunState;
  mode: RunMode;
  route: RunRoute | null;
  attempt: number;
  page_key: string | null;
  park_kind: ParkKind | null;
  steps_count: number;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

export interface RunStep {
  run_id: string;
  seq: number;
  at: number;
  phase: StepPhase;
  action: string | null;
  target: string | null;
  detail: string | null;
  snapshot_hash: string | null;
  duration_ms: number | null;
  ok: boolean;
}

export interface ListLeanInput {
  state?: RunState;
  source?: string;
  lane?: RunLane;
  applicationId?: string;
  since?: number;
  limit?: number;
  offset?: number;
}

export interface StatsInput {
  hours?: number;
  lane?: RunLane;
}

export interface RunStats {
  byState: Record<string, number>;
  total: number;
}

// ---- column lists (explicit — never SELECT *) -------------------------------

const RUN_COLS =
  'id, application_id, job_id, profile_id, source, lane, adapter_id, adapter_version, state, mode, ' +
  'route, attempt, page_key, step_seq, cmd_seq, resume_count, tab_epoch, park_kind, park_detail, ' +
  'pending_questions_json, error, evidence_kind, evidence_json, steps_count, queued_at, ' +
  'dispatched_at, started_at, finished_at, updated_at';

const LEAN_COLS =
  'id, application_id, job_id, profile_id, source, lane, state, mode, route, attempt, page_key, ' +
  'park_kind, steps_count, queued_at, started_at, finished_at, updated_at';

const STEP_COLS = 'run_id, seq, at, phase, action, target, detail, snapshot_hash, duration_ms, ok';

// ---- raw DB row types (before defensive JSON parse) -------------------------

interface RunRow {
  id: string; application_id: string; job_id: string; profile_id: string; source: string;
  lane: RunLane; adapter_id: string | null; adapter_version: number | null; state: RunState;
  mode: RunMode; route: RunRoute | null; attempt: number; page_key: string | null;
  step_seq: number; cmd_seq: number; resume_count: number; tab_epoch: number | null;
  park_kind: ParkKind | null; park_detail: string | null; pending_questions_json: string;
  error: string | null; evidence_kind: EvidenceKind | null; evidence_json: string | null;
  steps_count: number; queued_at: number; dispatched_at: number | null; started_at: number | null;
  finished_at: number | null; updated_at: number;
}

interface StepRow {
  run_id: string; seq: number; at: number; phase: StepPhase; action: string | null;
  target: string | null; detail: string | null; snapshot_hash: string | null;
  duration_ms: number | null; ok: number;
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

function hydrate(row: RunRow): Run {
  return {
    id: row.id,
    application_id: row.application_id,
    job_id: row.job_id,
    profile_id: row.profile_id,
    source: row.source,
    lane: row.lane,
    adapter_id: row.adapter_id,
    adapter_version: row.adapter_version,
    state: row.state,
    mode: row.mode,
    route: row.route,
    attempt: row.attempt,
    page_key: row.page_key,
    step_seq: row.step_seq,
    cmd_seq: row.cmd_seq,
    resume_count: row.resume_count,
    tab_epoch: row.tab_epoch,
    park_kind: row.park_kind,
    park_detail: row.park_detail,
    pending_questions: parseJson<unknown[]>(row.pending_questions_json, []),
    error: row.error,
    evidence_kind: row.evidence_kind,
    evidence: parseJson<unknown>(row.evidence_json, null),
    steps_count: row.steps_count,
    queued_at: row.queued_at,
    dispatched_at: row.dispatched_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    updated_at: row.updated_at,
  };
}

function hydrateStep(row: StepRow): RunStep {
  return {
    run_id: row.run_id,
    seq: row.seq,
    at: row.at,
    phase: row.phase,
    action: row.action,
    target: row.target,
    detail: row.detail,
    snapshot_hash: row.snapshot_hash,
    duration_ms: row.duration_ms,
    ok: row.ok === 1,
  };
}

export function makeRunsDal(ctx: DalContext) {
  const stmt = makeStmtCache(ctx.db);

  /** One run, JSON columns hydrated — the run-detail / transcript-header read. */
  function get(id: string): Run | null {
    const row = stmt(`SELECT ${RUN_COLS} FROM apply_runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row ? hydrate(row) : null;
  }

  /** Lean page of runs (no evidence/pending blobs). Filters compose; total ignores limit/offset.
   *  `applicationId` drives the Applications drawer's run-history (idx_runs_appl). */
  function listLean(input: ListLeanInput = {}): LeanPage<RunLean> {
    const limit = clampLimit(input.limit, 100);
    const offset = clampOffset(input.offset);

    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (input.state !== undefined) {
      where.push('state = @state');
      params.state = input.state;
    }
    if (input.source !== undefined) {
      where.push('source = @source');
      params.source = input.source;
    }
    if (input.lane !== undefined) {
      where.push('lane = @lane');
      params.lane = input.lane;
    }
    if (input.applicationId !== undefined) {
      where.push('application_id = @applicationId');
      params.applicationId = input.applicationId;
    }
    if (input.since !== undefined) {
      where.push('queued_at >= @since');
      params.since = input.since;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      stmt(`SELECT COUNT(*) AS c FROM apply_runs ${clause}`).get(params) as { c: number }
    ).c;
    const rows = stmt(
      `SELECT ${LEAN_COLS} FROM apply_runs ${clause} ORDER BY queued_at DESC LIMIT @limit OFFSET @offset`,
    ).all({ ...params, limit, offset }) as RunLean[];
    return { rows, total };
  }

  /** Steps for a run, ordered by seq. Bounded by the schema's 500-cap trigger; default reads the
   *  whole ring (hard max 500 — the cap is structural, not a courtesy). */
  function getSteps(runId: string, { limit = 500 }: { limit?: number } = {}): RunStep[] {
    const lim = clampLimit(limit, 500, 500);
    const rows = stmt(
      `SELECT ${STEP_COLS} FROM apply_run_steps WHERE run_id = ? ORDER BY seq ASC LIMIT ?`,
    ).all(runId, lim) as StepRow[];
    return rows.map(hydrateStep);
  }

  /** Per-state counts within a trailing window (by queued_at), optionally scoped to one lane —
   *  the honest-rate panel's raw numbers. */
  function stats(input: StatsInput = {}): RunStats {
    const hours = typeof input.hours === 'number' && input.hours > 0 ? input.hours : 24;
    const since = ctx.now() - hours * 3_600_000;
    const params: Record<string, unknown> = { since };
    let clause = 'WHERE queued_at >= @since';
    if (input.lane !== undefined) {
      clause += ' AND lane = @lane';
      params.lane = input.lane;
    }
    const rows = stmt(
      `SELECT state, COUNT(*) AS c FROM apply_runs ${clause} GROUP BY state`,
    ).all(params) as Array<{ state: string; c: number }>;
    const byState: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byState[r.state] = r.c;
      total += r.c;
    }
    return { byState, total };
  }

  return { get, listLean, getSteps, stats };
}

export type RunsDal = ReturnType<typeof makeRunsDal>;
