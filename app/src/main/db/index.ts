// The one writer. better-sqlite3, WAL, main-process only (structural law 5).
// Every other pillar reaches SQLite through the DAL modules that sit on top of this handle —
// nothing else opens the file. Synchronous by design: no async races on a single-writer DB.

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { runMigrations, DEFAULT_MIGRATIONS_DIR, type MigrateResult } from './migrate.js';

export { DEFAULT_MIGRATIONS_DIR } from './migrate.js';
export type { MigrateResult } from './migrate.js';

export interface OpenOptions {
  /** Path to jat13.db, or ':memory:' for tests. */
  file: string;
  /** Override the migrations directory (packaged app passes an explicit path). */
  migrationsDir?: string;
  /** Open read-only (the v11 importer opens the SOURCE db this way; never the live one). */
  readonly?: boolean;
}

export interface OpenResult {
  db: DB;
  migration: MigrateResult;
}

/**
 * Pragmas applied to every writable handle. Kept in one place so the diagnostics page can
 * assert them and a stray connection can never run with the wrong durability/enforcement.
 *  - WAL: concurrent readers (the Hono server) never block the single writer.
 *  - synchronous=NORMAL: safe under WAL, far fewer fsyncs than FULL.
 *  - foreign_keys=ON: the CASCADE/SET NULL wiring in the schema is only real if this is on.
 *  - busy_timeout: a reader mid-checkpoint waits, never throws SQLITE_BUSY at the user.
 *  - trusted_schema=OFF: hardening — the schema uses only core functions, no loadable extensions.
 */
export function applyPragmas(db: DB): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('trusted_schema = OFF');
}

/**
 * Open (creating if absent), apply pragmas, migrate forward, and hand back the live handle.
 * Throws before returning if the DB is from a newer app or a migration fails — the caller
 * surfaces that as the read-only "migration failed / update the app" launch state.
 */
export function openDatabase(opts: OpenOptions): OpenResult {
  const readonly = opts.readonly ?? false;
  const db = new Database(opts.file, { readonly, fileMustExist: readonly });

  if (readonly) {
    // A read-only handle can't run WAL/enforcement pragmas that write; enforce what it can.
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = OFF');
    return { db, migration: { from: db.pragma('user_version', { simple: true }) as number, to: 0, applied: [] } };
  }

  applyPragmas(db);
  const migration = runMigrations(db, opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  return { db, migration };
}
