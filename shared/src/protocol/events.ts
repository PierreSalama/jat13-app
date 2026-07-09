// Upward EVENTS (Pillar 3 §3.6) — what the extension reports to the app. Note `page_gone`/`page_ready`
// are the resume backbone: a dead port emits page_gone → app moves the run to waiting_page; a
// reconnect emits hello/page_ready → app resumes by re-classifying the live page (never replays).
import { z } from 'zod';
import { PageSnapshot } from './snapshot.js';
import { CmdResult } from './commands.js';

export const TabInfo = z.object({
  tabId: z.number().int(),
  epoch: z.string(),
  url: z.string(),
  runId: z.string().optional(),
  lane: z.string().optional(),
});
export type TabInfo = z.infer<typeof TabInfo>;

// NOTE: the plan's `dialog` event nests an inner `kind` — renamed to `dialogKind` here so the outer
// discriminator stays unambiguous on the wire.
export const ExtEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hello'), tabs: z.array(TabInfo) }),
  z.object({ kind: z.literal('page_ready'), epoch: z.string(), url: z.string(), snapshot: PageSnapshot }),
  z.object({ kind: z.literal('page_gone'), epoch: z.string(), reason: z.enum(['nav', 'close', 'crash', 'bfcache']) }),
  z.object({ kind: z.literal('mutated'), epoch: z.string(), hash: z.string() }),
  z.object({ kind: z.literal('cmd_result'), seq: z.number().int(), result: CmdResult }),
  z.object({ kind: z.literal('dialog'), epoch: z.string(), dialogKind: z.enum(['beforeunload', 'alert']), text: z.string() }),
  z.object({ kind: z.literal('tab_error'), tabId: z.number().int(), error: z.string() }),
]);
export type ExtEvent = z.infer<typeof ExtEvent>;
export type ExtEventKind = ExtEvent['kind'];
