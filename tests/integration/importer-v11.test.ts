// Integration test for the v11 → v12 importer. Builds a SYNTHETIC v11 jat.db (v11-shaped tables +
// sample rows) in a temp file, then runs planImport + executeImport into a FRESH migrated v12 db and
// asserts the mapping table's load-bearing rules: id preservation, deterministic appl/run ids,
// sensitive-key drops, evidence trust → 'submitted' vs quarantined 'parked', stale in-flight NOT
// imported, email+match, punishment→blocklist, and secrets absent.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../app/src/main/db/index.js';
import { planImport, executeImport, ImportError } from '../../app/src/main/importer/v11.js';

const T = 1_700_000_000_000; // fixed epoch-ms

// ---- synthetic v11 DDL (a representative subset of the v11 shape the importer feature-detects) ----
function buildV11Db(path: string): void {
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
      confidence REAL, locked INTEGER, seen_count INTEGER, source TEXT, created_at TEXT
    );
    CREATE TABLE qa (
      id TEXT PRIMARY KEY, profile_id TEXT, question TEXT, question_norm TEXT, answer TEXT,
      seen_count INTEGER, created_at TEXT
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
      id TEXT PRIMARY KEY, at TEXT, kind TEXT, job_id TEXT, summary TEXT, data TEXT
    );
    CREATE TABLE auto_apply_tasks (
      id TEXT PRIMARY KEY, job_id TEXT, source TEXT, status TEXT, apply_route TEXT, attempts INTEGER,
      submission_evidence TEXT, last_error TEXT, park_reason TEXT, transcript TEXT,
      created_at TEXT, started_at TEXT, finished_at TEXT, updated_at TEXT
    );
    CREATE TABLE settings ( section TEXT, key TEXT, value TEXT, PRIMARY KEY (section, key) );
    CREATE TABLE punishments ( id TEXT PRIMARY KEY, company TEXT, title TEXT, reason TEXT, created_at TEXT );
    CREATE TABLE ai_log ( id TEXT PRIMARY KEY, msg TEXT );
  `);

  const iso = (ms: number) => new Date(ms).toISOString();

  // 1 default profile
  db.prepare('INSERT INTO profiles (id, name, is_default, source_assignments, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('prof_main', 'Pierre', 1, '[]', JSON.stringify({ contact: { email: 'p@x.com' } }), iso(T), iso(T));

  // 2 jobs — one applied (submitted), one tracked
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

  // normal profile_field + a SENSITIVE one (gender) that must be dropped
  db.prepare('INSERT INTO profile_fields (id, profile_id, key_norm, label, value, field_type, confidence, locked, seen_count, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('pf_1', 'prof_main', 'phone', 'Phone number', '555-1234', 'text', 0.9, 0, 5, 'linkedin.com', iso(T));
  db.prepare('INSERT INTO profile_fields (id, profile_id, key_norm, label, value, field_type, confidence, locked, seen_count, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('pf_sens', 'prof_main', 'gender', 'What is your gender?', 'prefer not to say', 'select', 0.5, 0, 2, 'greenhouse.io', iso(T));

  // a qa row
  db.prepare('INSERT INTO qa (id, profile_id, question, question_norm, answer, seen_count, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('qa_1', 'prof_main', 'Are you authorized to work in Canada?', 'authorized canada work', 'Yes', 3, iso(T));

  // a document with a MISSING file_path
  db.prepare('INSERT INTO documents (id, profile_id, name, role, file_path, mime, text_content, keywords, is_default, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('doc_1', 'prof_main', 'CS_Resume_2024.pdf', 'coverLetter', 'C:\\definitely\\missing\\resume.pdf', 'application/pdf', 'Resume text here', JSON.stringify(['react']), 1, iso(T));

  // an email matched to job_A
  db.prepare('INSERT INTO emails (id, from_addr, subject, body, sent_at, matched_job_id, match_confidence, match_source, category, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('eml_1', 'jobs@acme.com', 'Application received', 'Thanks for applying', iso(T + 2000), 'job_A', 0.95, 'auto', 'confirmation', iso(T + 2000));
  // an email matched to a NON-EXISTENT job (match must be dropped, email still imports)
  db.prepare('INSERT INTO emails (id, from_addr, subject, body, matched_job_id, match_confidence, match_source, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('eml_2', 'noreply@ghost.com', 'Unrelated', 'x', 'job_GHOST', 0.4, 'suggested', iso(T));

  // an event (status_change → kept) and a junk event (dropped)
  db.prepare('INSERT INTO events (id, at, kind, job_id, summary, data) VALUES (?,?,?,?,?,?)')
    .run('ev_1', iso(T), 'status_change', 'job_A', 'moved to applied', JSON.stringify({ from: 'tracked' }));
  db.prepare('INSERT INTO events (id, at, kind, job_id, summary, data) VALUES (?,?,?,?,?,?)')
    .run('ev_2', iso(T), 'detector_ping', 'job_A', 'noise', null);

  // auto_apply_tasks: done+trustworthy-evidence, done+no-evidence, failed, queued(stale, dropped)
  db.prepare(`INSERT INTO auto_apply_tasks (id, job_id, source, status, apply_route, attempts,
      submission_evidence, last_error, transcript, created_at, finished_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('task_done_ok', 'job_A', 'linkedin', 'done', 'easy-apply', 1,
      JSON.stringify({ type: 'verified', detail: 'text-became-success' }), null,
      'x'.repeat(1000), iso(T), iso(T + 3000), iso(T + 3000));
  db.prepare(`INSERT INTO auto_apply_tasks (id, job_id, source, status, apply_route, attempts,
      submission_evidence, last_error, transcript, created_at, finished_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('task_done_noevi', 'job_A', 'linkedin', 'done', 'easy-apply', 1, null, null, 'y'.repeat(500), iso(T), iso(T + 3500), iso(T + 3500));
  db.prepare(`INSERT INTO auto_apply_tasks (id, job_id, source, status, apply_route, attempts,
      last_error, transcript, created_at, finished_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('task_failed', 'job_B', 'indeed', 'failed', 'external', 2, 'timeout waiting for form', 'z'.repeat(200), iso(T), iso(T + 4000), iso(T + 4000));
  db.prepare(`INSERT INTO auto_apply_tasks (id, job_id, source, status, apply_route, attempts, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run('task_queued', 'job_B', 'indeed', 'queued', 'external', 0, iso(T), iso(T));

  // settings: allowed + a SECRET that must never import
  db.prepare('INSERT INTO settings (section, key, value) VALUES (?,?,?)').run('autoApply', 'keywords', JSON.stringify(['engineer', 'developer']));
  db.prepare('INSERT INTO settings (section, key, value) VALUES (?,?,?)').run('appearance', 'theme', JSON.stringify('dark'));
  db.prepare('INSERT INTO settings (section, key, value) VALUES (?,?,?)').run('ai', 'apiKey', JSON.stringify('sk-SECRET-KEY-NEVER-IMPORT'));

  // punishment → blocklist
  db.prepare('INSERT INTO punishments (id, company, title, reason, created_at) VALUES (?,?,?,?,?)')
    .run('pun_1', 'Scam Inc', 'Data Entry', 'spam employer', iso(T));

  db.close();
}

describe('v11 → v12 importer', () => {
  let dir: string;
  let sourcePath: string;
  let v12db: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jat-import-'));
    sourcePath = join(dir, 'jat.db');
    buildV11Db(sourcePath);
    ({ db: v12db } = openDatabase({ file: join(dir, 'jat13.db') }));
  });
  afterEach(() => {
    v12db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('plan() is read-only and reports honest counts without touching v12', () => {
    const report = planImport(sourcePath);
    expect(report.source.v11_user_version).toBe(15);
    expect(report.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.jobs.found).toBe(2);
    expect(report.answers.fields.droppedSensitive).toBe(1);
    expect(report.answers.qa.found).toBe(1);
    expect(report.runs.droppedInFlight).toBe(1); // the queued task
    expect(report.blocklist.found).toBe(1);
    // v12 untouched by plan
    expect((v12db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c).toBe(0);
    expect((v12db.prepare('SELECT COUNT(*) c FROM import_runs').get() as { c: number }).c).toBe(0);
  });

  it('executeImport carries jobs + deterministic appl_v11_ applications', () => {
    const res = executeImport(v12db, sourcePath, { now: () => T });
    expect(res.status).toBe('ok');
    expect(res.sectionErrors).toEqual([]);

    // jobs preserved by id
    expect(v12db.prepare('SELECT 1 FROM jobs WHERE id = ?').get('job_A')).toBeDefined();
    expect(v12db.prepare('SELECT 1 FROM jobs WHERE id = ?').get('job_B')).toBeDefined();
    // job_details description carried
    const det = v12db.prepare('SELECT description FROM job_details WHERE job_id = ?').get('job_A') as { description: string };
    expect(det.description.length).toBeGreaterThan(0);
    // job_url_norm computed
    const job = v12db.prepare('SELECT job_url_norm, company_key FROM jobs WHERE id = ?').get('job_A') as { job_url_norm: string; company_key: string };
    expect(job.job_url_norm).toContain('linkedin.com/jobs/view/123');
    expect(job.company_key).toBe('acme corp');

    // deterministic applications
    const applA = v12db.prepare('SELECT id, status, via FROM applications WHERE id = ?').get('appl_v11_job_A') as { id: string; status: string; via: string };
    expect(applA.id).toBe('appl_v11_job_A');
    expect(applA.status).toBe('submitted'); // 'applied' → 'submitted'
    expect(applA.via).toBe('import');
    const applB = v12db.prepare('SELECT status FROM applications WHERE id = ?').get('appl_v11_job_B') as { status: string };
    expect(applB.status).toBe('tracked'); // 'started' → 'tracked'
  });

  it('drops the sensitive field (counted) while importing the normal field + qa', () => {
    const report = executeImport(v12db, sourcePath, { now: () => T }).report;
    expect(report.answers.fields.droppedSensitive).toBe(1);

    // normal field imported, id preserved, provenance import_v11
    const pf = v12db.prepare('SELECT provenance, kind, value FROM learned_answers WHERE id = ?').get('pf_1') as { provenance: string; kind: string; value: string };
    expect(pf.kind).toBe('field');
    expect(pf.provenance).toBe('import_v11');
    expect(pf.value).toBe('555-1234');
    // sensitive field NOT present
    expect(v12db.prepare('SELECT 1 FROM learned_answers WHERE id = ?').get('pf_sens')).toBeUndefined();
    expect(v12db.prepare("SELECT 1 FROM learned_answers WHERE key_norm = 'gender'").get()).toBeUndefined();

    // qa imported as kind='qa', confidence 0.7, question→label answer→value
    const qa = v12db.prepare("SELECT kind, label, value, confidence FROM learned_answers WHERE id = 'qa_1'").get() as { kind: string; label: string; value: string; confidence: number };
    expect(qa.kind).toBe('qa');
    expect(qa.value).toBe('Yes');
    expect(qa.confidence).toBeCloseTo(0.7);
  });

  it('maps a done+trustworthy-evidence task to a submitted run', () => {
    executeImport(v12db, sourcePath, { now: () => T });
    const run = v12db.prepare('SELECT state, evidence_kind FROM apply_runs WHERE id = ?').get('run_v11_task_done_ok') as { state: string; evidence_kind: string };
    expect(run.state).toBe('submitted');
    expect(run.evidence_kind).toBe('text_became_success');
    expect(run.evidence_kind).not.toBe('legacy_untrusted');
  });

  it('quarantines a done+no-evidence task as parked/legacy_untrusted', () => {
    executeImport(v12db, sourcePath, { now: () => T });
    const run = v12db.prepare('SELECT state, park_kind, evidence_kind FROM apply_runs WHERE id = ?').get('run_v11_task_done_noevi') as { state: string; park_kind: string; evidence_kind: string };
    expect(run.state).toBe('parked');
    expect(run.park_kind).toBe('awaiting_review');
    expect(run.evidence_kind).toBe('legacy_untrusted');
  });

  it('imports the failed run and does NOT import the queued (stale in-flight) task', () => {
    executeImport(v12db, sourcePath, { now: () => T });
    const failed = v12db.prepare('SELECT state, error FROM apply_runs WHERE id = ?').get('run_v11_task_failed') as { state: string; error: string } | undefined;
    expect(failed?.state).toBe('failed');
    expect(failed?.error).toContain('timeout');
    // queued → not imported
    expect(v12db.prepare('SELECT 1 FROM apply_runs WHERE id = ?').get('run_v11_task_queued')).toBeUndefined();
  });

  it('imports the email + its match, and drops a match whose job is absent', () => {
    executeImport(v12db, sourcePath, { now: () => T });
    // both emails imported
    expect(v12db.prepare('SELECT 1 FROM emails WHERE id = ?').get('eml_1')).toBeDefined();
    expect(v12db.prepare('SELECT 1 FROM emails WHERE id = ?').get('eml_2')).toBeDefined();
    // synthetic imported account exists
    const acct = v12db.prepare("SELECT kind FROM email_accounts WHERE id = 'acct_v11_imported'").get() as { kind: string };
    expect(acct.kind).toBe('imported');
    // match for eml_1 → job_A + appl_v11_job_A
    const m = v12db.prepare('SELECT job_id, application_id, match_via, source FROM email_matches WHERE email_id = ?').get('eml_1') as { job_id: string; application_id: string; match_via: string; source: string };
    expect(m.job_id).toBe('job_A');
    expect(m.application_id).toBe('appl_v11_job_A');
    expect(m.match_via).toBe('import');
    expect(m.source).toBe('auto');
    // match for eml_2 (ghost job) dropped
    expect(v12db.prepare('SELECT 1 FROM email_matches WHERE email_id = ?').get('eml_2')).toBeUndefined();
  });

  it('imports the punishment into blocklist and never imports secrets', () => {
    executeImport(v12db, sourcePath, { now: () => T });
    // blocklist
    const b = v12db.prepare("SELECT company_key, reason FROM blocklist WHERE company_key = 'scam inc'").get() as { company_key: string; reason: string } | undefined;
    expect(b).toBeDefined();
    expect(b?.reason).toBe('spam employer');
    // allowed settings imported
    expect(v12db.prepare("SELECT 1 FROM settings WHERE section='autoApply' AND key='keywords'").get()).toBeDefined();
    expect(v12db.prepare("SELECT 1 FROM settings WHERE section='appearance' AND key='theme'").get()).toBeDefined();
    // secret NEVER imported
    expect(v12db.prepare("SELECT 1 FROM settings WHERE section='ai'").get()).toBeUndefined();
    expect(v12db.prepare("SELECT 1 FROM settings WHERE key='apiKey'").get()).toBeUndefined();
    const allSettings = JSON.stringify(v12db.prepare('SELECT * FROM settings').all());
    expect(allSettings).not.toContain('SECRET-KEY');
  });

  it('records a missing document with missing_file=1 and keeps origin_path', () => {
    const report = executeImport(v12db, sourcePath, { now: () => T }).report;
    expect(report.documents.missingFile).toBe(1);
    const doc = v12db.prepare('SELECT missing_file, origin_path, role FROM documents WHERE id = ?').get('doc_1') as { missing_file: number; origin_path: string; role: string };
    expect(doc.missing_file).toBe(1);
    expect(doc.origin_path).toContain('missing');
    expect(doc.role).toBe('cover_letter'); // coverLetter → cover_letter
    // no blob for a missing file
    expect(v12db.prepare('SELECT 1 FROM document_blobs WHERE document_id = ?').get('doc_1')).toBeUndefined();
    // but text carried
    expect(v12db.prepare('SELECT 1 FROM document_text WHERE document_id = ?').get('doc_1')).toBeDefined();
  });

  it('is idempotent — a second run inserts nothing new and stays ok', () => {
    executeImport(v12db, sourcePath, { now: () => T });
    const before = {
      jobs: (v12db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c,
      appl: (v12db.prepare('SELECT COUNT(*) c FROM applications').get() as { c: number }).c,
      ans: (v12db.prepare('SELECT COUNT(*) c FROM learned_answers').get() as { c: number }).c,
      runs: (v12db.prepare('SELECT COUNT(*) c FROM apply_runs').get() as { c: number }).c,
    };
    const res2 = executeImport(v12db, sourcePath, { now: () => T });
    expect(res2.status).toBe('ok');
    const after = {
      jobs: (v12db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c,
      appl: (v12db.prepare('SELECT COUNT(*) c FROM applications').get() as { c: number }).c,
      ans: (v12db.prepare('SELECT COUNT(*) c FROM learned_answers').get() as { c: number }).c,
      runs: (v12db.prepare('SELECT COUNT(*) c FROM apply_runs').get() as { c: number }).c,
    };
    expect(after).toEqual(before);
    // two audit rows (one per execute)
    expect((v12db.prepare('SELECT COUNT(*) c FROM import_runs').get() as { c: number }).c).toBe(2);
  });

  it('writes an import_runs audit row with the report', () => {
    const res = executeImport(v12db, sourcePath, { now: () => T });
    const row = v12db.prepare('SELECT status, source_sha256, v11_user_version, dry_run, report_json FROM import_runs WHERE id = ?').get(res.importRunId) as { status: string; source_sha256: string; v11_user_version: number; dry_run: number; report_json: string };
    expect(row.status).toBe('ok');
    expect(row.dry_run).toBe(0);
    expect(row.v11_user_version).toBe(15);
    expect(row.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => JSON.parse(row.report_json)).not.toThrow();
  });

  it('refuses with V11_LOCK_PRESENT when a jat.db.lock directory is present', () => {
    // node-sqlite3-wasm lock is a DIRECTORY next to the source.
    const lockDir = join(dir, 'jat.db.lock');
    mkdirSync(lockDir);
    expect(() => planImport(sourcePath)).toThrow(ImportError);
    try {
      planImport(sourcePath);
    } catch (e) {
      expect((e as ImportError).code).toBe('V11_LOCK_PRESENT');
    }
  });

  it('never opens the source writable — leaves the file content unchanged', () => {
    const before = planImport(sourcePath).source.sha256;
    executeImport(v12db, sourcePath, { now: () => T });
    const after = planImport(sourcePath).source.sha256;
    expect(after).toBe(before);
    expect(statSync(sourcePath).size).toBeGreaterThan(0);
  });
});
