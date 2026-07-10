// The REST API the Atelier UI + the extension popup call. Loopback-only; every /api route except
// the pairing hand-off requires the X-JAT13-Token header.
//
// ENVELOPE LAW (v13.0.x post-mortem #4 — the {rows:{rows}} class): EVERY /api response, success or
// failure, goes through the shared ok()/err() helpers from @jat13/shared. No route hand-rolls a
// shape; the contract test in tests/server/envelope.test.ts walks every mounted route and rejects
// anything that isn't a well-formed single-wrap envelope. /health (server/index.ts) is the ONE
// bare exception (external liveness-probe contract).
//
// Stage 0 surface is deliberately tiny: pair/token (public), version, status, app/front. Everything
// else arrives via `extend` in later stages, under the same token guard and the same envelope.
import { Hono } from 'hono';
import type { Database } from 'better-sqlite3';
import { IDENTITY, PROTOCOL_VERSION, ok, err } from '@jat13/shared';

export interface ApiDeps {
  /** Stage 0 talks to the raw handle for pragma/counts; Stage 1 swaps in DAL projections. */
  db: Database;
  /** the sealed pairing token (server/pairing.ts) — the ONLY credential loopback callers present. */
  token: string;
  version: string;
  /** epoch-ms the process booted, for /api/status uptime. */
  startedAt: number;
  /** dev-drive (in-app remote-control test channel) is mounted — advertised on pair/token so the
   *  renderer starts its poller. */
  devtools?: boolean;
  /** show + focus the app window (popup "Open dashboard"); absent in headless tests. */
  frontWindow?: () => void;
  /** mount extra routes on the AUTHED /api sub-app (dev-drive now; Gmail/import/engine later
   *  stages). Runs BEFORE the enveloped 404 catch-all so extended routes always win. */
  extend?: (api: Hono) => void;
}

/** Tables the Stage-0 status card counts. Real DAL projections replace this in Stage 1. */
const COUNT_TABLES = ['jobs', 'applications', 'apply_runs'] as const;

/**
 * Counts stub: best-effort row counts for the skeleton's status surface. Existence-guarded so the
 * harness runs against a bare in-memory DB (contract tests) as well as the migrated schema-v1 file.
 * NOT the loud-on-unknown path — a missing table here is a boot-order concern owned by the
 * migration runner, not by a status read.
 */
function countsStub(db: Database): Record<string, number> {
  const has = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`);
  const out: Record<string, number> = {};
  for (const t of COUNT_TABLES) {
    // t comes from the const list above — never from input — so the interpolation is safe.
    out[t] = has.get(t) ? (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c : 0;
  }
  return out;
}

export function mountApi(app: Hono, deps: ApiDeps): void {
  // --- public: the loopback pairing hand-off (extension popup fetches the token on a user click).
  // Safe unauthenticated because the server binds 127.0.0.1 only — no remote page can reach it.
  const pub = new Hono();
  pub.get('/pair/token', (c) =>
    c.json(
      ok({
        token: deps.token,
        productName: IDENTITY.productName,
        version: deps.version,
        protocol: PROTOCOL_VERSION,
        devtools: deps.devtools === true,
      }),
    ),
  );
  app.route('/api', pub);

  // --- protected: everything else. The guard responds with the SAME envelope — an unauthorized
  // caller still gets a parseable {ok:false,error} body, never a bespoke shape.
  const api = new Hono();
  api.use('*', async (c, next) => {
    if (c.req.header(IDENTITY.authHeader) !== deps.token) {
      return c.json(err('unauthorized', `missing or invalid ${IDENTITY.authHeader} header`), 401);
    }
    await next();
  });

  api.get('/version', (c) => c.json(ok({ version: deps.version, protocol: PROTOCOL_VERSION })));

  // The skeleton's vitals: schema version proves migrations ran, stage pins what's built, counts
  // give Pierre's Stage-0 checklist a non-empty body to look at.
  api.get('/status', (c) => {
    const schema = deps.db.pragma('user_version', { simple: true }) as number;
    return c.json(
      ok({
        schema,
        version: deps.version,
        uptimeMs: Date.now() - deps.startedAt,
        stage: '0',
        counts: countsStub(deps.db),
      }),
    );
  });

  // popup "Open dashboard" → front + focus the tray-resident window (scar: closing the window used
  // to kill the brain entirely — 13.0.1's tray fix made "front" a real operation).
  api.post('/app/front', (c) => {
    deps.frontWindow?.();
    return c.json(ok({ fronted: typeof deps.frontWindow === 'function' }));
  });

  deps.extend?.(api); // extra authed routes (dev-drive at Stage 0; Gmail etc. later) mount here

  // Enveloped 404 LAST: an unknown /api path must answer in the envelope, not fall through to the
  // SPA fallback (a renderer typo returning index.html as "data" was exactly the silent-failure
  // class the post-mortem banned).
  api.all('*', (c) => c.json(err('not_found', `no such route: ${c.req.method} ${new URL(c.req.url).pathname}`), 404));

  app.route('/api', api);
}
