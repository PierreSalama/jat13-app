// Migration runner tests — the two v13 postmortem traps (silent filename skip #7, unwired backup #8)
// each have a test here so they can never regress silently again.

import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS_DIR,
  discoverMigrations,
  runMigrations,
} from '../../app/src/main/db/migrate.js';
import { applyPragmas, openDatabase } from '../../app/src/main/db/index.js';

/** temp dir seeded with the REAL 001 so fixture chains build on the actual schema. */
function fixtureDir(extraFiles: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jat13-mig-'));
  copyFileSync(join(DEFAULT_MIGRATIONS_DIR, '001_init.sql'), join(dir, '001_init.sql'));
  for (const [name, sql] of Object.entries(extraFiles)) {
    writeFileSync(join(dir, name), sql, 'utf8');
  }
  return dir;
}

const NOOP_002 = '-- test fixture\nCREATE TABLE backup_probe (x INTEGER) STRICT;\n';

describe('discoverMigrations', () => {
  it('the real migrations dir contains exactly 001_init', () => {
    const migs = discoverMigrations();
    expect(migs.map((m) => ({ version: m.version, name: m.name }))).toEqual([
      { version: 1, name: 'init' },
    ]);
  });

  it('THROWS on a .sql filename outside the convention (trap #7: old runner silently skipped it)', () => {
    // underscore in the name part — the exact shape the old regex dropped without a word
    const dir = fixtureDir({ '002_add_thing.sql': NOOP_002 });
    expect(() => discoverMigrations(dir)).toThrow(/unrecognized \.sql file.*002_add_thing\.sql/s);
  });

  it('THROWS on uppercase / free-form .sql names too', () => {
    const dir = fixtureDir({ 'HOTFIX.sql': '-- nope' });
    expect(() => discoverMigrations(dir)).toThrow(/unrecognized \.sql file.*HOTFIX\.sql/s);
  });

  it('ignores non-.sql files (a stray README is not a migration)', () => {
    const dir = fixtureDir({ 'README.md': '# not a migration' });
    expect(discoverMigrations(dir).map((m) => m.version)).toEqual([1]);
  });

  it('THROWS on a numbering gap (missing NNN = packaging bug)', () => {
    const dir = fixtureDir({ '003_later.sql': NOOP_002 }); // 002 missing
    expect(() => discoverMigrations(dir)).toThrow(/numbering broken.*expected 002.*found 003/s);
  });
});

describe('runMigrations', () => {
  it('applies 001 to a fresh db: user_version, ledger row, every v1 table present', () => {
    const { db, migration } = openDatabase({ file: ':memory:' });
    expect(migration.from).toBe(0);
    expect(migration.to).toBe(1);
    expect(migration.applied).toHaveLength(1);
    expect(migration.backups).toEqual([]); // fresh db — nothing worth backing up

    expect(db.pragma('user_version', { simple: true })).toBe(1);
    const ledger = db.prepare('SELECT version, name FROM schema_migrations').all();
    expect(ledger).toEqual([{ version: 1, name: 'init' }]);

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    // the whole v1 set from 00-MASTER-PLAN §5 (support tables included)
    for (const t of [
      'profiles', 'jobs', 'job_details', 'applications', 'apply_runs', 'apply_run_steps',
      'apply_ledger', 'learned_answers', 'documents', 'document_blobs', 'document_text',
      'email_accounts', 'emails', 'email_matches', 'events',
      'discovery_sources', 'company_tokens', 'discovery_batches', 'job_sightings',
      'fit_scores', 'autopsies', 'interviews', 'ai_calls',
      'settings', 'secrets', 'import_runs', 'schema_migrations',
    ]) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }
    db.close();
  });

  it('is idempotent: a second run applies nothing', () => {
    const { db } = openDatabase({ file: ':memory:' });
    const second = runMigrations(db);
    expect(second.from).toBe(1);
    expect(second.applied).toEqual([]);
    expect(second.backups).toEqual([]);
    db.close();
  });

  it('refuses a db created by a newer app (forward-only, never downgrade)', () => {
    const db = new Database(':memory:');
    applyPragmas(db);
    db.pragma('user_version = 99');
    expect(() => runMigrations(db)).toThrow(/newer JAT.*never downgrades/s);
    db.close();
  });

  it('writes <db>.pre-migrate-<version>.bak before migrating a NON-EMPTY file db (trap #8)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jat13-db-'));
    const file = join(dir, 'jat13.db');

    // boot 1: fresh install at v1 — no backups
    const first = openDatabase({ file });
    expect(first.migration.backups).toEqual([]);
    first.db.close();

    // boot 2: a 002 lands — the existing db must get a restore point BEFORE 002 touches it
    const migDir = fixtureDir({ '002_backup-probe.sql': NOOP_002 });
    const second = openDatabase({ file, migrationsDir: migDir });
    const bak = `${file}.pre-migrate-2.bak`;
    expect(second.migration.backups).toEqual([bak]);
    expect(existsSync(bak)).toBe(true);
    expect(second.db.pragma('user_version', { simple: true })).toBe(2);
    second.db.close();

    // the backup is a REAL restorable SQLite db: still v1, does NOT contain 002's table
    const restored = new Database(bak, { readonly: true, fileMustExist: true });
    expect(restored.pragma('user_version', { simple: true })).toBe(1);
    const probe = restored
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'backup_probe'")
      .get() as { n: number };
    expect(probe.n).toBe(0);
    restored.close();
  });

  it('skips the backup for :memory: (nothing on disk to copy)', () => {
    const db = new Database(':memory:');
    applyPragmas(db);
    runMigrations(db); // to v1 — db now HAS content, so only the memory guard skips the backup
    const migDir = fixtureDir({ '002_backup-probe.sql': NOOP_002 });
    const result = runMigrations(db, migDir);
    expect(result.applied.map((a) => a.version)).toEqual([2]);
    expect(result.backups).toEqual([]);
    db.close();
  });

  it('a failing migration rolls back whole: no ledger row, user_version unchanged', () => {
    const { db } = openDatabase({ file: ':memory:' });
    const migDir = fixtureDir({
      '002_broken.sql': 'CREATE TABLE ok_table (x INTEGER) STRICT;\nTHIS IS NOT SQL;\n',
    });
    expect(() => runMigrations(db, migDir)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    const ledger = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
    expect(ledger.map((r) => r.version)).toEqual([1]);
    const half = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'ok_table'")
      .get() as { n: number };
    expect(half.n).toBe(0); // nothing from the failed file survived
    db.close();
  });
});

describe('schema laws (the CHECKs are executable requirements)', () => {
  function seeded() {
    const { db } = openDatabase({ file: ':memory:' });
    const now = Date.now();
    db.prepare(
      'INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).run('pro_1', 'Pierre', now, now);
    db.prepare(
      `INSERT INTO jobs (id, source, title, company, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES ('job_1', 'linkedin', 'Dev', 'Acme', ?, ?, ?, ?)`,
    ).run(now, now, now, now);
    db.prepare(
      `INSERT INTO applications (id, job_id, profile_id, created_at, updated_at)
       VALUES ('app_1', 'job_1', 'pro_1', ?, ?)`,
    ).run(now, now);
    return { db, now };
  }

  function insertRun(db: Database.Database, now: number, state: string, evidenceKind: string | null) {
    return db
      .prepare(
        `INSERT INTO apply_runs (id, application_id, job_id, profile_id, source, state, evidence_kind, queued_at, updated_at)
         VALUES (?, 'app_1', 'job_1', 'pro_1', 'linkedin', ?, ?, ?, ?)`,
      )
      .run(`run_${state}_${evidenceKind ?? 'none'}`, state, evidenceKind, now, now);
  }

  it("submit truth: state='submitted' requires trustworthy typed evidence", () => {
    const { db, now } = seeded();
    // no evidence → refused at the schema
    expect(() => insertRun(db, now, 'submitted', null)).toThrow(/CHECK/i);
    // legacy_untrusted is explicitly NOT good enough
    expect(() => insertRun(db, now, 'submitted', 'legacy_untrusted')).toThrow(/CHECK/i);
    // a trustworthy kind passes
    expect(() => insertRun(db, now, 'submitted', 'confirm_signal')).not.toThrow();
    db.close();
  });

  it('application status vocabulary is CHECK-bounded (unknown status = loud error)', () => {
    const { db, now } = seeded();
    const upd = db.prepare('UPDATE applications SET status = ?, updated_at = ? WHERE id = ?');
    expect(() => upd.run('applied', now, 'app_1')).toThrow(/CHECK/i); // v11 label, not v13 vocab
    expect(() => upd.run('ghosted', now, 'app_1')).not.toThrow();
    db.close();
  });

  it('run state vocabulary is the exact 13-state set', () => {
    const { db, now } = seeded();
    expect(() => insertRun(db, now, 'succeeded', null)).toThrow(/CHECK/i); // pillar-era name, killed
    for (const s of ['queued', 'leased', 'waiting_page', 'ready_for_review']) {
      expect(() => insertRun(db, now, s, null)).not.toThrow();
    }
    db.close();
  });
});
