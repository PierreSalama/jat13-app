// PageSnapshot — the SENSOR format (Pillar 3 §3.3). An accessibility-tree-ish, size-bounded view of
// the live page. This is the ONLY thing the extension sends up about page content; the app classifies
// and decides against it. zod is the single source of truth (types are inferred), so a malformed
// snapshot is rejected at the gateway boundary, not deep in the interpreter.
import { z } from 'zod';

/** Roles the sensor emits (a curated interaction-oriented subset of ARIA). */
export const SNAP_ROLES = [
  'button', 'link', 'textbox', 'textarea', 'radio', 'checkbox', 'combobox', 'select',
  'option', 'file', 'heading', 'text', 'group', 'radiogroup', 'progressbar',
  'alert', 'dialog', 'img', 'iframe',
] as const;
export const SnapRole = z.enum(SNAP_ROLES);
export type SnapRole = z.infer<typeof SnapRole>;

export const SnapNodeStates = z.object({
  disabled: z.literal(true).optional(),
  checked: z.literal(true).optional(),
  required: z.literal(true).optional(),
  focused: z.literal(true).optional(),
  /** 0×0/opacity:0 input WITH a visible label affordance (v11.56 hidden-radio grounding). */
  hiddenInput: z.literal(true).optional(),
  /** name matched a leading loading token before app-side stripping (v11.86). */
  loadingLabel: z.literal(true).optional(),
  expanded: z.boolean().optional(),
});
export type SnapNodeStates = z.infer<typeof SnapNodeStates>;

export const SnapNodeAttrs = z.object({
  id: z.string().optional(),
  nameAttr: z.string().optional(),
  type: z.string().optional(),
  placeholder: z.string().optional(),
  autocomplete: z.string().optional(),
  testid: z.string().optional(),
  href: z.string().optional(),
  accept: z.string().optional(),
});
export type SnapNodeAttrs = z.infer<typeof SnapNodeAttrs>;

export const SnapNode = z.object({
  /** stable per epoch (WeakMap<Element,int>); THE command target. */
  nid: z.number().int(),
  role: SnapRole,
  /** accessible name (label/aria/placeholder/nearby-text ladder), ≤200 chars. */
  name: z.string().max(200),
  /** CURRENT value — REDACTED for password/sensitive-named fields (sensor never sends secrets up). */
  value: z.string().optional(),
  states: SnapNodeStates.optional(),
  /** affordance rect [x,y,w,h] (label rect for hiddenInput). */
  rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** shared id for radio/checkbox groups. */
  group: z.number().int().optional(),
  /** resolved question text for the group ('' when the resolver can't ground it — never a dirty label). */
  groupPrompt: z.string().optional(),
  attrs: SnapNodeAttrs.optional(),
  /** resilient locator (tag + stable-attr chain) — REBIND fallback only, never adapter-evaluated. */
  path: z.string(),
  headingLevel: z.number().int().optional(),
});
export type SnapNode = z.infer<typeof SnapNode>;

export const FrameSnap = z.object({
  framePath: z.string(), //   '' main, '0', '0.2', …
  frameHost: z.string(), //   cross-origin iframe: host only, nodes empty
  nodes: z.array(SnapNode),
});
export type FrameSnap = z.infer<typeof FrameSnap>;

export const PageSnapshot = z.object({
  v: z.literal(1),
  epoch: z.string(),
  url: z.string(),
  title: z.string(),
  readyState: z.enum(['loading', 'interactive', 'complete']),
  /** ms since the last DOM mutation burst (hydration/quiescence signal). */
  quietMs: z.number().int().nonnegative(),
  /** main frame first; same-process iframes flattened with framePath. */
  frames: z.array(FrameSnap),
  /** size cap (128KB / 400 nodes) hit — app may request a scoped snapshot. */
  truncated: z.boolean(),
  /** sha1 of the normalized node list (change detection). */
  hash: z.string(),
});
export type PageSnapshot = z.infer<typeof PageSnapshot>;
