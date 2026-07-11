// The content-script ENTRY — a DORMANT-by-default state machine. On load it does the BARE minimum:
// connect the port and say `hello {url}`. Then it waits. The service worker is the sole authority and
// puts the tab into exactly ONE of three states:
//
//   • DRIVE   (activate {runId, epoch})  — the tab is leased to a run. Only NOW do we emit page_ready
//     with a snapshot, install the MutationObserver, and accept Cmd envelopes → actuator.
//   • OBSERVE (observe {sessionId})       — watch-and-learn: attach the passive recorder. No driving,
//     no commands, no navigation — purely watch the human fill their own application.
//   • DORMANT (deactivate)                — tear everything down and go quiet. THE DEFAULT.
//
// This kills the v11-era drain/self-refresh bug class: the old content script snapshotted on EVERY
// page load and rebuilt a full 128KB snapshot every 500ms on ANY mutation, regardless of whether a run
// targeted the tab — a massive drain on heavy sites, and a stray page_ready could be mistaken for a
// resumable run and re-navigate ("refresh") the tab. Here a tab does NOTHING until the SW activates it,
// and the actuator structurally refuses to act on a tab that isn't in DRIVE mode for a matching epoch.
//
// NOTE: `activate`/`observe`/`deactivate` are INTERNAL SW↔content port messages — NOT the app wire
// protocol. The app never sees them.
import type { Cmd, CmdResult, TypedEnvelope } from './protocol.js';
import { PROTOCOL_VERSION } from '@jat13/shared/identity';
import { buildSnapshot, markMutation } from './sensor.js';
import { execute, type ActuatorCtx } from './actuator.js';
import { startRecorder, type RecorderHandle } from './recorder.js';

/** The wire frame, as a TS type (the app's zod `Envelope` is the runtime schema; this is its shape). */
type Wire = TypedEnvelope<unknown>;
type Mode = 'dormant' | 'drive' | 'observe';

const MUTATION_DEBOUNCE_MS = 500;
const RECONNECT_DELAY_MS = 1500;

// ---- state (the SW is authoritative; this only mirrors what it assigned) ----
let mode: Mode = 'dormant';
let epoch = ''; // set by `activate`; commands whose epoch ≠ this are refused (stale-epoch guard).
let runId: string | undefined;
let sessionId: string | undefined;
let seqUp = 0;

let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

let mo: MutationObserver | null = null;
let mutTimer: ReturnType<typeof setTimeout> | null = null;
let lastHash = '';

let recorder: RecorderHandle | null = null;

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------
function up(kind: string, body: unknown, r?: string, seq?: number): void {
  if (!port) return;
  const env: Wire = { v: PROTOCOL_VERSION, kind, seq: seq ?? ++seqUp, body };
  if (r) env.runId = r;
  if (epoch) env.epoch = epoch;
  try {
    port.postMessage(env);
  } catch {
    /* port dead → onDisconnect will fire and drive us dormant */
  }
}

function hello(): void {
  up('hello', { url: location.href });
}

function connect(): void {
  try {
    port = chrome.runtime.connect({ name: 'jat13.page' });
  } catch {
    port = null;
    scheduleReconnect(true);
    return;
  }
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(onPortDisconnect);
  hello();
}

function onPortDisconnect(): void {
  port = null;
  const wasActive = mode !== 'dormant'; // only a drive/observe tab is worth re-establishing
  toDormant();
  scheduleReconnect(wasActive);
}

function scheduleReconnect(should: boolean): void {
  // Idle browsing tabs that were already dormant stay quiet on SW eviction (no reconnect storm); a
  // fresh navigation re-injects the script anyway. Only drive/observe tabs reconnect to resume.
  if (!should || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!port) connect();
  }, RECONNECT_DELAY_MS);
}

// ---------------------------------------------------------------------------
// the state machine — the SW sends exactly one of these
// ---------------------------------------------------------------------------
function onPortMessage(raw: unknown): void {
  const env = raw as Wire;
  switch (env.kind) {
    case 'activate':
      return activate(env.body as { runId?: string; epoch?: string });
    case 'observe':
      return observe(env.body as { sessionId?: string });
    case 'deactivate':
      return toDormant();
    case 'cmd':
      return onCommand(env);
    default:
      return;
  }
}

/** DRIVE: the tab is leased to a run. Emit the first snapshot and start driving. */
function activate(body: { runId?: string; epoch?: string }): void {
  stopObserve();
  mode = 'drive';
  runId = body.runId;
  if (body.epoch) epoch = body.epoch;
  sessionId = undefined;
  emitReady();
  startMutationObserver();
}

/** OBSERVE: attach the passive recorder. No driving, no commands, no navigation. */
function observe(body: { sessionId?: string }): void {
  stopDrive();
  mode = 'observe';
  runId = undefined;
  sessionId = body.sessionId;
  if (!recorder) {
    recorder = startRecorder(document, {
      onBatch: (events) => {
        if (mode !== 'observe' || !sessionId) return;
        up('observed', { sessionId, url: location.href, host: location.host, events });
      },
    });
  }
}

/** DORMANT: tear everything down and go quiet. The default state. */
function toDormant(): void {
  stopDrive();
  stopObserve();
  mode = 'dormant';
  runId = undefined;
  sessionId = undefined;
}

// ---------------------------------------------------------------------------
// DRIVE internals — snapshot + a CHEAP change-detecting MutationObserver
// ---------------------------------------------------------------------------
function emitReady(): void {
  const snap = buildSnapshot(document, epoch || 'ep_pending');
  epoch = snap.epoch;
  lastHash = snap.hash;
  up('page_ready', { epoch, url: location.href, snapshot: snap }, runId);
}

/**
 * A CHEAP form-shape digest — control count + tag/type/name/label/checked, bounded to 200 controls.
 * The old code rebuilt a full 128KB snapshot on every mutation tick; this computes a rolling hash with
 * NO getComputedStyle / getBoundingClientRect, so the observer is nearly free. A full snapshot is only
 * built on `activate` and after a mutating command (the actuator attaches it as snapshotDelta).
 */
function cheapFormHash(): string {
  const ctrls = document.querySelectorAll(
    'input, textarea, select, button, [role="button"], [role="radio"], [role="checkbox"], [role="combobox"]',
  );
  let h = 0x811c9dc5;
  const push = (s: string): void => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  };
  push(String(ctrls.length));
  let i = 0;
  for (const el of Array.from(ctrls)) {
    if (i++ >= 200) break;
    push('|');
    push(el.tagName);
    push(el.getAttribute('type') || '');
    push(el.getAttribute('name') || el.getAttribute('id') || '');
    push(el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.tagName === 'BUTTON' ? (el.textContent || '').slice(0, 32) : ''));
    if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) push(el.checked ? '1' : '0');
  }
  return `h_${(h >>> 0).toString(16)}`;
}

function startMutationObserver(): void {
  if (mo) return;
  lastHash = lastHash || cheapFormHash();
  mo = new MutationObserver(() => {
    markMutation(); // keeps the sensor's quiet tracker fresh for waitFor 'quiet'
    if (mutTimer) return;
    mutTimer = setTimeout(() => {
      mutTimer = null;
      const h = cheapFormHash();
      if (h !== lastHash) {
        lastHash = h;
        up('mutated', { epoch, hash: h }, runId); // only when the form shape actually changed
      }
    }, MUTATION_DEBOUNCE_MS);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
}

function stopDrive(): void {
  if (mo) {
    try { mo.disconnect(); } catch { /* noop */ }
    mo = null;
  }
  if (mutTimer) { clearTimeout(mutTimer); mutTimer = null; }
  lastHash = '';
}

function stopObserve(): void {
  if (recorder) {
    try { recorder.stop(); } catch { /* noop */ }
    recorder = null;
  }
}

// ---------------------------------------------------------------------------
// command execution — ONLY in DRIVE mode for a matching epoch
// ---------------------------------------------------------------------------
function onCommand(env: Wire): void {
  const cmd = env.body as Cmd;
  // STRUCTURAL GUARD: a tab with no lease (or a stale epoch) can never act — this is the anti-refresh
  // invariant. Anything else replies not_active without touching the DOM.
  if (mode !== 'drive' || (env.epoch && env.epoch !== epoch)) {
    replyResult(env, { ok: false, error: 'not_active' });
    return;
  }
  const ctx: ActuatorCtx = { doc: document, epoch, mode };
  void execute(cmd, ctx)
    .then((result) => replyResult(env, result))
    .catch((err: unknown) => replyResult(env, { ok: false, error: err instanceof Error ? err.message : String(err) }));
}

function replyResult(env: Wire, result: CmdResult): void {
  up('cmd_result', result, env.runId, env.seq);
}

// ---------------------------------------------------------------------------
// lifecycle: bfcache restore reconnects but NEVER auto-snapshots — it just says
// hello and adopts whatever state the SW re-assigns.
// ---------------------------------------------------------------------------
window.addEventListener('pageshow', (e: PageTransitionEvent) => {
  if (!e.persisted) return;
  if (!port) connect();
  else hello();
});

window.addEventListener('pagehide', () => {
  // flush any pending learn batch before the page is cached/destroyed.
  if (mode === 'observe') recorder?.flush();
});

window.addEventListener('beforeunload', () => {
  if (mode === 'drive') up('dialog', { epoch, dialogKind: 'beforeunload', text: '' }, runId);
  else if (mode === 'observe') recorder?.flush();
});

// boot: connect + hello, then WAIT. No snapshot, no observer, no recorder until the SW decides.
connect();
