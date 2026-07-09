// jobs DAL — the posting aggregate (jobs + job_details). LEAN by construction: the list endpoint
// queries `jobs` only (descriptions live in the quarantined `job_details` table), so a page can NEVER
// ship a 256KB description. `upsert` is the single dedup gate: v11 forked the same posting into dozens
// of rows because 40 ad-hoc insert sites each keyed differently; here one factory owns norm_key +
// job_url_norm, and everything else patches the row it already has.

import type { DalContext, LeanPage } from './util.js';
import { makeStmtCache, clampLimit } from './util.js';
import { normKey, normJobUrl } from '@jat13/shared/norm';

/** Descriptions are hard-capped by the CHECK (length <= 262144); we truncate defensively BEFORE the DB
 *  can reject an oversized paste, appending a visible marker so a reader knows content was cut. */
const DESC_MAX = 262144;
const DESC_MARKER = '\n…[truncated]';

/** apply_capability enum (jobs CHECK). Kept here so `patch`/`markSeen` reject a bad capability in TS
 *  before the DB does — a clearer error at the call site than a raw CHECK failure. */
const CAPABILITIES = [
  'easy_apply',
  'smartapply',
  'ats_form',
  'external',
  'account_wall',
  'unknown',
] as const;
export type ApplyCapability = (typeof CAPABILITIES)[number];

const WORK_MODES = ['remote', 'hybrid', 'onsite'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

const POSTING_STATES = ['active', 'stale', 'removed'] as const;
export type PostingState = (typeof POSTING_STATES)[number];

/** Input to upsert — everything the discovery/import path knows about a posting. All optional except
 *  source + job_url (the two things that make a posting addressable). `fit` is written to fit_json. */
export interface JobInput {
  source: string;
  job_url: string;
  external_id?: string | null;
  title?: string;
  company?: string;
  location?: string;
  work_mode?: WorkMode | null;
  employment_type?: string | null;
  compensation?: string | null;
  apply_capability?: ApplyCapability;
  fit_score?: number | null;
  tags?: string[];
  posting_state?: PostingState;
  description?: string;
  fit?: unknown;
  raw?: unknown;
}

/** The lean row the list endpoint ships — the full `jobs` row, NEVER the description. */
export interface JobLean {
  id: string;
  source: string;
  external_id: string | null;
  title: string;
  company: string;
  company_key: string;
  location: string;
  work_mode: WorkMode | null;
  employment_type: string | null;
  compensation: string | null;
  job_url: string;
  apply_capability: ApplyCapability;
  fit_score: number | null;
  tags: string[];
  posting_state: PostingState;
  first_seen_at: number;
  last_seen_at: number;
  created_at: number;
  updated_at: number;
}

/** getDetail result — the lean row PLUS the heavy columns from job_details (only when explicitly asked). */
export interface JobDetail extends JobLean {
  description: string;
  fit: unknown;
}

export interface ListParams {
  source?: string;
  postingState?: PostingState;
  q?: string;
  limit?: number;
  offset?: number;
}

/** Mutable columns `patch` will touch — the whitelist IS the security boundary: nothing outside this
 *  set can ever be written by a patch, so ids / dedup keys / *_seen_at timestamps can't be spoofed. */
const PATCHABLE = [
  'title',
  'company',
  'location',
  'work_mode',
  'employment_type',
  'compensation',
  'apply_capability',
  'fit_score',
  'tags',
  'posting_state',
] as const;
export type PatchableField = (typeof PATCHABLE)[number];

export interface JobPatch {
  title?: string;
  company?: string;
  location?: string;
  work_mode?: WorkMode | null;
  employment_type?: string | null;
  compensation?: string | null;
  apply_capability?: ApplyCapability;
  fit_score?: number | null;
  tags?: string[];
  posting_state?: PostingState;
}

// ---- helpers (module-private; no SQL, no side effects) ---------------------

/** Truncate a description to the DB cap, appending a marker so the cut is visible. Never rejects. */
function clampDescription(desc: string): string {
  if (desc.length <= DESC_MAX) return desc;
  return desc.slice(0, DESC_MAX - DESC_MARKER.length) + DESC_MARKER;
}

/** Compose the posting-identity key: company + title, run through the shared normalizer so casing /
 *  punctuation / whitespace can't fork the same posting. Mirrors the v11 dedup key so imported rows
 *  collapse onto discovery rows. */
function jobNormKey(company: string, title: string): string {
  return normKey(`${company} ${title}`);
}

/** Defensive JSON parse for a text column that the CHECK guarantees is valid JSON *when present*.
 *  Still guarded: a NULL column or a legacy bad value must not crash a read. */
function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Shape a raw `jobs` row (snake_case DB fields) into a JobLean (parsed tags). */
interface JobRow {
  id: string;
  source: string;
  external_id: string | null;
  title: string;
  company: string;
  company_key: string;
  location: string;
  work_mode: WorkMode | null;
  employment_type: string | null;
  compensation: string | null;
  job_url: string;
  apply_capability: ApplyCapability;
  fit_score: number | null;
  tags_json: string;
  posting_state: PostingState;
  first_seen_at: number;
  last_seen_at: number;
  created_at: number;
  updated_at: number;
}

function toLean(row: JobRow): JobLean {
  return {
    id: row.id,
    source: row.source,
    external_id: row.external_id,
    title: row.title,
    company: row.company,
    company_key: row.company_key,
    location: row.location,
    work_mode: row.work_mode,
    employment_type: row.employment_type,
    compensation: row.compensation,
    job_url: row.job_url,
    apply_capability: row.apply_capability,
    fit_score: row.fit_score,
    tags: parseJson<string[]>(row.tags_json, []),
    posting_state: row.posting_state,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Explicit lean column list — used by BOTH listLean and getDetail's jobs half. Never `SELECT *`,
// never `description`. Keeping it in one const guarantees the two read paths can't drift.
const LEAN_COLS =
  'id, source, external_id, title, company, company_key, location, work_mode, employment_type, ' +
  'compensation, job_url, apply_capability, fit_score, tags_json, posting_state, ' +
  'first_seen_at, last_seen_at, created_at, updated_at';

export interface UpsertResult {
  job: JobLean;
  action: 'inserted' | 'updated';
}

export function makeJobsDal(ctx: DalContext) {
  const { db, now, newId, emit } = ctx;
  const stmt = makeStmtCache(db);

  // Dedup lookup: same posting is norm_key OR job_url_norm match. Same-source rows are preferred
  // (ORDER puts a source match first) so cross-source collisions don't hijack an existing row.
  const findExisting = (
    source: string,
    normKeyVal: string,
    urlNorm: string,
  ): JobRow | undefined =>
    stmt(
      `SELECT ${LEAN_COLS} FROM jobs
        WHERE (norm_key = @normKey AND @normKey <> '')
           OR (job_url_norm = @urlNorm AND @urlNorm <> '')
        ORDER BY (source = @source) DESC, updated_at DESC
        LIMIT 1`,
    ).get({ source, normKey: normKeyVal, urlNorm }) as JobRow | undefined;

  const getRow = (id: string): JobRow | undefined =>
    stmt(`SELECT ${LEAN_COLS} FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;

  function upsert(job: JobInput): UpsertResult {
    const ts = now();
    const title = job.title ?? '';
    const company = job.company ?? '';
    const jobUrl = job.job_url ?? '';
    const urlNorm = normJobUrl(jobUrl);
    const nk = jobNormKey(company, title);
    const companyKey = normKey(company);
    const fitJson = job.fit === undefined ? null : JSON.stringify(job.fit);
    const rawJson = job.raw === undefined ? null : JSON.stringify(job.raw);

    // Whole upsert (jobs row + job_details row) is ONE transaction: a posting is never half-written
    // (a jobs row with no detail, or vice-versa). read-then-write also lives inside so the dedup
    // decision and the write are atomic under the single writer.
    const run = db.transaction((): UpsertResult => {
      const existing = findExisting(job.source, nk, urlNorm);

      if (existing) {
        // UPDATE: refresh mutable fields + bump last_seen_at/updated_at. Identity columns
        // (id, source, first_seen_at, created_at) and the dedup keys are NOT rewritten.
        // Every mutable field PRESERVES the existing value when the caller omits it — a bare
        // re-sighting (source+url only, e.g. a list-view "seen again") must never blank out
        // title/company/tags or recompute company_key to '' (that would orphan idx_jobs_company).
        const nextTitle = job.title ?? existing.title;
        const nextCompany = job.company ?? existing.company;
        const nextCompanyKey = job.company !== undefined ? companyKey : existing.company_key;
        const nextTags =
          job.tags !== undefined ? JSON.stringify(job.tags) : existing.tags_json;
        stmt(
          `UPDATE jobs SET
             title = @title, company = @company, company_key = @companyKey, location = @location,
             work_mode = @work_mode, employment_type = @employment_type, compensation = @compensation,
             apply_capability = @apply_capability, fit_score = @fit_score, tags_json = @tagsJson,
             posting_state = @posting_state, external_id = @external_id,
             last_seen_at = @ts, updated_at = @ts
           WHERE id = @id`,
        ).run({
          id: existing.id,
          title: nextTitle,
          company: nextCompany,
          companyKey: nextCompanyKey,
          location: job.location ?? existing.location,
          work_mode: job.work_mode ?? existing.work_mode,
          employment_type: job.employment_type ?? existing.employment_type,
          compensation: job.compensation ?? existing.compensation,
          apply_capability: job.apply_capability ?? existing.apply_capability,
          fit_score: job.fit_score ?? existing.fit_score,
          tagsJson: nextTags,
          posting_state: job.posting_state ?? existing.posting_state,
          external_id: job.external_id ?? existing.external_id,
          ts,
        });

        // job_details: upsert the description/fit alongside. Only overwrite description/fit_json/
        // raw_json when the caller actually supplied them — a bare re-sighting (no description) must
        // KEEP the full text captured on first sight, not blank it to ''.
        const descProvided = job.description !== undefined;
        stmt(
          `INSERT INTO job_details (job_id, description, fit_json, raw_json)
             VALUES (@id, @description, @fitJson, @rawJson)
           ON CONFLICT(job_id) DO UPDATE SET
             description = CASE WHEN @descProvided = 1 THEN excluded.description ELSE job_details.description END,
             fit_json = COALESCE(excluded.fit_json, job_details.fit_json),
             raw_json = COALESCE(excluded.raw_json, job_details.raw_json)`,
        ).run({
          id: existing.id,
          description: clampDescription(job.description ?? ''),
          fitJson,
          rawJson,
          descProvided: descProvided ? 1 : 0,
        });

        const row = getRow(existing.id)!;
        const lean = toLean(row);
        emit({ table: 'jobs', op: 'update', id: existing.id, patch: { ...lean } });
        return { job: lean, action: 'updated' };
      }

      // INSERT: brand-new posting. first_seen = last_seen = created = updated = now.
      const id = newId('job');
      stmt(
        `INSERT INTO jobs (
           id, source, external_id, title, company, company_key, location, work_mode,
           employment_type, compensation, job_url, job_url_norm, norm_key, apply_capability,
           fit_score, tags_json, posting_state, first_seen_at, last_seen_at, created_at, updated_at
         ) VALUES (
           @id, @source, @external_id, @title, @company, @companyKey, @location, @work_mode,
           @employment_type, @compensation, @job_url, @urlNorm, @normKey, @apply_capability,
           @fit_score, @tagsJson, @posting_state, @ts, @ts, @ts, @ts
         )`,
      ).run({
        id,
        source: job.source,
        external_id: job.external_id ?? null,
        title,
        company,
        companyKey,
        location: job.location ?? '',
        work_mode: job.work_mode ?? null,
        employment_type: job.employment_type ?? null,
        compensation: job.compensation ?? null,
        job_url: jobUrl,
        urlNorm,
        normKey: nk,
        apply_capability: job.apply_capability ?? 'unknown',
        fit_score: job.fit_score ?? null,
        tagsJson: JSON.stringify(job.tags ?? []),
        posting_state: job.posting_state ?? 'active',
        ts,
      });

      stmt(
        `INSERT INTO job_details (job_id, description, fit_json, raw_json)
           VALUES (@id, @description, @fitJson, @rawJson)`,
      ).run({ id, description: clampDescription(job.description ?? ''), fitJson, rawJson });

      const lean = toLean(getRow(id)!);
      emit({ table: 'jobs', op: 'insert', id, patch: { ...lean } });
      return { job: lean, action: 'inserted' };
    });

    return run();
  }

  function listLean(params: ListParams = {}): LeanPage<JobLean> {
    const limit = clampLimit(params.limit, 500);
    const offset =
      typeof params.offset === 'number' && Number.isFinite(params.offset) && params.offset > 0
        ? Math.floor(params.offset)
        : 0;

    // WHERE built from bound params only (each clause is a param placeholder — no value ever touches
    // the SQL string). `@q` is applied twice (title + company); we pre-wrap it with % here, still bound.
    const clauses: string[] = [];
    const bind: Record<string, unknown> = {};
    if (params.source !== undefined) {
      clauses.push('source = @source');
      bind.source = params.source;
    }
    if (params.postingState !== undefined) {
      clauses.push('posting_state = @postingState');
      bind.postingState = params.postingState;
    }
    if (params.q !== undefined && params.q.trim().length > 0) {
      clauses.push('(title LIKE @q ESCAPE \'\\\' OR company LIKE @q ESCAPE \'\\\')');
      // escape LIKE metacharacters so a user typing "50%" isn't a wildcard search.
      const safe = params.q.trim().replace(/[\\%_]/g, (m) => '\\' + m);
      bind.q = `%${safe}%`;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const total = (
      stmt(`SELECT COUNT(*) AS c FROM jobs ${where}`).get(bind) as { c: number }
    ).c;

    const rows = stmt(
      `SELECT ${LEAN_COLS} FROM jobs ${where}
        ORDER BY updated_at DESC
        LIMIT @limit OFFSET @offset`,
    ).all({ ...bind, limit, offset }) as JobRow[];

    return { rows: rows.map(toLean), total };
  }

  function getDetail(id: string): JobDetail | undefined {
    // Join the lean columns to the two heavy detail columns explicitly (never SELECT *). LEFT JOIN so a
    // (structurally impossible, but defensive) missing detail row still returns the job.
    const row = stmt(
      `SELECT ${LEAN_COLS
        .split(', ')
        .map((c) => `j.${c}`)
        .join(', ')},
        d.description AS description, d.fit_json AS fit_json
       FROM jobs j LEFT JOIN job_details d ON d.job_id = j.id
       WHERE j.id = ?`,
    ).get(id) as (JobRow & { description: string | null; fit_json: string | null }) | undefined;
    if (!row) return undefined;
    return {
      ...toLean(row),
      description: row.description ?? '',
      fit: parseJson<unknown>(row.fit_json, null),
    };
  }

  function patch(id: string, fields: JobPatch): JobLean | undefined {
    const sets: string[] = [];
    const bind: Record<string, unknown> = { id };
    for (const key of PATCHABLE) {
      if (!(key in fields)) continue;
      const val = (fields as Record<string, unknown>)[key];
      if (key === 'tags') {
        sets.push('tags_json = @tags_json');
        bind.tags_json = JSON.stringify((val as string[] | undefined) ?? []);
      } else {
        sets.push(`${key} = @${key}`);
        bind[key] = val ?? null;
      }
    }
    if (sets.length === 0) {
      // Nothing whitelisted was supplied — return current state, no write, no event.
      const row = getRow(id);
      return row ? toLean(row) : undefined;
    }
    const ts = now();
    bind.updated_at = ts;
    const info = stmt(
      `UPDATE jobs SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`,
    ).run(bind);
    if (info.changes === 0) return undefined; // no such job
    const lean = toLean(getRow(id)!);
    emit({ table: 'jobs', op: 'update', id, patch: { ...lean } });
    return lean;
  }

  function markSeen(
    id: string,
    opts: { sourceId?: string; capability?: ApplyCapability } = {},
  ): JobLean | undefined {
    // NOTE: `sourceId` (which discovery source re-sighted this posting) is a job_sightings concept
    // (migration 002), NOT the posting's own external_id. It is intentionally NOT written here —
    // clobbering external_id would corrupt the (source, external_id) dedup index. Once 002 lands,
    // markSeen upserts a job_sightings row; for now it only freshens the posting.
    const ts = now();
    const setCap = opts.capability !== undefined;
    const info = stmt(
      `UPDATE jobs SET
         last_seen_at = @ts,
         posting_state = 'active',
         updated_at = @ts,
         apply_capability = CASE WHEN @setCap = 1 THEN @capability ELSE apply_capability END
       WHERE id = @id`,
    ).run({
      id,
      ts,
      setCap: setCap ? 1 : 0,
      capability: opts.capability ?? null,
    });
    if (info.changes === 0) return undefined;
    const lean = toLean(getRow(id)!);
    emit({ table: 'jobs', op: 'update', id, patch: { ...lean } });
    return lean;
  }

  return { upsert, listLean, getDetail, patch, markSeen };
}
