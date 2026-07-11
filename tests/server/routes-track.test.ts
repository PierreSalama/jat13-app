// Stage-3 TRACK + PERMANENT-DISMISS route tests — Pierre's #1 scar, proven end-to-end.
// Three jobs:
//   1. CONTRACT: every route mountTrackRoutes adds answers the canonical envelope (walked route table).
//   2. THE GATE: a non-job URL → { tracked:false, reason:'not_a_job' } and NO job/application row is
//      ever created (the v11 phantom-job scar).
//   3. PERMANENCE: track a job → dismiss it → re-track the SAME url → { tracked:false, reason:'dismissed' }
//      (all three identity keys written; the application withdrawn). A dismissed posting can NEVER return.
// Exercised against the REAL schema-v1+002 DB + the REAL jobs/applications/dismissals DALs, with a real
// ingest (jobs.upsert + applications.ensure — what the discovery agent's ingest does) and an injected
// job-gate (a fake host heuristic; the real isJobPosting lives in discovery/ingest.ts).
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Database as DB } from 'better-sqlite3';
import type { Hono } from 'hono';
import { createApp } from '../../app/src/main/server/index.js';
import { mountApi } from '../../app/src/main/server/api.js';
import {
  mountTrackRoutes,
  type TrackDal,
  type JobGate,
  type IngestFn,
} from '../../app/src/main/server/routes-track.js';
import { makeDismissalsDal } from '../../app/src/main/db/dal/dismissals.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { openDatabase } from '../../app/src/main/db/index.js';
import { IDENTITY } from '@jat13/shared';

const VERSION = '13.3.0';
const TOKEN = 'tok-routes-track';

const JOB_URL = 'https://boards.greenhouse.io/acme/jobs/12345?gh_jid=12345&utm_source=x';
const JOB_BODY = { url: JOB_URL, title: 'Senior TypeScript Engineer', company: 'Acme Corp' };
const NON_JOB_URL = 'https://www.reddit.com/r/cats/comments/abc';

/** Reversible fake — vitest has no Electron safeStorage. */
const fakeSealer: Sealer = {
  available: () => true,
  seal: (p) => Buffer.from(`sealed:${p}`, 'utf8'),
  open: (b) => b.toString('utf8').replace(/^sealed:/, ''),
};

// ---------------------------------------------------------------------------------------------
// canonical envelope (written from the spec — independent of @jat13/shared, no rubber-stamping)
// ---------------------------------------------------------------------------------------------
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const EnvelopeSchema = z
  .discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
    z
      .object({
        ok: z.literal(false),
        error: z
          .object({ code: z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/), message: z.string().min(1) })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((env, ctx) => {
    if (!env.ok) return;
    const d = (env as { data: unknown }).data;
    if (isRecord(d) && 'ok' in d && ('data' in d || 'error' in d)) {
      ctx.addIssue({ code: 'custom', message: 'data is itself an envelope (double wrap)' });
    }
  });

// ---------------------------------------------------------------------------------------------
// the injected job-gate: a fake host heuristic — postings pass, social/aggregator hosts don't.
// ---------------------------------------------------------------------------------------------
const NON_JOB_HOSTS = ['reddit.com', 'facebook.com', 'youtube.com', 'twitter.com'];
const isJobPosting: JobGate = (i) => !NON_JOB_HOSTS.some((h) => i.url.includes(h));

// ---------------------------------------------------------------------------------------------
// harness: real DB + real DAL + a real ingest (jobs.upsert + applications.ensure) + the dismissals DAL.
// ---------------------------------------------------------------------------------------------
interface Harness {
  app: Hono;
  db: DB;
  dal: Dal;
  trackDal: TrackDal;
  ingestCalls: string[];
}

function makeHarness(): Harness {
  const { db } = openDatabase({ file: ':memory:' });
  const dal = makeDal(defaultContext(db), { sealer: fakeSealer });
  const t = Date.now();
  db.prepare(
    `INSERT INTO profiles (id, name, is_default, data_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  ).run('prof_1', 'Pierre', 1, '{}', t, t);

  const dismissals = makeDismissalsDal(dal.ctx);
  const trackDal: TrackDal = { dismissals };

  const ingestCalls: string[] = [];
  const ingest: IngestFn = (input) => {
    ingestCalls.push(input.url);
    const up = dal.jobs.upsert({
      source: input.source ?? 'extension',
      job_url: input.url,
      title: input.title ?? '',
      company: input.company ?? '',
    });
    const app = dal.applications.ensure(up.job.id, 'prof_1');
    return { applicationId: app.id, jobId: up.job.id };
  };

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
        extend: (api) => mountTrackRoutes(api, { dal: trackDal, ingest, isJobPosting }),
      }),
  });

  return { app, db, dal, trackDal, ingestCalls };
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
describe('Stage-3 track/dismiss routes — envelope contract', () => {
  const TRACK_ROUTES = ['POST /api/track', 'POST /api/jobs/:id/dismiss', 'GET /api/dismissals'];

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

  it('every declared track/dismiss route is actually mounted (no vacuous walk)', () => {
    const keys = walkable(makeHarness().app).map((r) => `${r.method} ${r.path}`);
    expect(keys).toEqual(expect.arrayContaining(TRACK_ROUTES));
  });

  it('every mounted route answers JSON that parses as the canonical envelope', async () => {
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
    const res = await app.request('/api/dismissals');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. the is-this-a-job GATE — a non-posting NEVER becomes a phantom job
// ---------------------------------------------------------------------------------------------
describe('POST /api/track — the job GATE', () => {
  it('a non-job URL → { tracked:false, reason:"not_a_job" } and creates NO row', async () => {
    const h = makeHarness();
    const data = await okData<{ tracked: boolean; reason?: string }>(
      await call(h.app, 'POST', '/api/track', { url: NON_JOB_URL, title: 'cute cats' }),
    );
    expect(data.tracked).toBe(false);
    expect(data.reason).toBe('not_a_job');

    // the scar: no phantom job, no application, ingest never touched.
    expect(count(h.db, `SELECT COUNT(*) AS c FROM jobs`)).toBe(0);
    expect(count(h.db, `SELECT COUNT(*) AS c FROM applications`)).toBe(0);
    expect(h.ingestCalls).toEqual([]);
  });

  it('a real job URL → { tracked:true, applicationId } and creates the job + application', async () => {
    const h = makeHarness();
    const data = await okData<{ tracked: boolean; applicationId: string; jobId: string }>(
      await call(h.app, 'POST', '/api/track', JOB_BODY),
    );
    expect(data.tracked).toBe(true);
    expect(data.applicationId).toBeTruthy();
    expect(data.jobId).toBeTruthy();
    expect(h.ingestCalls).toEqual([JOB_URL]);
    expect(count(h.db, `SELECT COUNT(*) AS c FROM jobs`)).toBe(1);
    expect(count(h.db, `SELECT COUNT(*) AS c FROM applications WHERE id = ?`, data.applicationId)).toBe(1);
  });

  it('validates: a missing/blank url → enveloped 400, no ingest', async () => {
    const h = makeHarness();
    expect((await call(h.app, 'POST', '/api/track', {})).status).toBe(400);
    expect((await call(h.app, 'POST', '/api/track', { url: '  ' })).status).toBe(400);
    expect(h.ingestCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. PERMANENCE — dismiss sticks across a re-track of the SAME url (THE scar)
// ---------------------------------------------------------------------------------------------
describe('permanent dismiss — a dismissed posting can NEVER return', () => {
  it('track → dismiss → re-track the SAME url → { tracked:false, reason:"dismissed" }', async () => {
    const h = makeHarness();

    // 1) track it for real.
    const first = await okData<{ tracked: boolean; jobId: string; applicationId: string }>(
      await call(h.app, 'POST', '/api/track', JOB_BODY),
    );
    expect(first.tracked).toBe(true);
    const { jobId, applicationId } = first;

    // 2) dismiss it via the UI's button route.
    const dismiss = await okData<{ dismissed: boolean }>(
      await call(h.app, 'POST', `/api/jobs/${jobId}/dismiss`, { reason: 'not_a_job' }),
    );
    expect(dismiss.dismissed).toBe(true);

    // all three identity keys written, all pointing at the job.
    expect(count(h.db, `SELECT COUNT(*) AS c FROM dismissals WHERE job_id = ?`, jobId)).toBe(3);
    expect(
      count(h.db, `SELECT COUNT(*) AS c FROM dismissals WHERE job_id = ? AND (dismiss_key LIKE 'nk:%' OR dismiss_key LIKE 'url:%' OR dismiss_key LIKE 'co:%')`, jobId),
    ).toBe(3);
    // the application is withdrawn (hidden from the pipeline).
    expect(
      (h.db.prepare(`SELECT status FROM applications WHERE id = ?`).get(applicationId) as { status: string }).status,
    ).toBe('withdrawn');

    const ingestBefore = h.ingestCalls.length;

    // 3) re-track the EXACT SAME url — it must NOT come back.
    const second = await okData<{ tracked: boolean; reason?: string }>(
      await call(h.app, 'POST', '/api/track', JOB_BODY),
    );
    expect(second.tracked).toBe(false);
    expect(second.reason).toBe('dismissed');

    // the re-track short-circuited BEFORE ingest — no new job, no re-created application.
    expect(h.ingestCalls.length).toBe(ingestBefore);
    expect(count(h.db, `SELECT COUNT(*) AS c FROM jobs`)).toBe(1);
    expect(count(h.db, `SELECT COUNT(*) AS c FROM jobs WHERE dismissed_at IS NOT NULL`)).toBe(1);
  });

  it('dismiss on an unknown job id → enveloped 404', async () => {
    const h = makeHarness();
    const res = await call(h.app, 'POST', '/api/jobs/job_nope/dismiss', {});
    expect(res.status).toBe(404);
    expect((await errBody(res)).code).toBe('not_found');
  });

  it('an unknown dismiss reason → enveloped 400 (loud on unknown), nothing written', async () => {
    const h = makeHarness();
    const first = await okData<{ jobId: string }>(await call(h.app, 'POST', '/api/track', JOB_BODY));
    const res = await call(h.app, 'POST', `/api/jobs/${first.jobId}/dismiss`, { reason: 'whatever' });
    expect(res.status).toBe(400);
    expect((await errBody(res)).code).toBe('bad_reason');
    expect(count(h.db, `SELECT COUNT(*) AS c FROM dismissals`)).toBe(0);
  });

  it('GET /api/dismissals lists the dismissed job, one entry, joined to the posting', async () => {
    const h = makeHarness();
    const first = await okData<{ jobId: string }>(await call(h.app, 'POST', '/api/track', JOB_BODY));
    await call(h.app, 'POST', `/api/jobs/${first.jobId}/dismiss`, { reason: 'off_target', note: 'wrong stack' });

    const page = await okData<{
      rows: Array<{ job_id: string; reason: string; note: string | null; key_count: number; company: string | null }>;
      total: number;
    }>(await call(h.app, 'GET', '/api/dismissals'));
    expect(page.total).toBe(1);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.job_id).toBe(first.jobId);
    expect(page.rows[0]!.reason).toBe('off_target');
    expect(page.rows[0]!.note).toBe('wrong stack');
    expect(page.rows[0]!.key_count).toBe(3);
    expect(page.rows[0]!.company).toBe('Acme Corp');
  });
});
