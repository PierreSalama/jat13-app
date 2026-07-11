// Stage-3 SCHEDULER tests — the engine laws proven headlessly (engine-knowledge §2, §3, §1.83, ★dismiss).
// The Stage-2 single-apply glue is covered by run-service.test.ts; here we prove what the SCHEDULER adds
// around the same driveRun spine:
//   • pump enqueues ONLY eligible applications (excludes dismissed, below-floor, over-cap, no-adapter),
//     best-fit-first, per-lane target;
//   • the apply_ledger cap stops a lane at 45 (pump won't feed it, driveNext won't drive it);
//   • the SERIAL invariant — one foreground token, never two concurrent drives (the freeze scar);
//   • the per-lane BREAKER pauses ONE lane after N failures while the others keep going.
// Everything runs against an in-memory DAL + custom adapters + a scripted RunGateway (no real browser).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { PageSnapshot, Cmd, CmdResult } from '@jat13/shared/protocol';
import { parseAdapter } from '../../app/src/main/adapters/schema.js';
import { makeRegistry } from '../../app/src/main/adapters/registry.js';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { makeRunService, LINKEDIN_DAILY_CAP, type FitPort } from '../../app/src/main/engine/run-service.js';
import type { RunGateway } from '../../app/src/main/engine/gateway.js';

const fakeSealer: Sealer = { available: () => true, seal: (p) => Buffer.from(p), open: (b) => Buffer.from(b).toString() };

// A gateway that must NEVER be touched — proves pump() drives nothing (it only reads the DB).
const noGateway = {
  command: () => Promise.reject(new Error('gateway must not be called during pump')),
  awaitResume: () => Promise.reject(new Error('no resume')),
} as unknown as RunGateway;

// ---- two tiny adapters: LinkedIn (fails on navigate) + a greenhouse ATS lane (parks cleanly) --------
const LI = parseAdapter({
  id: 'li-test', version: 1, engineMin: '1.0.0', source: 'linkedin',
  hosts: ['*.linkedin.com'], priority: 100,
  pages: [{ key: 'form', kind: 'form', classify: { any: [{ url: '/jobs/view/' }] }, next: [] }],
  advance: { labels: ['^continue$'], finalLabels: ['^submit application$'], neverLabels: [], disabledIsWaiting: true, waitEnabledMs: 100 },
  oracles: { success: [], failure: [], humanGate: [] },
  limits: { maxSteps: 3 },
});
const ATS = parseAdapter({
  id: 'ats-test', version: 1, engineMin: '1.0.0', source: 'greenhouse',
  hosts: ['*.greenhouse.io'], priority: 100,
  pages: [{ key: 'landing', kind: 'review', classify: { any: [{ url: 'greenhouse' }] }, next: [] }],
  advance: { labels: ['^submit$'], finalLabels: ['^submit$'], neverLabels: [], disabledIsWaiting: true, waitEnabledMs: 100 },
  oracles: { success: [], failure: [], humanGate: [] },
  limits: { maxSteps: 5 },
});
const registry = makeRegistry([LI, ATS]);

/** greenhouse landing snapshot with NO advance button → the runner parks 'stuck_step:no_advance'. */
function atsSnap(): PageSnapshot {
  return {
    v: 1, epoch: 'ep0', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'GH',
    readyState: 'complete', quietMs: 900,
    frames: [{ framePath: '', frameHost: 'boards.greenhouse.io', nodes: [] }], truncated: false, hash: 'ats',
  };
}

/** LinkedIn navigate throws (a transport death that ISN'T a clean resume) → the run fails; the greenhouse
 *  lane drives to a clean park. So linkedin is the "sick" lane and ats is the "healthy" one. */
class LaneGateway implements RunGateway {
  async command(_runId: string, _epoch: string, cmd: Cmd): Promise<CmdResult> {
    if (cmd.op === 'navigate') {
      if (/linkedin/i.test(cmd.url)) throw new Error('linkedin transport boom');
      return { ok: true, snapshotDelta: atsSnap() };
    }
    return { ok: true, snapshotDelta: atsSnap() };
  }
  async awaitResume(): Promise<never> {
    throw new Error('no resume in scheduler tests');
  }
}

let db: Database;
let dal: Dal;

beforeEach(() => {
  ({ db } = openDatabase({ file: ':memory:' }));
  dal = makeDal(defaultContext(db), { sealer: fakeSealer });
  db.prepare('INSERT INTO profiles (id, name, is_default, data_json, created_at, updated_at) VALUES (?,?,1,?,?,?)').run('p1', 'Pierre', '{}', 1, 1);
});
afterEach(() => db.close());

interface SeedOpts {
  source: string;
  url: string;
  normKey?: string;
  urlNorm?: string;
  companyKey?: string;
  dismissedAt?: number | null;
  lastSeen?: number;
}
function seedApp(appId: string, o: SeedOpts): void {
  db.prepare(
    'INSERT INTO jobs (id, source, title, company, company_key, job_url, job_url_norm, norm_key, dismissed_at, first_seen_at, last_seen_at, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(`job_${appId}`, o.source, 'Engineer', 'Co', o.companyKey ?? '', o.url, o.urlNorm ?? '', o.normKey ?? '', o.dismissedAt ?? null, 1, o.lastSeen ?? 1, 1, 1);
  db.prepare('INSERT INTO applications (id, job_id, profile_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(appId, `job_${appId}`, 'p1', 'tracked', 1, 1);
}

/** enqueue N ledger rows in a lane by pointing them at one real run of that lane (the cap join reads the
 *  run's lane; COUNT of ledger rows in-window is the authority). */
function seedLedger(lane: 'linkedin' | 'indeed' | 'ats', source: string, url: string, n: number): void {
  seedApp(`led_${lane}`, { source, url });
  const run = dal.runs.enqueue(`led_${lane}`, { source, lane, jobId: `job_led_${lane}`, profileId: 'p1' });
  const ins = db.prepare("INSERT INTO apply_ledger (run_id, source, account_key, submitted_at) VALUES (?, ?, 'default', ?)");
  for (let i = 0; i < n; i++) ins.run(run.id, source, Date.now());
}

// ---------------------------------------------------------------------------------------------------
describe('scheduler · pump eligibility (★ the dismiss scar + floor + adapter gate)', () => {
  it('enqueues ONLY eligible apps — excludes dismissed, below-floor, and no-adapter', () => {
    const FIT: Record<string, number> = { job_a_eli: 80, job_a_low: 20, job_a_dis: 80, job_a_dk: 80, job_a_na: 80 };
    const fit: FitPort = { scoreFor: (jobId) => FIT[jobId] ?? null, floor: () => 50 };

    seedApp('a_eli', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/1', normKey: 'nk-eli' }); // ✓ eligible
    seedApp('a_low', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/2', normKey: 'nk-low' }); // ✗ fit 20 < floor 50
    seedApp('a_dis', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/3', normKey: 'nk-dis', dismissedAt: 1 }); // ✗ jobs.dismissed_at
    seedApp('a_dk', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/4', normKey: 'nk-dk' }); // ✗ permanent dismissal
    db.prepare("INSERT INTO dismissals (dismiss_key, job_id, reason, dismissed_at) VALUES (?,?,'user',?)").run('nk:nk-dk', 'job_a_dk', 1);
    seedApp('a_na', { source: 'other', url: 'https://example.com/careers/1', normKey: 'nk-na' }); // ✗ no adapter for host

    const enq = makeRunService({ dal, gateway: noGateway, registry, fit }).pump();

    expect(enq).toBe(1);
    const queued = dal.runs.listLean({ state: 'queued' });
    expect(queued.total).toBe(1);
    expect(queued.rows[0]!.application_id).toBe('a_eli');
    // the excluded four never spawned a run
    for (const id of ['a_low', 'a_dis', 'a_dk', 'a_na']) {
      expect(dal.runs.listLean({ applicationId: id }).total).toBe(0);
    }
  });

  it('a permanently-dismissed posting can NEVER be re-queued — even keyed by url or company', () => {
    const fit: FitPort = { scoreFor: () => 90, floor: () => 0 };
    seedApp('a_url', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/9', urlNorm: 'https://www.linkedin.com/jobs/view/9' });
    seedApp('a_co', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/10', companyKey: 'acme inc' });
    db.prepare("INSERT INTO dismissals (dismiss_key, job_id, reason, dismissed_at) VALUES (?,?,'irrelevant',?)").run('url:https://www.linkedin.com/jobs/view/9', 'job_a_url', 1);
    db.prepare("INSERT INTO dismissals (dismiss_key, job_id, reason, dismissed_at) VALUES (?,?,'off_target',?)").run('co:acme inc', 'job_a_co', 1);

    expect(makeRunService({ dal, gateway: noGateway, registry, fit }).pump()).toBe(0);
    expect(dal.runs.listLean({ state: 'queued' }).total).toBe(0);
  });

  it('orders best-fit-first and tops each lane only to its target', () => {
    const FIT: Record<string, number> = { job_a_hi: 90, job_a_lo: 60 };
    const fit: FitPort = { scoreFor: (jobId) => FIT[jobId] ?? null, floor: () => 0 };
    seedApp('a_hi', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/5', normKey: 'nk-hi', lastSeen: 5 });
    seedApp('a_lo', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/6', normKey: 'nk-lo', lastSeen: 9 }); // fresher, but lower fit

    // per-lane target 1 → only the single BEST-fit linkedin app is enqueued (fit beats freshness).
    const enq = makeRunService({ dal, gateway: noGateway, registry, fit, queueTarget: 1 }).pump();
    expect(enq).toBe(1);
    const queued = dal.runs.listLean({ state: 'queued' });
    expect(queued.total).toBe(1);
    expect(queued.rows[0]!.application_id).toBe('a_hi');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('scheduler · caps (apply_ledger is the 45/24h authority — §2.2)', () => {
  it('LINKEDIN_DAILY_CAP is 45', () => {
    expect(LINKEDIN_DAILY_CAP).toBe(45);
  });

  it('a lane at 45 submits is skipped by BOTH driveNext and pump; uncapped lanes still flow', async () => {
    seedLedger('linkedin', 'linkedin', 'https://www.linkedin.com/jobs/view/led', LINKEDIN_DAILY_CAP); // 45 submits today
    const sched = makeRunService({ dal, gateway: noGateway, registry });

    const st = sched.state();
    expect(st.lanes.linkedin.submittedToday).toBe(45);
    expect(st.lanes.linkedin.capRemaining).toBe(0);
    expect(st.lanes.ats.capRemaining).toBeNull(); // uncapped

    // the one queued linkedin run (the ledger holder) must NOT be driven — the account cap is absolute.
    // (noGateway throws if a drive ever starts, so a clean null return proves nothing was driven.)
    const outcome = await sched.driveNext();
    expect(outcome).toBeNull();
    expect(dal.runs.listLean({ state: 'queued', lane: 'linkedin' }).total).toBe(1); // still queued, never leased
  });

  it('pump refuses to feed a capped lane but still feeds an uncapped one', () => {
    seedLedger('linkedin', 'linkedin', 'https://www.linkedin.com/jobs/view/led', LINKEDIN_DAILY_CAP);
    seedApp('a_li', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/20', normKey: 'nk-li' }); // linkedin, capped → skip
    seedApp('a_gh', { source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/20', normKey: 'nk-gh' }); // ats, uncapped → feed

    makeRunService({ dal, gateway: noGateway, registry }).pump();

    expect(dal.runs.listLean({ applicationId: 'a_li' }).total).toBe(0); // capped lane not fed
    expect(dal.runs.listLean({ applicationId: 'a_gh' }).total).toBe(1); // uncapped lane fed
  });
});

// ---------------------------------------------------------------------------------------------------
describe('scheduler · serial pacing (ONE foreground token — the freeze scar §3.1)', () => {
  it('never runs two drives at once: a second driveNext no-ops while the first holds the token', async () => {
    seedApp('a_g1', { source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', normKey: 'g1' });
    seedApp('a_g2', { source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/2', normKey: 'g2' });
    const r1 = dal.runs.enqueue('a_g1', { source: 'greenhouse', lane: 'ats', jobId: 'job_a_g1', profileId: 'p1' });
    const r2 = dal.runs.enqueue('a_g2', { source: 'greenhouse', lane: 'ats', jobId: 'job_a_g2', profileId: 'p1' });
    const sched = makeRunService({ dal, gateway: new LaneGateway(), registry });

    const p1 = sched.driveNext(); // acquires the token synchronously, then suspends on navigate
    const second = await sched.driveNext(); // token held → returns null WITHOUT starting a drive
    const first = await p1;

    expect(second).toBeNull();
    expect(first?.state).toBe('parked'); // the first actually drove to a terminal
    // exactly one drove, the other stayed queued — proof no second drive ever started
    const states = [dal.runs.get(r1.id)!.state, dal.runs.get(r2.id)!.state].sort();
    expect(states).toEqual(['parked', 'queued']);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('scheduler · per-lane breaker (source-scoped — §1.83)', () => {
  it('pauses ONLY the failing lane after N failures; the other lane keeps driving', async () => {
    // three linkedin runs (each fails on navigate) with a threshold of 3 → linkedin trips.
    seedApp('a_l1', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/1', normKey: 'l1' });
    seedApp('a_l2', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/2', normKey: 'l2' });
    seedApp('a_l3', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/3', normKey: 'l3' });
    dal.runs.enqueue('a_l1', { source: 'linkedin', lane: 'linkedin', jobId: 'job_a_l1', profileId: 'p1' });
    dal.runs.enqueue('a_l2', { source: 'linkedin', lane: 'linkedin', jobId: 'job_a_l2', profileId: 'p1' });
    dal.runs.enqueue('a_l3', { source: 'linkedin', lane: 'linkedin', jobId: 'job_a_l3', profileId: 'p1' });

    const sched = makeRunService({ dal, gateway: new LaneGateway(), registry, breakerThreshold: 3 });
    await sched.driveNext();
    await sched.driveNext();
    await sched.driveNext(); // 3rd consecutive linkedin failure → lane pauses

    expect(sched.state().lanes.linkedin.breaker.paused).toBe(true);
    expect(sched.state().lanes.linkedin.breaker.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(sched.state().lanes.ats.breaker.paused).toBe(false);

    // now a still-queued linkedin run + a fresh ats run: driveNext must SKIP the paused linkedin lane
    // and drive the ats one (the other lanes keep going).
    seedApp('a_l4', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/4', normKey: 'l4' });
    seedApp('a_a1', { source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', normKey: 'a1' });
    const l4 = dal.runs.enqueue('a_l4', { source: 'linkedin', lane: 'linkedin', jobId: 'job_a_l4', profileId: 'p1' });
    const a1 = dal.runs.enqueue('a_a1', { source: 'greenhouse', lane: 'ats', jobId: 'job_a_a1', profileId: 'p1' });

    const outcome = await sched.driveNext();
    expect(outcome?.state).toBe('parked'); // the ats run drove
    expect(dal.runs.get(a1.id)!.state).toBe('parked');
    expect(dal.runs.get(l4.id)!.state).toBe('queued'); // paused linkedin run never leased
  });
});
