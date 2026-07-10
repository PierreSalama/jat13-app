// The ONE API envelope. v13.0.0's blank-Documents-page class ({rows:{rows}} double-wrap) existed
// because every route improvised its shape; here the shape exists exactly once, as zod schemas both
// sides parse and contract tests assert per route:
//   success = { ok: true,  data: <payload> }
//   error   = { ok: false, error: { code: "<snake_case>", message: "<human>" } }
// The single sanctioned exception: GET /health keeps the bare v11-era liveness shape — external
// probes (and the extension's is-the-brain-up check) predate the envelope and rely on it.
import { z } from 'zod';

/** Machine-readable snake_case error codes ("not_found", "bad_request", "db_locked"). */
export const ErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'error codes are snake_case');

export const ErrorShapeSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
});

export const OkEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() });
export const ErrEnvelopeSchema = z.object({ ok: z.literal(false), error: ErrorShapeSchema });

/** Loose validator: "is this ANY well-formed envelope?" — the renderer API client and the
 *  route contract tests both run every response through this before touching data. */
export const EnvelopeSchema = z.discriminatedUnion('ok', [OkEnvelopeSchema, ErrEnvelopeSchema]);

/** Contract-test helper: the success envelope with a KNOWN payload schema, so per-route tests
 *  assert the exact shape (`okEnvelopeOf(z.object({ rows: ... }))`) instead of `unknown`. */
export function okEnvelopeOf<T extends z.ZodType>(data: T) {
  return z.object({ ok: z.literal(true), data });
}

export interface Ok<T> {
  ok: true;
  data: T;
}

export interface Err {
  ok: false;
  error: { code: string; message: string };
}

export type Envelope<T> = Ok<T> | Err;

/** Build a success envelope. Every route returns `c.json(ok(payload))` — never a bare object. */
export function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}

/** Build an error envelope. `code` is the machine contract; `message` is for humans/logs. */
export function err(code: string, message: string): Err {
  return { ok: false, error: { code, message } };
}
