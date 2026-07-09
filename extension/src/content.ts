// The content-script ENTRY — the thin bridge that wires the sensor + actuator to the SW Port. It owns
// NO logic: it forwards Cmd envelopes to the actuator, relays cmd_result/events back, and reports
// page_ready / mutated / page_gone lifecycle. Bundled (with sensor.ts + actuator.ts) into content.js.
import type { Cmd, CmdResult, TypedEnvelope } from '@jat13/shared/protocol';
import { PROTOCOL_VERSION } from '@jat13/shared/constants';
import { buildSnapshot, markMutation } from './sensor.js';
import { execute, type ActuatorCtx } from './actuator.js';

/** The wire frame, as a TS type (the shared `Envelope` is the runtime zod schema; this is its shape). */
type Wire = TypedEnvelope<unknown>;

let epoch = ''; // the SW mints the authoritative epoch; we echo whatever it stamps back on relayed cmds.
let seqUp = 0;

const port = chrome.runtime.connect({ name: 'jat13.page' });

function up(kind: string, body: unknown, runId?: string, seq?: number): void {
  const env: Wire = { v: PROTOCOL_VERSION, kind, seq: seq ?? ++seqUp, body };
  if (runId) env.runId = runId;
  if (epoch) env.epoch = epoch;
  try { port.postMessage(env); } catch { /* port dead → SW sees onDisconnect */ }
}

// announce ourselves. committed:true on a fresh load (a bfcache restore fires 'pageshow' with persisted).
up('ready', { epoch, committed: true });

// first quiet snapshot → page_ready
function emitReady(): void {
  const snap = buildSnapshot(document, epoch || 'ep_pending');
  epoch = snap.epoch;
  up('page_ready', { epoch: snap.epoch, url: location.href, snapshot: snap });
}
if (document.readyState === 'complete') emitReady();
else window.addEventListener('load', emitReady, { once: true });

// bfcache restore → reconnect keeps the OLD epoch (app resumes).
window.addEventListener('pageshow', (e: PageTransitionEvent) => {
  if (e.persisted) up('ready', { epoch, committed: false });
});

// mutation → debounced 'mutated' (the app decides whether to re-snapshot).
let mutTimer: ReturnType<typeof setTimeout> | null = null;
const mo = new MutationObserver(() => {
  markMutation();
  if (mutTimer) return;
  mutTimer = setTimeout(() => {
    mutTimer = null;
    const snap = buildSnapshot(document, epoch || 'ep_pending');
    up('mutated', { epoch: snap.epoch, hash: snap.hash });
  }, 500);
});
mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

// beforeunload / alert dialogs surface upward (the app never auto-dismisses).
window.addEventListener('beforeunload', () => {
  up('dialog', { epoch, dialogKind: 'beforeunload', text: '' });
});

// incoming Cmd envelopes from the SW → run the actuator, reply cmd_result with the SAME seq.
port.onMessage.addListener((raw: unknown) => {
  const env = raw as Wire;
  if (env.epoch) epoch = env.epoch; // adopt the SW's authoritative epoch
  const cmd = env.body as Cmd;
  const ctx: ActuatorCtx = { doc: document, epoch };
  void execute(cmd, ctx).then((result: CmdResult) => {
    up('cmd_result', result, env.runId, env.seq);
  }).catch((err: unknown) => {
    const result: CmdResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
    up('cmd_result', result, env.runId, env.seq);
  });
});
