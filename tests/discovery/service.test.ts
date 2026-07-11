// discovery service tests — the five-lane engine with its anti-starvation scars. Everything network- and
// subprocess-facing is injected (canned ATS JSON, a fake jobspy runner), so no real python or net is hit.
// Proven here: ATS lanes ingest + write yield-only telemetry; jobspy lanes ingest + ramp freshness; a
// jobspy env failure trips ONLY its lane's breaker (the ATS lanes keep supplying); the refill gate reads
// ONLY its own lane's depth (v11.83 — the ATS feed can never starve LinkedIn); dismissed postings stay dead.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { makeDiscoveryDal, type DiscoveryDal } from '../../app/src/main/db/dal/discovery.js';
import { makeDismissalsDal } from '../../app/src/main/db/dal/dismissals.js';
import { makeRegistry, loadBuiltins, type Registry } from '../../app/src/main/adapters/registry.js';
import { makeIngest, candidateKeys, type Ingest } from '../../app/src/main/discovery/ingest.js';
import type { FetchImpl, FetchResponse } from '../../app/src/main/discovery/ats-boards.js';
import type { JobSpyRunner, JobSpyResult } from '../../app/src/main/discovery/jobspy.js';
import {
  makeDiscoveryService,
  effectiveFreshTier,
  widerFreshTier,
  isComboSaturated,
  shouldSkipSaturatedCombo,
  plannerSlot,
  FRESH_BASE_SEC,
  FRESH_WIDEST_SEC,
  type DiscoveryConfig,
  type DiscoveryServiceDeps,
} from '../../app/src/main/discovery/service.js';

const fakeSealer: Sealer = { available: () => true, seal: (p) => Buffer.from(p), open: (b) => Buffer.from(b).toString() };

const CONFIG: DiscoveryConfig = {
  keywords: ['engineer'],
  locations: ['toronto'],
  country: 'Canada',
  easyApplyOnly: true,
  boards: ['linkedin', 'indeed'],
  remote: false,
  perRunLimit: 25,
  distanceMiles: 0,
  combosPerTick: 1,
  tokensPerTick: 10,
  refillBelow: 20,
  intervalMinutes: 15,
  enabled: true,
};

/** canned Greenhouse board for the `acme` token — one matching Toronto engineer role. */
const GREENHOUSE_BODY = {
  jobs: [
    { id: 42, absolute_url: 'https://boards.greenhouse.io/acme/jobs/42', title: 'Senior Engineer', location: { name: 'Toronto, ON, Canada' }, content: '<p>Build things</p>', updated_at: '2026-07-01' },
  ],
};

function jsonRes(body: unknown, status = 200): FetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
/** greenhouse → canned jobs; every other board/token → an empty board. */
const cannedGreenhouse: FetchImpl = (url) => Promise.resolve(url.includes('greenhouse') ? jsonRes(GREENHOUSE_BODY) : jsonRes({ jobs: [] }));
const emptyBoards: FetchImpl = () => Promise.resolve(jsonRes({ jobs: [] }));

const okJobSpy = (jobs: unknown[]): JobSpyRunner => ({
  run: async (req) => ({ ok: true, source: req.source, jobs: jobs as never[] } as JobSpyResult),
});
const failJobSpy = (reason: 'python_missing' | 'rate_limited' | 'timeout'): JobSpyRunner => ({
  run: async () => ({ ok: false, reason, error: `simulated ${reason}` }),
});
const LINKEDIN_JOBS = [
  { title: 'Frontend Engineer', company: 'Acme', location: 'Toronto, ON', job_url: 'https://www.linkedin.com/jobs/view/999', source: 'linkedin', description: '', posted_at: null, remote: false, employment_type: null, direct_job_url: null },
];

let db: Database;
let dal: Dal;
let discoveryDal: DiscoveryDal;
let registry: Registry;
let ingest: Ingest;

beforeEach(() => {
  ({ db } = openDatabase({ file: ':memory:' }));
  dal = makeDal(defaultContext(db), { sealer: fakeSealer });
  discoveryDal = makeDiscoveryDal(dal.ctx);
  registry = makeRegistry(loadBuiltins());
  ingest = makeIngest({ dal, discoveryDal, registry, dismissals: makeDismissalsDal(dal.ctx) });
});
afterEach(() => db.close());

function svc(over: Partial<DiscoveryServiceDeps> = {}, cfg: Partial<DiscoveryConfig> = {}) {
  return makeDiscoveryService({
    dal,
    discoveryDal,
    registry,
    ingest,
    seedTokens: [{ ats: 'greenhouse', token: 'acme' }],
    fetchImpl: cannedGreenhouse,
    jobspy: okJobSpy(LINKEDIN_JOBS),
    readConfig: () => ({ ...CONFIG, ...cfg }),
    ...over,
  });
}

function batches(sourceId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM discovery_batches WHERE source_id = ?').get(sourceId) as { c: number }).c;
}
function jobCount(): number {
  return (db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c;
}

describe('ATS lanes (greenhouse/lever/ashby via the JSON boards)', () => {
  it('ingests a gated posting, records ONE yield batch, a sighting, and marks the token yielded', async () => {
    const r = await svc().runLane('greenhouse');
    expect(r.accepted).toBe(1);
    expect(jobCount()).toBe(1);
    expect(batches('src_gh')).toBe(1);
    const sight = db.prepare('SELECT COUNT(*) c FROM job_sightings WHERE source_id = ?').get('src_gh') as { c: number };
    expect(sight.c).toBe(1);
    const tok = db.prepare('SELECT dead_count, last_yield_at FROM company_tokens WHERE ats = ?').get('greenhouse') as { dead_count: number; last_yield_at: number | null };
    expect(tok.dead_count).toBe(0);
    expect(tok.last_yield_at).not.toBeNull();
  });

  it('an empty scan writes NOTHING (yield-only) and bumps the token dead_count', async () => {
    const r = await svc({ fetchImpl: emptyBoards }).runLane('greenhouse');
    expect(r.found).toBe(0);
    expect(batches('src_gh')).toBe(0); // the yield-only law: no telemetry row for a dry scan
    const tok = db.prepare('SELECT dead_count FROM company_tokens WHERE ats = ?').get('greenhouse') as { dead_count: number };
    expect(tok.dead_count).toBe(1);
  });

  it('a 429 trips ONLY this lane and sets a cooldown breaker', async () => {
    const rateLimited: FetchImpl = () => Promise.resolve(jsonRes({}, 429));
    const s = svc({ fetchImpl: rateLimited });
    const r = await s.runLane('greenhouse');
    expect(r.breaker).toBeTruthy();
    const src = discoveryDal.sourceGet('greenhouse')!;
    expect(src.cooldown_until).not.toBeNull();
    expect(src.cooldown_until! > Date.now()).toBe(true);
    // the lane refuses to run again while the breaker is open.
    expect((await s.runLane('greenhouse')).skipped).toBe('cooldown');
  });
});

describe('JobSpy lanes (linkedin/indeed via the subprocess)', () => {
  it('ingests normalized postings and writes a yield batch', async () => {
    const r = await svc().runLane('linkedin');
    expect(r.accepted).toBe(1);
    expect(jobCount()).toBe(1);
    expect(batches('src_linkedin')).toBe(1);
  });

  it('a dry scan writes no batch and WIDENS the combo freshness tier one step', async () => {
    const s = svc({ jobspy: okJobSpy([]) }); // 0 jobs = dry
    await s.runLane('linkedin');
    expect(batches('src_linkedin')).toBe(0);
    const cursor = discoveryDal.sourceGet('linkedin')!.cursor as { combos?: Record<string, { tier: number }> };
    expect(cursor.combos?.['engineer|toronto']?.tier).toBe(widerFreshTier(FRESH_BASE_SEC)); // 72h → 7d
  });

  it('skips a lane the user did not enable in autoApply.boards', async () => {
    const r = await svc({}, { boards: ['indeed'] }).runLane('linkedin');
    expect(r.skipped).toBe('board_off');
  });
});

describe('lane independence — a jobspy env failure never starves the ATS feed', () => {
  it('python_missing trips ONLY the jobspy lanes; ATS still ingests in the same runOnce', async () => {
    const s = svc({ jobspy: failJobSpy('python_missing') });
    const res = await s.runOnce();
    const li = res.lanes.find((l) => l.board === 'linkedin')!;
    const gh = res.lanes.find((l) => l.board === 'greenhouse')!;
    expect(li.breaker).toContain('python_missing');
    expect(gh.accepted).toBe(1); // the ATS lane carried supply regardless
    // the linkedin breaker got a LONG (env) cooldown; greenhouse has none.
    expect(discoveryDal.sourceGet('linkedin')!.cooldown_until! > Date.now()).toBe(true);
    expect(discoveryDal.sourceGet('greenhouse')!.cooldown_until).toBeNull();
  });
});

describe('source-scoped refill gate (kills v11.83 — the shared gate that starved LinkedIn)', () => {
  it('a deep LinkedIn queue gates the LinkedIn lane but NOT the ATS lane', async () => {
    // seed one in-flight linkedin run so laneQueuedDepth('linkedin') = 1.
    db.prepare('INSERT INTO profiles (id,name,is_default,data_json,created_at,updated_at) VALUES (?,?,1,?,?,?)').run('p1', 'P', '{}', 1, 1);
    db.prepare('INSERT INTO jobs (id,source,title,company,job_url,norm_key,first_seen_at,last_seen_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('j1', 'linkedin', 'E', 'Co', 'https://www.linkedin.com/jobs/view/1', 'nk1', 1, 1, 1, 1);
    db.prepare('INSERT INTO applications (id,job_id,profile_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('a1', 'j1', 'p1', 'tracked', 1, 1);
    db.prepare("INSERT INTO apply_runs (id,application_id,job_id,profile_id,source,lane,state,mode,queued_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run('r1', 'a1', 'j1', 'p1', 'linkedin', 'linkedin', 'queued', 'auto', 1, 1);

    const s = svc({}, { refillBelow: 1 }); // refill when a lane's own depth < 1
    expect((await s.runLane('linkedin')).skipped).toBe('well_supplied'); // linkedin depth 1 >= 1 → gated
    expect((await s.runLane('greenhouse')).accepted).toBe(1); // ats lane depth 0 → runs (source-scoped!)
  });
});

describe('permanent dismiss reaches through discovery', () => {
  it('a dismissed posting is never re-created by a lane scan', async () => {
    // pre-seed the dismissal by the canned posting's normalized url (no job row exists yet).
    const keys = candidateKeys({ source: 'greenhouse', job_url: 'https://boards.greenhouse.io/acme/jobs/42', company: 'acme', title: 'Senior Engineer' });
    db.prepare("INSERT INTO dismissals (dismiss_key, job_id, reason, dismissed_at) VALUES (?, NULL, 'not_a_job', ?)").run('url:' + keys.urlNorm, Date.now());
    const r = await svc().runLane('greenhouse');
    expect(r.accepted).toBe(0);
    expect(jobCount()).toBe(0);
  });
});

describe('freshness ramp + saturation (pure helpers)', () => {
  it('a never-scanned combo starts at the 72h floor; a saturated one JUMPS to 30d', () => {
    const nowMs = 10 * FRESH_WIDEST_SEC * 1000;
    expect(effectiveFreshTier(null, 0, nowMs)).toBe(FRESH_BASE_SEC); // never scanned → newest-first
    // scanned, but no new accept within the window → jump straight to widest (never creep).
    expect(effectiveFreshTier(604_800, nowMs - 7 * 3600 * 1000, nowMs)).toBe(FRESH_WIDEST_SEC);
    // recently productive → keep the climbed tier.
    expect(effectiveFreshTier(604_800, nowMs - 60_000, nowMs)).toBe(604_800);
  });

  it('a saturated combo is down-weighted 3-of-4 visits (still runs on the 4th)', () => {
    expect(shouldSkipSaturatedCombo(true, 0)).toBe(true);
    expect(shouldSkipSaturatedCombo(true, 1)).toBe(true);
    expect(shouldSkipSaturatedCombo(true, 2)).toBe(true);
    expect(shouldSkipSaturatedCombo(true, 3)).toBe(false); // the 1-in-4 turn
    expect(shouldSkipSaturatedCombo(false, 99)).toBe(false); // non-saturated never skipped
  });

  it('isComboSaturated is true only when saturated on EVERY board; planner round-robins the whole space', () => {
    const getter = () => ({ storedSec: 604_800, lastNewAtMs: 0 }); // stale on every board
    expect(isComboSaturated(getter, ['linkedin'], 'a', 'b', 1)).toBe(true);
    expect(isComboSaturated(() => ({ storedSec: FRESH_BASE_SEC, lastNewAtMs: Date.now() }), ['linkedin'], 'a', 'b')).toBe(false);
    const p0 = plannerSlot(['a', 'b'], ['x', 'y'], 0)!;
    expect(p0).toMatchObject({ keyword: 'a', location: 'x', nextIndex: 1 });
    expect(plannerSlot(['a', 'b'], ['x', 'y'], 3)).toMatchObject({ keyword: 'b', location: 'y', nextIndex: 0 });
  });
});
