-- Migration 002 — inbox (email → application status). Pillar 4 §2.7 + the Gmail-sync columns Pillar 8
-- needs, in this codebase's house style (STRICT, epoch-ms, CHECK-bounded). The v11 importer targets
-- these tables (a synthetic 'imported' account holds carried-over mail). The maintenance() email
-- retention (365d unmatched) activates automatically now that these tables exist.
-- NOTE: numbering is contiguous by BUILD order — inbox ships before discovery, so inbox=002. Secrets
-- (tokens) never live here; they go through the secrets DAL (Electron safeStorage).

CREATE TABLE email_accounts (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('gmail_oauth','imap','imported')),
  email          TEXT NOT NULL DEFAULT '',
  label          TEXT CHECK (label IS NULL OR length(label) <= 128),
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  -- gmail sync cursors
  history_id     TEXT,
  watermark_ms   INTEGER NOT NULL DEFAULT 0,
  -- imap cursors
  imap_host      TEXT, imap_port INTEGER,
  imap_secure    INTEGER CHECK (imap_secure IS NULL OR imap_secure IN (0,1)),
  imap_uid       INTEGER NOT NULL DEFAULT 0,
  imap_uidvalidity TEXT,
  -- token lifecycle (health surface reads this; the sealed token lives in the secrets table)
  token_state    TEXT NOT NULL DEFAULT 'unauthorized'
                 CHECK (token_state IN ('unauthorized','healthy','expiring_soon','expired','revoked')),
  auth_fail_count INTEGER NOT NULL DEFAULT 0,
  last_ok_at     INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE TABLE emails (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  provider        TEXT CHECK (provider IS NULL OR provider IN ('gmail','outlook','imap','imported')),
  provider_msg_id TEXT NOT NULL,                  -- Gmail msg id / IMAP uid-as-string — per-account dedup
  message_id      TEXT,                            -- RFC 5322 Message-ID — cross-account dedup + deep links
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
CREATE INDEX idx_emails_msgid ON emails(message_id);
CREATE INDEX idx_emails_sent  ON emails(sent_at DESC);
CREATE INDEX idx_emails_thread ON emails(thread_id);

-- Match is its own row (v11 had it inline): ONE current match per email, with provenance to power the
-- suggest→confirm UI and never resurrect a dismissal. Pipeline rule (v11.48/64): only auto/manual may
-- elevate an application; suggested waits for a click; dismissed is never re-suggested.
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
