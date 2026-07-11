// ingest chokepoint tests — Pierre's 2026-07-10 scar, proven both ways: (1) the is-a-job GATE rejects
// non-postings on EVERY path (extension /track AND discovery), and (2) a DISMISSED posting can NEVER
// return, even re-ingested under a fresh external_id / new row id. Also covers the funnel tally, that a
// single bad candidate never throws (one weird page can't wedge a lane), and the /track chokepoint
// (job dedup + application ensure). The dismiss surface is the AUTHORITATIVE db/dal/dismissals.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { makeDiscoveryDal, type DiscoveryDal } from '../../app/src/main/db/dal/discovery.js';
import { makeDismissalsDal, type DismissalsDal } from '../../app/src/main/db/dal/dismissals.js';
import { makeRegistry, loadBuiltins, type Registry } from '../../app/src/main/adapters/registry.js';
import { makeIngest, isJobPosting, candidateKeys, type Ingest, type IngestCandidate } from '../../app/src/main/discovery/ingest.js';

const fakeSealer: Sealer = { available: () => true, seal: (p) => Buffer.from(p), open: (b) => Buffer.from(b).toString() };

let db: Database;
let dal: Dal;
let discoveryDal: DiscoveryDal;
let dismissals: DismissalsDal;
let registry: Registry;
let ingest: Ingest;

beforeEach(() => {
  ({ db } = openDatabase({ file: ':memory:' }));
  dal = makeDal(defaultContext(db), { sealer: fakeSealer });
  discoveryDal = makeDiscoveryDal(dal.ctx);
  dismissals = makeDismissalsDal(dal.ctx);
  registry = makeRegistry(loadBuiltins());
  ingest = makeIngest({ dal, discoveryDal, registry, dismissals });
  discoveryDal.sourceUpsert('linkedin'); // give the sighting a source row
  db.prepare('INSERT INTO profiles (id,name,is_default,data_json,created_at,updated_at) VALUES (?,?,1,?,?,?)').run('p1', 'Pierre', '{}', 1, 1);
});
afterEach(() => db.close());

const linkedinJob: IngestCandidate = {
  source: 'linkedin',
  job_url: 'https://www.linkedin.com/jobs/view/123',
  title: 'Software Engineer',
  company: 'Acme',
  location: 'Toronto, ON',
};

const jobCount = (): number => (db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c;
/** pre-seed a dismissal by raw key (no job row yet) — the authoritative dismiss() needs a job id. */
function seedDismissKey(key: string): void {
  db.prepare("INSERT OR IGNORE INTO dismissals (dismiss_key, job_id, reason, dismissed_at) VALUES (?, NULL, 'not_a_job', ?)").run(key, Date.now());
}

describe('isJobPosting — the is-a-job gate', () => {
  it('accepts a real posting on a known job host', () => {
    expect(isJobPosting(linkedinJob, registry).ok).toBe(true);
    expect(isJobPosting({ ...linkedinJob, job_url: 'https://boards.greenhouse.io/acme/jobs/9', source: 'greenhouse' }, registry).ok).toBe(true);
  });

  it("rejects a bare unrelated page — reason 'not_a_job'", () => {
    const r = isJobPosting({ source: 'x', job_url: 'https://example.com/blog/why-i-love-tabs', title: 'Why I love tabs', company: 'Acme' }, registry);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_a_job');
  });

  it('rejects missing title, missing company, and non-http urls', () => {
    expect(isJobPosting({ ...linkedinJob, title: '' }, registry).ok).toBe(false);
    expect(isJobPosting({ ...linkedinJob, company: '' }, registry).ok).toBe(false);
    expect(isJobPosting({ ...linkedinJob, job_url: 'mailto:jobs@acme.com' }, registry).ok).toBe(false);
    expect(isJobPosting({ ...linkedinJob, job_url: 'not a url' }, registry).ok).toBe(false);
  });

  it('jobGate is the boolean {url,title,company} adapter the /track route injects', () => {
    expect(ingest.jobGate({ url: linkedinJob.job_url, title: 'Software Engineer', company: 'Acme' })).toBe(true);
    expect(ingest.jobGate({ url: 'https://example.com/about', title: 'About', company: 'Acme' })).toBe(false);
  });
});

describe('ingestOne — gate → dismiss → upsert', () => {
  it('accepts a new posting, then counts a re-ingest as a duplicate', () => {
    expect(ingest.ingestOne(linkedinJob, { sourceId: 'src_linkedin' }).outcome).toBe('accepted');
    expect(jobCount()).toBe(1);
    expect(ingest.ingestOne(linkedinJob, { sourceId: 'src_linkedin' }).outcome).toBe('duplicate');
    expect(jobCount()).toBe(1);
    const sight = db.prepare('SELECT seen_count FROM job_sightings WHERE source_id = ?').get('src_linkedin') as { seen_count: number };
    expect(sight.seen_count).toBe(2);
  });

  it('rejects a non-job (counted, never thrown) and creates no row', () => {
    const r = ingest.ingestOne({ source: 'x', job_url: 'https://example.com/about', title: 'About us', company: 'Acme' });
    expect(r.outcome).toBe('rejected');
    expect(jobCount()).toBe(0);
  });
});

describe('permanent dismiss — a dismissed posting can NEVER return', () => {
  it('a dismiss written BEFORE ingest blocks creation entirely', () => {
    seedDismissKey('url:' + candidateKeys(linkedinJob).urlNorm);
    expect(ingest.ingestOne(linkedinJob, { sourceId: 'src_linkedin' }).outcome).toBe('dismissed');
    expect(jobCount()).toBe(0);
  });

  it('a dismiss AFTER ingest prevents the same posting re-arriving under a fresh external_id / url query', () => {
    const created = ingest.ingestOne(linkedinJob, { sourceId: 'src_linkedin' });
    expect(created.outcome).toBe('accepted');
    // authoritative dismiss reads the STORED dedup keys off the jobs row and writes nk:/url:/co:.
    expect(dismissals.dismiss(created.jobId!, { reason: 'not_a_job' })).not.toBeNull();

    // same posting, different external_id → still dismissed (nk:/url: identity survives).
    expect(ingest.ingestOne({ ...linkedinJob, external_id: 'brand-new-id' }, { sourceId: 'src_linkedin' }).outcome).toBe('dismissed');
    // re-post under a tracking-query variant that normalizes to the same url → still dismissed.
    expect(ingest.ingestOne({ ...linkedinJob, job_url: 'https://www.linkedin.com/jobs/view/123/?utm=x&trk=y' }, {}).outcome).toBe('dismissed');
    // the specific row is marked dismissed (views hide it).
    const row = db.prepare('SELECT dismissed_at FROM jobs WHERE id = ?').get(created.jobId) as { dismissed_at: number | null };
    expect(row.dismissed_at).not.toBeNull();
  });
});

describe('ingestBatch — the funnel tally', () => {
  it('tallies accepted / duplicate / rejected / dismissed across a mixed batch without throwing', () => {
    seedDismissKey('url:' + candidateKeys({ source: 'linkedin', job_url: 'https://www.linkedin.com/jobs/view/555', company: 'Dismissed Co', title: 'Dev' }).urlNorm);
    const batch: IngestCandidate[] = [
      linkedinJob, // accepted
      linkedinJob, // duplicate (same posting again in the same batch)
      { source: 'x', job_url: 'https://example.com/careers-blog', title: 'Our culture', company: 'Acme' }, // rejected (unknown host)
      { source: 'linkedin', job_url: 'https://www.linkedin.com/jobs/view/555', title: 'Dev', company: 'Dismissed Co' }, // dismissed
    ];
    const r = ingest.ingestBatch(batch, { sourceId: 'src_linkedin' });
    expect(r).toMatchObject({ found: 4, accepted: 1, duplicate: 1, rejected: 1, dismissed: 1 });
    expect(r.jobIds.length).toBe(2); // accepted + duplicate both resolve to a job id
  });
});

describe('track — the /track chokepoint (job dedup + application ensure)', () => {
  it('creates a job + a tracked application, and dedups on a repeat track', () => {
    const first = ingest.track({ url: linkedinJob.job_url, title: 'Software Engineer', company: 'Acme' });
    expect(first.jobId).toBeTruthy();
    expect(first.applicationId).toBeTruthy();
    const appl = db.prepare('SELECT status FROM applications WHERE id = ?').get(first.applicationId) as { status: string };
    expect(appl.status).toBe('tracked');
    // repeat track = same job + same application (UNIQUE job_id+profile_id).
    const again = ingest.track({ url: linkedinJob.job_url, title: 'Software Engineer', company: 'Acme' });
    expect(again).toEqual(first);
    expect(jobCount()).toBe(1);
  });
});
