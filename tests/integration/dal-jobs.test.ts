// jobs DAL — behavior + guard paths. The v11 failure this whole module exists to prevent is the same
// posting forking into many rows, so the CENTER of these tests is dedup: insert then re-see by the same
// job_url must UPDATE, not insert. Plus the payload-discipline invariants (list never ships description,
// oversized description is truncated not rejected) that the schema CHECK would otherwise turn into a crash.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { defaultContext } from '../../app/src/main/db/dal/util.js';
import type { DomainEvent } from '../../app/src/main/db/dal/util.js';
import { makeJobsDal } from '../../app/src/main/db/dal/jobs.js';

describe('jobs DAL', () => {
  let db: Database;
  let events: DomainEvent[];
  let dal: ReturnType<typeof makeJobsDal>;
  let clock: number;

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    events = [];
    clock = 1_700_000_000_000;
    // deterministic clock + capturing emit, but keep the real newId (ULID) from defaultContext.
    const base = defaultContext(db, (e) => events.push(e));
    dal = makeJobsDal({ ...base, now: () => clock });
  });
  afterEach(() => db.close());

  it('inserts a new posting and writes both jobs + job_details in one shot', () => {
    const res = dal.upsert({
      source: 'linkedin',
      job_url: 'https://www.linkedin.com/jobs/view/12345',
      title: 'Senior Engineer',
      company: 'Acme Corp',
      description: 'Build things.',
      fit: { score: 88, reasons: ['match'] },
    });
    expect(res.action).toBe('inserted');
    expect(res.job.title).toBe('Senior Engineer');
    expect(res.job.company_key).toBe('acme corp');
    // detail row exists and is retrievable
    const detail = dal.getDetail(res.job.id);
    expect(detail?.description).toBe('Build things.');
    expect(detail?.fit).toEqual({ score: 88, reasons: ['match'] });
    // emitted an insert event carrying the lean row (never a "refetch" signal)
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ table: 'jobs', op: 'insert', id: res.job.id });
    expect(events[0]?.patch).not.toHaveProperty('description');
  });

  it('DEDUPES: re-seeing the same job_url UPDATES the existing row (no second row)', () => {
    const first = dal.upsert({
      source: 'linkedin',
      job_url: 'https://www.linkedin.com/jobs/view/999?ref=feed',
      title: 'Backend Dev',
      company: 'Globex',
      description: 'v1',
    });
    expect(first.action).toBe('inserted');

    clock += 60_000;
    // same posting, URL differs only by a tracking param normJobUrl drops → must match & UPDATE.
    const second = dal.upsert({
      source: 'linkedin',
      job_url: 'https://www.linkedin.com/jobs/view/999?ref=email&utm_source=x',
      title: 'Backend Developer', // refreshed mutable field
      company: 'Globex',
      description: 'v2',
    });
    expect(second.action).toBe('updated');
    expect(second.job.id).toBe(first.job.id); // SAME row
    expect(second.job.title).toBe('Backend Developer');
    expect(second.job.last_seen_at).toBe(clock); // bumped
    expect(second.job.first_seen_at).toBe(first.job.first_seen_at); // preserved

    // exactly one jobs row total
    const count = (db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c;
    expect(count).toBe(1);
    // description was refreshed in the same tx
    expect(dal.getDetail(first.job.id)?.description).toBe('v2');
  });

  it('DEDUPES by norm_key even when the URL differs entirely (same company+title)', () => {
    const a = dal.upsert({
      source: 'greenhouse',
      job_url: 'https://boards.greenhouse.io/acme/jobs/1',
      title: 'Data Scientist',
      company: 'Initech',
    });
    const b = dal.upsert({
      source: 'greenhouse',
      job_url: 'https://boards.greenhouse.io/acme/jobs/2-different-url',
      title: 'Data  Scientist', // extra space folds via normKey
      company: 'INITECH',
    });
    expect(b.action).toBe('updated');
    expect(b.job.id).toBe(a.job.id);
    expect((db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c).toBe(1);
  });

  it('a bare re-sighting (source+url only) PRESERVES title/company/company_key/tags/description', () => {
    const first = dal.upsert({
      source: 'linkedin',
      job_url: 'https://www.linkedin.com/jobs/view/555',
      title: 'Staff Engineer',
      company: 'Umbrella Corp',
      tags: ['keep', 'me'],
      description: 'the full posting text',
    });
    clock += 1000;
    // A list-view "seen again": the source only knows source + url this time.
    const again = dal.upsert({
      source: 'linkedin',
      job_url: 'https://www.linkedin.com/jobs/view/555?utm=x',
    });
    expect(again.action).toBe('updated');
    expect(again.job.id).toBe(first.job.id);
    expect(again.job.title).toBe('Staff Engineer'); // NOT blanked
    expect(again.job.company).toBe('Umbrella Corp'); // NOT blanked
    expect(again.job.company_key).toBe('umbrella corp'); // NOT recomputed to ''
    expect(again.job.tags).toEqual(['keep', 'me']); // NOT reset to []
    // and the heavy description survives the bare re-sighting
    expect(dal.getDetail(first.job.id)?.description).toBe('the full posting text');
  });

  it('an explicit empty tags array on re-sighting DOES clear tags (undefined preserves, [] overwrites)', () => {
    const first = dal.upsert({
      source: 'linkedin', job_url: 'https://x/tagclear', title: 'T', company: 'C', tags: ['x'],
    });
    const cleared = dal.upsert({
      source: 'linkedin', job_url: 'https://x/tagclear', title: 'T', company: 'C', tags: [],
    });
    expect(cleared.job.tags).toEqual([]);
  });

  it('listLean NEVER returns a description and respects filters/paging', () => {
    dal.upsert({ source: 'linkedin', job_url: 'https://x/1', title: 'Alpha', company: 'One', description: 'D1' });
    clock += 1000;
    dal.upsert({ source: 'indeed', job_url: 'https://x/2', title: 'Beta', company: 'Two', description: 'D2' });
    clock += 1000;
    dal.upsert({ source: 'linkedin', job_url: 'https://x/3', title: 'Gamma', company: 'Three', description: 'D3' });

    const page = dal.listLean({ limit: 500 });
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(3);
    // ordered by updated_at DESC (Gamma most recent)
    expect(page.rows[0]?.title).toBe('Gamma');
    // structurally cannot carry a description (assert the property is absent — a substring scan of
    // JSON.stringify(r) is unsafe because the random ULID id can itself contain the probe string).
    for (const r of page.rows) {
      expect(r).not.toHaveProperty('description');
      expect(r).not.toHaveProperty('fit');
      expect(Object.values(r)).not.toContain('D1');
    }

    // source filter
    const li = dal.listLean({ source: 'linkedin' });
    expect(li.total).toBe(2);
    expect(li.rows.every((r) => r.source === 'linkedin')).toBe(true);

    // q filters over title+company
    const q = dal.listLean({ q: 'Beta' });
    expect(q.total).toBe(1);
    expect(q.rows[0]?.title).toBe('Beta');
  });

  it('listLean q escapes LIKE wildcards (a literal % is not a wildcard)', () => {
    dal.upsert({ source: 'linkedin', job_url: 'https://x/a', title: 'Plain', company: 'Co' });
    dal.upsert({ source: 'linkedin', job_url: 'https://x/b', title: '50% remote', company: 'Co' });
    const res = dal.listLean({ q: '50%' });
    expect(res.total).toBe(1);
    expect(res.rows[0]?.title).toBe('50% remote');
  });

  it('getDetail returns the description; returns undefined for a missing id', () => {
    const j = dal.upsert({ source: 'linkedin', job_url: 'https://x/z', title: 'Z', company: 'Zed', description: 'full text here' });
    expect(dal.getDetail(j.job.id)?.description).toBe('full text here');
    expect(dal.getDetail('job_does_not_exist')).toBeUndefined();
  });

  it('TRUNCATES an oversized description instead of rejecting it (CHECK cap is 262144)', () => {
    const huge = 'x'.repeat(300_000);
    const res = dal.upsert({ source: 'linkedin', job_url: 'https://x/huge', title: 'Big', company: 'Cap', description: huge });
    expect(res.action).toBe('inserted'); // did NOT throw
    const stored = dal.getDetail(res.job.id)!.description;
    expect(stored.length).toBeLessThanOrEqual(262144);
    expect(stored.endsWith('…[truncated]')).toBe(true);
    // and the DB actually accepted it (round-trips through the CHECK)
    const raw = db.prepare('SELECT length(description) n FROM job_details WHERE job_id=?').get(res.job.id) as { n: number };
    expect(raw.n).toBeLessThanOrEqual(262144);
  });

  it('patch whitelists mutable columns, bumps updated_at, emits; ignores unknown fields', () => {
    const j = dal.upsert({ source: 'linkedin', job_url: 'https://x/p', title: 'Old', company: 'Co' });
    events.length = 0;
    clock += 5000;
    const patched = dal.patch(j.job.id, {
      title: 'New Title',
      apply_capability: 'easy_apply',
      posting_state: 'stale',
      tags: ['a', 'b'],
    });
    expect(patched?.title).toBe('New Title');
    expect(patched?.apply_capability).toBe('easy_apply');
    expect(patched?.posting_state).toBe('stale');
    expect(patched?.tags).toEqual(['a', 'b']);
    expect(patched?.updated_at).toBe(clock);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ table: 'jobs', op: 'update', id: j.job.id });
  });

  it('patch on a non-existent id returns undefined and emits nothing', () => {
    events.length = 0;
    expect(dal.patch('job_nope', { title: 'x' })).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('patch with no whitelisted fields is a no-op read (no write, no event)', () => {
    const j = dal.upsert({ source: 'linkedin', job_url: 'https://x/noop', title: 'Keep', company: 'Co' });
    const before = dal.getDetail(j.job.id)!.updated_at;
    events.length = 0;
    clock += 9999;
    const res = dal.patch(j.job.id, { /* nothing patchable */ } as never);
    expect(res?.title).toBe('Keep');
    expect(res?.updated_at).toBe(before); // untouched
    expect(events).toHaveLength(0);
  });

  it('markSeen bumps last_seen_at, forces posting_state=active, sets capability when given', () => {
    const j = dal.upsert({ source: 'linkedin', job_url: 'https://x/s', title: 'S', company: 'Co', posting_state: 'stale' });
    events.length = 0;
    clock += 3000;
    const seen = dal.markSeen(j.job.id, { capability: 'smartapply' });
    expect(seen?.last_seen_at).toBe(clock);
    expect(seen?.posting_state).toBe('active'); // revived
    expect(seen?.apply_capability).toBe('smartapply');
    expect(events).toHaveLength(1);

    // without a capability, the existing capability is preserved
    const again = dal.markSeen(j.job.id, {});
    expect(again?.apply_capability).toBe('smartapply');
  });

  it('markSeen on a missing id returns undefined', () => {
    expect(dal.markSeen('job_nope', { capability: 'external' })).toBeUndefined();
  });

  it('does not string-concatenate values — a quote in title/company is stored verbatim', () => {
    const evil = `O'Brien "Corp" -- ; DROP TABLE jobs`;
    const j = dal.upsert({ source: 'linkedin', job_url: 'https://x/inj', title: evil, company: evil });
    expect(j.job.title).toBe(evil);
    // table still exists and the value round-trips
    const back = dal.getDetail(j.job.id);
    expect(back?.title).toBe(evil);
    expect((db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c).toBe(1);
  });
});
