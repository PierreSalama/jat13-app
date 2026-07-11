// The LEARN API surface — two authed loopback routes mounted inside the existing /api token guard.
// The learning path is the extension recorder's uplink: the SW POSTs observed batches here (already
// redacted extension-side), and reads the master-switch + apply-host patterns from here.
//
//   POST /api/learn/observe  — validate a batch, hand it to the distiller, return { learned }.
//   GET  /api/learn/config   — { enabled, applyHosts } so the SW knows whether/where to observe.
//
// Both mount via mountLearnApi(api, dal, distiller) from api.ts's `extend` hook, so they inherit the
// X-JAT13-Token guard automatically. Ported from cb25d19 with the ONE new-convention delta the rebuild
// mandates: EVERY /api response goes through the shared ok()/err() envelope (the {rows:{rows}} scar) —
// the old bare `{ error }` / `{ learned }` bodies are gone. The SW consumes the envelope like every
// other client (lib/api.js unwraps it in the renderer; the SW unwraps `data` the same way).

import type { Hono, Context } from 'hono';
import { ok, err } from '@jat13/shared';
import type { Dal } from '../db/dal/index.js';
import type { LearnDistiller, ObservedBatch, ObservedEvent } from './distiller.js';

/**
 * The apply-surface patterns the extension SW uses to decide whether to OBSERVE a tab. `host` is a
 * suffix match; the optional `path` is a substring of pathname+search. Kept in sync (by intent) with
 * the SW's DEFAULT_APPLY_HOSTS. Returned to the SW by /learn/config so the app can retune the observe
 * surface without shipping a new extension.
 */
export const APPLY_HOST_PATTERNS: ReadonlyArray<{ host: string; path?: string }> = [
  { host: 'linkedin.com', path: '/apply' },
  { host: 'smartapply.indeed.com' },
  { host: 'indeed.com', path: 'apply' },
  { host: 'greenhouse.io' },
  { host: 'lever.co' },
  { host: 'ashbyhq.com' },
];

/**
 * Whether watch-and-learn is ON. Reads settings.learn.enabled, defaulting to TRUE (Pierre: on by
 * default). Resilient to the `learn` settings section not being registered yet: dal.settings.get()
 * THROWS on an unknown section, so any failure falls through to the ON default — the flag works both
 * before and after a `learn` section is added to the registry, and never reaches for raw SQL (which
 * would break the no-raw-SQL-outside-db/dal law this file lives under).
 */
export function learnEnabled(dal: Dal): boolean {
  try {
    const learn = dal.settings.get('learn') as { enabled?: boolean };
    if (typeof learn.enabled === 'boolean') return learn.enabled;
  } catch {
    /* `learn` section not registered yet — fall through to the ON default */
  }
  return true;
}

/** The /learn/config payload. Pure (no request) so tests can assert it directly. */
export function learnConfig(
  dal: Dal,
): { enabled: boolean; applyHosts: ReadonlyArray<{ host: string; path?: string }> } {
  return { enabled: learnEnabled(dal), applyHosts: APPLY_HOST_PATTERNS };
}

/** Defensively coerce an untrusted request body into an ObservedBatch, or null if unusable. */
export function validateBatch(body: unknown): ObservedBatch | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.events)) return null;
  if (b.events.length > 500) return null; // payload discipline

  const events: ObservedEvent[] = [];
  for (const raw of b.events) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (e.kind !== 'fill' && e.kind !== 'choose' && e.kind !== 'advance') continue;
    const ev: ObservedEvent = { kind: e.kind };
    if (typeof e.label === 'string') ev.label = e.label.slice(0, 512);
    if (typeof e.fieldType === 'string') ev.fieldType = e.fieldType.slice(0, 32);
    if (typeof e.value === 'string') ev.value = e.value.slice(0, 8192);
    if (typeof e.choice === 'string') ev.choice = e.choice.slice(0, 8192);
    if (e.redacted === true) ev.redacted = true;
    if (typeof e.at === 'number') ev.at = e.at;
    events.push(ev);
  }

  const out: ObservedBatch = { events };
  if (typeof b.sessionId === 'string') out.sessionId = b.sessionId.slice(0, 64);
  if (typeof b.url === 'string') out.url = b.url.slice(0, 2048);
  if (typeof b.host === 'string') out.host = b.host.slice(0, 256);
  return out;
}

/** Mount the two learn routes on the ALREADY-AUTHED /api sub-app (enveloped, guarded). */
export function mountLearnApi(api: Hono, dal: Dal, distiller: LearnDistiller): void {
  api.get('/learn/config', (c: Context) => {
    try {
      return c.json(ok(learnConfig(dal)));
    } catch (e) {
      return c.json(err('internal', e instanceof Error ? e.message : String(e)), 500);
    }
  });

  api.post('/learn/observe', async (c: Context) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(err('bad_json', 'expected a JSON body'), 400);
    }
    const batch = validateBatch(raw);
    if (!batch) return c.json(err('bad_batch', 'body must be { events: ObservedEvent[] } (<= 500)'), 400);
    try {
      // honor the master switch server-side too (the SW also gates, but never trust the client alone).
      if (!learnEnabled(dal)) return c.json(ok({ learned: 0, dropped: batch.events.length, disabled: true }));
      const res = distiller.ingest(batch);
      return c.json(ok({ learned: res.learned, dropped: res.dropped }));
    } catch (e) {
      return c.json(err('internal', e instanceof Error ? e.message : String(e)), 500);
    }
  });
}
