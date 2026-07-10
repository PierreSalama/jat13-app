// The local server: Hono REST + (later) the /drive WebSocket. Loopback-only on 127.0.0.1:7860
// (dev 7861). Stage 0 ships the liveness surface, the static renderer mount, and the hook the
// REST API mounts through.
//
// /health is intentionally UNAUTHENTICATED and intentionally NOT enveloped — it's the loopback
// liveness probe (mirrors what the importer uses against v11's :7744/health to refuse importing
// from a running instance), and external probes expect a flat body. It is the ONE exception to
// the {ok,data}/{ok:false,error} envelope; every /api route uses the envelope (see api.ts).

import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { Database } from 'better-sqlite3';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { PORTS, PROTOCOL_VERSION, IDENTITY } from '@jat13/shared';

export interface ServerDeps {
  db: Database;
  /** app version (from package.json / electron app.getVersion()). */
  version: string;
  /** epoch-ms the process booted, for uptime reporting. */
  startedAt: number;
  /** true when running under `npm run dev` (dev identity/port 7861). */
  dev?: boolean;
  /** mount additional routes (the REST API) on the app before it serves. */
  mount?: (app: Hono) => void;
  /** serve the built Atelier renderer over http (same origin as the API) — lets the dashboard open
   *  in a plain browser tab, not just the Electron window. Absent in tests. */
  rendererDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/**
 * Serve the renderer's static files at the API's own origin (no CORS) so the dashboard opens in a
 * plain browser tab, not just the Electron window. Serves the WHOLE renderer dir generically —
 * scar: the v13.0.0 hard-coded whitelist 404'd any file it forgot (e.g. lib/icons.js), which
 * blank-screened the browser dashboard; 13.0.1 fixed it to this generic mount. Path is resolved +
 * confined under `dir` (no `..` traversal escape, including %2e%2e-encoded forms — the guard runs
 * AFTER decodeURIComponent).
 */
function mountStatic(app: Hono, dir: string): void {
  const root = resolve(dir);
  const send = (rel: string): Response | null => {
    const p = resolve(root, '.' + (rel.startsWith('/') ? rel : '/' + rel));
    if (p !== root && !p.startsWith(root + sep)) return null; // traversal guard
    if (!existsSync(p) || !statSync(p).isFile()) return null;
    const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
    return new Response(new Uint8Array(readFileSync(p)), {
      status: 200,
      headers: { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' },
    });
  };
  const indexHtml = (c: Context): Response | Promise<Response> => send('index.html') ?? c.notFound();
  app.get('/', indexHtml);
  // any other path → the matching file under the renderer dir, else the SPA index (hash-routed
  // app). /api, /health and /drive are NEVER swallowed by the SPA fallback — an API typo must
  // surface as an API 404, not silently return index.html.
  app.get('/*', (c) => {
    const path = new URL(c.req.url).pathname;
    if (path === '/' || path.startsWith('/api') || path === '/health' || path === '/drive') return c.notFound();
    return send(decodeURIComponent(path)) ?? indexHtml(c);
  });
}

/** The bare /health body — the ONE non-enveloped JSON surface (liveness probe contract). */
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

  deps.mount?.(app); // REST API (enveloped, guarded routes) mounts here, after /health
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
 * Bind the app to a loopback socket. `port` defaults to the dev/prod port from IDENTITY
 * (7861 dev / 7860 prod); pass an explicit port (e.g. 0 for an ephemeral port) in tests/smoke
 * harnesses. 127.0.0.1 ONLY — the pairing token's whole security model relies on the server
 * being unreachable from any remote page.
 */
export function startServer(deps: ServerDeps, port?: number): Promise<RunningServer> {
  const app = createApp(deps);
  const boundPort = port ?? (deps.dev ? PORTS.dev : PORTS.app);
  return new Promise((resolvePromise, reject) => {
    try {
      const server = serve(
        { fetch: app.fetch, port: boundPort, hostname: '127.0.0.1' },
        (info) => {
          resolvePromise({
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
