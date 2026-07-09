// answers DAL — the per-profile "ask-once-ever" memory (table: learned_answers). The answer-service
// builds an in-memory fuzzy index from snapshot(); the auto-apply engine consults lookup() before it
// ever asks the human. Binds to migration 001-core column names + CHECKs verbatim.
//
// SECURITY-CRITICAL: EEO / demographic / SSN / DOB / salary-history / criminal answers must NEVER be
// stored. record() DROPS them (returns null) before any INSERT — the drop is the first thing it does,
// so a sensitive value never reaches SQLite even transiently.

import type { DalContext, LeanPage } from './util.js';
import { makeStmtCache, clampLimit } from './util.js';
import { normKey, normQuestion } from '@jat13/shared/norm';

// ---- domain types ----------------------------------------------------------

export type AnswerKind = 'field' | 'qa';
export type FieldType = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'number' | 'date' | 'file';
export type Provenance = 'user' | 'harvest' | 'ai' | 'teach' | 'profile_push' | 'import_v11';

/** A learned answer row as returned by the DAL. `options` is parsed from options_json. */
export interface LearnedAnswer {
  id: string;
  profile_id: string;
  kind: AnswerKind;
  key_norm: string;
  label: string;
  locale: string;
  field_type: FieldType | null;
  value: string | null;
  options: string[] | null;
  confidence: number;
  provenance: Provenance;
  locked: boolean;
  seen_count: number;
  used_count: number;
  last_used_at: number | null;
  source_host: string | null;
  source_job_id: string | null;
  created_at: number;
  updated_at: number;
}

/** A lean list row — never carries the potentially-large `value`/`options` text (payload discipline). */
export interface LearnedAnswerLean {
  id: string;
  profile_id: string;
  kind: AnswerKind;
  key_norm: string;
  label: string;
  field_type: FieldType | null;
  confidence: number;
  provenance: Provenance;
  locked: boolean;
  seen_count: number;
  used_count: number;
  last_used_at: number | null;
  updated_at: number;
}

export interface RecordInput {
  kind: AnswerKind;
  label: string;
  value: string | null;
  /** Defaults to normQuestion(label) for kind='qa', normKey(label) for kind='field'. */
  keyNorm?: string;
  fieldType?: FieldType;
  options?: string[];
  confidence?: number;
  provenance?: Provenance;
  locked?: boolean;
  sourceHost?: string;
  sourceJobId?: string;
}

export interface ListInput {
  q?: string;
  kind?: AnswerKind;
  limit?: number;
  offset?: number;
}

// ---- provenance rank (high wins) -------------------------------------------
// The DB CHECK only enumerates the vocabulary; the ORDER of trust lives here. A higher-ranked write
// may overwrite a lower-ranked value; the reverse never does. `user` is the human's explicit truth.
const PROVENANCE_RANK: Readonly<Record<Provenance, number>> = {
  user: 6,
  teach: 5,
  profile_push: 4,
  import_v11: 3,
  ai: 2,
  harvest: 1,
};

function rankOf(p: string): number {
  return PROVENANCE_RANK[p as Provenance] ?? 0;
}

// ---- sensitive-key guard (SECURITY-CRITICAL) -------------------------------
// Refuse to store protected/demographic/regulated attributes: gender, race, ethnicity, disability,
// veteran status, sexual orientation, SSN / social security, date of birth / DOB, salary history,
// criminal / felony history.
//
// The guard is TOKEN-AWARE, not a phrase regex, because normQuestion() SORTS tokens and folds EN/FR
// (e.g. "date of birth" → "birth date", "social security number" → "number security social",
// "sexual orientation" → "orientation sexual"). A left-to-right phrase regex would miss all of those.
// So we (1) test single-word triggers against each token, and (2) test a few co-occurrence pairs where
// the concept is only sensitive when two tokens appear together (salary+history, social+security,
// birth+date). This also means a benign key like "salary expectations" (no "history") is NOT dropped.

/** Single normalized tokens that are sensitive on their own. */
const SENSITIVE_TOKENS = new Set([
  'gender',
  'race',
  'ethnic',
  'ethnicity',
  'disability',
  'disabled',
  'veteran',
  'ssn',
  'dob',
  'criminal',
  'felony',
  'felon',
]);

/** Substrings that flag a token (covers folded variants like "disabilities", "ethnicities"). */
const SENSITIVE_FRAGMENTS = ['ethnic', 'disab', 'veteran', 'felon'];

/** Concepts sensitive only when BOTH tokens co-occur (order-independent — normQuestion sorts). */
const SENSITIVE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['salary', 'history'],
  ['social', 'security'],
  ['birth', 'date'],
  ['sexual', 'orientation'],
];

/** True if a normalized key names a protected/demographic/regulated attribute we refuse to store. */
export function isSensitiveKey(keyNorm: string): boolean {
  const norm = String(keyNorm || '').toLowerCase();
  const tokens = norm.split(/[^a-z0-9]+/).filter(Boolean);
  const tokenSet = new Set(tokens);

  for (const t of tokens) {
    if (SENSITIVE_TOKENS.has(t)) return true;
    for (const frag of SENSITIVE_FRAGMENTS) if (t.includes(frag)) return true;
  }
  for (const [a, b] of SENSITIVE_PAIRS) {
    if (tokenSet.has(a) && tokenSet.has(b)) return true;
  }
  // "orientation" alone (sexual-orientation questions frequently drop the "sexual" filler token).
  if (tokenSet.has('orientation')) return true;
  return false;
}

// ---- explicit column lists (never SELECT *) --------------------------------
const FULL_COLS =
  'id, profile_id, kind, key_norm, label, locale, field_type, value, options_json, confidence, ' +
  'provenance, locked, seen_count, used_count, last_used_at, source_host, source_job_id, created_at, updated_at';

const LEAN_COLS =
  'id, profile_id, kind, key_norm, label, field_type, confidence, provenance, locked, ' +
  'seen_count, used_count, last_used_at, updated_at';

// ---- row shapes as they come back from SQLite (snake_case, ints for bools) -
interface FullRow {
  id: string;
  profile_id: string;
  kind: AnswerKind;
  key_norm: string;
  label: string;
  locale: string;
  field_type: FieldType | null;
  value: string | null;
  options_json: string | null;
  confidence: number;
  provenance: Provenance;
  locked: number;
  seen_count: number;
  used_count: number;
  last_used_at: number | null;
  source_host: string | null;
  source_job_id: string | null;
  created_at: number;
  updated_at: number;
}

interface LeanRow {
  id: string;
  profile_id: string;
  kind: AnswerKind;
  key_norm: string;
  label: string;
  field_type: FieldType | null;
  confidence: number;
  provenance: Provenance;
  locked: number;
  seen_count: number;
  used_count: number;
  last_used_at: number | null;
  updated_at: number;
}

/** Defensive parse: bad/oversized JSON never crashes a read — return null and move on. */
function parseOptions(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    return null;
  } catch {
    return null;
  }
}

function mapFull(r: FullRow): LearnedAnswer {
  return {
    id: r.id,
    profile_id: r.profile_id,
    kind: r.kind,
    key_norm: r.key_norm,
    label: r.label,
    locale: r.locale,
    field_type: r.field_type,
    value: r.value,
    options: parseOptions(r.options_json),
    confidence: r.confidence,
    provenance: r.provenance,
    locked: r.locked === 1,
    seen_count: r.seen_count,
    used_count: r.used_count,
    last_used_at: r.last_used_at,
    source_host: r.source_host,
    source_job_id: r.source_job_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function mapLean(r: LeanRow): LearnedAnswerLean {
  return {
    id: r.id,
    profile_id: r.profile_id,
    kind: r.kind,
    key_norm: r.key_norm,
    label: r.label,
    field_type: r.field_type,
    confidence: r.confidence,
    provenance: r.provenance,
    locked: r.locked === 1,
    seen_count: r.seen_count,
    used_count: r.used_count,
    last_used_at: r.last_used_at,
    updated_at: r.updated_at,
  };
}

export function makeAnswersDal(ctx: DalContext) {
  const stmt = makeStmtCache(ctx.db);

  function getById(id: string): LearnedAnswer | undefined {
    const row = stmt(`SELECT ${FULL_COLS} FROM learned_answers WHERE id = ?`).get(id) as FullRow | undefined;
    return row ? mapFull(row) : undefined;
  }

  /**
   * Record a learned answer. SECURITY: sensitive keys are DROPPED (return null, nothing inserted).
   * Upsert on UNIQUE(profile_id, kind, key_norm):
   *   - new key → insert (seen_count = 1).
   *   - existing key → seen_count++, and update the VALUE only if the incoming provenance rank is
   *     >= the existing rank AND the existing row is not locked. A locked row's value is immutable
   *     to anything but promoteToProfile()/an explicit user write.
   * The whole thing is one transaction (read-then-write on the unique key).
   */
  function record(profileId: string, input: RecordInput): LearnedAnswer | null {
    const keyNorm =
      input.keyNorm ?? (input.kind === 'qa' ? normQuestion(input.label) : normKey(input.label));

    // SECURITY-CRITICAL drop: never let a sensitive answer reach the DB.
    if (isSensitiveKey(keyNorm)) return null;

    const provenance: Provenance = input.provenance ?? 'harvest';
    const incomingRank = rankOf(provenance);
    const optionsJson = input.options !== undefined ? JSON.stringify(input.options) : null;
    const fieldType = input.fieldType ?? null;
    const confidence = typeof input.confidence === 'number' ? input.confidence : 0.5;
    const lockedIn = input.locked ? 1 : 0;
    const sourceHost = input.sourceHost ?? null;
    const sourceJobId = input.sourceJobId ?? null;

    const tx = ctx.db.transaction((): LearnedAnswer => {
      const existing = stmt(
        `SELECT ${FULL_COLS} FROM learned_answers WHERE profile_id = ? AND kind = ? AND key_norm = ?`,
      ).get(profileId, input.kind, keyNorm) as FullRow | undefined;
      const now = ctx.now();

      if (!existing) {
        const id = ctx.newId('ans');
        stmt(
          `INSERT INTO learned_answers
             (id, profile_id, kind, key_norm, label, field_type, value, options_json, confidence,
              provenance, locked, seen_count, used_count, source_host, source_job_id, created_at, updated_at)
           VALUES
             (@id, @profile_id, @kind, @key_norm, @label, @field_type, @value, @options_json, @confidence,
              @provenance, @locked, 1, 0, @source_host, @source_job_id, @created_at, @updated_at)`,
        ).run({
          id,
          profile_id: profileId,
          kind: input.kind,
          key_norm: keyNorm,
          label: input.label,
          field_type: fieldType,
          value: input.value,
          options_json: optionsJson,
          confidence,
          provenance,
          locked: lockedIn,
          source_host: sourceHost,
          source_job_id: sourceJobId,
          created_at: now,
          updated_at: now,
        });
        const created = getById(id)!;
        ctx.emit({ table: 'learned_answers', op: 'insert', id, patch: leanPatch(created) });
        return created;
      }

      // Conflict path: always bump seen_count. Overwrite the value/metadata only when the incoming
      // provenance is at least as trustworthy as what's stored AND the stored row isn't locked.
      const existingRank = rankOf(existing.provenance);
      const canOverwrite = !(existing.locked === 1) && incomingRank >= existingRank;

      if (canOverwrite) {
        stmt(
          `UPDATE learned_answers
              SET seen_count = seen_count + 1,
                  label = @label,
                  value = @value,
                  options_json = @options_json,
                  field_type = COALESCE(@field_type, field_type),
                  confidence = @confidence,
                  provenance = @provenance,
                  source_host = COALESCE(@source_host, source_host),
                  source_job_id = COALESCE(@source_job_id, source_job_id),
                  updated_at = @updated_at
            WHERE id = @id`,
        ).run({
          id: existing.id,
          label: input.label,
          value: input.value,
          options_json: optionsJson,
          field_type: fieldType,
          confidence,
          provenance,
          source_host: sourceHost,
          source_job_id: sourceJobId,
          updated_at: now,
        });
      } else {
        // Locked, or a lower-provenance write: preserve the stored value; only count the sighting.
        stmt(
          `UPDATE learned_answers SET seen_count = seen_count + 1, updated_at = @updated_at WHERE id = @id`,
        ).run({ id: existing.id, updated_at: now });
      }

      const updated = getById(existing.id)!;
      ctx.emit({ table: 'learned_answers', op: 'update', id: existing.id, patch: leanPatch(updated) });
      return updated;
    });

    return tx();
  }

  /** Exact-key lookup for one profile. undefined if not learned yet. */
  function lookup(profileId: string, keyNorm: string): LearnedAnswer | undefined {
    const row = stmt(
      `SELECT ${FULL_COLS} FROM learned_answers WHERE profile_id = ? AND key_norm = ? ORDER BY updated_at DESC LIMIT 1`,
    ).get(profileId, keyNorm) as FullRow | undefined;
    return row ? mapFull(row) : undefined;
  }

  /** Full answer by id (VALUE included) — the Profile page loads this on demand to view/edit an answer. */
  function get(id: string): LearnedAnswer | undefined {
    const row = stmt(`SELECT ${FULL_COLS} FROM learned_answers WHERE id = ?`).get(id) as FullRow | undefined;
    return row ? mapFull(row) : undefined;
  }

  /** Every row for a profile — the answer-service turns this into an in-memory fuzzy index. Full rows
   *  (values included) because the fuzzy matcher needs the value to return; bounded by profile size. */
  function snapshot(profileId: string): LearnedAnswer[] {
    const rows = stmt(
      `SELECT ${FULL_COLS} FROM learned_answers WHERE profile_id = ? ORDER BY updated_at DESC`,
    ).all(profileId) as FullRow[];
    return rows.map(mapFull);
  }

  /** Paged, LEAN list (no value/options text). Optional free-text (label/key) + kind filter. */
  function list(profileId: string, input: ListInput = {}): LeanPage<LearnedAnswerLean> {
    const limit = clampLimit(input.limit, 200);
    const offset = typeof input.offset === 'number' && input.offset > 0 ? Math.floor(input.offset) : 0;

    const where: string[] = ['profile_id = @profile_id'];
    const params: Record<string, unknown> = { profile_id: profileId };
    if (input.kind) {
      where.push('kind = @kind');
      params.kind = input.kind;
    }
    if (input.q && input.q.trim()) {
      where.push('(label LIKE @q OR key_norm LIKE @q)');
      params.q = `%${input.q.trim()}%`;
    }
    const whereSql = where.join(' AND ');

    const total = (
      stmt(`SELECT COUNT(*) AS c FROM learned_answers WHERE ${whereSql}`).get(params) as { c: number }
    ).c;

    const rows = stmt(
      `SELECT ${LEAN_COLS} FROM learned_answers WHERE ${whereSql}
       ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`,
    ).all({ ...params, limit, offset }) as LeanRow[];

    return { rows: rows.map(mapLean), total };
  }

  /** Promote a learned row to the human's own truth: lock it, stamp provenance=user. Idempotent. */
  function promoteToProfile(id: string): LearnedAnswer | undefined {
    const now = ctx.now();
    const info = stmt(
      `UPDATE learned_answers SET locked = 1, provenance = 'user', updated_at = ? WHERE id = ?`,
    ).run(now, id);
    if (info.changes === 0) return undefined;
    const row = getById(id)!;
    ctx.emit({ table: 'learned_answers', op: 'update', id, patch: leanPatch(row) });
    return row;
  }

  /** Count a successful use of this answer on a form (drives ranking + last-used recency). */
  function markUsed(id: string): LearnedAnswer | undefined {
    const now = ctx.now();
    const info = stmt(
      `UPDATE learned_answers SET used_count = used_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now, now, id);
    if (info.changes === 0) return undefined;
    const row = getById(id)!;
    ctx.emit({ table: 'learned_answers', op: 'update', id, patch: leanPatch(row) });
    return row;
  }

  return { record, lookup, get, snapshot, list, promoteToProfile, markUsed, isSensitiveKey };
}

// The lean patch a mutation broadcasts on the PatchBus: the changed row in its list shape (no value/
// options text). Returned as a plain Record so it satisfies DomainEvent.patch's index signature.
function leanPatch(a: LearnedAnswer): Record<string, unknown> {
  return {
    id: a.id,
    profile_id: a.profile_id,
    kind: a.kind,
    key_norm: a.key_norm,
    label: a.label,
    field_type: a.field_type,
    confidence: a.confidence,
    provenance: a.provenance,
    locked: a.locked,
    seen_count: a.seen_count,
    used_count: a.used_count,
    last_used_at: a.last_used_at,
    updated_at: a.updated_at,
  };
}
