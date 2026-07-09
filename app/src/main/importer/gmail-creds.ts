// gmail-creds.ts — carry a working Gmail connection from JAT v11 into v13 so email→status works the
// instant the import finishes, with NO second OAuth consent. v11 stored (app/src/db.js + gmail.js):
//   • settings section 'gmail' → a JSON blob { clientId, clientSecret(SEALED), query, enabled, … }
//   • kv key 'gmailTokens'     → a SEALED JSON blob { access_token, refresh_token, expires_at }
// v11 sealed clientSecret + gmailTokens through Electron safeStorage, tagged `enc:v1:` (secretstore.js).
// On the same Windows user (DPAPI is user-scoped, not app-scoped) v13's safeStorage can decrypt them —
// production passes an `unsealV11` that does exactly that; tests pass plaintext and omit it.
//
// This writes ONLY through the DAL (single writer): an email_accounts row, the sealed client creds +
// sealed refresh-token set (under the SAME secrets keys makeGmailClientFactory reads), and — as the one
// legitimate settings write — the carried-over gmail.query (a registered, non-secret key). It is:
//   • CONSENT-GATED: opts.consent defaults FALSE (only the wizard's "migrate Gmail" checkbox flips it),
//   • IDEMPOTENT: a deterministic account id means a re-run touches nothing,
//   • GRACEFUL: a v11 with no Gmail set up, or a sealed value we can't unseal, is a clean no-op.

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { existsSync } from 'node:fs';
import type { Dal } from '../db/dal/index.js';
import { sealClientCredentials, sealToken, type GmailTokenSet } from '../gmail/oauth.js';

/** v11 secretstore.js tag prefixing a safeStorage-sealed value. */
const V11_SEAL_PREFIX = 'enc:v1:';

export interface MigrateGmailDeps {
  dal: Dal;
  /**
   * Decrypt a v11 `enc:v1:`-tagged value (production: Electron safeStorage.decryptString on the sealed
   * base64). Omitted in tests / when the OS keychain is unavailable → sealed values are treated as
   * unreadable and the migration no-ops cleanly rather than storing garbage.
   */
  unsealV11?: (stored: string) => string;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface MigrateGmailOptions {
  /** Master consent gate. FALSE (default) → no-op. Set TRUE only when the import wizard's box is checked. */
  consent?: boolean;
  /** Deterministic account id so re-imports are idempotent (default 'acct_v11_gmail'). */
  accountId?: string;
}

export type MigrateGmailReason =
  | 'not_consented'
  | 'source_missing'
  | 'no_gmail_settings'
  | 'no_client_credentials'
  | 'no_refresh_token'
  | 'sealed_no_unsealer';

export interface MigrateGmailResult {
  migrated: boolean;
  reason?: MigrateGmailReason;
  accountId?: string;
  email?: string;
}

interface TokenBlob {
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
  email?: string;
}

interface ResolvedSecret {
  value: string;
  /** the value was sealed (`enc:v1:`) but we had no working unsealer → treat as unavailable. */
  blockedSealed: boolean;
}

/**
 * Migrate v11's stored Gmail credentials into v13. See file header for the full contract.
 * @param v13db  the live v13 database handle (the DAL's single writer; used for the token_state UPDATE).
 * @param v11SourcePath  path to the v11 jat.db (opened READ-ONLY, feature-detected).
 */
export function migrateGmailCredentials(
  v13db: DB,
  v11SourcePath: string,
  deps: MigrateGmailDeps,
  opts: MigrateGmailOptions = {},
): MigrateGmailResult {
  const { dal } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  if (!opts.consent) return { migrated: false, reason: 'not_consented' };
  if (!existsSync(v11SourcePath)) return { migrated: false, reason: 'source_missing' };

  const accountId = opts.accountId ?? 'acct_v11_gmail';

  let src: DB | null = null;
  try {
    src = new Database(v11SourcePath, { readonly: true, fileMustExist: true });
    src.pragma('query_only = ON'); // belt-and-suspenders: the handle physically cannot write.

    const gmail = readV11GmailSettings(src);
    if (!gmail) return { migrated: false, reason: 'no_gmail_settings' };

    const ci = resolveV11Secret(gmail.clientId, deps.unsealV11); // clientId is plaintext in v11 — tolerant.
    const cs = resolveV11Secret(gmail.clientSecret, deps.unsealV11); // clientSecret is sealed in v11.
    const clientId = ci.value.trim();
    const clientSecret = cs.value.trim();
    if (!clientId || !clientSecret) {
      const reason = ci.blockedSealed || cs.blockedSealed ? 'sealed_no_unsealer' : 'no_client_credentials';
      log(`gmail migration skipped: ${reason}`);
      return { migrated: false, reason };
    }

    // Refresh token: primary from kv.gmailTokens (real v11), fallback to one embedded in the gmail blob.
    const kv = readV11GmailTokens(src, deps.unsealV11);
    let tokenBlob: TokenBlob | null = kv.blob && kv.blob.refresh_token ? kv.blob : null;
    if (!tokenBlob) tokenBlob = embeddedTokens(gmail);
    const refreshToken = (tokenBlob?.refresh_token ?? '').trim();
    if (!refreshToken) {
      const reason: MigrateGmailReason = kv.blockedSealed ? 'sealed_no_unsealer' : 'no_refresh_token';
      log(`gmail migration skipped: ${reason}`);
      return { migrated: false, reason };
    }

    const email = pickEmail(gmail, tokenBlob);

    // Persist through the DAL (single writer). Deterministic account id ⇒ idempotent re-runs.
    const account = dal.emails.ensureAccount({ kind: 'gmail_oauth', email, id: accountId });
    const tokens: GmailTokenSet = { refresh_token: refreshToken, issued_at: now() };
    if (tokenBlob?.access_token) tokens.access_token = tokenBlob.access_token;
    if (typeof tokenBlob?.expires_at === 'number' && Number.isFinite(tokenBlob.expires_at)) {
      tokens.expiry_date = tokenBlob.expires_at;
    }
    sealClientCredentials(dal, clientId, clientSecret);
    sealToken(dal, account.id, tokens);

    // Flip the account healthy (mirrors the connect flow + index.ts's single-writer UPDATE).
    v13db
      .prepare('UPDATE email_accounts SET token_state = ?, auth_fail_count = 0, last_ok_at = ?, updated_at = ? WHERE id = ?')
      .run('healthy', now(), now(), account.id);

    // Carry the broad v11 job-mail query into the (registered, non-secret) v13 setting — best-effort.
    const query = typeof gmail.query === 'string' ? gmail.query.trim() : '';
    if (query) {
      try {
        dal.settings.set('gmail', 'query', query);
      } catch (e) {
        log(`gmail.query carry skipped: ${(e as Error).message}`);
      }
    }

    log(`gmail credentials migrated → account ${account.id} (${email || 'no address'})`);
    return { migrated: true, accountId: account.id, email };
  } finally {
    try {
      src?.close();
    } catch {
      /* ignore */
    }
  }
}

// ---- v11 read helpers (feature-detected, read-only) ------------------------------------------------

/** Read the v11 gmail settings object across both known shapes: (section,value blob) and (section,key,value). */
function readV11GmailSettings(src: DB): Record<string, unknown> | null {
  const cols = tableCols(src, 'settings');
  if (!cols) return null;

  // (section,key,value) rows — the alt shape some tooling used.
  if (cols.has('key') && cols.has('value')) {
    const hasSection = cols.has('section');
    const rows = (
      hasSection
        ? src.prepare("SELECT key, value FROM settings WHERE section = 'gmail'").all()
        : src.prepare("SELECT key, value FROM settings WHERE key LIKE 'gmail.%'").all()
    ) as { key?: string; value?: unknown }[];
    if (!rows.length) return null;
    const obj: Record<string, unknown> = {};
    for (const r of rows) {
      const raw = String(r.key ?? '');
      const key = hasSection ? raw : raw.slice('gmail.'.length);
      if (key) obj[key] = jsonMaybe(r.value);
    }
    return Object.keys(obj).length ? obj : null;
  }

  // Real v11: settings(section PRIMARY KEY, value TEXT) with the whole section as a JSON blob.
  if (cols.has('value')) {
    const row = src.prepare("SELECT value FROM settings WHERE section = 'gmail'").get() as { value?: unknown } | undefined;
    if (!row || row.value == null) return null;
    return safeJsonObject(String(row.value));
  }
  return null;
}

/** Read + unseal the v11 kv 'gmailTokens' blob. */
function readV11GmailTokens(src: DB, unseal?: (s: string) => string): { blob: TokenBlob | null; blockedSealed: boolean } {
  const cols = tableCols(src, 'kv');
  if (!cols || !cols.has('key') || !cols.has('value')) return { blob: null, blockedSealed: false };
  const row = src.prepare('SELECT value FROM kv WHERE key = ?').get('gmailTokens') as { value?: unknown } | undefined;
  if (!row || row.value == null) return { blob: null, blockedSealed: false };
  const resolved = resolveV11Secret(row.value, unseal);
  if (resolved.blockedSealed) return { blob: null, blockedSealed: true };
  const parsed = safeJsonObject(resolved.value);
  return { blob: parsed as TokenBlob | null, blockedSealed: false };
}

/** Refresh token embedded directly in the gmail settings blob (fallback / the test's simplified shape). */
function embeddedTokens(gmail: Record<string, unknown>): TokenBlob | null {
  const nested = (gmail.tokens ?? gmail.token) as Record<string, unknown> | undefined;
  const refresh =
    (typeof gmail.refresh_token === 'string' ? gmail.refresh_token : undefined) ??
    (nested && typeof nested.refresh_token === 'string' ? nested.refresh_token : undefined);
  if (!refresh) return null;
  const blob: TokenBlob = { refresh_token: refresh };
  const access =
    (typeof gmail.access_token === 'string' ? gmail.access_token : undefined) ??
    (nested && typeof nested.access_token === 'string' ? nested.access_token : undefined);
  if (access) blob.access_token = access;
  return blob;
}

function pickEmail(gmail: Record<string, unknown>, tokenBlob: TokenBlob | null): string {
  const candidates = [gmail.email, gmail.address, gmail.accountEmail, gmail.emailAddress, tokenBlob?.email];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().toLowerCase();
  }
  return '';
}

/** Resolve a possibly-sealed v11 value: pass plaintext through; unseal `enc:v1:` when we can. */
function resolveV11Secret(raw: unknown, unseal?: (s: string) => string): ResolvedSecret {
  if (raw == null) return { value: '', blockedSealed: false };
  const s = String(raw);
  if (s.startsWith(V11_SEAL_PREFIX)) {
    if (!unseal) return { value: '', blockedSealed: true };
    try {
      return { value: unseal(s), blockedSealed: false };
    } catch {
      return { value: '', blockedSealed: true };
    }
  }
  return { value: s, blockedSealed: false };
}

// ---- tiny sqlite / json utils ----------------------------------------------------------------------

function tableCols(src: DB, table: string): Set<string> | null {
  const rows = src.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[];
  if (!rows.length) return null;
  return new Set(rows.map((r) => r.name));
}

function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

function safeJsonObject(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A row-shaped setting value may itself be JSON (e.g. '"a string"' / 'true' / '{...}') — parse if so. */
function jsonMaybe(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t) return v;
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"') || t === 'true' || t === 'false' || t === 'null' || /^-?\d/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}
