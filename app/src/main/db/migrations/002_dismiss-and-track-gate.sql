-- Migration 002 — permanent dismiss + the track/ingest gate's memory (Stage 3).
--
-- Pierre's v11 scar (2026-07-10): the extension tracked pages that were NOT job postings, and
-- DISMISSING one didn't stick — it came back on the next sighting. Two structural fixes:
--
--  1) DISMISSALS is the permanent block. Every ingest path (extension "track this page" AND every
--     discovery lane) consults it BEFORE creating or reviving a job. Keyed by EVERY dedup identity a
--     re-sighting could arrive under (normalized key / normalized url / company), so a re-post under a
--     fresh row id still resolves to the same dismissal. A dismissed posting can never return.
--
--  2) jobs.dismissed_at hides the specific row + its application from every view (funnel excludes it),
--     and records WHY, so "not a job" dismissals also teach the ingest gate (a growing negative signal).
--
-- The job-GATE itself (is this URL/page actually a posting?) is code (discovery/ingest + /track), not
-- schema — but its "no, and remember it" outcome lands here.

CREATE TABLE dismissals (
  dismiss_key   TEXT PRIMARY KEY,     -- 'nk:'||norm_key | 'url:'||job_url_norm | 'co:'||company_key
  job_id        TEXT,                 -- the job dismissed (nullable — the KEY outlives any row)
  reason        TEXT NOT NULL DEFAULT 'user'
                CHECK (reason IN ('user','not_a_job','spam','irrelevant','off_target')),
  note          TEXT CHECK (note IS NULL OR length(note) <= 512),
  dismissed_at  INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_dismissals_job ON dismissals(job_id);

-- the specific dismissed job (its keys are already in `dismissals`); NULL = live. Views filter on this.
ALTER TABLE jobs ADD COLUMN dismissed_at INTEGER;
CREATE INDEX idx_jobs_dismissed ON jobs(dismissed_at);
