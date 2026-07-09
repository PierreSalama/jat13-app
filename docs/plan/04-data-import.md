# Pillar 4 — Data Model, v11 Import, Multi-User

**Status:** design-complete, implementation-ready
**Owner module:** `app/src/main/db/` (schema, migrations, DAL) + `app/src/main/importer/` (v11 importer)
**Engine:** better-sqlite3 (native, WAL), app **main process is the ONLY writer**. Renderer and extension reach data exclusively through the local API (pillar 1/5 owns transport; this doc owns what's underneath).

Evidence base: v11 `db.js` (all 15 migrations read in full), memory files `reference_jat_v1181_v1182` (payload bombs, DB bloat, retention numbers), `reference_jat_profile_memory` (per-profile memory contract), `reference_jat_email_pipeline`, `reference_jat_pipeline_ceilings`, `reference_jat_discovery_supply`, vault ADR `2026-07-03 — jat-v12-sibling-coexistence-architecture` (wasm mkdir-lock semantics).

---

## 0. Non-negotiables this schema encodes (from v11 production failures)

| # | v11 failure | Structural answer in this schema |
|---|---|---|
| 1 | 16MB `/jobs`, 17MB `/queue` payload bombs (`SELECT *` dragged descriptions + transcripts) | Heavy text lives in **separate tables** (`job_details`, `document_blobs`, `document_text`, `apply_run_steps`). The hot tables (`jobs`, `applications`, `apply_runs`) physically cannot ship a blob because they don't contain one. |
| 2 | 12.8k empty discovery_batch rows/day; O(scans) telemetry | `discovery_batches` has a **CHECK constraint forbidding zero-yield ok rows**; per-job provenance is a **PK-deduped `job_sightings`** table (O(jobs), not O(scans)); telemetry tables are **ring buffers via AFTER INSERT triggers**. |
| 3 | 15MB transcript blobs; success-truth quarantine retrofits | Transcripts are replaced by a **bounded step table** (`apply_run_steps`, ≤500 rows/run, ≤1KB/row, trigger-enforced) and **typed submission evidence**. `state='succeeded'` **requires trustworthy evidence by CHECK constraint** — the Activision/Canada-Job-Bank false-positive class can't be written. |
| 4 | node-sqlite3-wasm: mkdir-lock VFS, silently dropped writes, bricked launches | better-sqlite3, WAL, `busy_timeout`, single writer. The v11 importer **detects the wasm `jat.db.lock` directory and refuses**. |
| 5 | Retention as afterthought cron (DB hit 74MB) | Size bounds are **in the DDL**: length CHECKs on every free-text/JSON column, ring-buffer triggers, PK-dedup, plus a small residual `maintenance()` for time-based pruning + VACUUM. |
| 6 | Global-then-retrofitted per-profile memory (v11 migration v6 rebuild) | `learned_answers` is **per-profile from day one** (`UNIQUE(profile_id, kind, key_norm)`, FK CASCADE). Every DAL memory function takes `profileId` and throws on absence. |
| 7 | Job posting vs application-lifecycle conflated in one `jobs.status` | **`jobs` (the posting) and `applications` (the act, per profile)** are separate tables. Multi-profile on one machine works without status collisions. |
| 8 | Token/auth rot invisible until things die | First-class `secrets` table with **health columns** (`status`, `last_ok_at`, `expires_hint_at`) the UI reads directly. |

---

## 1. Engine, conventions, pragmas

### 1.1 Engine
- **better-sqlite3** pinned in `app/package.json`; `electron-rebuild` runs in CI (repo `PierreSalama/Job-ext-app` pattern — the v11-era MSB8020 local-toolchain objection doesn't apply because installers build on CI, and prebuilt binaries exist for current Electron ABIs).
- DB file: `%APPDATA%\jat12-app\jat12.db` (identity reserved per the sibling ADR — same file even though v12 is now the primary app, so a machine that ran the v12-sibling preview keeps its data).
- Opened once in the main process by `app/src/main/db/index.js`. **No other process ever opens the file.** A build-time validation gate (reuse v11's `tools/validate.mjs` pattern) fails the build on `better-sqlite3`/`new Database` outside `app/src/main/db/`.

### 1.2 Pragmas (set at every open, in this order)
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;        -- WAL-safe; fsync on checkpoint
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;   -- pages (~4MB)
PRAGMA trusted_schema = OFF;
```
A `wal_checkpoint(TRUNCATE)` runs on app quit and in `maintenance()` so the `-wal` file cannot grow unbounded across long auto-apply runs.

### 1.3 Conventions
- **Ids:** TEXT `"<prefix>_<uuidv4>"` — `job_`, `appl_`, `run_`, `prof_`, `ans_`, `doc_`, `eml_`, `src_`, `ctk_`, `imp_`. Same scheme as v11 → imported v11 ids are preserved verbatim (idempotency, §5.4).
- **Timestamps:** `INTEGER` epoch **milliseconds**, columns named `*_at`. (v11 used ISO TEXT; epoch-ms halves index size on the hottest columns and makes range scans trivial. The importer converts with `Date.parse`.)
- **JSON columns:** named `*_json`, always `CHECK (json_valid(col))` + an explicit byte cap. Never a dumping ground: anything queried gets its own column.
- **All tables `STRICT`.** Booleans are `INTEGER CHECK (col IN (0,1))`.
- **Normalization functions** live in ONE shared module `app/src/shared/normalize.js` (used by main, importer, and shipped to the extension bundle so the sensor stamps the same keys):
  - `normKey(s)` — lowercase, `[^a-z0-9]+`→space, trim (v11-identical, so imported `norm_key`s match natively computed ones).
  - `normJobUrl(url)` — origin+path lowercased, trailing `/` stripped, keep only params `{currentjobid, jk, gh_jid, ashby_jid, jobid, job_id, lever_origin}` (v11 set + lever).
  - `normQuestion(label)` — the v11 EN+FR-collapsed canonical question key (port verbatim from v11 `memory.js`; this is what makes "asked once ever" work).

### 1.4 Write discipline
- Every DAL write is wrapped in `db.transaction(...)` (better-sqlite3 native; reentrancy handled by composing functions, not nested BEGIN).
- Prepared statements are cached per-module (`const stmt = db.prepare(...)` at module scope) — better-sqlite3 idiom, kills v11's re-parse overhead.
- The DAL exposes **lean list projections and detail getters as separate named functions** (`jobs.listLean()`, `jobs.getDetail(id)`, `runs.listLean()`, `runs.getSteps(id)`). There is deliberately **no `SELECT *` helper** in the DAL.

---

## 2. Full schema DDL (migration 001)

> One migration file `app/src/main/db/migrations/001_init.sql`, executed in a single transaction. `PRAGMA user_version = 1` on success.

### 2.1 Profiles (multi-user root)

```sql
CREATE TABLE profiles (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  is_default              INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  -- which discovery sources route their applications to this profile: ["linkedin","indeed",...]
  source_assignments_json TEXT NOT NULL DEFAULT '[]'
                          CHECK (json_valid(source_assignments_json) AND length(source_assignments_json) <= 2048),
  -- structured profile: contact, links, workHistory[], educationHistory[], custom fields
  data_json               TEXT NOT NULL DEFAULT '{}'
                          CHECK (json_valid(data_json) AND length(data_json) <= 262144),
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
) STRICT;
-- exactly one default profile, enforced structurally
CREATE UNIQUE INDEX idx_profiles_default ON profiles(is_default) WHERE is_default = 1;
```

Multi-user model: **one human per machine, N profiles per human** (Pierre: EN/FR profiles; Dad: one). There is no tenant column anywhere — Dad's machine has its own `jat12.db`. Everything user-shaped hangs off `profile_id` with `ON DELETE CASCADE`.

### 2.2 Jobs (the posting — LEAN by construction) + details

```sql
CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL,                    -- linkedin|indeed|greenhouse|lever|ashby|manual|import
  external_id      TEXT,                             -- board-native id (currentJobId, jk, gh_jid, ...)
  title            TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 512),
  company          TEXT NOT NULL DEFAULT '' CHECK (length(company) <= 256),
  company_key      TEXT NOT NULL DEFAULT '',         -- normKey(company)
  location         TEXT NOT NULL DEFAULT '' CHECK (length(location) <= 256),
  work_mode        TEXT CHECK (work_mode IN ('remote','hybrid','onsite')),
  employment_type  TEXT CHECK (length(employment_type) <= 64),
  compensation     TEXT CHECK (length(compensation) <= 256),
  job_url          TEXT NOT NULL DEFAULT '' CHECK (length(job_url) <= 2048),
  job_url_norm     TEXT NOT NULL DEFAULT '',
  norm_key         TEXT NOT NULL DEFAULT '',         -- normKey(title|company|location) — dedup key
  apply_capability TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (apply_capability IN
                     ('easy_apply','smartapply','ats_form','external','account_wall','unknown')),
  fit_score        INTEGER CHECK (fit_score BETWEEN 0 AND 100),
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

-- Heavy text quarantined here. The list endpoint CANNOT ship descriptions
-- because they are not in the table it queries.
CREATE TABLE job_details (
  job_id      TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 262144),  -- 256KB cap
  fit_json    TEXT CHECK (fit_json IS NULL OR (json_valid(fit_json) AND length(fit_json) <= 16384)),
  raw_json    TEXT CHECK (raw_json IS NULL OR (json_valid(raw_json) AND length(raw_json) <= 131072))
) STRICT;
```

Optional (migration 002, ship with launch): contentless FTS5 for the command palette / search:
```sql
CREATE VIRTUAL TABLE jobs_fts USING fts5(title, company, location, content='');
-- maintained by the jobs DAL on insert/update/delete (external-content pattern)
```

Dedup rule (DAL `jobs.upsert`): match on `(source, external_id)` → else `job_url_norm` → else `norm_key`. Forward-only merge of posting metadata; `last_seen_at` always bumped. (Same precedence as v11 `upsertJob`, so import merges cleanly.)

### 2.3 Applications (the act, per profile — clean status lifecycle)

```sql
CREATE TABLE applications (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES jobs(id)     ON DELETE CASCADE,
  profile_id       TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'tracked' CHECK (status IN
                     ('tracked','submitted','acknowledged','assessment',
                      'interview_1','interview_2','interview_final',
                      'offer','hired','rejected','withdrawn','ghosted')),
  via              TEXT CHECK (via IN ('auto','manual','import')),
  submitted_at     INTEGER,
  -- snapshot of answers given on THIS application (record, not memory — memory is learned_answers)
  answers_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(answers_json) AND length(answers_json) <= 32768),
  attachments_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attachments_json) AND length(attachments_json) <= 4096),
  notes            TEXT CHECK (length(notes) <= 16384),
  next_action      TEXT CHECK (length(next_action) <= 512),
  due_at           INTEGER,
  needs_review     INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (job_id, profile_id)
) STRICT;
CREATE INDEX idx_appl_status  ON applications(status, updated_at DESC);
CREATE INDEX idx_appl_profile ON applications(profile_id, updated_at DESC);
CREATE INDEX idx_appl_job     ON applications(job_id);
```

**Status FSM** (code constant `app/src/shared/status.js`, one place):
```
tracked(10) → submitted(20) → acknowledged(30) → assessment(35)
→ interview_1(40) → interview_2(50) → interview_final(60) → offer(70) → hired(80)
terminal: hired(80), rejected(90), withdrawn(91), ghosted(92)
```
- v11 names map 1:1 except `started→tracked`, `contacted→acknowledged` (importer translates; renderer labels are the new ones).
- **Pipeline writes are forward-only** (`applications.elevate(id, status, source)` — refuses to lower rank, exactly v11's email-elevation contract). **Manual patch** (`applications.patch`) can move anywhere and distinguishes `null` (clear) from `undefined` (keep).
- `sweepGhosted({days:28})` ports over: still-`submitted` + no matched inbound email in N days → `ghosted`.

### 2.4 Apply runs (structured run records — the transcript-blob replacement)

```sql
CREATE TABLE apply_runs (
  id                TEXT PRIMARY KEY,
  application_id    TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  job_id            TEXT NOT NULL,                    -- denormalized for hot filters (no FK: cascade comes via application)
  profile_id        TEXT NOT NULL,
  source            TEXT NOT NULL,                    -- linkedin|indeed|greenhouse|lever|ashby
  adapter_id        TEXT,                             -- pillar-2 site-adapter recipe id
  adapter_version   INTEGER,
  state             TEXT NOT NULL DEFAULT 'queued' CHECK (state IN
                      ('queued','dispatched','running','succeeded','parked','failed','skipped','abandoned')),
  mode              TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','review','teach')),
  route             TEXT CHECK (route IN ('easy_apply','smartapply','ats_form','external')),
  attempt           INTEGER NOT NULL DEFAULT 1,
  park_kind         TEXT CHECK (park_kind IN
                      ('captcha','cloudflare','login','account_wall','resume_required',
                       'needs_answer','awaiting_review','external_redirect','rate_limited','other')),
  park_detail       TEXT CHECK (length(park_detail) <= 2048),
  pending_questions_json TEXT NOT NULL DEFAULT '[]'
                      CHECK (json_valid(pending_questions_json) AND length(pending_questions_json) <= 16384),
  error             TEXT CHECK (length(error) <= 2048),
  evidence_kind     TEXT CHECK (evidence_kind IN
                      ('text_became_success','new_confirmation_node','confirm_signal',
                       'url_confirmation','modal_close_confirmed','manual_confirmed','legacy_untrusted')),
  evidence_json     TEXT CHECK (evidence_json IS NULL OR (json_valid(evidence_json) AND length(evidence_json) <= 8192)),
  steps_count       INTEGER NOT NULL DEFAULT 0,
  queued_at         INTEGER NOT NULL,
  dispatched_at     INTEGER,
  started_at        INTEGER,
  finished_at       INTEGER,
  updated_at        INTEGER NOT NULL,
  -- SUCCESS-TRUTH AS A CONSTRAINT: a run cannot be 'succeeded' without trustworthy typed evidence.
  CHECK (state <> 'succeeded' OR (evidence_kind IS NOT NULL AND evidence_kind <> 'legacy_untrusted'))
) STRICT;
CREATE INDEX idx_runs_state   ON apply_runs(state, queued_at);
CREATE INDEX idx_runs_appl    ON apply_runs(application_id);
CREATE INDEX idx_runs_updated ON apply_runs(updated_at DESC);
CREATE INDEX idx_runs_source  ON apply_runs(source, state);
```

Notes:
- **Worker slots = rows in state `dispatched|running`** — the pillar-3 scheduler counts these, never open tabs (the v11.84 warm-tab-pins-slot bug is impossible to express here). Stranded `dispatched` rows are reclaimed by the scheduler after 2 min, `running` after 8 (same numbers that proved out in v11.84).
- `evidence_kind` values are exactly the v11 R1 trustworthy set + `url_confirmation` (Indeed `/post-apply`) + `manual_confirmed` (human clicked "I submitted this"). `legacy_untrusted` exists ONLY so the importer can carry quarantined v11 history honestly.
- Timing analytics (gap-between-applies, apply duration — the v11.84 diagnostic) fall out of `queued_at/dispatched_at/started_at/finished_at` with plain SQL; no transcript parsing ever again.

**Steps — bounded, typed, per-run ring:**
```sql
CREATE TABLE apply_run_steps (
  run_id      TEXT NOT NULL REFERENCES apply_runs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,                       -- 1-based, monotonic per run
  at          INTEGER NOT NULL,
  phase       TEXT NOT NULL CHECK (phase IN
                ('open','detect','fill','answer','upload','advance','verify','park','finish')),
  action      TEXT CHECK (length(action) <= 64),      -- click|fill|select|scroll|wait|...
  target      TEXT CHECK (length(target) <= 256),     -- element role/label, NEVER raw HTML
  detail      TEXT CHECK (length(detail) <= 1024),
  duration_ms INTEGER,
  ok          INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
  PRIMARY KEY (run_id, seq)
) STRICT, WITHOUT ROWID;

-- STRUCTURAL bound: a run can never accrete more than 500 steps (v11 transcripts hit thousands).
CREATE TRIGGER trg_steps_cap BEFORE INSERT ON apply_run_steps
WHEN NEW.seq > 500
BEGIN SELECT RAISE(IGNORE); END;
```
Retention (residual cron, §2.11): steps of terminal runs older than 14 days are deleted; the `apply_runs` row (with evidence, error, park, timings) is permanent history. `steps_count` on the run survives deletion so the UI can say "412 steps (pruned)".

### 2.5 Learned answers (per-profile memory — profile_fields + qa unified)

```sql
CREATE TABLE learned_answers (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('field','qa')),   -- field = structured form field, qa = free-text screening Q
  key_norm      TEXT NOT NULL,                                  -- normQuestion(label) — THE dedup key ("asked once ever")
  label         TEXT NOT NULL CHECK (length(label) <= 512),     -- human question, original language
  locale        TEXT NOT NULL DEFAULT 'en',
  field_type    TEXT CHECK (field_type IN ('text','textarea','select','radio','checkbox','number','date','file')),
  value         TEXT CHECK (value IS NULL OR length(value) <= 8192),
  options_json  TEXT CHECK (options_json IS NULL OR (json_valid(options_json) AND length(options_json) <= 4096)),
  confidence    REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  provenance    TEXT NOT NULL DEFAULT 'harvest' CHECK (provenance IN
                  ('user','harvest','ai','teach','profile_push','import_v11')),
  locked        INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),  -- user-edited: harvest/AI may never overwrite
  seen_count    INTEGER NOT NULL DEFAULT 1,
  used_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER,
  source_host   TEXT CHECK (length(source_host) <= 128),
  source_job_id TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (profile_id, kind, key_norm)
) STRICT;
CREATE INDEX idx_answers_lookup ON learned_answers(profile_id, key_norm);
```

Contract (mirrors the hard-won v11 rules):
- **Every** DAL function takes `profileId` and **throws** on a missing one — no silent global writes (v11 logged-and-returned; v12 is stricter because there is no legacy global data).
- Answer resolution order (pillar 3 consumes this): exact `key_norm` (kind `field` then `qa`) → fuzzy in-memory over a per-request snapshot (v11.82's `makeMemoryCache` pattern — never per-question table scans) → profile `data_json` structured fields → cloud AI fallback (≥ `aiAnswerConfidenceMin`, default 0.65) → park `needs_answer`. **Every AI/user answer is written back** with its provenance, so each question is asked once ever.
- **Sensitive guard:** `isSensitiveKey()` (EEO/demographics/SSN/DOB/criminal — port v11 `SENSITIVE_RX`) blocks writes at the DAL, at import, and in the extension harvester. Three layers, same regex module.
- `locked=1` rows win all merges. `profile_push` provenance rows (profile→memory bridge) are written locked at confidence 1.0 (v11 behavior).

### 2.6 Documents (bytes IN the database + extracted text)

v11 stored only `file_path`; a disk restore already cost Pierre the Aurora code — resumes must not depend on loose files. 82 docs ≈ tens of MB: fine in SQLite, and blobs live in their own table so document lists stay lean.

```sql
CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT REFERENCES profiles(id) ON DELETE SET NULL,   -- NULL = shared/unassigned
  name        TEXT NOT NULL CHECK (length(name) <= 256),
  role        TEXT NOT NULL DEFAULT 'resume' CHECK (role IN ('resume','cover_letter','portfolio','transcript','other')),
  label       TEXT CHECK (length(label) <= 128),                 -- user designation ("Master CV")
  mime        TEXT CHECK (length(mime) <= 128),
  size_bytes  INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes <= 26214400),   -- 25MB hard cap/file
  sha256      TEXT,                                               -- content dedup + import idempotency
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  source      TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','application','folder','import_v11')),
  origin_path TEXT CHECK (length(origin_path) <= 1024),           -- informational only; bytes are canonical
  missing_file INTEGER NOT NULL DEFAULT 0 CHECK (missing_file IN (0,1)),   -- import couldn't recover bytes
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
  document_id  TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  text         TEXT NOT NULL DEFAULT '' CHECK (length(text) <= 524288),
  keywords_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(keywords_json) AND length(keywords_json) <= 4096),
  indexed_at   INTEGER
) STRICT;
```

Upload flow writes `documents` + `document_blobs` in one transaction; extraction fills `document_text` async. The apply engine streams bytes to the extension per-upload on demand (pillar 1 transport) — bytes never sit in any list payload.

### 2.7 Emails + matches

```sql
CREATE TABLE emails (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  provider    TEXT CHECK (provider IN ('gmail','outlook','imap')),
  uid         INTEGER,                                  -- IMAP UID / Gmail msg ordinal — per-account dedup
  message_id  TEXT,                                     -- RFC822 Message-ID — cross-account dedup
  thread_id   TEXT,
  from_addr   TEXT CHECK (length(from_addr) <= 320),
  from_name   TEXT CHECK (length(from_name) <= 256),
  to_addr     TEXT CHECK (length(to_addr) <= 320),
  subject     TEXT CHECK (length(subject) <= 998),
  snippet     TEXT CHECK (length(snippet) <= 512),
  body        TEXT CHECK (body IS NULL OR length(body) <= 65536),   -- 64KB cap AT THE SCHEMA
  sent_at     INTEGER,
  category    TEXT CHECK (category IN
                ('application_confirmation','recruiter','assessment','interview','offer','rejection','other')),
  created_at  INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_emails_acct_uid ON emails(account_id, uid);
CREATE INDEX idx_emails_msgid ON emails(message_id);
CREATE INDEX idx_emails_sent  ON emails(sent_at DESC);

-- Match is its own row (v11 had it inline on emails): one current match per email,
-- with enough provenance to power the suggest→confirm UI and never resurrect a dismissal.
CREATE TABLE email_matches (
  email_id       TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  job_id         TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  confidence     REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source         TEXT NOT NULL CHECK (source IN ('auto','suggested','manual','dismissed')),
  decided_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_email_matches_appl ON email_matches(application_id);
```

Pipeline rule (unchanged from the v11.48/64 lessons, enforced in the email DAL): only `auto`/`manual` matches may call `applications.elevate`; `suggested` waits for a human click; `dismissed` is never re-suggested. Category precedence (offer > rejection > strong-receipt-confirmation > assessment > interview > confirmation) ports verbatim — it is classifier logic, not schema, but the CHECK list above is its vocabulary.

### 2.8 Discovery (per-source lanes, yield-only telemetry, O(jobs) provenance)

```sql
-- One row per supply lane. Per-source gates/cursors LIVE HERE — there is no shared
-- refill gate row to fight over (the v11.83 starvation is unrepresentable).
CREATE TABLE discovery_sources (
  id              TEXT PRIMARY KEY,          -- 'src_linkedin','src_indeed','src_gh','src_lever','src_ashby'
  board           TEXT NOT NULL UNIQUE,      -- linkedin|indeed|greenhouse|lever|ashby
  kind            TEXT NOT NULL CHECK (kind IN ('jobspy','extension_scrape','ats_board')),
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  config_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json) AND length(config_json) <= 8192),
  cursor_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json) AND length(cursor_json) <= 16384),
                  -- combo index, per-combo freshness tiers, watermarks (replaces v11 kv sprawl)
  last_tick_at    INTEGER,
  next_earliest_at INTEGER,                  -- per-source pacing gate
  cooldown_until  INTEGER,                   -- breaker (rate-limit / CF detection)
  breaker_reason  TEXT CHECK (length(breaker_reason) <= 256),
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE TABLE company_tokens (
  id            TEXT PRIMARY KEY,
  ats           TEXT NOT NULL CHECK (ats IN ('greenhouse','lever','ashby')),
  token         TEXT NOT NULL CHECK (length(token) <= 128),
  company       TEXT CHECK (length(company) <= 256),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  added_by      TEXT NOT NULL DEFAULT 'seed' CHECK (added_by IN ('seed','learned','user')),
  verified_at   INTEGER,
  last_scan_at  INTEGER,
  last_yield_at INTEGER,
  dead_count    INTEGER NOT NULL DEFAULT 0,   -- consecutive 404/empty-API; >= 5 → active=0 (auto-retire)
  created_at    INTEGER NOT NULL,
  UNIQUE (ats, token)
) STRICT;
```
The 113 live-verified seed tokens ship as `app/src/main/discovery/seed-tokens.json` and are upserted (`ON CONFLICT DO NOTHING`) at first run — data, not migration, so token updates ride app updates without schema churn.

```sql
-- YIELD-ONLY telemetry, ring-buffered. INTEGER PK on purpose: nothing references batches
-- (provenance is job_sightings), so ring deletion is trivial and cheap.
CREATE TABLE discovery_batches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id        TEXT NOT NULL,
  company_token_id TEXT,
  keyword          TEXT CHECK (length(keyword) <= 128),
  location         TEXT CHECK (length(location) <= 128),
  status           TEXT NOT NULL CHECK (status IN ('ok','rate_limited','error')),
  found_count      INTEGER NOT NULL DEFAULT 0,
  accepted_count   INTEGER NOT NULL DEFAULT 0,
  duplicate_count  INTEGER NOT NULL DEFAULT 0,
  rejected_count   INTEGER NOT NULL DEFAULT 0,
  error            TEXT CHECK (length(error) <= 1024),
  started_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  -- STRUCTURAL: an empty successful scan cannot be recorded (the 12.8k-junk-rows/day bug).
  CHECK (status <> 'ok' OR found_count > 0)
) STRICT;
CREATE INDEX idx_batches_time ON discovery_batches(started_at DESC);
CREATE TRIGGER trg_batches_ring AFTER INSERT ON discovery_batches
BEGIN DELETE FROM discovery_batches WHERE id <= NEW.id - 5000; END;

-- Provenance: PK-deduped per (job, source). Re-seeing a job UPDATES last_seen/seen_count —
-- O(jobs × sources) rows max, never O(scans).
CREATE TABLE job_sightings (
  job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_id        TEXT NOT NULL,
  apply_capability TEXT NOT NULL DEFAULT 'unknown',
  raw_url          TEXT CHECK (length(raw_url) <= 2048),
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  seen_count       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (job_id, source_id)
) STRICT, WITHOUT ROWID;
```

SSE consequence (pillar 5 consumes): `discovery.updated` broadcasts carry the single batch row that was inserted — and since empty scans insert nothing, they broadcast nothing. The v11.85 SSE storm is gone at the source.

### 2.9 Settings (typed + versioned) and secrets (with health)

```sql
CREATE TABLE settings (
  section        TEXT NOT NULL,     -- autoApply | discovery | ai | gmail | appearance | notifications | maintenance | goals
  key            TEXT NOT NULL,     -- leaf key, dot-free
  value_json     TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 16384),
  schema_version INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (section, key)
) STRICT, WITHOUT ROWID;
```
- **Typed:** a code registry `app/src/main/settings/schema.js` declares every `(section, key)` with `{type, default, min, max, enum, description}`. Reads merge stored → defaults per key (no `deepMerge` of whole sections — the v11.13 "stale saved blob shadows new defaults forever" bug is impossible because unknown/new keys simply fall through to their registry default).
- **Versioned:** `schema_version` per row + per-key `upgrade(oldValue, oldVersion)` hooks in the registry (e.g. the v11 "remote is not a location" repair becomes a one-time typed upgrade instead of an on-every-load normalizer).
- Writes validate against the registry and **reject** unknown keys/types (the API returns 400 with the offending key).

```sql
-- Secrets NEVER live in settings. Sealed via Electron safeStorage (DPAPI on Windows).
CREATE TABLE secrets (
  key            TEXT PRIMARY KEY,   -- 'ai.anthropicKey','gmail.oauth','cws.oauth','pairing.extensionToken',...
  sealed         BLOB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('ok','expired','revoked','unknown')),
  last_ok_at     INTEGER,            -- last successful use
  last_error     TEXT CHECK (length(last_error) <= 512),
  expires_hint_at INTEGER,           -- provider-declared expiry when known (Google unverified ≈ 7d)
  updated_at     INTEGER NOT NULL
) STRICT;
```
Every consumer (Gmail sync, AI client) reports success/failure back to the secrets DAL → `status/last_ok_at/last_error` are always current → the UI token-health panel and its one-click re-auth (ground-truth failure mode 8) read this table, no probing.

### 2.10 Events (durable timeline) vs activity log (ring) vs AI ledger (ring)

```sql
-- Durable per-application/job timeline: status changes, submissions, email matches,
-- imports. Small, valuable, user-visible history. NOT a telemetry dump.
CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  at             INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('status_change','submitted','park','email_matched','note','imported','created','document_attached')),
  job_id         TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  run_id         TEXT,
  email_id       TEXT,
  source         TEXT CHECK (length(source) <= 64),
  summary        TEXT CHECK (length(summary) <= 512),
  data_json      TEXT CHECK (data_json IS NULL OR (json_valid(data_json) AND length(data_json) <= 4096))
) STRICT;
CREATE INDEX idx_events_appl ON events(application_id, at DESC);
CREATE INDEX idx_events_at   ON events(at DESC);

-- Telemetry firehose (scheduler ticks, breaker trips, SSE stats): ring buffer, 20k rows, period.
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

-- AI call ledger: ring buffer, 2000 rows.
CREATE TABLE ai_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  provider       TEXT, model TEXT, kind TEXT,
  ms             INTEGER, ok INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
  error          TEXT CHECK (length(error) <= 512),
  prompt_chars   INTEGER, response_chars INTEGER
) STRICT;
CREATE TRIGGER trg_ai_ring AFTER INSERT ON ai_calls
BEGIN DELETE FROM ai_calls WHERE id <= NEW.id - 2000; END;

-- Cursors/one-shot flags that are truly key-value (watermarks, vacuum stamps).
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT CHECK (length(value) <= 8192)
) STRICT, WITHOUT ROWID;

-- Importer audit (see §5)
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
```

### 2.11 Residual maintenance (small on purpose)

`db.maintenance()` — hourly timer + on-quit; everything here is *time*-based cleanup the schema can't express (the *size* bounds are already structural):
- delete `apply_run_steps` of terminal runs `finished_at < now-14d`
- delete unmatched emails `created_at < now-365d` where no `email_matches` row or `source='dismissed'` protection (v11 rule kept)
- `posting_state='stale'` for jobs `last_seen_at < now-45d` with no application activity
- `wal_checkpoint(TRUNCATE)`; `VACUUM` at most every 3 days (kv-stamped)
- daily `backupNow()` via **better-sqlite3 `db.backup(file)`** (online, non-blocking pages loop) to `userData/backups/jat12-YYYY-MM-DD.db`, keep 14

Steady-state size budget with the live dataset + 1 year of use: **< 80MB** (v11 hit 74MB in weeks; the two biggest v11 hogs — transcripts and O(scans) provenance — no longer exist).

---

## 3. Migration framework (forward-only)

`app/src/main/db/migrate.js`:

```js
// migrations/ directory: 001_init.sql, 002_fts.sql, 003_*.sql|.js  (NNN monotonic, no gaps)
// .sql  → executed via db.exec inside one transaction
// .js   → module.exports = { up(db) }  for data-shaping migrations
```

Rules (each one is a v11 scar):
1. **Forward-only.** If `PRAGMA user_version` > highest known migration → **refuse to open** with a clear "this database was created by a newer JAT — update the app" dialog. No downgrade path, ever.
2. **Backup before any migration** beyond 001: `db.backup(backups/pre-v{N}-{date}.db)` completes before the migration transaction begins.
3. One migration = one transaction; failure rolls back and the app opens in a read-only "migration failed" state showing the error + backup path (never a half-migrated DB, never a bricked launch).
4. `user_version` is written only inside `migrate.js` (build-gate enforced, same as the v12-sibling `tools/validate.mjs` rule).
5. Data repairs (v11's `migrateGmailQuery`-style kv-flagged one-shots) are **numbered `.js` migrations**, not open()-time side effects — one ordered ledger, no hidden second migration system.
6. `schema_migrations` ledger row per applied migration `(version, name, applied_at, ms)` for the diagnostics page.

```sql
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  ms         INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
```

---

## 4. DAL surface (names the other pillars code against)

`app/src/main/db/dal/` — one module per aggregate; all synchronous (better-sqlite3), all profile-scoped where user-shaped:

| Module | Key functions (signatures abridged) |
|---|---|
| `jobs.js` | `upsert(job) → {job, action}` · `listLean({status?, source?, q?, limit=500, offset})` · `getDetail(id)` · `patch(id, fields)` · `markSeen(id, sourceId, capability)` |
| `applications.js` | `ensure(jobId, profileId) → appl` · `elevate(id, status, source)` (forward-only) · `patch(id, fields)` (anywhere) · `listLean({status?, profileId?, limit})` · `funnel({days})` |
| `runs.js` | `enqueue(applicationId, {mode, source}) → run` · `claimNext(source, slotBudget)` (scheduler-only) · `patch(id, fields)` (state machine guards inside) · `addStep(runId, step)` · `getSteps(runId)` · `listLean({state?, since?, limit})` · `stats({hours})` |
| `answers.js` | `lookup(profileId, keyNorm)` · `snapshot(profileId)` (in-memory fuzzy cache) · `record(profileId, {kind, label, value, provenance, confidence})` · `list(profileId, {q, limit})` · `promoteToProfile(id)` |
| `documents.js` | `add({name, role, bytes, mime, profileId})` · `listLean()` · `getBytes(id)` · `getText(id)` · `setDefault(id)` |
| `emails.js` | `upsert(email)` (account+uid dedup; manual/dismissed match never clobbered) · `setMatch(emailId, {applicationId, confidence, source})` · `listForApplication(applId)` · `unmatchedSuggestions(limit)` |
| `discovery.js` | `sourceGet/patch(board)` · `recordBatch(batch)` (throws on zero-yield ok — belt to the CHECK's suspenders) · `tokensDue(ats, limit)` · `tokenScanned(id, {yielded})` |
| `settings.js` | `get(section)` / `getKey(section, key)` · `set(section, key, value)` (registry-validated) · `all()` |
| `secrets.js` | `seal(key, plaintext)` · `open(key)` · `reportUse(key, ok, error?)` · `health()` |
| `events.js` | `record(evt)` · `timeline(applicationId)` |
| `db/index.js` | `open(userDataDir)` · `close()` · `backupNow(tag)` · `maintenance()` · `transaction(fn)` |

Payload discipline (encodes failure mode 6): every `listLean` has an explicit column list, a default `limit`, and returns `{rows, total}`. SSE emits `{table, id, patch}` of the changed row (pillar 5); "go refetch everything" events do not exist in the DAL vocabulary.

---

## 5. The v11 importer

`app/src/main/importer/v11.js` + UI wizard (Settings → **Import from JAT v11**). Works identically on Pierre's and Dad's machines: zero hardcoded user paths, all shape detection is runtime.

### 5.1 Preconditions & safety gates (in order, each with a typed refusal the UI renders)

1. **Locate source.** Default `path.join(process.env.APPDATA, 'jat11-app', 'jat.db')`; file-picker override (Dad's machine if relocated, or a `backups/jat-YYYY-MM-DD.db` snapshot).
2. **wasm lock check.** `jat.db.lock` **is a directory** (node-sqlite3-wasm mkdir-lock). If it exists → refuse: `V11_LOCK_PRESENT` — "JAT v11 is running or crashed while holding its lock. Quit v11 (or delete the stale jat.db.lock folder if v11 is certainly not running) and retry."
3. **Live-process check.** Probe `http://127.0.0.1:7744/health` (800ms timeout). Responds → refuse: `V11_RUNNING` — "Quit JAT v11 first (import reads a consistent snapshot)."
4. **Snapshot copy.** Copy `jat.db` + `jat.db-wal` + `jat.db-shm` *if present* (the WAL-caveat lesson) to scratch temp; open the **copy** with `new Database(tmp, { readonly: true, fileMustExist: true })`. The original is never opened, never written. `sha256(jat.db)` recorded → `import_runs.source_sha256`.
5. **Version & shape detection.** Read `PRAGMA user_version` (v11 shipped 1…15). Importer supports `>= 6` (per-profile memory exists; Dad is ≥ 11). Column presence is feature-detected per table via `PRAGMA table_info` — e.g. `submission_evidence` only exists ≥ v11-migration-11; missing columns degrade gracefully. Unknown newer version → warn in the plan, proceed on the known-column subset.

### 5.2 Two-phase: plan (dry-run) → execute

- **`plan()`** — read-only over the snapshot; produces the full report (§5.6) without touching jat12.db. Always runs first; the UI shows it as the dry-run screen with an "Import now" button.
- **`execute(plan)`** — one big jat12 transaction per section (jobs+details+applications, then answers, documents, emails, events, runs), preceded by `backupNow('pre-import')`. Partial failure rolls back the failing section, records `status='partial'` with the error in `report_json`, and leaves earlier sections committed (they're idempotent to re-run).

### 5.3 Mapping table (v11 → v12)

| v11 table (live count) | v12 destination | Mapping detail |
|---|---|---|
| `jobs` (4,153) | `jobs` + `job_details` + `applications` | Job id preserved. `description`→`job_details.description` (truncate at 256KB, marker appended). `fit_data`→`fit_json`. `status` splits: posting fields stay on `jobs`; lifecycle → an `applications` row per job with **deterministic id `appl_v11_<v11JobId>`**, `profile_id = resolveProfileId(job.source)` (v11 `source_assignments` logic, else default profile), `status` mapped `started→tracked`, `contacted→acknowledged`, rest 1:1; `submitted_at`, `notes`, `next_action`, `due_at`, `needs_review`, `answers`→`answers_json` (cap 32KB), `attachments`→`attachments_json`, `tags` merged (+`"imported-v11"`). ISO→epoch-ms throughout. `first_seen_at=last_seen_at=created_at`. |
| `profiles` (Pierre: 1-2) | `profiles` | Ids + `is_default` + `source_assignments` + `data` preserved verbatim (JSON shape unchanged: contact, links, workHistory[], educationHistory[]). |
| `profile_fields` (1,614) | `learned_answers` kind=`'field'` | Id, `profile_id`, `key_norm`, `label`, `locale`, `value` (cap 8KB), `field_type` (normalized to the CHECK vocabulary, unknown→`text`), `confidence`, `locked`, `seen_count` preserved. `provenance='import_v11'` unless `locked=1` → `'user'`. `source`→`source_host`, `source_job_id` kept. **`isSensitiveKey(key_norm)` rows are dropped** (counted in the report — v11 had server backstops but pre-backstop rows may exist). |
| `qa` (2,314) | `learned_answers` kind=`'qa'` | `question_norm`→`key_norm`, `question`→`label`, `answer`→`value`, `seen_count` kept, `confidence=0.7` (v11 qa had none; 0.7 = usable-but-verifiable), `provenance='import_v11'`. `answer_lineage`/`reward_score` dropped (apprenticeship v11-specific). Collision with an existing `(profile_id,'qa',key_norm)` → skip (v12 wins). Sensitive guard applies. |
| `documents` (82) | `documents` + `document_blobs` + `document_text` | Id preserved. Read bytes from v11 `file_path`: found → `document_blobs` + `sha256` (sha-duplicate → skip blob, keep metadata row pointing at nothing? No — **skip the whole row**, count as duplicate); missing → row with `missing_file=1`, `origin_path` kept, warning listed per-file in the report. `text_content`→`document_text.text` (cap 512KB), `keywords`→`keywords_json`. `role` mapped (`coverLetter`→`cover_letter` already fixed in v11 v2). `folder_id`/`importance` dropped (folder-scan is re-configured fresh in v12). |
| `emails` (497) | `emails` + `email_matches` | Id preserved; column-for-column into `emails` (body capped 64KB). `matched_job_id`+`match_confidence`+`match_source` → one `email_matches` row: `job_id` = matched job (must exist post-import, else match dropped + warned), `application_id` = the `appl_v11_<jobId>` row, `source` mapped (`auto/manual/suggested/dismissed` 1:1). |
| `events` | `events` (filtered) | Keep kinds that map to the v12 vocabulary: `status_change`, `submitted`, `imported`, `email_matched`, `note`, `created`; everything else dropped (counted). `data` truncated to 4KB. `job_id` preserved; `application_id` derived. |
| `auto_apply_tasks` (~3.2k) | `apply_runs` (terminal history only) | Deterministic id `run_v11_<taskId>`. State map: `done`→`succeeded` **iff** `submission_evidence` passes the trust test (port `isTrustworthyEvidence`); evidence type mapped → `evidence_kind` (`verified:text-became-success`→`text_became_success`, `new-confirmation-node`→`new_confirmation_node`, `confirm-signal*`→`confirm_signal`, Indeed `type:verified detail:confirmation`→`url_confirmation`, modal-close `confirmed`→`modal_close_confirmed`). `done` with missing/legacy evidence → `parked` + `park_kind='awaiting_review'` + `evidence_kind='legacy_untrusted'` (mirrors v11's own quarantine; the CHECK forbids calling it success). `failed`→`failed`, `skipped`→`skipped`, `parked/awaiting_input/awaiting_review`→`parked` with `park_kind` derived from `park_reason` keyword table (captcha/cloudflare/login/resume/answer/review/wall→ respective kinds, else `other`). `queued/scheduled/running`→**not imported** (stale in-flight; the v12 scheduler starts clean). `apply_route`→`route` (`easy-apply`→`easy_apply`, `external`→`external`). `attempts`→`attempt`, `last_error`→`error` (2KB cap), `pending_questions`→`pending_questions_json`. Timestamps mapped; `queued_at=created_at`. |
| `auto_apply_tasks.transcript` (~15MB) | **DROPPED** | Deliberate (see §5.5). `steps_count=0`, and the importer stamps `park_detail`/`error` from `last_error` so nothing user-facing is lost. |
| `settings` | `settings` (curated subset) | Explicit allow-map, never a blind copy: `autoApply.{keywords, locations, workModes, country, seniorityMax, easyApplyOnly, maxPerDay, maxPerHour, aiAnswerConfidenceMin}` (through v11's `normalizeAutoApply` repair first), `gmail.query` **only if** it differs from every known v11 default (custom query preserved; stale LinkedIn-only default NOT imported), `appearance.theme`, `notifications.*`. Everything else = v12 registry defaults. Secrets (`ai.*.apiKey`, `gmail.clientSecret`) **never imported** — user reconnects via the token-health UI. |
| `ai_log`, `discovery_batches` (12k+ junk), `job_discovery_provenance` (26–37k), `discovery_fallbacks`, `nav_events`, `demonstrations`, `teach_screenshots`, `ats_recipes`, `recipe_steps`, `application_outcomes`, `punishments`, `document_folders`, `kv` | **DROPPED** | See §5.5. |

### 5.4 Idempotency (re-run safe, v12 edits never clobbered)

- Every insert is `INSERT ... ON CONFLICT DO NOTHING` keyed on **preserved v11 ids** (or the deterministic `appl_v11_*` / `run_v11_*` derivations). A re-run therefore creates exactly the rows that are missing and touches nothing else.
- **Import never updates an existing v12 row** — if Pierre edited a job/answer after the first import, a re-import skips it (counted as `skipped_existing`). The one exception: a job that exists in v12 via *native* discovery under a different id but with the same `norm_key`/`job_url_norm` — the plan detects these as `merge_dedup` and routes the v11 application/emails to the existing v12 job id instead of creating a duplicate posting.
- `import_runs` records every run (dry or real) with its full report; the UI lists them.

### 5.5 What we deliberately DROP (and why — shown verbatim in the report UI)

| Dropped | Size/count (Pierre live) | Why |
|---|---|---|
| Apply transcripts | ~15MB across ~3.2k tasks | Unstructured log lines; v12's structured `apply_runs` (state, route, park, typed evidence, timings) carries everything decision-relevant. v11 itself already nulls them after 3 days. |
| `discovery_batches` + `job_discovery_provenance` + `discovery_fallbacks` | 17k + 37k rows, mostly zero-yield | The junk-telemetry bug's residue. v12 provenance (`job_sightings`) is rebuilt naturally as sources re-see jobs; historical scan noise has zero forward value. |
| `ai_log` | ~thousands | Ephemeral ops telemetry; v12 ring-buffers its own. |
| Apprenticeship tables (`ats_recipes`, `recipe_steps`, `demonstrations`, `nav_events`, `application_outcomes`, `punishments`, `teach_screenshots`) | varies | Selector-level recipes learned against v11's executor world; v12's adapters-as-data (pillar 2) has its own recipe store + format. Importing stale selectors would seed the new driver with exactly the brittle heuristics v12 exists to kill. |
| `document_folders` | 0–2 rows | Folder scan is reconfigured fresh (paths may not exist post-restore anyway). |
| `kv` (cursors, watermarks, tokens) | ~dozens | All v11-runtime-specific; v12 cursors live in `discovery_sources.cursor_json` and start fresh. |
| Secrets | — | Policy: never copy credentials between apps; re-auth through the health UI. |

### 5.6 Dry-run report (shape → rendered by the wizard)

```jsonc
{
  "source": { "path": "...", "sha256": "...", "v11UserVersion": 15, "fileBytes": 49872896,
              "wal": true, "warnings": ["unknown user_version 16 — importing known columns only"] },
  "profiles": { "found": 2, "toCreate": 2, "existing": 0 },
  "jobs": { "found": 4153, "toCreate": 4100, "mergeDedup": 41, "skippedExisting": 12 },
  "applications": { "toCreate": 4141, "byStatus": { "tracked": 3300, "submitted": 483, "rejected": 214, "...": 0 } },
  "answers": { "fields": { "found": 1614, "toCreate": 1590, "droppedSensitive": 9, "skippedExisting": 15 },
               "qa": { "found": 2314, "toCreate": 2280, "droppedSensitive": 4, "skippedExisting": 30 } },
  "documents": { "found": 82, "toCreate": 71, "missingFile": 8, "duplicateSha": 3,
                 "missingList": [ { "name": "CS_Resume_2024.pdf", "path": "C:\\..." } ] },
  "emails": { "found": 497, "toCreate": 497, "matchesToCreate": 430, "matchesDroppedNoJob": 2 },
  "runs": { "found": 3194, "toCreate": 2100, "succeededVerified": 447, "quarantinedLegacy": 36,
            "parked": 400, "failed": 900, "skipped": 353, "droppedInFlight": 12 },
  "events": { "found": 9000, "toCreate": 5200, "droppedKinds": { "detector_ping": 3800 } },
  "settings": { "imported": ["autoApply.keywords", "autoApply.locations", "appearance.theme"], "defaulted": "everything else" },
  "dropped": [ { "table": "auto_apply_tasks.transcript", "reason": "replaced by structured runs", "bytes": 14900000 }, "..." ],
  "estimate": { "jat12DeltaBytes": 21000000, "seconds": 8 }
}
```

### 5.7 Dad's machine (multi-user proof)

Nothing Pierre-specific exists in the code path: source located via `%APPDATA%` at runtime; his single profile imports as the default; his own `profile_fields/qa` counts flow through the same mapping; the report renders his numbers. The wizard's only requirement — "quit v11 first" — is enforced by gates 2–3, with the exact same refusal messages. If his v11 lags at an older `user_version`, feature detection (§5.1.5) narrows the column set instead of failing.

### 5.8 API surface (pillar-5 routes; listed here as the contract)

```
POST /api/import/v11/plan     { sourcePath? }        → 200 report | 409 {code:V11_RUNNING|V11_LOCK_PRESENT|NOT_FOUND|UNSUPPORTED_VERSION}
POST /api/import/v11/execute  { planId }             → 200 {importRunId, report} (SSE progress events import.progress)
GET  /api/import/v11/runs                            → 200 [{id, startedAt, dryRun, status, summary}]
```

---

## 6. Test plan (files under `app/tests/`)

| Test file | Covers |
|---|---|
| `db-schema.test.mjs` | every CHECK fires (zero-yield batch rejected, succeeded-without-evidence rejected, step 501 ignored, oversized JSON rejected); ring triggers hold caps; WITHOUT ROWID PKs dedup sightings |
| `db-migrate.test.mjs` | fresh init → user_version; forward-only refusal on future version; backup-before-migrate; failed migration rolls back + read-only mode |
| `dal-answers.test.mjs` | per-profile isolation, FK cascade, sensitive-key rejection, locked-wins merge, lookup precedence |
| `dal-runs.test.mjs` | state-machine guards, slot counting = in-flight rows, evidence typing |
| `import-v11.test.mjs` | builds a synthetic v11 jat.db **with the real v11 DDL at user_version 6, 11, and 15**, plus a `jat.db.lock` directory case; asserts full mapping table, idempotent double-run (second run = all skips), sensitive drops, evidence trust mapping, merge_dedup path, missing-document warnings, deterministic ids |
| `import-report.test.mjs` | plan/execute parity (execute's actual counts == plan's promised counts on the same snapshot) |

---

## 7. Open questions (for the architect / Pierre)

1. **`answers_json` on applications** — 32KB snapshot per application of what was submitted. Keep (audit value) or reference `learned_answers` ids only (leaner, but breaks if an answer is later edited)? Current design: keep the snapshot.
2. **FTS5 at launch or fast-follow?** Command palette (pillar 6 Aurora) wants it; migration 002 is written either way.
3. **Import of v11 `punishments`** (don't-apply company/title blocklist): currently dropped, but if pillar 3's scheduler grows a blocklist table it should import — needs pillar-3's schema to exist first.
4. **Document bytes cap** — 25MB/file, blobs in-DB. If Pierre's portfolio PDFs exceed this, switch `document_blobs` to a content-addressed file store under userData with sha256 names (schema unchanged: blob table becomes optional cache). Decide when real data hits the cap.
5. **Profile deletion UX** — CASCADE wipes that profile's applications/answers/runs. Needs a typed-confirm + pre-delete backup in the UI spec (pillar 6).
