// secrets DAL — sealed credential storage with token-health reporting (schema: `secrets`).
//
// SECURITY LAW (encodes the v11 "API key in a settings JSON" failure): plaintext NEVER lives in
// settings, NEVER touches an emitted DomainEvent, and is NEVER written to any log column. The only
// at-rest form is the OS-sealed BLOB in `secrets.sealed`. safeStorage (the real Sealer) is unavailable
// under vitest, so the DAL takes an INJECTED Sealer — production wires Electron safeStorage, tests wire
// a fake. The DAL treats the sealed bytes as opaque and only round-trips them through the Sealer.
//
// This is the ONE writer of the `secrets` table (structural law 5). Every mutating write emits a
// DomainEvent whose patch carries STATUS/health fields only — never the plaintext, never the sealed bytes.

import type { DalContext, DomainEvent } from './util.js';
import { makeStmtCache } from './util.js';

/**
 * The sealing primitive the DAL depends on. Production passes an adapter over Electron `safeStorage`
 * (OS keychain / DPAPI); tests pass a fake. `available()` is false when the platform can't seal
 * (e.g. a headless Linux box with no keyring, or vitest) — callers must refuse to store rather than
 * fall back to plaintext.
 */
export interface Sealer {
  available(): boolean;
  seal(plaintext: string): Buffer;
  open(sealed: Buffer): string;
}

/** How a consumer classifies a failed use, so `reportUse` maps it onto the CHECK'd status vocab. */
export type SecretFailureReason = 'expired' | 'revoked';

export interface ReportUseInput {
  /** short human error for the token-health UI; stored capped at 512 chars, never the plaintext. */
  error?: string;
  /** epoch-ms hint of when the credential is known to expire (e.g. an OAuth `expiry_date`). */
  expiresHintAt?: number;
  /** on failure only: whether the credential is expired (refreshable) or revoked (dead). Defaults 'expired'. */
  reason?: SecretFailureReason;
}

/** Row returned by `health()` — the token-health panel's shape. NEVER carries `sealed`. */
export interface SecretHealth {
  key: string;
  status: 'ok' | 'expired' | 'revoked' | 'unknown';
  last_ok_at: number | null;
  last_error: string | null;
  expires_hint_at: number | null;
}

/** The surface the rest of the app codes against (Gmail sync / AI client / token-health UI). */
export interface SecretsDal {
  seal(key: string, plaintext: string): void;
  open(key: string): string | undefined;
  reportUse(key: string, ok: boolean, input?: ReportUseInput): void;
  health(): SecretHealth[];
}

const LAST_ERROR_CAP = 512;

/** cap the stored error to the column's CHECK (length <= 512) so a long provider message can't throw. */
function capError(s: string | undefined): string | null {
  if (s === undefined) return null;
  return s.length > LAST_ERROR_CAP ? s.slice(0, LAST_ERROR_CAP) : s;
}

export function makeSecretsDal(ctx: DalContext, sealer: Sealer): SecretsDal {
  const stmt = makeStmtCache(ctx.db);

  // Health-only projection: `sealed` is deliberately absent so no read path can leak it to the UI.
  const HEALTH_COLS = 'key, status, last_ok_at, last_error, expires_hint_at';

  /**
   * Seal `plaintext` under `key` and store the opaque BLOB with status='ok'. Refuses (throws) if the
   * platform can't seal — we NEVER persist plaintext as a fallback. The emitted patch carries only the
   * health fields; it must never contain the plaintext or the sealed bytes.
   */
  function seal(key: string, plaintext: string): void {
    if (!sealer.available()) {
      throw new Error('secrets: Sealer unavailable — refusing to store credential in plaintext');
    }
    const sealed = sealer.seal(plaintext);
    const now = ctx.now();
    stmt(
      `INSERT INTO secrets (key, sealed, status, updated_at)
       VALUES (@key, @sealed, 'ok', @now)
       ON CONFLICT(key) DO UPDATE SET sealed = @sealed, status = 'ok', updated_at = @now`,
    ).run({ key, sealed, now });
    const evt: DomainEvent = {
      table: 'secrets',
      op: 'update',
      id: key,
      patch: { key, status: 'ok', updated_at: now },
    };
    ctx.emit(evt);
  }

  /**
   * Read + unseal the credential for `key`, or `undefined` if there is no row. The plaintext returned
   * here is the ONLY place it exists in memory — the caller (Gmail sync / AI client) must not persist it.
   */
  function open(key: string): string | undefined {
    const row = stmt('SELECT sealed FROM secrets WHERE key = ?').get(key) as
      | { sealed: Buffer | Uint8Array }
      | undefined;
    if (!row) return undefined;
    // better-sqlite3 hands back a Buffer for BLOB; normalize defensively before handing to the Sealer.
    const sealed = Buffer.isBuffer(row.sealed) ? row.sealed : Buffer.from(row.sealed);
    return sealer.open(sealed);
  }

  /**
   * A consumer reports the outcome of USING the credential. On success: status='ok', last_ok_at=now,
   * last_error cleared. On failure: status='expired' (default, refreshable) or 'revoked' (dead) per
   * `reason`, last_error captured (capped). `expiresHintAt` (if given) is always recorded. No-op patch
   * if the key doesn't exist (never resurrects a deleted secret). Never touches `sealed`.
   */
  function reportUse(key: string, ok: boolean, input: ReportUseInput = {}): void {
    const now = ctx.now();
    const expiresHintAt = input.expiresHintAt ?? null;
    let status: SecretHealth['status'];
    let lastError: string | null;
    let lastOkAt: number | null;
    if (ok) {
      status = 'ok';
      lastOkAt = now;
      lastError = null;
    } else {
      status = input.reason === 'revoked' ? 'revoked' : 'expired';
      lastOkAt = null; // COALESCE below keeps the prior last_ok_at
      lastError = capError(input.error);
    }
    const info = stmt(
      `UPDATE secrets
          SET status = @status,
              last_ok_at = COALESCE(@lastOkAt, last_ok_at),
              last_error = @lastError,
              expires_hint_at = COALESCE(@expiresHintAt, expires_hint_at),
              updated_at = @now
        WHERE key = @key`,
    ).run({ key, status, lastOkAt, lastError, expiresHintAt, now });
    if (info.changes === 0) return; // no such secret — nothing to emit
    const patch: Record<string, unknown> = { key, status, updated_at: now };
    if (ok) patch.last_ok_at = now;
    else patch.last_error = lastError;
    if (input.expiresHintAt !== undefined) patch.expires_hint_at = input.expiresHintAt;
    const evt: DomainEvent = { table: 'secrets', op: 'update', id: key, patch };
    ctx.emit(evt);
  }

  /**
   * The token-health UI feed. Explicit health-only column list (structural law 4) — `sealed` is never
   * selected, so this endpoint structurally cannot leak the credential bytes. Ordered by key for a
   * stable panel; small fixed set of keys, so no limit is needed.
   */
  function health(): SecretHealth[] {
    return stmt(`SELECT ${HEALTH_COLS} FROM secrets ORDER BY key ASC`).all() as SecretHealth[];
  }

  return { seal, open, reportUse, health };
}
