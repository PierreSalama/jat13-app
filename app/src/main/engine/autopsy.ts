// autopsy.ts — turns a TERMINAL DriveOutcome into an autopsies row (01-ARCHITECTURE §6). Every run that
// reaches a terminal state (submitted | ready_for_review | parked | skipped | failed) gets one readable
// post-mortem: final state, park kind, last classified page, a condensed step trail, and the blocking
// control. `needs_human` is NOT terminal (it released its slot awaiting the human) → no autopsy, the run
// is paused, not dead. The DAL derives the pattern-miner `signature` so recurring failures group
// ("same failure ×N") for the Autopsies page + (Stage 6) one-click remedies.

import type { Dal } from '../db/dal/index.js';
import type { Run } from '../db/dal/runs.js';
import type { Autopsy, AutopsyFinalState } from '../db/dal/autopsies.js';
import type { DriveOutcome } from './runner.js';

/** True for the five terminal states an autopsy is written for; false for the `needs_human` pause. */
export function isAutopsyTerminal(state: DriveOutcome['state']): state is AutopsyFinalState {
  return state !== 'needs_human';
}

/** Newest N steps kept in the trail — the run stopped where the trail ends; older steps are the least
 *  useful and the column is capped anyway (the DAL trims further if needed). */
const TRAIL_KEEP = 40;

/** The control/reason that blocked the run — the most specific descriptor available, in order:
 *  the park detail (names the blocker, e.g. `stuck_step:no_advance` / `unknown_page`), then the run
 *  error, then the last step's target (element role/label — never raw HTML by construction). */
function deriveBlockingControl(dal: Dal, run: Run): string | null {
  if (run.park_detail) return run.park_detail;
  if (run.error) return run.error;
  const steps = dal.runs.getSteps(run.id);
  const last = steps[steps.length - 1];
  return last?.target ?? last?.detail ?? null;
}

/** A human one-liner for the post-mortem summary, keyed on the terminal state. */
function buildSummary(run: Run, outcome: DriveOutcome, finalState: AutopsyFinalState): string {
  const tail = ` · ${outcome.steps} step(s), ${outcome.resumes} resume(s)`;
  switch (finalState) {
    case 'submitted':
      return `Submitted — evidence ${run.evidence_kind ?? outcome.evidenceKind ?? 'confirmed'}${tail}`;
    case 'ready_for_review':
      return `Reached a confirmation but evidence was not trustworthy — quarantined for review${tail}`;
    case 'parked': {
      const detail = run.park_detail ? `: ${run.park_detail}` : '';
      return `Parked (${run.park_kind ?? 'other'})${detail}${tail}`;
    }
    case 'skipped':
      return `Skipped — ${run.error ?? 'not attempted (no adapter / relevance skip)'}${tail}`;
    case 'failed':
      return `Failed — ${run.error ?? 'run error'}${tail}`;
  }
}

/**
 * Write the autopsy for a terminal run. Returns the created (or pre-existing, idempotent) row, or null
 * when the outcome is `needs_human` (a pause, not a terminal). Records an `autopsy_created` timeline
 * event alongside the row so the Activity page + application drawer reflect it.
 */
export function writeAutopsy(dal: Dal, run: Run, outcome: DriveOutcome): Autopsy | null {
  if (!isAutopsyTerminal(outcome.state)) return null;
  const finalState: AutopsyFinalState = outcome.state;

  const trail = dal.runs.getSteps(run.id).slice(-TRAIL_KEEP).map((s) => ({
    seq: s.seq,
    phase: s.phase,
    action: s.action,
    target: s.target,
    ok: s.ok,
  }));

  const summary = buildSummary(run, outcome, finalState);
  const autopsy = dal.autopsies.record(run.id, {
    applicationId: run.application_id,
    jobId: run.job_id,
    lane: run.lane,
    finalState,
    parkKind: run.park_kind,
    lastPageClass: run.page_key,
    blockingControl: deriveBlockingControl(dal, run),
    stepTrail: trail,
    summary,
  });

  dal.events.record({
    kind: 'autopsy_created',
    applicationId: run.application_id,
    jobId: run.job_id,
    runId: run.id,
    source: run.lane,
    summary,
  });

  return autopsy;
}
