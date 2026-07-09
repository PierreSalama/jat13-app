// Forward-only migration runner (Pillar 4 §3). Every rule here is a v11 scar:
//  1. Forward-only: user_version > highest known → REFUSE to open (never downgrade a DB).
//  2. One migration = one transaction; failure rolls back whole (never a half-migrated DB).
//  3. user_version is written ONLY here (build-gate enforced elsewhere).
//  4. schema_migrations ledger row per applied migration, for the diagnostics page.
//  5. No gaps: versions must be contiguous 1..N (a missing NNN is a packaging bug, caught loud).
//
// The pre-migration backup (rule 2 in the plan) belongs to migrations BEYOND 001; wired in when
// 002 lands (it needs the async db.backup()). Today only 001 exists on a fresh DB, so no data to save.
//
// migrationsDir: tests + `npm run dev` resolve it relative to THIS source file. The packaged app
// passes an explicit dir (esbuild bundles main.js; the .sql files are copied beside it by build.mjs),
// so production never relies on import.meta.url pointing at a bundled location.

import { readFileSync, readdirSync } from 'node:fs';
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

export function discoverMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const migs = readdirSync(dir)
    .map((f) => {
      const m = FILE_RX.exec(f);
      return m ? { version: Number(m[1]), name: m[2]!, path: join(dir, f) } : null;
    })
    .filter((x): x is MigrationFile => x !== null)
    .sort((a, b) => a.version - b.version);

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
}

/**
 * Bring `db` up to the latest migration. Idempotent: already-applied versions are skipped.
 * Throws (leaving the DB untouched) if the DB was created by a newer app, or if any migration fails.
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

  const applied: AppliedMigration[] = [];
  for (const mig of migs) {
    if (mig.version <= from) continue;
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

  return { from, to: highest, applied };
}
