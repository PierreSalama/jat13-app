// The submit oracle — the app is the ONLY authority on success (Pillar 3 §2.4). The extension never
// stamps a status; there is no passive detector sharing code with the driver. `submitted` requires
// verification ∈ {verified, grounded}; an ambiguous submit downgrades to ready_for_review, never
// submitted. Honest counts beat pretty counts — this is the v11 false-submit class, designed out.
import type { PageSnapshot, SnapNode } from '@jat13/shared/protocol';
import type { Oracle } from '../adapters/schema.js';
import { allNodes, safeRx } from './labels.js';

export type Verification = 'verified' | 'grounded' | 'inferred' | 'none';

export interface EvidenceSignal {
  oracleId: string;
  kind: string;
  value: string;
  at: number;
}
export interface OutcomeEvidence {
  verification: Verification;
  signals: EvidenceSignal[];
}

const RANK: Record<Verification, number> = { none: 0, inferred: 1, grounded: 2, verified: 3 };

/** The trustworthy apply_runs.evidence_kind for a fired success oracle (only verified/grounded qualify). */
export const TRUSTWORTHY_EVIDENCE = ['text_became_success', 'url_confirmation'] as const;
export type TrustworthyEvidenceKind = (typeof TRUSTWORTHY_EVIDENCE)[number];

function successKindFor(kind: string): TrustworthyEvidenceKind {
  return kind === 'textPresent' ? 'text_became_success' : 'url_confirmation';
}

/** Is a node a real, visible captcha widget? (v11.59: exclude invisible badges / 0-size.) */
function isRealCaptcha(n: SnapNode): boolean {
  if (n.role !== 'iframe' && n.role !== 'img' && n.role !== 'group') return false;
  const w = n.rect[2];
  const h = n.rect[3];
  if (w < 60 || h < 30) return false;
  const hay = `${n.name} ${n.attrs?.id ?? ''} ${n.attrs?.testid ?? ''} ${n.attrs?.href ?? ''}`;
  return /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|are you human/i.test(hay);
}

export interface SuccessResult {
  evidence: OutcomeEvidence;
  /** set ONLY when verification ∈ {verified, grounded} — the value the runs DAL records for a real submit. */
  evidenceKind?: TrustworthyEvidenceKind;
}

/** Run the adapter's success oracles against the post-submit snapshot. */
export function evaluateSuccess(snap: PageSnapshot, oracles: readonly Oracle[], now: number): SuccessResult {
  const signals: EvidenceSignal[] = [];
  let best: Verification = 'none';
  let bestKind: TrustworthyEvidenceKind | undefined;

  for (const o of oracles) {
    if (o.kind === 'urlMatches' && safeRx(o.rx).test(snap.url)) {
      signals.push({ oracleId: o.id, kind: o.kind, value: snap.url, at: now });
      if (RANK[o.level] > RANK[best]) {
        best = o.level;
        bestKind = successKindFor(o.kind);
      }
    } else if (o.kind === 'textPresent') {
      const hit = allNodes(snap).find((n) => safeRx(o.rx).test(n.name));
      if (hit) {
        signals.push({ oracleId: o.id, kind: o.kind, value: hit.name.slice(0, 120), at: now });
        if (RANK[o.level] > RANK[best]) {
          best = o.level;
          bestKind = successKindFor(o.kind);
        }
      }
    } else if (o.kind === 'nodeGone') {
      // inferred-level: the prior page's marker is gone. Never enough for `submitted` on its own.
      signals.push({ oracleId: o.id, kind: o.kind, value: o.page, at: now });
      if (RANK['inferred'] > RANK[best]) best = 'inferred';
    }
  }

  const evidence: OutcomeEvidence = { verification: best, signals };
  // Only surface a trustworthy kind when the level actually justifies a submit.
  return (best === 'verified' || best === 'grounded') && bestKind
    ? { evidence, evidenceKind: bestKind }
    : { evidence };
}

/** True when a human-wall oracle fires (captcha/login/verification) → the run parks needs_human. */
export function evaluateHumanGate(snap: PageSnapshot, oracles: readonly Oracle[]): Oracle | null {
  const nodes = allNodes(snap);
  for (const o of oracles) {
    if (o.kind === 'realCaptchaWidget' && nodes.some(isRealCaptcha)) return o;
    if (o.kind === 'challengeCopy' && nodes.some((n) => safeRx(o.rx).test(n.name))) return o;
    if (o.kind === 'textPresent' && nodes.some((n) => safeRx(o.rx).test(n.name))) return o;
    if (o.kind === 'urlMatches' && safeRx(o.rx).test(snap.url)) return o;
  }
  return null;
}

/** True when a definitive dead-end oracle fires → the run fails/parks. */
export function evaluateFailure(snap: PageSnapshot, oracles: readonly Oracle[]): Oracle | null {
  const nodes = allNodes(snap);
  for (const o of oracles) {
    if (o.kind === 'urlMatches' && safeRx(o.rx).test(snap.url)) return o;
    if (o.kind === 'textPresent' && nodes.some((n) => safeRx(o.rx).test(n.name))) return o;
  }
  return null;
}
