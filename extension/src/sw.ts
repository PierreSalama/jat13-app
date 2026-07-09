// The background SERVICE WORKER — the ONLY stateful-ish part of the thin extension, and even here the
// state is just transport plumbing (a socket, a tab registry, per-tab ports), never run state. It:
//   • opens ONE WebSocket to the app gateway (ws://127.0.0.1:<PORTS.app><IDENTITY.wsPath>?token=…),
//     authenticated by the paired token from chrome.storage.local; idle (no retry storm) if unpaired.
//   • mints an epoch = crypto.randomUUID() per (tab × committed navigation).
//   • keeps ONE dedicated apply window (chrome.windows.create({focused:false})); NEVER fronts a window
//     except on an explicit app `frontWindow` command. Tabs are NEVER slots.
//   • relays Cmd envelopes DOWN to the content Port and cmd_result/events UP to the socket.
//   • sends hello{tabs} on (re)connect; a dead Port emits page_gone; a chrome.alarms watchdog
//     ('jat13.reconnect', 0.5min) re-opens a dead socket. Eviction is NORMAL — resume-by-classify (app).
//
// It holds ZERO adapter/apply logic. Every "decision" here is a transport/tab-lifecycle fact.
import { PORTS, IDENTITY, PROTOCOL_VERSION } from '@jat13/shared/constants';
import type { TypedEnvelope, ExtEvent, PageSnapshot, CmdResult } from '@jat13/shared/protocol';

/** The wire frame, as a TS type (the shared `Envelope` is the runtime zod schema; this is its shape). */
type Envelope = TypedEnvelope<unknown>;

/** page_gone reasons (mirrors the ExtEvent.page_gone enum). */
type PageGoneReason = 'nav' | 'close' | 'crash' | 'bfcache';
type DialogKind = 'beforeunload' | 'alert';

function normalizeGoneReason(r: string | undefined): PageGoneReason {
  return r === 'nav' || r === 'close' || r === 'crash' || r === 'bfcache' ? r : 'close';
}

// ---- module-scope transport state (rebuilt freely on SW eviction; app owns real state) -----------
const RECONNECT_ALARM = 'jat13.reconnect';
const APPLY_WINDOW_KEY = 'jat13.applyWindowId';
const TOKEN_KEY = 'jat13Token'; // chrome.storage.local

let socket: WebSocket | null = null;
let controlSeq = 0; // sender-monotonic for control-plane envelopes (no runId)

interface TabEntry {
  tabId: number;
  epoch: string;
  url: string;
  runId?: string;
  lane?: string;
  port?: chrome.runtime.Port | undefined;
  createdAt: number;
}
const tabs = new Map<number, TabEntry>();

// ---------------------------------------------------------------------------
// socket lifecycle
// ---------------------------------------------------------------------------
async function readToken(): Promise<string | null> {
  try {
    const got = await chrome.storage.local.get(TOKEN_KEY);
    const t = got[TOKEN_KEY];
    return typeof t === 'string' && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

function socketAlive(): boolean {
  return !!socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
}

async function ensureSocket(): Promise<void> {
  if (socketAlive()) return;
  const token = await readToken();
  if (!token) return; // unpaired → stay idle; the popup/pairing flow sets the token later.

  const url = `ws://127.0.0.1:${PORTS.app}${IDENTITY.wsPath}?token=${encodeURIComponent(token)}`;
  try {
    socket = new WebSocket(url);
  } catch {
    socket = null;
    return;
  }

  socket.addEventListener('open', () => {
    void sendHello();
  });
  socket.addEventListener('message', (ev: MessageEvent) => {
    void onSocketMessage(ev.data);
  });
  socket.addEventListener('close', () => {
    socket = null; // the alarm watchdog re-opens it
  });
  socket.addEventListener('error', () => {
    try { socket?.close(); } catch { /* noop */ }
    socket = null;
  });
}

function sendUp(env: Envelope): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(env));
  }
}

/**
 * Emit an ExtEvent upward. The wire contract (see shared/src/protocol + ws-gateway.parseFrame) is an
 * Envelope whose BODY is the complete ExtEvent (the app validates `env.body` against ExtEventSchema —
 * the event carries its own discriminating `kind`). The outer envelope repeats kind/epoch/runId only
 * for routing; the source of truth is `body`.
 */
function sendEvent(event: ExtEvent, opts: { epoch?: string; runId?: string; seq?: number } = {}): void {
  const env: Envelope = {
    v: PROTOCOL_VERSION,
    kind: event.kind,
    seq: opts.seq ?? ++controlSeq,
    body: event,
  };
  if (opts.epoch) env.epoch = opts.epoch;
  if (opts.runId) env.runId = opts.runId;
  sendUp(env);
}

async function sendHello(): Promise<void> {
  const list = await snapshotTabRegistry();
  sendEvent({ kind: 'hello', tabs: list });
}

/** hello{tabs}: reconcile the live registry against Chrome's actual tabs. */
async function snapshotTabRegistry(): Promise<Array<{ tabId: number; epoch: string; url: string; runId?: string; lane?: string }>> {
  const out: Array<{ tabId: number; epoch: string; url: string; runId?: string; lane?: string }> = [];
  for (const t of tabs.values()) {
    const entry: { tabId: number; epoch: string; url: string; runId?: string; lane?: string } = {
      tabId: t.tabId, epoch: t.epoch, url: t.url,
    };
    if (t.runId) entry.runId = t.runId;
    if (t.lane) entry.lane = t.lane;
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// downward: app → SW → content port. The app addresses commands by runId+epoch;
// the SW finds the tab whose epoch matches and relays the envelope to its Port.
// ---------------------------------------------------------------------------
async function onSocketMessage(raw: unknown): Promise<void> {
  let env: Envelope;
  try {
    env = JSON.parse(String(raw)) as Envelope;
  } catch {
    return;
  }

  // control commands the SW itself owns (tab lifecycle) — never the content script's job.
  switch (env.kind) {
    case 'openTab': return void openApplyTab(env);
    case 'closeTab': return void closeTab(env);
    case 'frontWindow': return void frontWindow(env);
    case 'setEpoch': return; // app-driven epoch pinning is not used at M1
    default: break;
  }

  // everything else is a Cmd for a specific tab (matched by epoch) → relay to its Port.
  const target = findTabByEpoch(env.epoch);
  if (!target || !target.port) {
    // no live port for this epoch → the page is gone; the app resumes by re-classification.
    const goneEpoch = env.epoch ?? '';
    sendEvent({ kind: 'page_gone', epoch: goneEpoch, reason: 'close' }, { epoch: goneEpoch });
    return;
  }
  try {
    target.port.postMessage(env);
  } catch {
    handlePortDeath(target, 'crash');
  }
}

function findTabByEpoch(epoch: string | undefined): TabEntry | undefined {
  if (!epoch) return undefined;
  for (const t of tabs.values()) if (t.epoch === epoch) return t;
  return undefined;
}

// ---------------------------------------------------------------------------
// dedicated apply window + tab management (the ONLY logic the SW owns)
// ---------------------------------------------------------------------------
async function getApplyWindowId(): Promise<number | null> {
  try {
    const got = await chrome.storage.session.get(APPLY_WINDOW_KEY);
    const id = got[APPLY_WINDOW_KEY];
    if (typeof id === 'number') {
      // verify it still exists
      try { await chrome.windows.get(id); return id; } catch { /* recreate below */ }
    }
  } catch { /* fall through */ }
  return null;
}

async function ensureApplyWindow(): Promise<number> {
  const existing = await getApplyWindowId();
  if (existing !== null) return existing;
  const win = await chrome.windows.create({ focused: false }); // NEVER focus on our own initiative
  const id = win?.id ?? -1;
  try { await chrome.storage.session.set({ [APPLY_WINDOW_KEY]: id }); } catch { /* noop */ }
  return id;
}

async function openApplyTab(env: Envelope): Promise<void> {
  const body = (env.body ?? {}) as { url?: string; runId?: string; lane?: string };
  const windowId = await ensureApplyWindow();
  const tab = await chrome.tabs.create({ windowId, url: body.url ?? 'about:blank', active: true });
  const tabId = tab.id ?? -1;
  const epoch = mintEpoch();
  const entry: TabEntry = { tabId, epoch, url: body.url ?? '', createdAt: Date.now() };
  if (body.runId) entry.runId = body.runId;
  if (body.lane) entry.lane = body.lane;
  tabs.set(tabId, entry);
}

async function closeTab(env: Envelope): Promise<void> {
  const body = (env.body ?? {}) as { tabId?: number };
  if (typeof body.tabId === 'number') {
    try { await chrome.tabs.remove(body.tabId); } catch { /* already gone */ }
    tabs.delete(body.tabId);
  }
}

/** The ONE place a window is fronted — only on an explicit app command (scheduler's foreground token). */
async function frontWindow(env: Envelope): Promise<void> {
  const windowId = await getApplyWindowId();
  if (windowId !== null) {
    try { await chrome.windows.update(windowId, { focused: true }); } catch { /* noop */ }
  }
}

function mintEpoch(): string {
  // crypto.randomUUID is available in the SW; guard just in case.
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `ep_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// content Port: per-tab chrome.runtime Port named 'jat13.page'. The content
// script connects on load/pageshow; the SW registers it, relays cmd_result and
// events up, and treats a disconnect as page_gone (the resume backbone).
// ---------------------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'jat13.page') return;
  const tabId = port.sender?.tab?.id;
  if (typeof tabId !== 'number') return;

  // (re)bind the port to the tab entry; a real navigation mints a new epoch, a bfcache reconnect keeps
  // the old one — the content script tells us which via its first 'ready' message.
  let entry = tabs.get(tabId);
  if (!entry) {
    entry = { tabId, epoch: mintEpoch(), url: port.sender?.url ?? '', createdAt: Date.now() };
    tabs.set(tabId, entry);
  }
  entry.port = port;

  port.onMessage.addListener((msg: unknown) => {
    void onPortMessage(tabId, msg);
  });
  port.onDisconnect.addListener(() => {
    const e = tabs.get(tabId);
    if (e) handlePortDeath(e, 'nav');
  });
});

/** The content-port frame the SW receives (a loose superset of the wire Envelope). The `body` shape
 *  varies by kind; for `cmd_result` the body IS the CmdResult (content.ts sends the raw result). */
interface PortFrame {
  kind: string;
  seq?: number;
  runId?: string;
  epoch?: string;
  body?: {
    epoch?: string;
    committed?: boolean;
    url?: string;
    snapshot?: PageSnapshot;
    hash?: string;
    reason?: PageGoneReason;
    dialogKind?: DialogKind;
    text?: string;
  } & Record<string, unknown>;
}

async function onPortMessage(tabId: number, msg: unknown): Promise<void> {
  const entry = tabs.get(tabId);
  if (!entry) return;
  const env = msg as PortFrame;

  switch (env.kind) {
    case 'ready': {
      // content announces itself. committed:true = real navigation → mint a fresh epoch; otherwise
      // (bfcache restore) keep the reported epoch so the app resumes rather than re-classifies fresh.
      const reported = env.body?.epoch;
      if (env.body?.committed || !reported) entry.epoch = mintEpoch();
      else entry.epoch = reported;
      sendEvent({ kind: 'hello', tabs: await snapshotTabRegistry() });
      return;
    }
    case 'page_ready': {
      // stamp the tab's LIVE epoch (authoritative) onto the event + its snapshot, then relay up.
      const snapshot = env.body?.snapshot;
      if (!snapshot) return; // no snapshot ⇒ nothing the app can classify; drop.
      const stamped: PageSnapshot = { ...snapshot, epoch: entry.epoch };
      sendEvent(
        { kind: 'page_ready', epoch: entry.epoch, url: env.body?.url ?? entry.url, snapshot: stamped },
        { epoch: entry.epoch },
      );
      return;
    }
    case 'mutated': {
      sendEvent({ kind: 'mutated', epoch: entry.epoch, hash: env.body?.hash ?? '' }, { epoch: entry.epoch });
      return;
    }
    case 'dialog': {
      const dialogKind: DialogKind = env.body?.dialogKind === 'alert' ? 'alert' : 'beforeunload';
      sendEvent(
        { kind: 'dialog', epoch: entry.epoch, dialogKind, text: env.body?.text ?? '' },
        { epoch: entry.epoch },
      );
      return;
    }
    case 'page_gone': {
      const reason: PageGoneReason = normalizeGoneReason(env.body?.reason);
      sendEvent({ kind: 'page_gone', epoch: entry.epoch, reason }, { epoch: entry.epoch });
      return;
    }
    case 'cmd_result': {
      // relay the command result up UNDER the run's stream (keep the seq the app assigned). content.ts
      // sends the raw CmdResult as the port-frame body.
      const result = (env.body as unknown as CmdResult | undefined) ?? { ok: false, error: 'not_found' };
      const seq = env.seq ?? 0;
      const opts: { epoch?: string; runId?: string; seq?: number } = { epoch: entry.epoch, seq };
      if (env.runId) opts.runId = env.runId;
      sendEvent({ kind: 'cmd_result', seq, result }, opts);
      return;
    }
    default:
      return;
  }
}

function handlePortDeath(entry: TabEntry, reason: PageGoneReason): void {
  const dead = entry.port;
  entry.port = undefined;
  if (dead) {
    try { dead.disconnect(); } catch { /* already gone */ }
  }
  sendEvent({ kind: 'page_gone', epoch: entry.epoch, reason }, { epoch: entry.epoch });
}

// ---------------------------------------------------------------------------
// tab bookkeeping: a committed navigation mints a new epoch; a closed tab is
// reaped. Orphan tabs (no live run > 3min) are closed to avoid leaks.
// ---------------------------------------------------------------------------
chrome.webNavigation?.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return; // main frame only
  const entry = tabs.get(details.tabId);
  if (entry) {
    entry.epoch = mintEpoch(); // committed nav → new TabSession
    entry.url = details.url;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = tabs.get(tabId);
  if (entry) {
    sendEvent({ kind: 'page_gone', epoch: entry.epoch, reason: 'close' }, { epoch: entry.epoch });
    tabs.delete(tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  const entry = tabs.get(tabId);
  if (entry && info.url) entry.url = info.url;
});

// ---------------------------------------------------------------------------
// watchdog: chrome.alarms re-opens a dead socket (eviction is normal). Also
// reaps orphan apply tabs.
// ---------------------------------------------------------------------------
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  void ensureSocket();
  reapOrphanTabs();
});

function reapOrphanTabs(): void {
  const now = Date.now();
  for (const entry of tabs.values()) {
    const orphan = !entry.runId && !entry.port && now - entry.createdAt > 3 * 60_000;
    if (orphan) {
      try { void chrome.tabs.remove(entry.tabId); } catch { /* noop */ }
      tabs.delete(entry.tabId);
    }
  }
}

// re-open the socket whenever the token appears/changes (pairing flow writes it).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[TOKEN_KEY]) void ensureSocket();
});

// boot / wake paths — try to connect immediately; the alarm keeps retrying if unpaired/offline.
chrome.runtime.onStartup.addListener(() => void ensureSocket());
chrome.runtime.onInstalled.addListener(() => void ensureSocket());
void ensureSocket();
