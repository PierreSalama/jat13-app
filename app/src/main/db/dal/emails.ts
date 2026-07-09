// emails DAL — inbox rows + the email→application match (Pillar 4 §4 / §2.7). The pipeline rule
// (v11.48/64) is enforced HERE: a manual or dismissed match is never clobbered by an auto/suggested
// one, and only auto/manual matches are allowed to drive applications.elevate (the caller checks the
// returned source). Body is quarantined from list projections (the 64KB cap is structural).
import type { DalContext, LeanPage } from './util.js';
import { makeStmtCache, clampLimit } from './util.js';

export interface EmailAccount {
  id: string;
  kind: 'gmail_oauth' | 'imap' | 'imported';
  email: string;
  label: string | null;
  enabled: number;
  token_state: string;
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
  category: string | null;
  classified_by: string | null;
  created_at: number;
}

export interface EmailMatch {
  email_id: string;
  application_id: string | null;
  job_id: string | null;
  confidence: number;
  source: 'auto' | 'suggested' | 'manual' | 'dismissed';
  match_via: string | null;
  decided_at: number;
}

export interface UpsertEmailInput {
  accountId: string;
  providerMsgId: string;
  provider?: 'gmail' | 'outlook' | 'imap' | 'imported';
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
  category?: string;
  classifiedBy?: 'rules' | 'ai' | 'manual';
  aiConfidence?: number;
  rulesPackVer?: number;
}

export interface SetMatchInput {
  applicationId?: string;
  jobId?: string;
  confidence?: number;
  source: 'auto' | 'suggested' | 'manual' | 'dismissed';
  matchVia?: 'thread' | 'ats_id' | 'score' | 'ai' | 'auto_created' | 'user' | 'import';
}

const LEAN_COLS = 'id, account_id, from_addr, from_name, subject, snippet, sent_at, category, classified_by, created_at';

function cap(s: string | undefined, n: number): string {
  return (s ?? '').slice(0, n);
}

export function makeEmailsDal(ctx: DalContext) {
  const { db, now, newId, emit } = ctx;
  const stmt = makeStmtCache(db);

  function ensureAccount(input: { id?: string; kind: EmailAccount['kind']; email?: string; label?: string }): EmailAccount {
    const existing = input.id
      ? (stmt('SELECT * FROM email_accounts WHERE id = ?').get(input.id) as EmailAccount | undefined)
      : (stmt('SELECT * FROM email_accounts WHERE kind = ? AND email = ?').get(input.kind, input.email ?? '') as EmailAccount | undefined);
    if (existing) return existing;
    const id = input.id ?? newId('acct');
    const ts = now();
    stmt(
      `INSERT INTO email_accounts (id, kind, email, label, created_at, updated_at) VALUES (@id,@kind,@email,@label,@ts,@ts)`,
    ).run({ id, kind: input.kind, email: input.email ?? '', label: input.label ?? null, ts });
    emit({ table: 'email_accounts', op: 'insert', id });
    return stmt('SELECT * FROM email_accounts WHERE id = ?').get(id) as EmailAccount;
  }

  function listAccounts(): EmailAccount[] {
    return stmt('SELECT * FROM email_accounts ORDER BY created_at ASC').all() as EmailAccount[];
  }

  function upsert(input: UpsertEmailInput): { id: string; action: 'inserted' | 'updated' } {
    const existing = stmt('SELECT id FROM emails WHERE account_id = ? AND provider_msg_id = ?').get(input.accountId, input.providerMsgId) as
      | { id: string }
      | undefined;
    const ts = now();
    const row = {
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
    };
    if (existing) {
      stmt(
        `UPDATE emails SET message_id=COALESCE(@message_id,message_id), thread_id=COALESCE(@thread_id,thread_id),
           subject=@subject, snippet=@snippet, body=COALESCE(@body,body), sent_at=COALESCE(@sent_at,sent_at),
           category=COALESCE(@category,category), classified_by=COALESCE(@classified_by,classified_by),
           rules_pack_ver=COALESCE(@rules_pack_ver,rules_pack_ver), ai_confidence=COALESCE(@ai_confidence,ai_confidence)
         WHERE id=@id`,
      ).run({ ...row, id: existing.id });
      emit({ table: 'emails', op: 'update', id: existing.id });
      return { id: existing.id, action: 'updated' };
    }
    const id = newId('eml');
    stmt(
      `INSERT INTO emails (id, account_id, provider_msg_id, provider, message_id, thread_id, in_reply_to, ref_ids,
         from_addr, from_name, to_addr, subject, snippet, body, sent_at, category, classified_by, rules_pack_ver, ai_confidence, created_at)
       VALUES (@id,@account_id,@provider_msg_id,@provider,@message_id,@thread_id,@in_reply_to,@ref_ids,
         @from_addr,@from_name,@to_addr,@subject,@snippet,@body,@sent_at,@category,@classified_by,@rules_pack_ver,@ai_confidence,@created_at)`,
    ).run({ ...row, id, created_at: ts });
    emit({ table: 'emails', op: 'insert', id });
    return { id, action: 'inserted' };
  }

  function getMatch(emailId: string): EmailMatch | undefined {
    return stmt('SELECT * FROM email_matches WHERE email_id = ?').get(emailId) as EmailMatch | undefined;
  }

  /**
   * Set/replace the email's match. A manual or dismissed decision is STICKY: an incoming auto/suggested
   * match never overwrites it (returns the existing match unchanged). Returns the effective match.
   */
  function setMatch(emailId: string, input: SetMatchInput): EmailMatch {
    const existing = getMatch(emailId);
    if (existing && (existing.source === 'manual' || existing.source === 'dismissed') && input.source !== 'manual' && input.source !== 'dismissed') {
      return existing; // human decision wins
    }
    const ts = now();
    const conf = Math.min(Math.max(input.confidence ?? 0, 0), 1);
    stmt(
      `INSERT INTO email_matches (email_id, application_id, job_id, confidence, source, match_via, decided_at)
       VALUES (@email_id,@application_id,@job_id,@confidence,@source,@match_via,@decided_at)
       ON CONFLICT(email_id) DO UPDATE SET application_id=excluded.application_id, job_id=excluded.job_id,
         confidence=excluded.confidence, source=excluded.source, match_via=excluded.match_via, decided_at=excluded.decided_at`,
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
  }

  function listForApplication(applicationId: string): EmailLean[] {
    return stmt(
      `SELECT ${LEAN_COLS} FROM emails WHERE id IN (SELECT email_id FROM email_matches WHERE application_id = ?) ORDER BY sent_at DESC`,
    ).all(applicationId) as EmailLean[];
  }

  function unmatchedSuggestions(limit = 50): EmailLean[] {
    return stmt(
      `SELECT ${LEAN_COLS} FROM emails
       WHERE id IN (SELECT email_id FROM email_matches WHERE source = 'suggested')
       ORDER BY sent_at DESC LIMIT ?`,
    ).all(clampLimit(limit, 50)) as EmailLean[];
  }

  function listLean(opts: { accountId?: string; category?: string; limit?: number; offset?: number } = {}): LeanPage<EmailLean> {
    const where: string[] = [];
    const bind: Record<string, unknown> = { limit: clampLimit(opts.limit, 200), offset: opts.offset ?? 0 };
    if (opts.accountId) { where.push('account_id = @accountId'); bind.accountId = opts.accountId; }
    if (opts.category) { where.push('category = @category'); bind.category = opts.category; }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (stmt(`SELECT COUNT(*) AS c FROM emails ${clause}`).get(bind) as { c: number }).c;
    const rows = stmt(`SELECT ${LEAN_COLS} FROM emails ${clause} ORDER BY sent_at DESC LIMIT @limit OFFSET @offset`).all(bind) as EmailLean[];
    return { rows, total };
  }

  function getBody(id: string): string | undefined {
    return (stmt('SELECT body FROM emails WHERE id = ?').get(id) as { body: string | null } | undefined)?.body ?? undefined;
  }

  return { ensureAccount, listAccounts, upsert, getMatch, setMatch, listForApplication, unmatchedSuggestions, listLean, getBody };
}
