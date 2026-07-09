// DAL foundation — the conventions EVERY aggregate module binds to. Kept tiny and dependency-free
// so the modules stay consistent (the v11 failure was 40 ad-hoc query sites with divergent shapes).
//
// Every DAL is a FACTORY `makeXDal(ctx)` returning an object bound to one db handle + one clock +
// one id source + one event sink. That makes them trivially testable (inject a fixed clock / fake
// sink) and guarantees a single writer path.

import type { Database, Statement } from 'better-sqlite3';

/** PatchBus payload (structural law 6): the CHANGED ROW, never "refetch everything". The M1 server
 *  subscribes this sink to broadcast over /drive; until then `emit` is a no-op. */
export interface DomainEvent {
  table: string;
  op: 'insert' | 'update' | 'delete';
  id: string;
  /** the changed lean row (or a partial patch); omitted for deletes. */
  patch?: Record<string, unknown>;
}

export interface DalContext {
  db: Database;
  /** epoch-ms; injectable so tests are deterministic and imports can backfill historical times. */
  now: () => number;
  /** monotonic, sortable id with a table prefix (e.g. `run_01J…`). */
  newId: (prefix: string) => string;
  /** PatchBus hook; no-op until the M1 /drive server subscribes it. */
  emit: (evt: DomainEvent) => void;
}

/** Every `listLean` returns this — an explicit page with a total, never a bare unbounded array. */
export interface LeanPage<T> {
  rows: T[];
  total: number;
}

// ---- id generation (ULID: 48-bit time + 80-bit randomness, Crockford base32, lexically sortable) --
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID body (26 chars). `Date.now`/`Math.random` are fine in app code (only Workflow SCRIPTS ban them). */
export function ulid(nowMs: number = Date.now()): string {
  let t = nowMs;
  const time = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = CROCKFORD[t % 32]!;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(Math.random() * 32)];
  return time.join('') + rand;
}

/** Default DalContext helpers; real main-process wiring passes the same shapes (with a live emit). */
export function defaultContext(db: Database, emit: DalContext['emit'] = () => {}): DalContext {
  return { db, now: () => Date.now(), newId: (prefix) => `${prefix}_${ulid()}`, emit };
}

/**
 * Prepared-statement cache keyed by SQL text. better-sqlite3 does NOT cache prepares itself, so each
 * DAL builds one of these to avoid recompiling hot queries. Bound to a single db handle.
 */
export function makeStmtCache(db: Database) {
  const cache = new Map<string, Statement>();
  return (sql: string): Statement => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
}

/** Clamp a caller-supplied limit into a sane band (payload-cap discipline; no unbounded scans). */
export function clampLimit(limit: unknown, def: number, max = 1000): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : def;
  return Math.min(Math.max(n, 1), max);
}
