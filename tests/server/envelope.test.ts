// THE envelope contract test — the one that makes the v13.0.x {rows:{rows}} class impossible.
//
// It does NOT test routes one by one. It enumerates EVERY route mounted under /api on a fully
// wired test app (api + dev-drive extend hook) via Hono's route table, fires a real request at
// each, and zod-parses every JSON response against the canonical envelope:
//     success = {"ok":true,"data":<payload>}
//     error   = {"ok":false,"error":{"code":"<snake_case>","message":"<human>"}}
// A new route added in ANY later stage is automatically walked the moment it mounts — a bespoke
// shape, a double wrap, or a bare body fails CI without anyone writing a per-route test.
//
// The schema is DELIBERATELY defined here, inline, rather than imported from @jat13/shared: a
// contract test that validates the helpers with the helpers' own schema would rubber-stamp a bug
// in shared. This file is the independent second opinion.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { createApp, type ServerDeps } from '../../app/src/main/server/index.js';
import { mountApi, type ApiDeps } from '../../app/src/main/server/api.js';
import { makeDevDrive } from '../../app/src/main/server/devdrive.js';
import { IDENTITY } from '@jat13/shared';

const VERSION = '13.1.0';
const TOKEN = 'tok-envelope-walk';

// ---------------------------------------------------------------------------------------------
// The canonical envelope, written from the spec (not from the implementation).
// ---------------------------------------------------------------------------------------------
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const ErrorShape = z
  .object({
    // snake_case, lowercase, starts alphabetic: 'unauthorized', 'not_found', 'no_window', ...
    code: z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, 'error.code must be snake_case'),
    message: z.string().min(1, 'error.message must be a human-readable string'),
  })
  .strict(); // no extra keys smuggled beside code/message

const EnvelopeSchema = z
  .discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: z.unknown() }).strict(), // ok + data, NOTHING else
    z.object({ ok: z.literal(false), error: ErrorShape }).strict(), // ok + error, NOTHING else
  ])
  .superRefine((env, ctx) => {
    if (!env.ok) return;
    // z.unknown() lets a missing key parse — require the data key to physically exist.
    if (!Object.hasOwn(env, 'data')) {
      ctx.addIssue({ code: 'custom', message: 'ok envelope must carry a "data" key' });
      return;
    }
    const d = (env as { data: unknown }).data;
    // double-wrap guards — the exact v13.0.x failure classes:
    if (isRecord(d) && 'ok' in d && ('data' in d || 'error' in d)) {
      ctx.addIssue({ code: 'custom', message: 'data is itself an envelope (double wrap)' });
    }
    if (isRecord(d) && isRecord(d.rows) && 'rows' in d.rows) {
      ctx.addIssue({
        code: 'custom',
        message: '{rows:{rows}} double wrap — pass the DAL page straight to ok(), do not re-wrap it',
      });
    }
  });

// ---------------------------------------------------------------------------------------------
// Fully wired test app: api + dev-drive via the extend hook (exactly how main.ts mounts it).
// ---------------------------------------------------------------------------------------------
function makeWalkApp(): Hono {
  const db = new Database(':memory:');
  const devDrive = makeDevDrive({
    getWindow: () => undefined, // headless — screenshot must answer with an err envelope, not throw
    execTimeoutMs: 50, // keep the exec long-poll walkable; production default is 12s
  });
  const deps: ServerDeps = {
    db,
    version: VERSION,
    startedAt: Date.now(),
    dev: true,
    mount: (a) => {
      const apiDeps: ApiDeps = {
        db,
        token: TOKEN,
        version: VERSION,
        startedAt: Date.now(),
        devtools: true,
        extend: (api) => devDrive.mount(api),
      };
      mountApi(a, apiDeps);
    },
  };
  return createApp(deps);
}

interface WalkRoute {
  method: string;
  path: string;
}

/** Every concrete /api route in the app's route table (middleware + the ALL catch-all excluded —
 *  the catch-all's envelope is asserted explicitly below). */
function walkableRoutes(app: Hono): WalkRoute[] {
  const seen = new Set<string>();
  const out: WalkRoute[] = [];
  for (const r of app.routes) {
    if (!r.path.startsWith('/api')) continue;
    if (r.method === 'ALL') continue; // use('*') middleware + the enveloped 404 catch-all
    if (r.path.includes('*')) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

/** Substitute :params with a dummy id so param'd routes (later stages) stay walkable. */
const concretePath = (path: string): string => path.replace(/:[A-Za-z0-9_]+/g, 'x-walk-test-id');

async function fire(app: Hono, r: WalkRoute, withToken: boolean): Promise<Response> {
  const headers: Record<string, string> = {};
  if (withToken) headers[IDENTITY.authHeader] = TOKEN;
  const init: RequestInit = { method: r.method, headers };
  if (r.method !== 'GET' && r.method !== 'HEAD') {
    headers['content-type'] = 'application/json';
    init.body = '{}'; // minimal parseable body — routes must not 500 on an empty object
  }
  return app.request(concretePath(r.path), init);
}

describe('API envelope contract — every mounted /api route', () => {
  it('the walk actually covers the Stage-0 surface (no vacuous pass)', () => {
    const keys = walkableRoutes(makeWalkApp()).map((r) => `${r.method} ${r.path}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'GET /api/pair/token',
        'GET /api/version',
        'GET /api/status',
        'POST /api/app/front',
        'GET /api/dev/pending',
        'POST /api/dev/result',
        'POST /api/dev/exec',
        'POST /api/dev/screenshot',
        'GET /api/dev/ping',
      ]),
    );
    expect(keys.length).toBeGreaterThanOrEqual(9);
  });

  it('every JSON response parses as the canonical envelope (authed walk)', async () => {
    const app = makeWalkApp();
    for (const r of walkableRoutes(app)) {
      const res = await fire(app, r, true);
      const label = `${r.method} ${r.path} → ${res.status}`;
      const contentType = res.headers.get('content-type') ?? '';
      // the ONE non-JSON /api surface is the dev screenshot's raw PNG (and only when a window
      // exists — headless here, so anything non-JSON is a contract breach).
      expect(contentType, `${label} must answer JSON (envelope), got "${contentType}"`).toContain('application/json');
      const parsed = EnvelopeSchema.safeParse(await res.json());
      expect(parsed.success, `${label} — ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });

  it('every route EXCEPT pair/token answers 401 with an err envelope when unauthenticated', async () => {
    const app = makeWalkApp();
    for (const r of walkableRoutes(app)) {
      if (r.path === '/api/pair/token') continue;
      const res = await fire(app, r, false);
      const label = `${r.method} ${r.path}`;
      expect(res.status, label).toBe(401);
      const parsed = EnvelopeSchema.safeParse(await res.json());
      expect(parsed.success, `${label} 401 body must still be the envelope`).toBe(true);
      if (parsed.success && parsed.data.ok === false) expect(parsed.data.error.code).toBe('unauthorized');
    }
  });

  it('pair/token is public AND enveloped', async () => {
    const app = makeWalkApp();
    const res = await app.request('/api/pair/token');
    expect(res.status).toBe(200);
    const parsed = EnvelopeSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.ok) {
      expect((parsed.data.data as Record<string, unknown>).token).toBe(TOKEN);
    }
  });

  it('the /api 404 catch-all is enveloped too', async () => {
    const app = makeWalkApp();
    const res = await app.request('/api/no/such/route', { headers: { [IDENTITY.authHeader]: TOKEN } });
    expect(res.status).toBe(404);
    const parsed = EnvelopeSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.ok === false) expect(parsed.data.error.code).toBe('not_found');
  });

  it('headless /dev/screenshot answers an err envelope (503), never a throw or a bare body', async () => {
    const app = makeWalkApp();
    const res = await app.request('/api/dev/screenshot', {
      method: 'POST',
      headers: { [IDENTITY.authHeader]: TOKEN, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(503);
    const parsed = EnvelopeSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.ok === false) expect(parsed.data.error.code).toBe('no_window');
  });

  it('the schema itself rejects the historical failure shapes (self-test)', () => {
    // bare body (no envelope at all)
    expect(EnvelopeSchema.safeParse({ rows: [], total: 0 }).success).toBe(false);
    // double-wrapped envelope
    expect(EnvelopeSchema.safeParse({ ok: true, data: { ok: true, data: { rows: [] } } }).success).toBe(false);
    // THE {rows:{rows}} bug, in envelope clothing
    expect(EnvelopeSchema.safeParse({ ok: true, data: { rows: { rows: [], total: 0 } } }).success).toBe(false);
    // error without snake_case code / without message
    expect(EnvelopeSchema.safeParse({ ok: false, error: { code: 'NotFound', message: 'x' } }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ok: false, error: { code: 'not_found', message: '' } }).success).toBe(false);
    // extra keys beside the envelope
    expect(EnvelopeSchema.safeParse({ ok: true, data: {}, rows: [] }).success).toBe(false);
    // legit shapes pass
    expect(EnvelopeSchema.safeParse({ ok: true, data: { rows: [{ id: 1 }], total: 1 } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ok: false, error: { code: 'not_found', message: 'no such job' } }).success).toBe(true);
  });

  it('/health stays the ONE bare exception (regression pin)', async () => {
    const app = makeWalkApp();
    const body = (await (await app.request('/health')).json()) as Record<string, unknown>;
    // flat liveness shape — if someone "helpfully" envelopes /health, external probes break.
    expect(body.ok).toBe(true);
    expect('data' in body).toBe(false);
    expect(body.name).toBe('JAT 13');
  });
});
