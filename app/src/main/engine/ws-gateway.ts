// The REAL RunGateway (Pillar 3 §3) — the runner's transport over a live WebSocket to the thin MV3
// extension's service worker. driveRun() (runner.ts) is transport-agnostic and speaks Cmd/CmdResult;
// this class turns each command into a sequenced Envelope, ships it to the connected SW, and awaits the
// matching cmd_result by seq. A dead port (page_gone / socket close / timeout) surfaces as a
// PortGoneError so the runner parks the run to waiting_page and resumes by re-classifying the live page.
//
// Wire contract (never weakened here — see shared/src/protocol):
//   - outbound: Envelope{ v:1, kind:'cmd', runId, epoch, seq, body: Cmd }
//   - inbound : Envelope{ v:1, kind:<ExtEvent.kind>, runId?, epoch?, seq, body: ExtEvent }
//              (a bare ExtEvent frame is also accepted, for robustness)
// EVERY inbound frame is zod-parsed; malformed frames are logged and DROPPED, never thrown.

import type { Server as HttpServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Cmd, CmdResult, ExtEvent, PageSnapshot } from '@jat13/shared/protocol';
import { Envelope, ExtEvent as ExtEventSchema } from '@jat13/shared/protocol';
import { IDENTITY } from '@jat13/shared/constants';
import { PortGoneError, type ResumeInfo, type RunGateway } from './gateway.js';

/** The path the extension's service worker connects to — the SINGLE source of truth is the shared
 *  constant (never hardcode: the real SW connects to IDENTITY.wsPath). */
const WS_PATH: string = IDENTITY.wsPath;
/** Default per-command TTL: no cmd_result within this window ⇒ the port is treated as dead. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

interface PendingCommand {
  readonly runId: string;
  resolve(result: CmdResult): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface PendingResume {
  resolve(info: ResumeInfo): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/** What we've learned about a run's live tab from hello/page_ready. */
interface RunState {
  epoch: string;
}

export interface WsGatewayOptions {
  /** the pairing token; the upgrade must present it via ?token= or the X-JAT13-Token header. */
  token: string;
  log?: (msg: string) => void;
  /** override the per-command TTL (default ~30s). */
  commandTimeoutMs?: number;
}

export class WsGateway implements RunGateway {
  private readonly token: string;
  private readonly log: (msg: string) => void;
  private readonly commandTimeoutMs: number;

  private wss: WebSocketServer | null = null;
  /** the single connected service-worker socket (the extension is a singleton SW). */
  private sw: WebSocket | null = null;

  private seqCounter = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly resumes = new Map<string, PendingResume>();
  private readonly runs = new Map<string, RunState>();

  constructor(opts: WsGatewayOptions) {
    this.token = opts.token;
    this.log = opts.log ?? (() => {});
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  // --------------------------------------------------------------------------- attach / auth

  /**
   * Mount the ws.WebSocketServer on `/ext` of an existing http.Server and authenticate every upgrade.
   * A wrong/absent token is rejected with a 401 before the socket is accepted.
   */
  attach(server: HttpServer): void {
    if (this.wss) throw new Error('WsGateway already attached');
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        this.rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }
      if (url.pathname !== WS_PATH) return; // not ours — let other upgrade handlers (if any) decide

      const presented = url.searchParams.get('token') ?? headerToken(req);
      if (!presented || presented !== this.token) {
        this.log(`upgrade rejected: bad token on ${url.pathname}`);
        this.rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws: WebSocket) => this.onConnection(ws));
  }

  private rejectUpgrade(socket: Socket, code: number, reason: string): void {
    try {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
    } catch {
      /* socket may already be gone */
    }
    socket.destroy();
  }

  private onConnection(ws: WebSocket): void {
    // A new SW connection supersedes any stale one (the extension is a singleton).
    if (this.sw && this.sw !== ws && this.sw.readyState === WebSocket.OPEN) {
      try {
        this.sw.close();
      } catch {
        /* ignore */
      }
    }
    this.sw = ws;
    this.log('service worker connected');

    ws.on('message', (data: RawData) => this.onMessage(data));
    ws.on('close', () => this.onSocketClosed(ws));
    ws.on('error', (err: Error) => this.log(`socket error: ${err.message}`));
  }

  // --------------------------------------------------------------------------- inbound

  private onMessage(data: RawData): void {
    const event = this.parseFrame(data);
    if (!event) return; // malformed — already logged, dropped
    this.dispatch(event);
  }

  /** Parse a raw frame into a validated ExtEvent, or null if malformed. NEVER throws. */
  private parseFrame(data: RawData): ExtEvent | null {
    let json: unknown;
    try {
      json = JSON.parse(toText(data));
    } catch {
      this.log('dropped frame: invalid JSON');
      return null;
    }

    // Preferred wire shape: an Envelope whose body is an ExtEvent.
    const env = Envelope.safeParse(json);
    if (env.success) {
      const inner = ExtEventSchema.safeParse(env.data.body);
      if (inner.success) return inner.data;
      // An Envelope that isn't wrapping an ExtEvent body (e.g. a bare event mislabeled) — fall through.
    }

    // Fallback: a bare ExtEvent frame (no envelope wrapper).
    const bare = ExtEventSchema.safeParse(json);
    if (bare.success) return bare.data;

    this.log('dropped frame: not a valid Envelope<ExtEvent> or ExtEvent');
    return null;
  }

  private dispatch(event: ExtEvent): void {
    switch (event.kind) {
      case 'hello':
        for (const tab of event.tabs) {
          if (tab.runId) {
            this.runs.set(tab.runId, { epoch: tab.epoch });
            this.settleResume(tab.runId, tab.epoch, undefined);
          }
        }
        break;
      case 'page_ready': {
        const runId = this.runForEpoch(event.epoch);
        if (runId) this.runs.set(runId, { epoch: event.epoch });
        this.settleResumeByEpoch(event.epoch, event.snapshot);
        break;
      }
      case 'page_gone':
        this.failRunCommands(this.runForEpoch(event.epoch), goneReason(event.reason));
        break;
      case 'cmd_result':
        this.settleCommand(event.seq, event.result);
        break;
      case 'mutated':
      case 'dialog':
      case 'tab_error':
        // Nothing the runner needs; the next command's snapshotDelta reflects reality.
        break;
    }
  }

  /** Find the runId whose known tab epoch matches (page_ready/page_gone carry only an epoch). */
  private runForEpoch(epoch: string): string | undefined {
    for (const [runId, state] of this.runs) {
      if (state.epoch === epoch) return runId;
    }
    return undefined;
  }

  // --------------------------------------------------------------------------- command

  async command(runId: string, epoch: string, cmd: Cmd): Promise<CmdResult> {
    const ws = this.sw;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new PortGoneError('crash');
    }

    const seq = ++this.seqCounter;
    const envelope = { v: 1 as const, kind: 'cmd' as const, runId, epoch, seq, body: cmd };

    return new Promise<CmdResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(seq);
        if (p && !p.settled) {
          p.settled = true;
          this.pending.delete(seq);
          reject(new PortGoneError('crash'));
        }
      }, this.commandTimeoutMs);
      // don't keep the event loop alive purely for a pending command
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(seq, { runId, resolve, reject, timer, settled: false });

      try {
        ws.send(JSON.stringify(envelope));
      } catch (err) {
        const p = this.pending.get(seq);
        if (p && !p.settled) {
          p.settled = true;
          clearTimeout(p.timer);
          this.pending.delete(seq);
          this.log(`send failed for seq ${seq}: ${(err as Error).message}`);
          reject(new PortGoneError('crash'));
        }
      }
    });
  }

  /** Resolve a pending command with its result. Idempotent: a duplicate seq is ignored. */
  private settleCommand(seq: number, result: CmdResult): void {
    const p = this.pending.get(seq);
    if (!p || p.settled) return; // duplicate / already-settled cmd_result — idempotent
    p.settled = true;
    clearTimeout(p.timer);
    this.pending.delete(seq);
    p.resolve(result);
  }

  /** Reject every in-flight command for a run (or all, if runId unknown) with a PortGoneError. */
  private failRunCommands(runId: string | undefined, err: PortGoneError): void {
    for (const [seq, p] of this.pending) {
      if (p.settled) continue;
      if (runId !== undefined && p.runId !== runId) continue;
      p.settled = true;
      clearTimeout(p.timer);
      this.pending.delete(seq);
      p.reject(err);
    }
  }

  private onSocketClosed(ws: WebSocket): void {
    if (this.sw === ws) this.sw = null;
    this.log('service worker disconnected');
    // The port is gone: every in-flight command dies, and any waiter for a resume is failed.
    this.failRunCommands(undefined, new PortGoneError('close'));
    for (const [runId, r] of this.resumes) {
      if (r.settled) continue;
      r.settled = true;
      clearTimeout(r.timer);
      this.resumes.delete(runId);
      r.reject(new PortGoneError('close'));
    }
  }

  // --------------------------------------------------------------------------- awaitResume

  awaitResume(runId: string, timeoutMs: number): Promise<ResumeInfo> {
    // If the run already reconnected between the PortGoneError and this call, resolve immediately
    // only when we also have a fresh snapshot — otherwise wait for the next page_ready/hello.
    return new Promise<ResumeInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        const r = this.resumes.get(runId);
        if (r && !r.settled) {
          r.settled = true;
          this.resumes.delete(runId);
          reject(new Error(`awaitResume TTL expired for run ${runId}`));
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.resumes.set(runId, { resolve, reject, timer, settled: false });
    });
  }

  /** page_ready → resolve the pending resume for whichever run owns this epoch. */
  private settleResumeByEpoch(epoch: string, snapshot: PageSnapshot): void {
    const runId = this.runForEpoch(epoch);
    if (runId) {
      this.settleResume(runId, epoch, snapshot);
      return;
    }
    // No run mapped to this epoch yet: if exactly one resume is pending, this reconnect is for it.
    if (this.resumes.size === 1) {
      const onlyRunId = [...this.resumes.keys()][0];
      if (onlyRunId !== undefined) {
        this.runs.set(onlyRunId, { epoch });
        this.settleResume(onlyRunId, epoch, snapshot);
      }
    }
  }

  private settleResume(runId: string, _routingEpoch: string, snapshot: PageSnapshot | undefined): void {
    const r = this.resumes.get(runId);
    if (!r || r.settled) return;
    if (!snapshot) return; // a hello without a snapshot can't complete a resume; wait for page_ready
    // The epoch the runner will target with the next commands MUST be the LIVE page's epoch — i.e. the
    // snapshot's own epoch (a real navigation mints a fresh epoch; §3.4). Never resolve with the stale
    // routing epoch or commands would fire against a dead document and get `stale_epoch`.
    const liveEpoch = snapshot.epoch;
    this.runs.set(runId, { epoch: liveEpoch });
    r.settled = true;
    clearTimeout(r.timer);
    this.resumes.delete(runId);
    r.resolve({ epoch: liveEpoch, snapshot });
  }

  // --------------------------------------------------------------------------- lifecycle

  /** Tear down: close the SW socket + the server, and fail anything still in flight. */
  async close(): Promise<void> {
    this.failRunCommands(undefined, new PortGoneError('close'));
    for (const [, r] of this.resumes) {
      if (r.settled) continue;
      r.settled = true;
      clearTimeout(r.timer);
      r.reject(new PortGoneError('close'));
    }
    this.resumes.clear();

    const ws = this.sw;
    this.sw = null;
    if (ws) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }

    const wss = this.wss;
    this.wss = null;
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }
}

// ------------------------------------------------------------------------------- helpers

function headerToken(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-jat13-token'];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function goneReason(reason: 'nav' | 'close' | 'crash' | 'bfcache'): PortGoneError {
  return new PortGoneError(reason);
}

/** Normalize a ws RawData payload to a UTF-8 string. */
function toText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}
