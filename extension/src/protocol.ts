// The ext<->app WIRE CONTRACT, as the extension sees it (Pillar 3 §3). This is the SINGLE place the
// thin extension's view of the drive protocol lives — the sensor's PageSnapshot, the actuator's
// Cmd/CmdResult, the SW's ExtEvent/TypedEnvelope, and the payload CAPS. Every message on the socket
// is one of these shapes; a change here is a PROTOCOL_VERSION bump (constants live in @jat13/shared).
//
// WHY THIS FILE EXISTS (integrator: read this):
//   The proven tree (git cb25d19) kept these as ZOD schemas in `shared/src/protocol/*` +
//   `shared/src/constants.ts`, imported TYPE-ONLY by the extension (so zod never bundled into the
//   extension — it ships zero runtime deps) and as runtime schemas by the app's ws-gateway. The new
//   `@jat13/shared` package (Stage 0/1) only exports `./identity` + `./envelope` — the protocol
//   contract was not carried over yet. Rather than block on shared, the extension keeps its own
//   standalone TYPE mirror here so it builds independently. These shapes are derived VERBATIM from the
//   proven contract; agent A's ws-gateway (ported from the same commit) parses the identical frames.
//
//   ► RECOMMENDED next step (postmortem RESPEC "shared contracts — finish the loop"): promote the zod
//     wire contract into `shared/src/protocol/*` and CAPS/SOURCES/LANES into `shared/src/constants.ts`.
//     Then the app's ws-gateway imports the runtime schemas, the extension switches these to
//     `import type { … } from '@jat13/shared/protocol'` (still type-only → still zod-free), and this
//     file is deleted. ONE contract, both sides — the drift the rebuild is meant to kill.
//
// Types are hand-written here (no zod) precisely so this module carries no runtime dependency into the
// content/sw bundles. Validation is the APP's job (ws-gateway zod-parses every inbound frame); the
// extension is defensive by construction (JSON.parse + switch, drop-on-malformed, never throw).
export { PROTOCOL_VERSION } from '@jat13/shared/identity';

// ---------------------------------------------------------------------------
// PageSnapshot — the SENSOR format (§3.3). An accessibility-tree-ish, size-bounded view of the live
// page; the ONLY thing the extension reports about page content. The app classifies against it.
// ---------------------------------------------------------------------------

/** Roles the sensor emits (a curated interaction-oriented subset of ARIA). */
export const SNAP_ROLES = [
  'button', 'link', 'textbox', 'textarea', 'radio', 'checkbox', 'combobox', 'select',
  'option', 'file', 'heading', 'text', 'group', 'radiogroup', 'progressbar',
  'alert', 'dialog', 'img', 'iframe',
] as const;
export type SnapRole = (typeof SNAP_ROLES)[number];

export interface SnapNodeStates {
  disabled?: true;
  checked?: true;
  required?: true;
  focused?: true;
  /** 0×0/opacity:0 input WITH a visible label affordance (v11.56 hidden-radio grounding). */
  hiddenInput?: true;
  /** name matched a leading loading token before app-side stripping (v11.86). */
  loadingLabel?: true;
  expanded?: boolean;
}

export interface SnapNodeAttrs {
  id?: string;
  nameAttr?: string;
  type?: string;
  placeholder?: string;
  autocomplete?: string;
  testid?: string;
  href?: string;
  accept?: string;
}

export interface SnapNode {
  /** stable per epoch (WeakMap<Element,int>); THE command target. */
  nid: number;
  role: SnapRole;
  /** accessible name (label/aria/placeholder/nearby-text ladder), ≤200 chars. */
  name: string;
  /** CURRENT value — REDACTED for password/sensitive-named fields (sensor never sends secrets up). */
  value?: string;
  states?: SnapNodeStates;
  /** affordance rect [x,y,w,h] (label rect for hiddenInput). */
  rect: [number, number, number, number];
  /** shared id for radio/checkbox groups. */
  group?: number;
  /** resolved question text for the group ('' when unresolvable — never a dirty label). */
  groupPrompt?: string;
  attrs?: SnapNodeAttrs;
  /** resilient locator (tag + stable-attr chain) — REBIND fallback only, never adapter-evaluated. */
  path: string;
  headingLevel?: number;
}

export interface FrameSnap {
  framePath: string; // '' main, '0', '0.2', …
  frameHost: string; // cross-origin iframe: host only, nodes empty
  nodes: SnapNode[];
}

export interface PageSnapshot {
  v: 1;
  epoch: string;
  url: string;
  title: string;
  readyState: 'loading' | 'interactive' | 'complete';
  /** ms since the last DOM mutation burst (hydration/quiescence signal). */
  quietMs: number;
  /** main frame first; same-process iframes flattened with framePath. */
  frames: FrameSnap[];
  /** size cap (128KB / 400 nodes) hit — app may request a scoped snapshot. */
  truncated: boolean;
  /** deterministic digest of the normalized node list (change detection). */
  hash: string;
}

// ---------------------------------------------------------------------------
// Commands (§3.5) — idempotent, snapshot-targeted ops the app issues; the extension executes strictly
// in seq order. `nid` is the primary target (stable per epoch); `rebindPath` is the post-mutation
// fallback locator. Every MUTATING command's result carries a fresh snapshotDelta.
// ---------------------------------------------------------------------------
export interface TargetRef {
  nid: number;
  rebindPath?: string;
}

export type WaitCond =
  | { kind: 'enabled'; target: TargetRef }
  | { kind: 'present'; textOrRole: { text?: string; role?: string } }
  | { kind: 'absent'; target: TargetRef }
  | { kind: 'urlMatches'; pattern: string }
  | { kind: 'quiet'; quietMs: number };

export type Cmd =
  | { op: 'navigate'; url: string }
  | { op: 'snapshot'; scope?: number; full?: boolean }
  | { op: 'click'; target: TargetRef; clickCount?: 1 | 2 }
  | { op: 'fill'; target: TargetRef; value: string; method: 'auto' | 'native' | 'reactSetter' }
  | { op: 'selectOption'; target: TargetRef; option: { byText?: string; byValue?: string; byIndex?: number } }
  | { op: 'setChecked'; target: TargetRef; checked: boolean }
  | { op: 'chooseRadio'; group: number; option: { byText: string } }
  | { op: 'combobox'; target: TargetRef; typeText: string; pickText: string }
  | { op: 'upload'; target: TargetRef; fileId: string; fileName: string; mime: string }
  | { op: 'scrollIntoView'; target: TargetRef }
  | { op: 'scrollPage'; toBottom?: boolean; byPx?: number }
  | { op: 'waitFor'; cond: WaitCond; timeoutMs: number }
  | { op: 'extractText'; target: TargetRef; maxLen?: number };
export type CmdOp = Cmd['op'];

/** Machine error keys the actuator returns; free-form strings also allowed for adapter-specific cases. */
export const CMD_ERRORS = ['not_found', 'stale_epoch', 'disabled', 'timeout', 'detached', 'upload_failed'] as const;

export interface CmdResult {
  ok: boolean;
  error?: string;
  /** actuator auto-attaches a fresh snapshot after mutating ops. */
  snapshotDelta?: PageSnapshot;
}

// ---------------------------------------------------------------------------
// Upward EVENTS (§3.6) — what the extension reports to the app. page_gone/page_ready are the resume
// backbone: a dead port → page_gone → app moves the run to waiting_page; a reconnect → hello/page_ready
// → app resumes by re-classifying the live page (never replays command history).
// ---------------------------------------------------------------------------
export interface TabInfo {
  tabId: number;
  epoch: string;
  url: string;
  runId?: string;
  lane?: string;
}

export type ExtEvent =
  | { kind: 'hello'; tabs: TabInfo[] }
  | { kind: 'page_ready'; epoch: string; url: string; snapshot: PageSnapshot }
  | { kind: 'page_gone'; epoch: string; reason: 'nav' | 'close' | 'crash' | 'bfcache' }
  | { kind: 'mutated'; epoch: string; hash: string }
  | { kind: 'cmd_result'; seq: number; result: CmdResult }
  | { kind: 'dialog'; epoch: string; dialogKind: 'beforeunload' | 'alert'; text: string }
  | { kind: 'tab_error'; tabId: number; error: string };
export type ExtEventKind = ExtEvent['kind'];

// ---------------------------------------------------------------------------
// The wire ENVELOPE (§3.2) — every message, both directions, is sequenced so a dead port never loses
// state. Outbound (app→ext): { v:1, kind:'cmd', runId, epoch, seq, body:Cmd }. Inbound (ext→app):
// { v:1, kind:<ExtEvent.kind>, runId?, epoch?, seq, body:<ExtEvent> } — the app validates env.body
// against its ExtEvent schema (the event carries its own discriminating `kind`).
// ---------------------------------------------------------------------------
export interface TypedEnvelope<T> {
  v: 1;
  kind: string;
  runId?: string;
  epoch?: string;
  seq: number;
  ack?: number;
  body: T;
}

// ---------------------------------------------------------------------------
// Payload CAPS — enforced so a v11-style 16MB payload / uncapped snapshot is impossible (§12). The
// sensor enforces snapshotBytes/snapshotNodes; the rest document the app-side budgets for parity.
// (Belongs in shared/src/constants.ts on promotion — see the header note.)
// ---------------------------------------------------------------------------
export const CAPS = {
  snapshotBytes: 128 * 1024,
  snapshotNodes: 400,
  patchFrameBytes: 4 * 1024,
  patchReplayRing: 500,
  listPayloadBytes: 64 * 1024,
} as const;
