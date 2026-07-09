// The ACTUATOR command set (Pillar 3 §3.5) — idempotent, snapshot-targeted operations the app issues
// and the extension executes strictly in seq order per run. `nid` is the primary target (stable per
// epoch); `rebindPath` is the post-mutation fallback locator. Every mutating command's result carries
// a fresh snapshot so the app always decides the next action against post-action reality.
import { z } from 'zod';
import { PageSnapshot } from './snapshot.js';

export const TargetRef = z.object({
  nid: z.number().int(),
  rebindPath: z.string().optional(),
});
export type TargetRef = z.infer<typeof TargetRef>;

export const WaitCond = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('enabled'), target: TargetRef }),
  z.object({
    kind: z.literal('present'),
    textOrRole: z.object({ text: z.string().optional(), role: z.string().optional() }),
  }),
  z.object({ kind: z.literal('absent'), target: TargetRef }),
  z.object({ kind: z.literal('urlMatches'), pattern: z.string() }),
  z.object({ kind: z.literal('quiet'), quietMs: z.number().int() }),
]);
export type WaitCond = z.infer<typeof WaitCond>;

export const Cmd = z.discriminatedUnion('op', [
  z.object({ op: z.literal('navigate'), url: z.string() }),
  z.object({ op: z.literal('snapshot'), scope: z.number().int().optional(), full: z.boolean().optional() }),
  z.object({ op: z.literal('click'), target: TargetRef, clickCount: z.union([z.literal(1), z.literal(2)]).optional() }),
  z.object({ op: z.literal('fill'), target: TargetRef, value: z.string(), method: z.enum(['auto', 'native', 'reactSetter']) }),
  z.object({
    op: z.literal('selectOption'),
    target: TargetRef,
    option: z.object({ byText: z.string().optional(), byValue: z.string().optional(), byIndex: z.number().int().optional() }),
  }),
  z.object({ op: z.literal('setChecked'), target: TargetRef, checked: z.boolean() }),
  z.object({ op: z.literal('chooseRadio'), group: z.number().int(), option: z.object({ byText: z.string() }) }),
  z.object({ op: z.literal('combobox'), target: TargetRef, typeText: z.string(), pickText: z.string() }),
  z.object({ op: z.literal('upload'), target: TargetRef, fileId: z.string(), fileName: z.string(), mime: z.string() }),
  z.object({ op: z.literal('scrollIntoView'), target: TargetRef }),
  z.object({ op: z.literal('scrollPage'), toBottom: z.boolean().optional(), byPx: z.number().optional() }),
  z.object({ op: z.literal('waitFor'), cond: WaitCond, timeoutMs: z.number().int() }),
  z.object({ op: z.literal('extractText'), target: TargetRef, maxLen: z.number().int().optional() }),
]);
export type Cmd = z.infer<typeof Cmd>;
export type CmdOp = Cmd['op'];

/** Machine error keys the actuator returns; free-form strings also allowed for adapter-specific cases. */
export const CMD_ERRORS = ['not_found', 'stale_epoch', 'disabled', 'timeout', 'detached', 'upload_failed'] as const;

export const CmdResult = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  /** actuator auto-attaches a fresh snapshot after mutating ops. */
  snapshotDelta: PageSnapshot.optional(),
});
export type CmdResult = z.infer<typeof CmdResult>;
