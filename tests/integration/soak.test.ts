// Perf soak — proves the backend stays LEAN + BOUNDED at real scale (Pierre's #1 durability ask: the
// app must never freeze as entries pile up). We seed 10k jobs/applications, 5k runs (incl. 500 parked
// needs-you), and 10k events, then assert every read the dashboard makes returns a CAPPED result set
// fast — never the whole table. The freeze class is a payload-discipline failure; this locks it out.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';

const fakeSealer: Sealer = { available: () => true, seal: (p) => Buffer.from(p), open: (b) => Buffer.from(b).toString() };
const N_JOBS = 10_000;
const N_RUNS = 5_000;
const N_NEEDS = 500;
const N_EVENTS = 10_000;

let db: Database;
let dal: Dal;

beforeAll(() => {
  ({ db } = openDatabase({ file: ':memory:' }));
  dal = makeDal(defaultContext(db), { sealer: fakeSealer });
  db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?,?,1,?,?)').run('p1', 'Pierre', 1, 1);

  const STATUSES = ['tracked', 'submitted', 'acknowledged', 'interview_1', 'offer', 'rejected'];
  const seed = db.transaction(() => {
    const ji = db.prepare('INSERT INTO jobs (id, source, title, company, job_url, norm_key, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const ai = db.prepare('INSERT INTO applications (id, job_id, profile_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)');
    for (let i = 0; i < N_JOBS; i++) {
      ji.run(`j${i}`, 'linkedin', `Engineer ${i}`, `Co ${i}`, `https://x/${i}`, `nk${i}`, i, i, i, i);
      ai.run(`a${i}`, `j${i}`, 'p1', STATUSES[i % STATUSES.length], i, i);
    }
    // runs: most terminal, N_NEEDS parked as needs_human
    const ri = db.prepare(`INSERT INTO apply_runs (id, application_id, job_id, profile_id, source, lane, state, mode, park_kind, pending_questions_json, queued_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < N_RUNS; i++) {
      const needs = i < N_NEEDS;
      ri.run(`r${i}`, `a${i}`, `j${i}`, 'p1', 'linkedin', 'linkedin',
        needs ? 'needs_human' : 'skipped', 'auto', // 'submitted' needs trustworthy evidence (CHECK); skip is terminal
        needs ? 'needs_answer' : null,
        needs ? JSON.stringify([{ question: `Years with tech ${i}?`, kind: 'text' }]) : '[]',
        i, i);
    }
    const ei = db.prepare('INSERT INTO events (id, at, kind, job_id, application_id, summary) VALUES (?,?,?,?,?,?)');
    for (let i = 0; i < N_EVENTS; i++) ei.run(`e${i}`, i, i % 2 ? 'status_change' : 'created', `j${i % N_JOBS}`, `a${i % N_JOBS}`, `event ${i}`);
  });
  seed();
});
afterAll(() => db.close());

/** Run fn, return elapsed ms. */
function timed<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const r = fn();
  return [r, performance.now() - t0];
}

describe('soak @ 10k jobs / 5k runs / 10k events', () => {
  it('seeded the expected volume', () => {
    expect((db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c).toBe(N_JOBS);
    expect((db.prepare('SELECT COUNT(*) c FROM apply_runs').get() as { c: number }).c).toBe(N_RUNS);
    expect((db.prepare('SELECT COUNT(*) c FROM events').get() as { c: number }).c).toBe(N_EVENTS);
  });

  it('applications.listLean is CAPPED + fast (never returns the whole table)', () => {
    const [page, ms] = timed(() => dal.applications.listLean({ limit: 120, offset: 0 }));
    expect(page.rows.length).toBe(120); //     capped, not 10k
    expect(page.total).toBe(N_JOBS); //         accurate total for the pager
    expect(JSON.stringify(page.rows[0])).not.toContain('description'); // lean, no heavy text
    expect(ms).toBeLessThan(150); //            generous bound; the point is it's O(page) not O(table)
  });

  it('a deep page (offset 9000) is still bounded + fast', () => {
    const [page, ms] = timed(() => dal.applications.listLean({ limit: 120, offset: 9000 }));
    expect(page.rows.length).toBe(120);
    expect(ms).toBeLessThan(150);
  });

  it('needs-you runs are capped even though 500 exist', () => {
    const [page] = timed(() => dal.runs.listLean({ state: 'needs_human', limit: 200 }));
    expect(page.rows.length).toBe(200); //      capped at the requested limit
    expect(page.total).toBe(N_NEEDS); //         honest total for the badge
  });

  it('funnel + run stats aggregate fast', () => {
    // wide windows so the ancient (epoch-near-0) seed timestamps are all counted
    const [funnel, fms] = timed(() => dal.applications.funnel({ days: 100_000 }));
    expect(Object.values(funnel).reduce((a, b) => a + b, 0)).toBe(N_JOBS);
    expect(fms).toBeLessThan(150);
    const [stats, sms] = timed(() => dal.runs.stats({ hours: 24 * 100_000 }));
    expect(stats.total).toBe(N_RUNS);
    expect(sms).toBeLessThan(150);
  });

  it('recent events are capped', () => {
    const [page, ms] = timed(() => dal.events.recent({ limit: 100 }));
    expect(page.rows.length).toBe(100);
    expect(ms).toBeLessThan(100);
  });
});
