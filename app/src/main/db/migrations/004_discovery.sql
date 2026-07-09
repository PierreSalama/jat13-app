-- Migration 004 — discovery (Pillar 4 §2.8). Job SOURCING: the tables that let v13 FIND postings itself
-- so the auto-apply queue has supply. House style throughout (STRICT, epoch-ms, CHECK-bounded, contiguous
-- NNN — 003_ledger was the prior highest).
--
-- The three v11 discovery scars this schema makes structurally impossible:
--   1. v11.83 STARVATION — a single shared "discovery refill gate" row let one source (the ATS feed)
--      starve another (LinkedIn). Here every lane is a `discovery_sources` row that owns ITS OWN pacing
--      gate + breaker + cursor. There is no shared row to fight over, so one lane can never starve another.
--   2. 12.8k empty `discovery_batch` rows/day — telemetry was O(scans). Here a CHECK forbids an 'ok' batch
--      with found_count=0, so an empty scan is UNWRITABLE; the service records nothing on a dry scan.
--   3. O(scans) provenance (26-37k `job_discovery_provenance` rows) — replaced by `job_sightings`, a
--      PK-deduped (job, source) table: re-seeing a job UPDATES a row, so it is O(jobs×sources), not O(scans).

-- One row per supply lane. Per-source gates (next_earliest_at pacing, cooldown_until breaker) and the
-- combo cursor LIVE HERE — a wedged / rate-limited lane sets its OWN cooldown and cannot block another.
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

-- The ATS company slugs to poll. Round-robin fairness = ORDER BY last_scan_at (never-scanned NULLs
-- sort first); a slug that 404s / returns empty 5× consecutively auto-retires (active=0) so dead
-- tokens stop wasting scans. Seed tokens ship as data (discovery/seed-tokens.json), upserted at boot.
CREATE TABLE company_tokens (
  id            TEXT PRIMARY KEY,              -- ctk_<ulid>
  ats           TEXT NOT NULL CHECK (ats IN ('greenhouse','lever','ashby')),
  token         TEXT NOT NULL CHECK (length(token) <= 128),
  company       TEXT CHECK (company IS NULL OR length(company) <= 256),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  added_by      TEXT NOT NULL DEFAULT 'seed' CHECK (added_by IN ('seed','learned','user')),
  verified_at   INTEGER,
  last_scan_at  INTEGER,
  last_yield_at INTEGER,
  dead_count    INTEGER NOT NULL DEFAULT 0 CHECK (dead_count >= 0),   -- >= 5 → active=0 (auto-retire)
  created_at    INTEGER NOT NULL,
  UNIQUE (ats, token)
) STRICT;
-- backs tokensDue(ats, limit): active tokens per ats, least-recently-scanned first.
CREATE INDEX idx_tokens_due ON company_tokens(ats, active, last_scan_at);

-- YIELD-ONLY telemetry, ring-buffered. INTEGER PK on purpose: nothing references batches (provenance is
-- job_sightings), so ring deletion is trivial + cheap. The CHECK makes an empty successful scan UNWRITABLE.
CREATE TABLE discovery_batches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id        TEXT NOT NULL,              -- no FK (plan §2.8): nothing needs to join back to a lane row
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
  -- STRUCTURAL: an empty successful scan cannot be recorded (kills the 12.8k-junk-rows/day bug).
  CHECK (status <> 'ok' OR found_count > 0)
) STRICT;
CREATE INDEX idx_batches_time ON discovery_batches(started_at DESC);
CREATE TRIGGER trg_batches_ring AFTER INSERT ON discovery_batches
BEGIN DELETE FROM discovery_batches WHERE id <= NEW.id - 5000; END;

-- Provenance: PK-deduped per (job, source). Re-seeing a job UPDATES last_seen/seen_count — O(jobs×sources)
-- rows max, never O(scans). WITHOUT ROWID: the composite PK IS the row (no rowid indirection).
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
