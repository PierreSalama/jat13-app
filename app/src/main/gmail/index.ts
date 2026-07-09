// index.ts — the Gmail status service (Pillar 8). Wires the pure pieces (classify → match → statusMap)
// to the DAL and the fetch layer:
//   syncAccount(accountId): pull new messages since the account's watermark, upsert into the emails DAL,
//     classify + match each, and — for an auto/manual match — elevate the application forward-only
//     (categoryToStatus → applications.elevate, which the DAL guards). A low-confidence match is stored
//     as 'suggested' and waits for a human (never elevates). Token health is reported via
//     secrets.reportUse + email_accounts.token_state.
//   a scheduled tick — the cron EXPRESSION + a start/stop are exported, but main.ts wiring is NOT done
//     here (the orchestrator owns that).
//   gmailClientFactory is INJECTABLE so tests hand in a fake returning canned messages — there is no
//     live Gmail/OAuth in tests. The real factory (google-auth-library + @googleapis/gmail) is built
//     lazily from the sealed refresh token.
//
// The service reaches the DB through the DAL for everything it can; the few things the emails DAL does
// not expose (updating an account's sync cursor / token_state) go straight through dal.ctx.db — still
// the single main-process writer. No writes ever happen outside a DAL call or a parameterized statement.

import type { Hono } from 'hono';
import { Cron } from 'croner';
import type { Dal } from '../db/dal/index.js';
import { classifyEmail, type EmailCategory } from './classify.js';
import { categoryToStatus } from './statusMap.js';
import { makeMatcher, type MatchableEmail, type MatchResult } from './match.js';
import {
  computeTokenState,
  makeOAuthClient,
  openToken,
  type OAuthClientConfig,
  type TokenState,
} from './oauth.js';

// ---- the injectable fetch surface (fake in tests, google-backed in prod) --------------------------

/** A normalized message the service stores + classifies. The factory maps provider payloads to this. */
export interface FetchedMessage {
  providerMsgId: string;
  messageId?: string;
  threadId?: string;
  inReplyTo?: string;
  refIds?: string;
  fromAddr?: string;
  fromName?: string;
  toAddr?: string;
  subject?: string;
  snippet?: string;
  body?: string;
  /** epoch-ms the message was sent (Gmail internalDate). Drives the watermark + recency scoring. */
  sentAt?: number;
}

export interface ListMessagesOptions {
  /** the account's watermark — return only messages newer than this (epoch-ms). 0 = backfill. */
  sinceMs: number;
  /** query the pack/settings drive the fetch with (Gmail `q`). */
  query: string;
  /** hard cap on messages this call returns (mode-aware: backfill big, incremental small). */
  max: number;
}

/** The thin client the service drives. The real one wraps @googleapis/gmail; the fake returns canned. */
export interface GmailClient {
  listMessages(opts: ListMessagesOptions): Promise<FetchedMessage[]>;
}

/** Builds a client for an account. Injected → tests pass a fake; prod builds a google-backed one. */
export type GmailClientFactory = (accountId: string) => Promise<GmailClient>;

// ---- service deps + shape --------------------------------------------------------------------------

export interface GmailServiceDeps {
  dal: Dal;
  /** injected in tests; when absent, syncAccount throws a clear error (no live path is wired in tests). */
  gmailClientFactory?: GmailClientFactory;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface SyncSummary {
  accountId: string;
  mode: 'incremental' | 'backfill';
  scanned: number;
  stored: number;
  matched: number;
  suggested: number;
  elevated: number;
  tokenState: TokenState;
  error?: string;
}

export interface GmailService {
  /** pull + classify + match + elevate for one account; returns the run summary. */
  syncAccount(accountId: string, opts?: { backfill?: boolean }): Promise<SyncSummary>;
  /** cron expression the scheduler ticks on (derived from settings.gmail.syncMinutes). */
  cronExpression(): string;
  /** start the scheduled tick over all enabled accounts (does NOT wire main.ts). */
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

// The two thresholds v11 used (also in settings.inbox in the full build): high → auto, low → suggested.
const AUTO_THRESHOLD = 0.7;
const SUGGEST_THRESHOLD = 0.4;

// Mode-aware fetch caps (plan §4.3/§4.4): backfill pulls a wide window, incremental stays lean.
const BACKFILL_MAX = 1200;
const INCREMENTAL_MAX = 300;

export function makeGmailService(deps: GmailServiceDeps): GmailService {
  const { dal } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const db = dal.ctx.db;
  const matcher = makeMatcher(dal);

  let cron: Cron | null = null;
  let ticking = false;

  function gmailQuery(): string {
    return String(dal.settings.getKey('gmail', 'query'));
  }
  function syncMinutes(): number {
    const v = dal.settings.getKey('gmail', 'syncMinutes');
    return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 15;
  }

  /** cursor / token-state UPDATE for an account (parameterized; single-writer). */
  function updateAccount(
    accountId: string,
    fields: { watermarkMs?: number; historyId?: string; tokenState?: TokenState; authFailInc?: boolean; ok?: boolean },
  ): void {
    const sets: string[] = ['updated_at = @ts'];
    const bind: Record<string, unknown> = { id: accountId, ts: now() };
    if (fields.watermarkMs !== undefined) { sets.push('watermark_ms = @watermark'); bind.watermark = fields.watermarkMs; }
    if (fields.historyId !== undefined) { sets.push('history_id = @historyId'); bind.historyId = fields.historyId; }
    if (fields.tokenState !== undefined) { sets.push('token_state = @tokenState'); bind.tokenState = fields.tokenState; }
    if (fields.ok) { sets.push('last_ok_at = @ts', 'auth_fail_count = 0'); }
    else if (fields.authFailInc) { sets.push('auth_fail_count = auth_fail_count + 1'); }
    db.prepare(`UPDATE email_accounts SET ${sets.join(', ')} WHERE id = @id`).run(bind);
  }

  function accountWatermark(accountId: string): number {
    const row = db.prepare('SELECT watermark_ms FROM email_accounts WHERE id = ?').get(accountId) as
      | { watermark_ms: number }
      | undefined;
    return row?.watermark_ms ?? 0;
  }

  /** classify a stored email, persist the category (via the emails DAL upsert), and return it. */
  function classifyAndStore(accountId: string, msg: FetchedMessage): { emailId: string; category: EmailCategory } {
    const result = classifyEmail({ from: msg.fromAddr ?? '', subject: msg.subject ?? '', body: msg.body ?? '' });
    const up = dal.emails.upsert({
      accountId,
      providerMsgId: msg.providerMsgId,
      provider: 'gmail',
      ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
      ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
      ...(msg.inReplyTo !== undefined ? { inReplyTo: msg.inReplyTo } : {}),
      ...(msg.refIds !== undefined ? { refIds: msg.refIds } : {}),
      ...(msg.fromAddr !== undefined ? { fromAddr: msg.fromAddr } : {}),
      ...(msg.fromName !== undefined ? { fromName: msg.fromName } : {}),
      ...(msg.toAddr !== undefined ? { toAddr: msg.toAddr } : {}),
      ...(msg.subject !== undefined ? { subject: msg.subject } : {}),
      ...(msg.snippet !== undefined ? { snippet: msg.snippet } : {}),
      ...(msg.body !== undefined ? { body: msg.body } : {}),
      ...(msg.sentAt !== undefined ? { sentAt: msg.sentAt } : {}),
      category: result.category,
      classifiedBy: 'rules',
    });
    return { emailId: up.id, category: result.category };
  }

  /** Load a stored email into the matcher's shape (body included — it carries the ATS-id URLs). */
  function toMatchable(accountId: string, emailId: string): MatchableEmail {
    const row = db
      .prepare(
        `SELECT id, from_addr, from_name, subject, thread_id, in_reply_to, ref_ids, sent_at FROM emails WHERE id = ?`,
      )
      .get(emailId) as
      | {
          id: string;
          from_addr: string;
          from_name: string;
          subject: string;
          thread_id: string | null;
          in_reply_to: string | null;
          ref_ids: string | null;
          sent_at: number | null;
        }
      | undefined;
    const body = dal.emails.getBody(emailId) ?? '';
    return {
      id: emailId,
      accountId,
      fromAddr: row?.from_addr ?? '',
      fromName: row?.from_name ?? '',
      subject: row?.subject ?? '',
      body,
      threadId: row?.thread_id ?? null,
      inReplyTo: row?.in_reply_to ?? null,
      refIds: row?.ref_ids ?? null,
      sentAt: row?.sent_at ?? null,
    };
  }

  /**
   * Given a match + the email's category, write the match row and — for auto/manual — elevate the
   * application forward-only. Returns whether the email counted as matched / suggested / elevated.
   * The forward-only + terminal guards live in applications.elevate; we call it UNCONDITIONALLY on
   * every auto match (E4 idempotency) and swallow the DAL's backward/terminal refusal as a no-op.
   */
  function applyMatch(
    emailId: string,
    category: EmailCategory,
    m: MatchResult,
    subject: string,
  ): { matched: boolean; suggested: boolean; elevated: boolean } {
    if (!m.jobId || m.via === 'none') return { matched: false, suggested: false, elevated: false };

    const source: 'auto' | 'suggested' = m.confidence >= AUTO_THRESHOLD ? 'auto' : 'suggested';
    if (source === 'suggested' && m.confidence < SUGGEST_THRESHOLD) {
      // too weak even to suggest — record nothing (leaves the email unmatched).
      return { matched: false, suggested: false, elevated: false };
    }

    const via = m.via === 'thread' ? 'thread' : m.via === 'ats_id' ? 'ats_id' : 'score';
    const effective = dal.emails.setMatch(emailId, {
      ...(m.applicationId !== undefined ? { applicationId: m.applicationId } : {}),
      jobId: m.jobId,
      confidence: m.confidence,
      source,
      matchVia: via,
    });

    let elevated = false;
    // only an auto/manual match may move a status; suggested waits for a human confirm.
    if ((effective.source === 'auto' || effective.source === 'manual') && effective.application_id) {
      const target = categoryToStatus(category);
      if (target) {
        const before = dal.applications.get(effective.application_id);
        try {
          const after = dal.applications.elevate(effective.application_id, target, 'auto');
          if (before && after.status !== before.status) {
            elevated = true;
            dal.events.record({
              kind: 'status_change',
              applicationId: effective.application_id,
              jobId: m.jobId,
              emailId,
              source: 'inbox',
              summary: `${before.status} → ${after.status}`,
              data: { from: before.status, to: after.status, emailId, subject: subject.slice(0, 200) },
            });
          }
        } catch {
          // forward-only / terminal guard refused the move — a legitimate no-op (E4). Nothing to record.
        }
      }
      // an email that matched a job but did not (or could not) elevate still deserves a timeline row.
      if (!elevated) {
        dal.events.record({
          kind: 'email_matched',
          applicationId: effective.application_id,
          jobId: m.jobId,
          emailId,
          source: 'inbox',
          summary: `${category} email matched`,
          data: { category, emailId, subject: subject.slice(0, 200), via },
        });
      }
    }

    return {
      matched: effective.source === 'auto' || effective.source === 'manual',
      suggested: effective.source === 'suggested',
      elevated,
    };
  }

  async function syncAccount(accountId: string, opts: { backfill?: boolean } = {}): Promise<SyncSummary> {
    const factory = deps.gmailClientFactory;
    if (!factory) throw new Error('gmail: no gmailClientFactory injected — cannot sync');

    const backfill = opts.backfill ?? false;
    const mode: SyncSummary['mode'] = backfill ? 'backfill' : 'incremental';
    const tokens = openToken(dal, accountId);
    const summary: SyncSummary = {
      accountId,
      mode,
      scanned: 0,
      stored: 0,
      matched: 0,
      suggested: 0,
      elevated: 0,
      tokenState: computeTokenState({ tokens, now: now() }),
    };

    let client: GmailClient;
    try {
      client = await factory(accountId);
    } catch (e) {
      const err = e as { message?: string };
      summary.error = err.message ?? 'client_factory_failed';
      return summary;
    }

    const sinceMs = backfill ? 0 : accountWatermark(accountId);
    let messages: FetchedMessage[];
    try {
      messages = await client.listMessages({ sinceMs, query: gmailQuery(), max: backfill ? BACKFILL_MAX : INCREMENTAL_MAX });
    } catch (e) {
      // A hard failure here is the token-rot / quota signal. Classify it onto the health surface.
      // invalid_grant is the DEFINITIVE 7-day-rot signal (Google returns it with a "expired or revoked"
      // message), so it takes precedence over an incidental "revoked" substring; only a genuine
      // consent-withdrawal / insufficient-scope 403 (no invalid_grant) is treated as revoked.
      const err = e as { message?: string; code?: string };
      const msg = err.message ?? '';
      const invalidGrant = /invalid_grant/i.test(msg) || err.code === 'invalid_grant';
      const revoked = !invalidGrant && (/insufficient|forbidden|access_denied|unauthorized_client/i.test(msg) || err.code === 'revoked');
      const reason: 'revoked' | 'expired' = revoked ? 'revoked' : 'expired';
      dal.secrets.reportUse(`gmail.token.${accountId}`, false, { reason, error: err.message ?? 'sync_failed' });
      const nextState: TokenState = revoked ? 'revoked' : invalidGrant ? 'expired' : summary.tokenState;
      updateAccount(accountId, { tokenState: nextState, authFailInc: true });
      summary.error = err.message ?? 'sync_failed';
      summary.tokenState = nextState;
      log(`gmail sync ${accountId} failed: ${summary.error}`);
      return summary;
    }

    let maxSent = sinceMs;
    for (const msg of messages) {
      summary.scanned += 1;
      const existedBefore = db
        .prepare('SELECT 1 FROM emails WHERE account_id = ? AND provider_msg_id = ?')
        .get(accountId, msg.providerMsgId) as unknown;
      const { emailId, category } = classifyAndStore(accountId, msg);
      if (!existedBefore) summary.stored += 1;

      const m = matcher.match(toMatchable(accountId, emailId));
      const outcome = applyMatch(emailId, category, m, msg.subject ?? '');
      if (outcome.matched) summary.matched += 1;
      if (outcome.suggested) summary.suggested += 1;
      if (outcome.elevated) summary.elevated += 1;

      if (msg.sentAt !== undefined && msg.sentAt > maxSent) maxSent = msg.sentAt;
    }

    // Success: advance the watermark past everything we stored, mark the token healthy again.
    if (maxSent > sinceMs) updateAccount(accountId, { watermarkMs: maxSent, ok: true });
    else updateAccount(accountId, { ok: true });
    dal.secrets.reportUse(`gmail.token.${accountId}`, true);
    const freshTokens = openToken(dal, accountId);
    summary.tokenState = computeTokenState({ tokens: freshTokens, now: now() });
    updateAccount(accountId, { tokenState: summary.tokenState });

    log(
      `gmail sync ${accountId} [${mode}] scanned=${summary.scanned} stored=${summary.stored} matched=${summary.matched} elevated=${summary.elevated}`,
    );
    return summary;
  }

  /** the cron expression for the scheduled tick — every N minutes (croner "every N minutes" form). */
  function cronExpression(): string {
    return `*/${syncMinutes()} * * * *`;
  }

  async function tickAll(): Promise<void> {
    if (ticking) return; // one tick at a time (module mutex, as v11)
    ticking = true;
    try {
      const accounts = dal.emails.listAccounts().filter((a) => a.enabled === 1 && a.kind === 'gmail_oauth');
      for (const a of accounts) {
        try {
          await syncAccount(a.id);
        } catch (e) {
          log(`gmail tick ${a.id} error: ${(e as { message?: string }).message ?? e}`);
        }
      }
    } finally {
      ticking = false;
    }
  }

  function start(): void {
    if (cron) return;
    cron = new Cron(cronExpression(), { name: 'gmail.sync', protect: true }, () => {
      void tickAll();
    });
  }
  function stop(): void {
    cron?.stop();
    cron = null;
  }
  function isRunning(): boolean {
    return cron !== null;
  }

  return { syncAccount, cronExpression, start, stop, isRunning };
}

// ---- production client factory (google-auth-library + @googleapis/gmail) ---------------------------

/** Minimal shape of the @googleapis/gmail v1 client we drive (typed locally to avoid the huge dep types). */
interface GmailApiClient {
  users: {
    messages: {
      list(params: { userId: string; q: string; maxResults: number }): Promise<{ data: { messages?: { id?: string | null }[] } }>;
      get(params: { userId: string; id: string; format: string }): Promise<{ data: GmailApiMessage }>;
    };
  };
}
interface GmailApiMessage {
  id?: string | null;
  threadId?: string | null;
  internalDate?: string | null;
  snippet?: string | null;
  payload?: { headers?: { name?: string | null; value?: string | null }[]; parts?: unknown[]; body?: { data?: string | null } };
}

/** header lookup (case-insensitive) from a Gmail payload. */
function header(msg: GmailApiMessage, name: string): string {
  const h = msg.payload?.headers?.find((x) => (x.name ?? '').toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

/** parse "Name <addr@x>" into {name, addr}. */
function parseFrom(v: string): { name: string; addr: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(v);
  if (m) return { name: (m[1] ?? '').replace(/^"|"$/g, ''), addr: m[2] ?? '' };
  return { name: '', addr: v.trim() };
}

/**
 * Build the REAL client factory: for each account, open the sealed refresh token, construct an
 * OAuth2 client + gmail API, and expose listMessages that maps Gmail payloads to FetchedMessage. This
 * is the production path — the orchestrator injects it into makeGmailService. Tests never call it (they
 * inject a fake). It imports @googleapis/gmail lazily so the module type-checks without the huge types.
 */
export function makeGmailClientFactory(dal: Dal): GmailClientFactory {
  return async (accountId: string): Promise<GmailClient> => {
    const tokens = openToken(dal, accountId);
    if (!tokens) throw new Error(`invalid_grant: no sealed token for account ${accountId}`);
    // Client credentials (Google Cloud desktop-app id/secret) live sealed in the secrets DAL, not in
    // settings — they are a credential, and settings.gmail only registers query/syncMinutes. The consent
    // flow (the app's job) seals them under these keys before this factory is ever used.
    const cfg: OAuthClientConfig = {
      clientId: dal.secrets.open('gmail.clientId') ?? '',
      clientSecret: dal.secrets.open('gmail.clientSecret') ?? '',
    };
    const authClient = await makeOAuthClient(cfg, tokens);
    const { gmail } = (await import('@googleapis/gmail')) as {
      gmail: (opts: { version: 'v1'; auth: unknown }) => GmailApiClient;
    };
    const api = gmail({ version: 'v1', auth: authClient });

    return {
      async listMessages({ sinceMs, query, max }): Promise<FetchedMessage[]> {
        // Gmail `after:` is second-granularity; add the watermark as an `after:` clamp so we don't
        // re-fetch the whole query window every tick (dedup in the DAL still guards double-stores).
        const afterSec = sinceMs > 0 ? ` after:${Math.floor(sinceMs / 1000)}` : '';
        const listed = await api.users.messages.list({ userId: 'me', q: `${query}${afterSec}`, maxResults: max });
        const out: FetchedMessage[] = [];
        for (const ref of listed.data.messages ?? []) {
          if (!ref.id) continue;
          const full = await api.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
          const m = full.data;
          const from = parseFrom(header(m, 'From'));
          const bodyData = m.payload?.body?.data ?? '';
          const body = bodyData ? Buffer.from(bodyData, 'base64url').toString('utf8') : (m.snippet ?? '');
          const messageId = header(m, 'Message-ID');
          const inReplyTo = header(m, 'In-Reply-To');
          const refIds = header(m, 'References');
          const toAddr = header(m, 'To');
          const subject = header(m, 'Subject');
          // exactOptionalPropertyTypes: only set an optional key when we actually have a value.
          const fetched: FetchedMessage = {
            providerMsgId: m.id ?? ref.id,
            fromAddr: from.addr,
            fromName: from.name,
            body,
          };
          if (messageId) fetched.messageId = messageId;
          if (m.threadId) fetched.threadId = m.threadId;
          if (inReplyTo) fetched.inReplyTo = inReplyTo;
          if (refIds) fetched.refIds = refIds;
          if (toAddr) fetched.toAddr = toAddr;
          if (subject) fetched.subject = subject;
          if (m.snippet) fetched.snippet = m.snippet;
          if (m.internalDate) fetched.sentAt = Number(m.internalDate);
          out.push(fetched);
        }
        return out;
      },
    };
  };
}

// ---- API mounting ----------------------------------------------------------------------------------

/**
 * Mount the inbox status/sync routes onto the protected `/api` router (the orchestrator passes the same
 * Hono app the REST API uses AFTER its auth middleware, so these inherit the X-JAT13-Token gate).
 *   GET  /gmail/status        → per-account health + last cursor (NO bodies, NO lists — payload discipline)
 *   POST /gmail/sync          → {accountId?, backfill?} run a sync now; returns the run summary
 */
export function mountGmailApi(api: Hono, service: GmailService, dal: Dal): void {
  api.get('/gmail/status', (c) => {
    const accounts = dal.emails.listAccounts().map((a) => ({
      id: a.id,
      email: a.email,
      kind: a.kind,
      enabled: a.enabled === 1,
      tokenState: a.token_state,
      lastOkAt: a.last_ok_at,
    }));
    return c.json({ accounts, cron: service.cronExpression(), running: service.isRunning() });
  });

  api.post('/gmail/sync', async (c) => {
    let payload: { accountId?: string; backfill?: boolean } = {};
    try {
      payload = (await c.req.json()) as typeof payload;
    } catch {
      /* empty body → sync the first Gmail account */
    }
    const accountId =
      payload.accountId ?? dal.emails.listAccounts().find((a) => a.kind === 'gmail_oauth')?.id;
    if (!accountId) return c.json({ error: 'no_account' }, 400);
    try {
      const summary = await service.syncAccount(accountId, { backfill: payload.backfill ?? false });
      return c.json(summary);
    } catch (e) {
      return c.json({ error: (e as { message?: string }).message ?? 'sync_failed' }, 400);
    }
  });
}
