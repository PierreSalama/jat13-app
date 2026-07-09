import { describe, it, expect } from 'vitest';
import type { PageSnapshot, SnapNode } from '@jat13/shared/protocol';
import type { PageDef, Oracle } from '@jat13/shared/adapter-schema';
import {
  stripLoadingPrefix, normalizeLabel, radioAwareFieldCount, findAdvanceCandidates,
} from '../../app/src/main/engine/labels.js';
import { matchSignal, classifyPage, pageMatches, stepGraphAllows } from '../../app/src/main/engine/classifier.js';
import { evaluateSuccess, evaluateHumanGate } from '../../app/src/main/engine/oracle.js';

let nid = 0;
function node(role: SnapNode['role'], name: string, extra: Partial<SnapNode> = {}): SnapNode {
  return { nid: nid++, role, name, rect: [0, 0, 100, 30], path: `p${nid}`, ...extra };
}
function snap(url: string, nodes: SnapNode[]): PageSnapshot {
  return { v: 1, epoch: 'e', url, title: '', readyState: 'complete', quietMs: 800,
    frames: [{ framePath: '', frameHost: 'linkedin.com', nodes }], truncated: false, hash: 'h' };
}

describe('labels (v11 scars)', () => {
  it('strips a loading prefix so a waiting button is present, not absent (v11.86)', () => {
    expect(stripLoadingPrefix('Loading…Continue')).toBe('Continue');
    expect(stripLoadingPrefix('Loading... Submit application')).toBe('Submit application');
    expect(normalizeLabel('  CONTINUE ')).toBe('continue');
  });

  it('counts a radio group ONCE (v11.56 radio-aware grounding)', () => {
    const nodes = [
      node('radio', 'Yes', { group: 5 }), node('radio', 'No', { group: 5 }),
      node('radio', 'Maybe', { group: 5 }), node('textbox', 'Email'),
    ];
    expect(radioAwareFieldCount(nodes)).toBe(2); // one group + one textbox
  });

  it('finds advance buttons but never the opener', () => {
    const nodes = [node('button', 'Easy Apply'), node('button', 'Continue'), node('button', 'Loading…Submit application')];
    const cands = findAdvanceCandidates(nodes, ['^continue$', '^submit application$'], ['^easy apply']);
    expect(cands.map((n) => n.name).sort()).toEqual(['Continue', 'Loading…Submit application']);
  });
});

describe('classifier', () => {
  const pages: PageDef[] = [
    { key: 'job_view', kind: 'jobView',
      classify: { all: [{ url: '/jobs/(view|collections)/' }], none: [{ url: '/apply/' }] }, next: ['apply_modal'] },
    { key: 'apply_modal', kind: 'form',
      classify: { any: [{ selectorLike: { role: 'dialog', nameRx: 'apply' } }] }, next: ['review', 'confirmation'] },
  ];

  it('matches individual signals', () => {
    const s = snap('https://linkedin.com/jobs/view/123', [node('button', 'Easy Apply')]);
    expect(matchSignal(s, { url: '/jobs/view/' })).toBe(true);
    expect(matchSignal(s, { buttonLabel: '^easy apply' })).toBe(true);
    expect(matchSignal(s, { fieldCount: { min: 1, radioAware: true } })).toBe(false); // a button isn't a field
  });

  it('classifies the right page and honors none[]', () => {
    const jobView = snap('https://linkedin.com/jobs/view/123', [node('button', 'Easy Apply')]);
    expect(classifyPage(jobView, pages)?.key).toBe('job_view');

    // once the modal is open on the same URL, BOTH pages match; step-graph preference (prev=job_view)
    // resolves it to the successor apply_modal rather than the underlying job_view.
    const modal = snap('https://linkedin.com/jobs/view/123', [node('dialog', 'Apply to Aurora Labs'), node('textbox', 'Email')]);
    expect(classifyPage(modal, pages, pages[0])?.key).toBe('apply_modal');

    // on the /apply/ full-page URL, job_view's none[] rejects it
    const applyPage = snap('https://linkedin.com/jobs/view/123/apply/', [node('button', 'Continue')]);
    expect(pageMatches(applyPage, pages[0]!)).toBe(false);
  });

  it('enforces the step graph (unexpected page is refused)', () => {
    const jobView = pages[0]!;
    expect(stepGraphAllows(jobView, 'apply_modal')).toBe(true);
    expect(stepGraphAllows(jobView, 'job_view')).toBe(true); // re-render
    expect(stepGraphAllows(jobView, 'confirmation')).toBe(false); // not a declared successor
    expect(stepGraphAllows(null, 'anything')).toBe(true); // first classification
  });
});

describe('oracle (submit truth)', () => {
  const success: Oracle[] = [
    { id: 'url', kind: 'urlMatches', rx: 'post-apply', level: 'grounded' },
    { id: 'text', kind: 'textPresent', rx: 'application (was )?sent', level: 'verified' },
  ];

  it('grounds a submit from a URL oracle and yields a trustworthy evidence kind', () => {
    const s = snap('https://smartapply.indeed.com/beta/form/post-apply', []);
    const r = evaluateSuccess(s, success, 1000);
    expect(r.evidence.verification).toBe('grounded');
    expect(r.evidenceKind).toBe('url_confirmation');
  });

  it('prefers verified text evidence when present', () => {
    const s = snap('https://linkedin.com/jobs/view/1', [node('text', 'Your application was sent')]);
    const r = evaluateSuccess(s, success, 1000);
    expect(r.evidence.verification).toBe('verified');
    expect(r.evidenceKind).toBe('text_became_success');
  });

  it('returns NO evidence kind when nothing confirms (→ ready_for_review, never submitted)', () => {
    const s = snap('https://linkedin.com/jobs/view/1', [node('text', 'Some unrelated page')]);
    const r = evaluateSuccess(s, success, 1000);
    expect(r.evidence.verification).toBe('none');
    expect(r.evidenceKind).toBeUndefined();
  });

  it('detects a real captcha widget as a human gate', () => {
    const gate: Oracle[] = [{ id: 'cap', kind: 'realCaptchaWidget' }];
    const withCaptcha = snap('https://linkedin.com/checkpoint', [
      node('iframe', 'recaptcha challenge', { rect: [0, 0, 300, 80], attrs: { id: 'g-recaptcha' } }),
    ]);
    expect(evaluateHumanGate(withCaptcha, gate)?.id).toBe('cap');
    // an invisible badge does NOT trip it (v11.59)
    const badge = snap('https://linkedin.com/x', [node('iframe', 'recaptcha', { rect: [0, 0, 1, 1] })]);
    expect(evaluateHumanGate(badge, gate)).toBeNull();
  });
});
