-- JAT 13 — migration 001-core. Executed in ONE transaction; PRAGMA user_version=1 on success.
-- Source: Pillar 4 §2 DDL, with MASTER-PLAN reconciliations applied:
--   C6: apply_runs = 13 run-states + `submitted` (not `succeeded`) + engine columns (lane/page_key/…);
--       evidence CHECK gates `submitted` on trustworthy typed evidence.
--   C7: apply_run_steps keeps snapshot_hash; phase vocab += classify/resume; 1KB detail, 500-cap, WITHOUT ROWID.
--   C8: application statuses = canonical set (tracked/submitted/acknowledged/…).
--   punishments→blocklist (master-plan override of P4's drop).
-- DEFERRED to later migrations (no pre-12.0.0 installs, so 001 stays freely editable until release, C15):
--   002-discovery: discovery_sources, company_tokens, discovery_batches, job_sightings + jobs_fts
--   003-inbox: emails, email_matches, email_accounts
--   004-fts: jobs_fts (command palette)
--   [M1] the Pillar-3 engine tables (adapters, adapter_health, adapter_captures, apply_ledger,
--        lane_state, host_cooldowns) are added to 001 when the engine is built (Pillar 3 DDL).
-- The structural laws live in the CHECK constraints below — read them as executable requirements.

-- ---- profiles (multi-user root) --------------------------------------------
CREATE TABLE profiles (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  is_default              INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  source_assignments_json TEXT NOT NULL DEFAULT '[]'
                          CHECK (json_valid(source_assignments_json) AND length(source_assignments_json) <= 2048),
  data_json               TEXT NOT NULL DEFAULT '{}'
                          CHECK (json_valid(data_json) AND length(data_json) <= 262144),
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_profiles_default ON profiles(is_default) WHERE is_default = 1;

-- ---- jobs (the posting — LEAN by construction) + details -------------------
CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL,
  external_id      TEXT,
  title            TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 512),
  company          TEXT NOT NULL DEFAULT '' CHECK (length(company) <= 256),
  company_key      TEXT NOT NULL DEFAULT '',
  location         TEXT NOT NULL DEFAULT '' CHECK (length(location) <= 256),
  work_mode        TEXT CHECK (work_mode IS NULL OR work_mode IN ('remote','hybrid','onsite')),
  employment_type  TEXT CHECK (employment_type IS NULL OR length(employment_type) <= 64),
  compensation     TEXT CHECK (compensation IS NULL OR length(compensation) <= 256),
  job_url          TEXT NOT NULL DEFAULT '' CHECK (length(job_url) <= 2048),
  job_url_norm     TEXT NOT NULL DEFAULT '',
  norm_key         TEXT NOT NULL DEFAULT '',
  apply_capability TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (apply_capability IN
                     ('easy_apply','smartapply','ats_form','external','account_wall','unknown')),
  fit_score        INTEGER CHECK (fit_score IS NULL OR fit_score BETWEEN 0 AND 100),
  tags_json        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json) AND length(tags_json) <= 1024),
  posting_state    TEXT NOT NULL DEFAULT 'active' CHECK (posting_state IN ('active','stale','removed')),
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_jobs_normkey  ON jobs(norm_key);
CREATE INDEX idx_jobs_urlnorm  ON jobs(job_url_norm);
CREATE INDEX idx_jobs_external ON jobs(source, external_id);
CREATE INDEX idx_jobs_updated  ON jobs(updated_at DESC);
CREATE INDEX idx_jobs_company  ON jobs(company_key);

-- Heavy text quarantined: the list endpoint CANNOT ship descriptions (not in the table it queries).
CREATE TABLE job_details (
  job_id      TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 262144),
  fit_json    TEXT CHECK (fit_json IS NULL OR (json_valid(fit_json) AND length(fit_json) <= 16384)),
  raw_json    TEXT CHECK (raw_json IS NULL OR (json_valid(raw_json) AND length(raw_json) <= 131072))
) STRICT;

-- ---- applications (the act, per profile — clean status lifecycle) ----------
CREATE TABLE applications (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES jobs(id)     ON DELETE CASCADE,
  profile_id       TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'tracked' CHECK (status IN
                     ('tracked','submitted','acknowledged','assessment',
                      'interview_1','interview_2','interview_final',
                      'offer','hired','rejected','withdrawn','ghosted')),
  via              TEXT CHECK (via IS NULL OR via IN ('auto','manual','import')),
  submitted_at     INTEGER,
  answers_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(answers_json) AND length(answers_json) <= 32768),
  attachments_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attachments_json) AND length(attachments_json) <= 4096),
  notes            TEXT CHECK (notes IS NULL OR length(notes) <= 16384),
  next_action      TEXT CHECK (next_action IS NULL OR length(next_action) <= 512),
  due_at           INTEGER,
  needs_review     INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (job_id, profile_id)
) STRICT;
CREATE INDEX idx_appl_status  ON applications(status, updated_at DESC);
CREATE INDEX idx_appl_profile ON applications(profile_id, updated_at DESC);
CREATE INDEX idx_appl_job     ON applications(job_id);

-- ---- apply_runs (structured run record; states are DB columns) -------------
-- C6: 13 run-states; slot-holding = leased|navigating|classifying|driving|verifying|waiting_page;
--     terminal = submitted|ready_for_review|parked|skipped|failed. Engine columns persist per step
--     so ANY extension death resumes by reclassifying the live page (never restart).
CREATE TABLE apply_runs (
  id                TEXT PRIMARY KEY,
  application_id    TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  job_id            TEXT NOT NULL,
  profile_id        TEXT NOT NULL,
  source            TEXT NOT NULL,
  lane              TEXT NOT NULL DEFAULT 'linkedin' CHECK (lane IN ('linkedin','indeed','ats')),
  adapter_id        TEXT,
  adapter_version   INTEGER,
  state             TEXT NOT NULL DEFAULT 'queued' CHECK (state IN
                      ('queued','leased','navigating','classifying','driving','verifying',
                       'waiting_page','needs_human','submitted','ready_for_review',
                       'parked','skipped','failed')),
  mode              TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','review','teach')),
  route             TEXT CHECK (route IS NULL OR route IN ('easy_apply','smartapply','ats_form','external')),
  attempt           INTEGER NOT NULL DEFAULT 1,
  -- engine cursor (resume-by-reclassification): the last classified page + command sequencing.
  page_key          TEXT CHECK (page_key IS NULL OR length(page_key) <= 128),
  step_seq          INTEGER NOT NULL DEFAULT 0,
  cmd_seq           INTEGER NOT NULL DEFAULT 0,
  resume_count      INTEGER NOT NULL DEFAULT 0,
  tab_epoch         INTEGER,
  park_kind         TEXT CHECK (park_kind IS NULL OR park_kind IN
                      ('captcha','cloudflare','login','account_wall','resume_required',
                       'needs_answer','awaiting_review','external_redirect','rate_limited','other')),
  park_detail       TEXT CHECK (park_detail IS NULL OR length(park_detail) <= 2048),
  pending_questions_json TEXT NOT NULL DEFAULT '[]'
                      CHECK (json_valid(pending_questions_json) AND length(pending_questions_json) <= 16384),
  error             TEXT CHECK (error IS NULL OR length(error) <= 2048),
  evidence_kind     TEXT CHECK (evidence_kind IS NULL OR evidence_kind IN
                      ('text_became_success','new_confirmation_node','confirm_signal',
                       'url_confirmation','modal_close_confirmed','manual_confirmed','legacy_untrusted')),
  evidence_json     TEXT CHECK (evidence_json IS NULL OR (json_valid(evidence_json) AND length(evidence_json) <= 8192)),
  steps_count       INTEGER NOT NULL DEFAULT 0,
  queued_at         INTEGER NOT NULL,
  dispatched_at     INTEGER,
  started_at        INTEGER,
  finished_at       INTEGER,
  updated_at        INTEGER NOT NULL,
  -- SUCCESS-TRUTH AS A CONSTRAINT: cannot be 'submitted' without trustworthy typed evidence.
  CHECK (state <> 'submitted' OR (evidence_kind IS NOT NULL AND evidence_kind <> 'legacy_untrusted'))
) STRICT;
CREATE INDEX idx_runs_state   ON apply_runs(state, queued_at);
CREATE INDEX idx_runs_appl    ON apply_runs(application_id);
CREATE INDEX idx_runs_updated ON apply_runs(updated_at DESC);
CREATE INDEX idx_runs_source  ON apply_runs(source, state);
CREATE INDEX idx_runs_lane    ON apply_runs(lane, state);

-- Steps — bounded, typed, per-run ring (C7: +snapshot_hash, +classify/resume phases).
CREATE TABLE apply_run_steps (
  run_id        TEXT NOT NULL REFERENCES apply_runs(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  at            INTEGER NOT NULL,
  phase         TEXT NOT NULL CHECK (phase IN
                  ('open','navigate','classify','detect','fill','answer','upload',
                   'advance','verify','park','resume','finish')),
  action        TEXT CHECK (action IS NULL OR length(action) <= 64),
  target        TEXT CHECK (target IS NULL OR length(target) <= 256),   -- element role/label, NEVER raw HTML
  detail        TEXT CHECK (detail IS NULL OR length(detail) <= 1024),
  snapshot_hash TEXT CHECK (snapshot_hash IS NULL OR length(snapshot_hash) <= 64),
  duration_ms   INTEGER,
  ok            INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
  PRIMARY KEY (run_id, seq)
) STRICT, WITHOUT ROWID;
-- STRUCTURAL bound: a run can never accrete more than 500 steps (v11 transcripts hit thousands).
CREATE TRIGGER trg_steps_cap BEFORE INSERT ON apply_run_steps
WHEN NEW.seq > 500
BEGIN SELECT RAISE(IGNORE); END;

-- ---- learned_answers (per-profile memory — ask-once-ever) ------------------
CREATE TABLE learned_answers (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('field','qa')),
  key_norm      TEXT NOT NULL,
  label         TEXT NOT NULL CHECK (length(label) <= 512),
  locale        TEXT NOT NULL DEFAULT 'en',
  field_type    TEXT CHECK (field_type IS NULL OR field_type IN ('text','textarea','select','radio','checkbox','number','date','file')),
  value         TEXT CHECK (value IS NULL OR length(value) <= 8192),
  options_json  TEXT CHECK (options_json IS NULL OR (json_valid(options_json) AND length(options_json) <= 4096)),
  confidence    REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  provenance    TEXT NOT NULL DEFAULT 'harvest' CHECK (provenance IN
                  ('user','harvest','ai','teach','profile_push','import_v11')),
  locked        INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  seen_count    INTEGER NOT NULL DEFAULT 1,
  used_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER,
  source_host   TEXT CHECK (source_host IS NULL OR length(source_host) <= 128),
  source_job_id TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (profile_id, kind, key_norm)
) STRICT;
CREATE INDEX idx_answers_lookup ON learned_answers(profile_id, key_norm);

-- ---- documents (bytes IN the database — a disk restore already cost Aurora) -
CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  name        TEXT NOT NULL CHECK (length(name) <= 256),
  role        TEXT NOT NULL DEFAULT 'resume' CHECK (role IN ('resume','cover_letter','portfolio','transcript','other')),
  label       TEXT CHECK (label IS NULL OR length(label) <= 128),
  mime        TEXT CHECK (mime IS NULL OR length(mime) <= 128),
  size_bytes  INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes <= 26214400),
  sha256      TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  source      TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','application','folder','import_v11')),
  origin_path TEXT CHECK (origin_path IS NULL OR length(origin_path) <= 1024),
  missing_file INTEGER NOT NULL DEFAULT 0 CHECK (missing_file IN (0,1)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_documents_role ON documents(role, is_default DESC);
CREATE UNIQUE INDEX idx_documents_sha ON documents(sha256) WHERE sha256 IS NOT NULL;

CREATE TABLE document_blobs (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  bytes       BLOB NOT NULL
) STRICT;

CREATE TABLE document_text (
  document_id   TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  text          TEXT NOT NULL DEFAULT '' CHECK (length(text) <= 524288),
  keywords_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(keywords_json) AND length(keywords_json) <= 4096),
  indexed_at    INTEGER
) STRICT;

-- ---- settings (typed+versioned) and secrets (with health) ------------------
CREATE TABLE settings (
  section        TEXT NOT NULL,
  key            TEXT NOT NULL,
  value_json     TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 16384),
  schema_version INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (section, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE secrets (
  key            TEXT PRIMARY KEY,
  sealed         BLOB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('ok','expired','revoked','unknown')),
  last_ok_at     INTEGER,
  last_error     TEXT CHECK (last_error IS NULL OR length(last_error) <= 512),
  expires_hint_at INTEGER,
  updated_at     INTEGER NOT NULL
) STRICT;

-- ---- events (durable timeline) / activity_log (ring) / ai_calls (ring) -----
CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  at             INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('status_change','submitted','park','email_matched','note','imported','created','document_attached')),
  job_id         TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  run_id         TEXT,
  email_id       TEXT,
  source         TEXT CHECK (source IS NULL OR length(source) <= 64),
  summary        TEXT CHECK (summary IS NULL OR length(summary) <= 512),
  data_json      TEXT CHECK (data_json IS NULL OR (json_valid(data_json) AND length(data_json) <= 4096))
) STRICT;
CREATE INDEX idx_events_appl ON events(application_id, at DESC);
CREATE INDEX idx_events_at   ON events(at DESC);

CREATE TABLE activity_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  area      TEXT NOT NULL CHECK (length(area) <= 32),
  level     TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  message   TEXT NOT NULL CHECK (length(message) <= 1024),
  data_json TEXT CHECK (data_json IS NULL OR (json_valid(data_json) AND length(data_json) <= 2048))
) STRICT;
CREATE TRIGGER trg_activity_ring AFTER INSERT ON activity_log
BEGIN DELETE FROM activity_log WHERE id <= NEW.id - 20000; END;

CREATE TABLE ai_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  provider       TEXT, model TEXT, kind TEXT,
  ms             INTEGER, ok INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
  error          TEXT CHECK (error IS NULL OR length(error) <= 512),
  prompt_chars   INTEGER, response_chars INTEGER
) STRICT;
CREATE TRIGGER trg_ai_ring AFTER INSERT ON ai_calls
BEGIN DELETE FROM ai_calls WHERE id <= NEW.id - 2000; END;

CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT CHECK (value IS NULL OR length(value) <= 8192)
) STRICT, WITHOUT ROWID;

-- ---- blocklist (master-plan: v11 punishments import here; discovery+rankJob consume) --
CREATE TABLE blocklist (
  id          TEXT PRIMARY KEY,
  company_key TEXT CHECK (company_key IS NULL OR length(company_key) <= 256),
  title_rx    TEXT CHECK (title_rx IS NULL OR length(title_rx) <= 256),
  reason      TEXT CHECK (reason IS NULL OR length(reason) <= 256),
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_blocklist_company ON blocklist(company_key);

-- ---- importer audit + migration ledger ------------------------------------
CREATE TABLE import_runs (
  id               TEXT PRIMARY KEY,
  source_path      TEXT NOT NULL,
  source_sha256    TEXT,
  v11_user_version INTEGER,
  dry_run          INTEGER NOT NULL CHECK (dry_run IN (0,1)),
  status           TEXT NOT NULL CHECK (status IN ('ok','failed','partial')),
  report_json      TEXT NOT NULL CHECK (json_valid(report_json) AND length(report_json) <= 262144),
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER
) STRICT;

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  ms         INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
