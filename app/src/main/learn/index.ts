// The LEARN API surface — two authed loopback routes mounted inside the existing /api token guard.
// The learning path deliberately rides plain HTTP (NOT the zod wire protocol): the extension SW POSTs
// observed batches here, and reads the master-switch + apply-host patterns from here.
//
//   POST /api/learn/observe  — validate a batch, hand it to the distiller, return { learned }.
//   GET  /api/learn/config   — { enabled, applyHosts } so the SW knows whether/where to observe.
//
// Both are mounted via mountLearnApi(api, dal, distiller) from the api.ts `extend` hook, so they inherit
// the X-JAT13-Token guard automatically.

import type { Hono } from 'hono';
import type { Dal } from '../db/dal/index.js';
import type { LearnDistiller, ObservedBatch, ObservedEvent } from './distiller.js';

/**
 * The apply-surface patterns the extension SW uses to decide whether to OBSERVE a tab. host is a suffix
 * match; the optional path is a substring of pathname+search. Kept in sync (by intent) with the SW's
 * DEFAULT_APPLY_HOSTS. Returned to the SW by /api/learn/config so the app can retune without shipping a
 * new extension.
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
 * default). Resilient to the `learn` settings section not being registered yet: if the registry read
 * throws (section unknown) it falls back to a RAW settings-row read, then to the ON default — so the
 * flag works both before and after the schema snippet is applied.
 */
export function learnEnabled(dal: Dal): boolean {
  try {
    const learn = dal.settings.get('learn') as { enabled?: boolean };
    if (typeof learn.enabled === 'boolean') return learn.enabled;
  } catch {
    /* `learn` section not registered — fall through to a raw read */
  }
  try {
    const row = dal.ctx.db
      .prepare("SELECT value_json FROM settings WHERE section = 'learn' AND key = 'enabled'")
      .get() as { value_json: string } | undefined;
    if (row) return JSON.parse(row.value_json) !== false;
  } catch {
    /* ignore — default ON */
  }
  return true;
}

/** The /api/learn/config payload. Pure (no request) so tests can assert it directly. */
export function learnConfig(dal: Dal): { enabled: boolean; applyHosts: ReadonlyArray<{ host: string; path?: string }> } {
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

/** Mount the two learn routes on the ALREADY-AUTHED /api sub-app. */
export function mountLearnApi(api: Hono, dal: Dal, distiller: LearnDistiller): void {
  api.get('/learn/config', (c) => c.json(learnConfig(dal)));

  api.post('/learn/observe', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'bad_json' }, 400);
    }
    const batch = validateBatch(raw);
    if (!batch) return c.json({ error: 'bad_batch' }, 400);
    // honor the master switch server-side too (the SW also gates, but never trust the client alone).
    if (!learnEnabled(dal)) return c.json({ learned: 0, disabled: true });
    const res = distiller.ingest(batch);
    return c.json({ learned: res.learned });
  });
}
