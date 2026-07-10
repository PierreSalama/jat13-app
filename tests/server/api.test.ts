// Stage-0 server behavior tests: /health liveness contract, pair/token public hand-off, the
// X-JAT13-Token guard, the status/version/front routes, the static-mount traversal guard + SPA
// fallback, pairing-token persistence, and a real loopback bind via startServer.
// (The envelope SHAPE of every /api route is enforced separately by envelope.test.ts.)
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createApp, startServer, type ServerDeps, type HealthBody } from '../../app/src/main/server/index.js';
import { mountApi, type ApiDeps } from '../../app/src/main/server/api.js';
import { ensurePairingToken, type PairingDal } from '../../app/src/main/server/pairing.js';
import { makeDevDrive } from '../../app/src/main/server/devdrive.js';
import { IDENTITY, PROTOCOL_VERSION } from '@jat13/shared';

const VERSION = '13.1.0';
const TOKEN = 'tok-stage0-test';

interface TestApp {
  app: Hono;
  db: InstanceType<typeof Database>;
  fronted: () => number;
}

function makeTestApp(opts: { rendererDir?: string } = {}): TestApp {
  const db = new Database(':memory:');
  let fronted = 0;
  const deps: ServerDeps = {
    db,
    version: VERSION,
    startedAt: Date.now() - 1_000, // booted "1s ago" so uptimeMs is provably > 0
    dev: true,
    mount: (a) => {
      const apiDeps: ApiDeps = {
        db,
        token: TOKEN,
        version: VERSION,
        startedAt: Date.now() - 1_000,
        devtools: false,
        frontWindow: () => {
          fronted += 1;
        },
      };
      mountApi(a, apiDeps);
    },
  };
  if (opts.rendererDir !== undefined) deps.rendererDir = opts.rendererDir;
  return { app: createApp(deps), db, fronted: () => fronted };
}

const authed = { headers: { [IDENTITY.authHeader]: TOKEN } };

describe('/health — the bare liveness probe (the ONE non-enveloped surface)', () => {
  it('answers unauthenticated with the flat liveness body', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.ok).toBe(true);
    expect(body.name).toBe('JAT 13');
    expect(body.version).toBe(VERSION);
    expect(body.protocol).toBe(PROTOCOL_VERSION);
    expect(body.schema).toBe(0); // bare in-memory DB — user_version 0
    expect(body.dev).toBe(true);
    expect(body.uptimeMs).toBeGreaterThan(0);
    expect(body.pid).toBe(process.pid);
    // deliberately NOT the envelope: no data/error keys — external probes parse this flat.
    expect('data' in body).toBe(false);
    expect('error' in body).toBe(false);
  });
});

describe('/api/pair/token — the public pairing hand-off', () => {
  it('is reachable WITHOUT the auth header and carries the token in the envelope', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/api/pair/token');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data.token).toBe(TOKEN);
    expect(body.data.productName).toBe('JAT 13');
    expect(body.data.version).toBe(VERSION);
    expect(body.data.protocol).toBe(PROTOCOL_VERSION);
    expect(body.data.devtools).toBe(false);
  });
});

describe('X-JAT13-Token guard', () => {
  it('401s every non-pair /api route without the header — in the envelope', async () => {
    const { app } = makeTestApp();
    for (const [method, path] of [
      ['GET', '/api/version'],
      ['GET', '/api/status'],
      ['POST', '/api/app/front'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
      const body = (await res.json()) as { ok: false; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('unauthorized');
    }
  });

  it('401s a WRONG token too', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/api/version', { headers: { [IDENTITY.authHeader]: 'nope' } });
    expect(res.status).toBe(401);
  });

  it('admits the correct token', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/api/version', authed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { version: string; protocol: number } };
    expect(body.data.version).toBe(VERSION);
    expect(body.data.protocol).toBe(PROTOCOL_VERSION);
  });
});

describe('Stage-0 authed routes', () => {
  it('GET /api/status reports schema, uptime, stage "0" and the counts stub', async () => {
    const { app, db } = makeTestApp();
    // simulate a migrated DB with one table present — the stub must count it and zero the rest.
    db.pragma('user_version = 7');
    db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY); INSERT INTO jobs VALUES ('a'), ('b');`);
    const res = await app.request('/api/status', authed);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { schema: number; uptimeMs: number; stage: string; counts: Record<string, number> };
    };
    expect(data.schema).toBe(7);
    expect(data.stage).toBe('0');
    expect(data.uptimeMs).toBeGreaterThan(0);
    expect(data.counts).toEqual({ jobs: 2, applications: 0, apply_runs: 0 });
  });

  it('POST /api/app/front calls deps.frontWindow', async () => {
    const t = makeTestApp();
    const res = await t.app.request('/api/app/front', { ...authed, method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { fronted: boolean } };
    expect(body.data.fronted).toBe(true);
    expect(t.fronted()).toBe(1);
  });

  it('unknown /api paths get the enveloped 404 — never the SPA fallback', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/api/definitely/not/a/route', authed);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('not_found');
  });
});

describe('static renderer mount — generic whole-dir serve + traversal guard', () => {
  const INDEX = '<!doctype html><title>Atelier</title><div id="app"></div>';
  const APP_JS = 'export const atelier = true;';
  const SECRET = 'THE-SECRET-OUTSIDE-THE-RENDERER-ROOT';
  let base: string;

  function makeStaticApp(): Hono {
    base = mkdtempSync(join(tmpdir(), 'jat13-static-'));
    const renderer = join(base, 'renderer');
    mkdirSync(join(renderer, 'lib'), { recursive: true });
    writeFileSync(join(renderer, 'index.html'), INDEX);
    writeFileSync(join(renderer, 'app.js'), APP_JS);
    writeFileSync(join(renderer, 'lib', 'icons.js'), '// icons'); // the file the old whitelist forgot
    writeFileSync(join(base, 'secret.txt'), SECRET); // OUTSIDE the served root
    return makeTestApp({ rendererDir: renderer }).app;
  }

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('serves / as index.html and any real file generically (no whitelist)', async () => {
    const app = makeStaticApp();
    const root = await app.request('/');
    expect(root.status).toBe(200);
    expect(await root.text()).toBe(INDEX);
    expect(root.headers.get('content-type')).toContain('text/html');

    const js = await app.request('/app.js');
    expect(await js.text()).toBe(APP_JS);
    expect(js.headers.get('content-type')).toContain('text/javascript');

    // the exact class the v13.0.0 whitelist 404'd (blank-screened the browser dashboard)
    const nested = await app.request('/lib/icons.js');
    expect(nested.status).toBe(200);
  });

  it('falls back to index.html for unknown paths (hash-routed SPA)', async () => {
    const app = makeStaticApp();
    const res = await app.request('/some/deep/client/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
  });

  it('NEVER escapes the renderer root — encoded and raw traversal both confined', async () => {
    const app = makeStaticApp();
    for (const path of [
      '/%2e%2e/secret.txt', // %2e%2e survives URL normalization; guard runs post-decode
      '/..%2fsecret.txt',
      '/lib/%2e%2e/%2e%2e/secret.txt',
      '/../secret.txt', // normalized by URL parsing, but assert the outcome anyway
    ]) {
      const res = await app.request(path);
      const text = await res.text();
      expect(text, path).not.toContain(SECRET);
      expect(text, path).toBe(INDEX); // confined → SPA fallback, not the escaped file
    }
  });

  it('does not swallow /health, /api or /drive', async () => {
    const app = makeStaticApp();
    const health = await app.request('/health');
    expect(health.headers.get('content-type')).toContain('application/json');

    const api = await app.request('/api/nope', authed);
    expect(api.status).toBe(404);
    expect(((await api.json()) as { ok: boolean }).ok).toBe(false); // enveloped API 404, not index.html

    const drive = await app.request('/drive');
    expect(drive.status).toBe(404); // ws upgrade lives at the socket layer, not the static mount
  });
});

describe('ensurePairingToken', () => {
  function fakeDal(): PairingDal & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      store,
      secrets: {
        open: (k: string) => store.get(k),
        seal: (k: string, v: string) => {
          store.set(k, v);
        },
      },
    };
  }

  it('mints a 32-hex token once and returns the SAME token forever after', () => {
    const dal = fakeDal();
    const first = ensurePairingToken(dal);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(ensurePairingToken(dal)).toBe(first); // stable — a paired extension never re-pairs
    expect(dal.store.size).toBe(1);
  });

  it('different installs mint different tokens', () => {
    expect(ensurePairingToken(fakeDal())).not.toBe(ensurePairingToken(fakeDal()));
  });
});

describe('dev-drive command bus — the harness every stage exits through', () => {
  function makeDevApp(execTimeoutMs: number): Hono {
    const db = new Database(':memory:');
    const devDrive = makeDevDrive({ getWindow: () => undefined, execTimeoutMs });
    return createApp({
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
          devtools: true,
          extend: (api) => devDrive.mount(api),
        }),
    });
  }

  const jsonPost = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { [IDENTITY.authHeader]: TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('exec long-polls; the renderer drains /dev/pending and /dev/result wakes the waiter', async () => {
    const app = makeDevApp(5_000);
    // I (the harness) enqueue a DOM command — do NOT await yet, it long-polls.
    const execP = app.request('/api/dev/exec', jsonPost({ type: 'inspect', args: { selector: '#app' } }));

    // the renderer's poller drains pending (poll briefly — the exec handler pushes after body parse)
    let commands: { id: string; type: string; args?: Record<string, unknown> }[] = [];
    for (let i = 0; i < 50 && commands.length === 0; i++) {
      const res = await app.request('/api/dev/pending', authed);
      commands = ((await res.json()) as { data: { commands: typeof commands } }).data.commands;
      if (commands.length === 0) await new Promise((r) => setTimeout(r, 10));
    }
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe('inspect');
    expect(commands[0]!.args).toEqual({ selector: '#app' });

    // ...executes it against the real DOM and posts the result back
    const resultRes = await app.request('/api/dev/result', jsonPost({ id: commands[0]!.id, result: { found: true } }));
    expect(resultRes.status).toBe(200);

    // the long-poll wakes with the renderer's answer
    const execBody = (await (await execP).json()) as { ok: true; data: { id: string; result: unknown } };
    expect(execBody.data.id).toBe(commands[0]!.id);
    expect(execBody.data.result).toEqual({ found: true });

    // pending is drained again
    const ping = (await (await app.request('/api/dev/ping', authed)).json()) as { data: { pendingDepth: number } };
    expect(ping.data.pendingDepth).toBe(0);
  });

  it('exec resolves an honest timeout result when no renderer answers', async () => {
    const app = makeDevApp(30);
    const body = (await (
      await app.request('/api/dev/exec', jsonPost({ type: 'click' }))
    ).json()) as { ok: true; data: { result: { error?: string } } };
    expect(body.ok).toBe(true); // transport worked; the RESULT carries the timeout
    expect(body.data.result.error).toBe('timeout');
  });
});

describe('startServer — real loopback bind', () => {
  it('binds 127.0.0.1 on the requested port and serves /health over the wire', async () => {
    const db = new Database(':memory:');
    const running = await startServer(
      { db, version: VERSION, startedAt: Date.now(), dev: true },
      0, // ephemeral port — the override param the harness/tests use
    );
    try {
      expect(running.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${running.port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HealthBody;
      expect(body.name).toBe('JAT 13');
    } finally {
      await running.close();
    }
  });
});
