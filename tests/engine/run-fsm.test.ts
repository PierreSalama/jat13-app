// run-fsm — the graph authority. This proves the ONLY thing the DAL/runner rely on: that
// assertTransition accepts exactly the legal edges and throws on every illegal one, and that the
// slot-holding / terminal / park / evidence vocabularies match migration 001 EXACTLY. If this drifts
// from the schema CHECK constraints, a run could take an edge the DB then rejects (or worse, accepts a
// state the "busy" query miscounts) — so this test is the executable form of the state diagram.
import { describe, it, expect } from 'vitest';
import {
  RUN_STATES,
  SLOT_HOLDING,
  TERMINAL,
  TRANSITIONS,
  PARK_KINDS,
  EVIDENCE_KINDS,
  TRUSTWORTHY_EVIDENCE_KINDS,
  STEP_PHASES,
  canTransition,
  assertTransition,
  isSlotHolding,
  isTerminal,
  isTrustworthyEvidence,
  type RunState,
} from '../../app/src/main/engine/run-fsm.js';

describe('run-fsm — the 13-state graph', () => {
  it('declares exactly the 13 migration-001 states', () => {
    expect([...RUN_STATES]).toEqual([
      'queued', 'leased', 'navigating', 'classifying', 'driving', 'verifying',
      'waiting_page', 'needs_human', 'submitted', 'ready_for_review',
      'parked', 'skipped', 'failed',
    ]);
    expect(new Set(RUN_STATES).size).toBe(13);
  });

  it('has a transition entry for every state (total function over the state set)', () => {
    for (const s of RUN_STATES) expect(TRANSITIONS[s]).toBeDefined();
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...RUN_STATES].sort());
  });

  it('every declared edge points at a real state', () => {
    for (const from of RUN_STATES) {
      for (const to of TRANSITIONS[from]) {
        expect(RUN_STATES).toContain(to);
      }
    }
  });
});

describe('run-fsm — slot-holding set (the "busy = one SQL query" authority)', () => {
  it('is EXACTLY leased|navigating|classifying|driving|verifying|waiting_page', () => {
    expect([...SLOT_HOLDING]).toEqual([
      'leased', 'navigating', 'classifying', 'driving', 'verifying', 'waiting_page',
    ]);
  });

  it('does NOT include needs_human (it releases its slot — the human-pause rule)', () => {
    expect(SLOT_HOLDING).not.toContain('needs_human');
    expect(isSlotHolding('needs_human')).toBe(false);
  });

  it('no slot-holding state is terminal, and vice versa (the sets are disjoint)', () => {
    for (const s of SLOT_HOLDING) expect(isTerminal(s)).toBe(false);
    for (const s of TERMINAL) expect(isSlotHolding(s)).toBe(false);
  });

  it('isSlotHolding agrees with the set for every state', () => {
    for (const s of RUN_STATES) {
      expect(isSlotHolding(s)).toBe(SLOT_HOLDING.includes(s));
    }
  });
});

describe('run-fsm — terminal set', () => {
  it('is EXACTLY submitted|ready_for_review|parked|skipped|failed', () => {
    expect([...TERMINAL]).toEqual([
      'submitted', 'ready_for_review', 'parked', 'skipped', 'failed',
    ]);
  });

  it('every terminal state has NO outgoing edges', () => {
    for (const s of TERMINAL) expect(TRANSITIONS[s]).toEqual([]);
  });

  it('isTerminal agrees with the set for every state', () => {
    for (const s of RUN_STATES) {
      expect(isTerminal(s)).toBe(TERMINAL.includes(s));
    }
  });
});

describe('run-fsm — assertTransition accepts every legal edge', () => {
  it('accepts every edge in the transition table', () => {
    for (const from of RUN_STATES) {
      for (const to of TRANSITIONS[from]) {
        expect(() => assertTransition(from, to)).not.toThrow();
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });

  it('accepts same-state transitions (idempotent field patches)', () => {
    for (const s of RUN_STATES) {
      expect(canTransition(s, s)).toBe(true);
      expect(() => assertTransition(s, s)).not.toThrow();
    }
  });

  it('accepts the load-bearing resume + human edges by name', () => {
    // resume-by-reclassification and its TTL siblings
    expect(canTransition('waiting_page', 'classifying')).toBe(true);
    expect(canTransition('waiting_page', 'queued')).toBe(true);
    expect(canTransition('waiting_page', 'failed')).toBe(true);
    // needs_human release (re-queue at front of lane) / dismiss
    expect(canTransition('needs_human', 'queued')).toBe(true);
    expect(canTransition('needs_human', 'parked')).toBe(true);
    // relevance-skip before spending an attempt
    expect(canTransition('queued', 'skipped')).toBe(true);
    // the only truthful submit path
    expect(canTransition('verifying', 'submitted')).toBe(true);
    expect(canTransition('verifying', 'ready_for_review')).toBe(true);
  });
});

describe('run-fsm — assertTransition rejects every illegal edge', () => {
  it('throws on a precise, named set of illegal edges', () => {
    const illegal: Array<[RunState, RunState]> = [
      ['queued', 'submitted'], //        can never jump straight to submitted (must be verified)
      ['queued', 'driving'], //          must lease + navigate + classify first
      ['leased', 'submitted'],
      ['navigating', 'driving'], //      must classify before driving
      ['classifying', 'submitted'], //   submit only via verifying
      ['driving', 'submitted'], //       submit only via verifying (arm-then-verify)
      ['driving', 'queued'], //          no silent re-queue from mid-drive
      ['verifying', 'needs_human'], //   not a legal verify outcome
      ['needs_human', 'driving'], //     resolved runs re-queue, never resume mid-drive
      ['waiting_page', 'submitted'], //  must re-classify (never replay to a submit)
      ['skipped', 'queued'], //          terminal is terminal
    ];
    for (const [from, to] of illegal) {
      expect(canTransition(from, to)).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(/illegal apply_run transition/);
    }
  });

  it('no terminal state can transition to anything else', () => {
    for (const from of TERMINAL) {
      for (const to of RUN_STATES) {
        if (to === from) continue; // same-state idempotent patch is allowed
        expect(canTransition(from, to)).toBe(false);
        expect(() => assertTransition(from, to)).toThrow();
      }
    }
  });

  it('canTransition and assertTransition agree for EVERY (from,to) pair', () => {
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        const legal = canTransition(from, to);
        if (legal) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow();
      }
    }
  });
});

describe('run-fsm — park / evidence / step vocabularies match migration 001', () => {
  it('PARK_KINDS is exactly the apply_runs.park_kind CHECK set', () => {
    expect([...PARK_KINDS]).toEqual([
      'captcha', 'cloudflare', 'login', 'account_wall', 'resume_required',
      'needs_answer', 'awaiting_review', 'external_redirect', 'rate_limited', 'other',
    ]);
  });

  it('EVIDENCE_KINDS is exactly the apply_runs.evidence_kind CHECK set', () => {
    expect([...EVIDENCE_KINDS]).toEqual([
      'text_became_success', 'new_confirmation_node', 'confirm_signal',
      'url_confirmation', 'modal_close_confirmed', 'manual_confirmed', 'legacy_untrusted',
    ]);
  });

  it('only legacy_untrusted is untrustworthy — mirrors the submit-truth CHECK', () => {
    expect([...TRUSTWORTHY_EVIDENCE_KINDS]).not.toContain('legacy_untrusted');
    expect(isTrustworthyEvidence('legacy_untrusted')).toBe(false);
    expect(isTrustworthyEvidence(null)).toBe(false);
    expect(isTrustworthyEvidence(undefined)).toBe(false);
    for (const k of TRUSTWORTHY_EVIDENCE_KINDS) expect(isTrustworthyEvidence(k)).toBe(true);
  });

  it('STEP_PHASES is exactly the apply_run_steps.phase CHECK set', () => {
    expect([...STEP_PHASES]).toEqual([
      'open', 'navigate', 'classify', 'detect', 'fill', 'answer', 'upload',
      'advance', 'verify', 'park', 'resume', 'finish',
    ]);
  });
});
