// match.ts — email → application matcher (Pillar 8 / plan §7). A first-hit-wins ladder:
//   Rung 1  thread continuity   (0.95, via:'thread')  — the email is in a thread we already matched.
//   Rung 2  ATS external id     (0.93, via:'ats_id')  — an ATS job/application id in the body's URLs
//                                                        equals a tracked job's external_id/source id.
//   Rung 3  company + title + recency scoring (via:'score') — v11's fuzzy scorer over open applications.
// The matcher returns the BEST candidate + a confidence; it does NOT decide auto-vs-suggested and it
// NEVER writes — the caller (index.ts) reads the confidence, picks a source, and calls emails.setMatch.
// It reaches the DB READ-ONLY through dal.ctx.db for the couple of lookups the emails DAL doesn't
// expose (thread lookup, application-by-job) — no writes here.

import type { Dal } from '../db/dal/index.js';
import { normKey } from '@jat13/shared/norm';

/** The email fields the matcher needs. Mirrors an emails row (post-upsert), body included for URLs. */
export interface MatchableEmail {
  id: string;
  accountId: string;
  fromAddr: string;
  fromName: string;
  subject: string;
  body: string;
  threadId: string | null;
  inReplyTo: string | null;
  refIds: string | null;
  sentAt: number | null;
}

export interface MatchResult {
  /** application to elevate (present iff a job matched AND it has an application row). */
  applicationId?: string;
  /** the matched job (present on any hit). */
  jobId?: string;
  /** 0..1 — the caller thresholds this into auto (high) vs suggested (low). */
  confidence: number;
  via: 'thread' | 'ats_id' | 'score' | 'none';
}

const NO_MATCH: MatchResult = { confidence: 0, via: 'none' };

// Free-mail + job-board sender roots whose domain is NEVER the employer's own domain (so a sender-domain
// ↔ company signal must be ignored for them). Ported from v11's nonCompanyDomains/freeMail sets.
const NON_COMPANY_ROOTS = new Set<string>([
  'gmail', 'googlemail', 'outlook', 'hotmail', 'yahoo', 'icloud', 'proton', 'protonmail', 'aol', 'live',
  'linkedin', 'indeed', 'greenhouse', 'grnh', 'lever', 'ashbyhq', 'workday', 'myworkdayjobs', 'icims',
  'smartrecruiters', 'workable', 'bamboohr', 'taleo', 'jobvite', 'recruitee', 'breezy', 'successfactors',
  'ceipal', 'notifications', 'noreply', 'no-reply',
]);

// ATS mail systems — a hit here is a weaker positive (the mail came through a known ATS relay).
const ATS_MAIL_ROOTS = new Set<string>([
  'greenhouse', 'grnh', 'lever', 'ashbyhq', 'workday', 'myworkdayjobs', 'icims', 'smartrecruiters',
  'workable', 'bamboohr', 'taleo', 'jobvite', 'recruitee', 'breezy', 'successfactors',
]);

// ATS id extractors — a captured external id (org/job or org/application) is a near-certain link.
// Kept in code (would be pack data in the full build); the captured id is compared to jobs.external_id.
const ATS_ID_EXTRACTORS: readonly RegExp[] = [
  /boards\.greenhouse\.io\/[\w-]+\/jobs\/(\d+)/i,
  /job-boards\.greenhouse\.io\/[\w-]+\/jobs\/(\d+)/i,
  /grnh\.se\/([0-9a-f]{6,})/i,
  /jobs\.lever\.co\/[\w-]+\/([0-9a-f-]{36})/i,
  /jobs\.ashbyhq\.com\/[\w-]+\/([0-9a-f-]{36})/i,
  /gh_jid=(\d+)/i,
];

interface JobRowLite {
  id: string;
  external_id: string | null;
  title: string;
  company: string;
  company_key: string;
}

/** Lowercased local-part-less domain root of an email address (`a.b@mail.corp.com` → `corp`). */
function domainRoot(addr: string): string {
  const at = addr.lastIndexOf('@');
  const host = (at >= 0 ? addr.slice(at + 1) : addr).toLowerCase().trim();
  const labels = host.split('.').filter(Boolean);
  if (labels.length === 0) return '';
  // second-to-last label is the registrable-ish root for the common cases we care about.
  return labels.length >= 2 ? labels[labels.length - 2]! : labels[0]!;
}

/** Company hints from the sender: name, and domain root when it is not a job-board/free-mail domain. */
function companyHints(email: MatchableEmail): { fromName: string; domain: string; isAts: boolean } {
  const root = domainRoot(email.fromAddr);
  const isNonCompany = NON_COMPANY_ROOTS.has(root);
  return {
    fromName: email.fromName || '',
    domain: isNonCompany ? '' : root,
    isAts: ATS_MAIL_ROOTS.has(root),
  };
}

export function makeMatcher(dal: Dal) {
  const db = dal.ctx.db;

  /** The application row for a job (newest first if a job somehow has several profiles' rows). */
  function applicationForJob(jobId: string): string | undefined {
    const row = db
      .prepare('SELECT id FROM applications WHERE job_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(jobId) as { id: string } | undefined;
    return row?.id;
  }

  /** Rung 1 — a matched (auto|manual, NEVER suggested) email in the same thread/reply-chain → its job.
   *  Never inherits from a `suggested` match (v11 rule: a guess can't seed another guess). */
  function byThread(email: MatchableEmail): { jobId: string } | undefined {
    const ids: string[] = [];
    if (email.threadId) ids.push(email.threadId);
    // reply-chain: find OUR stored emails whose message_id is named by in_reply_to / references.
    const refTokens = `${email.inReplyTo ?? ''} ${email.refIds ?? ''}`.split(/\s+/).filter(Boolean);
    if (email.threadId) {
      const row = db
        .prepare(
          `SELECT m.job_id AS jobId FROM emails e JOIN email_matches m ON m.email_id = e.id
            WHERE e.thread_id = ? AND e.id <> ? AND m.source IN ('auto','manual') AND m.job_id IS NOT NULL
            ORDER BY m.decided_at DESC LIMIT 1`,
        )
        .get(email.threadId, email.id) as { jobId: string } | undefined;
      if (row?.jobId) return { jobId: row.jobId };
    }
    if (refTokens.length > 0) {
      const placeholders = refTokens.map(() => '?').join(',');
      const row = db
        .prepare(
          `SELECT m.job_id AS jobId FROM emails e JOIN email_matches m ON m.email_id = e.id
            WHERE e.message_id IN (${placeholders}) AND m.source IN ('auto','manual') AND m.job_id IS NOT NULL
            ORDER BY m.decided_at DESC LIMIT 1`,
        )
        .get(...refTokens) as { jobId: string } | undefined;
      if (row?.jobId) return { jobId: row.jobId };
    }
    void ids;
    return undefined;
  }

  /** Rung 2 — an ATS external id in the body's URLs that equals a tracked job's external_id. */
  function byAtsId(email: MatchableEmail): { jobId: string } | undefined {
    for (const rx of ATS_ID_EXTRACTORS) {
      const m = rx.exec(email.body);
      const id = m?.[1];
      if (!id) continue;
      const row = db
        .prepare('SELECT id FROM jobs WHERE external_id = ? LIMIT 1')
        .get(id) as { id: string } | undefined;
      if (row?.id) return { jobId: row.id };
    }
    return undefined;
  }

  /** Rung 3 — v11's company + title + recency scorer over candidate jobs. Returns the best job + score. */
  function byScore(email: MatchableEmail): { jobId: string; score: number } | undefined {
    const hints = companyHints(email);
    const nameKey = normKey(hints.fromName);
    const domainKey = normKey(hints.domain);
    // candidate companies from the sender: prefer the domain root, then the from-name.
    const candidateKeys = [domainKey, nameKey].filter((k) => k.length >= 2);
    if (candidateKeys.length === 0) return undefined;

    // pull jobs whose company_key contains (or is contained by) a candidate key.
    const jobs: JobRowLite[] = [];
    const seen = new Set<string>();
    for (const key of candidateKeys) {
      const rows = db
        .prepare(
          `SELECT id, external_id, title, company, company_key FROM jobs
            WHERE company_key <> '' AND (company_key LIKE @like OR @key LIKE '%' || company_key || '%')
            LIMIT 50`,
        )
        .all({ like: `%${key}%`, key }) as JobRowLite[];
      for (const r of rows) {
        if (!seen.has(r.id)) { seen.add(r.id); jobs.push(r); }
      }
    }
    if (jobs.length === 0) return undefined;

    const haystack = `${email.subject}\n${email.body.slice(0, 1500)}`.toLowerCase();
    let best: { jobId: string; score: number } | undefined;
    for (const job of jobs) {
      // time proximity: need the application's submitted_at (fallback to job/first-seen via applications).
      const appl = db
        .prepare('SELECT submitted_at, created_at FROM applications WHERE job_id = ? ORDER BY updated_at DESC LIMIT 1')
        .get(job.id) as { submitted_at: number | null; created_at: number } | undefined;
      const appliedAt = appl?.submitted_at ?? appl?.created_at ?? null;

      let s = 0;
      if (appliedAt !== null && email.sentAt !== null) {
        const days = Math.abs(email.sentAt - appliedAt) / 86_400_000;
        s += 1 - Math.min(days, 120) / 120; // time proximity, 0..1
        if (email.sentAt < appliedAt - 2 * 86_400_000) s = -1; // email predates the apply → not ours
      }
      if (s !== -1) {
        if (job.title && haystack.includes(job.title.toLowerCase())) s += 0.35;
        if (domainKey && job.company_key.includes(domainKey)) s += 0.3; // sender domain ↔ company
        else if (hints.isAts) s += 0.18; // came through a known ATS relay
      }
      if (!best || s > best.score) best = { jobId: job.id, score: s };
    }
    return best && best.score > 0 ? best : undefined;
  }

  /**
   * Run the ladder. First hit wins. Rung 3's score is folded into a 0..1 confidence exactly as v11:
   * auto band when score is high with a clear winner, suggested band otherwise. The CALLER decides the
   * source from the returned confidence — this only reports the best candidate it can find.
   */
  function match(email: MatchableEmail): MatchResult {
    const t = byThread(email);
    if (t) return { jobId: t.jobId, ...applId(t.jobId), confidence: 0.95, via: 'thread' };

    const a = byAtsId(email);
    if (a) return { jobId: a.jobId, ...applId(a.jobId), confidence: 0.93, via: 'ats_id' };

    const sc = byScore(email);
    if (sc) {
      // Fold score → confidence (v11 bands): a strong score reads as a high-confidence auto candidate.
      const confidence = Math.min(0.4 + Math.max(sc.score, 0) * 0.4, 0.96);
      return { jobId: sc.jobId, ...applId(sc.jobId), confidence, via: 'score' };
    }
    return NO_MATCH;
  }

  function applId(jobId: string): { applicationId?: string } {
    const id = applicationForJob(jobId);
    return id ? { applicationId: id } : {};
  }

  return { match };
}

/**
 * Convenience free function matching the task signature: matchEmailToApplication(dal, email).
 * Builds a matcher over `dal` and runs it once. (index.ts reuses the makeMatcher form to avoid
 * rebuilding per email in a sync loop, but this stays for one-shot callers/tests.)
 */
export function matchEmailToApplication(dal: Dal, email: MatchableEmail): MatchResult {
  return makeMatcher(dal).match(email);
}
