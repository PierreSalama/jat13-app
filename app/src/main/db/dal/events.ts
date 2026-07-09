// events DAL — the durable, user-visible timeline (NOT a ring buffer; activity_log/ai_calls are the rings).
// Every user-meaningful thing that happens to a job/application/run/email lands here exactly once and
// stays: status changes, submits, parks, matched emails, notes, imports, document attachments. The
// dashboard timeline and the per-application history both read this table. Append-only by contract —
// there is no update/delete surface (the only mutation is INSERT), so a row, once recorded, is history.

import type { DalContext, DomainEvent, LeanPage } from './util.js';
import { makeStmtCache, clampLimit } from './util.js';

/** The event vocabulary — MUST equal the events.kind CHECK in migration 001. An unknown kind is a
 *  programming error (the CHECK would reject it at write time anyway); we throw early with a clear
 *  message rather than surfacing a raw SQLITE CHECK failure from deep in a transaction. */
export const EVENT_KINDS = [
  'status_change',
  'submitted',
  'park',
  'email_matched',
  'note',
  'imported',
  'created',
  'document_attached',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

const EVENT_KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS);

/** events.data_json CHECK caps the serialized column at 4096 bytes. We keep a byte for headroom-free
 *  equality with the DDL: anything strictly larger is dropped and replaced by a warning marker so the
 *  timeline never silently loses the row just because its payload was fat. */
const DATA_JSON_MAX = 4096;

/** Input to record(). Only `kind` is required; the rest are optional links/annotations. */
export interface RecordEventInput {
  kind: EventKind;
  jobId?: string;
  applicationId?: string;
  runId?: string;
  emailId?: string;
  source?: string;
  summary?: string;
  /** Arbitrary structured payload — JSON.stringify'd into data_json, capped at 4096 bytes. */
  data?: unknown;
}

/** A lean timeline row — the exact columns the UI renders. data_json is parsed defensively on read. */
export interface EventRow {
  id: string;
  at: number;
  kind: EventKind;
  job_id: string | null;
  application_id: string | null;
  run_id: string | null;
  email_id: string | null;
  source: string | null;
  summary: string | null;
  data: unknown;
}

/** Explicit column list for every read (payload-cap discipline — never SELECT *). data_json is bounded
 *  at 4096 by the DDL so it is safe to ship in a list; there is no heavier text column on this table. */
const SELECT_COLS =
  'id, at, kind, job_id, application_id, run_id, ' +
  'email_id, source, summary, data_json AS dataJson';

/** Raw row shape as it comes back from SQLite (data_json still a string). */
interface RawEventRow {
  id: string;
  at: number;
  kind: EventKind;
  job_id: string | null;
  application_id: string | null;
  run_id: string | null;
  email_id: string | null;
  source: string | null;
  summary: string | null;
  dataJson: string | null;
}

/** Parse data_json without ever throwing on a read (a corrupt row must not crash the timeline). */
function parseData(dataJson: string | null): unknown {
  if (dataJson === null) return null;
  try {
    return JSON.parse(dataJson);
  } catch {
    return null;
  }
}

function toRow(raw: RawEventRow): EventRow {
  return {
    id: raw.id,
    at: raw.at,
    kind: raw.kind,
    job_id: raw.job_id,
    application_id: raw.application_id,
    run_id: raw.run_id,
    email_id: raw.email_id,
    source: raw.source,
    summary: raw.summary,
    data: parseData(raw.dataJson),
  };
}

/** Serialize the caller's `data` for the data_json column, honoring the 4096-byte cap. Returns null
 *  when there is nothing to store. If the payload is oversized we DROP it and store a small marker
 *  `{"warning":"data dropped: <n> bytes over 4096-byte cap"}` so the event still records. */
function serializeData(data: unknown): string | null {
  if (data === undefined || data === null) return null;
  const json = JSON.stringify(data);
  // JSON.stringify can return undefined (e.g. a bare function/symbol) — treat that as "no data".
  if (json === undefined) return null;
  if (Buffer.byteLength(json, 'utf8') <= DATA_JSON_MAX) return json;
  const marker = JSON.stringify({
    warning: `data dropped: ${Buffer.byteLength(json, 'utf8')} bytes over ${DATA_JSON_MAX}-byte cap`,
  });
  return marker;
}

export function makeEventsDal(ctx: DalContext) {
  const stmt = makeStmtCache(ctx.db);

  /**
   * Record one timeline event. id = evt_<ulid>, at = ctx.now(). Throws on an unknown kind (the DDL
   * CHECK would reject it anyway). Oversized `data` is dropped with a warning marker, never persisted
   * past the 4096-byte cap. Emits a DomainEvent { table:'events', op:'insert', id, patch } so the
   * PatchBus can push the new row without a refetch.
   */
  function record(input: RecordEventInput): EventRow {
    if (!EVENT_KIND_SET.has(input.kind)) {
      throw new Error(
        `events.record: unknown kind '${String(input.kind)}' (must be one of ${EVENT_KINDS.join(', ')})`,
      );
    }
    const id = ctx.newId('evt');
    const at = ctx.now();
    const dataJson = serializeData(input.data);

    stmt(
      `INSERT INTO events (id, at, kind, job_id, application_id, run_id, email_id, source, summary, data_json)
       VALUES (@id, @at, @kind, @jobId, @applicationId, @runId, @emailId, @source, @summary, @dataJson)`,
    ).run({
      id,
      at,
      kind: input.kind,
      jobId: input.jobId ?? null,
      applicationId: input.applicationId ?? null,
      runId: input.runId ?? null,
      emailId: input.emailId ?? null,
      source: input.source ?? null,
      summary: input.summary ?? null,
      dataJson,
    });

    const row: EventRow = {
      id,
      at,
      kind: input.kind,
      job_id: input.jobId ?? null,
      application_id: input.applicationId ?? null,
      run_id: input.runId ?? null,
      email_id: input.emailId ?? null,
      source: input.source ?? null,
      summary: input.summary ?? null,
      data: parseData(dataJson),
    };

    const evt: DomainEvent = { table: 'events', op: 'insert', id, patch: { ...row } };
    ctx.emit(evt);
    return row;
  }

  /**
   * The full history for one application, newest first. Uses the idx_events_appl(application_id, at DESC)
   * index. Default limit 200; total is the unbounded count for that application so the UI can page.
   */
  function timeline(applicationId: string, opts: { limit?: number } = {}): LeanPage<EventRow> {
    const limit = clampLimit(opts.limit, 200);
    const rows = (
      stmt(
        `SELECT ${SELECT_COLS} FROM events WHERE application_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
      ).all(applicationId, limit) as RawEventRow[]
    ).map(toRow);
    const { total } = stmt('SELECT COUNT(*) AS total FROM events WHERE application_id = ?').get(
      applicationId,
    ) as { total: number };
    return { rows, total };
  }

  /**
   * Recent events across the whole timeline, newest first, optionally filtered to a set of kinds.
   * Default limit 100. Unknown kinds in the filter are dropped (they can never match a stored row);
   * an empty-after-filtering kind list yields an empty page rather than an unfiltered scan.
   */
  function recent(opts: { limit?: number; kinds?: readonly string[] } = {}): LeanPage<EventRow> {
    const limit = clampLimit(opts.limit, 100);

    if (opts.kinds !== undefined) {
      const kinds = opts.kinds.filter((k): k is EventKind => EVENT_KIND_SET.has(k));
      if (kinds.length === 0) return { rows: [], total: 0 };
      const placeholders = kinds.map(() => '?').join(', ');
      const rows = (
        stmt(
          `SELECT ${SELECT_COLS} FROM events WHERE kind IN (${placeholders}) ORDER BY at DESC, id DESC LIMIT ?`,
        ).all(...kinds, limit) as RawEventRow[]
      ).map(toRow);
      const { total } = stmt(
        `SELECT COUNT(*) AS total FROM events WHERE kind IN (${placeholders})`,
      ).get(...kinds) as { total: number };
      return { rows, total };
    }

    const rows = (
      stmt(`SELECT ${SELECT_COLS} FROM events ORDER BY at DESC, id DESC LIMIT ?`).all(
        limit,
      ) as RawEventRow[]
    ).map(toRow);
    const { total } = stmt('SELECT COUNT(*) AS total FROM events').get() as { total: number };
    return { rows, total };
  }

  return { record, timeline, recent };
}

export type EventsDal = ReturnType<typeof makeEventsDal>;
