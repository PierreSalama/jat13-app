// ws-gateway — the REAL RunGateway over a live WebSocket. We stand up an http.Server on an ephemeral
// port, attach the gateway with a token, and drive it with a fake service-worker (the 'ws' client) that
// speaks the exact wire contract. This proves the transport the runner relies on end-to-end:
//   (1) command() resolves when the SW replies a cmd_result with the matching seq + a snapshotDelta
//   (2) a wrong token is rejected at the HTTP upgrade
//   (3) command() rejects with PortGoneError when the port dies (page_gone OR socket close) first
//   (4) awaitResume() resolves on a page_ready
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, type RawData } from 'ws';
import type { Cmd, CmdResult, ExtEvent, PageSnapshot } from '@jat13/shared/protocol';
import { IDENTITY } from '@jat13/shared/constants';
import { WsGateway } from '../../app/src/main/engine/ws-gateway.js';
import { PortGoneError } from '../../app/src/main/engine/gateway.js';

/** The gateway mounts on the shared wsPath — the test tracks the constant, not a hardcoded '/ext'. */
const WS_PATH = IDENTITY.wsPath;
const TOKEN = 'pair-secret-abc123';
const RUN_ID = 'run-1';
const EPOCH = 'ep0';

/** A minimal but valid PageSnapshot — passes the zod schema at the gateway boundary. */
function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    v: 1,
    epoch: EPOCH,
    url: 'https://www.linkedin.com/jobs/view/123',
    title: 'LinkedIn',
    readyState: 'complete',
    quietMs: 900,
    frames: [{ framePath: '', frameHost: 'www.linkedin.com', nodes: [] }],
    truncated: false,
    hash: 'h0',
    ...overrides,
  };
}

/** Inbound-frame builder: an Envelope wrapping an ExtEvent (the preferred wire shape). */
function frame(event: ExtEvent, extra: { seq?: number; runId?: string; epoch?: string } = {}): string {
  return JSON.stringify({
    v: 1,
    kind: event.kind,
    runId: extra.runId,
    epoch: extra.epoch,
    seq: extra.seq ?? 0,
    body: event,
  });
}

interface OutboundEnvelope {
  v: 1;
  kind: string;
  runId?: string;
  epoch?: string;
  seq: number;
  body: Cmd;
}

describe('ws-gateway (real WebSocket transport)', () => {
  let server: HttpServer;
  let gateway: WsGateway;
  let port: number;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    server = createServer();
    gateway = new WsGateway({ token: TOKEN, commandTimeoutMs: 1_000 });
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      try {
        c.terminate();
      } catch {
        /* ignore */
      }
    }
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Connect a fake service-worker client with the given token; resolves once OPEN. */
  function connectSw(token = TOKEN, via: 'query' | 'header' = 'query'): Promise<WebSocket> {
    const url = via === 'query' ? `ws://127.0.0.1:${port}${WS_PATH}?token=${token}` : `ws://127.0.0.1:${port}${WS_PATH}`;
    const opts = via === 'header' ? { headers: { 'X-JAT13-Token': token } } : undefined;
    const ws = new WebSocket(url, opts);
    clients.push(ws);
    return new Promise<WebSocket>((resolve, reject) => {
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  /** Send a hello so the gateway learns runId→epoch (needed to route page_ready/page_gone by epoch). */
  function sendHello(ws: WebSocket): void {
    const hello: ExtEvent = { kind: 'hello', tabs: [{ tabId: 1, epoch: EPOCH, url: 'x', runId: RUN_ID }] };
    ws.send(frame(hello));
  }

  it('(1) command() resolves when the SW replies a cmd_result with the matching seq + snapshotDelta', async () => {
    const sw = await connectSw();
    sendHello(sw);

    // fake SW: echo back a cmd_result for whatever seq it receives, with a fresh snapshot delta.
    sw.on('message', (data: RawData) => {
      const env = JSON.parse(data.toString()) as OutboundEnvelope;
      expect(env.kind).toBe('cmd');
      expect(env.runId).toBe(RUN_ID);
      const result: CmdResult = { ok: true, snapshotDelta: snapshot({ hash: 'h-after' }) };
      const reply: ExtEvent = { kind: 'cmd_result', seq: env.seq, result };
      sw.send(frame(reply, { seq: env.seq }));
    });

    const cmd: Cmd = { op: 'click', target: { nid: 10 } };
    const res = await gateway.command(RUN_ID, EPOCH, cmd);
    expect(res.ok).toBe(true);
    expect(res.snapshotDelta?.hash).toBe('h-after');
  });

  it('(1b) ignores a DUPLICATE cmd_result for an already-settled seq (idempotent)', async () => {
    const sw = await connectSw();
    sendHello(sw);
    let seenSeq = -1;
    sw.on('message', (data: RawData) => {
      const env = JSON.parse(data.toString()) as OutboundEnvelope;
      seenSeq = env.seq;
      const reply: ExtEvent = { kind: 'cmd_result', seq: env.seq, result: { ok: true } };
      sw.send(frame(reply, { seq: env.seq }));
      sw.send(frame(reply, { seq: env.seq })); // duplicate — must not blow up or double-settle
    });

    const res = await gateway.command(RUN_ID, EPOCH, { op: 'snapshot' });
    expect(res.ok).toBe(true);
    // a second command must get a fresh, monotonic seq (not the duplicated one)
    const res2 = await gateway.command(RUN_ID, EPOCH, { op: 'snapshot' });
    expect(res2.ok).toBe(true);
    expect(seenSeq).toBeGreaterThan(0);
  });

  it('(2) rejects the upgrade when the token is wrong', async () => {
    await expect(connectSw('WRONG-TOKEN')).rejects.toThrow();
  });

  it('(2b) accepts the token via the X-JAT13-Token header too', async () => {
    const sw = await connectSw(TOKEN, 'header');
    expect(sw.readyState).toBe(WebSocket.OPEN);
  });

  it('(3a) command() rejects with PortGoneError when a page_gone arrives before the result', async () => {
    const sw = await connectSw();
    sendHello(sw);
    // fake SW: on any command, report the port died instead of replying a cmd_result.
    sw.on('message', () => {
      const gone: ExtEvent = { kind: 'page_gone', epoch: EPOCH, reason: 'nav' };
      sw.send(frame(gone, { epoch: EPOCH }));
    });

    await expect(gateway.command(RUN_ID, EPOCH, { op: 'click', target: { nid: 10 } })).rejects.toBeInstanceOf(
      PortGoneError,
    );
  });

  it('(3b) command() rejects with PortGoneError when the socket CLOSES before replying', async () => {
    const sw = await connectSw();
    sendHello(sw);
    sw.on('message', () => sw.close()); // die without answering

    await expect(gateway.command(RUN_ID, EPOCH, { op: 'click', target: { nid: 10 } })).rejects.toBeInstanceOf(
      PortGoneError,
    );
  });

  it('(3c) command() rejects with PortGoneError on timeout when no result ever arrives', async () => {
    const sw = await connectSw();
    sendHello(sw);
    sw.on('message', () => {
      /* swallow — never reply, force the TTL */
    });

    await expect(gateway.command(RUN_ID, EPOCH, { op: 'snapshot' })).rejects.toBeInstanceOf(PortGoneError);
  });

  it('(4) awaitResume() resolves on a page_ready for the run', async () => {
    const sw = await connectSw();
    sendHello(sw); // gateway learns RUN_ID → EPOCH

    const resumeP = gateway.awaitResume(RUN_ID, 2_000);

    // A real committed navigation mints a FRESH epoch (§3.4); page_ready + its snapshot both carry it.
    // The resume MUST resolve to that LIVE epoch (not the stale hello epoch) or the next command would
    // fire against a dead document and get `stale_epoch`.
    const freshEpoch = 'ep1';
    const ready: ExtEvent = {
      kind: 'page_ready',
      epoch: freshEpoch,
      url: 'https://www.linkedin.com/jobs/view/123',
      snapshot: snapshot({ epoch: freshEpoch, hash: 'resumed' }),
    };
    sw.send(frame(ready, { epoch: freshEpoch }));

    const info = await resumeP;
    expect(info.epoch).toBe(freshEpoch); // the LIVE epoch, == snapshot.epoch — the runner targets THIS
    expect(info.snapshot.epoch).toBe(freshEpoch);
    expect(info.snapshot.hash).toBe('resumed');
  });

  it('(4b) awaitResume() rejects on TTL expiry when no page_ready arrives', async () => {
    await connectSw();
    await expect(gateway.awaitResume(RUN_ID, 150)).rejects.toThrow(/TTL/i);
  });

  it('(5) command() rejects with PortGoneError when NO service worker is connected', async () => {
    // no connectSw() — the gateway has never seen a socket; a command must fail fast, not hang.
    await expect(gateway.command(RUN_ID, EPOCH, { op: 'snapshot' })).rejects.toBeInstanceOf(PortGoneError);
  });

  it('(6) a cmd_result for an UNKNOWN seq is a harmless no-op, and later commands still work', async () => {
    const sw = await connectSw();
    sendHello(sw);
    // Fire a spurious cmd_result for a seq that was never issued — must not throw or wedge the socket.
    sw.send(frame({ kind: 'cmd_result', seq: 9999, result: { ok: true } }, { seq: 9999 }));

    sw.on('message', (data: RawData) => {
      const env = JSON.parse(data.toString()) as OutboundEnvelope;
      sw.send(frame({ kind: 'cmd_result', seq: env.seq, result: { ok: true } }, { seq: env.seq }));
    });
    const res = await gateway.command(RUN_ID, EPOCH, { op: 'snapshot' });
    expect(res.ok).toBe(true);
  });

  it('(7) after close() every in-flight command rejects with PortGoneError and never resolves', async () => {
    const sw = await connectSw();
    sendHello(sw);
    sw.on('message', () => {
      /* never reply; we will close() the gateway out from under it */
    });
    const p = gateway.command(RUN_ID, EPOCH, { op: 'snapshot' });
    // Attach the rejection assertion BEFORE close() so the rejection is never momentarily unhandled.
    const assertion = expect(p).rejects.toBeInstanceOf(PortGoneError);
    await gateway.close();
    await assertion;
  });

  it('drops a malformed frame without throwing, and keeps serving commands', async () => {
    const sw = await connectSw();
    sendHello(sw);
    sw.send('this is not json');
    sw.send(JSON.stringify({ v: 1, kind: 'cmd_result', seq: 'not-a-number' })); // bad shape
    sw.on('message', (data: RawData) => {
      const env = JSON.parse(data.toString()) as OutboundEnvelope;
      sw.send(frame({ kind: 'cmd_result', seq: env.seq, result: { ok: true } }, { seq: env.seq }));
    });

    const res = await gateway.command(RUN_ID, EPOCH, { op: 'snapshot' });
    expect(res.ok).toBe(true);
  });
});
