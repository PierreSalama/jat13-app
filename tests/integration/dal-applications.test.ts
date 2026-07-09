// applications DAL — the tests assert the FORWARD-ONLY guard's rejection paths (the load-bearing
// correctness), not just the happy path. Each expected throw is a v11 funnel-corruption bug this
// module makes impossible: backward moves, reopening a locked terminal, silent status downgrades.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { defaultContext, type DomainEvent } from '../../app/src/main/db/dal/util.js';
import { makeApplicationsDal, type ApplicationStatus } from '../../app/src/main/db/dal/applications.js';

const T = 1_700_000_000_000; // fixed epoch-ms; the clock is injected so time is deterministic.

/** Seed the FK parents (a profile + a job) an application needs. */
function seedParents(db: Database, jobId = 'job_1', profileId = 'prof_1'): { jobId: string; profileId: string } {
  db.prepare('INSERT OR IGNORE INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
    .run(profileId, 'Pierre', T, T);
  db.prepare('INSERT OR IGNORE INTO jobs (id, source, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(jobId, 'linkedin', T, T, T, T);
  return { jobId, profileId };
}

describe('applications DAL', () => {
  let db: Database;
  let clock: number;
  let events: DomainEvent[];
  let dal: ReturnType<typeof makeApplicationsDal>;

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    clock = T;
    events = [];
    const base = defaultContext(db, (e) => events.push(e));
    dal = makeApplicationsDal({ ...base, now: () => clock });
    seedParents(db);
  });
  afterEach(() => db.close());

  // ---- ensure ------------------------------------------------------------------------------------
  describe('ensure', () => {
    it('creates a tracked row and emits an insert', () => {
      const row = dal.ensure('job_1', 'prof_1');
      expect(row.status).toBe('tracked');
      expect(row.job_id).toBe('job_1');
      expect(row.profile_id).toBe('prof_1');
      expect(row.answers_json).toBe('[]');
      expect(row.attachments_json).toBe('[]');
      expect(row.submitted_at).toBeNull();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ table: 'applications', op: 'insert', id: row.id });
    });

    it('is get-or-create — the second call returns the SAME row and does not re-emit', () => {
      const a = dal.ensure('job_1', 'prof_1');
      const b = dal.ensure('job_1', 'prof_1');
      expect(b.id).toBe(a.id);
      expect(events).toHaveLength(1); // only the create emitted
      const n = db.prepare('SELECT COUNT(*) c FROM applications').get() as { c: number };
      expect(n.c).toBe(1);
    });
  });

  // ---- elevate: forward-only guard (the core) ----------------------------------------------------
  describe('elevate — forward-only', () => {
    it('allows a forward progressive move and emits an update', () => {
      const a = dal.ensure('job_1', 'prof_1');
      events.length = 0;
      const moved = dal.elevate(a.id, 'acknowledged');
      expect(moved.status).toBe('acknowledged');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ table: 'applications', op: 'update', id: a.id });
    });

    it('THROWS on a backward progressive move without bumping updated_at or emitting', () => {
      const a = dal.ensure('job_1', 'prof_1');
      dal.elevate(a.id, 'interview_1'); // climb up first
      const before = dal.get(a.id)!;
      events.length = 0;
      clock = T + 12345; // a real write would stamp this
      expect(() => dal.elevate(a.id, 'submitted')).toThrow(/backward status move refused/);
      // the row is fully unchanged after the refusal (status, updated_at) and nothing emitted
      const after = dal.get(a.id)!;
      expect(after.status).toBe('interview_1');
      expect(after.updated_at).toBe(before.updated_at);
      expect(events).toHaveLength(0);
    });

    it('THROWS on an equal-rank sideways move (interview_1 stays put)', () => {
      const a = dal.ensure('job_1', 'prof_1');
      dal.elevate(a.id, 'submitted');
      dal.elevate(a.id, 'assessment');
      // assessment (rank 3) -> submitted (rank 1) is backward; a same-rank retreat is likewise refused.
      expect(() => dal.elevate(a.id, 'submitted')).toThrow(/backward status move refused/);
      expect(dal.get(a.id)?.status).toBe('assessment');
    });

    it('same-status is a NO-OP: returns unchanged, no throw, no emit, no updated_at bump', () => {
      const a = dal.ensure('job_1', 'prof_1');
      dal.elevate(a.id, 'submitted');
      const before = dal.get(a.id)!;
      events.length = 0;
      clock = T + 999; // advance the clock — a real write would stamp it
      const same = dal.elevate(a.id, 'submitted');
      expect(same.status).toBe('submitted');
      expect(same.updated_at).toBe(before.updated_at); // untouched
      expect(events).toHaveLength(0);
    });

    it('stamps submitted_at exactly once when entering submitted', () => {
      const a = dal.ensure('job_1', 'prof_1');
      clock = T + 10;
      const s = dal.elevate(a.id, 'submitted');
      expect(s.submitted_at).toBe(T + 10);
      // a later forward move must NOT re-stamp submitted_at
      clock = T + 20;
      const ack = dal.elevate(a.id, 'acknowledged');
      expect(ack.submitted_at).toBe(T + 10);
      expect(ack.updated_at).toBe(T + 20);
    });

    it('persists `via` when supplied', () => {
      const a = dal.ensure('job_1', 'prof_1');
      const s = dal.elevate(a.id, 'submitted', 'auto');
      expect(s.via).toBe('auto');
    });

    it('throws on an unknown status without touching the row', () => {
      const a = dal.ensure('job_1', 'prof_1');
      expect(() => dal.elevate(a.id, 'succeeded' as unknown as ApplicationStatus)).toThrow(/unknown application status/);
      expect(dal.get(a.id)?.status).toBe('tracked');
    });

    it('throws when the application does not exist', () => {
      expect(() => dal.elevate('appl_nope', 'submitted')).toThrow(/not found/);
    });
  });

  // ---- elevate: terminal lock + withdraw carve-out -----------------------------------------------
  describe('elevate — terminal states', () => {
    it('sets a terminal (rejected) from a non-terminal state', () => {
      const a = dal.ensure('job_1', 'prof_1');
      dal.elevate(a.id, 'submitted');
      const r = dal.elevate(a.id, 'rejected');
      expect(r.status).toBe('rejected');
    });

    it('sets ghosted from a non-terminal state', () => {
      const a = dal.ensure('job_1', 'prof_1');
      dal.elevate(a.id, 'submitted');
      expect(dal.elevate(a.id, 'ghosted').status).toBe('ghosted');
    });

    it('LOCKS a terminal row — further elevate (non-withdraw) throws', () => {
      const a = dal.ensure('job_1', 'prof_1');
      dal.elevate(a.id, 'rejected');
      expect(() => dal.elevate(a.id, 'interview_1')).toThrow(/terminal/);
      expect(() => dal.elevate(a.id, 'offer')).toThrow(/terminal/);
      expect(() => dal.elevate(a.id, 'ghosted')).toThrow(/terminal/);
      expect(dal.get(a.id)?.status).toBe('rejected'); // unchanged
    });

    it('locks even hired (a happy terminal)', () => {
      const a = dal.ensure('job_1', 'prof_1');
      dal.elevate(a.id, 'submitted');
      dal.elevate(a.id, 'offer');
      dal.elevate(a.id, 'hired');
      expect(() => dal.elevate(a.id, 'rejected')).toThrow(/terminal/);
    });

    it('withdraw is ALWAYS allowed — from a fresh tracked row', () => {
      const a = dal.ensure('job_1', 'prof_1');
      expect(dal.elevate(a.id, 'withdrawn').status).toBe('withdrawn');
    });

    it('withdraw is ALWAYS allowed — even from another terminal (rejected → withdrawn)', () => {
      const a = dal.ensure('job_1', 'prof_1');
      dal.elevate(a.id, 'rejected');
      expect(dal.elevate(a.id, 'withdrawn').status).toBe('withdrawn');
    });

    it('withdraw is ALWAYS allowed — even from hired', () => {
      const a = dal.ensure('job_1', 'prof_1');
      dal.elevate(a.id, 'submitted');
      dal.elevate(a.id, 'offer');
      dal.elevate(a.id, 'hired');
      expect(dal.elevate(a.id, 'withdrawn').status).toBe('withdrawn');
    });
  });

  // ---- patch -------------------------------------------------------------------------------------
  describe('patch', () => {
    it('updates non-status fields and stringifies object JSON columns', () => {
      const a = dal.ensure('job_1', 'prof_1');
      clock = T + 5;
      const p = dal.patch(a.id, {
        notes: 'called recruiter',
        next_action: 'follow up',
        due_at: T + 86_400_000,
        needs_review: true,
        answers_json: [{ q: 'authorized?', a: 'yes' }],
        attachments_json: ['resume.pdf'],
        via: 'manual',
      });
      expect(p.notes).toBe('called recruiter');
      expect(p.next_action).toBe('follow up');
      expect(p.due_at).toBe(T + 86_400_000);
      expect(p.needs_review).toBe(1);
      expect(p.via).toBe('manual');
      expect(JSON.parse(p.answers_json)).toEqual([{ q: 'authorized?', a: 'yes' }]);
      expect(JSON.parse(p.attachments_json)).toEqual(['resume.pdf']);
      expect(p.updated_at).toBe(T + 5);
      expect(p.status).toBe('tracked'); // patch never touches status
    });

    it('passes a pre-stringified JSON string through unchanged', () => {
      const a = dal.ensure('job_1', 'prof_1');
      const p = dal.patch(a.id, { answers_json: '[{"q":"x"}]' });
      expect(p.answers_json).toBe('[{"q":"x"}]');
    });

    it('a patch with no recognized field is a no-op (no write, no emit)', () => {
      const a = dal.ensure('job_1', 'prof_1');
      const before = dal.get(a.id)!;
      events.length = 0;
      clock = T + 100;
      const p = dal.patch(a.id, {} as never);
      expect(p.updated_at).toBe(before.updated_at);
      expect(events).toHaveLength(0);
    });

    it('throws when the application does not exist', () => {
      expect(() => dal.patch('appl_nope', { notes: 'x' })).toThrow(/not found/);
    });

    it('never writes status — a stray status key is ignored (no downgrade, no throw)', () => {
      const a = dal.ensure('job_1', 'prof_1');
      dal.elevate(a.id, 'interview_1');
      events.length = 0;
      // A caller who smuggles `status` through patch must NOT be able to bypass elevate's guard.
      const p = dal.patch(a.id, { status: 'tracked', notes: 'x' } as never);
      expect(p.status).toBe('interview_1'); // status untouched by patch
      expect(p.notes).toBe('x');
      // and if status is the ONLY (unrecognized) key, it's a pure no-op
      events.length = 0;
      const before = dal.get(a.id)!;
      const p2 = dal.patch(a.id, { status: 'tracked' } as never);
      expect(p2.status).toBe('interview_1');
      expect(p2.updated_at).toBe(before.updated_at);
      expect(events).toHaveLength(0);
    });
  });

  // ---- listLean ----------------------------------------------------------------------------------
  describe('listLean', () => {
    it('returns {rows,total}, filters by status and profile, and omits heavy columns', () => {
      seedParents(db, 'job_2', 'prof_1');
      seedParents(db, 'job_3', 'prof_2');
      const a1 = dal.ensure('job_1', 'prof_1');
      dal.ensure('job_2', 'prof_1');
      dal.ensure('job_3', 'prof_2');
      dal.elevate(a1.id, 'submitted');

      const all = dal.listLean();
      expect(all.total).toBe(3);
      expect(all.rows).toHaveLength(3);
      // lean projection excludes answers_json/notes/attachments
      expect(all.rows[0]).not.toHaveProperty('answers_json');
      expect(all.rows[0]).not.toHaveProperty('notes');

      const byProfile = dal.listLean({ profileId: 'prof_1' });
      expect(byProfile.total).toBe(2);

      const byStatus = dal.listLean({ status: 'submitted' });
      expect(byStatus.total).toBe(1);
      expect(byStatus.rows[0]?.id).toBe(a1.id);
    });

    it('honors limit/offset while total reflects the full filtered set', () => {
      for (let i = 0; i < 5; i++) {
        seedParents(db, `job_p${i}`, 'prof_1');
        dal.ensure(`job_p${i}`, 'prof_1');
      }
      const page = dal.listLean({ profileId: 'prof_1', limit: 2, offset: 1 });
      expect(page.total).toBe(5);
      expect(page.rows).toHaveLength(2);
    });
  });

  // ---- funnel ------------------------------------------------------------------------------------
  describe('funnel', () => {
    it('counts by status within the window and zero-fills every status', () => {
      const a1 = dal.ensure('job_1', 'prof_1');
      seedParents(db, 'job_2', 'prof_1');
      const a2 = dal.ensure('job_2', 'prof_1');
      dal.elevate(a1.id, 'submitted');
      dal.elevate(a2.id, 'submitted');
      dal.elevate(a2.id, 'rejected');

      const f = dal.funnel({ days: 30 });
      expect(f.submitted).toBe(1);
      expect(f.rejected).toBe(1);
      expect(f.tracked).toBe(0); // both moved off tracked
      expect(f.hired).toBe(0); // zero-filled, present
      expect(Object.keys(f)).toHaveLength(12);
    });

    it('excludes rows older than the window', () => {
      const a = dal.ensure('job_1', 'prof_1');
      dal.elevate(a.id, 'submitted'); // stamped at T
      // now jump the clock far past the 30-day window relative to the stored updated_at
      clock = T + 40 * 86_400_000;
      const f = dal.funnel({ days: 30 });
      expect(f.submitted).toBe(0);
    });

    it('scopes to a profile when profileId is given', () => {
      seedParents(db, 'job_2', 'prof_2');
      const a1 = dal.ensure('job_1', 'prof_1');
      const a2 = dal.ensure('job_2', 'prof_2');
      dal.elevate(a1.id, 'submitted');
      dal.elevate(a2.id, 'submitted');
      expect(dal.funnel({ profileId: 'prof_1' }).submitted).toBe(1);
    });
  });
});
