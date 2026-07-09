// Proves the 8 DAL modules COMPOSE through the single makeDal() surface — one shared context, one
// emit sink — by walking a job all the way to a verified submit and asserting every module + the
// PatchBus emissions line up. If any module drifts from the shared conventions, this breaks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type DomainEvent, type Sealer } from '../../app/src/main/db/dal/index.js';

const T = 1_800_000_000_000;
const fakeSealer: Sealer = {
  available: () => true,
  seal: (p) => Buffer.from(p, 'utf8'),
  open: (b) => Buffer.from(b).toString('utf8'),
};

describe('DAL aggregate (makeDal composition)', () => {
  let db: Database;
  let dal: Dal;
  let emitted: DomainEvent[];

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    emitted = [];
    const ctx = defaultContext(db, (e) => emitted.push(e));
    dal = makeDal(ctx, { sealer: fakeSealer });
    db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?,?,1,?,?)')
      .run('p1', 'Pierre', T, T);
  });
  afterEach(() => db.close());

  it('drives a job → application → run to a verified submit, with an honest event trail', () => {
    const { job } = dal.jobs.upsert({
      source: 'linkedin',
      job_url: 'https://linkedin.com/jobs/view/123',
      title: 'Senior Engineer',
      company: 'Aurora Labs',
    });
    const appl = dal.applications.ensure(job.id, 'p1');
    expect(appl.status).toBe('tracked');

    const run = dal.runs.enqueue(appl.id, { source: 'linkedin', lane: 'linkedin', jobId: job.id, profileId: 'p1' });
    expect(run.state).toBe('queued');

    // walk the legal FSM path to a verified submit
    dal.runs.transition(run.id, 'leased');
    dal.runs.transition(run.id, 'navigating');
    dal.runs.transition(run.id, 'classifying');
    dal.runs.transition(run.id, 'driving');
    dal.runs.transition(run.id, 'verifying');
    const submitted = dal.runs.recordSubmitted(run.id, {
      evidenceKind: 'text_became_success',
      evidenceJson: JSON.stringify({ reason: 'confirmation page' }),
    });
    expect(submitted.state).toBe('submitted');
    expect(submitted.finished_at).toBeGreaterThan(0);

    // application status follows, forward-only
    dal.applications.elevate(appl.id, 'submitted', 'auto');
    dal.events.record({ kind: 'submitted', applicationId: appl.id, jobId: job.id, runId: run.id, source: 'linkedin' });

    // slot is released (submitted is terminal, not slot-holding)
    expect(dal.runs.slotCount('linkedin')).toBe(0);
    // durable timeline
    const timeline = dal.events.timeline(appl.id);
    expect(timeline.rows.some((e) => e.kind === 'submitted')).toBe(true);
    // PatchBus saw writes from every module we touched
    const tables = new Set(emitted.map((e) => e.table));
    expect(tables.has('jobs')).toBe(true);
    expect(tables.has('applications')).toBe(true);
    expect(tables.has('apply_runs')).toBe(true);
    expect(tables.has('events')).toBe(true);
  });

  it('an illegal FSM jump is refused across the aggregate', () => {
    const { job } = dal.jobs.upsert({ source: 'linkedin', job_url: 'https://x/y', title: 'T', company: 'C' });
    const appl = dal.applications.ensure(job.id, 'p1');
    const run = dal.runs.enqueue(appl.id, { source: 'linkedin', lane: 'linkedin', jobId: job.id, profileId: 'p1' });
    expect(() => dal.runs.transition(run.id, 'submitted')).toThrow(); // queued -> submitted is illegal
  });

  it('secrets seal/open round-trips and never leaks plaintext through health()', () => {
    dal.secrets.seal('gmail.oauth', 'super-secret-token');
    expect(dal.secrets.open('gmail.oauth')).toBe('super-secret-token');
    const health = dal.secrets.health();
    const row = health.find((h) => h.key === 'gmail.oauth');
    expect(row?.status).toBe('ok');
    expect(JSON.stringify(health)).not.toContain('super-secret-token');
  });

  it('settings round-trip through the registry; answers respect the sensitive guard', () => {
    dal.settings.set('autoApply', 'maxPerDay', 30);
    expect(dal.settings.getKey('autoApply', 'maxPerDay')).toBe(30);

    const ok = dal.answers.record('p1', { kind: 'qa', label: 'Are you authorized to work in Canada?', value: 'Yes' });
    expect(ok).not.toBeNull();
    expect(dal.answers.lookup('p1', ok!.key_norm)?.value).toBe('Yes');

    const sensitive = dal.answers.record('p1', { kind: 'qa', label: 'What is your gender?', value: 'x' });
    expect(sensitive).toBeNull(); // EEO/demographic never stored
  });
});
