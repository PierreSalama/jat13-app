// Gmail status pipeline (Pillar 8) integration + unit tests. In-memory migrated DB + makeDal, a FAKE
// gmail client returning canned messages (NO live Gmail/OAuth). Asserts: emails upserted + classified
// (offer beats a generic body via the ladder), the offer email matched + the application elevated to
// 'offer', a low-confidence stray stays out of the funnel, and a suggested match never elevates.
// Plus pure classify/statusMap/match unit checks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import {
  makeGmailService,
  type GmailClient,
  type FetchedMessage,
  type GmailClientFactory,
} from '../../app/src/main/gmail/index.js';
import { classifyEmail } from '../../app/src/main/gmail/classify.js';
import { categoryToStatus } from '../../app/src/main/gmail/statusMap.js';
import { matchEmailToApplication } from '../../app/src/main/gmail/match.js';

const fakeSealer: Sealer = {
  available: () => true,
  seal: (p) => Buffer.from(p),
  open: (b) => Buffer.from(b).toString(),
};

/** A fake client that returns a fixed message list newer than the requested watermark. */
function fakeClientFactory(messages: FetchedMessage[]): GmailClientFactory {
  return async (): Promise<GmailClient> => ({
    listMessages: async ({ sinceMs }) =>
      messages.filter((m) => (m.sentAt ?? 0) > sinceMs),
  });
}

const T = 1_700_000_000_000; // fixed epoch-ms "now"
const DAY = 86_400_000;

describe('gmail service — syncAccount pipeline', () => {
  let db: Database;
  let dal: Dal;

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    dal = makeDal(defaultContext(db, () => {}), { sealer: fakeSealer });
    db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?,?,1,?,?)').run('p1', 'Pierre', T, T);
  });
  afterEach(() => db.close());

  /** Seed a job at Acme + a submitted application, and return {jobId, applicationId}. */
  function seedAcme(appliedAt = T - 3 * DAY): { jobId: string; applicationId: string } {
    const { job } = dal.jobs.upsert({ source: 'greenhouse', job_url: 'https://boards.greenhouse.io/acme/jobs/123', external_id: '123', title: 'Staff Engineer', company: 'Acme Corp' });
    const appl = dal.applications.ensure(job.id, 'p1');
    dal.applications.elevate(appl.id, 'submitted', 'auto');
    // backdate submitted_at so recency scoring sees a plausible apply date
    db.prepare('UPDATE applications SET submitted_at = ? WHERE id = ?').run(appliedAt, appl.id);
    return { jobId: job.id, applicationId: appl.id };
  }

  it('upserts + classifies messages, matches the offer, and elevates the application to offer', async () => {
    const { applicationId } = seedAcme();
    const acct = dal.emails.ensureAccount({ kind: 'gmail_oauth', email: 'me@gmail.com' });

    const messages: FetchedMessage[] = [
      {
        providerMsgId: 'g-offer',
        messageId: '<offer@acme.com>',
        fromAddr: 'careers@acme.com',
        fromName: 'Acme Talent',
        subject: 'Your application to Acme Corp',
        // generic-looking subject, but the BODY carries the offer language — the ladder must win on body
        body: 'Hi Pierre, we are pleased to offer you the Staff Engineer position at Acme Corp. Offer letter attached.',
        sentAt: T - 1 * DAY,
      },
      {
        providerMsgId: 'g-reject',
        fromAddr: 'no-reply@lever.co',
        fromName: 'Globex',
        subject: 'Update on your application',
        body: 'Unfortunately we have decided to pursue other candidates for this role. We wish you the best.',
        sentAt: T - 2 * DAY,
      },
      {
        providerMsgId: 'g-recruiter',
        fromAddr: 'jane@some-recruiter.com',
        fromName: 'Jane Doe',
        subject: 'Opportunity that may interest you',
        body: 'I am a recruiter reaching out about a senior role. Came across your profile.',
        sentAt: T - 1.5 * DAY,
      },
    ];

    const svc = makeGmailService({ dal, gmailClientFactory: fakeClientFactory(messages), now: () => T });
    const summary = await svc.syncAccount(acct.id);

    // all three upserted + classified
    expect(summary.scanned).toBe(3);
    expect(summary.stored).toBe(3);
    expect(dal.emails.listLean({ accountId: acct.id }).total).toBe(3);

    const byCat = Object.fromEntries(
      dal.emails.listLean({ accountId: acct.id }).rows.map((r) => [r.subject, r.category]),
    );
    // offer beats the generic "Your application to X" subject (body-driven ladder)
    expect(byCat['Your application to Acme Corp']).toBe('offer');
    expect(byCat['Update on your application']).toBe('rejection');
    expect(byCat['Opportunity that may interest you']).toBe('recruiter');

    // the offer email matched Acme (ATS-id rung via the greenhouse job id) and elevated the app to offer
    expect(summary.matched).toBeGreaterThanOrEqual(1);
    expect(summary.elevated).toBeGreaterThanOrEqual(1);
    expect(dal.applications.get(applicationId)!.status).toBe('offer');

    // a status_change event was recorded from inbox evidence (audit invariant)
    const timeline = dal.events.timeline(applicationId).rows;
    const statusChange = timeline.find((e) => e.kind === 'status_change' && e.source === 'inbox');
    expect(statusChange).toBeTruthy();
    expect((statusChange!.data as { to?: string }).to).toBe('offer');

    // the watermark advanced past the newest message
    const wm = db.prepare('SELECT watermark_ms FROM email_accounts WHERE id = ?').get(acct.id) as { watermark_ms: number };
    expect(wm.watermark_ms).toBe(T - 1 * DAY);
  });

  it('a low-confidence match stays suggested and never elevates', async () => {
    // A job the fuzzy scorer will only weakly relate to (company matches by name, but no ATS id / thread,
    // and the apply date is far off so the time signal is weak).
    const { job } = dal.jobs.upsert({ source: 'linkedin', job_url: 'https://www.linkedin.com/jobs/view/9', title: 'Analyst', company: 'Initech' });
    const appl = dal.applications.ensure(job.id, 'p1');
    dal.applications.elevate(appl.id, 'submitted', 'auto');
    db.prepare('UPDATE applications SET submitted_at = ? WHERE id = ?').run(T - 100 * DAY, appl.id);

    const acct = dal.emails.ensureAccount({ kind: 'gmail_oauth', email: 'me@gmail.com' });
    const messages: FetchedMessage[] = [
      {
        providerMsgId: 'g-weak',
        fromAddr: 'careers@initech.com',
        fromName: 'Initech',
        subject: 'We received your application',
        body: 'Thank you for applying. Your application has been received.',
        sentAt: T - 1 * DAY, // ~99 days after the apply → weak time proximity
      },
    ];

    const svc = makeGmailService({ dal, gmailClientFactory: fakeClientFactory(messages), now: () => T });
    const summary = await svc.syncAccount(acct.id);

    expect(summary.stored).toBe(1);
    // it should be suggested (or unmatched), but definitely NOT elevated
    expect(summary.elevated).toBe(0);
    expect(dal.applications.get(appl.id)!.status).toBe('submitted');
    // if it was suggested, it shows up in the suggestions queue and did not move the funnel
    if (summary.suggested > 0) {
      expect(dal.emails.unmatchedSuggestions().length).toBeGreaterThanOrEqual(1);
    }
  });

  it('is idempotent — a second sync re-classifies without double-elevating and does not re-store', async () => {
    const { applicationId } = seedAcme();
    const acct = dal.emails.ensureAccount({ kind: 'gmail_oauth', email: 'me@gmail.com' });
    const messages: FetchedMessage[] = [
      {
        providerMsgId: 'g-offer',
        fromAddr: 'careers@acme.com',
        subject: 'Offer',
        body: 'We are pleased to offer you the role. Offer letter attached.',
        sentAt: T - 1 * DAY,
      },
    ];
    const svc = makeGmailService({ dal, gmailClientFactory: fakeClientFactory(messages), now: () => T });

    const first = await svc.syncAccount(acct.id);
    expect(first.elevated).toBeGreaterThanOrEqual(1);
    expect(dal.applications.get(applicationId)!.status).toBe('offer');

    // a backfill re-pull of the same message must not double-store nor demote/re-elevate
    const second = await svc.syncAccount(acct.id, { backfill: true });
    expect(second.stored).toBe(0); // already stored (dedup by account+provider_msg_id)
    expect(second.elevated).toBe(0); // forward-only guard makes the repeat a no-op
    expect(dal.applications.get(applicationId)!.status).toBe('offer');
    expect(dal.emails.listLean({ accountId: acct.id }).total).toBe(1);
  });

  it('reports token health as expired when the client throws invalid_grant', async () => {
    dal.emails.ensureAccount({ kind: 'gmail_oauth', email: 'me@gmail.com', id: 'acct_rot' });
    const throwingFactory: GmailClientFactory = async () => ({
      listMessages: async () => {
        throw new Error('invalid_grant: token has been expired or revoked');
      },
    });
    const svc = makeGmailService({ dal, gmailClientFactory: throwingFactory, now: () => T });
    const summary = await svc.syncAccount('acct_rot');
    expect(summary.error).toContain('invalid_grant');
    expect(summary.tokenState).toBe('expired');
    const acct = db.prepare('SELECT token_state, auth_fail_count FROM email_accounts WHERE id = ?').get('acct_rot') as {
      token_state: string;
      auth_fail_count: number;
    };
    expect(acct.token_state).toBe('expired');
    expect(acct.auth_fail_count).toBe(1);
  });

  it('exposes a cron expression derived from settings.gmail.syncMinutes', () => {
    const svc = makeGmailService({ dal, gmailClientFactory: fakeClientFactory([]) });
    expect(svc.cronExpression()).toBe('*/15 * * * *'); // default 15
    dal.settings.set('gmail', 'syncMinutes', 30);
    expect(svc.cronExpression()).toBe('*/30 * * * *');
    expect(svc.isRunning()).toBe(false);
  });
});

// ---- pure unit tests: classify ---------------------------------------------------------------------

describe('classifyEmail — the rules ladder', () => {
  it('applies category precedence: offer > rejection > assessment > interview > confirmation > recruiter', () => {
    // an email that mentions BOTH an interview and an offer classifies as offer (higher precedence)
    expect(
      classifyEmail({ subject: 'Interview + offer', body: 'We would like to schedule an interview, and we are pleased to offer you the role.' }).category,
    ).toBe('offer');
    // rejection quoting the stage still reads as rejection (before interview/assessment)
    expect(
      classifyEmail({ subject: 'Update', body: 'Unfortunately we will not be moving forward after your interview.' }).category,
    ).toBe('rejection');
  });

  it('a strong receipt pre-empts interview footer boilerplate (the CMiC bug)', () => {
    const r = classifyEmail({
      subject: 'Application received',
      body: 'Your application has been submitted successfully. We will contact you to schedule an interview if selected.',
    });
    expect(r.category).toBe('application_confirmation');
  });

  it('a neutral-subject rejection is caught by the body, not the subject', () => {
    const r = classifyEmail({ subject: 'Your application', body: 'We regret to inform you that we have decided to pursue other candidates.' });
    expect(r.category).toBe('rejection');
  });

  it('an assessment beats a bare interview mention', () => {
    const r = classifyEmail({ subject: 'Next step', body: 'Please complete this HackerRank coding challenge before we schedule an interview.' });
    expect(r.category).toBe('assessment');
  });

  it('a strong offer scores higher confidence than a soft hit', () => {
    const strong = classifyEmail({ subject: 'Offer', body: 'Please find your offer letter attached.' });
    const soft = classifyEmail({ subject: 'x', body: 'We are excited to offer you a chance to interview.' });
    expect(strong.confidence).toBeGreaterThan(soft.confidence);
    expect(strong.via).toBe('rules');
  });

  it('an unrelated email is other with zero confidence', () => {
    expect(classifyEmail({ subject: 'Your newsletter', body: 'Here is this weeks digest of articles.' })).toEqual({
      category: 'other',
      confidence: 0,
      via: 'rules',
    });
  });
});

// ---- pure unit tests: statusMap --------------------------------------------------------------------

describe('categoryToStatus', () => {
  it('maps status-bearing categories and returns null for non-bearing ones', () => {
    expect(categoryToStatus('offer')).toBe('offer');
    expect(categoryToStatus('rejection')).toBe('rejected');
    expect(categoryToStatus('assessment')).toBe('assessment');
    expect(categoryToStatus('interview')).toBe('interview_1');
    expect(categoryToStatus('application_confirmation')).toBe('submitted');
    expect(categoryToStatus('recruiter')).toBeNull();
    expect(categoryToStatus('other')).toBeNull();
  });
});

// ---- matcher unit tests ----------------------------------------------------------------------------

describe('matchEmailToApplication — the ladder', () => {
  let db: Database;
  let dal: Dal;
  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    dal = makeDal(defaultContext(db, () => {}), { sealer: fakeSealer });
    db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?,?,1,?,?)').run('p1', 'Pierre', T, T);
  });
  afterEach(() => db.close());

  it('the ATS-id rung matches a greenhouse job id in the body and beats fuzzy scoring', () => {
    const { job } = dal.jobs.upsert({ source: 'greenhouse', job_url: 'https://boards.greenhouse.io/acme/jobs/777', external_id: '777', title: 'SWE', company: 'Acme' });
    const appl = dal.applications.ensure(job.id, 'p1');
    const r = matchEmailToApplication(dal, {
      id: 'e1', accountId: 'a', fromAddr: 'no-reply@greenhouse.io', fromName: 'Acme',
      subject: 'Application', body: 'View your application at https://boards.greenhouse.io/acme/jobs/777 thanks',
      threadId: null, inReplyTo: null, refIds: null, sentAt: T,
    });
    expect(r.via).toBe('ats_id');
    expect(r.jobId).toBe(job.id);
    expect(r.applicationId).toBe(appl.id);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('the thread rung inherits the job of an already-matched email in the same thread', () => {
    const { job } = dal.jobs.upsert({ source: 'linkedin', job_url: 'https://www.linkedin.com/jobs/view/5', title: 'PM', company: 'Globex' });
    const appl = dal.applications.ensure(job.id, 'p1');
    // account row must exist for the FK before any email upsert
    const acct = dal.emails.ensureAccount({ kind: 'gmail_oauth', email: 'me@x.com' });
    const prior = dal.emails.upsert({ accountId: acct.id, providerMsgId: 'p1b', threadId: 'thread-A', subject: 'Applied', sentAt: T - DAY });
    dal.emails.setMatch(prior.id, { applicationId: appl.id, jobId: job.id, source: 'auto', confidence: 0.9 });

    const r = matchEmailToApplication(dal, {
      id: 'e-new', accountId: acct.id, fromAddr: 'recruiter@personal.com', fromName: 'Rec',
      subject: 'Re: Applied', body: 'Following up.', threadId: 'thread-A', inReplyTo: null, refIds: null, sentAt: T,
    });
    expect(r.via).toBe('thread');
    expect(r.jobId).toBe(job.id);
  });

  it('an email predating the apply by >2 days is not scored as a match', () => {
    const { job } = dal.jobs.upsert({ source: 'linkedin', job_url: 'https://www.linkedin.com/jobs/view/6', title: 'Dev', company: 'Umbrella' });
    const appl = dal.applications.ensure(job.id, 'p1');
    dal.applications.elevate(appl.id, 'submitted', 'auto');
    db.prepare('UPDATE applications SET submitted_at = ? WHERE id = ?').run(T, appl.id);
    const r = matchEmailToApplication(dal, {
      id: 'e2', accountId: 'a', fromAddr: 'jobs@umbrella.com', fromName: 'Umbrella',
      subject: 'Dev role', body: 'About the Dev position.', threadId: null, inReplyTo: null, refIds: null,
      sentAt: T - 10 * DAY, // 10 days BEFORE the apply
    });
    expect(r.via).toBe('none');
  });
});
