// events DAL — behavior AND guard paths. The timeline is durable history, so these tests assert
// DESC ordering round-trips, the unknown-kind rejection, the 4096-byte data cap, and kind filtering.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { defaultContext, type DomainEvent } from '../../app/src/main/db/dal/util.js';
import { makeEventsDal, type EventsDal } from '../../app/src/main/db/dal/events.js';

const T = 1_700_000_000_000; // fixed epoch-ms base

/** Seed the FK parents an event can reference (job + profile + application). */
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

describe('events DAL', () => {
  let db: Database;
  let dal: EventsDal;
  let clock: number;
  let emitted: DomainEvent[];

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    seed(db);
    clock = T;
    emitted = [];
    const ctx = {
      ...defaultContext(db, (evt) => emitted.push(evt)),
      now: () => clock, // deterministic, advanceable clock
    };
    dal = makeEventsDal(ctx);
  });
  afterEach(() => db.close());

  describe('record + timeline', () => {
    it('round-trips an event and returns it in the lean row shape', () => {
      const row = dal.record({
        kind: 'note',
        applicationId: 'appl_1',
        jobId: 'job_1',
        source: 'ui',
        summary: 'A note',
        data: { foo: 'bar' },
      });
      expect(row.id).toMatch(/^evt_/);
      expect(row.at).toBe(T);
      expect(row.kind).toBe('note');
      expect(row.application_id).toBe('appl_1');
      expect(row.job_id).toBe('job_1');
      expect(row.summary).toBe('A note');
      expect(row.data).toEqual({ foo: 'bar' });

      const page = dal.timeline('appl_1');
      expect(page.total).toBe(1);
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]?.id).toBe(row.id);
      expect(page.rows[0]?.data).toEqual({ foo: 'bar' }); // JSON.parse on read
    });

    it('emits a DomainEvent { table:events, op:insert } on every record', () => {
      const row = dal.record({ kind: 'created', applicationId: 'appl_1' });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.table).toBe('events');
      expect(emitted[0]?.op).toBe('insert');
      expect(emitted[0]?.id).toBe(row.id);
      expect(emitted[0]?.patch?.kind).toBe('created');
    });

    it('orders the timeline newest-first (at DESC)', () => {
      clock = T + 1;
      const a = dal.record({ kind: 'created', applicationId: 'appl_1', summary: 'first' });
      clock = T + 2;
      const b = dal.record({ kind: 'status_change', applicationId: 'appl_1', summary: 'second' });
      clock = T + 3;
      const c = dal.record({ kind: 'submitted', applicationId: 'appl_1', summary: 'third' });

      const page = dal.timeline('appl_1');
      expect(page.total).toBe(3);
      expect(page.rows.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    });

    it('scopes the timeline to one application', () => {
      // second application under the same profile+another job
      db.prepare('INSERT INTO jobs (id, source, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('job_2', 'indeed', T, T, T, T);
      db.prepare('INSERT INTO applications (id, job_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('appl_2', 'job_2', 'prof_1', T, T);

      dal.record({ kind: 'created', applicationId: 'appl_1' });
      dal.record({ kind: 'created', applicationId: 'appl_2' });
      dal.record({ kind: 'note', applicationId: 'appl_2' });

      expect(dal.timeline('appl_1').total).toBe(1);
      expect(dal.timeline('appl_2').total).toBe(2);
    });

    it('honors an explicit timeline limit while total stays unbounded', () => {
      for (let i = 0; i < 5; i++) {
        clock = T + i;
        dal.record({ kind: 'note', applicationId: 'appl_1' });
      }
      const page = dal.timeline('appl_1', { limit: 2 });
      expect(page.rows).toHaveLength(2);
      expect(page.total).toBe(5);
    });
  });

  describe('guard: unknown kind', () => {
    it('throws before touching the DB on an unknown kind', () => {
      expect(() =>
        // deliberately bad kind — bypass the type to exercise the runtime guard
        dal.record({ kind: 'succeeded' as unknown as 'note', applicationId: 'appl_1' }),
      ).toThrow(/unknown kind/);
      // nothing was written and nothing was emitted
      expect(dal.timeline('appl_1').total).toBe(0);
      expect(emitted).toHaveLength(0);
    });
  });

  describe('guard: data over the 4096-byte cap', () => {
    it('drops oversized data and records a warning marker instead', () => {
      const big = { blob: 'x'.repeat(5000) }; // well over 4096 serialized bytes
      const row = dal.record({ kind: 'imported', applicationId: 'appl_1', data: big });
      // the row still recorded (event is not lost)
      expect(dal.timeline('appl_1').total).toBe(1);
      // and its data is the marker, not the original payload
      expect(row.data).toMatchObject({ warning: expect.stringContaining('over 4096-byte cap') });

      // re-read from the DB to confirm the persisted column is the small marker, under the CHECK cap
      const persisted = dal.timeline('appl_1').rows[0];
      expect(persisted?.data).toMatchObject({ warning: expect.stringContaining('dropped') });
    });

    it('keeps data that fits under the cap intact', () => {
      const payload = { ok: true, n: 42, list: [1, 2, 3] };
      const row = dal.record({ kind: 'park', applicationId: 'appl_1', data: payload });
      expect(row.data).toEqual(payload);
      expect(dal.timeline('appl_1').rows[0]?.data).toEqual(payload);
    });

    it('round-trips a bare-primitive data payload (still valid JSON under the DDL CHECK)', () => {
      // JSON.stringify('hi') -> '"hi"'; json_valid() accepts it, so the CHECK must not reject it.
      const row = dal.record({ kind: 'note', applicationId: 'appl_1', data: 'hi' });
      expect(row.data).toBe('hi');
      const raw = db.prepare('SELECT data_json FROM events WHERE id = ?').get(row.id) as {
        data_json: string;
      };
      expect(raw.data_json).toBe('"hi"');
      expect(dal.timeline('appl_1').rows[0]?.data).toBe('hi');
    });

    it('treats the marker as its own valid, under-cap JSON when data is oversized', () => {
      const big = { blob: 'x'.repeat(5000) };
      const row = dal.record({ kind: 'imported', applicationId: 'appl_1', data: big });
      // the persisted marker must itself satisfy json_valid AND the 4096-byte length CHECK
      const raw = db.prepare('SELECT data_json FROM events WHERE id = ?').get(row.id) as {
        data_json: string;
      };
      expect(raw.data_json).not.toBeNull();
      expect(Buffer.byteLength(raw.data_json, 'utf8')).toBeLessThanOrEqual(4096);
      expect(() => JSON.parse(raw.data_json)).not.toThrow();
    });

    it('stores null data_json when no data is supplied', () => {
      dal.record({ kind: 'created', applicationId: 'appl_1' });
      const raw = db.prepare('SELECT data_json FROM events WHERE application_id = ?').get('appl_1') as {
        data_json: string | null;
      };
      expect(raw.data_json).toBeNull();
    });
  });

  describe('recent', () => {
    beforeEach(() => {
      clock = T + 1;
      dal.record({ kind: 'created', applicationId: 'appl_1' });
      clock = T + 2;
      dal.record({ kind: 'submitted', applicationId: 'appl_1' });
      clock = T + 3;
      dal.record({ kind: 'note', applicationId: 'appl_1' });
      clock = T + 4;
      dal.record({ kind: 'submitted', applicationId: 'appl_1' });
    });

    it('returns recent events across everything, newest first', () => {
      const page = dal.recent();
      expect(page.total).toBe(4);
      expect(page.rows.map((r) => r.kind)).toEqual(['submitted', 'note', 'submitted', 'created']);
    });

    it('filters by a kind list', () => {
      const page = dal.recent({ kinds: ['submitted'] });
      expect(page.total).toBe(2);
      expect(page.rows).toHaveLength(2);
      expect(page.rows.every((r) => r.kind === 'submitted')).toBe(true);
    });

    it('filters by multiple kinds', () => {
      const page = dal.recent({ kinds: ['note', 'created'] });
      expect(page.total).toBe(2);
      expect(new Set(page.rows.map((r) => r.kind))).toEqual(new Set(['note', 'created']));
    });

    it('honors an explicit recent limit while total stays unbounded', () => {
      const page = dal.recent({ limit: 1 });
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]?.kind).toBe('submitted'); // most recent
      expect(page.total).toBe(4);
    });

    it('returns an empty page (no unfiltered scan) when the kind filter has only unknown kinds', () => {
      const page = dal.recent({ kinds: ['bogus', 'also_bogus'] });
      expect(page.rows).toHaveLength(0);
      expect(page.total).toBe(0);
    });

    it('returns an empty page for a literal empty kind filter (does not degrade to unfiltered)', () => {
      const page = dal.recent({ kinds: [] });
      expect(page.rows).toHaveLength(0);
      expect(page.total).toBe(0);
    });

    it('drops unknown kinds from a mixed filter but keeps the valid ones', () => {
      const page = dal.recent({ kinds: ['submitted', 'bogus'] });
      expect(page.total).toBe(2);
      expect(page.rows.every((r) => r.kind === 'submitted')).toBe(true);
    });
  });
});
