// The schema IS the architecture — so the tests assert the REJECTIONS, not just the happy path.
// Each `toThrow` below is a v11 production failure that migration 001 makes structurally impossible.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { runMigrations, discoverMigrations } from '../../app/src/main/db/migrate.js';

const TOP = discoverMigrations().length; // current highest migration version

const T = 1_700_000_000_000; // fixed epoch-ms for deterministic rows

/** Insert the parent chain a run needs (FKs are ON), return the ids. */
function seed(db: Database): { profileId: string; jobId: string; applId: string } {
  const profileId = 'prof_1';
  const jobId = 'job_1';
  const applId = 'appl_1';
  db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
    .run(profileId, 'Pierre', T, T);
  db.prepare('INSERT INTO jobs (id, source, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(jobId, 'linkedin', T, T, T, T);
  db.prepare('INSERT INTO job_details (job_id, description) VALUES (?, ?)').run(jobId, 'desc');
  db.prepare('INSERT INTO applications (id, job_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(applId, jobId, profileId, T, T);
  return { profileId, jobId, applId };
}

function insertRun(db: Database, fields: Record<string, unknown>): void {
  const base: Record<string, unknown> = {
    id: 'run_1', application_id: 'appl_1', job_id: 'job_1', profile_id: 'prof_1',
    source: 'linkedin', state: 'queued', queued_at: T, updated_at: T,
  };
  const row = { ...base, ...fields };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO apply_runs (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

describe('migration 001-core', () => {
  let db: Database;
  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
  });
  afterEach(() => db.close());

  it('migrates a fresh DB to the top version and records the ledger', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(TOP);
    const row = db.prepare('SELECT version, name FROM schema_migrations WHERE version = 1').get() as
      | { version: number; name: string }
      | undefined;
    expect(row?.version).toBe(1);
    expect(row?.name).toBe('init');
    // every migration recorded a ledger row
    const n = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get() as { c: number };
    expect(n.c).toBe(TOP);
  });

  it('enforces foreign keys', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // orphan application (no such job/profile) is refused
    expect(() =>
      db.prepare('INSERT INTO applications (id, job_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('a', 'nope', 'nope', T, T),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  describe('the submit-truth constraint (structural law 5)', () => {
    beforeEach(() => seed(db));

    it('REFUSES state=submitted with no evidence', () => {
      expect(() => insertRun(db, { state: 'submitted', evidence_kind: null })).toThrow(/CHECK constraint failed/);
    });

    it('REFUSES state=submitted carrying only legacy_untrusted evidence', () => {
      expect(() => insertRun(db, { state: 'submitted', evidence_kind: 'legacy_untrusted' })).toThrow(
        /CHECK constraint failed/,
      );
    });

    it('ALLOWS state=submitted with trustworthy typed evidence', () => {
      expect(() => insertRun(db, { state: 'submitted', evidence_kind: 'text_became_success' })).not.toThrow();
      const n = db.prepare("SELECT COUNT(*) c FROM apply_runs WHERE state='submitted'").get() as { c: number };
      expect(n.c).toBe(1);
    });

    it('ALLOWS a non-terminal run to have no evidence yet', () => {
      expect(() => insertRun(db, { state: 'driving', evidence_kind: null })).not.toThrow();
    });

    it('REFUSES an unknown run state', () => {
      expect(() => insertRun(db, { state: 'succeeded' })).toThrow(/CHECK constraint failed/); // v11's word, banned
    });
  });

  it('caps apply_run_steps at 500 via RAISE(IGNORE), no error', () => {
    seed(db);
    insertRun(db, { state: 'driving' });
    const ins = db.prepare('INSERT INTO apply_run_steps (run_id, seq, at, phase) VALUES (?, ?, ?, ?)');
    expect(ins.run('run_1', 500, T, 'fill').changes).toBe(1); // 500 is allowed
    expect(ins.run('run_1', 501, T, 'fill').changes).toBe(0); // 501 silently ignored
    const n = db.prepare('SELECT COUNT(*) c FROM apply_run_steps WHERE run_id=?').get('run_1') as { c: number };
    expect(n.c).toBe(1);
  });

  it('rejects invalid or oversized JSON payloads', () => {
    seed(db);
    // not valid JSON
    expect(() =>
      db.prepare('INSERT INTO jobs (id, source, tags_json, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('j2', 'linkedin', 'not-json', T, T, T, T),
    ).toThrow(/CHECK constraint failed/);
    // valid JSON but over the 32KB answers cap
    const big = '["' + 'x'.repeat(33_000) + '"]';
    expect(() =>
      db.prepare('UPDATE applications SET answers_json=? WHERE id=?').run(big, 'appl_1'),
    ).toThrow(/CHECK constraint failed/);
  });

  it('allows only one application per (job, profile)', () => {
    seed(db);
    expect(() =>
      db.prepare('INSERT INTO applications (id, job_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('appl_dup', 'job_1', 'prof_1', T, T),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('allows only one default profile', () => {
    seed(db); // prof_1 is default
    expect(() =>
      db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
        .run('prof_2', 'Dad', T, T),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe('migration runner (forward-only)', () => {
  it('refuses to open a DB from a newer app', () => {
    const { db } = openDatabase({ file: ':memory:' });
    db.pragma('user_version = 99');
    expect(() => runMigrations(db)).toThrow(/newer JAT/);
    db.close();
  });

  it('is idempotent — re-running applies nothing', () => {
    const { db } = openDatabase({ file: ':memory:' });
    const res = runMigrations(db);
    expect(res.applied).toHaveLength(0);
    expect(res.from).toBe(TOP);
    db.close();
  });
});
