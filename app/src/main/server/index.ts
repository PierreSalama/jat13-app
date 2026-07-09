// The local server: Hono REST + (later) the /drive WebSocket. Loopback-only on 127.0.0.1:7860.
// Structural law 6 lives here eventually (PatchBus over /drive); M0 ships just the liveness surface.
//
// /health is intentionally UNAUTHENTICATED — it's the loopback liveness probe (mirrors what v12's
// own importer uses against v11's :7744/health to refuse importing from a running instance).
// Every other route will require the X-JAT13-Token pairing header; that middleware arrives with
// the first real ext<->app route in M1.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { Database } from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PORTS, PROTOCOL_VERSION, IDENTITY } from '@jat13/shared';

export interface ServerDeps {
  db: Database;
  /** app version (from package.json / electron app.getVersion()). */
  version: string;
  /** epoch-ms the process booted, for uptime reporting. */
  startedAt: number;
  /** true when running under `npm run dev` (dev identity/port). */
  dev?: boolean;
  /** mount additional routes (the REST API) on the app before it serves. */
  mount?: (app: Hono) => void;
  /** serve the built Aurora renderer over http (same origin as the API) — lets the dashboard open
   *  in a plain browser tab, not just the Electron window. Absent in tests. */
  rendererDir?: string;
}

/** Serve the renderer's static files at the API's own origin (no CORS). */
function mountStatic(app: Hono, dir: string): void {
  const file = (rel: string, type: string) => (c: { body: (b: Buffer, s: number, h: Record<string, string>) => Response; notFound: () => Response | Promise<Response> }) => {
    const p = join(dir, rel);
    if (!existsSync(p)) return c.notFound();
    return c.body(readFileSync(p), 200, { 'content-type': type, 'cache-control': 'no-store' });
  };
  app.get('/', file('index.html', 'text/html; charset=utf-8'));
  app.get('/index.html', file('index.html', 'text/html; charset=utf-8'));
  app.get('/main.js', file('main.js', 'text/javascript; charset=utf-8'));
  app.get('/main.js.map', file('main.js.map', 'application/json'));
  app.get('/styles.css', file('styles.css', 'text/css; charset=utf-8'));
  app.get('/lib/themes.js', file('lib/themes.js', 'text/javascript; charset=utf-8'));
}

export interface HealthBody {
  ok: true;
  name: string;
  version: string;
  protocol: number;
  schema: number;
  dev: boolean;
  uptimeMs: number;
  pid: number;
}

/** Build the Hono app (no socket bound) — used directly by tests via `app.request()`. */
export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const schema = deps.db.pragma('user_version', { simple: true }) as number;
    const body: HealthBody = {
      ok: true,
      name: IDENTITY.productName,
      version: deps.version,
      protocol: PROTOCOL_VERSION,
      schema,
      dev: deps.dev ?? false,
      uptimeMs: Date.now() - deps.startedAt,
      pid: process.pid,
    };
    return c.json(body);
  });

  deps.mount?.(app); // REST API (guarded routes) mounts here, after /health
  if (deps.rendererDir) mountStatic(app, deps.rendererDir); // browsable dashboard at /

  return app;
}

export interface RunningServer {
  app: Hono;
  server: ServerType;
  port: number;
  close: () => Promise<void>;
}

/**
 * Bind the app to a loopback socket. `port` defaults to the dev/prod port from IDENTITY;
 * pass an explicit port (e.g. 0 for an ephemeral port) in tests/smoke harnesses.
 */
export function startServer(deps: ServerDeps, port?: number): Promise<RunningServer> {
  const app = createApp(deps);
  const boundPort = port ?? (deps.dev ? PORTS.dev : PORTS.app);
  return new Promise((resolve, reject) => {
    try {
      const server = serve(
        { fetch: app.fetch, port: boundPort, hostname: '127.0.0.1' },
        (info) => {
          resolve({
            app,
            server,
            port: info.port,
            close: () =>
              new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
          });
        },
      );
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
