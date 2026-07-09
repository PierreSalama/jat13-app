// The SW→app WIRE-FRAMING contract. The app's ws-gateway.parseFrame validates the inbound frame's
// `body` against ExtEventSchema (the event carries its own discriminating `kind`; the outer envelope
// only repeats kind/epoch/runId for routing). A regression here — putting the raw payload in `body`
// instead of a full ExtEvent — silently DROPS every upward frame at the gateway (commands time out,
// awaitResume never resolves). These tests reproduce EXACTLY the envelopes the SW's sendEvent() emits
// and assert they survive the gateway's parse path (Envelope wrapper, then ExtEvent of the body).
import { describe, it, expect } from 'vitest';
import { Envelope, ExtEvent } from '@jat13/shared/protocol';
import type { CmdResult, PageSnapshot } from '@jat13/shared/protocol';
import { PROTOCOL_VERSION } from '@jat13/shared/constants';

/** Mirror of sw.ts sendEvent(): Envelope{ v, kind: event.kind, seq, epoch?, runId?, body: <ExtEvent> }. */
function frameLikeSw(event: unknown, opts: { epoch?: string; runId?: string; seq?: number } = {}): unknown {
  const env: Record<string, unknown> = {
    v: PROTOCOL_VERSION,
    kind: (event as { kind: string }).kind,
    seq: opts.seq ?? 1,
    body: event,
  };
  if (opts.epoch) env.epoch = opts.epoch;
  if (opts.runId) env.runId = opts.runId;
  return env;
}

/** The gateway's parse path: Envelope wrapper first, then ExtEvent of the body. */
function parseLikeGateway(frame: unknown): ReturnType<typeof ExtEvent.safeParse> {
  const env = Envelope.safeParse(frame);
  if (env.success) {
    const inner = ExtEvent.safeParse(env.data.body);
    if (inner.success) return inner;
  }
  return ExtEvent.safeParse(frame);
}

const snapshot = (): PageSnapshot => ({
  v: 1, epoch: 'ep_x', url: 'https://x', title: 't', readyState: 'complete',
  quietMs: 0, frames: [{ framePath: '', frameHost: 'x', nodes: [] }], truncated: false, hash: 'sha1_0',
});

describe('SW→app wire framing (ws-gateway.parseFrame interop)', () => {
  it('cmd_result: the body is a full ExtEvent (kind+seq+result), not a bare CmdResult', () => {
    const result: CmdResult = { ok: true, snapshotDelta: snapshot() };
    const frame = frameLikeSw({ kind: 'cmd_result', seq: 7, result }, { epoch: 'ep_x', runId: 'r1', seq: 7 });
    const parsed = parseLikeGateway(frame);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'cmd_result') {
      expect(parsed.data.seq).toBe(7);
      expect(parsed.data.result.ok).toBe(true);
    }
  });

  it('page_ready: body carries kind+epoch+url+snapshot and parses', () => {
    const frame = frameLikeSw({ kind: 'page_ready', epoch: 'ep_x', url: 'https://x', snapshot: snapshot() }, { epoch: 'ep_x' });
    const parsed = parseLikeGateway(frame);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind).toBe('page_ready');
  });

  it('page_gone: body carries kind+epoch+reason and parses', () => {
    const frame = frameLikeSw({ kind: 'page_gone', epoch: 'ep_x', reason: 'nav' }, { epoch: 'ep_x' });
    const parsed = parseLikeGateway(frame);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind).toBe('page_gone');
  });

  it('hello: body carries kind+tabs and parses', () => {
    const frame = frameLikeSw({ kind: 'hello', tabs: [{ tabId: 1, epoch: 'ep_x', url: 'https://x' }] });
    const parsed = parseLikeGateway(frame);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind).toBe('hello');
  });

  it('REGRESSION: a frame whose body is a BARE CmdResult (old-broken shape) is REJECTED', () => {
    // This is exactly what the pre-fix SW emitted — the app must NOT accept it (proves the bug is real).
    const broken = {
      v: PROTOCOL_VERSION, kind: 'cmd_result', seq: 7, epoch: 'ep_x',
      body: { ok: true } as CmdResult, // body is the raw CmdResult, NOT a { kind:'cmd_result', seq, result }
    };
    const parsed = parseLikeGateway(broken);
    expect(parsed.success).toBe(false);
  });
});
