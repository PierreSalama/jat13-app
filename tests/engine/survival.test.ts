// THE M1 CHECKPOINT — the test that retires the architecture risk.
// A fake extension scripts a LinkedIn Easy Apply (job_view → open modal → fill email → continue →
// review → submit → confirmation). We KILL it mid-run (PortGoneError on the Continue click). The app
// must: park the run to waiting_page, wait for reconnect, RE-CLASSIFY the live page (email still
// filled — LinkedIn kept the draft), and drive on to a VERIFIED submit. No script replay; the
// classifier is the only source of position. This is what a 4k-line MV3 content script could never do.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { PageSnapshot, SnapNode, Cmd, CmdResult } from '@jat13/shared/protocol';
import { parseAdapter, type AdapterDoc } from '../../app/src/main/adapters/schema.js';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { driveRun, type ResolveControl } from '../../app/src/main/engine/runner.js';
import { PortGoneError, type RunGateway, type ResumeInfo } from '../../app/src/main/engine/gateway.js';

const JOB_URL = 'https://www.linkedin.com/jobs/view/123';

const ADAPTER: AdapterDoc = parseAdapter({
  id: 'linkedin-easy-apply', version: 1, engineMin: '1.0.0', source: 'linkedin',
  hosts: ['*.linkedin.com'], priority: 100,
  pages: [
    { key: 'job_view', kind: 'jobView',
      classify: { all: [{ url: '/jobs/view/' }], none: [{ selectorLike: { role: 'dialog' } }, { textPresent: 'application (was )?sent' }] },
      onEnter: [{ action: 'click', target: { role: 'button', nameRx: '^easy apply' } }],
      next: ['apply_modal'] },
    { key: 'apply_modal', kind: 'form',
      classify: { any: [{ selectorLike: { role: 'dialog', nameRx: 'apply' } }] },
      formRoot: [{ kind: 'dialogRole' }], fill: { requiredFirst: true, fillOptional: true },
      next: ['review', 'confirmation'] },
    { key: 'review', kind: 'review',
      classify: { any: [{ selectorLike: { role: 'dialog', nameRx: 'review' } }] },
      next: ['confirmation'] },
    { key: 'confirmation', kind: 'confirmation',
      classify: { any: [{ textPresent: 'application (was )?sent' }] }, next: [] },
  ],
  advance: { labels: ['^continue$', '^review$', '^submit application$'], finalLabels: ['^submit application$'],
    neverLabels: ['^easy apply'], disabledIsWaiting: true, waitEnabledMs: 5000 },
  oracles: {
    success: [{ id: 'sent', kind: 'textPresent', rx: 'application (was )?sent', level: 'verified' }],
    failure: [], humanGate: [{ id: 'cap', kind: 'realCaptchaWidget' }],
  },
  limits: { maxSteps: 15 },
});

// nid → meaning (stable across the run)
const NID = { easyApply: 10, email: 20, cont: 30, submit: 40 } as const;

type Phase = 'start' | 'job_view' | 'apply_modal' | 'review' | 'confirmation';

/** A scripted, killable stand-in for the thin extension. Preserves the filled email across a "death". */
class FakeExtension implements RunGateway {
  phase: Phase = 'start';
  email = '';
  epochN = 0;
  commands: Cmd[] = [];
  private kill: ((cmd: Cmd) => boolean) | null;
  constructor(killOn?: (cmd: Cmd) => boolean) { this.kill = killOn ?? null; }

  private epoch() { return `ep${this.epochN}`; }
  private nameOf(nid: number): string {
    return nid === NID.easyApply ? 'Easy Apply' : nid === NID.email ? 'Email' : nid === NID.cont ? 'Continue' : nid === NID.submit ? 'Submit application' : '';
  }

  private node(nid: number, role: SnapNode['role'], name: string, extra: Partial<SnapNode> = {}): SnapNode {
    return { nid, role, name, rect: [0, 0, 120, 32], path: `#${nid}`, ...extra };
  }

  private snap(): PageSnapshot {
    let nodes: SnapNode[] = [];
    let url = JOB_URL;
    if (this.phase === 'job_view') nodes = [this.node(NID.easyApply, 'button', 'Easy Apply')];
    else if (this.phase === 'apply_modal') nodes = [
      this.node(1, 'dialog', 'Apply to Aurora Labs'),
      this.node(NID.email, 'textbox', 'Email address', this.email ? { value: this.email } : {}),
      this.node(NID.cont, 'button', 'Continue'),
    ];
    else if (this.phase === 'review') nodes = [
      this.node(2, 'dialog', 'Review your application'),
      this.node(NID.submit, 'button', 'Submit application'),
    ];
    else if (this.phase === 'confirmation') { url = JOB_URL + '/post-apply'; nodes = [this.node(3, 'text', 'Your application was sent')]; }
    const hash = `${this.phase}:${this.email ? 'filled' : 'empty'}`;
    return { v: 1, epoch: this.epoch(), url, title: 'LinkedIn', readyState: 'complete', quietMs: 900,
      frames: [{ framePath: '', frameHost: 'www.linkedin.com', nodes }], truncated: false, hash };
  }

  async command(_runId: string, _epoch: string, cmd: Cmd): Promise<CmdResult> {
    this.commands.push(cmd);
    if (this.kill && this.kill(cmd)) { this.kill = null; throw new PortGoneError('crash'); } // one-shot death
    switch (cmd.op) {
      case 'navigate': this.phase = 'job_view'; break;
      case 'fill': if (cmd.target.nid === NID.email) this.email = cmd.value; break; // draft persists
      case 'click': {
        const n = this.nameOf(cmd.target.nid);
        if (/easy apply/i.test(n)) this.phase = 'apply_modal';
        else if (/^continue$/i.test(n)) this.phase = 'review';
        else if (/submit application/i.test(n)) this.phase = 'confirmation';
        break;
      }
      default: break; // snapshot / waitFor / scrollIntoView: no state change
    }
    return { ok: true, snapshotDelta: this.snap() };
  }

  async awaitResume(_runId: string, _ttl: number): Promise<ResumeInfo> {
    this.epochN++; // reconnect mints a fresh epoch; the PAGE is unchanged (draft preserved)
    return { epoch: this.epoch(), snapshot: this.snap() };
  }
}

const resolve: ResolveControl = (control) =>
  /email/i.test(control.name) ? { kind: 'fill', value: 'pierre@example.com' } : { kind: 'park', reason: 'unknown' };

const fakeSealer: Sealer = { available: () => true, seal: (p) => Buffer.from(p), open: (b) => Buffer.from(b).toString() };

describe('M1 — a real Easy Apply that survives an extension-kill', () => {
  let db: Database;
  let dal: Dal;

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    dal = makeDal(defaultContext(db), { sealer: fakeSealer });
    db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?,?,1,?,?)').run('p1', 'Pierre', 1, 1);
    db.prepare('INSERT INTO jobs (id, source, job_url, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run('j1', 'linkedin', JOB_URL, 1, 1, 1, 1);
  });
  afterEach(() => db.close());

  function newRun(): string {
    const appl = dal.applications.ensure('j1', 'p1');
    return dal.runs.enqueue(appl.id, { source: 'linkedin', lane: 'linkedin', jobId: 'j1', profileId: 'p1' }).id;
  }
  const runRow = (id: string) =>
    db.prepare('SELECT state, evidence_kind, resume_count FROM apply_runs WHERE id=?').get(id) as
      { state: string; evidence_kind: string | null; resume_count: number };

  it('happy path: drives job_view → fill → submit → verified confirmation', async () => {
    const ext = new FakeExtension();
    const runId = newRun();
    const outcome = await driveRun(runId, { runs: dal.runs, gateway: ext, adapter: ADAPTER, resolve, jobUrl: JOB_URL, now: () => 1000 });

    expect(outcome.state).toBe('submitted');
    expect(outcome.evidenceKind).toBe('text_became_success');
    expect(outcome.resumes).toBe(0);
    const row = runRow(runId);
    expect(row.state).toBe('submitted');
    expect(row.evidence_kind).toBe('text_became_success'); // the CHECK would have rejected a false submit
    expect(ext.email).toBe('pierre@example.com');
  });

  it('KILLED mid-run on the Continue click: resumes by re-classifying, still submits', async () => {
    // die exactly when advancing out of the filled modal — the highest-value mid-flow death
    const ext = new FakeExtension((cmd) => cmd.op === 'click' && cmd.target.nid === NID.cont);
    const runId = newRun();
    const outcome = await driveRun(runId, { runs: dal.runs, gateway: ext, adapter: ADAPTER, resolve, jobUrl: JOB_URL, now: () => 1000 });

    expect(outcome.state).toBe('submitted'); //          completed DESPITE the death
    expect(outcome.resumes).toBeGreaterThanOrEqual(1); // it actually went through waiting_page→resume
    const row = runRow(runId);
    expect(row.state).toBe('submitted');
    expect(row.evidence_kind).toBe('text_became_success');
    expect(row.resume_count).toBeGreaterThanOrEqual(1); // the DAL recorded the resume
    expect(ext.email).toBe('pierre@example.com'); //     the filled draft survived the kill
  });

  it('parks needs_human on an unanswerable question rather than guessing', async () => {
    // a resolver that can't answer anything → the modal's email field parks
    const parkResolver: ResolveControl = () => ({ kind: 'park', reason: 'unknown' });
    const ext = new FakeExtension();
    const runId = newRun();
    const outcome = await driveRun(runId, { runs: dal.runs, gateway: ext, adapter: ADAPTER, resolve: parkResolver, jobUrl: JOB_URL, now: () => 1000 });

    expect(outcome.state).toBe('needs_human');
    expect(outcome.parkKind).toBe('needs_answer');
    expect(outcome.pendingQuestions).toContain('Email address');
    expect(runRow(runId).state).toBe('needs_human');
  });
});
