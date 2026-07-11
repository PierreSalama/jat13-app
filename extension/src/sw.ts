// The background SERVICE WORKER — the ONLY stateful-ish part of the thin extension, and even here the
// state is just transport plumbing (a socket, a tab registry, per-tab ports), never run state. It:
//   • opens ONE WebSocket to the app gateway (ws://127.0.0.1:<port><IDENTITY.wsPath>?token=…),
//     authenticated by the paired token from chrome.storage.local; idle (no retry storm) if unpaired.
//   • PORT-AWARE: the port comes from storage (the popup stores what it discovered — prod 7860 /
//     dev 7861). The 13.0.1 scar was a hardcoded 7860 here; identity flows from @jat13/shared +
//     pairing storage, never a literal.
//   • mints an epoch = crypto.randomUUID() per (tab × committed navigation).
//   • keeps ONE dedicated apply window (chrome.windows.create({focused:false})); NEVER fronts a window
//     except on an explicit app `frontWindow` command. Tabs are NEVER slots.
//   • relays Cmd envelopes DOWN to the content Port and cmd_result/events UP to the socket.
//   • sends hello{tabs} on (re)connect; a dead Port emits page_gone; a chrome.alarms watchdog
//     ('jat13.reconnect', 0.5min) re-opens a dead socket. Eviction is NORMAL — resume-by-classify (app).
//   • badge = the glanceable truth: grey ● unpaired · red ! app-unreachable · green ● connected ·
//     amber N when the brain has N items that need the human (from /api/summary).
//
// It holds ZERO adapter/apply logic. Every "decision" here is a transport/tab-lifecycle fact. All
// module state is rebuilt freely on SW eviction from storage + the alarm; the app owns real state.
import { PORTS, IDENTITY, PROTOCOL_VERSION, STORAGE_KEYS } from '@jat13/shared/identity';
import type { TypedEnvelope, ExtEvent, PageSnapshot, CmdResult } from './protocol.js';

/** The wire frame, as a TS type (the app's zod `Envelope` is the runtime schema; this is its shape). */
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
const TOKEN_KEY = STORAGE_KEYS.token; // chrome.storage.local — the popup writes it at pair time
const PORT_KEY = STORAGE_KEYS.port; //  the popup stores the port it discovered (prod 7860 / dev 7861)
//                                      so the SW's WS + HTTP hit the SAME app — no hardcoded port.
let appPort: number = PORTS.app; // refreshed from storage before each connect; defaults to the prod port

let socket: WebSocket | null = null;
let controlSeq = 0; // sender-monotonic for control-plane envelopes (no runId)

type TabMode = 'dormant' | 'drive' | 'observe';

interface TabEntry {
  tabId: number;
  epoch: string;
  url: string;
  runId?: string;
  lane?: string;
  mode?: TabMode;
  sessionId?: string;
  port?: chrome.runtime.Port | undefined;
  createdAt: number;
}
const tabs = new Map<number, TabEntry>();

// ---- watch-and-learn config (pushed from the app; cached across SW wakes) -------------------------
/** An apply-surface matcher: host is a SUFFIX match; path (optional) is a substring of the URL. */
interface ApplyHostPattern { host: string; path?: string }

/** Default apply-surface patterns — the app's /api/learn/config overrides these on connect. Kept in
 *  intent-sync with the content_scripts host matches in manifest.json + the app's learn config. */
const DEFAULT_APPLY_HOSTS: ApplyHostPattern[] = [
  { host: 'linkedin.com', path: '/apply' },
  { host: 'smartapply.indeed.com' },
  { host: 'indeed.com', path: 'apply' },
  { host: 'greenhouse.io' },
  { host: 'lever.co' },
  { host: 'ashbyhq.com' },
];

let learnEnabled = true; // ON by default (Pierre); the app's config can turn it off.
let applyHostPatterns: ApplyHostPattern[] = DEFAULT_APPLY_HOSTS;

// badge palette — deliberately loud primitives (a 16px signal, not a design surface).
const BADGE_GREEN = '#22c55e';
const BADGE_AMBER = '#f59e0b';
const BADGE_RED = '#ef4444';
const BADGE_GREY = '#9aa0a6';
let alarmTicks = 0; // config is refreshed every Nth alarm (a few minutes), not every 30s.

function mintSessionId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `ls_${crypto.randomUUID()}`
    : `ls_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Does this URL look like a job-application surface we should passively learn from? */
function isApplySurface(url: string): boolean {
  let host = '';
  let full = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    full = u.pathname + u.search;
  } catch {
    return false;
  }
  for (const p of applyHostPatterns) {
    const hostMatch = host === p.host || host.endsWith(`.${p.host}`);
    if (!hostMatch) continue;
    if (p.path === undefined) return true;
    if (full.toLowerCase().includes(p.path.toLowerCase())) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// pairing storage
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

/** Refresh `appPort` from the port the popup discovered (falls back to the prod port). */
async function readPort(): Promise<void> {
  try {
    const got = await chrome.storage.local.get(PORT_KEY);
    const p = got[PORT_KEY];
    if (typeof p === 'number' && p > 0) appPort = p;
  } catch { /* keep current */ }
}

// ---------------------------------------------------------------------------
// socket lifecycle — ONE socket, alarm-paced retries, refusal is quiet
// ---------------------------------------------------------------------------
function socketAlive(): boolean {
  return !!socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
}

async function ensureSocket(): Promise<void> {
  if (socketAlive()) return;
  const token = await readToken();
  if (!token) {
    void reflectDown(); // unpaired → grey; the popup/pairing flow sets the token later.
    return;
  }
  await readPort(); // connect to the SAME app the popup paired with (prod 7860 / dev 7861)

  const url = `ws://127.0.0.1:${appPort}${IDENTITY.wsPath}?token=${encodeURIComponent(token)}`;
  try {
    socket = new WebSocket(url);
  } catch {
    socket = null;
    void reflectDown();
    return;
  }

  socket.addEventListener('open', () => {
    paintBadge('●', BADGE_GREEN, `${IDENTITY.productName} — connected (port ${appPort})`);
    void sendHello();
    void fetchLearnConfig(); // sync the learn master-switch + apply-host patterns on connect
    void refreshBadge(); // reflect the app's Needs-You count immediately
  });
  socket.addEventListener('message', (ev: MessageEvent) => {
    void onSocketMessage(ev.data);
  });
  // A refused/dropped connection fires error then close (or just close). Both null the socket and
  // reflect the truth; NEITHER schedules a retry — that is the alarm's job alone (no tight loop).
  socket.addEventListener('close', () => {
    socket = null;
    void reflectDown();
  });
  socket.addEventListener('error', () => {
    try { socket?.close(); } catch { /* noop */ }
    socket = null;
    void reflectDown();
  });
}

function sendUp(env: Envelope): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(env));
  }
}

/**
 * Emit an ExtEvent upward. The wire contract (shared/src/protocol + ws-gateway.parseFrame) is an
 * Envelope whose BODY is the complete ExtEvent (the app validates `env.body` against its ExtEvent
 * schema — the event carries its own discriminating `kind`). The outer envelope repeats kind/epoch/
 * runId only for routing; the source of truth is `body`.
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

/** hello{tabs}: the live registry the app reconciles against (resume leased tabs by epoch). */
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
// loopback HTTP to the app (learning + cohesion). Reuses the SAME port + paired
// token as the WebSocket. All best-effort: a failed fetch NEVER breaks anything.
// Every /api response is the canonical envelope { ok, data } — appGetData unwraps
// it; a bare/legacy body is treated as no-data (never guessed at).
// ---------------------------------------------------------------------------
async function appFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const token = await readToken();
  if (!token) return null;
  await readPort();
  const headers = new Headers(init?.headers);
  headers.set(IDENTITY.authHeader, token);
  try {
    return await fetch(`http://127.0.0.1:${appPort}${path}`, { ...init, headers });
  } catch {
    return null;
  }
}

/** GET an enveloped endpoint and return its unwrapped `data`, or null on any failure. */
async function appGetData<T>(path: string): Promise<T | null> {
  const res = await appFetch(path);
  if (!res || !res.ok) return null;
  try {
    const j = (await res.json()) as { ok?: boolean; data?: unknown };
    return j && j.ok === true ? (j.data as T) : null;
  } catch {
    return null;
  }
}

/** Pull the learn master-switch + apply-host patterns from the app; keep the cache on any failure. */
async function fetchLearnConfig(): Promise<void> {
  const cfg = await appGetData<{ enabled?: boolean; applyHosts?: ApplyHostPattern[] }>('/api/learn/config');
  if (!cfg) return; // endpoint absent/unreachable → keep defaults (enabled, DEFAULT_APPLY_HOSTS)
  if (typeof cfg.enabled === 'boolean') learnEnabled = cfg.enabled;
  if (Array.isArray(cfg.applyHosts) && cfg.applyHosts.length) {
    applyHostPatterns = cfg.applyHosts.filter((p) => p && typeof p.host === 'string');
  }
}

/** POST a passively-observed (redacted) batch to the app's distiller. Best-effort with ONE retry. */
async function forwardObserved(body: unknown): Promise<void> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await appFetch('/api/learn/observe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    if (res && res.ok) return;
  }
}

// ---------------------------------------------------------------------------
// badge — connection truth, plus the app's Needs-You count when connected.
// ---------------------------------------------------------------------------
function paintBadge(text: string, color: string, title: string): void {
  try {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
    chrome.action.setTitle({ title });
  } catch {
    /* action API unavailable (should never happen in MV3) */
  }
}

/** Socket is down — red '!' if paired, grey '●' if there's no token at all. */
async function reflectDown(): Promise<void> {
  const token = await readToken();
  if (token) paintBadge('!', BADGE_RED, `${IDENTITY.productName} — app unreachable (is it running?)`);
  else paintBadge('●', BADGE_GREY, `${IDENTITY.productName} — not paired (open the popup)`);
}

/** COHESION: mirror the app's Needs-You count onto the badge (amber) while connected; green ● at zero.
 *  A missing/unreachable summary is NOT an error state — we stay green (the socket is up). */
async function refreshBadge(): Promise<void> {
  if (!socketAlive()) return; // the socket handlers own the down/unpaired states
  const data = await appGetData<{ needsYou?: number }>('/api/summary');
  const n = data ? (Number(data.needsYou) || 0) : 0;
  if (n > 0) paintBadge(n > 99 ? '99+' : String(n), BADGE_AMBER, `${IDENTITY.productName} — ${n} need you`);
  else paintBadge('●', BADGE_GREEN, `${IDENTITY.productName} — connected (port ${appPort})`);
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
    return; // not our frame — drop, never throw (a throwing handler kills the socket)
  }

  // keepalive + SW-owned tab-lifecycle commands (never the content script's job).
  switch (env.kind) {
    case 'ping': return sendUp({ v: PROTOCOL_VERSION, kind: 'pong', seq: env.seq, body: { kind: 'pong' } });
    case 'pong': return; // ack of our own keepalive
    case 'openTab': return void openApplyTab(env);
    case 'closeTab': return void closeTab(env);
    case 'frontWindow': return void frontWindow(env);
    case 'setEpoch': return; // app-driven epoch pinning is not used at this stage
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
async function frontWindow(_env: Envelope): Promise<void> {
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
// state authority: the SW decides — and is the ONLY thing that decides — which of
// the three lifecycle states a tab is in. A tab NEVER observes AND drives at once.
//   • has a runId (leased by the app)                       → DRIVE
//   • no run, learn ON, URL is an apply surface             → OBSERVE
//   • otherwise                                             → DORMANT
// An INTERNAL SW↔content port message (never the app wire protocol).
// ---------------------------------------------------------------------------
function sendControl(entry: TabEntry, kind: 'activate' | 'observe' | 'deactivate', body: Record<string, unknown>): void {
  if (!entry.port) return;
  try {
    entry.port.postMessage({ v: PROTOCOL_VERSION, kind, seq: 0, body });
  } catch {
    handlePortDeath(entry, 'crash');
  }
}

/** Assign (or re-assign) a tab's lifecycle state and tell its content port. Idempotent per hello. */
function assignMode(entry: TabEntry): void {
  if (entry.runId) {
    entry.mode = 'drive';
    delete entry.sessionId;
    sendControl(entry, 'activate', { runId: entry.runId, epoch: entry.epoch });
    return;
  }
  if (learnEnabled && isApplySurface(entry.url)) {
    const sid = mintSessionId();
    entry.mode = 'observe';
    entry.sessionId = sid;
    sendControl(entry, 'observe', { sessionId: sid });
    return;
  }
  entry.mode = 'dormant';
  delete entry.sessionId;
  sendControl(entry, 'deactivate', {});
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

  // (re)bind the port to the tab entry. Epoch is owned by the SW: onConnect mints one for a fresh tab;
  // webNavigation.onCommitted re-mints on a real navigation; a bfcache reconnect keeps the existing
  // entry (and its epoch). The content script's first `hello` then triggers the state assignment.
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
    sessionId?: string;
    host?: string;
    events?: unknown[];
  } & Record<string, unknown>;
}

async function onPortMessage(tabId: number, msg: unknown): Promise<void> {
  const entry = tabs.get(tabId);
  if (!entry) return;
  const env = msg as PortFrame;

  switch (env.kind) {
    case 'hello': {
      // content announces itself on load / bfcache restore. The SW owns the epoch (minted by onConnect
      // for a fresh tab, re-minted by webNavigation.onCommitted on a real nav), so hello just refreshes
      // the URL and (re)assigns the tab's lifecycle state — DRIVE / OBSERVE / DORMANT.
      if (typeof env.body?.url === 'string') entry.url = env.body.url;
      assignMode(entry);
      // keep the app's tab registry current (the app resumes leased tabs by epoch).
      sendEvent({ kind: 'hello', tabs: await snapshotTabRegistry() });
      return;
    }
    case 'observed': {
      // watch-and-learn uplink: forward the redacted batch to the app's distiller over loopback HTTP.
      if (entry.mode !== 'observe') return; // ignore stray batches from a non-observe tab
      const payload = {
        sessionId: env.body?.sessionId ?? entry.sessionId ?? '',
        url: env.body?.url ?? entry.url,
        host: env.body?.host ?? '',
        events: Array.isArray(env.body?.events) ? env.body?.events : [],
      };
      void forwardObserved(payload);
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
// reaps orphan apply tabs + keeps the badge in step with the app.
// ---------------------------------------------------------------------------
// ONE alarm drives every periodic job (reconnect + badge + config). Idempotent: chrome.alarms dedups
// by name across SW wakes, so this never stacks duplicate timers (the freeze-over-time class).
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  void ensureSocket();
  reapOrphanTabs();
  // Cohesion: keep the toolbar badge in step with the app's Needs-You count (~every 30s).
  if (socketAlive()) void refreshBadge();
  // Refresh the learn config every ~3 minutes (every 6th 30s tick), not on every tick.
  alarmTicks = (alarmTicks + 1) % 6;
  if (alarmTicks === 0 && socketAlive()) void fetchLearnConfig();
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

// re-dial whenever pairing changes (popup writes token+port). A port change must DROP the current
// socket — otherwise we'd stay connected to the app the user just paired AWAY from (prod↔dev).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes[TOKEN_KEY] && !changes[PORT_KEY]) return;
  if (socket) {
    try { socket.close(); } catch { /* noop */ }
    socket = null;
  }
  void ensureSocket();
});

// boot / wake paths — try to connect immediately; the alarm keeps retrying if unpaired/offline.
chrome.runtime.onStartup.addListener(() => void ensureSocket());
chrome.runtime.onInstalled.addListener(() => void ensureSocket());
void ensureSocket();
