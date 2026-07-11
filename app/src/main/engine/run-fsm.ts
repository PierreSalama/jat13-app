// The apply-run state machine as DATA (Architecture §2 · engine-knowledge §11). This module is the
// ONE authority for the run graph: the runs DAL's guarded `transition` writer MUST route every
// apply_runs.state write through `assertTransition` (structural law — an illegal edge is a thrown
// error, never a silent bad row). Nothing re-derives the graph anywhere else.
//
// Ported VERBATIM from cb25d19 app/src/main/db/dal/run-fsm.ts, with two new-tree deltas:
//   1) the vocab is defined HERE as literal data (the old tree read it from shared/contracts/
//      status.json; that contract does not exist in the rebuild yet, so run-fsm is self-contained
//      and testable with zero imports — status.json, if it lands, must be checked AGAINST this).
//   2) run-fsm now lives under engine/ (not db/dal/); the runs DAL imports up from here.
//
// Every vocabulary below is reconciled against migration 001_init.sql — the schema CHECK constraints
// are the law and this file must not drift from them (loud-on-unknown is a schema property):
//   apply_runs.state        — the 13 states
//   apply_runs.park_kind    — PARK_KINDS
//   apply_runs.evidence_kind— EVIDENCE_KINDS (trustworthy vs the one untrusted importer-only kind)
//   apply_run_steps.phase   — STEP_PHASES
// "Busy = one SQL query" is derived from SLOT_HOLDING; nothing counts tabs/ports/SW-liveness (§3.3).

// ---- the 13 states (order == migration 001 apply_runs.state CHECK) --------------------------------

export const RUN_STATES = [
  'queued',
  'leased',
  'navigating',
  'classifying',
  'driving',
  'verifying',
  'waiting_page',
  'needs_human',
  'submitted',
  'ready_for_review',
  'parked',
  'skipped',
  'failed',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/**
 * These and ONLY these count toward a lane's in-flight slot budget — the "busy = one SQL query" law
 * (engine-knowledge §3.3). Derived-from-state, never from open tabs/windows/ports (the freeze scar:
 * an idle warm tab is NOT a busy slot). `needs_human` is DELIBERATELY absent — it has released its
 * slot and is not time-capped by the run (§5.5), so a human pause never pins a slot.
 * Annotated `readonly RunState[]` so `.includes(s: RunState)` type-checks AND every element is
 * validated as a real state at compile time.
 */
export const SLOT_HOLDING: readonly RunState[] = [
  'leased',
  'navigating',
  'classifying',
  'driving',
  'verifying',
  'waiting_page',
];

/** Terminal states (no outgoing edges) — order == migration 001 autopsies.final_state CHECK. */
export const TERMINAL: readonly RunState[] = [
  'submitted',
  'ready_for_review',
  'parked',
  'skipped',
  'failed',
];

export function isSlotHolding(s: RunState): boolean {
  return SLOT_HOLDING.includes(s);
}
export function isTerminal(s: RunState): boolean {
  return TERMINAL.includes(s);
}

// ---- the legal-transition graph (the §2.1 stateDiagram) -------------------------------------------

/**
 * Legal transitions. Edges are the state diagram plus the watchdog rules encoded structurally:
 *   - queued → skipped        relevance-skip before any attempt is spent (no tab opened)
 *   - <slot-holding> → failed the 8-min whole-run hard cap can fail any slot-holding state
 *   - waiting_page → classifying|queued  RESUME-by-reclassification / TTL re-queue (bumps resume_count)
 *   - waiting_page → failed    TTL exhausted with no attempts left (§2.2 / v11.84 stranded-slot lesson)
 *   - needs_human → queued|parked  human resolved (re-queue at front of lane) / dismissed-or-stale
 * A missing edge is illegal by construction — `assertTransition` throws on it.
 */
export const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['leased', 'skipped'],
  leased: ['navigating', 'waiting_page', 'failed'],
  navigating: ['classifying', 'waiting_page', 'failed'],
  classifying: ['driving', 'needs_human', 'parked', 'waiting_page', 'failed'],
  driving: ['classifying', 'verifying', 'needs_human', 'parked', 'waiting_page', 'failed'],
  verifying: ['submitted', 'ready_for_review', 'driving', 'waiting_page', 'failed'],
  waiting_page: ['classifying', 'queued', 'failed'],
  needs_human: ['queued', 'parked'],
  submitted: [],
  ready_for_review: [],
  parked: [],
  skipped: [],
  failed: [],
};

/** Same-state is always allowed (idempotent field patches route through the guarded writer too). */
export function canTransition(from: RunState, to: RunState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Throw on an illegal transition — the ONLY authority for the graph. */
export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal apply_run transition: ${from} -> ${to}`);
  }
}

// ---- park vocabulary (== migration 001 apply_runs.park_kind CHECK) --------------------------------
// Why the run parked when it stopped short of a terminal drive. captcha/cloudflare/login/account_wall
// are human walls (never auto-solved, §9.4); needs_answer carries the exact question(s) to the
// Needs-You queue; awaiting_review = "probably already submitted" hygiene bucket (§8 / v11.61).

export const PARK_KINDS = [
  'captcha',
  'cloudflare',
  'login',
  'account_wall',
  'resume_required',
  'needs_answer',
  'awaiting_review',
  'external_redirect',
  'rate_limited',
  'other',
] as const;
export type ParkKind = (typeof PARK_KINDS)[number];

// ---- evidence vocabulary (== migration 001 apply_runs.evidence_kind CHECK) ------------------------
// Submit-truth as a constraint (§10): state='submitted' is UNWRITABLE without a TRUSTWORTHY kind
// (the DB CHECK enforces it). `legacy_untrusted` exists ONLY so the v11 importer can carry quarantined
// history honestly — the engine NEVER writes it, and it can never accompany a 'submitted' row.

export const TRUSTWORTHY_EVIDENCE_KINDS = [
  'text_became_success',
  'new_confirmation_node',
  'confirm_signal',
  'url_confirmation',
  'modal_close_confirmed',
  'manual_confirmed',
] as const;
export type TrustworthyEvidenceKind = (typeof TRUSTWORTHY_EVIDENCE_KINDS)[number];

export const UNTRUSTED_EVIDENCE_KINDS = ['legacy_untrusted'] as const;

export const EVIDENCE_KINDS = [
  ...TRUSTWORTHY_EVIDENCE_KINDS,
  ...UNTRUSTED_EVIDENCE_KINDS,
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** A kind trustworthy enough to justify state='submitted' (mirrors the CHECK: <> 'legacy_untrusted'). */
export function isTrustworthyEvidence(kind: EvidenceKind | null | undefined): kind is TrustworthyEvidenceKind {
  return kind != null && kind !== 'legacy_untrusted';
}

// ---- step-transcript phase vocabulary (== migration 001 apply_run_steps.phase CHECK) --------------

export const STEP_PHASES = [
  'open',
  'navigate',
  'classify',
  'detect',
  'fill',
  'answer',
  'upload',
  'advance',
  'verify',
  'park',
  'resume',
  'finish',
] as const;
export type StepPhase = (typeof STEP_PHASES)[number];
