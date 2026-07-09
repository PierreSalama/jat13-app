// Gmail CONNECT flow + v11 credential MIGRATION tests (Pillar 8). No live Google is touched: we assert
// buildAuthUrl's query params (pure) and drive migrateGmailCredentials against SYNTHETIC v11 jat.db
// files (real v11 settings/kv shape) through the real DAL + a FakeSealer. Verifies the sealed-key
// convention matches makeGmailClientFactory (gmail.clientId / gmail.clientSecret / gmail.token.<id>),
// the account row flips healthy, gmail.query carries over, and every no-op path (no consent, no Gmail,
// sealed-without-unsealer) leaves the v13 db untouched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as DB } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { buildAuthUrl } from '../../app/src/main/gmail/connect.js';
import { migrateGmailCredentials } from '../../app/src/main/importer/gmail-creds.js';
import {
  openToken,
  GMAIL_CLIENT_ID_KEY,
  GMAIL_CLIENT_SECRET_KEY,
  GMAIL_READONLY_SCOPE,
} from '../../app/src/main/gmail/oauth.js';

const T = 1_700_000_000_000;

const fakeSealer: Sealer = {
  available: () => true,
  seal: (p) => Buffer.from(p),
  open: (b) => Buffer.from(b).toString(),
};

// ---- synthetic v11 jat.db (real v11 shape: settings(section PK, value) + kv(key PK, value)) --------

interface V11Fixture {
  /** the gmail settings blob (JSON-stored under settings.section='gmail'); null → no gmail row. */
  gmail?: Record<string, unknown> | null;
  /** the kv 'gmailTokens' blob; null → no kv row (or omit the kv table entirely). */
  gmailTokens?: Record<string, unknown> | null;
  /** when false, don't create the settings table at all. */
  withSettings?: boolean;
}

function buildV11Db(path: string, fx: V11Fixture): void {
  const db = new Database(path);
  db.pragma('user_version = 15');
  if (fx.withSettings !== false) {
    db.exec('CREATE TABLE settings (section TEXT PRIMARY KEY, value TEXT NOT NULL);');
    // an unrelated section always present, so "no gmail" is distinguishable from "no settings".
    db.prepare('INSERT INTO settings (section, value) VALUES (?, ?)').run('appearance', JSON.stringify({ theme: 'atelier' }));
    if (fx.gmail) {
      db.prepare('INSERT INTO settings (section, value) VALUES (?, ?)').run('gmail', JSON.stringify(fx.gmail));
    }
  }
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);');
  if (fx.gmailTokens) {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('gmailTokens', JSON.stringify(fx.gmailTokens));
  }
  db.close();
}

// ---- buildAuthUrl (pure) ---------------------------------------------------------------------------

describe('buildAuthUrl', () => {
  it('includes the loopback desktop-flow params (offline + consent + gmail.readonly)', () => {
    const url = buildAuthUrl({ clientId: 'cid-123.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:54321/callback', state: 'nonce-abc' });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = parsed.searchParams;
    expect(p.get('client_id')).toBe('cid-123.apps.googleusercontent.com');
    expect(p.get('redirect_uri')).toBe('http://127.0.0.1:54321/callback');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe(GMAIL_READONLY_SCOPE);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('state')).toBe('nonce-abc');
  });

  it('defaults the scope to gmail.readonly and omits state when not given', () => {
    const url = buildAuthUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1:1/callback' });
    const p = new URL(url).searchParams;
    expect(p.get('scope')).toBe(GMAIL_READONLY_SCOPE);
    expect(p.has('state')).toBe(false);
  });
});

// ---- migrateGmailCredentials -----------------------------------------------------------------------

describe('migrateGmailCredentials', () => {
  let dir: string;
  let db: DB;
  let dal: Dal;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jat-gmailcreds-'));
    ({ db } = openDatabase({ file: ':memory:' }));
    dal = makeDal(defaultContext(db, () => {}), { sealer: fakeSealer });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const GMAIL = {
    clientId: 'client-abc.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-secret-xyz',
    query: 'from:jobs-noreply@linkedin.com OR "your application" OR "we regret to inform"',
    email: 'Pierre@Gmail.com',
    enabled: true,
  };

  it('carries clientId/secret + refresh token (kv) into a healthy v13 account + sealed secrets + settings', () => {
    const src = join(dir, 'jat.db');
    buildV11Db(src, { gmail: GMAIL, gmailTokens: { access_token: 'at-1', refresh_token: 'rt-REAL', expires_at: T + 3_600_000 } });

    const res = migrateGmailCredentials(db, src, { dal, now: () => T }, { consent: true });
    expect(res).toEqual({ migrated: true, accountId: 'acct_v11_gmail', email: 'pierre@gmail.com' });

    // account row created + healthy
    const acct = db.prepare('SELECT kind, email, enabled, token_state FROM email_accounts WHERE id = ?').get('acct_v11_gmail') as
      | { kind: string; email: string; enabled: number; token_state: string }
      | undefined;
    expect(acct?.kind).toBe('gmail_oauth');
    expect(acct?.email).toBe('pierre@gmail.com');
    expect(acct?.enabled).toBe(1);
    expect(acct?.token_state).toBe('healthy');

    // client creds sealed under the EXACT keys makeGmailClientFactory reads
    expect(dal.secrets.open(GMAIL_CLIENT_ID_KEY)).toBe(GMAIL.clientId);
    expect(dal.secrets.open(GMAIL_CLIENT_SECRET_KEY)).toBe(GMAIL.clientSecret);

    // refresh-token set sealed under gmail.token.<accountId> (openToken is what the factory uses)
    const tok = openToken(dal, 'acct_v11_gmail');
    expect(tok?.refresh_token).toBe('rt-REAL');
    expect(tok?.access_token).toBe('at-1');
    expect(tok?.expiry_date).toBe(T + 3_600_000);
    expect(tok?.issued_at).toBe(T);

    // the broad v11 query carried into the registered, non-secret setting
    expect(dal.settings.getKey('gmail', 'query')).toBe(GMAIL.query);
  });

  it('accepts a refresh token embedded directly in the gmail settings blob (no kv row)', () => {
    const src = join(dir, 'jat.db');
    buildV11Db(src, { gmail: { ...GMAIL, refresh_token: 'rt-EMBEDDED' } });

    const res = migrateGmailCredentials(db, src, { dal, now: () => T }, { consent: true });
    expect(res.migrated).toBe(true);
    expect(openToken(dal, 'acct_v11_gmail')?.refresh_token).toBe('rt-EMBEDDED');
  });

  it('no-ops when the v11 db has no Gmail section (nothing written to v13)', () => {
    const src = join(dir, 'jat.db');
    buildV11Db(src, { gmail: null });

    const res = migrateGmailCredentials(db, src, { dal }, { consent: true });
    expect(res).toEqual({ migrated: false, reason: 'no_gmail_settings' });
    expect(dal.emails.listAccounts()).toHaveLength(0);
    expect(dal.secrets.open(GMAIL_CLIENT_ID_KEY)).toBeUndefined();
  });

  it('no-ops (not_consented) unless the consent flag is set — even with valid v11 creds', () => {
    const src = join(dir, 'jat.db');
    buildV11Db(src, { gmail: GMAIL, gmailTokens: { refresh_token: 'rt-REAL' } });

    const off = migrateGmailCredentials(db, src, { dal }); // consent defaults false
    expect(off).toEqual({ migrated: false, reason: 'not_consented' });
    expect(dal.emails.listAccounts()).toHaveLength(0);

    const explicitOff = migrateGmailCredentials(db, src, { dal }, { consent: false });
    expect(explicitOff.reason).toBe('not_consented');
  });

  it('no-ops (no_refresh_token) when creds exist but no refresh token is present', () => {
    const src = join(dir, 'jat.db');
    buildV11Db(src, { gmail: GMAIL, gmailTokens: { access_token: 'at-only' } });

    const res = migrateGmailCredentials(db, src, { dal }, { consent: true });
    expect(res).toEqual({ migrated: false, reason: 'no_refresh_token' });
    expect(dal.emails.listAccounts()).toHaveLength(0);
  });

  it('treats a v11-sealed clientSecret as unreadable without an unsealer, then migrates once given one', () => {
    const src = join(dir, 'jat.db');
    buildV11Db(src, {
      gmail: { ...GMAIL, clientSecret: 'enc:v1:U0VBTEVE' }, // enc:v1: tag → sealed
      gmailTokens: { refresh_token: 'rt-REAL' },
    });

    // no unsealer → clean no-op, nothing stored
    const blocked = migrateGmailCredentials(db, src, { dal }, { consent: true });
    expect(blocked).toEqual({ migrated: false, reason: 'sealed_no_unsealer' });
    expect(dal.secrets.open(GMAIL_CLIENT_SECRET_KEY)).toBeUndefined();

    // production-style unsealer (strip the tag, "decrypt") → migrates
    const unsealV11 = (s: string): string => (s.startsWith('enc:v1:') ? `plain-${s.slice('enc:v1:'.length)}` : s);
    const ok = migrateGmailCredentials(db, src, { dal, unsealV11 }, { consent: true });
    expect(ok.migrated).toBe(true);
    expect(dal.secrets.open(GMAIL_CLIENT_SECRET_KEY)).toBe('plain-U0VBTEVE');
  });

  it('is idempotent — a second run creates no new account or secret rows', () => {
    const src = join(dir, 'jat.db');
    buildV11Db(src, { gmail: GMAIL, gmailTokens: { refresh_token: 'rt-REAL' } });

    migrateGmailCredentials(db, src, { dal, now: () => T }, { consent: true });
    const after1 = {
      accounts: (db.prepare('SELECT COUNT(*) c FROM email_accounts').get() as { c: number }).c,
      secrets: (db.prepare('SELECT COUNT(*) c FROM secrets').get() as { c: number }).c,
    };
    const res2 = migrateGmailCredentials(db, src, { dal, now: () => T }, { consent: true });
    expect(res2.migrated).toBe(true);
    const after2 = {
      accounts: (db.prepare('SELECT COUNT(*) c FROM email_accounts').get() as { c: number }).c,
      secrets: (db.prepare('SELECT COUNT(*) c FROM secrets').get() as { c: number }).c,
    };
    expect(after2).toEqual(after1);
    expect(after1.accounts).toBe(1);
    expect(after1.secrets).toBe(3); // gmail.clientId, gmail.clientSecret, gmail.token.acct_v11_gmail
  });
});
