// Stage-1 DAL read-surface tests — seed SMALL, assert the LAWS: every list is a {rows,total} page,
// caps clamp, heavy columns never ride in a list projection, funnel is zero-filled + windowed,
// timeline is newest-first, matches are sticky, sensitive answers never land, defaults are singular.
// Runs are seeded with raw SQL (the Stage-1 runs DAL is read-only by design; the importer is the
// only Stage-1 writer of apply_runs).

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../app/src/main/db/index.js';
import {
  makeDal,
  clampLimit,
  type Dal,
  type DalContext,
  type Sealer,
} from '../../app/src/main/db/dal/index.js';
import type { Database } from 'better-sqlite3';

/** Reversible fake — vitest has no Electron safeStorage; the DAL treats sealed bytes as opaque. */
const fakeSealer: Sealer = {
  available: () => true,
  seal: (plaintext) => Buffer.from(`sealed:${plaintext}`, 'utf8'),
  open: (sealed) => sealed.toString('utf8').replace(/^sealed:/, ''),
};

const T0 = 1_750_000_000_000; // fixed epoch base so window math is deterministic
const DAY = 86_400_000;

interface Fixture {
  dal: Dal;
  db: Database;
  clock: { t: number };
}

/** Fresh in-memory DB + DAL with a CONTROLLABLE clock and sequential ids (assert-friendly). */
function fresh(): Fixture {
  const { db } = openDatabase({ file: ':memory:' });
  const clock = { t: T0 };
  let seq = 0;
  const ctx: DalContext = {
    db,
    now: () => clock.t,
    newId: (prefix) => `${prefix}_${String(++seq).padStart(6, '0')}`,
    emit: () => {},
  };
  return { dal: makeDal(ctx, { sealer: fakeSealer }), db, clock };
}

/** Seed one profile + N jobs; returns ids. */
function seedJobs(dal: Dal, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { job } = dal.jobs.upsert({
      source: i % 2 === 0 ? 'linkedin' : 'greenhouse',
      job_url: `https://example.com/jobs/${i}`,
      title: `Engineer ${i}`,
      company: `Acme ${i}`,
      description: `desc ${i}`,
      fit: { score: i },
    });
    ids.push(job.id);
  }
  return ids;
}

// ---- the cap mechanism itself ---------------------------------------------------------------------

describe('clampLimit: the one payload cap', () => {
  it('clamps into [1, max] and falls back to the default', () => {
    expect(clampLimit(undefined, 500)).toBe(500);
    expect(clampLimit(99_999, 500)).toBe(1000); // hard cap
    expect(clampLimit(0, 500)).toBe(1); // floor
    expect(clampLimit(-5, 500)).toBe(1);
    expect(clampLimit(7.9, 500)).toBe(7); // floored int
    expect(clampLimit(600, 500, 500)).toBe(500); // custom max
  });
});

// ---- jobs -------------------------------------------------------------------------------------------

describe('jobs: lean pages + quarantined detail', () => {
  it('listLean returns a {rows,total} page and NEVER ships a description', () => {
    const { dal } = fresh();
    seedJobs(dal, 3);
    const page = dal.jobs.listLean();
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(3);
    expect(page.rows[0]).not.toHaveProperty('description');
    expect(page.rows[0]).not.toHaveProperty('tags_json'); // parsed, not raw
    expect(page.rows[0]!.tags).toEqual([]);
  });

  it('limit/offset page through while total counts the whole filtered set', () => {
    const { dal } = fresh();
    seedJobs(dal, 3);
    const page = dal.jobs.listLean({ limit: 1, offset: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(3);
    const filtered = dal.jobs.listLean({ source: 'linkedin' });
    expect(filtered.total).toBe(2);
    expect(filtered.rows.every((r) => r.source === 'linkedin')).toBe(true);
  });

  it('q search matches title/company with LIKE metacharacters escaped', () => {
    const { dal } = fresh();
    seedJobs(dal, 2);
    dal.jobs.upsert({ source: 'manual', job_url: 'https://x.co/1', title: '50% remote QA' });
    expect(dal.jobs.listLean({ q: 'Acme 1' }).total).toBe(1);
    expect(dal.jobs.listLean({ q: '50%' }).total).toBe(1); // % is literal, not a wildcard
    expect(dal.jobs.listLean({ q: '5%' }).total).toBe(0);
  });

  it('upsert dedups on the normalized URL; a bare re-sighting preserves captured fields', () => {
    const { dal } = fresh();
    const first = dal.jobs.upsert({
      source: 'linkedin',
      job_url: 'https://example.com/jobs/7?utm_source=feed',
      title: 'Staff Eng',
      company: 'Initech',
      description: 'full text',
    });
    expect(first.action).toBe('inserted');
    // Same posting re-seen: tracking param differs, no title/description supplied.
    const again = dal.jobs.upsert({ source: 'linkedin', job_url: 'https://example.com/jobs/7' });
    expect(again.action).toBe('updated');
    expect(again.job.id).toBe(first.job.id);
    expect(again.job.title).toBe('Staff Eng'); // not blanked
    expect(dal.jobs.listLean().total).toBe(1);
    expect(dal.jobs.getDetail(first.job.id)!.description).toBe('full text'); // kept
  });

  it('getDetail hydrates the quarantined heavy columns', () => {
    const { dal } = fresh();
    const [id] = seedJobs(dal, 1);
    const detail = dal.jobs.getDetail(id!)!;
    expect(detail.description).toBe('desc 0');
    expect(detail.fit).toEqual({ score: 0 });
    expect(dal.jobs.getDetail('job_nope')).toBeUndefined();
  });
});

// ---- applications + THE funnel ---------------------------------------------------------------------

describe('applications: lean list, hydrated detail, funnel authority', () => {
  function seedApps(f: Fixture) {
    const profile = f.dal.profiles.create({ name: 'Pierre' });
    const jobs = seedJobs(f.dal, 3);
    const a = f.dal.applications.ensure(jobs[0]!, profile.id);
    const b = f.dal.applications.ensure(jobs[1]!, profile.id);
    const c = f.dal.applications.ensure(jobs[2]!, profile.id);
    return { profile, jobs, a, b, c };
  }

  it('listLean ships NO heavy JSON/notes columns; ensure is idempotent', () => {
    const f = fresh();
    const { a, jobs, profile } = seedApps(f);
    expect(f.dal.applications.ensure(jobs[0]!, profile.id).id).toBe(a.id); // same row back
    const page = f.dal.applications.listLean();
    expect(page.total).toBe(3);
    expect(page.rows[0]).not.toHaveProperty('answers_json');
    expect(page.rows[0]).not.toHaveProperty('attachments_json');
    expect(page.rows[0]).not.toHaveProperty('notes');
  });

  it('getDetail hydrates answers/attachments', () => {
    const f = fresh();
    const { a } = seedApps(f);
    f.dal.applications.patch(a.id, { answers_json: [{ q: 'q1', a: 'a1' }], notes: 'hello' });
    const detail = f.dal.applications.getDetail(a.id)!;
    expect(detail.answers).toEqual([{ q: 'q1', a: 'a1' }]);
    expect(detail.attachments).toEqual([]);
    expect(detail.notes).toBe('hello');
  });

  it('funnel is zero-filled across ALL 12 statuses and counts the window', () => {
    const f = fresh();
    const { a, b } = seedApps(f);
    f.dal.applications.elevate(a.id, 'submitted', 'auto');
    f.dal.applications.elevate(b.id, 'rejected');
    const funnel = f.dal.applications.funnel({ days: 30 });
    expect(Object.keys(funnel).sort()).toEqual(
      [
        'tracked', 'submitted', 'acknowledged', 'assessment',
        'interview_1', 'interview_2', 'interview_final',
        'offer', 'hired', 'rejected', 'withdrawn', 'ghosted',
      ].sort(),
    );
    expect(funnel.submitted).toBe(1);
    expect(funnel.rejected).toBe(1);
    expect(funnel.tracked).toBe(1);
    expect(funnel.offer).toBe(0); // zero-filled, key present
  });

  it('funnel window excludes rows not touched within the trailing days', () => {
    const f = fresh();
    const { a } = seedApps(f); // 3 apps updated at T0
    f.dal.applications.elevate(a.id, 'submitted');
    f.clock.t = T0 + 40 * DAY; // 40 days later…
    const profile2 = f.dal.profiles.getDefault()!;
    const job = f.dal.jobs.upsert({ source: 'manual', job_url: 'https://x.co/new' }).job;
    f.dal.applications.ensure(job.id, profile2.id); // one fresh row
    const funnel = f.dal.applications.funnel({ days: 30 });
    expect(funnel.submitted).toBe(0); // aged out of the window
    expect(funnel.tracked).toBe(1); // only the fresh one
  });

  it('elevate is forward-only: backward moves and terminal reopen throw; submitted_at stamps once', () => {
    const f = fresh();
    const { a } = seedApps(f);
    f.dal.applications.elevate(a.id, 'submitted');
    const sub = f.dal.applications.get(a.id)!;
    expect(sub.submitted_at).toBe(f.clock.t);
    expect(() => f.dal.applications.elevate(a.id, 'tracked')).toThrow(/backward/);
    f.dal.applications.elevate(a.id, 'rejected');
    expect(() => f.dal.applications.elevate(a.id, 'interview_1')).toThrow(/terminal/);
    // withdraw is the one terminal carve-out
    expect(f.dal.applications.elevate(a.id, 'withdrawn').status).toBe('withdrawn');
  });
});

// ---- events: THE timeline ---------------------------------------------------------------------------

describe('events: append-only timeline', () => {
  it('timeline(applicationId) is newest-first, paged, with an unbounded total', () => {
    const f = fresh();
    const profile = f.dal.profiles.create({ name: 'P' });
    const job = f.dal.jobs.upsert({ source: 'manual', job_url: 'https://x.co/j' }).job;
    const appl = f.dal.applications.ensure(job.id, profile.id);

    f.dal.events.record({ kind: 'created', applicationId: appl.id, summary: 'first' });
    f.clock.t += 1000;
    f.dal.events.record({ kind: 'status_change', applicationId: appl.id, data: { to: 'submitted' } });
    f.clock.t += 1000;
    f.dal.events.record({ kind: 'note', applicationId: appl.id, summary: 'latest' });
    f.dal.events.record({ kind: 'imported', summary: 'unrelated' }); // NOT on this timeline

    const page = f.dal.events.timeline(appl.id, { limit: 2 });
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]!.summary).toBe('latest'); // newest first
    expect(page.rows[1]!.kind).toBe('status_change');
    expect(page.rows[1]!.data).toEqual({ to: 'submitted' }); // data_json hydrated
    const rest = f.dal.events.timeline(appl.id, { limit: 2, offset: 2 });
    expect(rest.rows).toHaveLength(1);
    expect(rest.rows[0]!.summary).toBe('first');
  });

  it('record throws LOUDLY on an unknown kind; recent() filters kinds', () => {
    const f = fresh();
    expect(() => f.dal.events.record({ kind: 'nonsense' as never })).toThrow(/unknown kind/);
    f.dal.events.record({ kind: 'imported', summary: 'i' });
    f.dal.events.record({ kind: 'note', summary: 'n' });
    expect(f.dal.events.recent({ kinds: ['note'] }).total).toBe(1);
    expect(f.dal.events.recent({ kinds: ['bogus'] })).toEqual({ rows: [], total: 0 });
    expect(f.dal.events.recent().total).toBe(2);
  });
});

// ---- emails: quarantined body, sticky matches, suggestion queue --------------------------------------

describe('emails: inbox projections + match pipeline rules', () => {
  function seedInbox(f: Fixture) {
    const profile = f.dal.profiles.create({ name: 'P' });
    const job = f.dal.jobs.upsert({ source: 'manual', job_url: 'https://x.co/j' }).job;
    const appl = f.dal.applications.ensure(job.id, profile.id);
    const acct = f.dal.emails.ensureAccount({ kind: 'imported', email: 'me@x.co' });
    const e1 = f.dal.emails.upsert({
      accountId: acct.id, providerMsgId: 'm1', subject: 'Interview!', snippet: 's1',
      body: 'the full body text', sentAt: T0, category: 'interview',
    });
    f.clock.t += 1000;
    const e2 = f.dal.emails.upsert({
      accountId: acct.id, providerMsgId: 'm2', subject: 'Maybe related', snippet: 's2', sentAt: T0 + 1000,
    });
    return { profile, job, appl, acct, e1, e2 };
  }

  it('list projections never carry the body; getBody is the one sanctioned read', () => {
    const f = fresh();
    const { e1 } = seedInbox(f);
    const page = f.dal.emails.listLean();
    expect(page.total).toBe(2);
    expect(page.rows[0]).not.toHaveProperty('body');
    expect(f.dal.emails.getBody(e1.id)).toBe('the full body text');
  });

  it('upsert dedups per (account, provider_msg_id) and enriches instead of blanking', () => {
    const f = fresh();
    const { acct, e1 } = seedInbox(f);
    const again = f.dal.emails.upsert({
      accountId: acct.id, providerMsgId: 'm1', subject: 'Interview!', snippet: 's1', category: 'interview',
    }); // no body this time
    expect(again).toEqual({ id: e1.id, action: 'updated' });
    expect(f.dal.emails.getBody(e1.id)).toBe('the full body text'); // COALESCE kept it
    expect(f.dal.emails.listLean().total).toBe(2);
  });

  it('listForApplication pages matched emails; suggestions join the pending match', () => {
    const f = fresh();
    const { appl, job, e1, e2 } = seedInbox(f);
    f.dal.emails.setMatch(e1.id, { applicationId: appl.id, source: 'auto', confidence: 0.9, matchVia: 'thread' });
    f.dal.emails.setMatch(e2.id, { applicationId: appl.id, jobId: job.id, source: 'suggested', confidence: 0.4, matchVia: 'score' });

    const matched = f.dal.emails.listForApplication(appl.id);
    expect(matched.total).toBe(2);
    expect(matched.rows[0]).not.toHaveProperty('body');

    const sugg = f.dal.emails.suggestions();
    expect(sugg.total).toBe(1);
    expect(sugg.rows[0]!.id).toBe(e2.id);
    expect(sugg.rows[0]!.application_id).toBe(appl.id);
    expect(sugg.rows[0]!.confidence).toBe(0.4);
    expect(sugg.rows[0]!.match_via).toBe('score');
  });

  it('a manual/dismissed decision is STICKY against auto/suggested; dismissed leaves reads', () => {
    const f = fresh();
    const { appl, e1 } = seedInbox(f);
    f.dal.emails.setMatch(e1.id, { applicationId: appl.id, source: 'manual', matchVia: 'user' });
    const clobbered = f.dal.emails.setMatch(e1.id, { source: 'suggested', confidence: 0.99 });
    expect(clobbered.source).toBe('manual'); // human decision wins
    f.dal.emails.setMatch(e1.id, { applicationId: appl.id, source: 'dismissed' });
    expect(f.dal.emails.listForApplication(appl.id).total).toBe(0); // dismissed never returns
  });
});

// ---- documents: bytes in DB, dedup, default law -------------------------------------------------------

describe('documents: lean metadata, blob roundtrip, one default per role', () => {
  it('listLean never ships bytes; getBytes roundtrips; sha dedup returns the existing doc', () => {
    const f = fresh();
    const bytes = Buffer.from('PDF-ish bytes here');
    const doc = f.dal.documents.add({ name: 'resume.pdf', role: 'resume', bytes, mime: 'application/pdf' });
    expect(doc.is_default).toBe(true); // first of its role
    const dup = f.dal.documents.add({ name: 'copy.pdf', role: 'resume', bytes });
    expect(dup.id).toBe(doc.id); // content-addressed dedup
    const page = f.dal.documents.listLean();
    expect(page.total).toBe(1);
    expect(page.rows[0]).not.toHaveProperty('bytes');
    expect(f.dal.documents.getBytes(doc.id)!.equals(bytes)).toBe(true);
  });

  it('setDefault swaps atomically within a role; remove cascades the blob', () => {
    const f = fresh();
    const d1 = f.dal.documents.add({ name: 'a.pdf', role: 'resume', bytes: Buffer.from('aaa') });
    const d2 = f.dal.documents.add({ name: 'b.pdf', role: 'resume', bytes: Buffer.from('bbb') });
    expect(d1.is_default).toBe(true);
    expect(d2.is_default).toBe(false);
    f.dal.documents.setDefault(d2.id);
    const byId = new Map(f.dal.documents.listLean().rows.map((r) => [r.id, r]));
    expect(byId.get(d1.id)!.is_default).toBe(false);
    expect(byId.get(d2.id)!.is_default).toBe(true);

    expect(f.dal.documents.remove(d1.id)).toBe(true);
    expect(f.dal.documents.getBytes(d1.id)).toBeUndefined(); // FK cascade took the blob
    expect(f.dal.documents.listLean().total).toBe(1);
  });

  it('generated docs never steal the role default; lineage columns persist and filter', () => {
    const f = fresh();
    const profile = f.dal.profiles.create({ name: 'P' });
    const job = f.dal.jobs.upsert({ source: 'manual', job_url: 'https://x.co/j' }).job;
    const appl = f.dal.applications.ensure(job.id, profile.id);
    const master = f.dal.documents.add({ name: 'master.pdf', role: 'resume', bytes: Buffer.from('m') });
    const gen = f.dal.documents.add({
      name: 'tailored.pdf', role: 'resume', bytes: Buffer.from('t'), source: 'generated',
      derivedFrom: master.id, applicationId: appl.id, guardrailStatus: 'passed',
    });
    expect(master.is_default).toBe(true); // the library master holds the role default
    expect(gen.is_default).toBe(false); // a tailored one-off never steals it
    expect(gen.derived_from).toBe(master.id);
    expect(gen.guardrail_status).toBe('passed');
    const forAppl = f.dal.documents.listLean({ applicationId: appl.id });
    expect(forAppl.total).toBe(1);
    expect(forAppl.rows[0]!.id).toBe(gen.id);
  });
});

// ---- answers: ask-once-ever memory --------------------------------------------------------------------

describe('answers: lean list w/ q search, full get, sensitive drop, provenance rank', () => {
  it('list is LEAN (no value/options); get(id) returns the full value', () => {
    const f = fresh();
    const p = f.dal.profiles.create({ name: 'P' });
    const rec = f.dal.answers.record(p.id, {
      kind: 'qa', label: 'How many years of experience with Rust?', value: '4', provenance: 'user',
    })!;
    const page = f.dal.answers.list(p.id);
    expect(page.total).toBe(1);
    expect(page.rows[0]).not.toHaveProperty('value');
    expect(page.rows[0]).not.toHaveProperty('options');
    expect(f.dal.answers.get(rec.id)!.value).toBe('4');
  });

  it('q searches label/key with escaped LIKE; kind filters', () => {
    const f = fresh();
    const p = f.dal.profiles.create({ name: 'P' });
    f.dal.answers.record(p.id, { kind: 'qa', label: 'Years of experience with Rust', value: '4' });
    f.dal.answers.record(p.id, { kind: 'field', label: 'City', value: 'Montreal' });
    expect(f.dal.answers.list(p.id, { q: 'rust' }).total).toBe(1);
    expect(f.dal.answers.list(p.id, { kind: 'field' }).total).toBe(1);
    expect(f.dal.answers.list(p.id, { q: '100%_match' }).total).toBe(0); // no wildcard injection
  });

  it('SECURITY: sensitive keys are dropped before any insert', () => {
    const f = fresh();
    const p = f.dal.profiles.create({ name: 'P' });
    expect(f.dal.answers.record(p.id, { kind: 'qa', label: 'What is your gender?', value: 'x' })).toBeNull();
    expect(f.dal.answers.record(p.id, { kind: 'qa', label: 'Date of birth', value: 'x' })).toBeNull();
    expect(f.dal.answers.record(p.id, { kind: 'qa', label: 'Salary history', value: 'x' })).toBeNull();
    expect(f.dal.answers.list(p.id).total).toBe(0);
    // benign near-misses still store:
    expect(f.dal.answers.record(p.id, { kind: 'qa', label: 'Salary expectations', value: '100k' })).not.toBeNull();
  });

  it('a lower-provenance write never clobbers a higher one; sightings still count', () => {
    const f = fresh();
    const p = f.dal.profiles.create({ name: 'P' });
    f.dal.answers.record(p.id, { kind: 'field', label: 'Phone', value: '555-1111', provenance: 'user' });
    const after = f.dal.answers.record(p.id, { kind: 'field', label: 'Phone', value: '555-9999', provenance: 'harvest' })!;
    expect(after.value).toBe('555-1111'); // user truth preserved
    expect(after.seen_count).toBe(2); // sighting counted
  });
});

// ---- profiles ------------------------------------------------------------------------------------------

describe('profiles: get/default, hydrated data, singular default', () => {
  it('first create becomes THE default; get hydrates data_json', () => {
    const f = fresh();
    const p1 = f.dal.profiles.create({ name: 'Pierre', data: { firstName: 'Pierre', city: 'Montreal' } });
    expect(p1.is_default).toBe(true);
    expect(f.dal.profiles.getDefault()!.id).toBe(p1.id);
    expect(f.dal.profiles.get(p1.id)!.data).toEqual({ firstName: 'Pierre', city: 'Montreal' });

    const p2 = f.dal.profiles.create({ name: 'Dad' });
    expect(p2.is_default).toBe(false);
    expect(f.dal.profiles.list().total).toBe(2);
    expect(f.dal.profiles.list().rows[0]!.id).toBe(p1.id); // default sorts first
    expect(f.dal.profiles.list().rows[0]).not.toHaveProperty('data'); // lean

    f.dal.profiles.setDefault(p2.id);
    expect(f.dal.profiles.getDefault()!.id).toBe(p2.id);
  });

  it('ensureDefault is idempotent; oversized data_json throws loudly', () => {
    const f = fresh();
    const p = f.dal.profiles.ensureDefault('Me');
    expect(f.dal.profiles.ensureDefault('Other').id).toBe(p.id);
    expect(() =>
      f.dal.profiles.create({ name: 'Big', data: { blob: 'x'.repeat(262_144) } }),
    ).toThrow(/schema cap/);
  });
});

// ---- runs (read-only surface over importer-written rows) ------------------------------------------------

describe('runs: lean list + hydrated get over seeded history', () => {
  function seedRuns(f: Fixture) {
    const profile = f.dal.profiles.create({ name: 'P' });
    const job = f.dal.jobs.upsert({ source: 'linkedin', job_url: 'https://x.co/j' }).job;
    const appl = f.dal.applications.ensure(job.id, profile.id);
    // Raw SQL seeding is the test stand-in for the importer (the only Stage-1 apply_runs writer).
    const ins = f.db.prepare(
      `INSERT INTO apply_runs (id, application_id, job_id, profile_id, source, lane, state, park_kind,
         pending_questions_json, evidence_kind, evidence_json, queued_at, finished_at, updated_at)
       VALUES (@id, @appl, @job, @prof, 'linkedin', 'linkedin', @state, @park, @pending, @ekind, @ejson, @t, @fin, @t)`,
    );
    ins.run({
      id: 'run_a', appl: appl.id, job: job.id, prof: profile.id, state: 'parked', park: 'needs_answer',
      pending: '[{"q":"Years of Rust?"}]', ekind: null, ejson: null, t: T0, fin: T0 + 5000,
    });
    ins.run({
      id: 'run_b', appl: appl.id, job: job.id, prof: profile.id, state: 'submitted', park: null,
      pending: '[]', ekind: 'confirm_signal', ejson: '{"url":"https://x.co/done"}', t: T0 + 1000, fin: T0 + 9000,
    });
    f.db.prepare(
      `INSERT INTO apply_run_steps (run_id, seq, at, phase, action) VALUES
        ('run_b', 1, ${T0}, 'open', 'open_tab'), ('run_b', 2, ${T0 + 100}, 'classify', 'page_key')`,
    ).run();
    return { appl };
  }

  it('listLean is a page with NO evidence/pending blobs; applicationId filters', () => {
    const f = fresh();
    const { appl } = seedRuns(f);
    const page = f.dal.runs.listLean({ applicationId: appl.id });
    expect(page.total).toBe(2);
    expect(page.rows[0]!.id).toBe('run_b'); // newest queued_at first
    expect(page.rows[0]).not.toHaveProperty('evidence_json');
    expect(page.rows[0]).not.toHaveProperty('pending_questions');
    expect(f.dal.runs.listLean({ state: 'submitted' }).total).toBe(1);
  });

  it('get hydrates evidence + pending questions; getSteps orders by seq', () => {
    const f = fresh();
    seedRuns(f);
    const parked = f.dal.runs.get('run_a')!;
    expect(parked.pending_questions).toEqual([{ q: 'Years of Rust?' }]);
    const submitted = f.dal.runs.get('run_b')!;
    expect(submitted.evidence).toEqual({ url: 'https://x.co/done' });
    const steps = f.dal.runs.getSteps('run_b');
    expect(steps.map((s) => s.seq)).toEqual([1, 2]);
    expect(steps[0]!.ok).toBe(true);
  });

  it('stats windows by queued_at and groups by state', () => {
    const f = fresh();
    seedRuns(f);
    f.clock.t = T0 + 2 * 3_600_000; // 2h after the seeds
    const s = f.dal.runs.stats({ hours: 24 });
    expect(s.total).toBe(2);
    expect(s.byState['submitted']).toBe(1);
    expect(s.byState['parked']).toBe(1);
    expect(f.dal.runs.stats({ hours: 24, lane: 'indeed' }).total).toBe(0);
  });
});
