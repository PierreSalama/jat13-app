import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { discoverMigrations } from '../../app/src/main/db/migrate.js';
import { createApp, startServer, type HealthBody, type RunningServer } from '../../app/src/main/server/index.js';

const TOP = discoverMigrations().length; // schema version a fresh DB migrates to

describe('/health', () => {
  let db: Database;
  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
  });
  afterEach(() => db.close());

  it('reports liveness with the migrated schema version (in-process)', async () => {
    const app = createApp({ db, version: '13.0.0', startedAt: Date.now() - 5, dev: true });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.ok).toBe(true);
    expect(body.name).toBe('JAT 13');
    expect(body.version).toBe('13.0.0');
    expect(body.protocol).toBe(1);
    expect(body.schema).toBe(TOP); // all migrations applied
    expect(body.dev).toBe(true);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(body.pid).toBe(process.pid);
  });

  it('serves over a real loopback socket — the M0 boot spine end-to-end', async () => {
    // Exercises the exact modules main.ts wires: migrated DB + a real bound socket + HTTP fetch.
    let running: RunningServer | undefined;
    try {
      running = await startServer({ db, version: '13.0.0', startedAt: Date.now(), dev: true }, 0); // ephemeral port
      expect(running.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${running.port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HealthBody;
      expect(body.ok).toBe(true);
      expect(body.schema).toBe(TOP);
    } finally {
      await running?.close();
    }
  });
});
