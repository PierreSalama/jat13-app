// discovery DAL — the four §2.8 supply-lane tables (discovery_sources, company_tokens, discovery_batches,
// job_sightings). This is the anti-starvation surface: every lane is its OWN discovery_sources row with
// its OWN pacing gate + breaker + cursor, so nothing shared can let one lane starve another (v11.83).
//
// Two structural laws are enforced HERE in TypeScript, belt-to-the-DDL's-CHECK-suspenders:
//   1. recordBatch THROWS on a zero-yield 'ok' batch (the CHECK forbids it too — but a clear TS error at
//      the call site beats a raw SQLITE_CONSTRAINT from deep in a transaction). An empty scan records
//      NOTHING; the service simply never calls recordBatch on a dry scan.
//   2. tokenScanned auto-retires a token (active=0) after 5 consecutive dead scans, so the rotation stops
//      wasting slots on 404'd / removed company boards.
//
// snake_case DTOs (matching jobs/events), parameterized SQL only, prepared-statement cache per module,
// and a DomainEvent on every batch insert + source change (the single discovery.updated broadcast).

import type { DalContext } from './util.js';
import { makeStmtCache, clampLimit } from './util.js';

// ---- vocabularies (mirror the migration 004 CHECKs) ------------------------------------------------

export type Board = 'linkedin' | 'indeed' | 'greenhouse' | 'lever' | 'ashby';
export type SourceKind = 'jobspy' | 'extension_scrape' | 'ats_board';
/** the three public-JSON-board ATSes company_tokens tracks. */
export type Ats = 'greenhouse' | 'lever' | 'ashby';
export type BatchStatus = 'ok' | 'rate_limited' | 'error';

/** board → (deterministic source id, default kind). ids match the §2.8 examples ('src_gh' for greenhouse).
 *  The default kind is a starting point; sourceUpsert's patch can override it (other pillars own the
 *  linkedin/indeed lanes — this module ships the ats_board lanes). */
const BOARD_META: Record<Board, { id: string; kind: SourceKind }> = {
  linkedin: { id: 'src_linkedin', kind: 'extension_scrape' },
  indeed: { id: 'src_indeed', kind: 'jobspy' },
  greenhouse: { id: 'src_gh', kind: 'ats_board' },
  lever: { id: 'src_lever', kind: 'ats_board' },
  ashby: { id: 'src_ashby', kind: 'ats_board' },
};

/** consecutive dead (404/empty) scans before a token auto-retires. */
const DEAD_RETIRE_AT = 5;

// ---- DTOs ------------------------------------------------------------------------------------------

export interface DiscoverySource {
  id: string;
  board: Board;
  kind: SourceKind;
  enabled: number; // 0|1
  config: Record<string, unknown>; // parsed config_json
  cursor: Record<string, unknown>; // parsed cursor_json
  last_tick_at: number | null;
  next_earliest_at: number | null;
  cooldown_until: number | null;
  breaker_reason: string | null;
  updated_at: number;
}

/** Fields sourceUpsert will write when present. A key set to `null` clears the column; an ABSENT key is
 *  left untouched (the presence test is `key in patch`, exactly like jobs.patch's whitelist). */
export interface SourcePatch {
  kind?: SourceKind;
  enabled?: number;
  config?: Record<string, unknown>;
  cursor?: Record<string, unknown>;
  last_tick_at?: number | null;
  next_earliest_at?: number | null;
  cooldown_until?: number | null;
  breaker_reason?: string | null;
}

export interface CompanyToken {
  id: string;
  ats: Ats;
  token: string;
  company: string | null;
  active: number;
  added_by: string;
  verified_at: number | null;
  last_scan_at: number | null;
  last_yield_at: number | null;
  dead_count: number;
  created_at: number;
}

export interface TokenInput {
  ats: Ats;
  token: string;
  company?: string | null;
  addedBy?: 'seed' | 'learned' | 'user';
}

export interface DiscoveryBatch {
  id: number;
  source_id: string;
  company_token_id: string | null;
  keyword: string | null;
  location: string | null;
  status: BatchStatus;
  found_count: number;
  accepted_count: number;
  duplicate_count: number;
  rejected_count: number;
  error: string | null;
  started_at: number;
  completed_at: number | null;
}

export interface RecordBatchInput {
  sourceId: string;
  companyTokenId?: string | null;
  keyword?: string | null;
  location?: string | null;
  status: BatchStatus;
  found?: number;
  accepted?: number;
  duplicate?: number;
  rejected?: number;
  error?: string | null;
  startedAt?: number;
  completedAt?: number | null;
}

export interface SightingInput {
  jobId: string;
  sourceId: string;
  applyCapability?: string;
  rawUrl?: string | null;
}

export interface LaneStat {
  source_id: string;
  board: Board;
  kind: SourceKind;
  enabled: boolean;
  last_tick_at: number | null;
  next_earliest_at: number | null;
  cooldown_until: number | null;
  breaker_reason: string | null;
  tokens_total: number;
  tokens_active: number;
  batches_24h: number;
  found_24h: number;
  accepted_24h: number;
  sightings_total: number;
}

// ---- raw-row shapes + parsers ----------------------------------------------------------------------

interface SourceRow {
  id: string;
  board: Board;
  kind: SourceKind;
  enabled: number;
  config_json: string;
  cursor_json: string;
  last_tick_at: number | null;
  next_earliest_at: number | null;
  cooldown_until: number | null;
  breaker_reason: string | null;
  updated_at: number;
}

/** Never throws on a read: a corrupt JSON column (impossible under the CHECK, but defensive) → {}. */
function parseObj(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toSource(row: SourceRow): DiscoverySource {
  return {
    id: row.id,
    board: row.board,
    kind: row.kind,
    enabled: row.enabled,
    config: parseObj(row.config_json),
    cursor: parseObj(row.cursor_json),
    last_tick_at: row.last_tick_at,
    next_earliest_at: row.next_earliest_at,
    cooldown_until: row.cooldown_until,
    breaker_reason: row.breaker_reason,
    updated_at: row.updated_at,
  };
}

const SOURCE_COLS =
  'id, board, kind, enabled, config_json, cursor_json, last_tick_at, next_earliest_at, ' +
  'cooldown_until, breaker_reason, updated_at';

const TOKEN_COLS =
  'id, ats, token, company, active, added_by, verified_at, last_scan_at, last_yield_at, dead_count, created_at';

export function makeDiscoveryDal(ctx: DalContext) {
  const { db, now, newId, emit } = ctx;
  const stmt = makeStmtCache(db);

  const sourceRow = (board: Board): SourceRow | undefined =>
    stmt(`SELECT ${SOURCE_COLS} FROM discovery_sources WHERE board = ?`).get(board) as
      | SourceRow
      | undefined;

  // ---- sources -------------------------------------------------------------------------------------

  function sourceGet(board: Board): DiscoverySource | undefined {
    const row = sourceRow(board);
    return row ? toSource(row) : undefined;
  }

  function listSources(): DiscoverySource[] {
    return (
      stmt(`SELECT ${SOURCE_COLS} FROM discovery_sources ORDER BY board`).all() as SourceRow[]
    ).map(toSource);
  }

  /**
   * Ensure the lane row for `board` exists and apply any patch. First call INSERTs (deriving the
   * deterministic id + default kind from BOARD_META); later calls UPDATE only the columns present in
   * `patch`. Always bumps updated_at. Emits a DomainEvent so the SSE layer can push the lane change.
   */
  function sourceUpsert(board: Board, patch: SourcePatch = {}): DiscoverySource {
    const meta = BOARD_META[board];
    const ts = now();
    const existing = sourceRow(board);

    if (!existing) {
      stmt(
        `INSERT INTO discovery_sources
           (id, board, kind, enabled, config_json, cursor_json, last_tick_at, next_earliest_at,
            cooldown_until, breaker_reason, updated_at)
         VALUES (@id, @board, @kind, @enabled, @config, @cursor, @lastTick, @nextEarliest,
            @cooldown, @breaker, @ts)`,
      ).run({
        id: meta.id,
        board,
        kind: patch.kind ?? meta.kind,
        enabled: patch.enabled ?? 1,
        config: JSON.stringify(patch.config ?? {}),
        cursor: JSON.stringify(patch.cursor ?? {}),
        lastTick: patch.last_tick_at ?? null,
        nextEarliest: patch.next_earliest_at ?? null,
        cooldown: patch.cooldown_until ?? null,
        breaker: patch.breaker_reason ?? null,
        ts,
      });
      const created = toSource(sourceRow(board)!);
      emit({ table: 'discovery_sources', op: 'insert', id: created.id, patch: { ...created } });
      return created;
    }

    // UPDATE only the whitelisted columns actually present in the patch (absent key = leave column as-is;
    // a key set to null CLEARS the column — that distinction is what lets the service clear a breaker).
    const sets: string[] = ['updated_at = @ts'];
    const bind: Record<string, unknown> = { id: existing.id, ts };
    if ('kind' in patch) { sets.push('kind = @kind'); bind.kind = patch.kind; }
    if ('enabled' in patch) { sets.push('enabled = @enabled'); bind.enabled = patch.enabled; }
    if ('config' in patch) { sets.push('config_json = @config'); bind.config = JSON.stringify(patch.config ?? {}); }
    if ('cursor' in patch) { sets.push('cursor_json = @cursor'); bind.cursor = JSON.stringify(patch.cursor ?? {}); }
    if ('last_tick_at' in patch) { sets.push('last_tick_at = @lastTick'); bind.lastTick = patch.last_tick_at ?? null; }
    if ('next_earliest_at' in patch) { sets.push('next_earliest_at = @nextEarliest'); bind.nextEarliest = patch.next_earliest_at ?? null; }
    if ('cooldown_until' in patch) { sets.push('cooldown_until = @cooldown'); bind.cooldown = patch.cooldown_until ?? null; }
    if ('breaker_reason' in patch) { sets.push('breaker_reason = @breaker'); bind.breaker = patch.breaker_reason ?? null; }

    stmt(`UPDATE discovery_sources SET ${sets.join(', ')} WHERE id = @id`).run(bind);
    const updated = toSource(sourceRow(board)!);
    emit({ table: 'discovery_sources', op: 'update', id: updated.id, patch: { ...updated } });
    return updated;
  }

  // ---- company tokens ------------------------------------------------------------------------------

  /**
   * The next `limit` active tokens for an ATS, least-recently-scanned first (never-scanned NULLs sort
   * ahead of any scanned token, then oldest last_scan_at), tie-broken by created_at for a stable
   * round-robin. This IS the fairness rotation — every active token gets polled before any is re-polled.
   */
  function tokensDue(ats: Ats, limit: number): CompanyToken[] {
    const n = clampLimit(limit, 10, 200);
    return stmt(
      `SELECT ${TOKEN_COLS} FROM company_tokens
        WHERE ats = @ats AND active = 1
        ORDER BY last_scan_at ASC, created_at ASC
        LIMIT @n`,
    ).all({ ats, n }) as CompanyToken[];
  }

  /** Insert a token if (ats, token) is new; otherwise leave the existing row untouched (ON CONFLICT DO
   *  NOTHING — a re-seed never clobbers a token's learned scan history). Returns whether it inserted. */
  function tokenUpsert(input: TokenInput): { inserted: boolean; id: string } {
    const existing = stmt('SELECT id FROM company_tokens WHERE ats = ? AND token = ?').get(
      input.ats,
      input.token,
    ) as { id: string } | undefined;
    if (existing) return { inserted: false, id: existing.id };
    const id = newId('ctk');
    stmt(
      `INSERT INTO company_tokens (id, ats, token, company, active, added_by, dead_count, created_at)
       VALUES (@id, @ats, @token, @company, 1, @addedBy, 0, @ts)
       ON CONFLICT (ats, token) DO NOTHING`,
    ).run({
      id,
      ats: input.ats,
      token: input.token,
      company: input.company ?? null,
      addedBy: input.addedBy ?? 'seed',
      ts: now(),
    });
    return { inserted: true, id };
  }

  /** Bulk-seed tokens in one transaction (ON CONFLICT DO NOTHING). Returns the count actually inserted. */
  function seedTokens(tokens: readonly TokenInput[]): number {
    const run = db.transaction((list: readonly TokenInput[]): number => {
      let inserted = 0;
      for (const t of list) if (tokenUpsert(t).inserted) inserted += 1;
      return inserted;
    });
    return run(tokens);
  }

  /**
   * Record the outcome of scanning a token. Always stamps last_scan_at. On a yield, refreshes
   * last_yield_at and RESETS dead_count. On a dry scan, increments dead_count and — once it hits
   * DEAD_RETIRE_AT consecutive dead scans — flips active=0 so the rotation stops polling a dead board.
   */
  function tokenScanned(id: string, opts: { yielded: boolean }): void {
    const ts = now();
    if (opts.yielded) {
      stmt(
        `UPDATE company_tokens SET last_scan_at = @ts, last_yield_at = @ts, dead_count = 0 WHERE id = @id`,
      ).run({ id, ts });
      return;
    }
    stmt(
      `UPDATE company_tokens SET
         last_scan_at = @ts,
         dead_count = dead_count + 1,
         active = CASE WHEN dead_count + 1 >= @retire THEN 0 ELSE active END
       WHERE id = @id`,
    ).run({ id, ts, retire: DEAD_RETIRE_AT });
  }

  // ---- batches (yield-only telemetry) --------------------------------------------------------------

  /**
   * Insert one telemetry batch. THROWS on a zero-yield 'ok' batch (belt to the CHECK's suspenders) — an
   * empty scan must record NOTHING, so the service never calls this on a dry scan. 'rate_limited' /
   * 'error' batches with found_count 0 are legitimate (a breaker trip is worth one diagnostic row).
   * Emits the DomainEvent that becomes the single discovery.updated broadcast (empty scans → no emit).
   */
  function recordBatch(input: RecordBatchInput): DiscoveryBatch {
    const found = input.found ?? 0;
    if (input.status === 'ok' && found <= 0) {
      throw new Error(
        'discovery.recordBatch: refusing a zero-yield ok batch — an empty scan must record nothing',
      );
    }
    const startedAt = input.startedAt ?? now();
    const info = stmt(
      `INSERT INTO discovery_batches
         (source_id, company_token_id, keyword, location, status, found_count, accepted_count,
          duplicate_count, rejected_count, error, started_at, completed_at)
       VALUES (@sourceId, @companyTokenId, @keyword, @location, @status, @found, @accepted,
          @duplicate, @rejected, @error, @startedAt, @completedAt)`,
    ).run({
      sourceId: input.sourceId,
      companyTokenId: input.companyTokenId ?? null,
      keyword: input.keyword ?? null,
      location: input.location ?? null,
      status: input.status,
      found,
      accepted: input.accepted ?? 0,
      duplicate: input.duplicate ?? 0,
      rejected: input.rejected ?? 0,
      error: input.error ?? null,
      startedAt,
      completedAt: input.completedAt ?? now(),
    });
    const id = Number(info.lastInsertRowid);
    const row = stmt(
      `SELECT id, source_id, company_token_id, keyword, location, status, found_count, accepted_count,
              duplicate_count, rejected_count, error, started_at, completed_at
         FROM discovery_batches WHERE id = ?`,
    ).get(id) as DiscoveryBatch;
    emit({ table: 'discovery_batches', op: 'insert', id: String(id), patch: { ...row } });
    return row;
  }

  // ---- provenance (job_sightings, PK-deduped) ------------------------------------------------------

  /**
   * Record that `sourceId` saw `jobId`. First sight inserts (seen_count 1); a re-sight bumps last_seen_at
   * + seen_count and refreshes the raw_url/capability — O(jobs×sources) rows, never O(scans).
   */
  function recordSighting(input: SightingInput): void {
    const ts = now();
    stmt(
      `INSERT INTO job_sightings
         (job_id, source_id, apply_capability, raw_url, first_seen_at, last_seen_at, seen_count)
       VALUES (@jobId, @sourceId, @cap, @rawUrl, @ts, @ts, 1)
       ON CONFLICT (job_id, source_id) DO UPDATE SET
         last_seen_at = @ts,
         seen_count = seen_count + 1,
         apply_capability = excluded.apply_capability,
         raw_url = COALESCE(excluded.raw_url, job_sightings.raw_url)`,
    ).run({
      jobId: input.jobId,
      sourceId: input.sourceId,
      cap: input.applyCapability ?? 'unknown',
      rawUrl: input.rawUrl ?? null,
      ts,
    });
  }

  // ---- stats (per-lane rollup for /api/discovery/status) -------------------------------------------

  function stats(): LaneStat[] {
    const sources = listSources();
    const since = now() - 86_400_000;

    const tokenAgg = stmt(
      'SELECT ats, COUNT(*) AS total, SUM(active) AS active FROM company_tokens GROUP BY ats',
    ).all() as { ats: Ats; total: number; active: number }[];
    const tokensByAts = new Map(tokenAgg.map((r) => [r.ats, r]));

    const batchAgg = stmt(
      `SELECT source_id,
              COUNT(*) AS batches,
              COALESCE(SUM(found_count), 0) AS found,
              COALESCE(SUM(accepted_count), 0) AS accepted
         FROM discovery_batches WHERE started_at > @since GROUP BY source_id`,
    ).all({ since }) as { source_id: string; batches: number; found: number; accepted: number }[];
    const batchBySource = new Map(batchAgg.map((r) => [r.source_id, r]));

    const sightAgg = stmt(
      'SELECT source_id, COUNT(*) AS c FROM job_sightings GROUP BY source_id',
    ).all() as { source_id: string; c: number }[];
    const sightBySource = new Map(sightAgg.map((r) => [r.source_id, r.c]));

    return sources.map((s) => {
      const tok = (s.board === 'greenhouse' || s.board === 'lever' || s.board === 'ashby')
        ? tokensByAts.get(s.board)
        : undefined;
      const b = batchBySource.get(s.id);
      return {
        source_id: s.id,
        board: s.board,
        kind: s.kind,
        enabled: s.enabled === 1,
        last_tick_at: s.last_tick_at,
        next_earliest_at: s.next_earliest_at,
        cooldown_until: s.cooldown_until,
        breaker_reason: s.breaker_reason,
        tokens_total: tok?.total ?? 0,
        tokens_active: tok?.active ?? 0,
        batches_24h: b?.batches ?? 0,
        found_24h: b?.found ?? 0,
        accepted_24h: b?.accepted ?? 0,
        sightings_total: sightBySource.get(s.id) ?? 0,
      };
    });
  }

  return {
    sourceGet,
    sourceUpsert,
    listSources,
    tokensDue,
    tokenUpsert,
    seedTokens,
    tokenScanned,
    recordBatch,
    recordSighting,
    stats,
  };
}

export type DiscoveryDal = ReturnType<typeof makeDiscoveryDal>;
