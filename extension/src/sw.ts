// The background SERVICE WORKER — Stage 0: connection truth ONLY. It pairs with the desktop brain
// and tells the truth about that link on the toolbar badge. Nothing else lives here yet.
//
//   • opens ONE WebSocket to the app gateway (ws://127.0.0.1:<port><IDENTITY.wsPath>?token=…),
//     authenticated by the paired token from chrome.storage.local; idle (no retry storm) if unpaired.
//   • PORT-AWARE: the port comes from storage (the popup stores what it discovered — prod 7860 /
//     dev 7861). The 13.0.1 scar: a hardcoded 7860 here while the popup paired on 7861 meant the SW
//     dialed an app the user never paired with. Identity flows from @jat13/shared + pairing storage.
//   • ONE named alarm (30s) is the ONLY retry mechanism. chrome.alarms dedups by name across SW
//     wakes, so timers never stack (the freeze-over-time class). A refused connect — the /drive
//     endpoint may not even exist server-side at Stage 0 — is a NORMAL quiet state: error/close
//     handlers null the socket and set the badge; the next attempt is the next alarm tick. No
//     setTimeout reconnect chains, ever.
//   • badge = the ONE glanceable truth: green dot connected · red "!" disconnected (paired but the
//     brain is unreachable) · grey dot unpaired (no token yet — open the popup to pair).
//   • messages: sends `hello` on open; answers `ping` with `pong`. EVERYTHING else falls into the
//     typed Stage-2 seam below (drive protocol: cmd relay, tab registry, epochs, apply window).
//
// It holds ZERO adapter/apply logic — and at Stage 0, zero tab logic too. Eviction is normal: all
// module state here is rebuilt from storage + the alarm; the app owns real state.
import { PORTS, IDENTITY, PROTOCOL_VERSION } from '@jat13/shared';

/** The wire frame. Kept structural at Stage 0 (the shared zod `Envelope` becomes the runtime
 *  validator when the drive protocol lands in Stage 2). */
interface Envelope {
  v: number;
  kind: string;
  seq: number;
  epoch?: string;
  runId?: string;
  body?: unknown;
}

// ---- module-scope transport state (rebuilt freely on SW eviction; app owns real state) -----------
const RECONNECT_ALARM = 'jat13.reconnect';
const TOKEN_KEY = 'jat13Token'; // chrome.storage.local — MUST match popup.js
const PORT_KEY = 'jat13Port'; //  the popup stores the port it discovered so the SW dials the SAME app

let appPort: number = PORTS.app; // refreshed from storage before each connect; defaults to prod
let socket: WebSocket | null = null;
let controlSeq = 0; // sender-monotonic for control-plane envelopes (no runId)

// ---------------------------------------------------------------------------
// badge — the connection-truth surface. Colors are deliberately loud primitives
// (not the atelier palette): a badge is a 16px signal, not a design surface.
// ---------------------------------------------------------------------------
type ConnState = 'connected' | 'disconnected' | 'unpaired';

const BADGE: Record<ConnState, { text: string; color: string; title: string }> = {
  connected: { text: '●', color: '#22c55e', title: `${IDENTITY.productName} — connected` },
  disconnected: { text: '!', color: '#ef4444', title: `${IDENTITY.productName} — app unreachable (is it running?)` },
  unpaired: { text: '●', color: '#9aa0a6', title: `${IDENTITY.productName} — not paired (open the popup)` },
};

function setConnState(state: ConnState): void {
  const b = BADGE[state];
  try {
    chrome.action.setBadgeBackgroundColor({ color: b.color });
    chrome.action.setBadgeText({ text: b.text });
    chrome.action.setTitle({ title: state === 'connected' ? `${b.title} (port ${appPort})` : b.title });
  } catch {
    /* action API unavailable (should never happen in MV3) */
  }
}

/** Socket is down — badge red if paired, grey if there's no token at all. */
async function reflectDown(): Promise<void> {
  const token = await readToken();
  setConnState(token ? 'disconnected' : 'unpaired');
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
  } catch {
    /* keep current */
  }
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
    setConnState('unpaired'); // idle — the pairing flow (popup) writes the token later
    return;
  }
  await readPort(); // connect to the SAME app the popup paired with (prod 7860 / dev 7861)

  const url = `ws://127.0.0.1:${appPort}${IDENTITY.wsPath}?token=${encodeURIComponent(token)}`;
  try {
    socket = new WebSocket(url);
  } catch {
    // constructor threw (malformed url class) — quiet red; the alarm retries.
    socket = null;
    setConnState('disconnected');
    return;
  }

  socket.addEventListener('open', () => {
    setConnState('connected');
    sendHello();
  });
  socket.addEventListener('message', (ev: MessageEvent) => {
    onSocketMessage(ev.data);
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

/** hello — announces this extension to the gateway on every (re)connect. `tabs` is the proven wire
 *  shape (the app reconciles its registry from it); at Stage 0 there is no tab registry, so it's
 *  honestly empty. The body IS the complete event (the outer envelope only repeats kind for routing). */
function sendHello(): void {
  sendUp({
    v: PROTOCOL_VERSION,
    kind: 'hello',
    seq: ++controlSeq,
    body: { kind: 'hello', tabs: [] },
  });
}

// ---------------------------------------------------------------------------
// inbound — Stage 0 speaks keepalive only
// ---------------------------------------------------------------------------

/** Everything the SW will route in Stage 2 — typed now so the seam is visible and greppable. */
type DriveKind = 'cmd' | 'openTab' | 'closeTab' | 'frontWindow' | 'setEpoch';

/**
 * TODO(stage-2): the drive protocol lands here — tab registry + epoch minting (webNavigation
 * onCommitted), the dedicated unfocused apply window, per-tab content Ports with
 * DRIVE/OBSERVE/DORMANT assignment, cmd relay down / cmd_result + page events up, page_gone on
 * port death. Until then every drive-shaped frame is acknowledged by silence — the app's runner
 * treats an unresponsive extension as resume-by-reclassification, never as a crash.
 */
function onDriveEnvelope(env: Envelope & { kind: DriveKind }): void {
  void env; // deliberately inert at Stage 0
}

function onSocketMessage(raw: unknown): void {
  let env: Envelope;
  try {
    env = JSON.parse(String(raw)) as Envelope;
  } catch {
    return; // not our frame — drop, never throw (a throwing SW handler kills the socket)
  }

  switch (env.kind) {
    case 'ping': {
      // keepalive: echo the server's seq back so it can correlate the round-trip.
      sendUp({ v: PROTOCOL_VERSION, kind: 'pong', seq: env.seq, body: { kind: 'pong' } });
      return;
    }
    case 'pong':
      return; // ack of our own keepalive — nothing to do
    case 'cmd':
    case 'openTab':
    case 'closeTab':
    case 'frontWindow':
    case 'setEpoch':
      return onDriveEnvelope(env as Envelope & { kind: DriveKind });
    default:
      return; // unknown kind: forward-compatible silence (protocol grows app-first)
  }
}

// ---------------------------------------------------------------------------
// watchdog + boot paths
// ---------------------------------------------------------------------------
// ONE alarm drives every periodic job. Idempotent: chrome.alarms dedups by name across SW wakes,
// so this never stacks duplicate timers. 0.5min = the floor Chrome allows for packed extensions.
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  void ensureSocket();
});

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
