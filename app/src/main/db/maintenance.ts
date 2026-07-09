// Residual time-based maintenance (Pillar 4 §2.11). Deliberately SMALL: the schema's CHECK/trigger
// caps already bound every table by SIZE, so this only does the TIME-based cleanup SQL can't express
// structurally, plus WAL checkpoint / periodic VACUUM / online backup. Runs hourly + on quit.
//
// Forward-compatible: tables that arrive in later migrations (emails=003, discovery=002) are cleaned
// only once they exist (guarded by hasTable), so this file never needs editing when they land.
import type { Database } from 'better-sqlite3';
import { TERMINAL } from './dal/run-fsm.js';

/** Retention windows (days) — Pillar 4 §2.11 / master-plan C18. */
export const RETENTION = {
  stepsDays: 14, //     apply_run_steps of terminal runs
  staleJobDays: 45, //  jobs with no application activity go posting_state='stale'
  emailDays: 365, //    unmatched, non-dismissed emails (once the emails table exists)
  vacuumEveryDays: 3,
} as const;

const DAY_MS = 86_400_000;
const VACUUM_STAMP_KEY = 'maintenance.lastVacuumAt';

function hasTable(db: Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
      .get(name) !== undefined
  );
}

export interface MaintenanceReport {
  stepsDeleted: number;
  jobsStaled: number;
  emailsDeleted: number;
  vacuumed: boolean;
  checkpointed: boolean;
}

/**
 * Synchronous cleanup pass. `now` is injectable for deterministic tests.
 * VACUUM cannot run inside a transaction, so the deletes each run standalone (they are independently
 * safe/idempotent) and VACUUM runs last, outside any tx.
 */
export function runMaintenance(db: Database, now: number = Date.now()): MaintenanceReport {
  const report: MaintenanceReport = {
    stepsDeleted: 0,
    jobsStaled: 0,
    emailsDeleted: 0,
    vacuumed: false,
    checkpointed: false,
  };

  // 1. Steps of terminal runs older than the window (the transcript-bloat killer).
  const terminalPlaceholders = TERMINAL.map(() => '?').join(',');
  const stepCutoff = now - RETENTION.stepsDays * DAY_MS;
  report.stepsDeleted = db
    .prepare(
      `DELETE FROM apply_run_steps WHERE run_id IN (
         SELECT id FROM apply_runs
         WHERE state IN (${terminalPlaceholders}) AND finished_at IS NOT NULL AND finished_at < ?
       )`,
    )
    .run(...TERMINAL, stepCutoff).changes;

  // 2. Stale postings: not seen in 45d AND never had an application (a tracked/applied job is kept).
  const staleCutoff = now - RETENTION.staleJobDays * DAY_MS;
  report.jobsStaled = db
    .prepare(
      `UPDATE jobs SET posting_state='stale', updated_at=?
       WHERE posting_state='active' AND last_seen_at < ?
         AND id NOT IN (SELECT job_id FROM applications)`,
    )
    .run(now, staleCutoff).changes;

  // 3. Unmatched, non-dismissed emails past a year (only once migration 003 has created the tables).
  if (hasTable(db, 'emails') && hasTable(db, 'email_matches')) {
    const emailCutoff = now - RETENTION.emailDays * DAY_MS;
    report.emailsDeleted = db
      .prepare(
        `DELETE FROM emails
         WHERE created_at < ?
           AND id NOT IN (SELECT email_id FROM email_matches)`,
      )
      .run(emailCutoff).changes;
  }

  // 4. WAL checkpoint (truncate the WAL so it doesn't grow unbounded between runs).
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    report.checkpointed = true;
  } catch {
    /* checkpoint is best-effort; a busy reader just defers it */
  }

  // 5. VACUUM at most every N days (kv-stamped). Reclaims pages after the deletes above.
  const lastVacuum = Number(
    (db.prepare('SELECT value FROM kv WHERE key=?').get(VACUUM_STAMP_KEY) as { value: string } | undefined)?.value ??
      0,
  );
  if (now - lastVacuum >= RETENTION.vacuumEveryDays * DAY_MS) {
    db.exec('VACUUM'); // must be outside any transaction
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
      VACUUM_STAMP_KEY,
      String(now),
    );
    report.vacuumed = true;
  }

  return report;
}

/** Online, non-blocking backup (better-sqlite3 pages loop). Caller supplies the dated destination path. */
export async function backupOnline(db: Database, destPath: string): Promise<void> {
  await db.backup(destPath);
}
