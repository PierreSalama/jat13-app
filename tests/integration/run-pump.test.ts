// The enqueue pump — the piece whose absence made auto-apply do NOTHING (the driver had an empty queue
// forever). These lock in that pump() turns eligible applications into queued runs, and ONLY eligible
// ones: adapter-supported host, still Saved (never applied), no existing run, real URL, under the target.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { loadBuiltins, makeRegistry } from '../../app/src/main/adapters/registry.js';
import { makeRunService } from '../../app/src/main/engine/run-service.js';
import type { RunGateway } from '../../app/src/main/engine/gateway.js';

const fakeSealer: Sealer = { available: () => true, seal: (p) => Buffer.from(p), open: (b) => Buffer.from(b).toString() };
// pump() never touches the gateway (it only enqueues) — a throwing stub proves that.
const unusedGateway = { command: () => Promise.reject(new Error('gateway must not be called by pump')) } as unknown as RunGateway;

let db: Database;
let dal: Dal;

beforeEach(() => {
  ({ db } = openDatabase({ file: ':memory:' }));
  dal = makeDal(defaultContext(db), { sealer: fakeSealer });
  db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?,?,1,?,?)').run('p1', 'Pierre', 1, 1);
  const ji = db.prepare('INSERT INTO jobs (id, source, title, company, job_url, norm_key, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const ai = db.prepare('INSERT INTO applications (id, job_id, profile_id, status, submitted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
  // eligible — adapter-supported hosts, Saved, never applied, no run
  ji.run('jL', 'linkedin', 'Eng', 'Co', 'https://www.linkedin.com/jobs/view/123', 'kL', 1, 1, 1, 1);
  ai.run('aL', 'jL', 'p1', 'tracked', null, 1, 1);
  ji.run('jI', 'indeed', 'Eng', 'Co', 'https://ca.indeed.com/viewjob?jk=abc', 'kI', 1, 1, 1, 1);
  ai.run('aI', 'jI', 'p1', 'tracked', null, 1, 1);
  // ineligible — no adapter for this host
  ji.run('jX', 'other', 'Eng', 'Co', 'https://example.com/job/1', 'kX', 1, 1, 1, 1);
  ai.run('aX', 'jX', 'p1', 'tracked', null, 1, 1);
  // ineligible — already applied (has a submit timestamp)
  ji.run('jS', 'linkedin', 'Eng', 'Co', 'https://www.linkedin.com/jobs/view/999', 'kS', 1, 1, 1, 1);
  ai.run('aS', 'jS', 'p1', 'tracked', 5, 1, 1);
  // ineligible — no URL to drive
  ji.run('jN', 'linkedin', 'Eng', 'Co', '', 'kN', 1, 1, 1, 1);
  ai.run('aN', 'jN', 'p1', 'tracked', null, 1, 1);
});
afterEach(() => db.close());

function svc(queueTarget: number) {
  return makeRunService({ dal, gateway: unusedGateway, registry: makeRegistry(loadBuiltins()), queueTarget });
}

describe('run-service pump (auto-apply queue populator)', () => {
  it('enqueues ONLY eligible applications (host+applied+url filters), with the right lane', () => {
    const n = svc(20).pump();
    expect(n).toBe(2); // jL + jI only — jX (no adapter), jS (applied), jN (no url) excluded
    const queued = dal.runs.listLean({ state: 'queued', limit: 50 });
    expect(queued.total).toBe(2);
    expect(queued.rows.map((r) => r.job_id).sort()).toEqual(['jI', 'jL']);
    const byJob = Object.fromEntries(queued.rows.map((r) => [r.job_id, r]));
    expect(byJob['jL']?.lane).toBe('linkedin');
    expect(byJob['jI']?.lane).toBe('indeed');
  });

  it('does NOT double-enqueue an application that already has a run', () => {
    const s = svc(20);
    expect(s.pump()).toBe(2);
    expect(s.pump()).toBe(0); // both eligible apps now have a queued run
    expect(dal.runs.listLean({ state: 'queued', limit: 50 }).total).toBe(2);
  });

  it('stops topping up at queueTarget', () => {
    const ji = db.prepare('INSERT INTO jobs (id, source, title, company, job_url, norm_key, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const ai = db.prepare('INSERT INTO applications (id, job_id, profile_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)');
    for (let i = 0; i < 10; i++) {
      ji.run(`j${i}`, 'linkedin', 'E', 'C', `https://www.linkedin.com/jobs/view/${i}`, `k${i}`, 1, 1, 1, 1);
      ai.run(`a${i}`, `j${i}`, 'p1', 'tracked', 1, 1);
    }
    expect(svc(3).pump()).toBe(3); // capped at the target, not all 12 eligible
    expect(dal.runs.listLean({ state: 'queued', limit: 50 }).total).toBe(3);
  });
});
