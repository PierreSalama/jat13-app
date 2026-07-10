// DAL foundation + aggregate. Stage 0 exposes exactly what the skeleton needs to boot, pair, and
// remember knobs: `settings` (registry-merged) and `secrets` (sealed pairing-token storage). Every
// later module (jobs/applications/runs/…) is a factory bound to the SAME DalContext — one db handle,
// one clock, one id source, one event sink — so there is exactly one writer path and event emission
// stays uniform. No raw SQL outside db/dal/ (grep-gated law; v13's law leaked without the gate).
//
// NOTE on module shape: settings.ts / secrets.ts import the foundation back from this file, which
// is a benign ESM cycle — they only use hoisted function declarations + erased types, nothing at
// module-evaluation time. When the DAL grows past a couple modules, split the foundation into
// dal/util.ts (the old tree's shape) and the cycle disappears.

import type { Database, Statement } from 'better-sqlite3';
import { makeSettingsDal } from './settings.js';
import { makeSecretsDal, type Sealer, type SecretsDal } from './secrets.js';

/** Event-sink payload: the CHANGED ROW (or a partial patch), never "refetch everything".
 *  `emit` is a no-op until a consumer (live UI updates — build-or-strike at Stage 0's PatchBus
 *  decision) subscribes; DALs emit unconditionally so the seam already exists either way. */
export interface DomainEvent {
  table: string;
  op: 'insert' | 'update' | 'delete';
  id: string;
  /** the changed lean row (or a partial patch); omitted for deletes. */
  patch?: Record<string, unknown>;
}

export interface DalContext {
  db: Database;
  /** epoch-ms; injectable so tests are deterministic and the importer can backfill historical times. */
  now: () => number;
  /** monotonic, sortable id with a table prefix (e.g. `run_01J…`). */
  newId: (prefix: string) => string;
  /** event-sink hook; no-op until a live consumer subscribes. */
  emit: (evt: DomainEvent) => void;
}

// ---- id generation (ULID: 48-bit time + 80-bit randomness, Crockford base32, lexically sortable) --
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID body (26 chars). Sortable-by-creation is what the timeline/queue ORDER BYs lean on. */
export function ulid(nowMs: number = Date.now()): string {
  let t = nowMs;
  const time = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = CROCKFORD[t % 32]!;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(Math.random() * 32)];
  return time.join('') + rand;
}

/** Default DalContext; real main-process wiring passes the same shapes (with a live emit). */
export function defaultContext(db: Database, emit: DalContext['emit'] = () => {}): DalContext {
  return { db, now: () => Date.now(), newId: (prefix) => `${prefix}_${ulid()}`, emit };
}

/**
 * Prepared-statement cache keyed by SQL text. better-sqlite3 does NOT cache prepares itself, so
 * each DAL builds one of these to avoid recompiling hot queries. Bound to a single db handle.
 */
export function makeStmtCache(db: Database) {
  const cache = new Map<string, Statement>();
  return (sql: string): Statement => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
}

// ---- the aggregate -------------------------------------------------------------------------------

export interface Dal {
  settings: ReturnType<typeof makeSettingsDal>;
  secrets: SecretsDal;
  /** the shared context, so callers can run their own ctx.db.transaction / emit / newId. */
  ctx: DalContext;
}

/**
 * Build the Stage-0 DAL. Secrets needs a Sealer (Electron safeStorage in main; a fake in tests) —
 * the only external dependency any module takes; injected because safeStorage does not exist under
 * vitest and plaintext-fallback is forbidden.
 */
export function makeDal(ctx: DalContext, deps: { sealer: Sealer }): Dal {
  return {
    settings: makeSettingsDal(ctx),
    secrets: makeSecretsDal(ctx, deps.sealer),
    ctx,
  };
}

// Re-exports so consumers import the whole DAL surface from one place.
export type { Sealer, SecretsDal, SecretHealth, ReportUseInput, SecretFailureReason } from './secrets.js';
export type { SettingsSnapshot, SettingSpec, SettingType, SettingsRegistry } from './settings.js';
export { SETTINGS_REGISTRY, validate as validateSetting } from './settings.js';
