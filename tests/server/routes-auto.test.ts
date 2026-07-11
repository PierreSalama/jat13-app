// Stage-3 mission-control route tests (server/routes-auto.ts). Three jobs:
//   1. CONTRACT: every route mountAutoRoutes adds answers the canonical envelope (walked route table,
//      same independent inline schema as envelope.test.ts) + inherits the token guard.
//   2. ENGINE SURFACE: start/stop/state/queue delegate to the run-service; discovery status/run to the
//      discovery service — a fake of each records its calls (the real engine files are siblings the
//      integrator wires).
//   3. STATE-CHANGING routes against the REAL schema-v1 DB + REAL Stage-1 DAL (makeDal): settings
//      read/write (the auto-apply + discovery registry, proving the schema.ts merge is live), the
//      permanent job dismiss (jobs.dismissed_at + dismissals keys), the needs_human→parked wall skip.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Database as DB } from 'better-sqlite3';
import type { Hono } from 'hono';
import { createApp } from '../../app/src/main/server/index.js';
import { mountApi } from '../../app/src/main/server/api.js';
import {
  mountAutoRoutes,
  type AutoDal,
  type AutoRunService,
  type AutoState,
  type AutoQueue,
  type DiscoveryService,
  type DiscoveryStatus,
} from '../../app/src/main/server/routes-auto.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { openDatabase } from '../../app/src/main/db/index.js';
import { IDENTITY } from '@jat13/shared';

const VERSION = '13.3.0';
const TOKEN = 'tok-routes-auto';

const fakeSealer: Sealer = {
  available: () => true,
  seal: (p) => Buffer.from(`sealed:${p}`, 'utf8'),
  open: (b) => b.toString('utf8').replace(/^sealed:/, ''),
};

// ---------------------------------------------------------------------------------------------
// canonical envelope (independent of @jat13/shared — no rubber-stamping)
// ---------------------------------------------------------------------------------------------
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const ErrorShape = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, 'error.code must be snake_case'),
    message: z.string().min(1),
  })
  .strict();

const EnvelopeSchema = z
  .discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
    z.object({ ok: z.literal(false), error: ErrorShape }).strict(),
  ])
  .superRefine((env, ctx) => {
    if (!env.ok) return;
    if (!Object.hasOwn(env, 'data')) { ctx.addIssue({ code: 'custom', message: 'ok envelope must carry a "data" key' }); return; }
    const d = (env as { data: unknown }).data;
    if (isRecord(d) && 'ok' in d && ('data' in d || 'error' in d)) ctx.addIssue({ code: 'custom', message: 'data is itself an envelope (double wrap)' });
  });

// ---------------------------------------------------------------------------------------------
// fixture: real migrated schema-v1 DB + a seeded slice
// ---------------------------------------------------------------------------------------------
function seed(db: DB): void {
  const t = Date.now() - 60_000;
  db.prepare(`INSERT INTO profiles (id, name, is_default, data_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run('prof_1', 'Pierre', 1, '{}', t, t);

  db.prepare(
    `INSERT INTO jobs (id, source, title, company, company_key, location, job_url, job_url_norm, norm_key,
                       apply_capability, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (@id,@src,@title,@co,@ck,@loc,@url,@urln,@nk,@cap,@t,@t,@t,@t)`,
  ).run({ id: 'job_1', src: 'linkedin', title: 'Not A Real Job — spammy page', co: 'Spammy Inc', ck: 'spammy inc', loc: 'Remote', url: 'https://example.com/x', urln: 'example.com/x', nk: 'k1', cap: 'unknown', t });

  db.prepare(`INSERT INTO applications (id, job_id, profile_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run('app_1', 'job_1', 'prof_1', 'tracked', t, t);

  const insRun = db.prepare(
    `INSERT INTO apply_runs (id, application_id, job_id, profile_id, source, lane, state, park_kind, park_detail,
                             pending_questions_json, steps_count, queued_at, updated_at)
     VALUES (@id,@app,@job,@prof,@src,@lane,@state,@pk,@pd,'[]',0,@t,@t)`,
  );
  insRun.run({ id: 'run_wall', app: 'app_1', job: 'job_1', prof: 'prof_1', src: 'linkedin', lane: 'linkedin', state: 'needs_human', pk: 'captcha', pd: 'captcha wall', t });
  insRun.run({ id: 'run_done', app: 'app_1', job: 'job_1', prof: 'prof_1', src: 'linkedin', lane: 'linkedin', state: 'failed', pk: null, pd: null, t });
}

// permanent-dismiss test impl (real SQL is fine in a test — the grep-gate covers app/src only). Mirrors
// the ingest agent's dal.dismissals.dismiss: stamp jobs.dismissed_at + write the dismissal KEYS, and
// return null for an unknown job id (the route maps null → 404).
function makeTestDismissalsDal(db: DB): AutoDal['dismissals'] {
  return {
    dismiss(jobId, opts) {
      const job = db.prepare('SELECT id, norm_key, job_url_norm, company_key FROM jobs WHERE id = ?').get(jobId) as
        | { id: string; norm_key: string; job_url_norm: string; company_key: string }
        | undefined;
      if (!job) return null;
      const now = Date.now();
      db.prepare('UPDATE jobs SET dismissed_at = ? WHERE id = ?').run(now, jobId);
      const keys = [`nk:${job.norm_key}`, `url:${job.job_url_norm}`, `co:${job.company_key}`].filter((k) => k.length > 3);
      const ins = db.prepare('INSERT OR IGNORE INTO dismissals (dismiss_key, job_id, reason, note, dismissed_at) VALUES (?,?,?,?,?)');
      for (const k of keys) ins.run(k, jobId, opts.reason ?? 'user', (opts.note ?? null) as string | null, now);
      return { dismissed: true, jobId, keys, reason: (opts.reason ?? 'user') as string };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// fakes for the engine services
// ---------------------------------------------------------------------------------------------
interface Fakes {
  runService: AutoRunService;
  discovery: DiscoveryService;
  calls: { start: number; stop: number; runOnce: number };
}
function makeFakes(): Fakes {
  const calls = { start: 0, stop: 0, runOnce: 0 };
  let running = false;
  const state: AutoState = {
    running: false,
    lanes: [
      { lane: 'linkedin', queued: 3, inflight: 1, submittedToday: 12, parkedToday: 2, failedToday: 1, skippedToday: 4, cap: 45, capRemaining: 33, breaker: null },
      { lane: 'indeed', queued: 0, inflight: 0, submittedToday: 0, cap: null, breaker: 'rate_limited' },
    ],
  };
  const queue: AutoQueue = {
    upcoming: [{ jobId: 'job_1', title: 'Senior TS', company: 'Acme', lane: 'linkedin', source: 'linkedin', fit: 82, reasons: ['title match', 'remote'] }],
    skipped: [{ jobId: 'job_x', title: 'Sales Rep', company: 'Globex', fit: 12, floor: 30, reason: 'below_fit_floor' }],
  };
  const disco: DiscoveryStatus = {
    enabled: true,
    sources: [{ id: 'src_linkedin', board: 'linkedin', kind: 'jobspy', enabled: true, lastTickAt: Date.now(), yield: 7, freshnessHours: 72, saturation: 0.25, breaker: null, cooldownUntil: null }],
  };
  const runService: AutoRunService = {
    start() { calls.start += 1; running = true; state.running = true; },
    stop() { calls.stop += 1; running = false; state.running = false; },
    state() { return { ...state, running }; },
    queue() { return queue; },
  };
  const discovery: DiscoveryService = {
    status() { return disco; },
    runOnce() { calls.runOnce += 1; },
  };
  return { runService, discovery, calls };
}

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------
interface Harness { app: Hono; db: DB; dal: Dal; fakes: Fakes; }
function makeHarness(): Harness {
  const { db } = openDatabase({ file: ':memory:' });
  seed(db);
  const dal = makeDal(defaultContext(db), { sealer: fakeSealer });
  const fakes = makeFakes();
  const autoDal: AutoDal = { settings: dal.settings, runs: dal.runs, dismissals: makeTestDismissalsDal(db) };

  const app = createApp({
    db,
    version: VERSION,
    startedAt: Date.now(),
    dev: true,
    mount: (a) =>
      mountApi(a, {
        db,
        token: TOKEN,
        version: VERSION,
        startedAt: Date.now(),
        extend: (api) => mountAutoRoutes(api, { dal: autoDal, runService: fakes.runService, discovery: fakes.discovery }),
      }),
  });
  return { app, db, dal, fakes };
}

async function call(app: Hono, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { [IDENTITY.authHeader]: TOKEN };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  return app.request(path, init);
}
async function okData<T>(res: Response): Promise<T> {
  const env = (await res.json()) as { ok: boolean; data?: T };
  expect(env.ok, `expected ok envelope, got ${JSON.stringify(env).slice(0, 300)}`).toBe(true);
  return env.data as T;
}
async function errBody(res: Response): Promise<{ code: string; message: string }> {
  const env = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
  expect(env.ok).toBe(false);
  return env.error;
}
function count(db: DB, sql: string, ...bind: unknown[]): number {
  return (db.prepare(sql).get(...bind) as { c: number }).c;
}

// ---------------------------------------------------------------------------------------------
// 1. contract
// ---------------------------------------------------------------------------------------------
describe('Stage-3 auto routes — envelope contract', () => {
  const AUTO_ROUTES = [
    'POST /api/auto/start',
    'POST /api/auto/stop',
    'GET /api/auto/state',
    'GET /api/auto/queue',
    'GET /api/discovery/status',
    'POST /api/discovery/run',
    'GET /api/settings',
    'PUT /api/settings/:pair',
    'POST /api/runs/:id/dismiss',
    'POST /api/jobs/:id/dismiss',
  ];

  function walkable(app: Hono): Array<{ method: string; path: string }> {
    const seen = new Set<string>();
    const out: Array<{ method: string; path: string }> = [];
    for (const r of app.routes) {
      if (!r.path.startsWith('/api') || r.method === 'ALL' || r.path.includes('*')) continue;
      const key = `${r.method} ${r.path}`;
      if (!seen.has(key)) { seen.add(key); out.push({ method: r.method, path: r.path }); }
    }
    return out;
  }

  it('every declared Stage-3 route is actually mounted', () => {
    const keys = walkable(makeHarness().app).map((r) => `${r.method} ${r.path}`);
    expect(keys).toEqual(expect.arrayContaining(AUTO_ROUTES));
  });

  it('every mounted auto route answers the canonical envelope', async () => {
    const { app } = makeHarness();
    for (const r of walkable(app)) {
      const path = r.path.replace(/:[A-Za-z0-9_]+/g, 'x-walk-id');
      const res = await call(app, r.method, path, r.method === 'GET' ? undefined : {});
      const label = `${r.method} ${path} → ${res.status}`;
      expect(res.headers.get('content-type') ?? '', label).toContain('application/json');
      const parsed = EnvelopeSchema.safeParse(await res.json());
      expect(parsed.success, `${label} — ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });

  it('inherits the token guard: unauthenticated → enveloped 401', async () => {
    const { app } = makeHarness();
    for (const path of ['/api/auto/state', '/api/discovery/status', '/api/settings']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    }
  });

  it('a throwing service answers an enveloped 500, never a bare error page', async () => {
    const h = makeHarness();
    h.fakes.runService.queue = () => { throw new Error('boom in queue()'); };
    const res = await call(h.app, 'GET', '/api/auto/queue');
    expect(res.status).toBe(500);
    const e = await errBody(res);
    expect(e.code).toBe('internal');
    expect(e.message).toContain('boom');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. supervised scheduler + discovery surface
// ---------------------------------------------------------------------------------------------
describe('supervised auto-apply: start / stop / state / queue', () => {
  it('start → running:true (delegates to runService.start); stop → running:false', async () => {
    const h = makeHarness();
    const started = await okData<AutoState>(await call(h.app, 'POST', '/api/auto/start', {}));
    expect(started.running).toBe(true);
    expect(h.fakes.calls.start).toBe(1);

    const stopped = await okData<AutoState>(await call(h.app, 'POST', '/api/auto/stop', {}));
    expect(stopped.running).toBe(false);
    expect(h.fakes.calls.stop).toBe(1);
  });

  it('state exposes per-lane pacing/caps/breakers', async () => {
    const { app } = makeHarness();
    const s = await okData<AutoState>(await call(app, 'GET', '/api/auto/state'));
    expect(s.lanes.map((l) => l.lane)).toEqual(['linkedin', 'indeed']);
    expect(s.lanes[0]!.submittedToday).toBe(12);
    expect(s.lanes[0]!.capRemaining).toBe(33);
    expect(s.lanes[1]!.breaker).toBe('rate_limited');
  });

  it('queue exposes the fit-ordered upcoming + the skip-floor decisions with reasons', async () => {
    const { app } = makeHarness();
    const q = await okData<AutoQueue>(await call(app, 'GET', '/api/auto/queue'));
    expect(q.upcoming[0]!.fit).toBe(82);
    expect(q.upcoming[0]!.reasons).toContain('title match');
    expect(q.skipped[0]!.reason).toBe('below_fit_floor');
    expect(q.skipped[0]!.floor).toBe(30);
  });
});

describe('discovery: status + manual sweep', () => {
  it('status lists per-source yield/freshness/saturation/breaker', async () => {
    const { app } = makeHarness();
    const d = await okData<DiscoveryStatus>(await call(app, 'GET', '/api/discovery/status'));
    expect(d.sources[0]!.board).toBe('linkedin');
    expect(d.sources[0]!.yield).toBe(7);
    expect(d.sources[0]!.freshnessHours).toBe(72);
  });

  it('run kicks ONE sweep (fire-and-forget) and returns immediately', async () => {
    const h = makeHarness();
    const r = await okData<{ started: boolean }>(await call(h.app, 'POST', '/api/discovery/run', {}));
    expect(r.started).toBe(true);
    expect(h.fakes.calls.runOnce).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. settings — the auto-apply + discovery config cards' read/write surface
// ---------------------------------------------------------------------------------------------
describe('settings read/write (proves the schema.ts registry merge is live)', () => {
  it('GET /settings carries the permissive auto-apply + discovery defaults', async () => {
    const { app } = makeHarness();
    const all = await okData<Record<string, Record<string, unknown>>>(await call(app, 'GET', '/api/settings'));
    expect(all.autoApply).toBeTruthy();
    expect(all.autoApply!.fitFloor).toBe(30);
    expect(all.autoApply!.country).toBe('Canada');
    expect(all.autoApply!.seniorityMax).toBe('mid');
    expect(all.autoApply!.maxPerDay).toBe(120);
    expect(all.autoApply!.easyApplyOnly).toBe(true);
    expect(all.discovery!.enabled).toBe(true);
    expect(all.discovery!.freshnessHours).toBe(72);
  });

  it('PUT /settings/<section>.<key> validates then persists ONE knob', async () => {
    const h = makeHarness();
    const res = await okData<{ section: string; key: string; value: unknown }>(
      await call(h.app, 'PUT', '/api/settings/autoApply.maxPerDay', { value: 90 }),
    );
    expect(res).toEqual({ section: 'autoApply', key: 'maxPerDay', value: 90 });
    expect(h.dal.settings.getKey('autoApply', 'maxPerDay')).toBe(90);

    // a string[] knob round-trips as an array
    await call(h.app, 'PUT', '/api/settings/autoApply.keywords', { value: ['typescript', 'backend'] });
    expect(h.dal.settings.getKey('autoApply', 'keywords')).toEqual(['typescript', 'backend']);
  });

  it('rejects a bad type / unknown key / malformed pair / missing value with a 400', async () => {
    const h = makeHarness();
    expect((await errBody(await call(h.app, 'PUT', '/api/settings/autoApply.fitFloor', { value: 'high' }))).code).toBe('bad_setting');
    expect((await errBody(await call(h.app, 'PUT', '/api/settings/autoApply.nope', { value: 1 }))).code).toBe('bad_setting');
    expect((await errBody(await call(h.app, 'PUT', '/api/settings/nodot', { value: 1 }))).code).toBe('bad_request');
    expect((await errBody(await call(h.app, 'PUT', '/api/settings/autoApply.maxPerDay', {}))).code).toBe('bad_request');
    // nothing persisted from the rejected writes
    expect(h.dal.settings.getKey('autoApply', 'fitFloor')).toBe(30);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. permanent dismiss — the 2026-07-10 scar (a dismissed posting can never return)
// ---------------------------------------------------------------------------------------------
describe('POST /jobs/:id/dismiss — permanent block', () => {
  it('sets jobs.dismissed_at AND writes the dismissal keys, then reports dismissed', async () => {
    const h = makeHarness();
    const r = await okData<{ id: string; dismissed: boolean; reason: string }>(
      await call(h.app, 'POST', '/api/jobs/job_1/dismiss', { reason: 'not_a_job', note: 'this is not a posting' }),
    );
    expect(r).toEqual({ id: 'job_1', dismissed: true, reason: 'not_a_job' });
    expect(count(h.db, `SELECT COUNT(*) AS c FROM jobs WHERE id = 'job_1' AND dismissed_at IS NOT NULL`)).toBe(1);
    // keyed by norm_key / url_norm / company_key so a re-post under a fresh row still resolves dismissed.
    expect(count(h.db, `SELECT COUNT(*) AS c FROM dismissals WHERE job_id = 'job_1'`)).toBe(3);
    expect(count(h.db, `SELECT COUNT(*) AS c FROM dismissals WHERE dismiss_key = 'nk:k1' AND reason = 'not_a_job'`)).toBe(1);
  });

  it('unknown job → 404; unknown reason → 400 (loud, never a silent user)', async () => {
    const h = makeHarness();
    expect((await call(h.app, 'POST', '/api/jobs/nope/dismiss', {})).status).toBe(404);
    expect((await errBody(await call(h.app, 'POST', '/api/jobs/job_1/dismiss', { reason: 'bogus' }))).code).toBe('bad_reason');
  });
});

// ---------------------------------------------------------------------------------------------
// 5. needs-you wall skip — needs_human → parked (the §8 hygiene edge)
// ---------------------------------------------------------------------------------------------
describe('POST /runs/:id/dismiss — skip a wall the engine cannot clear', () => {
  it('moves a needs_human run to parked (FSM-legal dismissed-or-stale edge)', async () => {
    const h = makeHarness();
    const r = await okData<{ id: string; state: string }>(await call(h.app, 'POST', '/api/runs/run_wall/dismiss'));
    expect(r.state).toBe('parked');
    expect((h.db.prepare(`SELECT state FROM apply_runs WHERE id = 'run_wall'`).get() as { state: string }).state).toBe('parked');
  });

  it('refuses a non-needs_human run (409) and an unknown run (404)', async () => {
    const h = makeHarness();
    expect((await call(h.app, 'POST', '/api/runs/run_done/dismiss')).status).toBe(409);
    expect((await call(h.app, 'POST', '/api/runs/nope/dismiss')).status).toBe(404);
  });
});
