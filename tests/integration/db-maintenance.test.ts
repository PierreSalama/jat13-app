import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { runMaintenance, RETENTION } from '../../app/src/main/db/maintenance.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function seedProfile(db: Database) {
  db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?,?,1,?,?)')
    .run('p1', 'Pierre', NOW, NOW);
}
function seedJob(db: Database, id: string, lastSeen: number) {
  db.prepare(
    'INSERT INTO jobs (id, source, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run(id, 'linkedin', lastSeen, lastSeen, lastSeen, lastSeen);
}
function seedTerminalRunWithStep(db: Database, jobId: string, finishedAt: number) {
  db.prepare('INSERT INTO applications (id, job_id, profile_id, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run('a_' + jobId, jobId, 'p1', NOW, NOW);
  db.prepare(
    `INSERT INTO apply_runs (id, application_id, job_id, profile_id, source, state, queued_at, finished_at, updated_at)
     VALUES (?,?,?,?,?, 'failed', ?, ?, ?)`,
  ).run('r_' + jobId, 'a_' + jobId, jobId, 'p1', 'linkedin', finishedAt, finishedAt, finishedAt);
  db.prepare('INSERT INTO apply_run_steps (run_id, seq, at, phase) VALUES (?,1,?,?)').run('r_' + jobId, finishedAt, 'finish');
}

describe('runMaintenance (retention-by-design, time-based half)', () => {
  let db: Database;
  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    seedProfile(db);
  });
  afterEach(() => db.close());

  it('deletes steps of terminal runs past the window, keeps recent ones', () => {
    seedJob(db, 'old', NOW - 100 * DAY);
    seedJob(db, 'new', NOW - 1 * DAY);
    seedTerminalRunWithStep(db, 'old', NOW - (RETENTION.stepsDays + 5) * DAY); // beyond 14d
    seedTerminalRunWithStep(db, 'new', NOW - 1 * DAY); // recent

    const rep = runMaintenance(db, NOW);
    expect(rep.stepsDeleted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM apply_run_steps WHERE run_id=?').get('r_old')).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM apply_run_steps WHERE run_id=?').get('r_new')).toEqual({ c: 1 });
  });

  it('marks unseen jobs stale ONLY when they have no application', () => {
    seedJob(db, 'ghost', NOW - (RETENTION.staleJobDays + 10) * DAY); // old, no application
    seedJob(db, 'applied', NOW - (RETENTION.staleJobDays + 10) * DAY); // old, but applied to
    db.prepare('INSERT INTO applications (id, job_id, profile_id, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('a_applied', 'applied', 'p1', NOW, NOW);
    seedJob(db, 'fresh', NOW - 2 * DAY); // recent

    const rep = runMaintenance(db, NOW);
    expect(rep.jobsStaled).toBe(1);
    const state = (id: string) => (db.prepare('SELECT posting_state s FROM jobs WHERE id=?').get(id) as { s: string }).s;
    expect(state('ghost')).toBe('stale');
    expect(state('applied')).toBe('active');
    expect(state('fresh')).toBe('active');
  });

  it('vacuums at most every 3 days (kv-stamped)', () => {
    const first = runMaintenance(db, NOW);
    expect(first.vacuumed).toBe(true); // no stamp yet
    const soon = runMaintenance(db, NOW + 1 * DAY);
    expect(soon.vacuumed).toBe(false); // within window
    const later = runMaintenance(db, NOW + (RETENTION.vacuumEveryDays + 1) * DAY);
    expect(later.vacuumed).toBe(true); // window elapsed
  });

  it('does not choke on the not-yet-created emails table (migration 003)', () => {
    const rep = runMaintenance(db, NOW);
    expect(rep.emailsDeleted).toBe(0); // guarded by hasTable
  });
});
