// Stage-1 data-route tests. Two jobs:
//   1. CONTRACT: every route mountDataRoutes adds answers the canonical envelope (walked route
//      table, same independent inline schema as envelope.test.ts) — plus the one sanctioned
//      exception, the raw-bytes document download.
//   2. BEHAVIOR: each route's filters/pagination/404s/guards, exercised against the REAL schema-v1
//      DB (openDatabase(':memory:') + migrations) through a reference DAL implemented here with
//      the proven v13.0.x SQL semantics. The reference DAL doubles as the executable spec of the
//      DataDal seam the real Stage-1 DAL must satisfy (structural typing checks it at wiring time).
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import type { Hono } from 'hono';
import { createApp } from '../../app/src/main/server/index.js';
import { mountApi } from '../../app/src/main/server/api.js';
import {
  mountDataRoutes,
  type DataDal,
  type DataDeps,
  type ImporterPort,
} from '../../app/src/main/server/routes-data.js';
import { openDatabase } from '../../app/src/main/db/index.js';
import { IDENTITY } from '@jat13/shared';

const VERSION = '13.1.0';
const TOKEN = 'tok-routes-data';
const authed = { headers: { [IDENTITY.authHeader]: TOKEN } };

// ---------------------------------------------------------------------------------------------
// canonical envelope, written from the spec (independent of @jat13/shared — no rubber-stamping)
// ---------------------------------------------------------------------------------------------
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const ErrorShape = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, 'error.code must be snake_case'),
    message: z.string().min(1),
  })
  .strict();

const EnvelopeSchema = z
  .discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
    z.object({ ok: z.literal(false), error: ErrorShape }).strict(),
  ])
  .superRefine((env, ctx) => {
    if (!env.ok) return;
    if (!Object.hasOwn(env, 'data')) {
      ctx.addIssue({ code: 'custom', message: 'ok envelope must carry a "data" key' });
      return;
    }
    const d = (env as { data: unknown }).data;
    if (isRecord(d) && 'ok' in d && ('data' in d || 'error' in d)) {
      ctx.addIssue({ code: 'custom', message: 'data is itself an envelope (double wrap)' });
    }
    if (isRecord(d) && isRecord(d.rows) && 'rows' in d.rows) {
      ctx.addIssue({ code: 'custom', message: '{rows:{rows}} double wrap' });
    }
  });

// ---------------------------------------------------------------------------------------------
// fixture: real migrated schema-v1 DB + a seeded slice of Pierre's world
// ---------------------------------------------------------------------------------------------
function seed(db: DB): void {
  const t = Date.now() - 60_000; // a minute ago — inside every trailing window (funnel 90d, etc.)

  db.prepare(
    `INSERT INTO profiles (id, name, is_default, data_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  ).run('prof_1', 'Pierre', 1, JSON.stringify({ first_name: 'Pierre', last_name: 'Salama' }), t, t);

  const insJob = db.prepare(
    `INSERT INTO jobs (id, source, title, company, company_key, location, job_url, job_url_norm,
                       norm_key, apply_capability, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (@id,@source,@title,@company,@ck,@loc,@url,@urln,@nk,@cap,@t,@t,@t,@u)`,
  );
  insJob.run({ id: 'job_1', source: 'linkedin', title: 'Senior TypeScript Engineer', company: 'Acme Corp', ck: 'acme corp', loc: 'Montreal, QC', url: 'https://linkedin.com/jobs/1', urln: 'linkedin.com/jobs/1', nk: 'k1', cap: 'easy_apply', t, u: t + 100 });
  insJob.run({ id: 'job_2', source: 'indeed', title: 'Rust Developer', company: 'Globex', ck: 'globex', loc: 'Remote', url: 'https://indeed.com/viewjob?jk=2', urln: 'indeed.com/viewjob?jk=2', nk: 'k2', cap: 'smartapply', t, u: t + 200 });
  insJob.run({ id: 'job_3', source: 'greenhouse', title: 'Platform Engineer', company: 'Initech', ck: 'initech', loc: 'Toronto, ON', url: 'https://boards.greenhouse.io/initech/3', urln: 'boards.greenhouse.io/initech/3', nk: 'k3', cap: 'ats_form', t, u: t + 300 });

  db.prepare(`INSERT INTO job_details (job_id, description) VALUES (?,?)`).run(
    'job_1',
    'We build rockets in TypeScript.',
  );

  const insApp = db.prepare(
    `INSERT INTO applications (id, job_id, profile_id, status, via, submitted_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  insApp.run('app_1', 'job_1', 'prof_1', 'submitted', 'import', t, t, t + 100);
  insApp.run('app_2', 'job_2', 'prof_1', 'tracked', null, null, t, t + 200);

  const insRun = db.prepare(
    `INSERT INTO apply_runs (id, application_id, job_id, profile_id, source, lane, state,
                             evidence_kind, park_kind, queued_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insRun.run('run_1', 'app_1', 'job_1', 'prof_1', 'linkedin', 'linkedin', 'submitted', 'url_confirmation', null, t, t);
  insRun.run('run_2', 'app_2', 'job_2', 'prof_1', 'indeed', 'indeed', 'parked', null, 'needs_answer', t + 10, t + 10);

  const insEvt = db.prepare(
    `INSERT INTO events (id, at, kind, job_id, application_id, summary) VALUES (?,?,?,?,?,?)`,
  );
  insEvt.run('evt_1', t, 'imported', 'job_1', 'app_1', 'Imported from v11');
  insEvt.run('evt_2', t + 50, 'status_change', 'job_1', 'app_1', 'tracked → submitted');
  insEvt.run('evt_3', t + 60, 'created', 'job_2', 'app_2', 'Tracked Rust Developer');

  db.prepare(
    `INSERT INTO email_accounts (id, kind, email, created_at, updated_at) VALUES (?,?,?,?,?)`,
  ).run('acct_1', 'imported', 'pierre@example.com', t, t);
  const insEmail = db.prepare(
    `INSERT INTO emails (id, account_id, provider_msg_id, from_addr, from_name, subject, snippet, sent_at, category, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  insEmail.run('email_1', 'acct_1', 'm1', 'no-reply@acme.com', 'Acme Talent', 'Your application to Acme', 'Thanks for applying', t + 20, 'rejection', t);
  insEmail.run('email_2', 'acct_1', 'm2', 'talent@initech.com', 'Initech', 'Interview invitation', 'We would like to meet', t + 30, 'interview', t);
  const insMatch = db.prepare(
    `INSERT INTO email_matches (email_id, application_id, job_id, confidence, source, match_via, decided_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  insMatch.run('email_1', 'app_1', 'job_1', 1, 'auto', 'import', t);
  insMatch.run('email_2', 'app_1', 'job_1', 0.6, 'suggested', 'score', t);

  const insAns = db.prepare(
    `INSERT INTO learned_answers (id, profile_id, kind, key_norm, label, value, provenance, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  insAns.run('ans_1', 'prof_1', 'qa', 'years_of_experience', 'Years of experience?', '8', 'import_v11', t, t);
  insAns.run('ans_2', 'prof_1', 'field', 'first_name', 'First name', 'Pierre', 'import_v11', t, t + 10);
}

// ---------------------------------------------------------------------------------------------
// reference DAL — the executable spec of the DataDal seam, real SQL on the real schema
// ---------------------------------------------------------------------------------------------
function makeTestDal(db: DB): DataDal {
  const like = (s: string) => `%${s.trim()}%`;
  const count = (sql: string, bind: Record<string, unknown>): number =>
    (db.prepare(sql).get(bind) as { c: number }).c;

  const docRow = (id: string) =>
    db.prepare(`SELECT id, name, role, mime, is_default FROM documents WHERE id = ?`).get(id) as
      | { id: string; name: string; role: string; mime: string | null; is_default: number }
      | undefined;

  return {
    jobs: {
      listLean(params = {}) {
        const where: string[] = [];
        const bind: Record<string, unknown> = {};
        if (params.source !== undefined) { where.push('source = @source'); bind.source = params.source; }
        if (params.q) { where.push('(title LIKE @q OR company LIKE @q)'); bind.q = like(params.q); }
        const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = count(`SELECT COUNT(*) AS c FROM jobs ${w}`, bind);
        const rows = db
          .prepare(
            `SELECT id, source, title, company, location, apply_capability, fit_score, posting_state, updated_at
             FROM jobs ${w} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`,
          )
          .all({ ...bind, limit: params.limit ?? 100, offset: params.offset ?? 0 });
        return { rows, total };
      },
      getDetail(id) {
        const row = db
          .prepare(
            `SELECT j.id, j.source, j.title, j.company, j.location, j.job_url, d.description
             FROM jobs j LEFT JOIN job_details d ON d.job_id = j.id WHERE j.id = ?`,
          )
          .get(id) as Record<string, unknown> | undefined;
        return row === undefined ? undefined : { ...row, description: row.description ?? '' };
      },
    },

    applications: {
      listLean(opts = {}) {
        const where: string[] = [];
        const bind: Record<string, unknown> = {};
        if (opts.status !== undefined) { where.push('a.status = @status'); bind.status = opts.status; }
        if (opts.q) { where.push('(j.title LIKE @q OR j.company LIKE @q)'); bind.q = like(opts.q); }
        const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = count(
          `SELECT COUNT(*) AS c FROM applications a JOIN jobs j ON j.id = a.job_id ${w}`,
          bind,
        );
        const rows = db
          .prepare(
            `SELECT a.id, a.job_id, a.profile_id, a.status, a.via, a.submitted_at, a.needs_review,
                    a.created_at, a.updated_at, j.title, j.company, j.source
             FROM applications a JOIN jobs j ON j.id = a.job_id ${w}
             ORDER BY a.updated_at DESC, a.id DESC LIMIT @limit OFFSET @offset`,
          )
          .all({ ...bind, limit: opts.limit ?? 100, offset: opts.offset ?? 0 });
        return { rows, total };
      },
      funnel(opts = {}) {
        const days = opts.days ?? 30;
        const since = Date.now() - days * 86_400_000;
        const counts: Record<string, number> = {
          tracked: 0, submitted: 0, acknowledged: 0, assessment: 0,
          interview_1: 0, interview_2: 0, interview_final: 0,
          offer: 0, hired: 0, rejected: 0, withdrawn: 0, ghosted: 0,
        };
        const rows = db
          .prepare(`SELECT status, COUNT(*) AS c FROM applications WHERE updated_at >= ? GROUP BY status`)
          .all(since) as Array<{ status: string; c: number }>;
        for (const r of rows) if (Object.hasOwn(counts, r.status)) counts[r.status] = r.c;
        return counts;
      },
    },

    runs: {
      listLean(input = {}) {
        const where: string[] = [];
        const bind: Record<string, unknown> = {};
        if (input.state !== undefined) { where.push('state = @state'); bind.state = input.state; }
        const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = count(`SELECT COUNT(*) AS c FROM apply_runs ${w}`, bind);
        const rows = db
          .prepare(
            `SELECT id, application_id, job_id, source, lane, state, park_kind, queued_at, finished_at, updated_at
             FROM apply_runs ${w} ORDER BY queued_at DESC LIMIT @limit OFFSET @offset`,
          )
          .all({ ...bind, limit: input.limit ?? 100, offset: input.offset ?? 0 });
        return { rows, total };
      },
    },

    emails: {
      listLean(opts = {}) {
        const where: string[] = [];
        const bind: Record<string, unknown> = {};
        if (opts.category !== undefined) { where.push('category = @category'); bind.category = opts.category; }
        const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = count(`SELECT COUNT(*) AS c FROM emails ${w}`, bind);
        const rows = db
          .prepare(
            `SELECT id, account_id, from_addr, from_name, subject, snippet, sent_at, category
             FROM emails ${w} ORDER BY sent_at DESC LIMIT @limit OFFSET @offset`,
          )
          .all({ ...bind, limit: opts.limit ?? 100, offset: opts.offset ?? 0 });
        return { rows, total };
      },
      listForApplication(applicationId) {
        const rows = db
          .prepare(
            `SELECT id, from_addr, from_name, subject, snippet, sent_at, category FROM emails
             WHERE id IN (SELECT email_id FROM email_matches WHERE application_id = ?)
             ORDER BY sent_at DESC`,
          )
          .all(applicationId);
        const total = count(
          `SELECT COUNT(*) AS c FROM email_matches WHERE application_id = @a`,
          { a: applicationId },
        );
        return { rows, total };
      },
      suggestions(opts = {}) {
        const rows = db
          .prepare(
            `SELECT e.id, e.from_addr, e.subject, e.snippet, e.sent_at, e.category,
                    m.application_id, m.job_id, m.confidence, m.match_via
             FROM emails e JOIN email_matches m ON m.email_id = e.id
             WHERE m.source = 'suggested' ORDER BY e.sent_at DESC LIMIT ?`,
          )
          .all(opts.limit ?? 50);
        const total = count(`SELECT COUNT(*) AS c FROM email_matches WHERE source = 'suggested'`, {});
        return { rows, total };
      },
    },

    documents: {
      get(id) {
        const row = docRow(id);
        return row === undefined ? undefined : { id: row.id, name: row.name, mime: row.mime };
      },
      listLean() {
        const rows = db
          .prepare(
            `SELECT id, profile_id, name, role, label, mime, size_bytes, sha256, is_default, source, created_at, updated_at
             FROM documents ORDER BY role ASC, is_default DESC, updated_at DESC`,
          )
          .all() as Array<{ id: string; name: string; mime: string | null }>;
        return { rows, total: count(`SELECT COUNT(*) AS c FROM documents`, {}) };
      },
      add(input) {
        const buf = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
        if (buf.length > 26_214_400) throw new Error(`document exceeds max size: ${buf.length}`);
        const sha = createHash('sha256').update(buf).digest('hex');
        const existing = db.prepare(`SELECT id FROM documents WHERE sha256 = ?`).get(sha) as { id: string } | undefined;
        if (existing) return docRow(existing.id);
        const role = input.role ?? 'resume';
        const hasDefault = db.prepare(`SELECT 1 AS x FROM documents WHERE role = ? AND is_default = 1`).get(role) !== undefined;
        const now = Date.now();
        const id = `doc_${(db.prepare(`SELECT COUNT(*) AS c FROM documents`).get() as { c: number }).c + 1}`;
        db.prepare(
          `INSERT INTO documents (id, profile_id, name, role, label, mime, size_bytes, sha256, is_default, source, created_at, updated_at)
           VALUES (@id,@pid,@name,@role,@label,@mime,@size,@sha,@def,@src,@now,@now)`,
        ).run({
          id, pid: input.profileId ?? null, name: input.name, role, label: input.label ?? null,
          mime: input.mime ?? null, size: buf.length, sha, def: hasDefault ? 0 : 1,
          src: input.source ?? 'upload', now,
        });
        db.prepare(`INSERT INTO document_blobs (document_id, bytes) VALUES (?,?)`).run(id, buf);
        return docRow(id);
      },
      getBytes(id) {
        const row = db.prepare(`SELECT bytes FROM document_blobs WHERE document_id = ?`).get(id) as
          | { bytes: Buffer }
          | undefined;
        return row?.bytes;
      },
      setDefault(id) {
        const doc = docRow(id);
        if (!doc) throw new Error(`no such document: ${id}`);
        db.prepare(`UPDATE documents SET is_default = 0 WHERE role = ? AND is_default = 1`).run(doc.role);
        db.prepare(`UPDATE documents SET is_default = 1 WHERE id = ?`).run(id);
      },
      remove(id) {
        return db.prepare(`DELETE FROM documents WHERE id = ?`).run(id).changes > 0;
      },
    },

    answers: {
      list(profileId, input = {}) {
        const where: string[] = ['profile_id = @pid'];
        const bind: Record<string, unknown> = { pid: profileId };
        if (input.q) { where.push('(label LIKE @q OR key_norm LIKE @q)'); bind.q = like(input.q); }
        const w = where.join(' AND ');
        const total = count(`SELECT COUNT(*) AS c FROM learned_answers WHERE ${w}`, bind);
        const rows = db
          .prepare(
            `SELECT id, profile_id, kind, key_norm, label, field_type, confidence, provenance, locked, updated_at
             FROM learned_answers WHERE ${w} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`,
          )
          .all({ ...bind, limit: input.limit ?? 200, offset: input.offset ?? 0 });
        return { rows, total };
      },
      get(id) {
        return db
          .prepare(
            `SELECT id, profile_id, kind, key_norm, label, field_type, value, confidence, provenance, locked, updated_at
             FROM learned_answers WHERE id = ?`,
          )
          .get(id) as unknown;
      },
    },

    events: {
      timeline(applicationId, opts = {}) {
        const rows = db
          .prepare(
            `SELECT id, at, kind, job_id, application_id, run_id, email_id, source, summary FROM events
             WHERE application_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
          )
          .all(applicationId, opts.limit ?? 200);
        const total = count(`SELECT COUNT(*) AS c FROM events WHERE application_id = @a`, { a: applicationId });
        return { rows, total };
      },
      recent(opts = {}) {
        const limit = opts.limit ?? 100;
        if (opts.kinds !== undefined) {
          const known = new Set([
            'created', 'status_change', 'submitted', 'park', 'needs_human', 'email', 'email_matched',
            'resume_tailored', 'cover_letter_generated', 'interview_detected', 'autopsy_created',
            'answer_learned', 'note', 'imported', 'document_attached',
          ]);
          const kinds = opts.kinds.filter((k) => known.has(k));
          if (kinds.length === 0) return { rows: [], total: 0 };
          const ph = kinds.map(() => '?').join(', ');
          const rows = db
            .prepare(
              `SELECT id, at, kind, job_id, application_id, summary FROM events
               WHERE kind IN (${ph}) ORDER BY at DESC, id DESC LIMIT ?`,
            )
            .all(...kinds, limit);
          const total = (db.prepare(`SELECT COUNT(*) AS c FROM events WHERE kind IN (${ph})`).get(...kinds) as { c: number }).c;
          return { rows, total };
        }
        const rows = db
          .prepare(`SELECT id, at, kind, job_id, application_id, summary FROM events ORDER BY at DESC, id DESC LIMIT ?`)
          .all(limit);
        return { rows, total: count(`SELECT COUNT(*) AS c FROM events`, {}) };
      },
    },

    profiles: {
      getDefault() {
        const row = db
          .prepare(`SELECT id, name, is_default, data_json FROM profiles WHERE is_default = 1 LIMIT 1`)
          .get() as { id: string; name: string; is_default: number; data_json: string } | undefined;
        if (!row) return undefined;
        let data: unknown = {};
        try { data = JSON.parse(row.data_json); } catch { data = {}; }
        return { id: row.id, name: row.name, is_default: row.is_default === 1, data };
      },
      list() {
        const rows = db.prepare(`SELECT id, name, is_default FROM profiles ORDER BY is_default DESC`).all();
        return { rows, total: rows.length };
      },
      get(id: string) {
        const row = db.prepare(`SELECT id, name, is_default, data_json FROM profiles WHERE id = ?`).get(id) as
          | { id: string; name: string; is_default: number; data_json: string }
          | undefined;
        if (!row) return undefined;
        let data: unknown = {};
        try { data = JSON.parse(row.data_json); } catch { data = {}; }
        return { id: row.id, name: row.name, is_default: row.is_default === 1, data };
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------
interface Harness {
  app: Hono;
  db: DB;
  dal: DataDal;
  calls: { plan: string[]; execute: Array<{ sourcePath: string; migrateGmail: boolean }> };
  setV11Running: (v: boolean) => void;
  probeCalls: () => number;
}

function makeHarness(opts: { seed?: boolean; snapshots?: boolean } = {}): Harness {
  const { db } = openDatabase({ file: ':memory:' });
  if (opts.seed !== false) seed(db);
  const dal = makeTestDal(db);

  const calls: Harness['calls'] = { plan: [], execute: [] };
  let v11Running = false;
  let probes = 0;

  const importer: ImporterPort = {
    plan(sourcePath) {
      calls.plan.push(sourcePath);
      if (sourcePath.includes('missing')) {
        const e = new Error('v11 database not found at that path') as Error & { code: string };
        e.code = 'NOT_FOUND'; // the importer's typed refusal — routes must snake_case it
        throw e;
      }
      return { willImport: true, source: { path: sourcePath } };
    },
    execute(sourcePath, o) {
      calls.execute.push({ sourcePath, migrateGmail: o.migrateGmail });
      return {
        importRunId: 'imp_test',
        status: 'ok',
        gmail: o.migrateGmail ? { migrated: false, reason: 'not_consented' } : null,
      };
    },
  };
  if (opts.snapshots) importer.snapshots = true;

  const dataDeps: DataDeps = {
    db,
    token: TOKEN,
    version: VERSION,
    startedAt: Date.now(),
    dal,
    importer,
    v11Probe: async () => {
      probes += 1;
      return v11Running;
    },
  };

  const app = createApp({
    db,
    version: VERSION,
    startedAt: Date.now(),
    dev: true,
    mount: (a) =>
      mountApi(a, {
        db,
        token: TOKEN,
        version: VERSION,
        startedAt: Date.now(),
        extend: (api) => mountDataRoutes(api, dataDeps), // exactly how the integrator wires it
      }),
  });

  return {
    app, db, dal, calls,
    setV11Running: (v) => { v11Running = v; },
    probeCalls: () => probes,
  };
}

async function call(app: Hono, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { [IDENTITY.authHeader]: TOKEN };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

async function okData<T>(res: Response): Promise<T> {
  const env = (await res.json()) as { ok: boolean; data?: T };
  expect(env.ok, `expected ok envelope, got ${JSON.stringify(env).slice(0, 300)}`).toBe(true);
  return env.data as T;
}

async function errBody(res: Response): Promise<{ code: string; message: string }> {
  const env = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
  expect(env.ok).toBe(false);
  return env.error;
}

interface Page<T = Record<string, unknown>> {
  rows: T[];
  total: number;
}

// ---------------------------------------------------------------------------------------------
// 1. contract: the walked route table
// ---------------------------------------------------------------------------------------------
describe('Stage-1 data routes — envelope contract', () => {
  const DATA_ROUTES = [
    'GET /api/summary',
    'GET /api/jobs',
    'GET /api/jobs/:id',
    'GET /api/applications',
    'GET /api/applications/:id/timeline',
    'GET /api/runs',
    'GET /api/emails',
    'GET /api/emails/suggestions',
    'GET /api/documents',
    'POST /api/documents',
    'GET /api/documents/:id/download',
    'POST /api/documents/:id/default',
    'DELETE /api/documents/:id',
    'GET /api/profile',
    'GET /api/answers',
    'GET /api/answers/:id',
    'GET /api/events',
    'POST /api/import/plan',
    'POST /api/import/execute',
  ];

  function walkable(app: Hono): Array<{ method: string; path: string }> {
    const seen = new Set<string>();
    const out: Array<{ method: string; path: string }> = [];
    for (const r of app.routes) {
      if (!r.path.startsWith('/api') || r.method === 'ALL' || r.path.includes('*')) continue;
      const key = `${r.method} ${r.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ method: r.method, path: r.path });
      }
    }
    return out;
  }

  it('every declared Stage-1 route is actually mounted (no vacuous walk)', () => {
    const keys = walkable(makeHarness().app).map((r) => `${r.method} ${r.path}`);
    expect(keys).toEqual(expect.arrayContaining(DATA_ROUTES));
  });

  it('every mounted /api route answers JSON that parses as the canonical envelope', async () => {
    const { app } = makeHarness();
    for (const r of walkable(app)) {
      const path = r.path.replace(/:[A-Za-z0-9_]+/g, 'x-walk-id');
      const res = await call(app, r.method, path, r.method === 'GET' ? undefined : {});
      const label = `${r.method} ${path} → ${res.status}`;
      expect(res.headers.get('content-type') ?? '', label).toContain('application/json');
      const parsed = EnvelopeSchema.safeParse(await res.json());
      expect(parsed.success, `${label} — ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });

  it('data routes inherit the token guard: unauthenticated → enveloped 401', async () => {
    const { app } = makeHarness();
    for (const path of ['/api/summary', '/api/jobs', '/api/documents']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    }
  });

  it('a throwing DAL answers an enveloped 500, never Hono\'s bare error page', async () => {
    const h = makeHarness();
    h.dal.jobs.listLean = () => {
      throw new Error('no such table: jobs (simulated storage failure)');
    };
    const res = await call(h.app, 'GET', '/api/jobs');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const e = await errBody(res);
    expect(e.code).toBe('internal');
    expect(e.message).toContain('no such table');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. behavior per surface
// ---------------------------------------------------------------------------------------------
describe('GET /api/summary', () => {
  it('ships the 90d funnel, the needsYou stub, and real totals', async () => {
    const { app } = makeHarness();
    const data = await okData<{ funnel: Record<string, number>; needsYou: number; counts: Record<string, number> }>(
      await call(app, 'GET', '/api/summary'),
    );
    expect(data.needsYou).toBe(0);
    expect(Object.keys(data.funnel)).toHaveLength(12); // zero-filled — stable funnel shape
    expect(data.funnel.submitted).toBe(1);
    expect(data.funnel.tracked).toBe(1);
    expect(data.counts).toEqual({ jobs: 3, applications: 2, runs: 2, documents: 0, emails: 2, answers: 2 });
  });

  it('pre-import (empty DB): zeros everywhere, no throw', async () => {
    const { app } = makeHarness({ seed: false });
    const data = await okData<{ counts: Record<string, number> }>(await call(app, 'GET', '/api/summary'));
    expect(data.counts).toEqual({ jobs: 0, applications: 0, runs: 0, documents: 0, emails: 0, answers: 0 });
  });
});

describe('GET /api/jobs (+/:id)', () => {
  it('lists lean rows newest-updated first with a filter-independent total', async () => {
    const { app } = makeHarness();
    const page = await okData<Page>(await call(app, 'GET', '/api/jobs'));
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.id)).toEqual(['job_3', 'job_2', 'job_1']);
    expect(page.rows[0]).not.toHaveProperty('description'); // heavy text stays quarantined
  });

  it('?q matches title OR company; ?source narrows the lane; limit/offset page', async () => {
    const { app } = makeHarness();
    expect((await okData<Page>(await call(app, 'GET', '/api/jobs?q=rust'))).total).toBe(1);
    expect((await okData<Page>(await call(app, 'GET', '/api/jobs?q=acme'))).total).toBe(1);
    expect((await okData<Page>(await call(app, 'GET', '/api/jobs?source=linkedin'))).rows[0]!.id).toBe('job_1');
    const paged = await okData<Page>(await call(app, 'GET', '/api/jobs?limit=1&offset=1'));
    expect(paged.rows).toHaveLength(1);
    expect(paged.rows[0]!.id).toBe('job_2');
    expect(paged.total).toBe(3);
  });

  it('/:id returns the detail (description joined in); unknown id → 404 not_found', async () => {
    const { app } = makeHarness();
    const d = await okData<Record<string, unknown>>(await call(app, 'GET', '/api/jobs/job_1'));
    expect(d.title).toBe('Senior TypeScript Engineer');
    expect(d.description).toBe('We build rockets in TypeScript.');
    const missing = await call(app, 'GET', '/api/jobs/job_nope');
    expect(missing.status).toBe(404);
    expect((await errBody(missing)).code).toBe('not_found');
  });
});

describe('GET /api/applications (+/:id/timeline)', () => {
  it('lists with joined job title/company; ?status and ?q filter', async () => {
    const { app } = makeHarness();
    const all = await okData<Page>(await call(app, 'GET', '/api/applications'));
    expect(all.total).toBe(2);
    expect(all.rows[0]!.title).toBe('Rust Developer'); // newest-updated first, job join present

    const submitted = await okData<Page>(await call(app, 'GET', '/api/applications?status=submitted'));
    expect(submitted.total).toBe(1);
    expect(submitted.rows[0]!.id).toBe('app_1');

    const byCompany = await okData<Page>(await call(app, 'GET', '/api/applications?q=acme'));
    expect(byCompany.total).toBe(1);
    expect(byCompany.rows[0]!.id).toBe('app_1');
  });

  it('timeline = the application\'s events page + matched-emails page in one round-trip', async () => {
    const { app } = makeHarness();
    const data = await okData<{ events: Page; emails: Page }>(
      await call(app, 'GET', '/api/applications/app_1/timeline'),
    );
    expect(data.events.total).toBe(2);
    expect(data.events.rows.map((r) => r.kind)).toEqual(['status_change', 'imported']); // newest first
    expect(data.emails.total).toBe(2); // both matched emails (auto + suggested) hang off app_1
    const unknown = await okData<{ events: Page; emails: Page }>(
      await call(app, 'GET', '/api/applications/app_nope/timeline'),
    );
    expect(unknown.events.total).toBe(0); // empty history, not an error (proven v13.0.x behavior)
    expect(unknown.emails.rows).toEqual([]);
  });
});

describe('GET /api/runs', () => {
  it('lists lean runs; ?state filters', async () => {
    const { app } = makeHarness();
    expect((await okData<Page>(await call(app, 'GET', '/api/runs'))).total).toBe(2);
    const parked = await okData<Page>(await call(app, 'GET', '/api/runs?state=parked'));
    expect(parked.total).toBe(1);
    expect(parked.rows[0]!.park_kind).toBe('needs_answer');
  });
});

describe('GET /api/emails (+/suggestions)', () => {
  it('lists lean emails (no body); ?category filters; suggestions = pending review set', async () => {
    const { app } = makeHarness();
    const all = await okData<Page>(await call(app, 'GET', '/api/emails'));
    expect(all.total).toBe(2);
    expect(all.rows[0]).not.toHaveProperty('body'); // 64KB body never rides a list
    const rej = await okData<Page>(await call(app, 'GET', '/api/emails?category=rejection'));
    expect(rej.total).toBe(1);
    expect(rej.rows[0]!.id).toBe('email_1');
    const sugg = await okData<Page>(await call(app, 'GET', '/api/emails/suggestions'));
    expect(sugg.total).toBe(1);
    expect(sugg.rows.map((r) => r.id)).toEqual(['email_2']);
    expect(sugg.rows[0]!.application_id).toBe('app_1'); // joined pending match — confirm/dismiss needs it
  });
});

describe('documents — upload → download round-trip + management', () => {
  const BYTES = Buffer.from('%PDF-1.7 fake resume bytes for the round-trip test %%EOF');

  async function upload(app: Hono, name: string, extra: Record<string, string> = {}): Promise<Response> {
    const fd = new FormData();
    fd.append('file', new File([BYTES], name, { type: 'application/pdf' }));
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return app.request('/api/documents', { method: 'POST', headers: { ...authed.headers }, body: fd });
  }

  it('uploads multipart, lists it, downloads the EXACT bytes with true content-type/disposition', async () => {
    const { app } = makeHarness();
    const up = await okData<{ doc: { id: string } }>(await upload(app, 'Pierre "2026" resume.pdf', { role: 'resume', label: 'Main' }));
    const id = up.doc.id;

    const page = await okData<Page>(await call(app, 'GET', '/api/documents'));
    expect(page.total).toBe(1);
    expect(page.rows[0]!.id).toBe(id);

    const dl = await app.request(`/api/documents/${id}/download`, authed);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/pdf');
    // quotes stripped from the filename param (header stays parseable, no injection)
    expect(dl.headers.get('content-disposition')).toBe('attachment; filename="Pierre 2026 resume.pdf"');
    expect(Buffer.from(await dl.arrayBuffer()).equals(BYTES)).toBe(true);
  });

  it('set-default and delete round out the library; unknown ids → 404', async () => {
    const { app } = makeHarness();
    const { doc } = await okData<{ doc: { id: string } }>(await upload(app, 'cv.pdf'));

    const def = await okData<{ id: string; is_default: boolean }>(
      await call(app, 'POST', `/api/documents/${doc.id}/default`, {}),
    );
    expect(def).toEqual({ id: doc.id, is_default: true });
    expect((await call(app, 'POST', '/api/documents/doc_nope/default', {})).status).toBe(404);

    expect(await okData(await call(app, 'DELETE', `/api/documents/${doc.id}`))).toEqual({ deleted: true });
    expect((await call(app, 'DELETE', `/api/documents/${doc.id}`)).status).toBe(404); // second delete
    expect((await app.request(`/api/documents/${doc.id}/download`, authed)).status).toBe(404); // bytes gone
  });

  it('rejects loudly: no file / unknown role / non-multipart body — all enveloped 400s', async () => {
    const { app } = makeHarness();

    const noFile = await app.request('/api/documents', { method: 'POST', headers: { ...authed.headers }, body: new FormData() });
    expect(noFile.status).toBe(400);
    expect((await errBody(noFile)).code).toBe('no_file');

    const badRole = await upload(app, 'cv.pdf', { role: 'mixtape' });
    expect(badRole.status).toBe(400);
    expect((await errBody(badRole)).code).toBe('bad_role'); // loud — never a silent 'resume' default

    const json = await call(app, 'POST', '/api/documents', { file: 'nope' });
    expect(json.status).toBe(400);
    expect((await errBody(json)).code).toBe('bad_form');
  });
});

describe('GET /api/profile + /api/answers', () => {
  it('profile = the default profile with parsed data fields', async () => {
    const { app } = makeHarness();
    const p = await okData<{ id: string; name: string; data: Record<string, unknown> }>(
      await call(app, 'GET', '/api/profile'),
    );
    expect(p.id).toBe('prof_1');
    expect(p.name).toBe('Pierre');
    expect(p.data.first_name).toBe('Pierre');
  });

  it('pre-import: profile → 404 no_profile; answers → empty page (not an error)', async () => {
    const { app } = makeHarness({ seed: false });
    const res = await call(app, 'GET', '/api/profile');
    expect(res.status).toBe(404);
    expect((await errBody(res)).code).toBe('no_profile');
    expect(await okData<Page>(await call(app, 'GET', '/api/answers'))).toEqual({ rows: [], total: 0 });
  });

  it('answers list is default-profile-scoped + LEAN (?q filters); /:id carries the value', async () => {
    const { app } = makeHarness();
    const all = await okData<Page>(await call(app, 'GET', '/api/answers'));
    expect(all.total).toBe(2);
    expect(all.rows[0]).not.toHaveProperty('value'); // payload discipline: value only on demand

    const filtered = await okData<Page>(await call(app, 'GET', '/api/answers?q=first'));
    expect(filtered.total).toBe(1);
    expect(filtered.rows[0]!.id).toBe('ans_2');

    const full = await okData<Record<string, unknown>>(await call(app, 'GET', '/api/answers/ans_1'));
    expect(full.value).toBe('8');
    expect((await call(app, 'GET', '/api/answers/ans_nope')).status).toBe(404);
  });
});

describe('GET /api/events', () => {
  it('recent ledger, ?kind filters, unknown kind → empty page (never a scan)', async () => {
    const { app } = makeHarness();
    expect((await okData<Page>(await call(app, 'GET', '/api/events'))).total).toBe(3);
    const imported = await okData<Page>(await call(app, 'GET', '/api/events?kind=imported'));
    expect(imported.total).toBe(1);
    expect(imported.rows[0]!.id).toBe('evt_1');
    expect(await okData<Page>(await call(app, 'GET', '/api/events?kind=discofever'))).toEqual({ rows: [], total: 0 });
  });
});

describe('POST /api/import/plan + /api/import/execute', () => {
  const SRC = 'C:/Users/pierr/AppData/Roaming/jat11-app/jat.db';

  it('validates sourcePath BEFORE probing (no network on a bad request)', async () => {
    const h = makeHarness();
    const res = await call(h.app, 'POST', '/api/import/plan', {});
    expect(res.status).toBe(400);
    expect((await errBody(res)).code).toBe('bad_request');
    expect(h.probeCalls()).toBe(0);
    expect(h.calls.plan).toEqual([]);
  });

  it('refuses while v11 answers on :7744 — enveloped 409, importer untouched', async () => {
    const h = makeHarness();
    h.setV11Running(true);
    for (const path of ['/api/import/plan', '/api/import/execute']) {
      const res = await call(h.app, 'POST', path, { sourcePath: SRC });
      expect(res.status, path).toBe(409);
      const e = await errBody(res);
      expect(e.code).toBe('v11_running');
      expect(e.message).toContain('7744');
    }
    expect(h.calls.plan).toEqual([]);
    expect(h.calls.execute).toEqual([]);
  });

  it('plans when v11 is down; executes with the migrateGmail flag threaded through', async () => {
    const h = makeHarness();
    const plan = await okData<{ willImport: boolean }>(await call(h.app, 'POST', '/api/import/plan', { sourcePath: SRC }));
    expect(plan.willImport).toBe(true);
    expect(h.calls.plan).toEqual([SRC]);

    const exec = await okData<{ importRunId: string; gmail: unknown }>(
      await call(h.app, 'POST', '/api/import/execute', { sourcePath: SRC, migrateGmail: true }),
    );
    expect(exec.importRunId).toBe('imp_test');
    expect(h.calls.execute).toEqual([{ sourcePath: SRC, migrateGmail: true }]);

    await okData(await call(h.app, 'POST', '/api/import/execute', { sourcePath: SRC }));
    expect(h.calls.execute[1]).toEqual({ sourcePath: SRC, migrateGmail: false }); // absent flag = false
  });

  it('a snapshotting importer skips the live-v11 refusal entirely', async () => {
    const h = makeHarness({ snapshots: true });
    h.setV11Running(true);
    await okData(await call(h.app, 'POST', '/api/import/plan', { sourcePath: SRC }));
    expect(h.probeCalls()).toBe(0); // never even probed
    expect(h.calls.plan).toEqual([SRC]);
  });

  it('typed importer refusals surface as snake_case envelope codes', async () => {
    const h = makeHarness();
    const res = await call(h.app, 'POST', '/api/import/plan', { sourcePath: 'C:/missing/jat.db' });
    expect(res.status).toBe(400);
    const e = await errBody(res);
    expect(e.code).toBe('not_found'); // 'NOT_FOUND' → snake_case contract
    expect(e.message).toContain('not found');
  });
});
