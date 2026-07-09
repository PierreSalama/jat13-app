// The wire contract must reject malformed messages at the boundary — these assert the zod schemas
// both accept real shapes and refuse broken ones (the gateway relies on this to stay honest).
import { describe, it, expect } from 'vitest';
import { PageSnapshot, Cmd, CmdResult, ExtEvent, Envelope } from '@jat13/shared/protocol';
import { AdapterDoc, parseAdapter, Signal, Oracle } from '@jat13/shared/adapter-schema';

const snapshot = {
  v: 1,
  epoch: 'ep_1',
  url: 'https://linkedin.com/jobs/view/1',
  title: 'x',
  readyState: 'complete',
  quietMs: 800,
  frames: [{ framePath: '', frameHost: 'linkedin.com', nodes: [
    { nid: 1, role: 'button', name: 'Easy Apply', rect: [0, 0, 100, 30], path: 'button#a' },
  ] }],
  truncated: false,
  hash: 'abc',
};

describe('protocol wire contract', () => {
  it('accepts a well-formed PageSnapshot and round-trips', () => {
    const parsed = PageSnapshot.parse(snapshot);
    expect(parsed.frames[0]!.nodes[0]!.name).toBe('Easy Apply');
  });

  it('rejects a snapshot with a bad role / wrong version', () => {
    expect(() => PageSnapshot.parse({ ...snapshot, v: 2 })).toThrow();
    const bad = structuredClone(snapshot);
    (bad.frames[0]!.nodes[0] as { role: string }).role = 'supernova';
    expect(() => PageSnapshot.parse(bad)).toThrow();
  });

  it('discriminates the Cmd union by op and rejects unknown ops', () => {
    expect(Cmd.parse({ op: 'fill', target: { nid: 3 }, value: 'x', method: 'auto' }).op).toBe('fill');
    expect(Cmd.parse({ op: 'waitFor', cond: { kind: 'enabled', target: { nid: 3 } }, timeoutMs: 5000 }).op).toBe('waitFor');
    expect(() => Cmd.parse({ op: 'teleport', target: { nid: 3 } })).toThrow();
    expect(() => Cmd.parse({ op: 'fill', target: { nid: 3 }, value: 'x', method: 'telepathy' })).toThrow();
  });

  it('carries a snapshot delta on a CmdResult', () => {
    const r = CmdResult.parse({ ok: true, snapshotDelta: snapshot });
    expect(r.snapshotDelta?.hash).toBe('abc');
  });

  it('discriminates ExtEvent (page_gone resume backbone) and validates the envelope', () => {
    expect(ExtEvent.parse({ kind: 'page_gone', epoch: 'ep_1', reason: 'bfcache' }).kind).toBe('page_gone');
    expect(ExtEvent.parse({ kind: 'page_ready', epoch: 'ep_1', url: 'u', snapshot }).kind).toBe('page_ready');
    expect(() => ExtEvent.parse({ kind: 'page_gone', epoch: 'ep_1', reason: 'meteor' })).toThrow();
    expect(Envelope.parse({ v: 1, kind: 'cmd', seq: 7, body: {} }).seq).toBe(7);
    expect(() => Envelope.parse({ v: 1, kind: 'cmd', body: {} })).toThrow(); // seq required
  });
});

const adapter = {
  id: 'linkedin-easy-apply',
  version: 1,
  engineMin: '1.0.0',
  source: 'linkedin',
  hosts: ['*.linkedin.com'],
  priority: 100,
  pages: [
    { key: 'job_view', kind: 'jobView', classify: { all: [{ url: '/jobs/(view|collections)/' }] }, next: ['apply_modal'] },
    { key: 'apply_modal', kind: 'form', classify: { any: [{ selectorLike: { role: 'dialog', nameRx: 'apply' } }] },
      formRoot: [{ kind: 'dialogRole' }], fill: { requiredFirst: true }, next: ['review', 'confirmation'] },
  ],
  advance: { labels: ['^(continue|next)$'], finalLabels: ['^submit application$'], neverLabels: ['^easy apply'],
    disabledIsWaiting: true, waitEnabledMs: 20000 },
  oracles: {
    success: [{ id: 'ok-url', kind: 'urlMatches', rx: 'post-apply', level: 'grounded' }],
    failure: [], humanGate: [{ id: 'cap', kind: 'realCaptchaWidget' }],
  },
  limits: { maxSteps: 12 },
};

describe('adapter schema', () => {
  it('parses a real linkedin-easy-apply adapter and applies defaults', () => {
    const doc: AdapterDoc = parseAdapter(adapter);
    expect(doc.id).toBe('linkedin-easy-apply');
    expect(doc.fieldMap).toEqual([]); //            defaulted
    expect(doc.limits.maxSameActionRepeat).toBe(2); // defaulted
    expect(doc.advance.maxLabelLen).toBe(40); //     defaulted
  });

  it('rejects a malformed adapter (bad source, empty pages, bad oracle level)', () => {
    expect(() => parseAdapter({ ...adapter, source: 'monster' })).toThrow();
    expect(() => parseAdapter({ ...adapter, pages: [] })).toThrow();
    expect(() => Oracle.parse({ id: 'x', kind: 'urlMatches', rx: 'y', level: 'inferred' })).toThrow(); // urlMatches is verified|grounded
  });

  it('Signal union accepts each variant', () => {
    expect(() => Signal.parse({ url: '/x' })).not.toThrow();
    expect(() => Signal.parse({ fieldCount: { min: 1, radioAware: true } })).not.toThrow();
    expect(() => Signal.parse({ nonsense: true })).toThrow();
  });
});
