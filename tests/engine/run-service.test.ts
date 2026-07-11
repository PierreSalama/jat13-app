// run-service (Stage-2 single-apply) glue tests. The DRIVE truthfulness (submit-only-with-evidence,
// kill-mid-run → truthful terminal) is proven by survival.test.ts against driveRun directly; here we
// prove what run-service ADDS around it: applyOne enqueues a real run, an unsupported host is an honest
// skip that still writes an autopsy, and requeue guards on the parked state. No gateway dance needed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { makeRegistry, loadBuiltins } from '../../app/src/main/adapters/registry.js';
import { makeRunService } from '../../app/src/main/engine/run-service.js';
import type { RunGateway } from '../../app/src/main/engine/gateway.js';

const fakeSealer: Sealer = { available: () => true, seal: (p) => Buffer.from(p), open: (b) => Buffer.from(b).toString() };
// the no-adapter skip path must NEVER reach the extension — a throwing gateway proves it.
const noGateway = {
  command: () => Promise.reject(new Error('gateway must not be called on a no-adapter skip')),
  awaitResume: () => Promise.reject(new Error('no resume')),
} as unknown as RunGateway;

let db: Database;
let dal: Dal;

beforeEach(() => {
  ({ db } = openDatabase({ file: ':memory:' }));
  dal = makeDal(defaultContext(db), { sealer: fakeSealer });
  db.prepare('INSERT INTO profiles (id, name, is_default, data_json, created_at, updated_at) VALUES (?,?,1,?,?,?)').run('p1', 'Pierre', '{}', 1, 1);
});
afterEach(() => db.close());

function seedApp(id: string, source: string, url: string): void {
  db.prepare('INSERT INTO jobs (id, source, title, company, job_url, norm_key, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    `job_${id}`, source, 'Engineer', 'Co', url, `nk_${id}`, 1, 1, 1, 1,
  );
  db.prepare('INSERT INTO applications (id, job_id, profile_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(id, `job_${id}`, 'p1', 'tracked', 1, 1);
}

function svc() {
  return makeRunService({ dal, gateway: noGateway, registry: makeRegistry(loadBuiltins()) });
}

async function waitTerminal(runId: string, ms = 2000): Promise<string> {
  const TERMINAL = new Set(['submitted', 'ready_for_review', 'parked', 'skipped', 'failed']);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = dal.runs.get(runId);
    if (r && TERMINAL.has(r.state)) return r.state;
    await new Promise((res) => setTimeout(res, 20));
  }
  return dal.runs.get(runId)?.state ?? 'gone';
}

describe('run-service applyOne (Stage 2 single-apply)', () => {
  it('enqueues a run with the source + lane derived from the job', async () => {
    seedApp('a_li', 'linkedin', 'https://www.linkedin.com/jobs/view/123');
    const { runId } = await svc().applyOne('a_li');
    const run = dal.runs.get(runId);
    expect(run).toBeTruthy();
    expect(run!.source).toBe('linkedin');
    expect(run!.lane).toBe('linkedin');
    expect(run!.application_id).toBe('a_li');
  });

  it('an unsupported host is an honest skip that writes an autopsy — never touches the extension', async () => {
    seedApp('a_x', 'other', 'https://example.com/careers/1');
    const { runId } = await svc().applyOne('a_x');
    expect(await waitTerminal(runId)).toBe('skipped');
    const autopsy = db.prepare('SELECT COUNT(*) c FROM autopsies WHERE run_id = ?').get(runId) as { c: number };
    expect(autopsy.c).toBe(1);
  });

  it('requeue only rescues a run that is actually parked for a human', async () => {
    seedApp('a_r', 'other', 'https://example.com/careers/2');
    const s = svc();
    const { runId } = await s.applyOne('a_r');
    await waitTerminal(runId); // ends 'skipped', not needs_human
    expect(await s.requeue(runId)).toBe(false);
    expect(await s.requeue('run_does_not_exist')).toBe(false);
  });

  it('applyOne throws on an unknown application', async () => {
    await expect(svc().applyOne('nope')).rejects.toThrow();
  });
});
