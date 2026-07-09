// The apply-run state machine as DATA (Pillar 3 §2.1 diagram + §2.2 watchdogs). The `runs` DAL is
// the ONLY writer of apply_runs.state and it MUST route every write through `assertTransition` —
// that is structural law 5 for run state (an illegal transition is a thrown error, not a silent bad row).
import STATUS from '@jat13/shared/contracts/status.json' with { type: 'json' };

export type RunState =
  | 'queued' | 'leased' | 'navigating' | 'classifying' | 'driving' | 'verifying'
  | 'waiting_page' | 'needs_human' | 'submitted' | 'ready_for_review'
  | 'parked' | 'skipped' | 'failed';

/** These and ONLY these count toward a lane's in-flight slot budget (the "busy = one SQL query" law). */
export const SLOT_HOLDING = STATUS.runStates.slotHolding as readonly RunState[];
export const TERMINAL = STATUS.runStates.terminal as readonly RunState[];

export function isSlotHolding(s: RunState): boolean {
  return SLOT_HOLDING.includes(s);
}
export function isTerminal(s: RunState): boolean {
  return TERMINAL.includes(s);
}

/**
 * Legal transitions. Edges come straight from the §2.1 stateDiagram, plus the §2.2 watchdog rule
 * that the 8-min hard cap can drive any SLOT-HOLDING state to `failed` (needs_human is exempt — it
 * already released its slot, so nothing is pinned to time out).
 */
export const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['leased', 'skipped'], //             scheduler grants a slot, or relevance-skip before any attempt
  leased: ['navigating', 'waiting_page', 'failed'], // tab provisioned / died / give-up
  navigating: ['classifying', 'waiting_page', 'failed'],
  classifying: ['driving', 'needs_human', 'parked', 'waiting_page', 'failed'],
  driving: ['classifying', 'verifying', 'needs_human', 'parked', 'waiting_page', 'failed'],
  verifying: ['submitted', 'ready_for_review', 'driving', 'waiting_page', 'failed'],
  waiting_page: ['classifying', 'queued', 'failed'], // RESUME (re-classify) / TTL re-queue / TTL exhausted
  needs_human: ['queued', 'parked'], //          human resolved / dismissed-or-stale
  submitted: [],
  ready_for_review: [],
  parked: [],
  skipped: [],
  failed: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Throw on an illegal transition. Same-state is allowed (idempotent field patches). */
export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal apply_run transition: ${from} -> ${to}`);
  }
}
