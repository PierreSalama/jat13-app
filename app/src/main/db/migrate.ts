// Forward-only migration runner. Every rule here is a scar — the v11 set plus the two LATENT v13
// traps the postmortem documented (traps #7/#8), both closed here for real:
//  1. Forward-only: user_version > highest known → REFUSE to open (never downgrade a DB).
//  2. One migration = one transaction; failure rolls back whole (never a half-migrated DB).
//  3. user_version is written ONLY here (grep-gate enforced elsewhere).
//  4. schema_migrations ledger row per applied migration, for the diagnostics page.
//  5. No gaps: versions must be contiguous 1..N (a missing NNN is a packaging bug, caught loud).
//  6. LOUD ON UNKNOWN FILES (v13 trap #7): any *.sql in the migrations dir that does not match
//     NNN_name.sql THROWS at boot. The old regex silently dropped `002_add_thing.sql` (underscore
//     in the name part) and the migration simply never ran — a silent skip in a convention dir.
//  7. PRE-MIGRATION BACKUP (v13 trap #8): before each migration applied over a db that already has
//     content, db + wal/shm sidecars are copied to <db>.pre-migrate-<version>.bak. The old code
//     deferred this behind a "wired when 002 lands" comment; 002–005 landed and it never was.
//     Deferrals carry a failing test, not a comment — so this ships working, with tests, at 001.
//
// migrationsDir: tests + `npm run dev` resolve it relative to THIS source file. The packaged app
// passes an explicit dir (esbuild bundles main.js; the .sql files are copied beside it by the build),
// so production never relies on import.meta.url pointing at a bundled location.

import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = join(HERE, 'migrations');

const FILE_RX = /^(\d{3})_([a-z0-9-]+)\.sql$/;

export interface MigrationFile {
  version: number;
  name: string;
  path: string;
}

/**
 * Enumerate the migrations dir. Only *.sql files participate in the convention; a stray non-sql file
 * (editor swap, .gitkeep) is ignored. A .sql file that does NOT match the convention is a boot ERROR —
 * never a silent skip (postmortem law 5: loud on unknown, everywhere a directory is scanned by convention).
 */
export function discoverMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const migs: MigrationFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.sql$/i.test(entry.name)) continue;
    const m = FILE_RX.exec(entry.name);
    if (!m) {
      throw new Error(
        `migrations dir contains an unrecognized .sql file: "${entry.name}" — migration filenames ` +
          `must match NNN_name.sql with a lowercase [a-z0-9-] name (dashes, not underscores). ` +
          `Rename or remove it; JAT refuses to guess. (The old runner silently skipped such files ` +
          `and the migration never ran — v13 postmortem trap #7.)`,
      );
    }
    migs.push({ version: Number(m[1]), name: m[2]!, path: join(dir, entry.name) });
  }
  migs.sort((a, b) => a.version - b.version);

  // Contiguity: NNN must be 1..N with no gaps and no duplicates.
  migs.forEach((mig, i) => {
    if (mig.version !== i + 1) {
      throw new Error(
        `migration numbering broken: expected ${String(i + 1).padStart(3, '0')}, found ${String(mig.version).padStart(3, '0')}_${mig.name}`,
      );
    }
  });
  return migs;
}

export interface AppliedMigration {
  version: number;
  name: string;
  ms: number;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: AppliedMigration[];
  /** paths of the pre-migration .bak files written this run (empty for fresh installs / :memory:). */
  backups: string[];
}

/** True when the db already holds anything worth protecting (applied schema or any objects at all). */
function hasContent(db: Database): boolean {
  const userVersion = db.pragma('user_version', { simple: true }) as number;
  if (userVersion > 0) return true;
  // user_version 0 but objects present = a foreign/hand-made SQLite file; still worth a backup.
  const row = db.prepare('SELECT count(*) AS n FROM sqlite_master').get() as { n: number };
  return row.n > 0;
}

/**
 * Copy db (+ -wal/-shm sidecars if present) to <db>.pre-migrate-<version>.bak before mutating it.
 * Skipped for :memory:/temp dbs (nothing on disk) and empty files. Sidecars keep the -wal/-shm
 * suffix RELATIVE TO THE .bak name so the backup opens as a normal SQLite file if restored.
 * Returns the .bak path, or null when there was nothing to copy.
 */
function backupBeforeMigration(db: Database, version: number): string | null {
  if (db.memory || db.name === '') return null;
  const file = db.name;
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return null; // file vanished between open and here — nothing to save
  }
  if (size === 0) return null;

  // Fold the WAL into the main file first so the copy is complete even if a sidecar copy fails.
  // Safe: migrations run at boot, single writer, no concurrent readers yet. Best-effort — if the
  // checkpoint can't run, copying db+wal+shm below still yields a restorable set.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* fall through to the three-file copy */
  }

  const dest = `${file}.pre-migrate-${version}.bak`;
  copyFileSync(file, dest);
  for (const suffix of ['-wal', '-shm'] as const) {
    if (existsSync(file + suffix)) copyFileSync(file + suffix, dest + suffix);
  }
  return dest;
}

/**
 * Bring `db` up to the latest migration. Idempotent: already-applied versions are skipped.
 * Throws (leaving the DB untouched) if the DB was created by a newer app, if the migrations dir
 * contains an unrecognized .sql file, or if any migration fails.
 */
export function runMigrations(db: Database, dir: string = DEFAULT_MIGRATIONS_DIR): MigrateResult {
  const migs = discoverMigrations(dir);
  const highest = migs.length ? migs[migs.length - 1]!.version : 0;
  const from = db.pragma('user_version', { simple: true }) as number;

  if (from > highest) {
    throw new Error(
      `This database (schema v${from}) was created by a newer JAT than this app understands (max v${highest}). Update the app — JAT never downgrades a database.`,
    );
  }

  // Decide ONCE, before mutating, whether this db holds anything worth protecting. A fresh install
  // (empty schema) gets no backups even when several migrations apply in a row; an existing db gets
  // one restore point per pending migration.
  const pending = migs.some((m) => m.version > from);
  const worthBackingUp = pending && hasContent(db);

  const applied: AppliedMigration[] = [];
  const backups: string[] = [];
  for (const mig of migs) {
    if (mig.version <= from) continue;

    if (worthBackingUp) {
      const bak = backupBeforeMigration(db, mig.version);
      if (bak !== null) backups.push(bak);
    }

    const sql = readFileSync(mig.path, 'utf8');
    const started = Date.now();

    // One migration = one transaction. exec() runs every statement in the file; the
    // schema_migrations ledger row is written inside the SAME tx (001 creates that table first).
    const tx = db.transaction(() => {
      db.exec(sql);
      const ms = Date.now() - started;
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at, ms) VALUES (?, ?, ?, ?)',
      ).run(mig.version, mig.name, Date.now(), ms);
      // user_version is a PRAGMA, not a bound param — value is a validated integer from the filename.
      db.pragma(`user_version = ${mig.version}`);
    });
    tx();

    applied.push({ version: mig.version, name: mig.name, ms: Date.now() - started });
  }

  return { from, to: highest, applied, backups };
}
