// runs DAL behavior tests — the GUARDS are the point (each rejection is a v11 production scar):
//  - illegal state transitions throw (run-fsm is the sole authority)
//  - submit WITHOUT evidence is refused by the row-level CHECK
//  - submit WITH evidence lands atomically and stamps finished_at
//  - setting state via patch is forbidden (callers must go through transition)
//  - the 500-step cap silently drops over-cap steps and never bumps steps_count
//  - slotCount counts ONLY slot-holding states

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { defaultContext, type DomainEvent } from '../../app/src/main/db/dal/util.js';
import { makeRunsDal, type RunsDal } from '../../app/src/main/db/dal/runs.js';

const T = 1_700_000_000_000; // fixed epoch-ms base

/** Seed the FK parent chain a run needs, returning ids. */
function seed(db: Database): { profileId: string; jobId: string; applId: string } {
  const profileId = 'prof_1';
  const jobId = 'job_1';
  const applId = 'appl_1';
  db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
    .run(profileId, 'Pierre', T, T);
  db.prepare('INSERT INTO jobs (id, source, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(jobId, 'linkedin', T, T, T, T);
  db.prepare('INSERT INTO applications (id, job_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(applId, jobId, profileId, T, T);
  return { profileId, jobId, applId };
}

/** Insert a SECOND application (job2) so a run can be enqueued independently. */
function seedSecond(db: Database): { jobId: string; applId: string } {
  db.prepare('INSERT INTO jobs (id, source, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('job_2', 'indeed', T, T, T, T);
  db.prepare('INSERT INTO applications (id, job_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('appl_2', 'job_2', 'prof_1', T, T);
  return { jobId: 'job_2', applId: 'appl_2' };
}

describe('runs DAL', () => {
  let db: Database;
  let dal: RunsDal;
  let clock: number;
  let events: DomainEvent[];

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    seed(db);
    clock = T;
    events = [];
    const ctx = { ...defaultContext(db, (e) => events.push(e)), now: () => clock };
    dal = makeRunsDal(ctx);
  });
  afterEach(() => db.close());

  function enqueueRun() {
    return dal.enqueue('appl_1', { source: 'linkedin', lane: 'linkedin', jobId: 'job_1', profileId: 'prof_1' });
  }

  it('enqueue inserts a queued run with timestamps and emits an insert event', () => {
    const run = enqueueRun();
    expect(run.state).toBe('queued');
    expect(run.queued_at).toBe(T);
    expect(run.updated_at).toBe(T);
    expect(run.attempt).toBe(1);
    expect(run.mode).toBe('auto');
    expect(run.started_at).toBeNull();
    expect(run.finished_at).toBeNull();
    expect(events.at(-1)).toMatchObject({ table: 'apply_runs', op: 'insert', id: run.id });
  });

  it('enqueue carries adapter + mode overrides', () => {
    const run = dal.enqueue('appl_1', {
      source: 'greenhouse', lane: 'ats', jobId: 'job_1', profileId: 'prof_1',
      mode: 'review', adapterId: 'greenhouse-form', adapterVersion: 3,
    });
    expect(run.lane).toBe('ats');
    expect(run.mode).toBe('review');
    expect(run.adapter_id).toBe('greenhouse-form');
    expect(run.adapter_version).toBe(3);
  });

  it('a legal transition succeeds and stamps started_at on first slot-holding entry', () => {
    const run = enqueueRun();
    clock = T + 1000;
    const leased = dal.transition(run.id, 'leased');
    expect(leased.state).toBe('leased');
    expect(leased.started_at).toBe(T + 1000); // leased is slot-holding
    expect(leased.updated_at).toBe(T + 1000);
    // started_at is NOT overwritten on the next slot-holding entry
    clock = T + 2000;
    const nav = dal.transition(run.id, 'navigating');
    expect(nav.started_at).toBe(T + 1000);
    expect(events.at(-1)).toMatchObject({ op: 'update', id: run.id, patch: { state: 'navigating' } });
  });

  it('an illegal transition throws and leaves the row unchanged', () => {
    const run = enqueueRun();
    // queued -> submitted is not an edge
    expect(() => dal.transition(run.id, 'submitted')).toThrow(/illegal apply_run transition/);
    expect(dal.get(run.id)!.state).toBe('queued'); // unchanged
  });

  it('REFUSES submit without evidence (row-level CHECK), inside the transition', () => {
    const run = enqueueRun();
    dal.transition(run.id, 'leased');
    dal.transition(run.id, 'navigating');
    dal.transition(run.id, 'classifying');
    dal.transition(run.id, 'driving');
    dal.transition(run.id, 'verifying');
    // verifying -> submitted is a legal EDGE, but the CHECK rejects it with no evidence_kind
    expect(() => dal.transition(run.id, 'submitted')).toThrow(/CHECK constraint failed/);
    // the failed transaction rolled back — still verifying
    expect(dal.get(run.id)!.state).toBe('verifying');
  });

  it('REFUSES submit carrying only legacy_untrusted evidence', () => {
    const run = enqueueRun();
    for (const to of ['leased', 'navigating', 'classifying', 'driving', 'verifying'] as const) {
      dal.transition(run.id, to);
    }
    expect(() =>
      dal.transition(run.id, 'submitted', { evidence_kind: 'legacy_untrusted' }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('ALLOWS submit with trustworthy evidence, atomically, and stamps finished_at', () => {
    const run = enqueueRun();
    for (const to of ['leased', 'navigating', 'classifying', 'driving', 'verifying'] as const) {
      dal.transition(run.id, to);
    }
    clock = T + 9999;
    const out = dal.recordSubmitted(run.id, {
      evidenceKind: 'text_became_success',
      evidenceJson: { verification: 'verified', matched: 'application sent' },
    });
    expect(out.state).toBe('submitted');
    expect(out.evidence_kind).toBe('text_became_success');
    expect(out.evidence).toEqual({ verification: 'verified', matched: 'application sent' });
    expect(out.finished_at).toBe(T + 9999);
  });

  it('records park terminal state with finished_at and park fields', () => {
    const run = enqueueRun();
    for (const to of ['leased', 'navigating', 'classifying'] as const) dal.transition(run.id, to);
    clock = T + 5000;
    const parked = dal.transition(run.id, 'parked', { park_kind: 'account_wall', park_detail: 'login required' });
    expect(parked.state).toBe('parked');
    expect(parked.park_kind).toBe('account_wall');
    expect(parked.finished_at).toBe(T + 5000);
  });

  it('resume edge waiting_page -> classifying increments resume_count', () => {
    const run = enqueueRun();
    for (const to of ['leased', 'navigating', 'classifying', 'driving'] as const) dal.transition(run.id, to);
    dal.transition(run.id, 'waiting_page');
    const resumed = dal.transition(run.id, 'classifying');
    expect(resumed.resume_count).toBe(1);
    dal.transition(run.id, 'waiting_page');
    const again = dal.transition(run.id, 'queued'); // also a resume edge
    expect(again.resume_count).toBe(2);
  });

  it('setting state via patch throws (must use transition)', () => {
    const run = enqueueRun();
    expect(() => dal.patch(run.id, { state: 'leased' } as unknown as Record<string, unknown>)).toThrow(
      /cannot set state/,
    );
    expect(dal.get(run.id)!.state).toBe('queued');
  });

  it('patch writes non-state fields and refuses non-patchable columns', () => {
    const run = enqueueRun();
    clock = T + 100;
    const patched = dal.patch(run.id, { page_key: 'apply_fullpage', cmd_seq: 4, attempt: 2 });
    expect(patched.page_key).toBe('apply_fullpage');
    expect(patched.cmd_seq).toBe(4);
    expect(patched.attempt).toBe(2);
    expect(patched.updated_at).toBe(T + 100);
    // serializes pending_questions_json
    const withQ = dal.patch(run.id, { pending_questions_json: [{ qid: 'q1', question: 'years?' }] });
    expect(withQ.pending_questions).toEqual([{ qid: 'q1', question: 'years?' }]);
    // a real column that isn't on the whitelist is refused
    expect(() => dal.patch(run.id, { resume_count: 9 } as Record<string, unknown>)).toThrow(/not patchable/);
  });

  it('addStep inserts a step and bumps step_seq + steps_count', () => {
    const run = enqueueRun();
    const s1 = dal.addStep(run.id, { phase: 'open', action: 'navigate', ok: true });
    expect(s1).not.toBeNull();
    expect(s1!.seq).toBe(1);
    const s2 = dal.addStep(run.id, { phase: 'fill', target: 'email', ok: true });
    expect(s2!.seq).toBe(2);
    const after = dal.get(run.id)!;
    expect(after.step_seq).toBe(2);
    expect(after.steps_count).toBe(2);
    expect(dal.getSteps(run.id).map((s) => s.seq)).toEqual([1, 2]);
  });

  it('addStep beyond the 500 cap does NOT bump steps_count', () => {
    const run = enqueueRun();
    // fast-forward the cursor to 500 directly, then insert the 500th (allowed) and 501st (ignored)
    db.prepare('UPDATE apply_runs SET step_seq = 499 WHERE id = ?').run(run.id);
    const s500 = dal.addStep(run.id, { phase: 'fill' }); // seq 500 — allowed
    expect(s500).not.toBeNull();
    expect(s500!.seq).toBe(500);
    const s501 = dal.addStep(run.id, { phase: 'fill' }); // seq 501 — trigger RAISE(IGNORE)
    expect(s501).toBeNull();
    const after = dal.get(run.id)!;
    // cursor still advanced past the cap, but steps_count only counts the real row
    expect(after.step_seq).toBe(501);
    expect(after.steps_count).toBe(1);
    const n = db.prepare('SELECT COUNT(*) c FROM apply_run_steps WHERE run_id = ?').get(run.id) as { c: number };
    expect(n.c).toBe(1);
  });

  it('slotCount counts ONLY slot-holding states in the lane', () => {
    const a = enqueueRun(); // linkedin lane
    // queued does NOT hold a slot
    expect(dal.slotCount('linkedin')).toBe(0);
    dal.transition(a.id, 'leased'); // slot-holding
    expect(dal.slotCount('linkedin')).toBe(1);
    dal.transition(a.id, 'navigating');
    dal.transition(a.id, 'classifying');
    dal.transition(a.id, 'needs_human'); // parked — NOT slot-holding (slot released)
    expect(dal.slotCount('linkedin')).toBe(0);

    // a second run on a DIFFERENT lane isn't counted for linkedin
    seedSecond(db);
    const b = dal.enqueue('appl_2', { source: 'indeed', lane: 'indeed', jobId: 'job_2', profileId: 'prof_1' });
    dal.transition(b.id, 'leased');
    expect(dal.slotCount('linkedin')).toBe(0);
    expect(dal.slotCount('indeed')).toBe(1);
  });

  it('listLean filters + paginates and never ships evidence blobs', () => {
    const a = enqueueRun();
    for (const to of ['leased', 'navigating', 'classifying', 'driving', 'verifying'] as const) {
      dal.transition(a.id, to);
    }
    dal.recordSubmitted(a.id, { evidenceKind: 'url_confirmation', evidenceJson: { url: 'x' } });
    seedSecond(db);
    const b = dal.enqueue('appl_2', { source: 'indeed', lane: 'indeed', jobId: 'job_2', profileId: 'prof_1' });
    dal.transition(b.id, 'leased');

    const all = dal.listLean();
    expect(all.total).toBe(2);
    expect(all.rows).toHaveLength(2);
    // lean rows carry no evidence/pending columns
    expect(all.rows[0]).not.toHaveProperty('evidence_json');
    expect(all.rows[0]).not.toHaveProperty('pending_questions');

    const onlyLinkedin = dal.listLean({ lane: 'linkedin' });
    expect(onlyLinkedin.total).toBe(1);
    expect(onlyLinkedin.rows[0]!.id).toBe(a.id);

    const onlyLeased = dal.listLean({ state: 'leased' });
    expect(onlyLeased.total).toBe(1);
    expect(onlyLeased.rows[0]!.id).toBe(b.id);
  });

  it('stats buckets by state within the trailing window', () => {
    const a = enqueueRun();
    dal.transition(a.id, 'leased');
    seedSecond(db);
    const b = dal.enqueue('appl_2', { source: 'indeed', lane: 'indeed', jobId: 'job_2', profileId: 'prof_1' });

    const s = dal.stats({ hours: 24 });
    expect(s.total).toBe(2);
    expect(s.byState.leased).toBe(1);
    expect(s.byState.queued).toBe(1);

    // an OLD run (queued 48h ago) falls outside a 24h window
    clock = T - 48 * 3_600_000;
    const old = dal.enqueue('appl_1', { source: 'linkedin', lane: 'linkedin', jobId: 'job_1', profileId: 'prof_1' });
    expect(old.queued_at).toBe(T - 48 * 3_600_000);
    clock = T;
    const s2 = dal.stats({ hours: 24 });
    expect(s2.total).toBe(2); // the old one is excluded

    const laneScoped = dal.stats({ hours: 24, lane: 'indeed' });
    expect(laneScoped.total).toBe(1);
    expect(laneScoped.byState.queued).toBe(1);
  });

  it('reclaimStranded requeues waiting_page runs with attempts left, fails exhausted ones', () => {
    // run A: attempt 1, stranded → requeued
    const a = enqueueRun();
    for (const to of ['leased', 'navigating', 'classifying', 'driving'] as const) dal.transition(a.id, to);
    dal.transition(a.id, 'waiting_page');
    // run B: attempt 3, stranded → failed
    seedSecond(db);
    const b = dal.enqueue('appl_2', { source: 'indeed', lane: 'indeed', jobId: 'job_2', profileId: 'prof_1' });
    dal.patch(b.id, { attempt: 3 });
    for (const to of ['leased', 'navigating', 'classifying', 'driving'] as const) dal.transition(b.id, to);
    dal.transition(b.id, 'waiting_page');

    // advance the clock so both are older than the TTL
    clock = T + 200_000;
    const reclaimed = dal.reclaimStranded({ ttlMs: 120_000 });
    expect(reclaimed).toBe(2);
    expect(dal.get(a.id)!.state).toBe('queued');
    expect(dal.get(a.id)!.resume_count).toBe(1); // requeue is a resume edge
    expect(dal.get(b.id)!.state).toBe('failed');
    expect(dal.get(b.id)!.error).toBe('waiting_page TTL exhausted');
  });

  it('reclaimStranded ignores fresh waiting_page runs inside the TTL', () => {
    const a = enqueueRun();
    for (const to of ['leased', 'navigating', 'classifying', 'driving'] as const) dal.transition(a.id, to);
    dal.transition(a.id, 'waiting_page');
    clock = T + 1000; // well inside a 120s TTL
    expect(dal.reclaimStranded({ ttlMs: 120_000 })).toBe(0);
    expect(dal.get(a.id)!.state).toBe('waiting_page');
  });
});
