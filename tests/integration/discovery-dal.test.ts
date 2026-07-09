// discovery DAL — behavior AND the two structural guards. Runs against a real in-memory migrated DB
// (migration 004 must have created the four §2.8 tables). Asserts: source upsert + id/kind derivation,
// the tokensDue least-recently-scanned rotation, the dead-token auto-retire, recordBatch's zero-yield
// THROW (belt to the CHECK), and the PK-deduped job_sightings.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { defaultContext, type DomainEvent } from '../../app/src/main/db/dal/util.js';
import { makeDiscoveryDal, type DiscoveryDal } from '../../app/src/main/db/dal/discovery.js';

const T = 1_700_000_000_000;

/** Insert a bare jobs row so a job_sightings FK (job_id → jobs.id) resolves. */
function seedJob(db: Database, id: string): void {
  db.prepare(
    'INSERT INTO jobs (id, source, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, 'greenhouse', T, T, T, T);
}

describe('discovery DAL', () => {
  let db: Database;
  let dal: DiscoveryDal;
  let clock: number;
  let emitted: DomainEvent[];

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    clock = T;
    emitted = [];
    const ctx = { ...defaultContext(db, (e) => emitted.push(e)), now: () => clock };
    dal = makeDiscoveryDal(ctx);
  });
  afterEach(() => db.close());

  describe('sources', () => {
    it('creates a lane row with the derived id + default kind, then patches only the given columns', () => {
      const created = dal.sourceUpsert('greenhouse');
      expect(created.id).toBe('src_gh');
      expect(created.kind).toBe('ats_board');
      expect(created.enabled).toBe(1);
      expect(created.cursor).toEqual({});
      expect(emitted.at(-1)).toMatchObject({ table: 'discovery_sources', op: 'insert', id: 'src_gh' });

      clock = T + 5;
      const patched = dal.sourceUpsert('greenhouse', { enabled: 0, cursor: { page: 3 } });
      expect(patched.enabled).toBe(0);
      expect(patched.cursor).toEqual({ page: 3 });
      expect(patched.updated_at).toBe(T + 5);
      // sourceGet round-trips the patch
      expect(dal.sourceGet('greenhouse')?.enabled).toBe(0);
      expect(emitted.at(-1)).toMatchObject({ table: 'discovery_sources', op: 'update' });
    });

    it('derives the right id + kind for every board', () => {
      expect(dal.sourceUpsert('linkedin')).toMatchObject({ id: 'src_linkedin', kind: 'extension_scrape' });
      expect(dal.sourceUpsert('indeed')).toMatchObject({ id: 'src_indeed', kind: 'jobspy' });
      expect(dal.sourceUpsert('lever')).toMatchObject({ id: 'src_lever', kind: 'ats_board' });
      expect(dal.sourceUpsert('ashby')).toMatchObject({ id: 'src_ashby', kind: 'ats_board' });
      expect(dal.listSources().map((s) => s.board).sort()).toEqual(['ashby', 'indeed', 'lever', 'linkedin']);
    });

    it('clearing a breaker: a null in the patch sets the column NULL; an absent key leaves it', () => {
      dal.sourceUpsert('greenhouse', { cooldown_until: T + 1000, breaker_reason: 'rate_limited' });
      expect(dal.sourceGet('greenhouse')?.cooldown_until).toBe(T + 1000);
      // patch that omits cooldown_until must NOT wipe it
      dal.sourceUpsert('greenhouse', { last_tick_at: T + 10 });
      expect(dal.sourceGet('greenhouse')?.cooldown_until).toBe(T + 1000);
      // explicit null clears it
      dal.sourceUpsert('greenhouse', { cooldown_until: null, breaker_reason: null });
      expect(dal.sourceGet('greenhouse')?.cooldown_until).toBeNull();
      expect(dal.sourceGet('greenhouse')?.breaker_reason).toBeNull();
    });
  });

  describe('tokens: seeding + due rotation', () => {
    it('seedTokens inserts once (ON CONFLICT DO NOTHING on re-seed)', () => {
      const list = [
        { ats: 'greenhouse' as const, token: 'acme' },
        { ats: 'lever' as const, token: 'globex' },
      ];
      expect(dal.seedTokens(list)).toBe(2);
      expect(dal.seedTokens(list)).toBe(0); // idempotent
    });

    it('tokensDue returns least-recently-scanned first, scoped to the ats, active only', () => {
      clock = T + 1;
      const a = dal.tokenUpsert({ ats: 'greenhouse', token: 'a' });
      clock = T + 2;
      const b = dal.tokenUpsert({ ats: 'greenhouse', token: 'b' });
      clock = T + 3;
      dal.tokenUpsert({ ats: 'greenhouse', token: 'c' });
      clock = T + 4;
      dal.tokenUpsert({ ats: 'lever', token: 'x' }); // different ats — must not appear

      // all never-scanned → created_at ASC order
      expect(dal.tokensDue('greenhouse', 10).map((t) => t.token)).toEqual(['a', 'b', 'c']);
      expect(dal.tokensDue('lever', 10).map((t) => t.token)).toEqual(['x']);

      // scanning 'a' pushes it to the back (it now has the newest last_scan_at)
      clock = T + 100;
      dal.tokenScanned(a.id, { yielded: true });
      expect(dal.tokensDue('greenhouse', 10).map((t) => t.token)).toEqual(['b', 'c', 'a']);

      // limit is honored
      expect(dal.tokensDue('greenhouse', 2).map((t) => t.token)).toEqual(['b', 'c']);
      void b;
    });

    it('a yield resets dead_count + stamps last_yield_at; a dry scan increments dead_count', () => {
      const t = dal.tokenUpsert({ ats: 'greenhouse', token: 'z' });
      clock = T + 10;
      dal.tokenScanned(t.id, { yielded: false });
      dal.tokenScanned(t.id, { yielded: false });
      const row = db.prepare('SELECT dead_count, last_yield_at, last_scan_at FROM company_tokens WHERE id = ?').get(t.id) as { dead_count: number; last_yield_at: number | null; last_scan_at: number };
      expect(row.dead_count).toBe(2);
      expect(row.last_yield_at).toBeNull();
      expect(row.last_scan_at).toBe(T + 10);

      clock = T + 20;
      dal.tokenScanned(t.id, { yielded: true });
      const row2 = db.prepare('SELECT dead_count, last_yield_at FROM company_tokens WHERE id = ?').get(t.id) as { dead_count: number; last_yield_at: number | null };
      expect(row2.dead_count).toBe(0);
      expect(row2.last_yield_at).toBe(T + 20);
    });

    it('auto-retires a token after 5 consecutive dead scans (drops out of tokensDue)', () => {
      const t = dal.tokenUpsert({ ats: 'greenhouse', token: 'dead' });
      for (let i = 0; i < 5; i++) dal.tokenScanned(t.id, { yielded: false });
      const row = db.prepare('SELECT active, dead_count FROM company_tokens WHERE id = ?').get(t.id) as { active: number; dead_count: number };
      expect(row.active).toBe(0);
      expect(row.dead_count).toBe(5);
      expect(dal.tokensDue('greenhouse', 10)).toHaveLength(0);
    });
  });

  describe('recordBatch: the zero-yield guard', () => {
    beforeEach(() => dal.sourceUpsert('greenhouse'));

    it('records an ok batch with found > 0 and emits a discovery_batches insert', () => {
      const before = emitted.length;
      const batch = dal.recordBatch({ sourceId: 'src_gh', status: 'ok', found: 3, accepted: 2, duplicate: 1 });
      expect(batch.id).toBeGreaterThan(0);
      expect(batch.found_count).toBe(3);
      expect(batch.accepted_count).toBe(2);
      expect(emitted.slice(before).some((e) => e.table === 'discovery_batches' && e.op === 'insert')).toBe(true);
    });

    it('THROWS on a zero-yield ok batch and writes nothing', () => {
      expect(() => dal.recordBatch({ sourceId: 'src_gh', status: 'ok', found: 0 })).toThrow(/zero-yield/);
      expect((db.prepare('SELECT COUNT(*) c FROM discovery_batches').get() as { c: number }).c).toBe(0);
    });

    it('allows a rate_limited / error batch with found_count 0 (a breaker trip is worth one row)', () => {
      expect(() => dal.recordBatch({ sourceId: 'src_gh', status: 'rate_limited', error: 'HTTP 429' })).not.toThrow();
      expect(() => dal.recordBatch({ sourceId: 'src_gh', status: 'error', error: 'boom' })).not.toThrow();
      expect((db.prepare('SELECT COUNT(*) c FROM discovery_batches').get() as { c: number }).c).toBe(2);
    });
  });

  describe('recordSighting: PK-dedup', () => {
    it('inserts once then bumps last_seen_at + seen_count on re-sight (one row per job+source)', () => {
      seedJob(db, 'job_1');
      dal.sourceUpsert('greenhouse');

      clock = T + 1;
      dal.recordSighting({ jobId: 'job_1', sourceId: 'src_gh', applyCapability: 'ats_form', rawUrl: 'https://x/1' });
      clock = T + 2;
      dal.recordSighting({ jobId: 'job_1', sourceId: 'src_gh', applyCapability: 'ats_form', rawUrl: 'https://x/1' });

      const rows = db.prepare('SELECT first_seen_at, last_seen_at, seen_count FROM job_sightings WHERE job_id = ? AND source_id = ?').all('job_1', 'src_gh') as { first_seen_at: number; last_seen_at: number; seen_count: number }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ first_seen_at: T + 1, last_seen_at: T + 2, seen_count: 2 });
    });
  });

  describe('stats', () => {
    it('rolls up per lane: token counts, 24h batch sums, and sighting totals', () => {
      dal.sourceUpsert('greenhouse');
      dal.tokenUpsert({ ats: 'greenhouse', token: 'a' });
      dal.tokenUpsert({ ats: 'greenhouse', token: 'b' });
      dal.recordBatch({ sourceId: 'src_gh', status: 'ok', found: 4, accepted: 3 });
      seedJob(db, 'job_1');
      dal.recordSighting({ jobId: 'job_1', sourceId: 'src_gh' });

      const gh = dal.stats().find((l) => l.board === 'greenhouse');
      expect(gh).toMatchObject({
        source_id: 'src_gh',
        kind: 'ats_board',
        enabled: true,
        tokens_total: 2,
        tokens_active: 2,
        batches_24h: 1,
        found_24h: 4,
        accepted_24h: 3,
        sightings_total: 1,
      });
    });
  });
});
