// connect.ts — the live Gmail OAuth CONNECT flow (Pillar 8, the app's job that oauth.ts deliberately
// left out). A user-supplied Google Cloud DESKTOP-app client (clientId/clientSecret) authorizes the
// gmail.readonly scope through a loopback redirect:
//
//   1. stand up a THROWAWAY http server on 127.0.0.1:<ephemeral> as the OAuth redirect target,
//   2. open the consent page in the user's real browser (shell.openExternal),
//   3. capture ?code on the loopback callback, exchange it at Google's TOKEN_URL for a
//      {refresh_token, access_token} set (access_type=offline + prompt=consent ⇒ Google always
//      returns a refresh_token),
//   4. read the account's address from the Gmail profile,
//   5. persist: an email_accounts row (kind 'gmail_oauth'), the sealed client creds, and the sealed
//      refresh-token set (under gmail.token.<accountId> — the SAME key makeGmailClientFactory reads),
//      then flip token_state → 'healthy'.
//
// Everything network/browser is injectable (openExternal, fetchFn) so nothing here needs a live Google
// to type-check; the required test only exercises the pure buildAuthUrl. Ported from v11 app/src/gmail.js
// startAuth (loopback + state + the exact query params), re-homed onto the v13 DAL + secrets.

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Hono } from 'hono';
import type { Dal } from '../db/dal/index.js';
import {
  GMAIL_READONLY_SCOPE,
  openClientCredentials,
  sealClientCredentials,
  sealToken,
  type GmailTokenSet,
} from './oauth.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

const DEFAULT_TIMEOUT_MS = 300_000; // 5 min — matches v11.

const SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>JAT connected</title>' +
  '<body style="font-family:system-ui,sans-serif;background:#0a0e1a;color:#e8eefc;display:grid;place-items:center;height:100vh;margin:0">' +
  '<div style="text-align:center"><h2>Gmail connected to JAT 13 ✓</h2><p>You can close this tab and return to the app.</p></div>';

// ---- typed refusals (the UI renders `code`) --------------------------------------------------------

export type GmailConnectErrorCode =
  | 'missing_credentials'
  | 'consent_denied'
  | 'timeout'
  | 'token_exchange_failed'
  | 'no_refresh_token'
  | 'seal_unavailable';

export class GmailConnectError extends Error {
  readonly code: GmailConnectErrorCode;
  constructor(code: GmailConnectErrorCode, message: string) {
    super(message);
    this.name = 'GmailConnectError';
    this.code = code;
  }
}

// ---- buildAuthUrl (pure) ---------------------------------------------------------------------------

export interface BuildAuthUrlParams {
  clientId: string;
  redirectUri: string;
  /** default: [gmail.readonly]. */
  scopes?: string[];
  /** CSRF nonce echoed back on the callback; include it when you have one. */
  state?: string;
  /** pre-fill the Google account chooser (optional). */
  loginHint?: string;
}

/**
 * Build the Google consent URL for the desktop loopback flow. access_type=offline + prompt=consent are
 * REQUIRED — they are what make Google mint (and re-mint) a refresh_token instead of only an access token.
 */
export function buildAuthUrl(params: BuildAuthUrlParams): string {
  const scopes = params.scopes && params.scopes.length ? params.scopes : [GMAIL_READONLY_SCOPE];
  const qs = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  if (params.state) qs.set('state', params.state);
  if (params.loginHint) qs.set('login_hint', params.loginHint);
  return `${AUTH_URL}?${qs.toString()}`;
}

// ---- startConnect (the live flow) ------------------------------------------------------------------

export interface StartConnectDeps {
  dal: Dal;
  /** open a URL in the user's real browser (electron shell.openExternal in prod). */
  openExternal: (url: string) => void | Promise<void>;
  /** user-supplied Google Cloud desktop-app credentials. */
  clientId: string;
  clientSecret: string;
  /** default: [gmail.readonly]. */
  scopes?: string[];
  /** how long to wait for the user to finish consent before giving up (default 5 min). */
  timeoutMs?: number;
  /** injectable clock + fetch for determinism (default Date.now / global fetch). */
  now?: () => number;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
}

export interface ConnectResult {
  accountId: string;
  email: string;
}

interface TokenExchangeBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Live-ish status the GET /gmail/connect/status route surfaces (last outcome + in-flight flag). */
interface ConnectStatusState {
  connecting: boolean;
  startedAt?: number;
  lastConnectedEmail?: string;
  lastConnectedAt?: number;
  lastError?: string;
}
let statusState: ConnectStatusState = { connecting: false };

export async function startConnect(deps: StartConnectDeps): Promise<ConnectResult> {
  const { dal, openExternal } = deps;
  const clientId = (deps.clientId ?? '').trim();
  const clientSecret = (deps.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new GmailConnectError(
      'missing_credentials',
      'Add your Google OAuth desktop-app clientId and clientSecret first (Google Cloud Console → Credentials → OAuth client ID → Desktop app, with the gmail.readonly scope).',
    );
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const scopes = deps.scopes && deps.scopes.length ? deps.scopes : [GMAIL_READONLY_SCOPE];
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = deps.log ?? (() => {});
  const state = randomBytes(16).toString('hex');

  const { server, port } = await listenLoopback();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  statusState = { connecting: true, startedAt: now() };

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        closeServer(server);
        reject(new GmailConnectError('timeout', 'Gmail authorization timed out after 5 minutes. Try Connect again.'));
      }, timeoutMs);

      server.on('request', (req, res) => {
        try {
          const u = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (u.pathname !== '/callback') {
            res.writeHead(404, { connection: 'close' });
            res.end();
            return;
          }
          const err = u.searchParams.get('error');
          const gotCode = u.searchParams.get('code');
          const gotState = u.searchParams.get('state');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
          res.end(SUCCESS_HTML);
          clearTimeout(timer);
          closeServer(server);
          if (err) return reject(new GmailConnectError('consent_denied', `Gmail authorization was denied (${err}).`));
          if (!gotCode || gotState !== state) {
            return reject(new GmailConnectError('consent_denied', 'Gmail authorization was cancelled or the state did not match.'));
          }
          resolve(gotCode);
        } catch (e) {
          clearTimeout(timer);
          closeServer(server);
          reject(e as Error);
        }
      });

      // Arm the listener FIRST, then send the user to the consent page.
      const url = buildAuthUrl({ clientId, redirectUri, scopes, state });
      Promise.resolve(openExternal(url)).catch((e) =>
        log(`openExternal failed (${(e as Error).message}); open manually: ${url}`),
      );
    });

    // Exchange the authorization code for tokens.
    const tokenRes = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const body = (await tokenRes.json()) as TokenExchangeBody;
    if (!tokenRes.ok || !body.access_token) {
      throw new GmailConnectError(
        'token_exchange_failed',
        body.error_description ?? body.error ?? `Gmail token exchange failed (HTTP ${tokenRes.status}).`,
      );
    }
    if (!body.refresh_token) {
      throw new GmailConnectError(
        'no_refresh_token',
        'Google did not return a refresh token. Revoke JAT at myaccount.google.com/permissions and Connect again (needs offline access + a fresh consent).',
      );
    }

    const email = await fetchProfileEmail(fetchFn, body.access_token, log);

    // Persist. ensureAccount dedups by (kind,email); the client creds + refresh token seal into secrets.
    const account = dal.emails.ensureAccount({ kind: 'gmail_oauth', email });
    const tokens: GmailTokenSet = {
      refresh_token: body.refresh_token,
      access_token: body.access_token,
      issued_at: now(),
    };
    if (typeof body.expires_in === 'number') tokens.expiry_date = now() + body.expires_in * 1000;
    if (body.scope) tokens.scope = body.scope;
    try {
      sealClientCredentials(dal, clientId, clientSecret);
      sealToken(dal, account.id, tokens);
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (/Sealer unavailable/i.test(msg)) {
        throw new GmailConnectError('seal_unavailable', 'This machine cannot encrypt secrets at rest (OS keychain unavailable), so JAT refuses to store your Gmail token in plaintext.');
      }
      throw e;
    }
    markAccountHealthy(dal, account.id, now());

    statusState = { connecting: false, lastConnectedEmail: email, lastConnectedAt: now() };
    log(`gmail connected: ${email || '(unknown address)'} (${account.id})`);
    return { accountId: account.id, email };
  } catch (e) {
    closeServer(server);
    statusState = { connecting: false, lastError: (e as Error).message };
    throw e;
  }
}

/** Snapshot for GET /gmail/connect/status — the in-flight flag + last outcome + the gmail accounts' health. */
export function getConnectStatus(dal: Dal): {
  connecting: boolean;
  lastConnectedEmail?: string;
  lastConnectedAt?: number;
  lastError?: string;
  accounts: { id: string; email: string; tokenState: string; enabled: boolean; lastOkAt: number | null }[];
} {
  const accounts = dal.emails
    .listAccounts()
    .filter((a) => a.kind === 'gmail_oauth')
    .map((a) => ({ id: a.id, email: a.email, tokenState: a.token_state, enabled: a.enabled === 1, lastOkAt: a.last_ok_at }));
  return {
    connecting: statusState.connecting,
    ...(statusState.lastConnectedEmail !== undefined ? { lastConnectedEmail: statusState.lastConnectedEmail } : {}),
    ...(statusState.lastConnectedAt !== undefined ? { lastConnectedAt: statusState.lastConnectedAt } : {}),
    ...(statusState.lastError !== undefined ? { lastError: statusState.lastError } : {}),
    accounts,
  };
}

// ---- API mounting ----------------------------------------------------------------------------------

export interface GmailConnectApiDeps {
  openExternal: (url: string) => void | Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Mount the connect routes onto the AUTHED `/api` sub-app (alongside mountGmailApi):
 *   POST /gmail/connect/start  → {clientId?, clientSecret?} (falls back to the sealed creds). Kicks the
 *      loopback consent flow off in the BACKGROUND and returns immediately — the flow can take minutes,
 *      so the client polls status rather than holding the request open. Returns 400 with a typed `code`
 *      when creds are absent.
 *   GET  /gmail/connect/status → the in-flight flag + last outcome + the gmail accounts' health.
 */
export function mountGmailConnectApi(api: Hono, dal: Dal, deps: GmailConnectApiDeps): void {
  const log = deps.log ?? (() => {});

  api.post('/gmail/connect/start', async (c) => {
    let body: { clientId?: string; clientSecret?: string } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      /* empty body → fall back to the previously-sealed creds */
    }
    const sealed = openClientCredentials(dal);
    const clientId = (body.clientId ?? sealed.clientId ?? '').trim();
    const clientSecret = (body.clientSecret ?? sealed.clientSecret ?? '').trim();
    if (!clientId || !clientSecret) {
      return c.json(
        { error: 'missing_credentials', message: 'Add your Google OAuth desktop-app clientId + clientSecret first.' },
        400,
      );
    }
    // Fire-and-forget: startConnect updates the module status the /status route reports.
    void startConnect({ dal, openExternal: deps.openExternal, clientId, clientSecret, log }).catch((e) =>
      log(`gmail connect failed: ${(e as Error).message}`),
    );
    return c.json({ started: true, connecting: true });
  });

  api.get('/gmail/connect/status', (c) => c.json(getConnectStatus(dal)));
}

// ---- helpers ---------------------------------------------------------------------------------------

/** Bind a throwaway http server to an ephemeral loopback port; resolve once it's listening. */
function listenLoopback(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr || typeof addr === 'string') {
        closeServer(server);
        reject(new Error('failed to bind a loopback port for the Gmail redirect'));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: Server): void {
  try {
    server.close();
  } catch {
    /* already closed */
  }
}

/** Read the connected mailbox address from the Gmail profile. Best-effort — a transient failure here
 *  must not waste the consent, so we fall back to '' (the email_accounts.email column allows empty). */
async function fetchProfileEmail(fetchFn: typeof fetch, accessToken: string, log: (m: string) => void): Promise<string> {
  try {
    const res = await fetchFn(PROFILE_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      log(`gmail profile lookup failed (HTTP ${res.status}) — connecting without an address`);
      return '';
    }
    const body = (await res.json()) as { emailAddress?: string };
    return (body.emailAddress ?? '').trim().toLowerCase();
  } catch (e) {
    log(`gmail profile lookup errored (${(e as Error).message}) — connecting without an address`);
    return '';
  }
}

/** Flip a freshly-sealed account to healthy (single-writer main-process UPDATE, mirrors index.ts). */
function markAccountHealthy(dal: Dal, accountId: string, nowMs: number): void {
  dal.ctx.db
    .prepare('UPDATE email_accounts SET token_state = ?, auth_fail_count = 0, last_ok_at = ?, updated_at = ? WHERE id = ?')
    .run('healthy', nowMs, nowMs, accountId);
}
