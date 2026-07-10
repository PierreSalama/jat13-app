// emails DAL — inbox rows + the email→application match. The pipeline rule (v11.48/64 scars) is
// enforced HERE: a manual or dismissed match is never clobbered by an auto/suggested one, and only
// auto/manual matches are allowed to drive applications.elevate (the caller checks the returned
// source). Body is quarantined from every list projection (the 64KB cap is structural — the schema
// caps it, and no list SELECT ever names the column). Ported from the proven cb25d19 tree; the
// email_accounts projection is explicit-column (the new table grew sync-cursor/token-health columns
// that a list has no business shipping).

import type { DalContext, LeanPage } from './index.js';
import { makeStmtCache, clampLimit, clampOffset } from './index.js';

export type EmailAccountKind = 'gmail_oauth' | 'imap' | 'imported';
export type EmailProvider = 'gmail' | 'outlook' | 'imap' | 'imported';
export type EmailCategory =
  | 'application_confirmation' | 'recruiter' | 'assessment' | 'interview'
  | 'offer' | 'rejection' | 'other';
export type ClassifiedBy = 'rules' | 'ai' | 'manual';
export type MatchSource = 'auto' | 'suggested' | 'manual' | 'dismissed';
export type MatchVia = 'thread' | 'ats_id' | 'score' | 'ai' | 'auto_created' | 'user' | 'import';

/** Lean account row — health surface only. Sync cursors (history_id/watermark/imap_*) are the
 *  gmail-sync engine's business (Stage 5); the sealed token itself lives in `secrets`. */
export interface EmailAccountLean {
  id: string;
  kind: EmailAccountKind;
  email: string;
  label: string | null;
  enabled: number;
  token_state: string;
  auth_fail_count: number;
  last_ok_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface EmailLean {
  id: string;
  account_id: string;
  from_addr: string;
  from_name: string;
  subject: string;
  snippet: string;
  sent_at: number | null;
  category: EmailCategory | null;
  classified_by: ClassifiedBy | null;
  created_at: number;
}

/** A suggestion row = the lean email + its pending match (what the review UI renders/confirms). */
export interface EmailSuggestion extends EmailLean {
  application_id: string | null;
  job_id: string | null;
  confidence: number;
  match_via: MatchVia | null;
}

export interface EmailMatch {
  email_id: string;
  application_id: string | null;
  job_id: string | null;
  confidence: number;
  source: MatchSource;
  match_via: MatchVia | null;
  decided_at: number;
}

export interface UpsertEmailInput {
  accountId: string;
  providerMsgId: string;
  provider?: EmailProvider;
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
  sentAt?: number;
  category?: EmailCategory;
  classifiedBy?: ClassifiedBy;
  aiConfidence?: number;
  rulesPackVer?: number;
}

export interface SetMatchInput {
  applicationId?: string;
  jobId?: string;
  confidence?: number;
  source: MatchSource;
  matchVia?: MatchVia;
}

const LEAN_COLS =
  'id, account_id, from_addr, from_name, subject, snippet, sent_at, category, classified_by, created_at';

const ACCOUNT_COLS =
  'id, kind, email, label, enabled, token_state, auth_fail_count, last_ok_at, created_at, updated_at';

const MATCH_COLS = 'email_id, application_id, job_id, confidence, source, match_via, decided_at';

function cap(s: string | undefined, n: number): string {
  return (s ?? '').slice(0, n);
}

export function makeEmailsDal(ctx: DalContext) {
  const { db, now, newId, emit } = ctx;
  const stmt = makeStmtCache(db);

  function getAccount(id: string): EmailAccountLean | undefined {
    return stmt(`SELECT ${ACCOUNT_COLS} FROM email_accounts WHERE id = ?`).get(id) as
      | EmailAccountLean
      | undefined;
  }

  /** Get-or-create an account keyed by id (when given) or (kind, email). Importer + Gmail connect
   *  both route through here so one mailbox can never fork into two account rows. */
  function ensureAccount(input: {
    id?: string;
    kind: EmailAccountKind;
    email?: string;
    label?: string;
  }): EmailAccountLean {
    return db.transaction((): EmailAccountLean => {
      const existing = input.id
        ? getAccount(input.id)
        : (stmt(`SELECT ${ACCOUNT_COLS} FROM email_accounts WHERE kind = ? AND email = ?`).get(
            input.kind,
            input.email ?? '',
          ) as EmailAccountLean | undefined);
      if (existing) return existing;
      const id = input.id ?? newId('acct');
      const ts = now();
      stmt(
        `INSERT INTO email_accounts (id, kind, email, label, created_at, updated_at)
         VALUES (@id, @kind, @email, @label, @ts, @ts)`,
      ).run({ id, kind: input.kind, email: input.email ?? '', label: input.label ?? null, ts });
      emit({ table: 'email_accounts', op: 'insert', id });
      return getAccount(id)!;
    })();
  }

  function listAccounts(): EmailAccountLean[] {
    return stmt(
      `SELECT ${ACCOUNT_COLS} FROM email_accounts ORDER BY created_at ASC`,
    ).all() as EmailAccountLean[];
  }

  /** Idempotent ingest keyed by UNIQUE(account_id, provider_msg_id). Updates COALESCE so a re-sync
   *  can enrich (add body, classification) but never blank out what an earlier sync captured. */
  function upsert(input: UpsertEmailInput): { id: string; action: 'inserted' | 'updated' } {
    return db.transaction((): { id: string; action: 'inserted' | 'updated' } => {
      const existing = stmt(
        'SELECT id FROM emails WHERE account_id = ? AND provider_msg_id = ?',
      ).get(input.accountId, input.providerMsgId) as { id: string } | undefined;
      const ts = now();

      if (existing) {
        stmt(
          `UPDATE emails SET
             message_id = COALESCE(@message_id, message_id),
             thread_id = COALESCE(@thread_id, thread_id),
             subject = @subject, snippet = @snippet,
             body = COALESCE(@body, body),
             sent_at = COALESCE(@sent_at, sent_at),
             category = COALESCE(@category, category),
             classified_by = COALESCE(@classified_by, classified_by),
             rules_pack_ver = COALESCE(@rules_pack_ver, rules_pack_ver),
             ai_confidence = COALESCE(@ai_confidence, ai_confidence)
           WHERE id = @id`,
        ).run({
          id: existing.id,
          message_id: input.messageId ?? null,
          thread_id: input.threadId ?? null,
          subject: cap(input.subject, 998),
          snippet: cap(input.snippet, 512),
          body: input.body === undefined ? null : cap(input.body, 65536),
          sent_at: input.sentAt ?? null,
          category: input.category ?? null,
          classified_by: input.classifiedBy ?? null,
          rules_pack_ver: input.rulesPackVer ?? null,
          ai_confidence: input.aiConfidence ?? null,
        });
        emit({ table: 'emails', op: 'update', id: existing.id });
        return { id: existing.id, action: 'updated' };
      }

      const id = newId('eml');
      stmt(
        `INSERT INTO emails (id, account_id, provider_msg_id, provider, message_id, thread_id, in_reply_to, ref_ids,
           from_addr, from_name, to_addr, subject, snippet, body, sent_at, category, classified_by, rules_pack_ver, ai_confidence, created_at)
         VALUES (@id, @account_id, @provider_msg_id, @provider, @message_id, @thread_id, @in_reply_to, @ref_ids,
           @from_addr, @from_name, @to_addr, @subject, @snippet, @body, @sent_at, @category, @classified_by, @rules_pack_ver, @ai_confidence, @created_at)`,
      ).run({
        id,
        account_id: input.accountId,
        provider_msg_id: input.providerMsgId,
        provider: input.provider ?? null,
        message_id: input.messageId ?? null,
        thread_id: input.threadId ?? null,
        in_reply_to: input.inReplyTo ?? null,
        ref_ids: input.refIds ?? null,
        from_addr: cap(input.fromAddr, 320),
        from_name: cap(input.fromName, 256),
        to_addr: cap(input.toAddr, 320),
        subject: cap(input.subject, 998),
        snippet: cap(input.snippet, 512),
        body: input.body === undefined ? null : cap(input.body, 65536),
        sent_at: input.sentAt ?? null,
        category: input.category ?? null,
        classified_by: input.classifiedBy ?? null,
        rules_pack_ver: input.rulesPackVer ?? null,
        ai_confidence: input.aiConfidence ?? null,
        created_at: ts,
      });
      emit({ table: 'emails', op: 'insert', id });
      return { id, action: 'inserted' };
    })();
  }

  function getMatch(emailId: string): EmailMatch | undefined {
    return stmt(`SELECT ${MATCH_COLS} FROM email_matches WHERE email_id = ?`).get(emailId) as
      | EmailMatch
      | undefined;
  }

  /**
   * Set/replace the email's ONE current match. A manual or dismissed decision is STICKY: an incoming
   * auto/suggested match never overwrites it (returns the existing match unchanged) — the human's
   * click always wins, and "dismissed never returns". Returns the effective match.
   */
  function setMatch(emailId: string, input: SetMatchInput): EmailMatch {
    return db.transaction((): EmailMatch => {
      const existing = getMatch(emailId);
      if (
        existing &&
        (existing.source === 'manual' || existing.source === 'dismissed') &&
        input.source !== 'manual' &&
        input.source !== 'dismissed'
      ) {
        return existing; // human decision wins
      }
      const ts = now();
      const conf = Math.min(Math.max(input.confidence ?? 0, 0), 1);
      stmt(
        `INSERT INTO email_matches (email_id, application_id, job_id, confidence, source, match_via, decided_at)
         VALUES (@email_id, @application_id, @job_id, @confidence, @source, @match_via, @decided_at)
         ON CONFLICT(email_id) DO UPDATE SET
           application_id = excluded.application_id, job_id = excluded.job_id,
           confidence = excluded.confidence, source = excluded.source,
           match_via = excluded.match_via, decided_at = excluded.decided_at`,
      ).run({
        email_id: emailId,
        application_id: input.applicationId ?? null,
        job_id: input.jobId ?? null,
        confidence: conf,
        source: input.source,
        match_via: input.matchVia ?? null,
        decided_at: ts,
      });
      emit({ table: 'email_matches', op: 'update', id: emailId });
      return getMatch(emailId)!;
    })();
  }

  /** Emails matched to one application (the drawer's emails panel), newest first. Dismissed matches
   *  are excluded — "dismissed never returns" applies to reads too. */
  function listForApplication(
    applicationId: string,
    opts: { limit?: number; offset?: number } = {},
  ): LeanPage<EmailLean> {
    const limit = clampLimit(opts.limit, 200);
    const offset = clampOffset(opts.offset);
    const sub =
      "SELECT email_id FROM email_matches WHERE application_id = ? AND source <> 'dismissed'";
    const total = (
      stmt(`SELECT COUNT(*) AS c FROM emails WHERE id IN (${sub})`).get(applicationId) as {
        c: number;
      }
    ).c;
    const rows = stmt(
      `SELECT ${LEAN_COLS} FROM emails WHERE id IN (${sub})
       ORDER BY sent_at DESC LIMIT ? OFFSET ?`,
    ).all(applicationId, limit, offset) as EmailLean[];
    return { rows, total };
  }

  /** The suggestion review queue: emails whose current match is 'suggested', joined to the pending
   *  match so the UI can render confirm/dismiss without a second query per row. */
  function suggestions(opts: { limit?: number; offset?: number } = {}): LeanPage<EmailSuggestion> {
    const limit = clampLimit(opts.limit, 50);
    const offset = clampOffset(opts.offset);
    const total = (
      stmt("SELECT COUNT(*) AS c FROM email_matches WHERE source = 'suggested'").get() as {
        c: number;
      }
    ).c;
    const leanQualified = LEAN_COLS.split(', ')
      .map((c) => `e.${c}`)
      .join(', ');
    const rows = stmt(
      `SELECT ${leanQualified}, m.application_id, m.job_id, m.confidence, m.match_via
       FROM emails e JOIN email_matches m ON m.email_id = e.id
       WHERE m.source = 'suggested'
       ORDER BY e.sent_at DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as EmailSuggestion[];
    return { rows, total };
  }

  /** Paged lean inbox (no body — structurally quarantined). */
  function listLean(
    opts: { accountId?: string; category?: EmailCategory; limit?: number; offset?: number } = {},
  ): LeanPage<EmailLean> {
    const limit = clampLimit(opts.limit, 200);
    const offset = clampOffset(opts.offset);
    const where: string[] = [];
    const bind: Record<string, unknown> = {};
    if (opts.accountId !== undefined) {
      where.push('account_id = @accountId');
      bind.accountId = opts.accountId;
    }
    if (opts.category !== undefined) {
      where.push('category = @category');
      bind.category = opts.category;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (stmt(`SELECT COUNT(*) AS c FROM emails ${clause}`).get(bind) as { c: number }).c;
    const rows = stmt(
      `SELECT ${LEAN_COLS} FROM emails ${clause} ORDER BY sent_at DESC LIMIT @limit OFFSET @offset`,
    ).all({ ...bind, limit, offset }) as EmailLean[];
    return { rows, total };
  }

  /** The one sanctioned body read — a single row, on explicit request (the reading pane). */
  function getBody(id: string): string | undefined {
    return (
      (stmt('SELECT body FROM emails WHERE id = ?').get(id) as { body: string | null } | undefined)
        ?.body ?? undefined
    );
  }

  return {
    ensureAccount,
    listAccounts,
    upsert,
    getMatch,
    setMatch,
    listForApplication,
    suggestions,
    listLean,
    getBody,
  };
}

export type EmailsDal = ReturnType<typeof makeEmailsDal>;
