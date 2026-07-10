-- JAT 13 — migration 001_init: THE WHOLE v1 schema (00-MASTER-PLAN §5), designed together.
-- This is the rebuild's no-accretion moment: every table the product needs through Stage 6 exists
-- here, in one migration, so no later stage bolts a table on without seeing the whole picture.
-- House rules: STRICT tables · epoch-ms INTEGER timestamps · CHECK-bounded enums (loud on unknown
-- is a schema property, not a code habit) · json_valid()+length caps on every JSON column ·
-- indexes on FKs + hot paths. The CHECK constraints are executable requirements — read them as law.
-- Executed in ONE transaction by the runner; PRAGMA user_version=1 written only by the runner.

-- ---- profiles (multi-user root; learned memory + documents + applications hang off this) --------
CREATE TABLE profiles (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  is_default              INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  source_assignments_json TEXT NOT NULL DEFAULT '[]'
                          CHECK (json_valid(source_assignments_json) AND length(source_assignments_json) <= 2048),
  -- identity + the 29 seed fields + work auth + salary target live here as one bounded JSON doc
  data_json               TEXT NOT NULL DEFAULT '{}'
                          CHECK (json_valid(data_json) AND length(data_json) <= 262144),
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_profiles_default ON profiles(is_default) WHERE is_default = 1;

-- ---- jobs (the posting — LEAN by construction) + quarantined heavy text -------------------------
CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL,                 -- discovery lane that first produced it
  external_id      TEXT,
  title            TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 512),
  company          TEXT NOT NULL DEFAULT '' CHECK (length(company) <= 256),
  company_key      TEXT NOT NULL DEFAULT '',      -- normalized company for dedup/blocking
  location         TEXT NOT NULL DEFAULT '' CHECK (length(location) <= 256),
  work_mode        TEXT CHECK (work_mode IS NULL OR work_mode IN ('remote','hybrid','onsite')),
  employment_type  TEXT CHECK (employment_type IS NULL OR length(employment_type) <= 64),
  compensation     TEXT CHECK (compensation IS NULL OR length(compensation) <= 256),
  job_url          TEXT NOT NULL DEFAULT '' CHECK (length(job_url) <= 2048),
  job_url_norm     TEXT NOT NULL DEFAULT '',      -- normalized URL for dedup
  norm_key         TEXT NOT NULL DEFAULT '',      -- cross-source dedup key (title+company+loc)
  apply_capability TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (apply_capability IN
                     ('easy_apply','smartapply','ats_form','external','account_wall','unknown')),
  fit_score        INTEGER CHECK (fit_score IS NULL OR fit_score BETWEEN 0 AND 100), -- cache; authority = fit_scores
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

-- ---- applications (the act, per profile — the canonical status FSM) ------------------------------
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

-- ---- apply_runs (13-state FSM as DB columns; "busy" is one SQL query) ----------------------------
-- Slot-holding = leased|navigating|classifying|driving|verifying|waiting_page;
-- terminal = submitted|ready_for_review|parked|skipped|failed. Engine cursor persists per step so
-- ANY extension death resumes by reclassifying the live page (never restart, never lie).
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
  -- engine cursor (resume-by-reclassification): last classified page + command sequencing
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
  -- SUBMIT TRUTH AS A CONSTRAINT: cannot be 'submitted' without trustworthy typed evidence.
  CHECK (state <> 'submitted' OR (evidence_kind IS NOT NULL AND evidence_kind <> 'legacy_untrusted'))
) STRICT;
CREATE INDEX idx_runs_state   ON apply_runs(state, queued_at);
CREATE INDEX idx_runs_appl    ON apply_runs(application_id);
CREATE INDEX idx_runs_updated ON apply_runs(updated_at DESC);
CREATE INDEX idx_runs_source  ON apply_runs(source, state);
CREATE INDEX idx_runs_lane    ON apply_runs(lane, state);

-- Per-run step transcript — bounded, typed, ring-capped (v11 transcripts hit thousands of rows).
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
-- STRUCTURAL bound: a run can never accrete more than 500 steps.
CREATE TRIGGER trg_steps_cap BEFORE INSERT ON apply_run_steps
WHEN NEW.seq > 500
BEGIN SELECT RAISE(IGNORE); END;

-- ---- apply_ledger (THE per-source/account cap authority) -----------------------------------------
-- ONE row per REAL submit. Cap checks read THIS table, never worker slots — parallelism can never
-- stack past an account limit (v11 LinkedIn-lockout lesson).
CREATE TABLE apply_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  source       TEXT NOT NULL,
  account_key  TEXT NOT NULL DEFAULT 'default',   -- reserved for future multi-account
  submitted_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_ledger_window ON apply_ledger(source, account_key, submitted_at);

-- ---- learned_answers (per-profile memory — ask-once-ever) ----------------------------------------
CREATE TABLE learned_answers (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('field','qa')),
  key_norm      TEXT NOT NULL,                    -- normalized question/field key (ONE choke point)
  label         TEXT NOT NULL CHECK (length(label) <= 512),
  locale        TEXT NOT NULL DEFAULT 'en',
  field_type    TEXT CHECK (field_type IS NULL OR field_type IN ('text','textarea','select','radio','checkbox','number','date','file')),
  value         TEXT CHECK (value IS NULL OR length(value) <= 8192),
  options_json  TEXT CHECK (options_json IS NULL OR (json_valid(options_json) AND length(options_json) <= 4096)),
  confidence    REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  provenance    TEXT NOT NULL DEFAULT 'harvest' CHECK (provenance IN
                  ('user','harvest','ai','teach','profile_push','deterministic','import_v11')),
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

-- ---- documents (bytes IN the database — a disk restore already cost one library) -----------------
-- Uploaded library docs AND AI-generated (tailored) docs share this table; the generated-doc lineage
-- columns are NULL for plain uploads. guardrail_status is the rephrase-only post-check verdict:
-- 'parked' docs are never auto-attached — they sit in review.
CREATE TABLE documents (
  id               TEXT PRIMARY KEY,
  profile_id       TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  name             TEXT NOT NULL CHECK (length(name) <= 256),
  role             TEXT NOT NULL DEFAULT 'resume' CHECK (role IN ('resume','cover_letter','portfolio','transcript','brief','other')),
  label            TEXT CHECK (label IS NULL OR length(label) <= 128),
  mime             TEXT CHECK (mime IS NULL OR length(mime) <= 128),
  size_bytes       INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes <= 26214400),
  sha256           TEXT,
  is_default       INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  source           TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','application','folder','generated','import_v11')),
  origin_path      TEXT CHECK (origin_path IS NULL OR length(origin_path) <= 1024),
  missing_file     INTEGER NOT NULL DEFAULT 0 CHECK (missing_file IN (0,1)),
  -- generated-doc lineage (AI tailoring):
  derived_from     TEXT REFERENCES documents(id)    ON DELETE SET NULL,   -- master doc it was tailored from
  application_id   TEXT REFERENCES applications(id) ON DELETE SET NULL,   -- application it was generated for
  guardrail_hash   TEXT CHECK (guardrail_hash IS NULL OR length(guardrail_hash) <= 64),  -- fact-whitelist digest the post-check ran against
  guardrail_status TEXT CHECK (guardrail_status IS NULL OR guardrail_status IN ('pending','passed','parked')), -- NULL = not generated
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_documents_role ON documents(role, is_default DESC);
CREATE UNIQUE INDEX idx_documents_sha ON documents(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX idx_documents_appl ON documents(application_id) WHERE application_id IS NOT NULL;
CREATE INDEX idx_documents_derived ON documents(derived_from) WHERE derived_from IS NOT NULL;

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

-- ---- inbox: email_accounts / emails / email_matches ----------------------------------------------
-- The Gmail QUERY stays broad (the v11.48 sender-restricted scar); classifier order is data with tests.
CREATE TABLE email_accounts (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('gmail_oauth','imap','imported')),
  email            TEXT NOT NULL DEFAULT '',
  label            TEXT CHECK (label IS NULL OR length(label) <= 128),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  history_id       TEXT,                          -- gmail sync cursor
  watermark_ms     INTEGER NOT NULL DEFAULT 0,
  imap_host        TEXT, imap_port INTEGER,
  imap_secure      INTEGER CHECK (imap_secure IS NULL OR imap_secure IN (0,1)),
  imap_uid         INTEGER NOT NULL DEFAULT 0,
  imap_uidvalidity TEXT,
  -- token lifecycle health surface; the sealed token itself lives in `secrets`
  token_state      TEXT NOT NULL DEFAULT 'unauthorized'
                   CHECK (token_state IN ('unauthorized','healthy','expiring_soon','expired','revoked')),
  auth_fail_count  INTEGER NOT NULL DEFAULT 0,
  last_ok_at       INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;

CREATE TABLE emails (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  provider        TEXT CHECK (provider IS NULL OR provider IN ('gmail','outlook','imap','imported')),
  provider_msg_id TEXT NOT NULL,                  -- per-account dedup (Gmail msg id / IMAP uid)
  message_id      TEXT,                           -- RFC 5322 Message-ID — cross-account dedup
  thread_id       TEXT,
  in_reply_to     TEXT,
  ref_ids         TEXT,
  from_addr       TEXT NOT NULL DEFAULT '' CHECK (length(from_addr) <= 320),
  from_name       TEXT NOT NULL DEFAULT '' CHECK (length(from_name) <= 256),
  to_addr         TEXT NOT NULL DEFAULT '' CHECK (length(to_addr) <= 320),
  subject         TEXT NOT NULL DEFAULT '' CHECK (length(subject) <= 998),
  snippet         TEXT NOT NULL DEFAULT '' CHECK (length(snippet) <= 512),
  body            TEXT CHECK (body IS NULL OR length(body) <= 65536),   -- 64KB cap AT THE SCHEMA
  sent_at         INTEGER,
  category        TEXT CHECK (category IS NULL OR category IN
                    ('application_confirmation','recruiter','assessment','interview','offer','rejection','other')),
  classified_by   TEXT CHECK (classified_by IS NULL OR classified_by IN ('rules','ai','manual')),
  rules_pack_ver  INTEGER,
  ai_confidence   REAL CHECK (ai_confidence IS NULL OR (ai_confidence >= 0.0 AND ai_confidence <= 1.0)),
  created_at      INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_emails_acct_msg ON emails(account_id, provider_msg_id);
CREATE INDEX idx_emails_msgid  ON emails(message_id);
CREATE INDEX idx_emails_sent   ON emails(sent_at DESC);
CREATE INDEX idx_emails_thread ON emails(thread_id);

-- ONE current match per email, with provenance for the suggest→confirm UI. Pipeline rule: only
-- auto/manual may elevate an application status; suggested waits for a click; dismissed never returns.
CREATE TABLE email_matches (
  email_id       TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  job_id         TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  confidence     REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source         TEXT NOT NULL CHECK (source IN ('auto','suggested','manual','dismissed')),
  match_via      TEXT CHECK (match_via IS NULL OR match_via IN ('thread','ats_id','score','ai','auto_created','user','import')),
  decided_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_email_matches_appl ON email_matches(application_id);
CREATE INDEX idx_email_matches_job  ON email_matches(job_id);

-- ---- events (append-only timeline — the Activity page + per-application drawer) ------------------
CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  at             INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('created','status_change','submitted','park','needs_human',
                    'email','email_matched','resume_tailored','cover_letter_generated',
                    'interview_detected','autopsy_created','answer_learned',
                    'note','imported','document_attached')),
  job_id         TEXT REFERENCES jobs(id)         ON DELETE CASCADE,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  run_id         TEXT,
  email_id       TEXT,
  source         TEXT CHECK (source IS NULL OR length(source) <= 64),
  summary        TEXT CHECK (summary IS NULL OR length(summary) <= 512),
  data_json      TEXT CHECK (data_json IS NULL OR (json_valid(data_json) AND length(data_json) <= 4096))
) STRICT;
CREATE INDEX idx_events_appl ON events(application_id, at DESC);
CREATE INDEX idx_events_job  ON events(job_id);
CREATE INDEX idx_events_at   ON events(at DESC);

-- ---- discovery: per-lane state (kills the v11.83 shared-refill-gate starvation structurally) -----
-- One row per supply lane; pacing gate + breaker + cursor LIVE HERE, so a wedged/rate-limited lane
-- sets its OWN cooldown and can never starve another.
CREATE TABLE discovery_sources (
  id               TEXT PRIMARY KEY,          -- 'src_linkedin','src_indeed','src_gh','src_lever','src_ashby'
  board            TEXT NOT NULL UNIQUE
                   CHECK (board IN ('linkedin','indeed','greenhouse','lever','ashby')),
  kind             TEXT NOT NULL CHECK (kind IN ('jobspy','extension_scrape','ats_board')),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  config_json      TEXT NOT NULL DEFAULT '{}'
                   CHECK (json_valid(config_json) AND length(config_json) <= 8192),
  cursor_json      TEXT NOT NULL DEFAULT '{}'  -- combo watermarks / freshness tiers (replaces v11 kv sprawl)
                   CHECK (json_valid(cursor_json) AND length(cursor_json) <= 16384),
  last_tick_at     INTEGER,
  next_earliest_at INTEGER,                    -- per-source pacing gate
  cooldown_until   INTEGER,                    -- breaker (rate-limit / CF detection)
  breaker_reason   TEXT CHECK (breaker_reason IS NULL OR length(breaker_reason) <= 256),
  updated_at       INTEGER NOT NULL
) STRICT;

-- ATS company slugs to poll. Round-robin fairness = ORDER BY last_scan_at (NULLs first); 5×
-- consecutive dead scans auto-retire a token so dead slugs stop wasting scans.
CREATE TABLE company_tokens (
  id            TEXT PRIMARY KEY,
  ats           TEXT NOT NULL CHECK (ats IN ('greenhouse','lever','ashby')),
  token         TEXT NOT NULL CHECK (length(token) <= 128),
  company       TEXT CHECK (company IS NULL OR length(company) <= 256),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  added_by      TEXT NOT NULL DEFAULT 'seed' CHECK (added_by IN ('seed','learned','user')),
  verified_at   INTEGER,
  last_scan_at  INTEGER,
  last_yield_at INTEGER,
  dead_count    INTEGER NOT NULL DEFAULT 0 CHECK (dead_count >= 0),   -- >= 5 → active=0
  created_at    INTEGER NOT NULL,
  UNIQUE (ats, token)
) STRICT;
CREATE INDEX idx_tokens_due ON company_tokens(ats, active, last_scan_at);

-- YIELD-ONLY telemetry, ring-buffered. The CHECK makes an empty successful scan UNWRITABLE
-- (kills the 12.8k-junk-rows/day class). Nothing joins back to batches — provenance is job_sightings.
CREATE TABLE discovery_batches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id        TEXT NOT NULL,
  company_token_id TEXT,
  keyword          TEXT CHECK (keyword IS NULL OR length(keyword) <= 128),
  location         TEXT CHECK (location IS NULL OR length(location) <= 128),
  status           TEXT NOT NULL CHECK (status IN ('ok','rate_limited','error')),
  found_count      INTEGER NOT NULL DEFAULT 0 CHECK (found_count >= 0),
  accepted_count   INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  duplicate_count  INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  rejected_count   INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  error            TEXT CHECK (error IS NULL OR length(error) <= 1024),
  started_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  CHECK (status <> 'ok' OR found_count > 0)
) STRICT;
CREATE INDEX idx_batches_time ON discovery_batches(started_at DESC);
CREATE TRIGGER trg_batches_ring AFTER INSERT ON discovery_batches
BEGIN DELETE FROM discovery_batches WHERE id <= NEW.id - 5000; END;

-- Provenance: PK-deduped per (job, source) — re-seeing a job UPDATES the row, so this is
-- O(jobs×sources), never O(scans) (the 26–37k-rows/day v11 class).
CREATE TABLE job_sightings (
  job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_id        TEXT NOT NULL,
  apply_capability TEXT NOT NULL DEFAULT 'unknown',
  raw_url          TEXT CHECK (raw_url IS NULL OR length(raw_url) <= 2048),
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  seen_count       INTEGER NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  PRIMARY KEY (job_id, source_id)
) STRICT, WITHOUT ROWID;

-- ---- fit_scores (queue ordering authority; jobs.fit_score is the denormalized cache) -------------
CREATE TABLE fit_scores (
  job_id         TEXT NOT NULL REFERENCES jobs(id)     ON DELETE CASCADE,
  profile_id     TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  score          INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  scorer         TEXT NOT NULL CHECK (scorer IN ('deterministic','ai')),
  backend        TEXT CHECK (backend IS NULL OR backend IN ('claude','codex')),  -- which CLI scored (ai only)
  reasons_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json) AND length(reasons_json) <= 8192),
  floor_decision TEXT NOT NULL DEFAULT 'pass' CHECK (floor_decision IN ('pass','skip')),  -- vs skip floor at scoring time
  floor_value    INTEGER CHECK (floor_value IS NULL OR floor_value BETWEEN 0 AND 100),    -- the floor compared against
  scored_at      INTEGER NOT NULL,
  PRIMARY KEY (job_id, profile_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_fit_order ON fit_scores(profile_id, score DESC);   -- queue ordering: best-first

-- ---- autopsies (every terminal run → readable post-mortem → pattern miner → self-healing) --------
CREATE TABLE autopsies (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL UNIQUE REFERENCES apply_runs(id) ON DELETE CASCADE,
  application_id   TEXT REFERENCES applications(id) ON DELETE CASCADE,
  job_id           TEXT,
  lane             TEXT NOT NULL CHECK (lane IN ('linkedin','indeed','ats')),
  final_state      TEXT NOT NULL CHECK (final_state IN
                     ('submitted','ready_for_review','parked','skipped','failed')),  -- terminal vocab only
  park_kind        TEXT CHECK (park_kind IS NULL OR park_kind IN
                     ('captcha','cloudflare','login','account_wall','resume_required',
                      'needs_answer','awaiting_review','external_redirect','rate_limited','other')),
  page_key         TEXT CHECK (page_key IS NULL OR length(page_key) <= 128),          -- last classified page
  blocking_control TEXT CHECK (blocking_control IS NULL OR length(blocking_control) <= 256), -- role/label, never raw HTML
  step_trail_json  TEXT NOT NULL DEFAULT '[]'
                   CHECK (json_valid(step_trail_json) AND length(step_trail_json) <= 16384), -- condensed trail
  summary          TEXT CHECK (summary IS NULL OR length(summary) <= 4096),           -- human/AI post-mortem text
  signature        TEXT NOT NULL DEFAULT '' CHECK (length(signature) <= 256),         -- pattern-miner group key ("same failure ×N")
  proposal_json    TEXT CHECK (proposal_json IS NULL OR (json_valid(proposal_json) AND length(proposal_json) <= 8192)), -- remedy: adapter patch / learned answer / setting
  proposal_state   TEXT NOT NULL DEFAULT 'none' CHECK (proposal_state IN ('none','proposed','applied','dismissed')),
  created_at       INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_autopsies_sig  ON autopsies(signature, created_at DESC);
CREATE INDEX idx_autopsies_appl ON autopsies(application_id);

-- ---- interviews (email detection → AI brief → prep) -----------------------------------------------
CREATE TABLE interviews (
  id                TEXT PRIMARY KEY,
  application_id    TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  email_id          TEXT REFERENCES emails(id) ON DELETE SET NULL,   -- detection provenance
  stage             TEXT NOT NULL DEFAULT 'screen' CHECK (stage IN
                      ('assessment','screen','interview_1','interview_2','interview_final','other')),
  scheduled_at      INTEGER,                                          -- NULL until a date is known
  detected_at       INTEGER NOT NULL,
  brief_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL, -- the AI brief lives in documents
  brief_state       TEXT NOT NULL DEFAULT 'none' CHECK (brief_state IN ('none','pending','ready','failed')),
  prep_json         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(prep_json) AND length(prep_json) <= 8192), -- checklist state
  notes             TEXT CHECK (notes IS NULL OR length(notes) <= 8192),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_interviews_appl  ON interviews(application_id, detected_at DESC);
CREATE INDEX idx_interviews_sched ON interviews(scheduled_at);

-- ---- ai_calls (the ledger behind the Settings backend cards + autopsies), ring-buffered ----------
CREATE TABLE ai_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  backend        TEXT NOT NULL CHECK (backend IN ('claude','codex')),
  task           TEXT NOT NULL CHECK (task IN
                   ('screening','tailor_resume','cover_letter','fit_score',
                    'interview_brief','autopsy_summary','health_probe')),
  model          TEXT CHECK (model IS NULL OR length(model) <= 128),
  ms             INTEGER,
  tokens_in      INTEGER,                        -- only when the CLI reports usage
  tokens_out     INTEGER,
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok','error','timeout')),
  error          TEXT CHECK (error IS NULL OR length(error) <= 512),
  run_id         TEXT,                           -- no FK: ring rows outlive/pre-date runs
  application_id TEXT,
  prompt_chars   INTEGER,
  response_chars INTEGER
) STRICT;
CREATE INDEX idx_ai_calls_at ON ai_calls(at DESC);
CREATE TRIGGER trg_ai_ring AFTER INSERT ON ai_calls
BEGIN DELETE FROM ai_calls WHERE id <= NEW.id - 5000; END;

-- ---- settings (one row per section+key — per-key merge kills the stale-blob-shadow bug) ----------
CREATE TABLE settings (
  section        TEXT NOT NULL,
  key            TEXT NOT NULL,
  value_json     TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 16384),
  schema_version INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (section, key)
) STRICT, WITHOUT ROWID;

-- ---- secrets (OS-sealed credential blobs + token health; plaintext NEVER lives anywhere else) ----
CREATE TABLE secrets (
  key             TEXT PRIMARY KEY,
  sealed          BLOB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('ok','expired','revoked','unknown')),
  last_ok_at      INTEGER,
  last_error      TEXT CHECK (last_error IS NULL OR length(last_error) <= 512),
  expires_hint_at INTEGER,
  updated_at      INTEGER NOT NULL
) STRICT;

-- ---- importer audit + migration ledger ------------------------------------------------------------
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
