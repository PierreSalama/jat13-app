// Importer tests: build a SYNTHETIC v11 jat.db (v11-shaped tables + sample rows) in a temp file,
// run planImport + executeImport into a FRESH migrated v13 db, and assert the 13.0.1 FIDELITY RULES
// (engine-knowledge §14.5) plus the new-schema deltas:
//   • reconcileStatus: submitted_at present + pre-submit status → 'submitted' (never "Saved" lies)
//   • run source/lane derived from the JOB row (task table has no source column)
//   • event kind fallback kind||type; 'email'→email_matched; 'resume_tailored'→note
//   • created_at falls back to updated_at (never fabricated as now())
//   • sensitive-key drop; evidence-trust quarantine; stale in-flight dropped; deterministic ids
//   • settings only land for REGISTERED (section,key) rows; secrets never land anywhere
//   • documents keep bytes; new tables (fit_scores/autopsies/interviews/ai_calls) receive NOTHING
//   • apply_ledger rows for verified submits (dedup on re-run); copy-based snapshot; idempotency
// Plus the consent-gated gmail-creds migration (sealed via the secrets DAL).
// NOTE: this synthetic-db suite is the regression net; Stage-1 acceptance ALSO requires a run against
// a snapshot of the REAL jat.db with field-level spot-checks (01-ARCHITECTURE §7).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../app/src/main/db/index.js';
import {
  planImport,
  executeImport,
  snapshotV11,
  ImportError,
} from '../../app/src/main/importer/v11.js';
import {
  migrateGmailCredentials,
  GMAIL_CLIENT_ID_KEY,
  GMAIL_CLIENT_SECRET_KEY,
  gmailTokenSecretKey,
} from '../../app/src/main/importer/gmail-creds.js';
import { defaultContext, makeDal, type Sealer } from '../../app/src/main/db/dal/index.js';

const T = 1_700_000_000_000; // fixed epoch-ms for source-row timestamps
const T_NOW = 1_760_000_000_000; // a DIFFERENT injected "now" so fabricated timestamps are detectable

// ---- synthetic v11 DDL (a representative subset of the v11 shape the importer feature-detects) ----
// events uses the REAL v11 column name `type` (not `kind`) — the kind||type fallback is under test.
function buildV11Db(path: string, opts: { realDocPath?: string } = {}): void {
  const db = new Database(path);
  db.pragma('user_version = 15');
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, name TEXT, is_default INTEGER DEFAULT 0,
      source_assignments TEXT, data TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, source TEXT, external_id TEXT, title TEXT, company TEXT, location TEXT,
      work_mode TEXT, job_url TEXT, description TEXT, fit_data TEXT, fit_score INTEGER,
      apply_capability TEXT, status TEXT, tags TEXT, answers TEXT, attachments TEXT, notes TEXT,
      submitted_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE profile_fields (
      id TEXT PRIMARY KEY, profile_id TEXT, key_norm TEXT, label TEXT, value TEXT, field_type TEXT,
      confidence REAL, locked INTEGER, seen_count INTEGER, source TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE qa (
      id TEXT PRIMARY KEY, profile_id TEXT, question TEXT, question_norm TEXT, answer TEXT,
      seen_count INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, profile_id TEXT, name TEXT, role TEXT, file_path TEXT, mime TEXT,
      text_content TEXT, keywords TEXT, is_default INTEGER, created_at TEXT
    );
    CREATE TABLE emails (
      id TEXT PRIMARY KEY, from_addr TEXT, subject TEXT, body TEXT, sent_at TEXT,
      matched_job_id TEXT, match_confidence REAL, match_source TEXT, category TEXT, created_at TEXT
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY, at TEXT, type TEXT, job_id TEXT, summary TEXT, data TEXT
    );
    CREATE TABLE auto_apply_tasks (
      id TEXT PRIMARY KEY, job_id TEXT, status TEXT, apply_route TEXT, attempts INTEGER,
      submission_evidence TEXT, last_error TEXT, park_reason TEXT, transcript TEXT,
      created_at TEXT, started_at TEXT, finished_at TEXT, updated_at TEXT
    );
    CREATE TABLE settings ( section TEXT, key TEXT, value TEXT, PRIMARY KEY (section, key) );
    CREATE TABLE kv ( key TEXT PRIMARY KEY, value TEXT );
    CREATE TABLE punishments ( id TEXT PRIMARY KEY, company TEXT, title TEXT, reason TEXT, created_at TEXT );
    CREATE TABLE ai_log ( id TEXT PRIMARY KEY, msg TEXT );
  `);

  const iso = (ms: number) => new Date(ms).toISOString();

  // 1 default profile — created_at NULL on purpose: must fall back to updated_at, never T_NOW.
  db.prepare('INSERT INTO profiles (id, name, is_default, source_assignments, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('prof_main', 'Pierre', 1, '[]', JSON.stringify({ contact: { email: 'p@x.com' } }), null, iso(T));

  // jobs: A applied linkedin · B started indeed · C saved greenhouse · D "saved" BUT submitted_at set
  db.prepare(`INSERT INTO jobs (id, source, title, company, location, work_mode, job_url, description,
      fit_data, fit_score, apply_capability, status, tags, submitted_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('job_A', 'linkedin', 'Senior Engineer', 'Acme Corp', 'Toronto', 'remote',
      'https://linkedin.com/jobs/view/123?currentJobId=123&trk=x', 'Great role. '.repeat(10),
      JSON.stringify({ score: 88 }), 88, 'easy-apply', 'applied',
      JSON.stringify(['saved']), iso(T + 1000), iso(T), iso(T + 5000));
  db.prepare(`INSERT INTO jobs (id, source, title, company, location, work_mode, job_url, description,
      apply_capability, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('job_B', 'indeed', 'Junior Dev', 'Beta LLC', 'Remote', 'remote',
      'https://indeed.com/viewjob?jk=abc', 'Another role.', 'external', 'started', iso(T), iso(T));
  db.prepare(`INSERT INTO jobs (id, source, title, company, location, job_url, description,
      apply_capability, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('job_C', 'greenhouse', 'Platform Eng', 'Gamma Inc', 'Montreal',
      'https://boards.greenhouse.io/gamma/jobs/42?gh_jid=42', 'ATS role.', 'ats-form', 'saved', iso(T), iso(T));
  // job_D: the reconcileStatus case — pre-submit status but a REAL submitted_at.
  db.prepare(`INSERT INTO jobs (id, source, title, company, job_url, status, submitted_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('job_D', 'linkedin', 'Data Eng', 'Delta Co', 'https://linkedin.com/jobs/view/999',
      'saved', iso(T + 2000), iso(T), iso(T + 2000));

  // normal profile_field (created_at NULL → falls back to updated_at) + a SENSITIVE one (dropped)
  db.prepare('INSERT INTO profile_fields (id, profile_id, key_norm, label, value, field_type, confidence, locked, seen_count, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('pf_1', 'prof_main', 'phone', 'Phone number', '555-1234', 'text', 0.9, 0, 5, 'linkedin.com', null, iso(T + 7000));
  db.prepare('INSERT INTO profile_fields (id, profile_id, key_norm, label, value, field_type, confidence, locked, seen_count, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('pf_sens', 'prof_main', 'gender', 'What is your gender?', 'prefer not to say', 'select', 0.5, 0, 2, 'greenhouse.io', iso(T), iso(T));

  // a qa row (created_at NULL → falls back to updated_at)
  db.prepare('INSERT INTO qa (id, profile_id, question, question_norm, answer, seen_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('qa_1', 'prof_main', 'Are you authorized to work in Canada?', 'authorized canada work', 'Yes', 3, null, iso(T + 8000));

  // documents: one MISSING file, one REAL file on disk (bytes must be kept)
  db.prepare('INSERT INTO documents (id, profile_id, name, role, file_path, mime, text_content, keywords, is_default, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('doc_1', 'prof_main', 'CS_Resume_2024.pdf', 'coverLetter', 'C:\\definitely\\missing\\resume.pdf', 'application/pdf', 'Resume text here', JSON.stringify(['react']), 1, iso(T));
  if (opts.realDocPath) {
    db.prepare('INSERT INTO documents (id, profile_id, name, role, file_path, mime, text_content, keywords, is_default, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('doc_2', 'prof_main', 'Master_Resume.pdf', 'resume', opts.realDocPath, 'application/pdf', 'Master resume text', '[]', 0, iso(T));
  }

  // an email matched to job_A + one matched to a NON-EXISTENT job (match dropped, email imports)
  db.prepare('INSERT INTO emails (id, from_addr, subject, body, sent_at, matched_job_id, match_confidence, match_source, category, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('eml_1', 'jobs@acme.com', 'Application received', 'Thanks for applying', iso(T + 2000), 'job_A', 0.95, 'auto', 'confirmation', iso(T + 2000));
  db.prepare('INSERT INTO emails (id, from_addr, subject, body, matched_job_id, match_confidence, match_source, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('eml_2', 'noreply@ghost.com', 'Unrelated', 'x', 'job_GHOST', 0.4, 'suggested', iso(T));

  // events under the REAL v11 `type` column: kept+mapped, kept-as-is, and dropped kinds
  const insEv = db.prepare('INSERT INTO events (id, at, type, job_id, summary, data) VALUES (?,?,?,?,?,?)');
  insEv.run('ev_status', iso(T), 'status_changed', 'job_A', 'moved to applied', JSON.stringify({ from: 'tracked' }));
  insEv.run('ev_email', iso(T + 100), 'email', 'job_A', 'confirmation matched', null); // → email_matched
  insEv.run('ev_resume', iso(T + 200), 'resume_tailored', 'job_A', 'tailored for Acme', null); // → note
  insEv.run('ev_junk', iso(T + 300), 'progressing', 'job_A', 'noise', null); // dropped
  insEv.run('ev_junk2', iso(T + 400), 'detector_ping', 'job_A', 'noise', null); // dropped (unknown)

  // auto_apply_tasks (NO source column — the v11 truth): done+trustworthy-evidence on linkedin job,
  // done+no-evidence, failed on the INDEED job, parked on the GREENHOUSE job, queued (stale, dropped)
  db.prepare(`INSERT INTO auto_apply_tasks (id, job_id, status, apply_route, attempts,
      submission_evidence, last_error, transcript, created_at, finished_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('task_done_ok', 'job_A', 'done', 'easy-apply', 1,
      JSON.stringify({ type: 'verified', detail: 'text-became-success' }), null,
      'x'.repeat(1000), iso(T), iso(T + 3000), iso(T + 3000));
  db.prepare(`INSERT INTO auto_apply_tasks (id, job_id, status, apply_route, attempts,
      submission_evidence, last_error, transcript, created_at, finished_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('task_done_noevi', 'job_A', 'done', 'easy-apply', 1, null, null, 'y'.repeat(500), iso(T), iso(T + 3500), iso(T + 3500));
  db.prepare(`INSERT INTO auto_apply_tasks (id, job_id, status, apply_route, attempts,
      last_error, transcript, created_at, finished_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('task_failed', 'job_B', 'failed', 'external', 2, 'timeout waiting for form', 'z'.repeat(200), iso(T), iso(T + 4000), iso(T + 4000));
  db.prepare(`INSERT INTO auto_apply_tasks (id, job_id, status, apply_route, park_reason, created_at, finished_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run('task_parked', 'job_C', 'parked', 'ats-form', 'captcha detected on final step', iso(T), iso(T + 4500), iso(T + 4500));
  db.prepare(`INSERT INTO auto_apply_tasks (id, job_id, status, apply_route, attempts, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)`)
    .run('task_queued', 'job_B', 'queued', 'external', 0, iso(T), iso(T));

  // settings: allow-mapped but UNREGISTERED (skipped) + registered notifications.onApply (lands) +
  // a SECRET that must never import + a secret-shaped key inside the allowed notifications section
  const insSet = db.prepare('INSERT INTO settings (section, key, value) VALUES (?,?,?)');
  insSet.run('autoApply', 'keywords', JSON.stringify(['engineer', 'developer']));
  insSet.run('appearance', 'theme', JSON.stringify('dark'));
  insSet.run('notifications', 'onApply', 'false');
  insSet.run('notifications', 'webhookToken', JSON.stringify('tok-NEVER-IMPORT'));
  insSet.run('ai', 'apiKey', JSON.stringify('sk-SECRET-KEY-NEVER-IMPORT'));

  // punishments exist in v11 but v13 has no blocklist table → warned, not carried
  db.prepare('INSERT INTO punishments (id, company, title, reason, created_at) VALUES (?,?,?,?,?)')
    .run('pun_1', 'Scam Inc', 'Data Entry', 'spam employer', iso(T));

  db.close();
}

/** Reversible fake — vitest has no Electron safeStorage; the DAL treats sealed bytes as opaque. */
const fakeSealer: Sealer = {
  available: () => true,
  seal: (plaintext) => Buffer.from(`sealed:${plaintext}`, 'utf8'),
  open: (sealed) => sealed.toString('utf8').replace(/^sealed:/, ''),
};

describe('v11 → v13 importer', () => {
  let dir: string;
  let sourcePath: string;
  let realDocPath: string;
  let v13db: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jat-import-'));
    sourcePath = join(dir, 'jat.db');
    realDocPath = join(dir, 'Master_Resume.pdf');
    writeFileSync(realDocPath, Buffer.from('%PDF-1.4 fake master resume bytes'));
    buildV11Db(sourcePath, { realDocPath });
    ({ db: v13db } = openDatabase({ file: join(dir, 'jat13.db') }));
  });
  afterEach(() => {
    v13db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = () => executeImport(v13db, sourcePath, { now: () => T_NOW });
  const get = <R>(sql: string, ...params: unknown[]): R => v13db.prepare(sql).get(...params) as R;
  const count = (sql: string): number => (v13db.prepare(sql).get() as { c: number }).c;

  it('plan() is read-only and reports honest counts without touching v13', () => {
    const report = planImport(sourcePath);
    expect(report.source.v11_user_version).toBe(15);
    expect(report.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.jobs.found).toBe(4);
    expect(report.answers.fields.droppedSensitive).toBe(1);
    expect(report.answers.qa.found).toBe(1);
    expect(report.runs.droppedInFlight).toBe(1); // the queued task
    expect(report.runs.submittedVerified).toBe(1);
    expect(report.runs.quarantinedLegacy).toBe(1);
    expect(report.events.droppedKinds['progressing']).toBe(1);
    expect(report.events.droppedKinds['detector_ping']).toBe(1);
    // punishments warned, never a section
    expect(report.source.warnings.join(' ')).toContain('punishment');
    // v13 untouched by plan
    expect(count('SELECT COUNT(*) c FROM jobs')).toBe(0);
    expect(count('SELECT COUNT(*) c FROM import_runs')).toBe(0);
  });

  it('plan and execute counts agree (shared decision functions)', () => {
    const plan = planImport(sourcePath);
    const res = run();
    expect(res.report.jobs.toCreate).toBe(plan.jobs.toCreate);
    expect(res.report.applications.toCreate).toBe(plan.applications.toCreate);
    expect(res.report.applications.byStatus).toEqual(plan.applications.byStatus);
    expect(res.report.runs).toEqual(plan.runs);
    expect(res.report.events.toCreate).toBe(plan.events.toCreate);
    expect(res.report.settings.imported).toEqual(plan.settings.imported);
    // …and the executed rows match the promised counts
    expect(count('SELECT COUNT(*) c FROM jobs')).toBe(plan.jobs.toCreate);
    expect(count('SELECT COUNT(*) c FROM applications')).toBe(plan.applications.toCreate);
    expect(count('SELECT COUNT(*) c FROM apply_runs')).toBe(plan.runs.toCreate);
    expect(count('SELECT COUNT(*) c FROM events')).toBe(plan.events.toCreate);
  });

  it('carries jobs + deterministic appl_v11_ applications with mapped statuses', () => {
    const res = run();
    expect(res.status).toBe('ok');
    expect(res.sectionErrors).toEqual([]);

    expect(get('SELECT 1 FROM jobs WHERE id = ?', 'job_A')).toBeDefined();
    expect(get('SELECT 1 FROM jobs WHERE id = ?', 'job_B')).toBeDefined();
    const det = get<{ description: string }>('SELECT description FROM job_details WHERE job_id = ?', 'job_A');
    expect(det.description.length).toBeGreaterThan(0);
    const job = get<{ job_url_norm: string; company_key: string }>('SELECT job_url_norm, company_key FROM jobs WHERE id = ?', 'job_A');
    expect(job.job_url_norm).toContain('linkedin.com/jobs/view/123');
    expect(job.company_key).toBe('acme corp');

    const applA = get<{ id: string; status: string; via: string }>('SELECT id, status, via FROM applications WHERE id = ?', 'appl_v11_job_A');
    expect(applA.id).toBe('appl_v11_job_A');
    expect(applA.status).toBe('submitted'); // 'applied' → 'submitted'
    expect(applA.via).toBe('import');
    const applB = get<{ status: string }>('SELECT status FROM applications WHERE id = ?', 'appl_v11_job_B');
    expect(applB.status).toBe('tracked'); // 'started' → 'tracked'
  });

  it("FIDELITY reconcileStatus: 'saved' + real submitted_at → 'submitted' (never shows Saved)", () => {
    const res = run();
    const applD = get<{ status: string; submitted_at: number }>('SELECT status, submitted_at FROM applications WHERE id = ?', 'appl_v11_job_D');
    expect(applD.status).toBe('submitted');
    expect(applD.submitted_at).toBe(T + 2000);
    // the funnel agrees: 2 submitted (job_A applied, job_D reconciled)
    expect(res.report.applications.byStatus['submitted']).toBe(2);
    expect(count("SELECT COUNT(*) c FROM applications WHERE status = 'submitted'")).toBe(2);
  });

  it('FIDELITY run source/lane derived from the JOB row (task table has no source column)', () => {
    run();
    const a = get<{ source: string; lane: string }>('SELECT source, lane FROM apply_runs WHERE id = ?', 'run_v11_task_done_ok');
    expect(a).toEqual({ source: 'linkedin', lane: 'linkedin' });
    const b = get<{ source: string; lane: string }>('SELECT source, lane FROM apply_runs WHERE id = ?', 'run_v11_task_failed');
    expect(b).toEqual({ source: 'indeed', lane: 'indeed' }); // NOT stamped linkedin
    const c = get<{ source: string; lane: string; park_kind: string }>('SELECT source, lane, park_kind FROM apply_runs WHERE id = ?', 'run_v11_task_parked');
    expect(c.source).toBe('greenhouse');
    expect(c.lane).toBe('ats');
    expect(c.park_kind).toBe('captcha');
  });

  it("FIDELITY event mapping: kind||type fallback, 'email'→email_matched, 'resume_tailored'→note, junk dropped", () => {
    run();
    expect(get<{ kind: string }>('SELECT kind FROM events WHERE id = ?', 'ev_status').kind).toBe('status_change');
    expect(get<{ kind: string }>('SELECT kind FROM events WHERE id = ?', 'ev_email').kind).toBe('email_matched');
    expect(get<{ kind: string }>('SELECT kind FROM events WHERE id = ?', 'ev_resume').kind).toBe('note');
    expect(get('SELECT 1 FROM events WHERE id = ?', 'ev_junk')).toBeUndefined();
    expect(get('SELECT 1 FROM events WHERE id = ?', 'ev_junk2')).toBeUndefined();
    // events hang off the imported job + deterministic application, with their REAL timestamps
    const ev = get<{ job_id: string; application_id: string; at: number }>('SELECT job_id, application_id, at FROM events WHERE id = ?', 'ev_email');
    expect(ev.job_id).toBe('job_A');
    expect(ev.application_id).toBe('appl_v11_job_A');
    expect(ev.at).toBe(T + 100);
  });

  it('FIDELITY created_at falls back to updated_at — timelines are never fabricated as now()', () => {
    run();
    // profile: created_at NULL in v11 → updated_at (T), not T_NOW
    expect(get<{ created_at: number }>('SELECT created_at FROM profiles WHERE id = ?', 'prof_main').created_at).toBe(T);
    // field + qa rows likewise
    expect(get<{ created_at: number }>('SELECT created_at FROM learned_answers WHERE id = ?', 'pf_1').created_at).toBe(T + 7000);
    expect(get<{ created_at: number }>('SELECT created_at FROM learned_answers WHERE id = ?', 'qa_1').created_at).toBe(T + 8000);
  });

  it('drops the sensitive field (counted) while importing the normal field + qa', () => {
    const report = run().report;
    expect(report.answers.fields.droppedSensitive).toBe(1);

    const pf = get<{ provenance: string; kind: string; value: string }>('SELECT provenance, kind, value FROM learned_answers WHERE id = ?', 'pf_1');
    expect(pf.kind).toBe('field');
    expect(pf.provenance).toBe('import_v11');
    expect(pf.value).toBe('555-1234');
    expect(get('SELECT 1 FROM learned_answers WHERE id = ?', 'pf_sens')).toBeUndefined();
    expect(get("SELECT 1 FROM learned_answers WHERE key_norm = 'gender'", ...[])).toBeUndefined();

    const qa = get<{ kind: string; label: string; value: string; confidence: number }>("SELECT kind, label, value, confidence FROM learned_answers WHERE id = 'qa_1'");
    expect(qa.kind).toBe('qa');
    expect(qa.value).toBe('Yes');
    expect(qa.confidence).toBeCloseTo(0.7);
  });

  it('maps a done+trustworthy-evidence task to a submitted run AND a ledger row (cap authority)', () => {
    run();
    const runRow = get<{ state: string; evidence_kind: string }>('SELECT state, evidence_kind FROM apply_runs WHERE id = ?', 'run_v11_task_done_ok');
    expect(runRow.state).toBe('submitted');
    expect(runRow.evidence_kind).toBe('text_became_success');
    // exactly ONE ledger row, for the verified submit only, stamped with the run's finish time
    const ledger = v13db.prepare('SELECT run_id, source, submitted_at FROM apply_ledger').all() as { run_id: string; source: string; submitted_at: number }[];
    expect(ledger).toEqual([{ run_id: 'run_v11_task_done_ok', source: 'linkedin', submitted_at: T + 3000 }]);
  });

  it('quarantines a done+no-evidence task as parked/legacy_untrusted (no ledger row)', () => {
    run();
    const runRow = get<{ state: string; park_kind: string; evidence_kind: string }>('SELECT state, park_kind, evidence_kind FROM apply_runs WHERE id = ?', 'run_v11_task_done_noevi');
    expect(runRow.state).toBe('parked');
    expect(runRow.park_kind).toBe('awaiting_review');
    expect(runRow.evidence_kind).toBe('legacy_untrusted');
    expect(get('SELECT 1 FROM apply_ledger WHERE run_id = ?', 'run_v11_task_done_noevi')).toBeUndefined();
  });

  it('imports the failed run and does NOT import the queued (stale in-flight) task', () => {
    run();
    const failed = get<{ state: string; error: string }>('SELECT state, error FROM apply_runs WHERE id = ?', 'run_v11_task_failed');
    expect(failed.state).toBe('failed');
    expect(failed.error).toContain('timeout');
    expect(get('SELECT 1 FROM apply_runs WHERE id = ?', 'run_v11_task_queued')).toBeUndefined();
  });

  it('imports the email + its match, and drops a match whose job is absent', () => {
    run();
    expect(get('SELECT 1 FROM emails WHERE id = ?', 'eml_1')).toBeDefined();
    expect(get('SELECT 1 FROM emails WHERE id = ?', 'eml_2')).toBeDefined();
    const acct = get<{ kind: string }>("SELECT kind FROM email_accounts WHERE id = 'acct_v11_imported'");
    expect(acct.kind).toBe('imported');
    const m = get<{ job_id: string; application_id: string; match_via: string; source: string }>('SELECT job_id, application_id, match_via, source FROM email_matches WHERE email_id = ?', 'eml_1');
    expect(m.job_id).toBe('job_A');
    expect(m.application_id).toBe('appl_v11_job_A');
    expect(m.match_via).toBe('import');
    expect(m.source).toBe('auto');
    expect(get('SELECT 1 FROM email_matches WHERE email_id = ?', 'eml_2')).toBeUndefined();
  });

  it('DELTA settings: only REGISTERED (section,key) rows land; secrets never land anywhere', () => {
    const report = run().report;
    // registered boolean: notifications.onApply landed with the v11 value
    expect(report.settings.imported).toContain('notifications.onApply');
    expect(get<{ value_json: string }>("SELECT value_json FROM settings WHERE section='notifications' AND key='onApply'").value_json).toBe('false');
    // autoApply.keywords is a REGISTERED Stage-3 key now → it LANDS (was skipped pre-Stage-3).
    expect(report.settings.imported).toContain('autoApply.keywords');
    expect(get<{ value_json: string }>("SELECT value_json FROM settings WHERE section='autoApply' AND key='keywords'").value_json).toContain('engineer');
    // appearance.theme is STILL unregistered (the registry key is themeId, not theme) → skipped, not written
    const skippedKeys = report.settings.skipped.map((s) => s.key);
    expect(skippedKeys).toContain('appearance.theme');
    expect(get("SELECT 1 FROM settings WHERE section='appearance'")).toBeUndefined();
    // secret-shaped key inside an allowed section → dropped
    expect(report.settings.skipped).toContainEqual({ key: 'notifications.webhookToken', reason: 'secret_shaped' });
    // secrets NEVER imported, under any section or key
    expect(get("SELECT 1 FROM settings WHERE section='ai'")).toBeUndefined();
    const allSettings = JSON.stringify(v13db.prepare('SELECT * FROM settings').all());
    expect(allSettings).not.toContain('SECRET-KEY');
    expect(allSettings).not.toContain('NEVER-IMPORT');
  });

  it('DELTA documents keep bytes: real file → blob + sha; missing file → metadata row, no blob', () => {
    const report = run().report;
    expect(report.documents.missingFile).toBe(1);
    // missing file: metadata kept, flagged, no blob, text carried
    const doc = get<{ missing_file: number; origin_path: string; role: string }>('SELECT missing_file, origin_path, role FROM documents WHERE id = ?', 'doc_1');
    expect(doc.missing_file).toBe(1);
    expect(doc.origin_path).toContain('missing');
    expect(doc.role).toBe('cover_letter'); // coverLetter → cover_letter
    expect(get('SELECT 1 FROM document_blobs WHERE document_id = ?', 'doc_1')).toBeUndefined();
    expect(get('SELECT 1 FROM document_text WHERE document_id = ?', 'doc_1')).toBeDefined();
    // real file: bytes IN the database, sha + size recorded
    const real = get<{ missing_file: number; sha256: string; size_bytes: number }>('SELECT missing_file, sha256, size_bytes FROM documents WHERE id = ?', 'doc_2');
    expect(real.missing_file).toBe(0);
    expect(real.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(real.size_bytes).toBeGreaterThan(0);
    const blob = get<{ bytes: Buffer }>('SELECT bytes FROM document_blobs WHERE document_id = ?', 'doc_2');
    expect(Buffer.from(blob.bytes).toString('utf8')).toContain('fake master resume bytes');
  });

  it('DELTA new v13 tables receive NOTHING from v11', () => {
    run();
    expect(count('SELECT COUNT(*) c FROM fit_scores')).toBe(0);
    expect(count('SELECT COUNT(*) c FROM autopsies')).toBe(0);
    expect(count('SELECT COUNT(*) c FROM interviews')).toBe(0);
    expect(count('SELECT COUNT(*) c FROM ai_calls')).toBe(0);
    expect(count('SELECT COUNT(*) c FROM apply_run_steps')).toBe(0);
  });

  it('is idempotent — a second run inserts nothing new (incl. the ledger) and stays ok', () => {
    run();
    const snapshot = () => ({
      jobs: count('SELECT COUNT(*) c FROM jobs'),
      appl: count('SELECT COUNT(*) c FROM applications'),
      ans: count('SELECT COUNT(*) c FROM learned_answers'),
      runs: count('SELECT COUNT(*) c FROM apply_runs'),
      ledger: count('SELECT COUNT(*) c FROM apply_ledger'),
      docs: count('SELECT COUNT(*) c FROM documents'),
      blobs: count('SELECT COUNT(*) c FROM document_blobs'),
      settings: count('SELECT COUNT(*) c FROM settings'),
    });
    const before = snapshot();
    const res2 = run();
    expect(res2.status).toBe('ok');
    expect(snapshot()).toEqual(before);
    // two audit rows (one per execute)
    expect(count('SELECT COUNT(*) c FROM import_runs')).toBe(2);
  });

  it('writes an import_runs audit row with the report', () => {
    const res = run();
    const row = get<{ status: string; source_sha256: string; v11_user_version: number; dry_run: number; report_json: string }>(
      'SELECT status, source_sha256, v11_user_version, dry_run, report_json FROM import_runs WHERE id = ?', res.importRunId);
    expect(row.status).toBe('ok');
    expect(row.dry_run).toBe(0);
    expect(row.v11_user_version).toBe(15);
    expect(row.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => JSON.parse(row.report_json)).not.toThrow();
  });

  it('snapshotV11 copies db (+sidecars) to a temp dir; import runs off the COPY, source untouched', () => {
    // fake a leftover sidecar next to the source (a live v11 usually has one)
    writeFileSync(sourcePath + '-wal', '');
    const before = statSync(sourcePath).mtimeMs;
    const snap = snapshotV11(sourcePath);
    try {
      expect(snap.path).not.toBe(sourcePath);
      expect(existsSync(snap.path)).toBe(true);
      expect(existsSync(snap.path + '-wal')).toBe(true);
      const res = executeImport(v13db, snap.path, { now: () => T_NOW });
      expect(res.status).toBe('ok');
      expect(count('SELECT COUNT(*) c FROM jobs')).toBe(4);
      // audit row records the SNAPSHOT path it actually read
      const audit = get<{ source_path: string }>('SELECT source_path FROM import_runs WHERE id = ?', res.importRunId);
      expect(audit.source_path).toBe(snap.path);
      expect(statSync(sourcePath).mtimeMs).toBe(before); // source file never touched
    } finally {
      rmSync(snap.dir, { recursive: true, force: true });
    }
  });

  it('refuses with V11_LOCK_PRESENT when pointed at a LIVE v11 (jat.db.lock directory present)', () => {
    mkdirSync(join(dir, 'jat.db.lock'));
    expect(() => planImport(sourcePath)).toThrow(ImportError);
    try {
      planImport(sourcePath);
    } catch (e) {
      expect((e as ImportError).code).toBe('V11_LOCK_PRESENT');
    }
    // …but the snapshot path has no lock dir, so the copy imports fine
    const snap = snapshotV11(sourcePath);
    try {
      expect(() => planImport(snap.path)).not.toThrow();
    } finally {
      rmSync(snap.dir, { recursive: true, force: true });
    }
  });

  it('never opens the source writable — leaves the file content unchanged', () => {
    const before = planImport(sourcePath).source.sha256;
    run();
    const after = planImport(sourcePath).source.sha256;
    expect(after).toBe(before);
    expect(statSync(sourcePath).size).toBeGreaterThan(0);
  });
});

// ==================================================================================================
//  gmail-creds migration (consent-gated, sealed via the secrets DAL)
// ==================================================================================================

describe('gmail-creds migration', () => {
  let dir: string;
  let sourcePath: string;
  let v13db: DB;

  /** v11-shaped source with ONLY the gmail-relevant tables. */
  function buildV11Gmail(path: string, opts: { sealed?: boolean } = {}): void {
    const db = new Database(path);
    db.pragma('user_version = 15');
    db.exec(`
      CREATE TABLE settings ( section TEXT PRIMARY KEY, value TEXT );
      CREATE TABLE kv ( key TEXT PRIMARY KEY, value TEXT );
    `);
    const seal = (s: string) => (opts.sealed ? `enc:v1:${Buffer.from(s).toString('base64')}` : s);
    db.prepare('INSERT INTO settings (section, value) VALUES (?,?)').run('gmail', JSON.stringify({
      clientId: 'client-id-123.apps.googleusercontent.com',
      clientSecret: seal('the-client-secret'),
      query: 'newer_than:60d (subject:application OR subject:interview)',
      email: 'Pierre@Example.com',
      enabled: true,
    }));
    db.prepare('INSERT INTO kv (key, value) VALUES (?,?)').run('gmailTokens', seal(JSON.stringify({
      refresh_token: 'refresh-token-xyz',
      access_token: 'access-token-abc',
      expires_at: T + 3_600_000,
    })));
    db.close();
  }

  /** decodes the enc:v1: base64 the builder above produced. */
  const fakeUnseal = (stored: string) => Buffer.from(stored.slice('enc:v1:'.length), 'base64').toString('utf8');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jat-gmail-'));
    sourcePath = join(dir, 'jat.db');
    ({ db: v13db } = openDatabase({ file: join(dir, 'jat13.db') }));
  });
  afterEach(() => {
    v13db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function freshDal() {
    return makeDal(defaultContext(v13db), { sealer: fakeSealer });
  }

  it('is a no-op without consent (the master gate)', () => {
    buildV11Gmail(sourcePath, { sealed: true });
    const res = migrateGmailCredentials(v13db, sourcePath, { dal: freshDal(), unsealV11: fakeUnseal });
    expect(res).toEqual({ migrated: false, reason: 'not_consented' });
    expect(v13db.prepare('SELECT COUNT(*) c FROM secrets').get()).toEqual({ c: 0 });
    expect(v13db.prepare('SELECT COUNT(*) c FROM email_accounts').get()).toEqual({ c: 0 });
  });

  it('migrates sealed v11 creds: secrets sealed under the convention keys, account healthy', () => {
    buildV11Gmail(sourcePath, { sealed: true });
    const dal = freshDal();
    const res = migrateGmailCredentials(v13db, sourcePath, { dal, unsealV11: fakeUnseal, now: () => T_NOW }, { consent: true });
    expect(res.migrated).toBe(true);
    expect(res.accountId).toBe('acct_v11_gmail');
    expect(res.email).toBe('pierre@example.com');

    // sealed round-trips through the DAL under EXACTLY the convention-locked keys
    expect(dal.secrets.open(GMAIL_CLIENT_ID_KEY)).toBe('client-id-123.apps.googleusercontent.com');
    expect(dal.secrets.open(GMAIL_CLIENT_SECRET_KEY)).toBe('the-client-secret');
    const tokens = JSON.parse(dal.secrets.open(gmailTokenSecretKey('acct_v11_gmail'))!) as Record<string, unknown>;
    expect(tokens.refresh_token).toBe('refresh-token-xyz');
    expect(tokens.access_token).toBe('access-token-abc');
    expect(tokens.expiry_date).toBe(T + 3_600_000);

    // account row: gmail_oauth, healthy, deterministic id
    const acct = v13db.prepare('SELECT kind, token_state, email FROM email_accounts WHERE id = ?').get('acct_v11_gmail') as { kind: string; token_state: string; email: string };
    expect(acct.kind).toBe('gmail_oauth');
    expect(acct.token_state).toBe('healthy');

    // no plaintext secret ever lands in settings (gmail.query is unregistered until Stage 5 → skipped)
    const allSettings = JSON.stringify(v13db.prepare('SELECT * FROM settings').all());
    expect(allSettings).not.toContain('the-client-secret');
    expect(allSettings).not.toContain('refresh-token-xyz');
    expect(v13db.prepare("SELECT 1 FROM settings WHERE section='gmail'").get()).toBeUndefined();

    // idempotent: re-run touches nothing new
    const res2 = migrateGmailCredentials(v13db, sourcePath, { dal, unsealV11: fakeUnseal, now: () => T_NOW }, { consent: true });
    expect(res2.migrated).toBe(true);
    expect((v13db.prepare('SELECT COUNT(*) c FROM email_accounts').get() as { c: number }).c).toBe(1);
  });

  it('no-ops cleanly when values are sealed and no unsealer is available', () => {
    buildV11Gmail(sourcePath, { sealed: true });
    const res = migrateGmailCredentials(v13db, sourcePath, { dal: freshDal() }, { consent: true });
    expect(res.migrated).toBe(false);
    expect(res.reason).toBe('sealed_no_unsealer');
    expect(v13db.prepare('SELECT COUNT(*) c FROM secrets').get()).toEqual({ c: 0 });
  });

  it('no-ops with source_missing / no_gmail_settings on absent or gmail-less sources', () => {
    const missing = migrateGmailCredentials(v13db, join(dir, 'nope.db'), { dal: freshDal() }, { consent: true });
    expect(missing.reason).toBe('source_missing');

    // a v11 with settings but no gmail section
    const db = new Database(sourcePath);
    db.exec('CREATE TABLE settings ( section TEXT PRIMARY KEY, value TEXT );');
    db.close();
    const none = migrateGmailCredentials(v13db, sourcePath, { dal: freshDal() }, { consent: true });
    expect(none.reason).toBe('no_gmail_settings');
  });
});
