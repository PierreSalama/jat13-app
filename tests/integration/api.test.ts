import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { loadBuiltins, makeRegistry } from '../../app/src/main/adapters/registry.js';
import { makeRunService } from '../../app/src/main/engine/run-service.js';
import { mountApi } from '../../app/src/main/server/api.js';
import type { RunGateway } from '../../app/src/main/engine/gateway.js';
import { LINKEDIN_DAILY_CAP } from '@jat13/shared';

const fakeSealer: Sealer = { available: () => true, seal: (p) => Buffer.from(p), open: (b) => Buffer.from(b).toString() };
const unusedGateway: RunGateway = {
  command: () => Promise.reject(new Error('gateway should not be called in these tests')),
  awaitResume: () => Promise.reject(new Error('no')),
};
// minimal fakes for the AI + discovery deps (these routes aren't exercised by this suite)
const fakeAi = {
  status: () => Promise.resolve({ available: false, detail: 'test' }),
  generate: () => Promise.resolve({ text: '', ms: 0 }),
  answerScreeningQuestion: () => Promise.resolve({ value: null, confidence: 0, refused: true, reason: 'test' }),
} as unknown as import('../../app/src/main/ai/index.js').AiService;
const fakeDiscovery = {
  runOnce: () => Promise.resolve({ lanes: [] }),
  start: () => {},
  stop: () => {},
} as unknown as import('../../app/src/main/discovery/service.js').DiscoveryService;
const svc = { aiService: fakeAi, discovery: fakeDiscovery };
const TOKEN = 'test-token';
const auth = { headers: { 'X-JAT13-Token': TOKEN } };

describe('REST API + run-service wiring', () => {
  let db: Database;
  let dal: Dal;
  let app: Hono;
  let runService: ReturnType<typeof makeRunService>;
  let registry: ReturnType<typeof makeRegistry>;

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    dal = makeDal(defaultContext(db), { sealer: fakeSealer });
    registry = makeRegistry(loadBuiltins());
    runService = makeRunService({ dal, gateway: unusedGateway, registry, pollMs: 999999 });
    app = new Hono();
    // inject a deterministic "v11 not running" so the import tests don't depend on a real :7744
    mountApi(app, { dal, runService, registry, ...svc, token: TOKEN, version: '13.0.0', v11Probe: () => Promise.resolve(false) });

    db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?,?,1,?,?)').run('p1', 'Pierre', 1, 1);
    db.prepare('INSERT INTO jobs (id, source, title, company, job_url, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('j1', 'linkedin', 'Engineer', 'Aurora', 'https://www.linkedin.com/jobs/view/1', 1, 1, 1, 1);
    dal.applications.ensure('j1', 'p1');
  });
  afterEach(() => { runService.stop(); db.close(); });

  it('serves the loopback pairing token WITHOUT auth', async () => {
    const res = await app.request('/api/pair/token');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; productName: string };
    expect(body.token).toBe(TOKEN);
    expect(body.productName).toBe('JAT 13');
  });

  it('rejects protected routes without the token, allows them with it', async () => {
    expect((await app.request('/api/summary')).status).toBe(401);
    const res = await app.request('/api/summary', auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { funnel: Record<string, number>; applying: boolean };
    expect(body.applying).toBe(false);
    expect(typeof body.funnel).toBe('object');
  });

  it('lists jobs and adapters', async () => {
    const jobs = (await (await app.request('/api/jobs', auth)).json()) as { rows: { id: string }[]; total: number };
    expect(jobs.total).toBe(1);
    expect(jobs.rows[0]!.id).toBe('j1');
    const adapters = (await (await app.request('/api/adapters', auth)).json()) as { rows: { id: string }[] };
    expect(adapters.rows.some((a) => a.id === 'linkedin-easy-apply')).toBe(true);
  });

  it('toggles the run-service via the API', async () => {
    await app.request('/api/apply/start', { method: 'POST', ...auth });
    expect(runService.isRunning()).toBe(true);
    const st = (await (await app.request('/api/apply/status', auth)).json()) as { running: boolean };
    expect(st.running).toBe(true);
    await app.request('/api/apply/stop', { method: 'POST', ...auth });
    expect(runService.isRunning()).toBe(false);
  });

  it('surfaces a typed importer error for a bad source path', async () => {
    const res = await app.request('/api/import/plan', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sourcePath: 'F:/definitely/not/a/real/jat.db' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy(); // NOT_FOUND / OPEN_FAILED
  });

  it('tracks a page via POST /track (upsert + application), rejects a bad url', async () => {
    const res = await app.request('/api/track', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.linkedin.com/jobs/view/999', title: 'Staff Eng' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; jobId: string; action: string };
    expect(body.action).toBe('tracked');
    // the job + an application on the default profile exist
    expect(dal.jobs.getDetail(body.jobId)?.title).toBe('Staff Eng');
    const appl = db.prepare('SELECT COUNT(*) c FROM applications WHERE job_id=?').get(body.jobId) as { c: number };
    expect(appl.c).toBe(1);
    // idempotent: same URL → existing
    const again = await app.request('/api/track', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.linkedin.com/jobs/view/999', title: 'Staff Eng' }),
    });
    expect(((await again.json()) as { action: string }).action).toBe('existing');
    const bad = await app.request('/api/track', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });
    expect(bad.status).toBe(400);
  });

  it('POST /app/front invokes the window callback', async () => {
    let fronted = 0;
    const app2 = new Hono();
    mountApi(app2, { dal, runService, registry, ...svc, token: TOKEN, version: '13.0.0', frontWindow: () => { fronted++; } });
    const res = await app2.request('/api/app/front', { method: 'POST', ...auth });
    expect(res.status).toBe(200);
    expect(fronted).toBe(1);
  });

  it('refuses import while v11 is running (409 V11_RUNNING)', async () => {
    const app2 = new Hono();
    mountApi(app2, { dal, runService, registry, ...svc, token: TOKEN, version: '13.0.0', v11Probe: () => Promise.resolve(true) });
    const res = await app2.request('/api/import/plan', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sourcePath: 'anything' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('V11_RUNNING');
  });

  it('run-service SKIPS a run whose job host has no adapter (queued→skipped, never attempted)', async () => {
    db.prepare('INSERT INTO jobs (id, source, job_url, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run('j2', 'other', 'https://example.com/careers/1', 1, 1, 1, 1);
    const appl = dal.applications.ensure('j2', 'p1');
    const run = dal.runs.enqueue(appl.id, { source: 'other', lane: 'ats', jobId: 'j2', profileId: 'p1' });
    const outcome = await runService.driveNext();
    expect(outcome?.state).toBe('skipped');
    expect(dal.runs.get(run.id)!.error).toContain('no_adapter');
  });

  it('respects the LinkedIn 45/24h ledger cap — a capped source stays queued, never driven', async () => {
    const t = Date.now();
    const ins = db.prepare("INSERT INTO apply_ledger (run_id, source, account_key, submitted_at) VALUES (?, 'linkedin', 'default', ?)");
    for (let i = 0; i < LINKEDIN_DAILY_CAP; i++) ins.run('r' + i, t - 1000); // fill the rolling window
    const appl = dal.applications.ensure('j1', 'p1'); // j1 is a linkedin job
    const run = dal.runs.enqueue(appl.id, { source: 'linkedin', lane: 'linkedin', jobId: 'j1', profileId: 'p1' });

    const outcome = await runService.driveNext(); // unusedGateway would throw if it tried to drive
    expect(outcome).toBeNull(); // over cap → nothing driven this tick
    expect(dal.runs.get(run.id)!.state).toBe('queued'); // left for a later window
  });

  // -------------------------------------------------------------------------
  // Dashboard-facing additive routes
  // -------------------------------------------------------------------------

  it('GET /stats returns funnel + run stats + cheap totals (auth-guarded)', async () => {
    expect((await app.request('/api/stats')).status).toBe(401);
    const res = await app.request('/api/stats', auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { funnel: Record<string, number>; runs: { byState: Record<string, number>; total: number }; totals: { jobs: number; applications: number; submitted7d: number } };
    expect(typeof body.funnel).toBe('object');
    expect(typeof body.runs.total).toBe('number');
    expect(body.totals.jobs).toBe(1); // one seeded job
    expect(body.totals.applications).toBe(1); // one seeded application
    expect(typeof body.totals.submitted7d).toBe('number');
  });

  it('GET /events/recent returns a rows array (auth-guarded)', async () => {
    expect((await app.request('/api/events/recent')).status).toBe(401);
    const res = await app.request('/api/events/recent?limit=5', auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it('lists profiles and fetches one with parsed data (auth-guarded)', async () => {
    expect((await app.request('/api/profiles')).status).toBe(401);
    const list = (await (await app.request('/api/profiles', auth)).json()) as { rows: { id: string; name: string; is_default: number }[] };
    expect(list.rows.some((p) => p.id === 'p1' && p.is_default === 1)).toBe(true);
    const one = (await (await app.request('/api/profiles/p1', auth)).json()) as { id: string; name: string; data: unknown };
    expect(one.id).toBe('p1');
    expect(typeof one.data).toBe('object');
    expect((await app.request('/api/profiles/nope', auth)).status).toBe(404);
  });

  it('PUT /profiles/:id updates name+data and enforces the 256KB json cap', async () => {
    const ok = await app.request('/api/profiles/p1', {
      method: 'PUT',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Pierre S', data: { city: 'Montreal' } }),
    });
    expect(ok.status).toBe(200);
    const row = db.prepare('SELECT name, data_json FROM profiles WHERE id=?').get('p1') as { name: string; data_json: string };
    expect(row.name).toBe('Pierre S');
    expect(JSON.parse(row.data_json).city).toBe('Montreal');
    // oversized payload is refused (400), never written
    const big = await app.request('/api/profiles/p1', {
      method: 'PUT',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ data: { blob: 'x'.repeat(300000) } }),
    });
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: string }).error).toBe('too_large');
  });

  it('answers: list scoped by profileId, then PUT + DELETE (auth-guarded)', async () => {
    dal.answers.record('p1', { kind: 'qa', label: 'Years of experience?', value: '5', provenance: 'user' });
    expect((await app.request('/api/answers?profileId=p1')).status).toBe(401);
    // missing profileId → 400
    expect((await app.request('/api/answers', auth)).status).toBe(400);
    const listed = (await (await app.request('/api/answers?profileId=p1', auth)).json()) as { rows: { id: string; label: string; locked: boolean; value?: unknown }[]; total: number };
    expect(listed.total).toBe(1);
    const row = listed.rows[0]!;
    expect(row.label).toBe('Years of experience?');
    expect('value' in row).toBe(false); // lean projection — no value/options blobs
    // PUT value + lock
    const put = await app.request('/api/answers/' + row.id, {
      method: 'PUT',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ value: '6', locked: true }),
    });
    expect(put.status).toBe(200);
    const after = db.prepare('SELECT value, locked FROM learned_answers WHERE id=?').get(row.id) as { value: string; locked: number };
    expect(after.value).toBe('6');
    expect(after.locked).toBe(1);
    // DELETE
    expect((await app.request('/api/answers/' + row.id, { method: 'DELETE', ...auth })).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM learned_answers WHERE id=?').get(row.id)).toEqual({ c: 0 });
    expect((await app.request('/api/answers/' + row.id, { method: 'DELETE', ...auth })).status).toBe(404);
  });

  it('GET /email/accounts returns a rows array (auth-guarded)', async () => {
    expect((await app.request('/api/email/accounts')).status).toBe(401);
    const body = (await (await app.request('/api/email/accounts', auth)).json()) as { rows: unknown[] };
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it('GET /export streams a JSON attachment with jobs + applications (auth-guarded)', async () => {
    expect((await app.request('/api/export')).status).toBe(401);
    const res = await app.request('/api/export', auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="jat13-export.json"');
    const body = (await res.json()) as { exportedAt: null; jobs: unknown[]; applications: unknown[] };
    expect(body.exportedAt).toBeNull();
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs.length).toBe(1);
    expect(Array.isArray(body.applications)).toBe(true);
  });
});
