// oauth.ts — Gmail OAuth client + token lifecycle helpers (Pillar 8 / plan §3). Two jobs, both
// side-effect-light so they're testable without a browser or a live Google:
//   1) seal/open the OAuth token set through the secrets DAL (safeStorage-sealed BLOB — plaintext never
//      lands in settings, an event, or a log; the secrets DAL enforces that).
//   2) compute token HEALTH (healthy | expiring_soon | expired | revoked | unauthorized) from the
//      sealed token's age + the last observed API outcome — this is the state the Mission Control chip
//      reads and what drives the weekly re-auth ritual.
// The live consent flow (loopback http server + shell.openExternal) is the APP's job later; this module
// exports only the client factory + the sealing/health helpers, and never opens a browser here.

import type { Dal } from '../db/dal/index.js';

/** The OAuth token set we seal. `expiry_date` is epoch-ms (google-auth-library's convention). */
export interface GmailTokenSet {
  refresh_token: string;
  access_token?: string;
  /** epoch-ms the access_token expires (NOT the refresh_token — that rots on Google's ~7d testing clock). */
  expiry_date?: number;
  /** epoch-ms the refresh_token was minted (age → expiring_soon). Set at consent, reset on re-auth. */
  issued_at?: number;
  scope?: string;
}

/** Token health — mirrors the email_accounts.token_state CHECK vocab in migration 002. */
export type TokenState = 'unauthorized' | 'healthy' | 'expiring_soon' | 'expired' | 'revoked';

/** Client credentials (user-supplied Google Cloud desktop-app id/secret; stored in settings.gmail). */
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  /** loopback redirect the ephemeral consent server listens on (the app fills the port at flow time). */
  redirectUri?: string;
}

const DAY_MS = 86_400_000;
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** The secrets-DAL key under which an account's sealed token set lives. One key per account. */
export function tokenSecretKey(accountId: string): string {
  return `gmail.token.${accountId}`;
}

/** Seal an account's token set (JSON) into the secrets table. `issued_at` defaults to now if absent. */
export function sealToken(dal: Dal, accountId: string, tokens: GmailTokenSet): void {
  const withIssued: GmailTokenSet = { ...tokens, issued_at: tokens.issued_at ?? dal.ctx.now() };
  dal.secrets.seal(tokenSecretKey(accountId), JSON.stringify(withIssued));
}

/** Open + parse an account's sealed token set, or undefined when there is none / it's corrupt. */
export function openToken(dal: Dal, accountId: string): GmailTokenSet | undefined {
  const raw = dal.secrets.open(tokenSecretKey(accountId));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as GmailTokenSet;
    if (typeof parsed?.refresh_token !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export interface TokenHealthInput {
  /** the sealed token set (undefined → never authorized). */
  tokens?: GmailTokenSet | undefined;
  /** epoch-ms now (injectable for deterministic tests). */
  now: number;
  /** day threshold at which a still-valid token flips to `expiring_soon` (default 5). */
  warnDays?: number;
  /** the last observed hard-failure kind from a refresh/API call, if any. */
  lastFailure?: 'invalid_grant' | 'revoked' | undefined;
}

/**
 * Compute token health from age + last outcome (plan §3.2 state machine). Precedence:
 *   no tokens                      → unauthorized
 *   lastFailure 'revoked'          → revoked   (user un-consented / insufficient-scope 403)
 *   lastFailure 'invalid_grant'    → expired   (the actual 7-day rot signal)
 *   age(issued_at) ≥ warnDays      → expiring_soon (proactive amber, before death)
 *   otherwise                      → healthy
 * Pure — no I/O — so the lifecycle simulation test can drive it with a fake clock.
 */
export function computeTokenState(input: TokenHealthInput): TokenState {
  const { tokens, now } = input;
  if (!tokens || !tokens.refresh_token) return 'unauthorized';
  if (input.lastFailure === 'revoked') return 'revoked';
  if (input.lastFailure === 'invalid_grant') return 'expired';
  const warnMs = (input.warnDays ?? 5) * DAY_MS;
  const issuedAt = tokens.issued_at ?? now;
  if (now - issuedAt >= warnMs) return 'expiring_soon';
  return 'healthy';
}

/** Age of the current refresh token in whole days (0 when unknown) — for the health chip tooltip. */
export function tokenAgeDays(tokens: GmailTokenSet | undefined, now: number): number {
  if (!tokens?.issued_at) return 0;
  return Math.max(0, Math.floor((now - tokens.issued_at) / DAY_MS));
}

/**
 * The real OAuth2 client factory (production only). Imports google-auth-library lazily so tests that
 * never touch the live path don't pull the module (and so this file type-checks with no top-level
 * dependency on the google types). Returns an OAuth2Client with the account's refresh token set, ready
 * for @googleapis/gmail to drive. NEVER called in tests — the gmail service takes an injected fake.
 */
export async function makeOAuthClient(config: OAuthClientConfig, tokens: GmailTokenSet): Promise<unknown> {
  const { OAuth2Client } = (await import('google-auth-library')) as {
    OAuth2Client: new (opts: { clientId: string; clientSecret: string; redirectUri?: string }) => {
      setCredentials(creds: { refresh_token?: string; access_token?: string; expiry_date?: number }): void;
    };
  };
  const client = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    ...(config.redirectUri ? { redirectUri: config.redirectUri } : {}),
  });
  client.setCredentials({
    refresh_token: tokens.refresh_token,
    ...(tokens.access_token ? { access_token: tokens.access_token } : {}),
    ...(tokens.expiry_date ? { expiry_date: tokens.expiry_date } : {}),
  });
  return client;
}
