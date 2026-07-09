// The wire ENVELOPE (Pillar 3 §3.2) — every message, both directions, is sequenced so a dead port
// never loses state. The app assigns cmd.seq from apply_runs.cmd_seq (persisted BEFORE send); the
// extension executes strictly in seq order and replies with the same seq; receiving a result for an
// already-recorded seq is idempotent. A command whose `epoch` != the live tab's epoch is refused
// (`stale_epoch`) — a command aimed at a dead page can never fire on a new one.
import { z } from 'zod';

/** Frame validator (body is opaque here; each `kind` validates its own body downstream). */
export const Envelope = z.object({
  v: z.literal(1),
  kind: z.string(),
  runId: z.string().optional(), //    absent for control messages
  epoch: z.string().optional(), //    TabSession epoch
  seq: z.number().int(), //           sender-monotonic per (runId | control)
  ack: z.number().int().optional(), // highest peer seq processed
  body: z.unknown(),
});

/** Typed view for producers/consumers that know their body shape. */
export interface TypedEnvelope<T> {
  v: 1;
  kind: string;
  runId?: string;
  epoch?: string;
  seq: number;
  ack?: number;
  body: T;
}
