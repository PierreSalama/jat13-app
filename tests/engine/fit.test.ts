// Deterministic fit scorer (Stage 3) tests. Proves the four contract points:
//   1. a strong-match job scores HIGH with a title-match reason,
//   2. an off-country / over-senior job scores BELOW the floor (30) with the reason,
//   3. scoreFor CACHES a fit_scores row (scorer='deterministic') + syncs the jobs.fit_score cache,
//   4. floor() reads settings.autoApply.fitFloor (and falls back to 30 when unregistered).
// Plus: never-throws on a missing job, and scoreEligible fills only UNSCORED, non-dismissed jobs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { makeFitService, scoreDeterministic, type FitSettingsSource } from '../../app/src/main/engine/fit.js';

const fakeSealer: Sealer = { available: () => true, seal: (p) => Buffer.from(p), open: (b) => Buffer.from(b).toString() };

let db: Database;
let dal: Dal;

// A fake settings source: agent E registers 'autoApply' for real; here we inject the section directly
// so the scorer's contract is proven without depending on E's registry landing first.
function settingsOf(autoApply: Record<string, unknown>): FitSettingsSource {
  return {
    get(section: string): Record<string, unknown> {
      if (section === 'autoApply') return autoApply;
      throw new Error(`unknown settings section: ${section}`);
    },
  };
}

// Settings that resemble Pierre's real config: Canada, mid ceiling, react/node keywords, remote/hybrid.
const PIERRE = {
  fitFloor: 30,
  country: 'Canada',
  locations: ['Toronto'],
  keywords: ['react', 'node', 'typescript'],
  seniorityMax: 'senior',
  workModes: ['remote', 'hybrid'],
};

function seedProfile(id: string, data: Record<string, unknown>): void {
  db.prepare('INSERT INTO profiles (id, name, is_default, data_json, created_at, updated_at) VALUES (?,?,1,?,?,?)').run(
    id,
    'Pierre',
    JSON.stringify(data),
    1,
    1,
  );
}

/** Insert a job via the real DAL (so job_details carries the description the scorer reads). */
function seedJob(input: {
  title: string;
  description?: string;
  location?: string;
  work_mode?: 'remote' | 'hybrid' | 'onsite' | null;
  apply_capability?: 'easy_apply' | 'smartapply' | 'ats_form' | 'external' | 'account_wall' | 'unknown';
  source?: string;
  url: string;
}): string {
  const res = dal.jobs.upsert({
    source: input.source ?? 'linkedin',
    job_url: input.url,
    title: input.title,
    company: 'Acme',
    location: input.location ?? '',
    work_mode: input.work_mode ?? null,
    apply_capability: input.apply_capability ?? 'unknown',
    description: input.description ?? '',
  });
  return res.job.id;
}

beforeEach(() => {
  ({ db } = openDatabase({ file: ':memory:' }));
  dal = makeDal(defaultContext(db), { sealer: fakeSealer });
  seedProfile('p1', { keywords: ['react', 'node'], headline: 'Senior Frontend Engineer', city: 'Toronto', country: 'Canada' });
});
afterEach(() => db.close());

describe('scoreDeterministic (pure)', () => {
  it('scores a strong match HIGH with a title-match reason', () => {
    const { score, reasons } = scoreDeterministic(
      {
        title: 'Senior React Engineer',
        description: 'Build node + typescript services.',
        location: 'Toronto, Ontario, Canada',
        work_mode: 'hybrid',
        apply_capability: 'easy_apply',
      },
      { keywords: ['react', 'node'] },
      PIERRE,
    );
    expect(score).toBeGreaterThanOrEqual(80);
    expect(reasons.some((r) => r.startsWith('+ title matches') && r.includes("'react'"))).toBe(true);
  });

  it('scores an off-country + over-senior job BELOW the floor with the seniority reason', () => {
    const { score, reasons } = scoreDeterministic(
      {
        title: 'Staff React Engineer', // 'staff' → rank 4, above a 'senior' (3)… but tested vs a mid ceiling below
        description: 'React platform team.',
        location: 'San Francisco, California, United States',
        work_mode: 'onsite',
        apply_capability: 'external',
      },
      { keywords: ['react'] },
      { ...PIERRE, seniorityMax: 'mid', workModes: ['remote'] },
    );
    expect(score).toBeLessThan(30);
    expect(reasons.some((r) => r.startsWith('− seniority'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('− off-country'))).toBe(true);
  });

  it('a job with configured keywords but zero overlap gets a no-overlap reason and low score', () => {
    const { score, reasons } = scoreDeterministic(
      { title: 'Warehouse Associate', description: 'Forklift operation.', location: 'Toronto, Canada', work_mode: 'onsite' },
      {},
      PIERRE,
    );
    expect(reasons.some((r) => r.startsWith('− no overlap'))).toBe(true);
    expect(score).toBeLessThan(60);
  });

  it('is generous on seniority — one level over is only a nudge, not a hard drop', () => {
    // Over ceiling by ONE (senior job, mid ceiling), but otherwise a perfect match → still ranks well.
    const { score } = scoreDeterministic(
      {
        title: 'Senior React Engineer',
        description: 'node typescript',
        location: 'Toronto, Canada',
        work_mode: 'remote',
        apply_capability: 'easy_apply',
      },
      { keywords: ['react', 'node'] },
      { ...PIERRE, seniorityMax: 'mid' },
    );
    expect(score).toBeGreaterThanOrEqual(50);
  });

  it('never throws and stays neutral when nothing is configured', () => {
    const empty = { fitFloor: 30, country: '', locations: [], keywords: [], seniorityMax: '', workModes: [] };
    const { score, reasons } = scoreDeterministic({ title: 'Engineer', location: '' }, {}, empty);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(reasons.some((r) => r.includes('no keywords configured'))).toBe(true);
  });
});

describe('makeFitService.scoreFor (compute + cache)', () => {
  it('caches a deterministic fit_scores row AND syncs the jobs.fit_score cache', () => {
    const jobId = seedJob({
      title: 'Senior React Engineer',
      description: 'node typescript',
      location: 'Toronto, Canada',
      work_mode: 'hybrid',
      apply_capability: 'easy_apply',
      url: 'https://www.linkedin.com/jobs/view/1',
    });
    const svc = makeFitService({ dal, settings: settingsOf(PIERRE) });
    const res = svc.scoreFor(jobId, 'p1');

    expect(res.floorDecision).toBe('pass');
    expect(res.score).toBeGreaterThanOrEqual(80);

    const row = db.prepare('SELECT score, scorer, floor_decision, floor_value FROM fit_scores WHERE job_id = ? AND profile_id = ?').get(jobId, 'p1') as
      | { score: number; scorer: string; floor_decision: string; floor_value: number | null }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.scorer).toBe('deterministic');
    expect(row!.score).toBe(res.score);
    expect(row!.floor_decision).toBe('pass');
    expect(row!.floor_value).toBe(30);

    // denormalized cache synced on the jobs row
    const cached = db.prepare('SELECT fit_score FROM jobs WHERE id = ?').get(jobId) as { fit_score: number | null };
    expect(cached.fit_score).toBe(res.score);
  });

  it('marks a below-floor score as skip and stores the reason', () => {
    const jobId = seedJob({
      title: 'Staff React Engineer',
      location: 'San Francisco, United States',
      work_mode: 'onsite',
      apply_capability: 'external',
      source: 'indeed',
      url: 'https://www.indeed.com/viewjob?jk=2',
    });
    const svc = makeFitService({ dal, settings: settingsOf({ ...PIERRE, seniorityMax: 'mid', workModes: ['remote'] }) });
    const res = svc.scoreFor(jobId, 'p1');
    expect(res.floorDecision).toBe('skip');
    expect(res.score).toBeLessThan(30);
    const row = db.prepare('SELECT floor_decision FROM fit_scores WHERE job_id = ? AND profile_id = ?').get(jobId, 'p1') as { floor_decision: string };
    expect(row.floor_decision).toBe('skip');
  });

  it('never throws on a missing job — returns a low, explained skip and caches nothing', () => {
    const svc = makeFitService({ dal, settings: settingsOf(PIERRE) });
    const res = svc.scoreFor('job_does_not_exist', 'p1');
    expect(res.score).toBe(0);
    expect(res.floorDecision).toBe('skip');
    expect(res.reasons.join(' ')).toMatch(/not found/);
    const c = db.prepare('SELECT COUNT(*) c FROM fit_scores').get() as { c: number };
    expect(c.c).toBe(0);
  });
});

describe('makeFitService.floor', () => {
  it('reads settings.autoApply.fitFloor', () => {
    const svc = makeFitService({ dal, settings: settingsOf({ ...PIERRE, fitFloor: 45 }) });
    expect(svc.floor()).toBe(45);
  });

  it('falls back to 30 when the autoApply section is not registered yet', () => {
    const throwing: FitSettingsSource = {
      get() {
        throw new Error('unknown settings section: autoApply');
      },
    };
    const svc = makeFitService({ dal, settings: throwing });
    expect(svc.floor()).toBe(30);
  });

  it('clamps an out-of-band configured floor into 0..100', () => {
    expect(makeFitService({ dal, settings: settingsOf({ ...PIERRE, fitFloor: 999 }) }).floor()).toBe(100);
    expect(makeFitService({ dal, settings: settingsOf({ ...PIERRE, fitFloor: -5 }) }).floor()).toBe(0);
  });
});

describe('makeFitService.scoreEligible (the pump batch)', () => {
  it('scores only UNSCORED, non-dismissed, active jobs and reports pass/skip counts', () => {
    const good = seedJob({
      title: 'Senior React Engineer',
      description: 'node typescript',
      location: 'Toronto, Canada',
      work_mode: 'remote',
      apply_capability: 'easy_apply',
      url: 'https://www.linkedin.com/jobs/view/10',
    });
    const bad = seedJob({
      title: 'Staff Engineer',
      location: 'San Francisco, United States',
      work_mode: 'onsite',
      apply_capability: 'external',
      source: 'indeed',
      url: 'https://www.indeed.com/viewjob?jk=11',
    });
    // a dismissed job must be skipped entirely by the batch (Pierre's permanent-dismiss scar).
    // distinct title so it doesn't dedup onto `good` (norm_key = company+title).
    const dismissed = seedJob({ title: 'Backend Node Developer', location: 'Toronto, Canada', url: 'https://www.linkedin.com/jobs/view/12' });
    db.prepare('UPDATE jobs SET dismissed_at = ? WHERE id = ?').run(999, dismissed);

    const svc = makeFitService({ dal, settings: settingsOf({ ...PIERRE, seniorityMax: 'mid', workModes: ['remote'] }) });
    const out = svc.scoreEligible({ profileId: 'p1' });

    expect(out.scored).toBe(2); // good + bad, NOT the dismissed one
    expect(out.passed).toBeGreaterThanOrEqual(1);
    expect(out.skipped).toBeGreaterThanOrEqual(1);
    // the dismissed job never got a score row
    const dRow = db.prepare('SELECT COUNT(*) c FROM fit_scores WHERE job_id = ?').get(dismissed) as { c: number };
    expect(dRow.c).toBe(0);

    // a second pass finds nothing new to score (idempotent gap-fill).
    expect(svc.scoreEligible({ profileId: 'p1' }).scored).toBe(0);

    void good;
    void bad;
  });
});
