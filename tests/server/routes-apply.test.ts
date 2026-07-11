// Stage-2 APPLY + LEARN route tests. Three jobs:
//   1. CONTRACT: every route mountApplyRoutes / mountLearnApi adds answers the canonical envelope
//      (walked route table, same independent inline schema as envelope.test.ts).
//   2. BEHAVIOR: the "Apply now" spine (delegates to runService.applyOne + returns {runId}), the
//      Needs-You enrichment shape, the answer→learn→requeue loop (incl. the sensitive DROP), the
//      autopsy reads — exercised against the REAL schema-v1 DB + the REAL Stage-1 DAL (makeDal), with
//      a fake run-service that records its calls (the real engine run-service is a sibling Stage-2
//      file the integrator wires) and a small autopsies shim (the ONE DAL module Stage 1 didn't ship).
//   3. LEARN: /learn/observe ingests a non-sensitive answer and DROPS redacted + sensitive-label ones.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Database as DB } from 'better-sqlite3';
import type { Hono } from 'hono';
import { createApp } from '../../app/src/main/server/index.js';
import { mountApi } from '../../app/src/main/server/api.js';
import {
  mountApplyRoutes,
  type ApplyDal,
  type ApplyRunService,
  type ApplyState,
} from '../../app/src/main/server/routes-apply.js';
import { mountLearnApi } from '../../app/src/main/learn/index.js';
import { makeLearnDistiller } from '../../app/src/main/learn/distiller.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { openDatabase } from '../../app/src/main/db/index.js';
import { IDENTITY } from '@jat13/shared';

const VERSION = '13.2.0';
const TOKEN = 'tok-routes-apply';
const authed = { headers: { [IDENTITY.authHeader]: TOKEN } };

/** Reversible fake — vitest has no Electron safeStorage; the DAL treats sealed bytes as opaque. */
const fakeSealer: Sealer = {
  available: () => true,
  seal: (p) => Buffer.from(`sealed:${p}`, 'utf8'),
  open: (b) => b.toString('utf8').replace(/^sealed:/, ''),
};

// ---------------------------------------------------------------------------------------------
// canonical envelope, written from the spec (independent of @jat13/shared — no rubber-stamping)
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
    if (!Object.hasOwn(env, 'data')) {
      ctx.addIssue({ code: 'custom', message: 'ok envelope must carry a "data" key' });
      return;
    }
    const d = (env as { data: unknown }).data;
    if (isRecord(d) && 'ok' in d && ('data' in d || 'error' in d)) {
      ctx.addIssue({ code: 'custom', message: 'data is itself an envelope (double wrap)' });
    }
  });

// ---------------------------------------------------------------------------------------------
// fixture: real migrated schema-v1 DB + a seeded slice of Pierre's world
// ---------------------------------------------------------------------------------------------
function seed(db: DB): void {
  const t = Date.now() - 60_000;

  db.prepare(
    `INSERT INTO profiles (id, name, is_default, data_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  ).run('prof_1', 'Pierre', 1, JSON.stringify({ first_name: 'Pierre' }), t, t);

  const insJob = db.prepare(
    `INSERT INTO jobs (id, source, title, company, company_key, location, job_url, job_url_norm,
                       norm_key, apply_capability, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (@id,@source,@title,@company,@ck,@loc,@url,@urln,@nk,@cap,@t,@t,@t,@t)`,
  );
  insJob.run({ id: 'job_1', source: 'linkedin', title: 'Senior TypeScript Engineer', company: 'Acme Corp', ck: 'acme corp', loc: 'Montreal, QC', url: 'https://linkedin.com/jobs/view/1/apply', urln: 'linkedin.com/jobs/view/1/apply', nk: 'k1', cap: 'easy_apply', t });
  insJob.run({ id: 'job_2', source: 'indeed', title: 'Rust Developer', company: 'Globex', ck: 'globex', loc: 'Remote', url: 'https://smartapply.indeed.com/2', urln: 'smartapply.indeed.com/2', nk: 'k2', cap: 'smartapply', t });

  // the "Apply now" target (Saved/tracked, never applied) + the run home for the needs-you fixtures.
  db.prepare(
    `INSERT INTO applications (id, job_id, profile_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  ).run('app_1', 'job_1', 'prof_1', 'tracked', t, t);
  db.prepare(
    `INSERT INTO applications (id, job_id, profile_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  ).run('app_2', 'job_2', 'prof_1', 'tracked', t, t);

  const insRun = db.prepare(
    `INSERT INTO apply_runs (id, application_id, job_id, profile_id, source, lane, state, park_kind,
                             park_detail, pending_questions_json, steps_count, queued_at, updated_at)
     VALUES (@id,@app,@job,@prof,@src,@lane,@state,@pk,@pd,@pq,@sc,@t,@t)`,
  );
  insRun.run({
    id: 'run_nh', app: 'app_1', job: 'job_1', prof: 'prof_1', src: 'linkedin', lane: 'linkedin',
    state: 'needs_human', pk: 'needs_answer', pd: '2 questions need you',
    pq: JSON.stringify([{ label: 'Years of experience?', keyNorm: 'experience_years' }]),
    sc: 2, t,
  });
  insRun.run({
    id: 'run_rr', app: 'app_2', job: 'job_2', prof: 'prof_1', src: 'indeed', lane: 'indeed',
    state: 'ready_for_review', pk: null, pd: null, pq: '[]', sc: 3, t: t + 10,
  });
  insRun.run({
    id: 'run_f', app: 'app_1', job: 'job_1', prof: 'prof_1', src: 'linkedin', lane: 'linkedin',
    state: 'failed', pk: null, pd: null, pq: '[]', sc: 1, t: t + 20,
  });

  const insStep = db.prepare(
    `INSERT INTO apply_run_steps (run_id, seq, at, phase, action, ok) VALUES (?,?,?,?,?,1)`,
  );
  insStep.run('run_nh', 1, t, 'classify', 'form_page');
  insStep.run('run_nh', 2, t + 1, 'detect', 'found_questions');

  db.prepare(
    `INSERT INTO autopsies (id, run_id, application_id, job_id, lane, final_state, summary, signature, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run('autopsy_1', 'run_f', 'app_1', 'job_1', 'linkedin', 'failed', 'Advance stayed disabled past the watchdog TTL.', 'linkedin|advance_disabled', t + 25);
}

// ---------------------------------------------------------------------------------------------
// autopsies shim — the ONE DAL module Stage 1 didn't ship; the integrator wires a real one that
// satisfies ApplyDal['autopsies']. Real SQL is fine in a test file (the grep-gate covers app/src only).
// ---------------------------------------------------------------------------------------------
function makeTestAutopsies(db: DB): ApplyDal['autopsies'] {
  return {
    listRecent(opts = {}) {
      const limit = opts.limit ?? 100;
      const offset = opts.offset ?? 0;
      const rows = db
        .prepare(
          `SELECT id, run_id, application_id, job_id, lane, final_state, park_kind, signature,
                  proposal_state, created_at
           FROM autopsies ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset);
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM autopsies`).get() as { c: number }).c;
      return { rows, total };
    },
    get(id) {
      return db.prepare(`SELECT * FROM autopsies WHERE id = ?`).get(id) as unknown;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// fake run-service — records its calls; applyOne SIMULATES the enqueue (inserts a queued run) so the
// route→service→enqueue path is provable end-to-end; requeue does the needs_human→queued transition.
// ---------------------------------------------------------------------------------------------
interface FakeRunService {
  svc: ApplyRunService;
  calls: { applyOne: string[]; stop: number; requeue: string[] };
}
function makeFakeRunService(db: DB): FakeRunService {
  const calls: FakeRunService['calls'] = { applyOne: [], stop: 0, requeue: [] };
  let running = false;
  let activeRun: unknown = null;
  let seq = 0;

  const svc: ApplyRunService = {
    applyOne(applicationId) {
      calls.applyOne.push(applicationId);
      const row = db
        .prepare(
          `SELECT a.job_id AS job_id, a.profile_id AS profile_id, j.source AS source
           FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
        )
        .get(applicationId) as { job_id: string; profile_id: string; source: string } | undefined;
      if (!row) throw new Error(`no such application: ${applicationId}`);
      const runId = `run_new_${++seq}`;
      const now = Date.now();
      db.prepare(
        `INSERT INTO apply_runs (id, application_id, job_id, profile_id, source, lane, state, queued_at, updated_at)
         VALUES (?,?,?,?,?,?, 'queued', ?, ?)`,
      ).run(runId, applicationId, row.job_id, row.profile_id, row.source, 'linkedin', now, now);
      running = true;
      activeRun = { id: runId, state: 'queued' };
      return { runId };
    },
    stop() {
      calls.stop += 1;
      running = false;
      activeRun = null;
    },
    state(): ApplyState {
      return { running, activeRun };
    },
    requeue(runId) {
      calls.requeue.push(runId);
      const info = db
        .prepare(`UPDATE apply_runs SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'needs_human'`)
        .run(Date.now(), runId);
      return info.changes > 0;
    },
  };
  return { svc, calls };
}

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------
interface Harness {
  app: Hono;
  db: DB;
  dal: Dal;
  applyDal: ApplyDal;
  runService: FakeRunService;
}
function makeHarness(opts: { seed?: boolean } = {}): Harness {
  const { db } = openDatabase({ file: ':memory:' });
  if (opts.seed !== false) seed(db);

  const dal = makeDal(defaultContext(db), { sealer: fakeSealer });
  const applyDal: ApplyDal = {
    runs: dal.runs,
    jobs: dal.jobs,
    answers: dal.answers,
    profiles: dal.profiles,
    autopsies: makeTestAutopsies(db),
  };
  const runService = makeFakeRunService(db);
  const distiller = makeLearnDistiller({ dal });

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
        extend: (api) => {
          mountApplyRoutes(api, { dal: applyDal, runService: runService.svc });
          mountLearnApi(api, dal, distiller);
        },
      }),
  });

  return { app, db, dal, applyDal, runService };
}

async function call(app: Hono, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { [IDENTITY.authHeader]: TOKEN };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
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
// 1. contract: the walked route table
// ---------------------------------------------------------------------------------------------
describe('Stage-2 apply/learn routes — envelope contract', () => {
  const APPLY_ROUTES = [
    'POST /api/apply/one',
    'POST /api/apply/stop',
    'GET /api/apply/state',
    'GET /api/runs/:id/steps',
    'GET /api/needs-you',
    'POST /api/answers',
    'GET /api/autopsies',
    'GET /api/autopsies/:id',
    'GET /api/learn/config',
    'POST /api/learn/observe',
  ];

  function walkable(app: Hono): Array<{ method: string; path: string }> {
    const seen = new Set<string>();
    const out: Array<{ method: string; path: string }> = [];
    for (const r of app.routes) {
      if (!r.path.startsWith('/api') || r.method === 'ALL' || r.path.includes('*')) continue;
      const key = `${r.method} ${r.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ method: r.method, path: r.path });
      }
    }
    return out;
  }

  it('every declared Stage-2 route is actually mounted (no vacuous walk)', () => {
    const keys = walkable(makeHarness().app).map((r) => `${r.method} ${r.path}`);
    expect(keys).toEqual(expect.arrayContaining(APPLY_ROUTES));
  });

  it('every mounted apply/learn route answers JSON that parses as the canonical envelope', async () => {
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
    for (const path of ['/api/needs-you', '/api/apply/state', '/api/autopsies']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    }
  });

  it('a throwing DAL answers an enveloped 500, never Hono\'s bare error page', async () => {
    const h = makeHarness();
    h.applyDal.runs.listLean = () => {
      throw new Error('no such table: apply_runs (simulated storage failure)');
    };
    const res = await call(h.app, 'GET', '/api/needs-you');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const e = await errBody(res);
    expect(e.code).toBe('internal');
    expect(e.message).toContain('no such table');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. apply spine
// ---------------------------------------------------------------------------------------------
describe('POST /api/apply/one — the "Apply now" spine', () => {
  it('delegates to runService.applyOne and returns the created {runId} (enqueue happened)', async () => {
    const h = makeHarness();
    const before = count(h.db, `SELECT COUNT(*) AS c FROM apply_runs WHERE state = 'queued'`);

    const data = await okData<{ runId: string }>(await call(h.app, 'POST', '/api/apply/one', { applicationId: 'app_1' }));
    expect(data.runId).toBe('run_new_1');
    expect(h.runService.calls.applyOne).toEqual(['app_1']);

    // the fake service enqueued a real queued run for app_1 — the route→service→enqueue path is whole.
    const after = count(h.db, `SELECT COUNT(*) AS c FROM apply_runs WHERE state = 'queued'`);
    expect(after).toBe(before + 1);
    expect(count(h.db, `SELECT COUNT(*) AS c FROM apply_runs WHERE id = 'run_new_1' AND application_id = 'app_1'`)).toBe(1);
  });

  it('validates applicationId BEFORE touching the service (bad body → enveloped 400)', async () => {
    const h = makeHarness();
    const res = await call(h.app, 'POST', '/api/apply/one', {});
    expect(res.status).toBe(400);
    expect((await errBody(res)).code).toBe('bad_request');
    expect(h.runService.calls.applyOne).toEqual([]);
  });
});

describe('GET /api/apply/state + POST /api/apply/stop', () => {
  it('reports {running, activeRun}: idle → after apply → after stop', async () => {
    const h = makeHarness();
    const idle = await okData<ApplyState>(await call(h.app, 'GET', '/api/apply/state'));
    expect(idle).toEqual({ running: false, activeRun: null });

    await call(h.app, 'POST', '/api/apply/one', { applicationId: 'app_1' });
    const busy = await okData<{ running: boolean; activeRun: { id: string } }>(await call(h.app, 'GET', '/api/apply/state'));
    expect(busy.running).toBe(true);
    expect(busy.activeRun.id).toBe('run_new_1');

    await okData<{ running: boolean }>(await call(h.app, 'POST', '/api/apply/stop', {}));
    expect(h.runService.calls.stop).toBe(1);
    const stopped = await okData<ApplyState>(await call(h.app, 'GET', '/api/apply/state'));
    expect(stopped).toEqual({ running: false, activeRun: null });
  });
});

describe('GET /api/runs/:id/steps', () => {
  it('returns the ring-capped step transcript for a run', async () => {
    const { app } = makeHarness();
    const data = await okData<{ steps: Array<{ seq: number; phase: string }> }>(
      await call(app, 'GET', '/api/runs/run_nh/steps'),
    );
    expect(data.steps).toHaveLength(2);
    expect(data.steps.map((s) => s.phase)).toEqual(['classify', 'detect']);
    const empty = await okData<{ steps: unknown[] }>(await call(app, 'GET', '/api/runs/run_nope/steps'));
    expect(empty.steps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. needs-you enrichment
// ---------------------------------------------------------------------------------------------
describe('GET /api/needs-you — the human queue, enriched', () => {
  it('enriches each needs_human run with park kind/detail, the pending questions, and job title+company', async () => {
    const { app } = makeHarness();
    const data = await okData<{
      needsHuman: Array<{
        id: string; park_kind: string | null; park_detail: string | null;
        questions: Array<{ label: string }>; job_title: string | null; company: string | null;
      }>;
      readyForReview: Array<{ id: string }>;
    }>(await call(app, 'GET', '/api/needs-you'));

    expect(data.needsHuman).toHaveLength(1);
    const nh = data.needsHuman[0]!;
    expect(nh.id).toBe('run_nh');
    expect(nh.park_kind).toBe('needs_answer');
    expect(nh.park_detail).toBe('2 questions need you');
    expect(nh.questions).toHaveLength(1);
    expect(nh.questions[0]!.label).toBe('Years of experience?');
    expect(nh.job_title).toBe('Senior TypeScript Engineer');
    expect(nh.company).toBe('Acme Corp');

    // the quarantined-submit review lane rides the same payload.
    expect(data.readyForReview.map((r) => r.id)).toEqual(['run_rr']);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. answer → learn (user, locked) → requeue
// ---------------------------------------------------------------------------------------------
describe('POST /api/answers — save the human answer + requeue the run', () => {
  it('saves as provenance=user + locked, then requeues the needs_human run (needs_human → queued)', async () => {
    const h = makeHarness();
    const data = await okData<{ saved: boolean; answerId: string | null; requeued: boolean }>(
      await call(h.app, 'POST', '/api/answers', {
        runId: 'run_nh',
        question: 'Years of experience?',
        keyNorm: 'experience_years',
        value: '8',
      }),
    );
    expect(data.saved).toBe(true);
    expect(data.answerId).toBeTruthy();
    expect(data.requeued).toBe(true);
    expect(h.runService.calls.requeue).toEqual(['run_nh']);

    const row = h.db
      .prepare(`SELECT value, provenance, locked FROM learned_answers WHERE profile_id = 'prof_1' AND key_norm = 'experience_years'`)
      .get() as { value: string; provenance: string; locked: number };
    expect(row).toEqual({ value: '8', provenance: 'user', locked: 1 });

    // the run actually moved out of needs_human.
    const state = (h.db.prepare(`SELECT state FROM apply_runs WHERE id = 'run_nh'`).get() as { state: string }).state;
    expect(state).toBe('queued');
  });

  it('DROPS a sensitive answer (saved:false, nothing stored) and never requeues without a runId', async () => {
    const h = makeHarness();
    const data = await okData<{ saved: boolean; answerId: string | null; requeued: boolean }>(
      await call(h.app, 'POST', '/api/answers', { question: 'What is your gender?', value: 'prefer not to say' }),
    );
    expect(data.saved).toBe(false); // isSensitiveKey → DAL returns null → nothing persisted
    expect(data.answerId).toBeNull();
    expect(data.requeued).toBe(false);
    expect(count(h.db, `SELECT COUNT(*) AS c FROM learned_answers WHERE key_norm = 'gender'`)).toBe(0);
    expect(h.runService.calls.requeue).toEqual([]);
  });

  it('validates: missing question / non-string value → enveloped 400', async () => {
    const h = makeHarness();
    expect((await call(h.app, 'POST', '/api/answers', { value: '8' })).status).toBe(400);
    expect((await call(h.app, 'POST', '/api/answers', { question: 'Q?' })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. autopsies
// ---------------------------------------------------------------------------------------------
describe('GET /api/autopsies (+/:id)', () => {
  it('lists recent post-mortems and reads one by id; unknown id → 404', async () => {
    const { app } = makeHarness();
    const page = await okData<{ rows: Array<{ id: string }>; total: number }>(await call(app, 'GET', '/api/autopsies'));
    expect(page.total).toBe(1);
    expect(page.rows[0]!.id).toBe('autopsy_1');

    const one = await okData<{ id: string; run_id: string; final_state: string }>(
      await call(app, 'GET', '/api/autopsies/autopsy_1'),
    );
    expect(one.run_id).toBe('run_f');
    expect(one.final_state).toBe('failed');

    const missing = await call(app, 'GET', '/api/autopsies/autopsy_nope');
    expect(missing.status).toBe(404);
    expect((await errBody(missing)).code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------------------------
// 6. learn/observe + learn/config (watch-and-learn uplink, enveloped)
// ---------------------------------------------------------------------------------------------
describe('learn API', () => {
  it('GET /api/learn/config returns enabled (ON by default) + the apply-host patterns', async () => {
    const { app } = makeHarness();
    const cfg = await okData<{ enabled: boolean; applyHosts: Array<{ host: string }> }>(
      await call(app, 'GET', '/api/learn/config'),
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.applyHosts.map((h) => h.host)).toContain('linkedin.com');
  });

  it('POST /api/learn/observe learns a non-sensitive answer and DROPS redacted + sensitive-label events', async () => {
    const h = makeHarness();
    const res = await okData<{ learned: number; dropped: number }>(
      await call(h.app, 'POST', '/api/learn/observe', {
        host: 'boards.greenhouse.io',
        url: 'https://boards.greenhouse.io/acme/jobs/1',
        events: [
          { kind: 'fill', label: 'Preferred start date?', fieldType: 'date', value: '2026-08-01' }, // learned
          { kind: 'choose', label: 'What is your gender?', fieldType: 'select', value: null, choice: null, redacted: true }, // dropped (redacted)
          { kind: 'fill', label: 'Your date of birth', fieldType: 'date', value: '1990-01-01' }, // dropped (sensitive LABEL — DAL belt)
          { kind: 'advance', label: 'Submit application' }, // ignored (transition marker)
        ],
      }),
    );
    expect(res.learned).toBe(1);
    expect(res.dropped).toBe(2);

    // exactly the one non-sensitive answer landed, as a harvested learned answer.
    expect(count(h.db, `SELECT COUNT(*) AS c FROM learned_answers`)).toBe(1);
    const row = h.db
      .prepare(`SELECT label, value, provenance FROM learned_answers WHERE profile_id = 'prof_1'`)
      .get() as { label: string; value: string; provenance: string };
    expect(row).toEqual({ label: 'Preferred start date?', value: '2026-08-01', provenance: 'harvest' });
    // neither the redacted gender nor the DOB reached the store.
    expect(count(h.db, `SELECT COUNT(*) AS c FROM learned_answers WHERE key_norm LIKE '%gender%' OR key_norm LIKE '%birth%'`)).toBe(0);
  });

  it('rejects a malformed batch with an enveloped 400', async () => {
    const { app } = makeHarness();
    const res = await call(app, 'POST', '/api/learn/observe', { nope: true });
    expect(res.status).toBe(400);
    expect((await errBody(res)).code).toBe('bad_batch');
  });
});
