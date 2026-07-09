// discovery — the ATS fetch/parse/gate layer (ats.ts) + the lane service (service.ts). The parse tests
// pin each board's JSON shape → normalized posting; the gate tests pin the keyword + Canada/remote gates;
// the service tests drive runOnce with a FAKE fetch (canned JSON, no network) and assert it upserts the
// right jobs, records a batch ONLY on a yield, skips an empty board with NO batch row, and — the headline
// anti-starvation property — a rate-limited lane trips its OWN breaker without stopping the other lanes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { makeDiscoveryDal, type DiscoveryDal } from '../../app/src/main/db/dal/discovery.js';
import { makeDiscoveryService } from '../../app/src/main/discovery/service.js';
import {
  normalizeAtsRecord,
  parseBoard,
  applyGates,
  titleMatchesKeywords,
  locationEligible,
  boardUrl,
  type Ats,
  type AtsPosting,
  type FetchImpl,
} from '../../app/src/main/discovery/ats.js';

const fakeSealer: Sealer = { available: () => true, seal: (p) => Buffer.from(p), open: (b) => Buffer.from(b).toString() };

// ---- a full AtsPosting with overridable fields (for the pure gate tests) ----------------------------
function posting(over: Partial<AtsPosting> = {}): AtsPosting {
  return {
    source: 'greenhouse',
    external_id: 'greenhouse:1',
    title: 'Software Engineer',
    company: 'acme',
    location: '',
    work_mode: null,
    job_url: 'https://x/1',
    apply_capability: 'ats_form',
    employment_type: null,
    description: '',
    posted_at: null,
    remote: false,
    ...over,
  };
}

// ---- fake fetch: route the built URL → canned JSON keyed by `<ats>:<token>` --------------------------
interface Canned {
  status?: number;
  data: unknown;
}
function makeFakeFetch(canned: Record<string, Canned>): FetchImpl {
  return async (url: string) => {
    let key = '';
    let m: RegExpExecArray | null;
    if ((m = /boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\//.exec(url))) key = `greenhouse:${decodeURIComponent(m[1]!)}`;
    else if ((m = /api\.lever\.co\/v0\/postings\/([^?]+)/.exec(url))) key = `lever:${decodeURIComponent(m[1]!)}`;
    else if ((m = /posting-api\/job-board\/([^?]+)/.exec(url))) key = `ashby:${decodeURIComponent(m[1]!)}`;
    const hit = canned[key];
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const status = hit.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => hit.data };
  };
}

describe('ats.ts — endpoints', () => {
  it('builds the three public board URLs', () => {
    expect(boardUrl('greenhouse', 'acme')).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true');
    expect(boardUrl('lever', 'globex')).toBe('https://api.lever.co/v0/postings/globex?mode=json');
    expect(boardUrl('ashby', 'notion')).toBe('https://api.ashbyhq.com/posting-api/job-board/notion?includeCompensation=true');
  });
});

describe('ats.ts — normalizeAtsRecord (per-board JSON → posting)', () => {
  it('greenhouse: maps id/url/title/location, strips HTML, detects remote, → ats_form', () => {
    const p = normalizeAtsRecord(
      { id: 55, absolute_url: 'https://boards.greenhouse.io/acme/jobs/55', title: 'Data Engineer', location: { name: 'Remote - Canada' }, content: '<p>Hi</p><script>evil()</script>', updated_at: '2026-01-02T00:00:00Z' },
      'greenhouse',
      'acme',
    )!;
    expect(p.source).toBe('greenhouse');
    expect(p.external_id).toBe('greenhouse:55');
    expect(p.job_url).toBe('https://boards.greenhouse.io/acme/jobs/55');
    expect(p.company).toBe('acme');
    expect(p.description).toBe('Hi'); // script + tags stripped
    expect(p.work_mode).toBe('remote');
    expect(p.apply_capability).toBe('ats_form');
    expect(p.posted_at).toBe(Date.parse('2026-01-02T00:00:00Z'));
  });

  it('lever: uses hostedUrl + text, keeps commitment as employment_type, createdAt is already epoch-ms', () => {
    const p = normalizeAtsRecord(
      { id: 'lv9', hostedUrl: 'https://jobs.lever.co/globex/lv9', text: 'Backend Engineer', categories: { location: 'Berlin', commitment: 'Full-time' }, descriptionPlain: 'plain desc', createdAt: 1735689600000 },
      'lever',
      'globex',
    )!;
    expect(p.external_id).toBe('lever:lv9');
    expect(p.job_url).toBe('https://jobs.lever.co/globex/lv9');
    expect(p.location).toBe('Berlin');
    expect(p.work_mode).toBeNull(); // Berlin, not remote
    expect(p.employment_type).toBe('Full-time');
    expect(p.posted_at).toBe(1735689600000);
  });

  it('ashby: uses jobUrl + title, isRemote drives work_mode, employmentType kept', () => {
    const p = normalizeAtsRecord(
      { id: 'as3', jobUrl: 'https://jobs.ashbyhq.com/notion/as3', title: 'ML Engineer', location: 'New York', isRemote: true, employmentType: 'FullTime', descriptionPlain: 'd', publishedAt: '2026-03-01T00:00:00Z' },
      'ashby',
      'notion',
    )!;
    expect(p.external_id).toBe('ashby:as3');
    expect(p.work_mode).toBe('remote'); // isRemote true even though "New York" isn't a remote string
    expect(p.employment_type).toBe('FullTime');
  });

  it('returns null for a record missing the id/url/title identity trio', () => {
    expect(normalizeAtsRecord({ id: 1 }, 'greenhouse', 'x')).toBeNull();
    expect(normalizeAtsRecord(null, 'lever', 'x')).toBeNull();
  });

  it('parseBoard drops malformed records', () => {
    const parsed = parseBoard(
      [
        { id: 1, absolute_url: 'https://b/1', title: 'Engineer' },
        { id: 2 }, // malformed → dropped
      ],
      'greenhouse',
      'acme',
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.external_id).toBe('greenhouse:1');
  });
});

describe('ats.ts — gates', () => {
  it('titleMatchesKeywords: any-of match, empty list keeps all', () => {
    expect(titleMatchesKeywords('Senior Software Engineer', ['engineer'])).toBe(true);
    expect(titleMatchesKeywords('Marketing Manager', ['engineer', 'developer'])).toBe(false);
    expect(titleMatchesKeywords('anything', [])).toBe(true);
  });

  it('locationEligible: local match, foreign reject, generic-remote pass, foreign-remote reject', () => {
    expect(locationEligible(posting({ location: 'Toronto, ON, Canada' }), [], 'Canada')).toBe(true);
    expect(locationEligible(posting({ location: 'San Francisco, CA' }), [], 'Canada')).toBe(false);
    expect(locationEligible(posting({ location: 'Remote', remote: true }), [], 'Canada')).toBe(true);
    expect(locationEligible(posting({ location: 'United States - Remote', remote: true }), [], 'Canada')).toBe(false);
    expect(locationEligible(posting({ location: 'anywhere on earth' }), [], '')).toBe(true); // no terms → keep all
  });

  it('applyGates runs BOTH gates', () => {
    const list = [
      posting({ title: 'Software Engineer', location: 'Toronto, Canada' }), // keep
      posting({ title: 'Software Engineer', location: 'Paris, France' }), // location fail
      posting({ title: 'Sales Lead', location: 'Toronto, Canada' }), // keyword fail
    ];
    const kept = applyGates(list, { keywords: ['engineer'], country: 'Canada' });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.location).toBe('Toronto, Canada');
  });
});

describe('discovery service — runOnce with a fake fetch', () => {
  let db: Database;
  let dal: Dal;
  let discoveryDal: DiscoveryDal;
  let clock: number;
  const T = 1_700_000_000_000;

  const GH_ACME = {
    jobs: [
      { id: 101, absolute_url: 'https://boards.greenhouse.io/acme/jobs/101', title: 'Senior Software Engineer', location: { name: 'Toronto, ON, Canada' }, content: '<p>Role</p>', updated_at: '2026-01-01T00:00:00Z' },
      { id: 102, absolute_url: 'https://boards.greenhouse.io/acme/jobs/102', title: 'Software Engineer', location: { name: 'San Francisco, CA' }, content: '<p>Role</p>' }, // location fail
      { id: 103, absolute_url: 'https://boards.greenhouse.io/acme/jobs/103', title: 'Marketing Manager', location: { name: 'Toronto, ON, Canada' }, content: '<p>Role</p>' }, // keyword fail
    ],
  };
  const LEVER_GLOBEX = [
    { id: 'lv1', hostedUrl: 'https://jobs.lever.co/globex/lv1', text: 'Backend Engineer', categories: { location: 'Remote', commitment: 'Full-time' }, descriptionPlain: 'desc', createdAt: 1735689600000 },
  ];

  function boot(canned: Record<string, Canned>, seeds: { ats: Ats; token: string }[]) {
    ({ db } = openDatabase({ file: ':memory:' }));
    clock = T;
    dal = makeDal({ ...defaultContext(db), now: () => clock }, { sealer: fakeSealer });
    discoveryDal = makeDiscoveryDal(dal.ctx);
    dal.settings.set('autoApply', 'keywords', ['engineer']);
    dal.settings.set('autoApply', 'country', 'Canada');
    return makeDiscoveryService({
      dal,
      discoveryDal,
      fetchImpl: makeFakeFetch(canned),
      now: () => clock,
      spacingMs: 0,
      seedTokens: seeds,
    });
  }

  afterEach(() => db.close());

  it('upserts the gated jobs, records a batch per yielding token, and records NO batch for an empty board', async () => {
    const svc = boot(
      { 'greenhouse:acme': { data: GH_ACME }, 'greenhouse:empty-co': { data: { jobs: [] } }, 'lever:globex': { data: LEVER_GLOBEX } },
      [
        { ats: 'greenhouse', token: 'acme' },
        { ats: 'greenhouse', token: 'empty-co' },
        { ats: 'lever', token: 'globex' },
      ],
    );

    const res = await svc.runOnce();

    // jobs: only the two gate-passing postings (gh 101 + lever lv1) were upserted
    expect(dal.jobs.listLean({ limit: 100 }).total).toBe(2);
    const urls = dal.jobs.listLean({ limit: 100 }).rows.map((r) => r.job_url).sort();
    expect(urls).toEqual(['https://boards.greenhouse.io/acme/jobs/101', 'https://jobs.lever.co/globex/lv1']);
    // every upserted job is an ats_form posting
    expect(dal.jobs.listLean({ limit: 100 }).rows.every((r) => r.apply_capability === 'ats_form')).toBe(true);

    // batches: exactly two 'ok' rows (acme + globex). empty-co yielded nothing → NO row.
    const batches = db.prepare('SELECT keyword, status, found_count FROM discovery_batches ORDER BY keyword').all() as { keyword: string; status: string; found_count: number }[];
    expect(batches).toEqual([
      { keyword: 'acme', status: 'ok', found_count: 1 },
      { keyword: 'globex', status: 'ok', found_count: 1 },
    ]);
    expect((db.prepare("SELECT COUNT(*) c FROM discovery_batches WHERE keyword = 'empty-co'").get() as { c: number }).c).toBe(0);

    // sightings: one per upserted job
    expect((db.prepare('SELECT COUNT(*) c FROM job_sightings').get() as { c: number }).c).toBe(2);

    // lane results: greenhouse scanned both tokens (acme + empty-co) but found only from acme
    const gh = res.lanes.find((l) => l.ats === 'greenhouse')!;
    expect(gh.scanned).toBe(2);
    expect(gh.found).toBe(1);
    expect(gh.accepted).toBe(1);
    const lv = res.lanes.find((l) => l.ats === 'lever')!;
    expect(lv).toMatchObject({ scanned: 1, found: 1, accepted: 1 });
    // ashby lane created but has no tokens → a clean no-op
    expect(res.lanes.find((l) => l.ats === 'ashby')).toMatchObject({ scanned: 0, found: 0 });

    // empty-co bumped its dead_count (a dry scan is a dead scan)
    expect((db.prepare("SELECT dead_count FROM company_tokens WHERE token = 'empty-co'").get() as { dead_count: number }).dead_count).toBe(1);
  });

  it('is idempotent: a second runOnce re-sights (seen_count++) and dedups jobs (no new inserts)', async () => {
    const svc = boot({ 'greenhouse:acme': { data: GH_ACME } }, [{ ats: 'greenhouse', token: 'acme' }]);
    await svc.runOnce();
    clock = T + 1000;
    const res2 = await svc.runOnce();

    expect(dal.jobs.listLean({ limit: 100 }).total).toBe(1); // still one job
    const gh = res2.lanes.find((l) => l.ats === 'greenhouse')!;
    expect(gh.accepted).toBe(0); // nothing new
    expect(gh.duplicate).toBe(1); // re-sighted
    const sighting = db.prepare('SELECT seen_count FROM job_sightings LIMIT 1').get() as { seen_count: number };
    expect(sighting.seen_count).toBe(2);
  });

  it('a rate-limited lane trips its OWN breaker and does not stop the others (anti-starvation)', async () => {
    const svc = boot(
      { 'greenhouse:acme': { data: GH_ACME }, 'lever:rl': { status: 429, data: {} } },
      [
        { ats: 'greenhouse', token: 'acme' },
        { ats: 'lever', token: 'rl' },
      ],
    );

    const res1 = await svc.runOnce();
    // greenhouse still produced its job despite lever being rate-limited
    expect(res1.lanes.find((l) => l.ats === 'greenhouse')?.found).toBe(1);
    // lever tripped its breaker
    const lever = discoveryDal.sourceGet('lever')!;
    expect(lever.cooldown_until).toBe(T + 30 * 60 * 1000);
    expect(lever.breaker_reason).toMatch(/rate_limited/);
    expect((db.prepare("SELECT COUNT(*) c FROM discovery_batches WHERE status = 'rate_limited'").get() as { c: number }).c).toBe(1);

    // second immediate run: lever is skipped (breaker still open) but greenhouse keeps working
    const res2 = await svc.runOnce();
    expect(res2.lanes.find((l) => l.ats === 'lever')?.skipped).toBe('cooldown');
    expect(res2.lanes.find((l) => l.ats === 'greenhouse')?.scanned).toBe(1);
    // breaker was NOT cleared by greenhouse's clean pass
    expect(discoveryDal.sourceGet('lever')?.cooldown_until).toBe(T + 30 * 60 * 1000);
  });
});
