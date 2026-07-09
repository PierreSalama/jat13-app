// The generic interpreter loop (Pillar 3 §4.3) — app code operating on snapshots; the page never runs
// adapter logic. It drives ONE run through the apply-run FSM (via the runs DAL, the only state writer)
// and — the whole point of v12 — RESUMES by re-classifying the live page after any extension death,
// never replaying a script. `driveRun` is transport-agnostic (RunGateway), so it's proven headlessly.
import type { PageSnapshot, SnapNode, Cmd } from '@jat13/shared/protocol';
import type { AdapterDoc, PageDef } from '@jat13/shared/adapter-schema';
import type { makeRunsDal } from '../db/dal/runs.js';
import { classifyPage, stepGraphAllows, type Classification } from './classifier.js';
import { evaluateSuccess, evaluateHumanGate, evaluateFailure } from './oracle.js';
import { allNodes, findAdvanceCandidates, matchesAny, normalizeLabel } from './labels.js';
import { PortGoneError, type RunGateway } from './gateway.js';

type RunsDal = ReturnType<typeof makeRunsDal>;

/** How the app wants a single form control satisfied. The runner filters already-satisfied controls;
 *  resolve() is only asked about the unsatisfied ones. The real profile-first+Codex resolver is #7. */
export type ControlAnswer =
  | { kind: 'fill'; value: string; method?: 'auto' | 'native' | 'reactSetter' }
  | { kind: 'radio'; byText: string }
  | { kind: 'select'; byText: string }
  | { kind: 'park'; reason: string };
export type ResolveControl = (control: SnapNode, page: PageDef, adapter: AdapterDoc) => ControlAnswer | Promise<ControlAnswer>;

export interface DriveDeps {
  runs: RunsDal;
  gateway: RunGateway;
  adapter: AdapterDoc;
  resolve: ResolveControl;
  jobUrl: string;
  now: () => number;
  /** waiting_page TTL for a resume (Pillar 3 §2.2 = 120s; injectable for tests). */
  resumeTtlMs?: number;
  log?: (msg: string) => void;
}

export interface DriveOutcome {
  state: 'submitted' | 'ready_for_review' | 'needs_human' | 'parked' | 'skipped' | 'failed';
  evidenceKind?: string;
  parkKind?: string;
  pendingQuestions?: string[];
  steps: number;
  resumes: number;
}

const CONTROL_ROLES = new Set<SnapNode['role']>(['textbox', 'textarea', 'checkbox', 'combobox', 'select', 'file']);

/** Is this control still needing a value? (radio-aware: a group is satisfied once any radio is checked.) */
function isUnsatisfied(control: SnapNode, all: SnapNode[]): boolean {
  if (control.role === 'radio') return false; // handled at the group level below
  if (control.role === 'radiogroup') {
    const g = control.group;
    const checked = all.some((n) => n.role === 'radio' && n.group === g && n.states?.checked);
    return !checked;
  }
  if (control.states?.checked) return false;
  if (CONTROL_ROLES.has(control.role)) return !control.value; // empty value = unsatisfied
  return false;
}

/** The command for a resolved control answer. */
function answerToCmd(control: SnapNode, ans: ControlAnswer): Cmd | null {
  const target = { nid: control.nid, rebindPath: control.path };
  switch (ans.kind) {
    case 'fill': return { op: 'fill', target, value: ans.value, method: ans.method ?? 'auto' };
    case 'radio': return { op: 'chooseRadio', group: control.group ?? control.nid, option: { byText: ans.byText } };
    case 'select': return { op: 'selectOption', target, option: { byText: ans.byText } };
    case 'park': return null;
  }
}

export async function driveRun(runId: string, deps: DriveDeps): Promise<DriveOutcome> {
  const { runs, gateway, adapter, resolve, now } = deps;
  const ttl = deps.resumeTtlMs ?? 120_000;
  const log = deps.log ?? (() => {});
  const limits = adapter.limits;

  let epoch = '';
  let snapshot: PageSnapshot;
  let prev: PageDef | null = null;
  let armed = false; // a final (submit) advance was clicked → success oracles are live
  let steps = 0;
  let resumes = 0;

  const finish = (o: DriveOutcome): DriveOutcome => o;

  // command wrapper: a PortGoneError bubbles to the loop-level resume handler.
  async function issue(cmd: Cmd): Promise<PageSnapshot> {
    const res = await gateway.command(runId, epoch, cmd);
    if (res.snapshotDelta) return res.snapshotDelta;
    // non-mutating result without a delta: request an explicit snapshot
    const s = await gateway.command(runId, epoch, { op: 'snapshot' });
    if (!s.snapshotDelta) throw new Error('no snapshot after command');
    return s.snapshotDelta;
  }

  // ---- lease + navigate ----
  runs.transition(runId, 'leased');
  runs.transition(runId, 'navigating', { page_key: null });
  try {
    snapshot = await issue({ op: 'navigate', url: deps.jobUrl });
    epoch = snapshot.epoch;
  } catch (e) {
    if (e instanceof PortGoneError) {
      const r = await resumeAfterGone();
      snapshot = r.snapshot;
    } else throw e;
  }
  runs.transition(runId, 'classifying');

  async function resumeAfterGone(): Promise<{ snapshot: PageSnapshot }> {
    runs.transition(runId, 'waiting_page');
    const resumed = await gateway.awaitResume(runId, ttl); // throws on TTL → propagates to caller
    epoch = resumed.epoch;
    resumes++;
    runs.transition(runId, 'classifying'); // waiting_page→classifying bumps resume_count in the DAL
    log(`resumed after port death → re-classifying ${resumed.snapshot.url}`);
    return { snapshot: resumed.snapshot };
  }

  // ---- the loop ----
  while (steps < limits.maxSteps) {
    steps++;
    try {
      const cls: Classification | null = classifyPage(snapshot, adapter.pages, prev);
      if (!cls) {
        // unknown page → capture-and-park (one weird page never wedges the lane)
        runs.transition(runId, 'parked', { park_kind: 'other', park_detail: 'unknown_page' });
        return finish({ state: 'parked', parkKind: 'other', steps, resumes });
      }
      const page = cls.page;
      if (!stepGraphAllows(prev, page.key)) {
        runs.transition(runId, 'parked', { park_kind: 'other', park_detail: `unexpected_page:${page.key}` });
        return finish({ state: 'parked', parkKind: 'other', steps, resumes });
      }
      runs.addStep(runId, { phase: 'classify', detail: page.key, snapshotHash: snapshot.hash });

      // success check FIRST (a confirmation page or an armed post-submit page is a terminal signal)
      if (armed || page.kind === 'confirmation') {
        const succ = evaluateSuccess(snapshot, adapter.oracles.success, now());
        if (succ.evidenceKind) {
          runs.transition(runId, 'verifying'); // ensure we're in verifying before recording the submit
          runs.recordSubmitted(runId, { evidenceKind: succ.evidenceKind, evidenceJson: JSON.stringify(succ.evidence) });
          return finish({ state: 'submitted', evidenceKind: succ.evidenceKind, steps, resumes });
        }
        if (page.kind === 'confirmation') {
          // reached a confirmation but evidence isn't trustworthy → honest downgrade
          runs.transition(runId, 'ready_for_review', { evidence_json: JSON.stringify(succ.evidence) });
          return finish({ state: 'ready_for_review', steps, resumes });
        }
      }

      // definitive dead-ends
      if (evaluateFailure(snapshot, adapter.oracles.failure)) {
        runs.transition(runId, 'parked', { park_kind: 'other', park_detail: 'failure_oracle' });
        return finish({ state: 'parked', parkKind: 'other', steps, resumes });
      }
      // human walls — never auto-solve
      const gate = evaluateHumanGate(snapshot, adapter.oracles.humanGate);
      if (gate) {
        const parkKind = gate.kind === 'realCaptchaWidget' || gate.kind === 'challengeCopy' ? 'captcha' : 'login';
        runs.transition(runId, 'needs_human', { park_kind: parkKind });
        return finish({ state: 'needs_human', parkKind, steps, resumes });
      }

      runs.transition(runId, 'driving');

      // onEnter actions (e.g. click the Easy Apply opener on job_view). If one MUTATES the page, this
      // step is done — re-classify next iteration rather than fill/advance on the freshly-opened page.
      if (page.onEnter?.length) {
        const hashBefore = snapshot.hash;
        for (const act of page.onEnter) {
          const targetNode = allNodes(snapshot).find(
            (n) => (!act.target.role || n.role === act.target.role) && (!act.target.nameRx || new RegExp(act.target.nameRx, 'i').test(n.name)),
          );
          if (targetNode) {
            snapshot = await issue({ op: act.action === 'click' ? 'click' : 'scrollIntoView', target: { nid: targetNode.nid, rebindPath: targetNode.path } });
            runs.addStep(runId, { phase: 'open', detail: `onEnter:${act.action}`, snapshotHash: snapshot.hash });
          }
        }
        if (snapshot.hash !== hashBefore) {
          prev = page;
          continue; // page opened/changed → re-classify from the top
        }
      }

      // fill the form (batch ALL unanswerable into one park — never one-at-a-time)
      if (page.kind === 'form' && page.fill) {
        const pending: string[] = [];
        for (const control of allNodes(snapshot)) {
          if (!isUnsatisfied(control, allNodes(snapshot))) continue;
          const ans = await resolve(control, page, adapter);
          if (ans.kind === 'park') {
            pending.push(control.groupPrompt || control.name || 'unknown question');
            continue;
          }
          const cmd = answerToCmd(control, ans);
          if (cmd) {
            snapshot = await issue(cmd);
            runs.addStep(runId, { phase: 'fill', target: control.name.slice(0, 64), snapshotHash: snapshot.hash });
          }
        }
        if (pending.length) {
          runs.transition(runId, 'needs_human', { park_kind: 'needs_answer', pending_questions_json: JSON.stringify(pending) });
          return finish({ state: 'needs_human', parkKind: 'needs_answer', pendingQuestions: pending, steps, resumes });
        }
      }

      // find the advance control within the (M1: whole-snapshot) root
      const candidates = findAdvanceCandidates(allNodes(snapshot), adapter.advance.labels, adapter.advance.neverLabels);
      const advance = candidates.find((n) => !n.states?.disabled) ?? candidates[0];
      if (!advance) {
        // no advance and not terminal → stuck
        runs.transition(runId, 'parked', { park_kind: 'other', park_detail: 'stuck_step:no_advance' });
        return finish({ state: 'parked', parkKind: 'other', steps, resumes });
      }

      // disabled-is-waiting (v11.86): wait for it to enable, never treat as absent
      if (advance.states?.disabled) {
        snapshot = await issue({ op: 'waitFor', cond: { kind: 'enabled', target: { nid: advance.nid } }, timeoutMs: adapter.advance.waitEnabledMs });
        const still = findAdvanceCandidates(allNodes(snapshot), adapter.advance.labels, adapter.advance.neverLabels).find((n) => n.nid === advance.nid);
        if (still?.states?.disabled) {
          runs.transition(runId, 'parked', { park_kind: 'other', park_detail: 'stuck_step:advance_never_enabled' });
          return finish({ state: 'parked', parkKind: 'other', steps, resumes });
        }
      }

      const isFinal = matchesAny(adapter.advance.finalLabels, advance.name);
      if (isFinal) {
        runs.transition(runId, 'verifying');
        armed = true;
      }
      snapshot = await issue({ op: 'click', target: { nid: advance.nid, rebindPath: advance.path } });
      runs.addStep(runId, { phase: isFinal ? 'verify' : 'advance', target: normalizeLabel(advance.name).slice(0, 64), snapshotHash: snapshot.hash });
      prev = page;
    } catch (e) {
      if (e instanceof PortGoneError) {
        const r = await resumeAfterGone(); // → waiting_page → awaitResume → classifying (resume_count++)
        snapshot = r.snapshot;
        continue; // re-enter the loop: re-classify the LIVE page, resume from where it actually is
      }
      throw e;
    }
  }

  // maxSteps exhausted
  runs.transition(runId, 'failed', { error: 'run hard cap: maxSteps exhausted' });
  return finish({ state: 'failed', steps, resumes });
}
