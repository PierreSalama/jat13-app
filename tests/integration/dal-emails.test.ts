import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';

const fakeSealer: Sealer = { available: () => true, seal: (p) => Buffer.from(p), open: (b) => Buffer.from(b).toString() };

describe('emails DAL', () => {
  let db: Database;
  let dal: Dal;
  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    dal = makeDal(defaultContext(db), { sealer: fakeSealer });
    db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?,?,1,?,?)').run('p1', 'Pierre', 1, 1);
    db.prepare('INSERT INTO jobs (id, source, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('j1', 'linkedin', 1, 1, 1, 1);
    dal.applications.ensure('j1', 'p1');
  });
  afterEach(() => db.close());

  it('creates a synthetic account and dedups emails by (account, provider_msg_id)', () => {
    const acct = dal.emails.ensureAccount({ kind: 'imported', email: 'me@x.com', label: 'Imported' });
    const a = dal.emails.upsert({ accountId: acct.id, providerMsgId: 'm1', subject: 'Application received', fromAddr: 'jobs@corp.com' });
    expect(a.action).toBe('inserted');
    const b = dal.emails.upsert({ accountId: acct.id, providerMsgId: 'm1', subject: 'Application received (updated)' });
    expect(b.action).toBe('updated');
    expect(b.id).toBe(a.id);
    expect(dal.emails.listLean().total).toBe(1);
  });

  it('a manual/dismissed match is sticky — auto never clobbers it', () => {
    const acct = dal.emails.ensureAccount({ kind: 'imported', email: 'me@x.com' });
    const appl = dal.applications.ensure('j1', 'p1');
    const { id: emlId } = dal.emails.upsert({ accountId: acct.id, providerMsgId: 'm2', subject: 'Interview invite' });

    dal.emails.setMatch(emlId, { applicationId: appl.id, jobId: 'j1', source: 'manual', confidence: 1 });
    // an automated re-match must NOT overwrite the human decision
    const after = dal.emails.setMatch(emlId, { applicationId: appl.id, source: 'auto', confidence: 0.6 });
    expect(after.source).toBe('manual');
    expect(after.confidence).toBe(1);

    // a dismissal is likewise sticky against auto
    const { id: e2 } = dal.emails.upsert({ accountId: acct.id, providerMsgId: 'm3', subject: 'Newsletter' });
    dal.emails.setMatch(e2, { source: 'dismissed' });
    expect(dal.emails.setMatch(e2, { applicationId: appl.id, source: 'auto', confidence: 0.9 }).source).toBe('dismissed');
  });

  it('lists matches for an application and surfaces suggestions', () => {
    const acct = dal.emails.ensureAccount({ kind: 'imported', email: 'me@x.com' });
    const appl = dal.applications.ensure('j1', 'p1');
    const { id: e1 } = dal.emails.upsert({ accountId: acct.id, providerMsgId: 'm4', subject: 'Confirmed', sentAt: 100 });
    const { id: e2 } = dal.emails.upsert({ accountId: acct.id, providerMsgId: 'm5', subject: 'Maybe yours?', sentAt: 200 });
    dal.emails.setMatch(e1, { applicationId: appl.id, jobId: 'j1', source: 'auto', confidence: 0.9 });
    dal.emails.setMatch(e2, { applicationId: appl.id, jobId: 'j1', source: 'suggested', confidence: 0.5 });

    expect(dal.emails.listForApplication(appl.id).map((r) => r.id).sort()).toEqual([e1, e2].sort());
    expect(dal.emails.unmatchedSuggestions().map((r) => r.id)).toEqual([e2]);
  });

  it('quarantines body from list projections', () => {
    const acct = dal.emails.ensureAccount({ kind: 'imported', email: 'me@x.com' });
    const { id } = dal.emails.upsert({ accountId: acct.id, providerMsgId: 'm6', subject: 'S', body: 'SECRET-BODY-TEXT' });
    const listed = dal.emails.listLean().rows[0]!;
    expect(JSON.stringify(listed)).not.toContain('SECRET-BODY-TEXT');
    expect(dal.emails.getBody(id)).toBe('SECRET-BODY-TEXT');
  });
});
