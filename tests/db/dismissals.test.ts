// dismissals DAL tests — Pierre's #1 scar, proven at the data layer.
//
// Exercised against the REAL schema-v1+002 DB (openDatabase runs BOTH migrations from the dir, so the
// `dismissals` table + jobs.dismissed_at exist) and the REAL jobs/applications DALs (so the stored
// dedup keys — norm_key / job_url_norm / company_key — are computed the production way). The scar the
// suite locks down: a dismiss must write all three identity keys, be permanent + idempotent, hide the
// job, and withdraw its application — so isDismissed() can never let a dismissed posting return.
import { describe, it, expect } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import {
  makeDal,
  defaultContext,
  normKey,
  normJobUrl,
  type Dal,
  type Sealer,
} from '../../app/src/main/db/dal/index.js';
import { makeDismissalsDal, type DismissalsDal } from '../../app/src/main/db/dal/dismissals.js';

/** Reversible fake — vitest has no Electron safeStorage; the DAL treats sealed bytes as opaque. */
const fakeSealer: Sealer = {
  available: () => true,
  seal: (p) => Buffer.from(`sealed:${p}`, 'utf8'),
  open: (b) => b.toString('utf8').replace(/^sealed:/, ''),
};

const JOB_URL = 'https://boards.greenhouse.io/acme/jobs/12345?gh_jid=12345&utm_source=x';
const JOB_TITLE = 'Senior TypeScript Engineer';
const JOB_COMPANY = 'Acme Corp';

interface Harness {
  db: DB;
  dal: Dal;
  dismissals: DismissalsDal;
  jobId: string;
  applicationId: string;
}

/** Seed a default profile + one real job (via jobs.upsert → real dedup keys) + its tracked application. */
function makeHarness(): Harness {
  const { db } = openDatabase({ file: ':memory:' });
  const dal = makeDal(defaultContext(db), { sealer: fakeSealer });
  const t = Date.now();
  db.prepare(
    `INSERT INTO profiles (id, name, is_default, data_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  ).run('prof_1', 'Pierre', 1, '{}', t, t);

  const up = dal.jobs.upsert({
    source: 'greenhouse',
    job_url: JOB_URL,
    title: JOB_TITLE,
    company: JOB_COMPANY,
    location: 'Montreal, QC',
  });
  const app = dal.applications.ensure(up.job.id, 'prof_1');

  const dismissals = makeDismissalsDal(dal.ctx);
  return { db, dal, dismissals, jobId: up.job.id, applicationId: app.id };
}

/** The dedup keys the jobs DAL actually stored for the seeded job — the authoritative identities. */
function storedKeys(db: DB, jobId: string): { norm_key: string; job_url_norm: string; company_key: string } {
  return db
    .prepare(`SELECT norm_key, job_url_norm, company_key FROM jobs WHERE id = ?`)
    .get(jobId) as { norm_key: string; job_url_norm: string; company_key: string };
}

function count(db: DB, sql: string, ...bind: unknown[]): number {
  return (db.prepare(sql).get(...bind) as { c: number }).c;
}

describe('dismissals DAL — dismiss() writes all three identity keys', () => {
  it('writes nk: / url: / co: keyed off the STORED dedup keys, all pointing at the job', () => {
    const h = makeHarness();
    const stored = storedKeys(h.db, h.jobId);

    const res = h.dismissals.dismiss(h.jobId, { reason: 'not_a_job', note: 'unrelated page' });
    expect(res).not.toBeNull();
    expect(res!.dismissed).toBe(true);
    expect(res!.reason).toBe('not_a_job');
    expect(res!.keys.sort()).toEqual(
      [`nk:${stored.norm_key}`, `url:${stored.job_url_norm}`, `co:${stored.company_key}`].sort(),
    );

    // all three rows landed in the table, all tagged with the job id + reason.
    const rows = h.db
      .prepare(`SELECT dismiss_key, job_id, reason, note FROM dismissals ORDER BY dismiss_key`)
      .all() as Array<{ dismiss_key: string; job_id: string; reason: string; note: string | null }>;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.job_id).toBe(h.jobId);
      expect(r.reason).toBe('not_a_job');
      expect(r.note).toBe('unrelated page');
    }
    expect(rows.map((r) => r.dismiss_key.split(':')[0]).sort()).toEqual(['co', 'nk', 'url']);
  });

  it('isDismissed is true for EACH key independently, and false for unrelated identities', () => {
    const h = makeHarness();
    const stored = storedKeys(h.db, h.jobId);
    h.dismissals.dismiss(h.jobId);

    // each identity a re-sighting could arrive under resolves to the dismissal on its own.
    expect(h.dismissals.isDismissed({ urlNorm: stored.job_url_norm })).toBe(true);
    expect(h.dismissals.isDismissed({ normKey: stored.norm_key })).toBe(true);
    expect(h.dismissals.isDismissed({ companyKey: stored.company_key })).toBe(true);

    // and via any combination.
    expect(
      h.dismissals.isDismissed({ urlNorm: stored.job_url_norm, normKey: 'nope', companyKey: 'nope' }),
    ).toBe(true);

    // unrelated identities are NOT dismissed.
    expect(
      h.dismissals.isDismissed({ urlNorm: 'other.com/1', normKey: 'other key', companyKey: 'globex' }),
    ).toBe(false);
    // empty / absent keys never block.
    expect(h.dismissals.isDismissed({})).toBe(false);
    expect(h.dismissals.isDismissed({ urlNorm: '', normKey: '', companyKey: '' })).toBe(false);
  });

  it('recomputing the keys the /track way matches the stored ones (the re-track permanence path)', () => {
    const h = makeHarness();
    h.dismissals.dismiss(h.jobId);

    // this is EXACTLY what routes-track computes from the raw {url,title,company} on a re-track.
    const trackKeys = {
      urlNorm: normJobUrl(JOB_URL),
      normKey: normKey(`${JOB_COMPANY} ${JOB_TITLE}`),
      companyKey: normKey(JOB_COMPANY),
    };
    expect(h.dismissals.isDismissed(trackKeys)).toBe(true);
  });
});

describe('dismissals DAL — dismiss() hides the job + withdraws its application', () => {
  it('stamps jobs.dismissed_at and withdraws + un-flags the live application', () => {
    const h = makeHarness();
    // pre-condition: application is live + could be flagged for review.
    h.dal.applications.patch(h.applicationId, { needs_review: true });
    expect(count(h.db, `SELECT COUNT(*) AS c FROM jobs WHERE id = ? AND dismissed_at IS NULL`, h.jobId)).toBe(1);

    h.dismissals.dismiss(h.jobId);

    expect(count(h.db, `SELECT COUNT(*) AS c FROM jobs WHERE id = ? AND dismissed_at IS NOT NULL`, h.jobId)).toBe(1);
    const app = h.db
      .prepare(`SELECT status, needs_review FROM applications WHERE id = ?`)
      .get(h.applicationId) as { status: string; needs_review: number };
    expect(app.status).toBe('withdrawn');
    expect(app.needs_review).toBe(0);
  });

  it('leaves an already-terminal application untouched (a dismissal never rewrites settled history)', () => {
    const h = makeHarness();
    h.dal.applications.elevate(h.applicationId, 'hired'); // settled
    h.dismissals.dismiss(h.jobId);
    const status = (
      h.db.prepare(`SELECT status FROM applications WHERE id = ?`).get(h.applicationId) as {
        status: string;
      }
    ).status;
    expect(status).toBe('hired'); // NOT clobbered to withdrawn
    // but the job row is still hidden.
    expect(count(h.db, `SELECT COUNT(*) AS c FROM jobs WHERE id = ? AND dismissed_at IS NOT NULL`, h.jobId)).toBe(1);
  });
});

describe('dismissals DAL — permanence, idempotence, and edges', () => {
  it('re-dismissing is a harmless no-op (INSERT OR IGNORE) — still exactly three keys', () => {
    const h = makeHarness();
    h.dismissals.dismiss(h.jobId, { reason: 'user' });
    const first = count(h.db, `SELECT COUNT(*) AS c FROM dismissals`);
    expect(first).toBe(3);

    // dismiss again — must not throw, must not duplicate keys.
    expect(() => h.dismissals.dismiss(h.jobId, { reason: 'spam' })).not.toThrow();
    expect(count(h.db, `SELECT COUNT(*) AS c FROM dismissals`)).toBe(3);
    const stored = storedKeys(h.db, h.jobId);
    expect(h.dismissals.isDismissed({ urlNorm: stored.job_url_norm })).toBe(true);
  });

  it('dismiss() on an unknown job id returns null and writes nothing', () => {
    const h = makeHarness();
    expect(h.dismissals.dismiss('job_nope')).toBeNull();
    expect(count(h.db, `SELECT COUNT(*) AS c FROM dismissals`)).toBe(0);
  });

  it('rejects an unknown reason loudly (would-be CHECK violation caught in TS)', () => {
    const h = makeHarness();
    // @ts-expect-error — 'bogus' is not a DismissReason; the DAL throws before any INSERT.
    expect(() => h.dismissals.dismiss(h.jobId, { reason: 'bogus' })).toThrow(/unknown reason/);
    expect(count(h.db, `SELECT COUNT(*) AS c FROM dismissals`)).toBe(0);
  });

  it('listRecent returns ONE entry per dismissed job, joined to the posting, newest-first', () => {
    const h = makeHarness();
    // a second dismissable job.
    const up2 = h.dal.jobs.upsert({ source: 'lever', job_url: 'https://jobs.lever.co/globex/9', title: 'Rust Dev', company: 'Globex' });
    h.dal.applications.ensure(up2.job.id, 'prof_1');

    h.dismissals.dismiss(h.jobId, { reason: 'not_a_job' });
    h.dismissals.dismiss(up2.job.id, { reason: 'off_target' });

    const page = h.dismissals.listRecent();
    expect(page.total).toBe(2); // two JOBS, not six key rows
    expect(page.rows).toHaveLength(2);
    // newest dismissal first (up2 dismissed last).
    expect(page.rows[0]!.job_id).toBe(up2.job.id);
    expect(page.rows[0]!.reason).toBe('off_target');
    expect(page.rows[0]!.key_count).toBe(3);
    const acmeRow = page.rows.find((r) => r.job_id === h.jobId)!;
    expect(acmeRow.job_title).toBe(JOB_TITLE);
    expect(acmeRow.company).toBe(JOB_COMPANY);
  });
});
