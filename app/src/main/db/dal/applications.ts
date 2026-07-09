// The applications aggregate — one row per (job, profile), the clean status lifecycle (schema §71-93).
// FORWARD-ONLY is the load-bearing invariant: `elevate` is the ONLY status writer and it refuses any
// backward progressive move, refuses to reopen a locked terminal row, and time-stamps `submitted_at`
// exactly once. v11 corrupted funnels by writing status from 40 ad-hoc sites with no ordering guard;
// here the guard lives in ONE function and the tests hammer its rejection paths.

import type { DalContext, LeanPage } from './util.js';
import { makeStmtCache, clampLimit } from './util.js';

// ---- status vocabulary (binds to the applications.status CHECK in migration 001) ------------------
export type ApplicationStatus =
  | 'tracked' | 'submitted' | 'acknowledged' | 'assessment'
  | 'interview_1' | 'interview_2' | 'interview_final'
  | 'offer' | 'hired' | 'rejected' | 'withdrawn' | 'ghosted';

/**
 * Progressive rank: the monotonic pipeline a live application climbs. A real `elevate` may only move
 * UP this ladder (or set a terminal). Terminal statuses are NOT on the ladder — they are handled by
 * their own rules (settable from any non-terminal; `withdrawn` from anywhere) and carry no rank.
 */
const PROGRESSIVE_RANK: Readonly<Record<string, number>> = {
  tracked: 0,
  submitted: 1,
  acknowledged: 2,
  assessment: 3,
  interview_1: 4,
  interview_2: 5,
  interview_final: 6,
  offer: 7,
  hired: 8,
};

/** LOCK set: once here, the row is closed to further `elevate` (the one carve-out is `withdrawn`). */
const TERMINAL: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'hired', 'rejected', 'withdrawn', 'ghosted',
]);

/** Terminals that a NON-terminal row may drop into at any time (a stop, not a step up the ladder). */
const NON_PROGRESSIVE_TERMINAL: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'rejected', 'withdrawn', 'ghosted',
]);

export type ApplicationVia = 'auto' | 'manual' | 'import';

/** The full row as stored (JSON columns still stringified) — returned by ensure/elevate/patch/get. */
export interface ApplicationRow {
  id: string;
  job_id: string;
  profile_id: string;
  status: ApplicationStatus;
  via: ApplicationVia | null;
  submitted_at: number | null;
  answers_json: string;
  attachments_json: string;
  notes: string | null;
  next_action: string | null;
  due_at: number | null;
  needs_review: number;
  created_at: number;
  updated_at: number;
}

/** The lean projection a list ships — NO heavy answers_json/attachments_json/notes text columns. */
export interface ApplicationLean {
  id: string;
  job_id: string;
  profile_id: string;
  status: ApplicationStatus;
  via: ApplicationVia | null;
  submitted_at: number | null;
  next_action: string | null;
  due_at: number | null;
  needs_review: number;
  created_at: number;
  updated_at: number;
}

/** Non-status patchable fields. `answers_json`/`attachments_json` accept an object (JSON.stringify'd). */
export interface ApplicationPatch {
  notes?: string | null;
  next_action?: string | null;
  due_at?: number | null;
  needs_review?: boolean | number;
  answers_json?: unknown;
  attachments_json?: unknown;
  via?: ApplicationVia | null;
}

const ROW_COLS =
  'id, job_id, profile_id, status, via, submitted_at, answers_json, attachments_json, ' +
  'notes, next_action, due_at, needs_review, created_at, updated_at';

const LEAN_COLS =
  'id, job_id, profile_id, status, via, submitted_at, next_action, due_at, needs_review, created_at, updated_at';

/**
 * True when `to` is a rank-ladder status (has a progressive rank). NOTE `hired` is on the ladder
 * (rank 8, its top rung) AND is terminal — reaching it is a strict climb, so it is rank-checked, not
 * dropped into the "settable-from-anywhere" terminal bucket. rejected/withdrawn/ghosted have NO rank.
 */
function isProgressive(s: ApplicationStatus): boolean {
  return Object.prototype.hasOwnProperty.call(PROGRESSIVE_RANK, s);
}

export function makeApplicationsDal(ctx: DalContext) {
  const { db, now, newId, emit } = ctx;
  const stmt = makeStmtCache(db);

  function getById(id: string): ApplicationRow | undefined {
    return stmt(`SELECT ${ROW_COLS} FROM applications WHERE id = ?`).get(id) as ApplicationRow | undefined;
  }

  /**
   * Get-or-create the UNIQUE(job_id, profile_id) row at status 'tracked'. Runs in one transaction so
   * a concurrent ensure can't double-insert past the UNIQUE constraint — on conflict we re-read the
   * existing row. Emits an insert event ONLY when a row was actually created.
   */
  function ensure(jobId: string, profileId: string): ApplicationRow {
    return db.transaction((): ApplicationRow => {
      const existing = stmt(
        `SELECT ${ROW_COLS} FROM applications WHERE job_id = ? AND profile_id = ?`,
      ).get(jobId, profileId) as ApplicationRow | undefined;
      if (existing) return existing;

      const id = newId('appl');
      const t = now();
      stmt(
        `INSERT INTO applications (id, job_id, profile_id, status, answers_json, attachments_json, needs_review, created_at, updated_at)
         VALUES (@id, @job_id, @profile_id, 'tracked', '[]', '[]', 0, @t, @t)`,
      ).run({ id, job_id: jobId, profile_id: profileId, t });

      const row = getById(id)!;
      emit({ table: 'applications', op: 'insert', id, patch: toLean(row) });
      return row;
    })();
  }

  /**
   * FORWARD-ONLY status change (the correctness core). Rules, in evaluation order:
   *  - same status  → no-op, return unchanged (never throws).
   *  - `withdrawn`  → ALWAYS allowed from any state (a user can always withdraw).
   *  - row terminal → LOCKED, throw (the withdraw carve-out above already returned).
   *  - terminal `to` (rejected/ghosted) from a non-terminal row → allowed (a stop, any time).
   *  - progressive `to` → allowed only if its rank is strictly ABOVE the current rank; equal/lower throws.
   * On a real change: stamp `submitted_at` once when entering 'submitted', bump updated_at, emit.
   */
  function elevate(id: string, status: ApplicationStatus, via?: ApplicationVia): ApplicationRow {
    if (!Object.prototype.hasOwnProperty.call(PROGRESSIVE_RANK, status) && !TERMINAL.has(status)) {
      throw new Error(`unknown application status: ${status}`);
    }
    return db.transaction((): ApplicationRow => {
      const row = getById(id);
      if (!row) throw new Error(`application not found: ${id}`);

      // 1) same status → no-op (may still carry a `via` update? No — elevate is status-only; use patch).
      if (row.status === status) return row;

      const fromTerminal = TERMINAL.has(row.status);

      if (status === 'withdrawn') {
        // 2) withdraw is always legal (including from another terminal) — falls through to apply.
      } else if (fromTerminal) {
        // 3) any non-withdraw elevate out of a terminal state is forbidden.
        throw new Error(`application ${id} is terminal (${row.status}); cannot elevate to ${status}`);
      } else if (NON_PROGRESSIVE_TERMINAL.has(status)) {
        // 4) rejected/ghosted from a non-terminal row → allowed, no rank check.
      } else if (isProgressive(status)) {
        // 5) progressive move must strictly climb. A non-terminal `from` is always on the ladder.
        const fromRank = PROGRESSIVE_RANK[row.status]!;
        const toRank = PROGRESSIVE_RANK[status]!;
        if (toRank <= fromRank) {
          throw new Error(
            `backward status move refused: ${row.status} -> ${status} (rank ${fromRank} -> ${toRank})`,
          );
        }
      } else {
        // hired is progressive; every remaining status is covered. Defensive: should be unreachable.
        throw new Error(`unhandled status transition: ${row.status} -> ${status}`);
      }

      const t = now();
      // Stamp submitted_at exactly once, the first time we enter 'submitted'.
      const setSubmittedAt = status === 'submitted' && row.submitted_at === null;
      if (via !== undefined) {
        stmt(
          `UPDATE applications SET status = @status, via = @via,
             submitted_at = CASE WHEN @setSub = 1 THEN @t ELSE submitted_at END,
             updated_at = @t WHERE id = @id`,
        ).run({ id, status, via, setSub: setSubmittedAt ? 1 : 0, t });
      } else {
        stmt(
          `UPDATE applications SET status = @status,
             submitted_at = CASE WHEN @setSub = 1 THEN @t ELSE submitted_at END,
             updated_at = @t WHERE id = @id`,
        ).run({ id, status, setSub: setSubmittedAt ? 1 : 0, t });
      }

      const updated = getById(id)!;
      emit({ table: 'applications', op: 'update', id, patch: toLean(updated) });
      return updated;
    })();
  }

  /**
   * Patch NON-status fields. `status` is intentionally not accepted (route status through `elevate`).
   * `answers_json`/`attachments_json` may be given as objects — stringified here; strings pass through.
   * A patch with no recognized field is a no-op (returns the current row, no write, no emit).
   */
  function patch(id: string, fields: ApplicationPatch): ApplicationRow {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };

    if ('notes' in fields) { sets.push('notes = @notes'); params['notes'] = fields.notes ?? null; }
    if ('next_action' in fields) { sets.push('next_action = @next_action'); params['next_action'] = fields.next_action ?? null; }
    if ('due_at' in fields) { sets.push('due_at = @due_at'); params['due_at'] = fields.due_at ?? null; }
    if ('needs_review' in fields) {
      sets.push('needs_review = @needs_review');
      params['needs_review'] = fields.needs_review ? 1 : 0;
    }
    if ('via' in fields) { sets.push('via = @via'); params['via'] = fields.via ?? null; }
    if ('answers_json' in fields) {
      sets.push('answers_json = @answers_json');
      params['answers_json'] = serializeJson(fields.answers_json, '[]');
    }
    if ('attachments_json' in fields) {
      sets.push('attachments_json = @attachments_json');
      params['attachments_json'] = serializeJson(fields.attachments_json, '[]');
    }

    if (sets.length === 0) {
      const cur = getById(id);
      if (!cur) throw new Error(`application not found: ${id}`);
      return cur;
    }

    return db.transaction((): ApplicationRow => {
      const cur = getById(id);
      if (!cur) throw new Error(`application not found: ${id}`);
      const t = now();
      params['t'] = t;
      stmt(`UPDATE applications SET ${sets.join(', ')}, updated_at = @t WHERE id = @id`).run(params);
      const updated = getById(id)!;
      emit({ table: 'applications', op: 'update', id, patch: toLean(updated) });
      return updated;
    })();
  }

  /**
   * Paged lean list, optionally filtered by status and/or profile. Explicit column list (no heavy
   * text), default limit 500 (clamped), ordered newest-updated first. `total` counts the filtered set.
   */
  function listLean(opts: {
    status?: ApplicationStatus;
    profileId?: string;
    limit?: number;
    offset?: number;
  } = {}): LeanPage<ApplicationLean> {
    const limit = clampLimit(opts.limit, 500);
    const offset = typeof opts.offset === 'number' && opts.offset > 0 ? Math.floor(opts.offset) : 0;

    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.status !== undefined) { where.push('status = @status'); params['status'] = opts.status; }
    if (opts.profileId !== undefined) { where.push('profile_id = @profileId'); params['profileId'] = opts.profileId; }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      stmt(`SELECT COUNT(*) AS c FROM applications ${whereSql}`).get(params) as { c: number }
    ).c;

    const rows = stmt(
      `SELECT ${LEAN_COLS} FROM applications ${whereSql}
       ORDER BY updated_at DESC, id DESC LIMIT @limit OFFSET @offset`,
    ).all({ ...params, limit, offset }) as ApplicationLean[];

    return { rows, total };
  }

  /**
   * Funnel: count applications by status within a trailing window (updated_at >= now - days*86.4e6).
   * Every status key is present (zero-filled) so a caller can render a stable funnel shape.
   */
  function funnel(opts: { days?: number; profileId?: string } = {}): Record<ApplicationStatus, number> {
    const days = typeof opts.days === 'number' && Number.isFinite(opts.days) && opts.days > 0 ? opts.days : 30;
    const since = now() - Math.floor(days * 86_400_000);

    const where: string[] = ['updated_at >= @since'];
    const params: Record<string, unknown> = { since };
    if (opts.profileId !== undefined) { where.push('profile_id = @profileId'); params['profileId'] = opts.profileId; }

    const counts: Record<ApplicationStatus, number> = {
      tracked: 0, submitted: 0, acknowledged: 0, assessment: 0,
      interview_1: 0, interview_2: 0, interview_final: 0,
      offer: 0, hired: 0, rejected: 0, withdrawn: 0, ghosted: 0,
    };
    const rows = stmt(
      `SELECT status, COUNT(*) AS c FROM applications WHERE ${where.join(' AND ')} GROUP BY status`,
    ).all(params) as Array<{ status: ApplicationStatus; c: number }>;
    for (const r of rows) {
      if (Object.prototype.hasOwnProperty.call(counts, r.status)) counts[r.status] = r.c;
    }
    return counts;
  }

  return { ensure, elevate, patch, get: getById, listLean, funnel };
}

// ---- helpers (module-local, no state) --------------------------------------------------------------

/**
 * Project a full row to its lean shape for the PatchBus payload (never ships heavy text columns).
 * Return type intersects Record<string,unknown> so it drops straight into DomainEvent.patch under
 * strict TS (an interface alone has no implicit index signature).
 */
function toLean(row: ApplicationRow): ApplicationLean & Record<string, unknown> {
  return {
    id: row.id,
    job_id: row.job_id,
    profile_id: row.profile_id,
    status: row.status,
    via: row.via,
    submitted_at: row.submitted_at,
    next_action: row.next_action,
    due_at: row.due_at,
    needs_review: row.needs_review,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Stringify an object/array value; pass a string through untouched; use `fallback` for null/undefined. */
function serializeJson(v: unknown, fallback: string): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
