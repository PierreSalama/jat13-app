// runs DAL — the apply-run state machine's ONLY persistence writer (structural law 5 for run state).
//
// Every `state` write routes through `transition`, which calls `assertTransition` from run-fsm.ts
// (the state graph is NOT re-derived here). The row-level CHECK `state<>'submitted' OR evidence…`
// is honored by writing state + evidence in ONE UPDATE so no bad intermediate row is ever visible.
// Slot accounting ("busy = one SQL query") counts ONLY the SLOT_HOLDING states, also from run-fsm.ts.

import type { DalContext, DomainEvent, LeanPage } from './util.js';
import { makeStmtCache, clampLimit } from './util.js';
import {
  assertTransition,
  isTerminal,
  isSlotHolding,
  SLOT_HOLDING,
  type RunState,
} from './run-fsm.js';

// ---- row shapes -------------------------------------------------------------

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

/** Lean projection for lists — NO evidence_json / pending_questions_json blobs (payload law 4). */
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

export interface EnqueueInput {
  source: string;
  lane: RunLane;
  jobId: string;
  profileId: string;
  mode?: RunMode;
  adapterId?: string;
  adapterVersion?: number;
}

/** Non-state patchable columns. `state` is intentionally ABSENT — set it via `transition`. */
export interface RunPatch {
  page_key?: string | null;
  step_seq?: number;
  cmd_seq?: number;
  tab_epoch?: number | null;
  park_kind?: ParkKind | null;
  park_detail?: string | null;
  error?: string | null;
  evidence_kind?: EvidenceKind | null;
  evidence_json?: unknown;
  pending_questions_json?: unknown;
  attempt?: number;
  adapter_id?: string | null;
  adapter_version?: number | null;
}

/** Patch fields applied in the SAME UPDATE as a state transition (evidence must land atomically). */
export interface TransitionPatch {
  page_key?: string | null;
  cmd_seq?: number;
  tab_epoch?: number | null;
  park_kind?: ParkKind | null;
  park_detail?: string | null;
  error?: string | null;
  evidence_kind?: EvidenceKind | null;
  evidence_json?: unknown;
  pending_questions_json?: unknown;
  attempt?: number;
  adapter_id?: string | null;
  adapter_version?: number | null;
}

export interface AddStepInput {
  phase: StepPhase;
  action?: string;
  target?: string;
  detail?: string;
  snapshotHash?: string;
  durationMs?: number;
  ok?: boolean;
}

export interface ListLeanInput {
  state?: RunState;
  source?: string;
  lane?: RunLane;
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

// The set of state values that hold a slot, spelled for an IN (…) clause. Derived from SLOT_HOLDING
// (run-fsm.ts owns the set) — never hand-listed, so the two can't drift.
const SLOT_PLACEHOLDERS = SLOT_HOLDING.map(() => '?').join(', ');

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

// The whitelist of columns `patch` may touch. `state` is deliberately not here — attempting to set
// it (or any unknown key) throws, forcing callers through `transition`.
const PATCHABLE = new Set<string>([
  'page_key', 'step_seq', 'cmd_seq', 'tab_epoch', 'park_kind', 'park_detail', 'error',
  'evidence_kind', 'evidence_json', 'pending_questions_json', 'attempt', 'adapter_id',
  'adapter_version',
]);

// The keys of a TransitionPatch that map straight to a column; JSON keys are handled specially.
const TRANSITION_SCALAR = new Set<string>([
  'page_key', 'cmd_seq', 'tab_epoch', 'park_kind', 'park_detail', 'error', 'evidence_kind',
  'attempt', 'adapter_id', 'adapter_version',
]);

export function makeRunsDal(ctx: DalContext) {
  const stmt = makeStmtCache(ctx.db);

  function getRaw(id: string): RunRow | undefined {
    return stmt(`SELECT ${RUN_COLS} FROM apply_runs WHERE id = ?`).get(id) as RunRow | undefined;
  }

  function requireRaw(id: string): RunRow {
    const row = getRaw(id);
    if (!row) throw new Error(`apply_run not found: ${id}`);
    return row;
  }

  function leanOf(run: Run): RunLean {
    return {
      id: run.id, application_id: run.application_id, job_id: run.job_id, profile_id: run.profile_id,
      source: run.source, lane: run.lane, state: run.state, mode: run.mode, route: run.route,
      attempt: run.attempt, page_key: run.page_key, park_kind: run.park_kind,
      steps_count: run.steps_count, queued_at: run.queued_at, started_at: run.started_at,
      finished_at: run.finished_at, updated_at: run.updated_at,
    };
  }

  function get(id: string): Run | null {
    const row = getRaw(id);
    return row ? hydrate(row) : null;
  }

  function enqueue(applicationId: string, input: EnqueueInput): Run {
    const now = ctx.now();
    const id = ctx.newId('run');
    const row = {
      id,
      application_id: applicationId,
      job_id: input.jobId,
      profile_id: input.profileId,
      source: input.source,
      lane: input.lane,
      adapter_id: input.adapterId ?? null,
      adapter_version: input.adapterVersion ?? null,
      state: 'queued',
      mode: input.mode ?? 'auto',
      queued_at: now,
      updated_at: now,
    };
    const cols = Object.keys(row);
    stmt(
      `INSERT INTO apply_runs (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
    ).run(row);
    const run = hydrate(requireRaw(id));
    ctx.emit(evt('insert', run));
    return run;
  }

  /**
   * THE guarded state writer. In ONE transaction: read current state, assert the transition is legal
   * (throws otherwise), then write state + the caller's patch fields + all timestamp side-effects in a
   * SINGLE UPDATE — so the row-level CHECK never observes a `submitted` row missing its evidence.
   */
  function transition(id: string, to: RunState, patch: TransitionPatch = {}): Run {
    const tx = ctx.db.transaction((): Run => {
      const cur = requireRaw(id);
      const from = cur.state;
      assertTransition(from, to); // throws on an illegal edge — the ONLY authority for the graph

      const now = ctx.now();
      const sets: string[] = ['state = @state', 'updated_at = @updated_at'];
      const params: Record<string, unknown> = { id, state: to, updated_at: now };

      // caller patch fields (scalars written verbatim; JSON serialized) — same UPDATE, so evidence
      // lands atomically with state=submitted.
      for (const key of Object.keys(patch) as Array<keyof TransitionPatch>) {
        if (TRANSITION_SCALAR.has(key)) {
          sets.push(`${key} = @${key}`);
          params[key] = patch[key] ?? null;
        } else if (key === 'evidence_json') {
          sets.push('evidence_json = @evidence_json');
          params.evidence_json = patch.evidence_json === undefined || patch.evidence_json === null
            ? null
            : JSON.stringify(patch.evidence_json);
        } else if (key === 'pending_questions_json') {
          sets.push('pending_questions_json = @pending_questions_json');
          params.pending_questions_json =
            patch.pending_questions_json === undefined || patch.pending_questions_json === null
              ? '[]'
              : JSON.stringify(patch.pending_questions_json);
        }
      }

      // timestamp side-effects (structural §2.1/§2.2):
      //  - started_at on FIRST entry into any slot-holding state (only if not already set)
      if (isSlotHolding(to) && cur.started_at === null) {
        sets.push('started_at = @started_at');
        params.started_at = now;
      }
      //  - finished_at when entering a terminal state
      if (isTerminal(to)) {
        sets.push('finished_at = @finished_at');
        params.finished_at = now;
      }
      //  - resume_count++ on the resume edge waiting_page -> classifying|queued
      if (from === 'waiting_page' && (to === 'classifying' || to === 'queued')) {
        sets.push('resume_count = resume_count + 1');
      }

      stmt(`UPDATE apply_runs SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return hydrate(requireRaw(id));
    });
    const run = tx();
    ctx.emit(evt('update', run));
    return run;
  }

  /** Convenience: record a verified submit (state=submitted + typed evidence in one atomic UPDATE). */
  function recordSubmitted(
    id: string,
    { evidenceKind, evidenceJson }: { evidenceKind: EvidenceKind; evidenceJson: unknown },
  ): Run {
    return transition(id, 'submitted', { evidence_kind: evidenceKind, evidence_json: evidenceJson });
  }

  /**
   * Non-state field writer. Setting `state` (or any non-whitelisted column) throws — callers MUST
   * route state through `transition`. JSON columns are serialized; scalars bound verbatim.
   */
  function patch(id: string, fields: RunPatch & Record<string, unknown>): Run {
    if ('state' in fields) {
      throw new Error('runs.patch cannot set state; use runs.transition');
    }
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: ctx.now() };
    for (const key of Object.keys(fields)) {
      if (!PATCHABLE.has(key)) {
        throw new Error(`runs.patch: field not patchable: ${key}`);
      }
      if (key === 'evidence_json') {
        sets.push('evidence_json = @evidence_json');
        params.evidence_json =
          fields.evidence_json === undefined || fields.evidence_json === null
            ? null
            : JSON.stringify(fields.evidence_json);
      } else if (key === 'pending_questions_json') {
        sets.push('pending_questions_json = @pending_questions_json');
        params.pending_questions_json =
          fields.pending_questions_json === undefined || fields.pending_questions_json === null
            ? '[]'
            : JSON.stringify(fields.pending_questions_json);
      } else {
        sets.push(`${key} = @${key}`);
        params[key] = fields[key] ?? null;
      }
    }
    if (sets.length === 0) {
      return hydrate(requireRaw(id));
    }
    sets.push('updated_at = @updated_at');
    stmt(`UPDATE apply_runs SET ${sets.join(', ')} WHERE id = @id`).run(params);
    const run = hydrate(requireRaw(id));
    ctx.emit(evt('update', run));
    return run;
  }

  /**
   * Append a step. In ONE tx: read the run's step_seq, seq=step_seq+1, INSERT the step, and bump
   * apply_runs.step_seq + steps_count. The 500-cap trigger silently drops seq>500 (RAISE(IGNORE)),
   * so steps_count is bumped ONLY when the insert actually added a row (result.changes === 1).
   */
  function addStep(runId: string, input: AddStepInput): RunStep | null {
    const tx = ctx.db.transaction((): RunStep | null => {
      const cur = requireRaw(runId);
      const seq = cur.step_seq + 1;
      const now = ctx.now();
      const res = stmt(
        `INSERT INTO apply_run_steps (${STEP_COLS}) ` +
          'VALUES (@run_id, @seq, @at, @phase, @action, @target, @detail, @snapshot_hash, @duration_ms, @ok)',
      ).run({
        run_id: runId,
        seq,
        at: now,
        phase: input.phase,
        action: input.action ?? null,
        target: input.target ?? null,
        detail: input.detail ?? null,
        snapshot_hash: input.snapshotHash ?? null,
        duration_ms: input.durationMs ?? null,
        ok: (input.ok ?? true) ? 1 : 0,
      });

      // Always advance step_seq (the monotonic cursor) so a later un-capped write can't reuse a seq.
      // Only bump steps_count when a row was truly inserted (trigger may have ignored an over-cap seq).
      if (res.changes === 1) {
        stmt(
          'UPDATE apply_runs SET step_seq = @seq, steps_count = steps_count + 1, updated_at = @now WHERE id = @id',
        ).run({ seq, now, id: runId });
        return hydrateStep(
          stmt(`SELECT ${STEP_COLS} FROM apply_run_steps WHERE run_id = ? AND seq = ?`).get(
            runId,
            seq,
          ) as StepRow,
        );
      }
      // Over-cap: advance the cursor only, no steps_count change, no row to return.
      stmt('UPDATE apply_runs SET step_seq = @seq, updated_at = @now WHERE id = @id').run({
        seq,
        now,
        id: runId,
      });
      return null;
    });
    const step = tx();
    if (step) {
      ctx.emit({ table: 'apply_run_steps', op: 'insert', id: `${runId}:${step.seq}`, patch: { ...step } });
    }
    return step;
  }

  /** Steps for a run, ordered by seq. Bounded by the 500-cap; default clamps to the whole ring. */
  function getSteps(runId: string, { limit = 500 }: { limit?: number } = {}): RunStep[] {
    const lim = clampLimit(limit, 500, 500);
    const rows = stmt(
      `SELECT ${STEP_COLS} FROM apply_run_steps WHERE run_id = ? ORDER BY seq ASC LIMIT ?`,
    ).all(runId, lim) as StepRow[];
    return rows.map(hydrateStep);
  }

  /** Lean page of runs (no evidence/pending blobs). Filters compose; total ignores limit/offset. */
  function listLean(input: ListLeanInput = {}): LeanPage<RunLean> {
    const limit = clampLimit(input.limit, 100);
    const offset = Math.max(0, Math.floor(input.offset ?? 0));

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

  /** Per-state counts within a trailing window (by queued_at), optionally scoped to one lane. */
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

  /** THE busy query: count of in-flight (slot-holding) runs in a lane. Drives scheduler pacing. */
  function slotCount(lane: RunLane): number {
    const row = stmt(
      `SELECT COUNT(*) AS c FROM apply_runs WHERE lane = ? AND state IN (${SLOT_PLACEHOLDERS})`,
    ).get(lane, ...SLOT_HOLDING) as { c: number };
    return row.c;
  }

  /**
   * Reclaim stranded `waiting_page` runs whose updated_at is older than the TTL: transition to
   * `queued` if attempts remain (<3), else `failed`. Runs each transition through the guarded writer
   * (both edges are legal from waiting_page). Returns the number reclaimed.
   */
  function reclaimStranded({ ttlMs }: { ttlMs: number }): number {
    const cutoff = ctx.now() - ttlMs;
    const ids = (
      stmt(
        "SELECT id FROM apply_runs WHERE state = 'waiting_page' AND updated_at < ?",
      ).all(cutoff) as Array<{ id: string }>
    ).map((r) => r.id);

    let reclaimed = 0;
    for (const id of ids) {
      const cur = getRaw(id);
      if (!cur || cur.state !== 'waiting_page') continue; // re-check (nothing else writes, but be safe)
      const to: RunState = cur.attempt < 3 ? 'queued' : 'failed';
      const p: TransitionPatch = to === 'failed' ? { error: 'waiting_page TTL exhausted' } : {};
      transition(id, to, p);
      reclaimed += 1;
    }
    return reclaimed;
  }

  return {
    enqueue,
    transition,
    recordSubmitted,
    patch,
    addStep,
    getSteps,
    get,
    listLean,
    stats,
    slotCount,
    reclaimStranded,
  };
}

/** Build the lean-row DomainEvent payload for a mutating write. */
function evt(op: DomainEvent['op'], run: Run): DomainEvent {
  return {
    table: 'apply_runs',
    op,
    id: run.id,
    patch: {
      id: run.id,
      application_id: run.application_id,
      job_id: run.job_id,
      profile_id: run.profile_id,
      source: run.source,
      lane: run.lane,
      state: run.state,
      mode: run.mode,
      route: run.route,
      attempt: run.attempt,
      page_key: run.page_key,
      park_kind: run.park_kind,
      steps_count: run.steps_count,
      queued_at: run.queued_at,
      started_at: run.started_at,
      finished_at: run.finished_at,
      updated_at: run.updated_at,
    },
  };
}

export type RunsDal = ReturnType<typeof makeRunsDal>;
