-- Migration 003 — apply_ledger (Pillar 3 §2.3). ONE row per REAL submit, per source/account. This is
-- the AUTHORITY for the rolling per-account cap (LinkedIn ~50/24h → we budget 45). The cap check reads
-- THIS table, never worker slots — so parallelism can never stack past the account limit (v11 lockout
-- lesson). The full multi-lane scheduler (concurrency/breakers/pacing, task #4) builds on this.
CREATE TABLE apply_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  source       TEXT NOT NULL,
  account_key  TEXT NOT NULL DEFAULT 'default',   -- reserved for future multi-account
  submitted_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_ledger_window ON apply_ledger(source, account_key, submitted_at);
