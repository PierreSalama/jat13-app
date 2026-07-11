// dismissals DAL — Pierre's #1 scar, made structural (migration 002_dismiss-and-track-gate).
//
// THE SCAR (2026-07-10): v11 tracked pages that were NOT jobs, and DISMISSING one did not stick — it
// came back on the very next sighting. The fix is PERMANENCE by identity, not by row: dismissing a job
// writes ALL THREE dedup identities a re-sighting could ever arrive under
//   'nk:'||norm_key  |  'url:'||job_url_norm  |  'co:'||company_key
// so a re-post that lands on a fresh job row (new id, slightly different url) still resolves to the same
// dismissal. EVERY ingest path (the extension /track route AND every discovery lane) MUST call
// isDismissed() BEFORE creating or reviving a job — a dismissed posting can never return.
//
// dismiss() ALSO stamps jobs.dismissed_at (hides the specific row + funnel-excludes it) and withdraws
// its live application(s). The block is permanent + idempotent: keys are INSERT OR IGNORE, so
// re-dismissing is a harmless no-op and the block never weakens.
//
// House rules honored: this is a db/dal/ module, so raw SQL lives here by design (the grep-gate that
// forbids SQL elsewhere covers app/src outside db/dal/); binds to migration 001+002 columns verbatim;
// reads the STORED dedup keys off the jobs row (never recomputes them) so the dismissal keys are
// exactly what a future re-sighting would dedup to.

import type { DalContext, LeanPage } from './index.js';
import { makeStmtCache, clampLimit, clampOffset } from './index.js';

// ---- vocabulary (binds to the dismissals.reason CHECK in migration 002) ---------------------------
export type DismissReason = 'user' | 'not_a_job' | 'spam' | 'irrelevant' | 'off_target';
const DISMISS_REASONS: ReadonlySet<string> = new Set<DismissReason>([
  'user', 'not_a_job', 'spam', 'irrelevant', 'off_target',
]);

/** note is capped at 512 by the DDL; we slice defensively so a long paste never trips the CHECK. */
const NOTE_MAX = 512;

/** The three dedup identities a re-sighting can arrive under. Any present → dismissed. Callers pass
 *  whichever they have; empty/undefined values are ignored (never blocks on a bare 'url:'/'co:'). */
export interface DismissKeys {
  normKey?: string;
  urlNorm?: string;
  companyKey?: string;
}

export interface DismissOptions {
  reason?: DismissReason;
  note?: string | null;
}

export interface DismissResult {
  dismissed: boolean;
  jobId: string;
  /** the dismiss_keys written (or that already existed) — 'nk:'/'url:'/'co:' prefixed. */
  keys: string[];
  reason: DismissReason;
}

/** listRecent row — ONE entry per dismissed job (its 3 keys collapse), joined to the posting for display. */
export interface DismissalLean {
  job_id: string | null;
  reason: DismissReason;
  note: string | null;
  dismissed_at: number;
  key_count: number;
  job_title: string | null;
  company: string | null;
}

/** The stored dedup keys we read off the jobs row to build the dismissal. */
interface JobKeysRow {
  norm_key: string;
  job_url_norm: string;
  company_key: string;
}

/** Accept a job id OR a row-ish object with an id — the route passes an id; a caller holding a row may
 *  pass it. The dedup KEYS are always read fresh from the DB (authoritative), never taken from the arg. */
function resolveJobId(job: string | { id: string }): string {
  return typeof job === 'string' ? job : job.id;
}

export function makeDismissalsDal(ctx: DalContext) {
  const { db, now, emit } = ctx;
  const stmt = makeStmtCache(db);

  /**
   * PERMANENTLY dismiss a job. Writes every non-empty dedup identity into `dismissals` (INSERT OR
   * IGNORE — idempotent), stamps jobs.dismissed_at, and withdraws + un-flags its live application(s).
   * Returns null when the job id is unknown (the route maps that to a 404). One transaction: the block,
   * the hide, and the withdraw are all-or-nothing.
   */
  function dismiss(job: string | { id: string }, opts: DismissOptions = {}): DismissResult | null {
    const jobId = resolveJobId(job);
    const reason: DismissReason = opts.reason ?? 'user';
    if (!DISMISS_REASONS.has(reason)) {
      throw new Error(
        `dismissals.dismiss: unknown reason '${String(reason)}' (must be one of ${[...DISMISS_REASONS].join(', ')})`,
      );
    }
    const note = opts.note === undefined || opts.note === null ? null : String(opts.note).slice(0, NOTE_MAX);

    return db.transaction((): DismissResult | null => {
      const row = stmt(
        `SELECT norm_key, job_url_norm, company_key FROM jobs WHERE id = ?`,
      ).get(jobId) as JobKeysRow | undefined;
      if (!row) return null;

      const ts = now();
      // Only NON-EMPTY keys are written — a bare 'url:' or 'co:' would collide across unrelated jobs.
      const keys: string[] = [];
      if (row.norm_key) keys.push('nk:' + row.norm_key);
      if (row.job_url_norm) keys.push('url:' + row.job_url_norm);
      if (row.company_key) keys.push('co:' + row.company_key);

      const insKey = stmt(
        `INSERT OR IGNORE INTO dismissals (dismiss_key, job_id, reason, note, dismissed_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const k of keys) insKey.run(k, jobId, reason, note, ts);

      // hide the specific row (funnel + views filter on dismissed_at).
      stmt(`UPDATE jobs SET dismissed_at = ? WHERE id = ?`).run(ts, jobId);

      // withdraw + un-flag the LIVE application(s); already-terminal rows (hired/rejected/withdrawn/
      // ghosted) are left untouched so a dismissal never rewrites settled history.
      const liveClause =
        `job_id = ? AND status NOT IN ('hired','rejected','withdrawn','ghosted')`;
      const affected = stmt(`SELECT id FROM applications WHERE ${liveClause}`).all(jobId) as {
        id: string;
      }[];
      stmt(
        `UPDATE applications SET status = 'withdrawn', needs_review = 0, updated_at = ? WHERE ${liveClause}`,
      ).run(ts, jobId);

      // live-UI patches (no-op until a consumer subscribes) — partial patches, never a refetch trigger.
      emit({ table: 'jobs', op: 'update', id: jobId, patch: { id: jobId, dismissed_at: ts } });
      for (const a of affected) {
        emit({
          table: 'applications',
          op: 'update',
          id: a.id,
          patch: { id: a.id, status: 'withdrawn', needs_review: 0, updated_at: ts },
        });
      }

      return { dismissed: true, jobId, keys, reason };
    })();
  }

  /**
   * THE ingest gate: is any of these identities dismissed? Called BEFORE creating/reviving a job on
   * every ingest path (/track + every discovery lane). Empty/undefined keys are skipped; no key given
   * → false (a caller with nothing to check never blocks). One indexed IN-lookup over the PK.
   */
  function isDismissed(keys: DismissKeys): boolean {
    const candidates: string[] = [];
    if (keys.normKey) candidates.push('nk:' + keys.normKey);
    if (keys.urlNorm) candidates.push('url:' + keys.urlNorm);
    if (keys.companyKey) candidates.push('co:' + keys.companyKey);
    if (candidates.length === 0) return false;
    const placeholders = candidates.map(() => '?').join(', ');
    const hit = stmt(
      `SELECT 1 AS x FROM dismissals WHERE dismiss_key IN (${placeholders}) LIMIT 1`,
    ).get(...candidates);
    return hit !== undefined;
  }

  /**
   * Recent dismissals for the "recently dismissed" surface — ONE row per dismissed job (its keys
   * collapse via GROUP BY), newest-first, joined to the posting for a human label. Keyless entries
   * (job_id NULL, e.g. a future manual key block) group by their own key. Payload-capped like every list.
   */
  function listRecent(opts: { limit?: number; offset?: number } = {}): LeanPage<DismissalLean> {
    const limit = clampLimit(opts.limit, 100);
    const offset = clampOffset(opts.offset);
    const rows = stmt(
      `SELECT d.job_id                       AS job_id,
              d.reason                       AS reason,
              d.note                         AS note,
              MAX(d.dismissed_at)            AS dismissed_at,
              COUNT(*)                       AS key_count,
              j.title                        AS job_title,
              j.company                      AS company
         FROM dismissals d
         LEFT JOIN jobs j ON j.id = d.job_id
        GROUP BY COALESCE(d.job_id, d.dismiss_key)
        ORDER BY dismissed_at DESC, job_id DESC
        LIMIT ? OFFSET ?`,
    ).all(limit, offset) as DismissalLean[];
    const total = (
      stmt(`SELECT COUNT(DISTINCT COALESCE(job_id, dismiss_key)) AS c FROM dismissals`).get() as {
        c: number;
      }
    ).c;
    return { rows, total };
  }

  return { dismiss, isDismissed, listRecent };
}

export type DismissalsDal = ReturnType<typeof makeDismissalsDal>;
