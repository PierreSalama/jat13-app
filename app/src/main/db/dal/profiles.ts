// profiles DAL — the multi-user root (learned memory, documents, applications all hang off a
// profile_id). NEW in the 13.1 tree: the old cb25d19 tree had no profiles table (its importer wrote
// raw rows); here the aggregate gets a real factory like everything else. data_json is ONE bounded
// JSON doc (identity + the 29 seed fields + work auth + salary target, <=256KB by CHECK) — heavy, so
// the LIST projection never ships it; get()/getDefault() hydrate it for the Profile page.
//
// Default law (mirrors documents): the partial unique index idx_profiles_default guarantees at most
// ONE is_default=1 row; create() makes the first profile the default, setDefault() swaps atomically.

import type { DalContext, LeanPage } from './index.js';
import { makeStmtCache, clampLimit } from './index.js';

// ---- caps (mirror the migration-001 CHECKs; reject loudly BEFORE SQLite does) ---------------------
const MAX_DATA_JSON = 262_144;
const MAX_ASSIGNMENTS_JSON = 2_048;

/** Lean list row — no data_json (the one heavy column on this table). */
export interface ProfileLean {
  id: string;
  name: string;
  is_default: boolean;
  created_at: number;
  updated_at: number;
}

/** Full hydrated profile — the Profile-page read. */
export interface ProfileRow extends ProfileLean {
  /** source keys this profile owns (v11 source_assignments semantics). */
  source_assignments: unknown[];
  /** identity + seed fields + work auth + salary target, as one structured doc. */
  data: Record<string, unknown>;
}

export interface CreateProfileInput {
  /** Caller-supplied id (the importer preserves v11 ids); omitted → prof_<ulid>. */
  id?: string;
  name: string;
  isDefault?: boolean;
  sourceAssignments?: unknown[];
  data?: Record<string, unknown>;
}

const LEAN_COLS = 'id, name, is_default, created_at, updated_at';
const FULL_COLS = 'id, name, is_default, source_assignments_json, data_json, created_at, updated_at';

interface LeanRow {
  id: string;
  name: string;
  is_default: number;
  created_at: number;
  updated_at: number;
}

interface FullRow extends LeanRow {
  source_assignments_json: string;
  data_json: string;
}

function toLean(r: LeanRow): ProfileLean {
  return {
    id: r.id,
    name: r.name,
    is_default: r.is_default === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Defensive parse (CHECK guarantees valid JSON on write; a read must still never crash). */
function parseArray(raw: string): unknown[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function hydrate(r: FullRow): ProfileRow {
  return {
    ...toLean(r),
    source_assignments: parseArray(r.source_assignments_json),
    data: parseObject(r.data_json),
  };
}

/** Serialize a JSON column value, throwing LOUDLY when it exceeds the schema cap — silently
 *  truncating structured JSON would corrupt it, and the CHECK would reject it anyway (opaquely). */
function serializeCapped(value: unknown, cap: number, what: string): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > cap) {
    throw new Error(`profiles.${what}: serialized JSON exceeds the ${cap}-byte schema cap`);
  }
  return json;
}

export function makeProfilesDal(ctx: DalContext) {
  const { db, now, newId, emit } = ctx;
  const stmt = makeStmtCache(db);

  function getFull(id: string): FullRow | undefined {
    return stmt(`SELECT ${FULL_COLS} FROM profiles WHERE id = ?`).get(id) as FullRow | undefined;
  }

  /** One profile, JSON columns hydrated. */
  function get(id: string): ProfileRow | undefined {
    const row = getFull(id);
    return row ? hydrate(row) : undefined;
  }

  /** THE default profile (single-profile installs live here), or undefined before first create. */
  function getDefault(): ProfileRow | undefined {
    const row = stmt(`SELECT ${FULL_COLS} FROM profiles WHERE is_default = 1`).get() as
      | FullRow
      | undefined;
    return row ? hydrate(row) : undefined;
  }

  /** Lean page of profiles, default first. Profiles are few — the cap is belt-and-braces. */
  function list(opts: { limit?: number } = {}): LeanPage<ProfileLean> {
    const limit = clampLimit(opts.limit, 100);
    const total = (stmt('SELECT COUNT(*) AS c FROM profiles').get() as { c: number }).c;
    const rows = stmt(
      `SELECT ${LEAN_COLS} FROM profiles ORDER BY is_default DESC, created_at ASC LIMIT ?`,
    ).all(limit) as LeanRow[];
    return { rows: rows.map(toLean), total };
  }

  /**
   * Create a profile. The FIRST profile always becomes the default (applications need a home);
   * isDefault=true on a later create swaps the default atomically (the partial unique index makes
   * two defaults structurally impossible, so the clear+set must share the transaction).
   */
  function create(input: CreateProfileInput): ProfileRow {
    const id = input.id ?? newId('prof');
    const t = now();
    const assignmentsJson = serializeCapped(
      input.sourceAssignments ?? [],
      MAX_ASSIGNMENTS_JSON,
      'create.sourceAssignments',
    );
    const dataJson = serializeCapped(input.data ?? {}, MAX_DATA_JSON, 'create.data');

    return db.transaction((): ProfileRow => {
      const hasAny = (stmt('SELECT COUNT(*) AS c FROM profiles').get() as { c: number }).c > 0;
      const wantDefault = input.isDefault === true || !hasAny;
      if (wantDefault && hasAny) {
        stmt('UPDATE profiles SET is_default = 0, updated_at = @t WHERE is_default = 1').run({ t });
      }
      stmt(
        `INSERT INTO profiles (id, name, is_default, source_assignments_json, data_json, created_at, updated_at)
         VALUES (@id, @name, @is_default, @assignments, @data, @t, @t)`,
      ).run({
        id,
        name: input.name,
        is_default: wantDefault ? 1 : 0,
        assignments: assignmentsJson,
        data: dataJson,
        t,
      });
      const row = hydrate(getFull(id)!);
      emit({
        table: 'profiles',
        op: 'insert',
        id,
        patch: { id: row.id, name: row.name, is_default: row.is_default, created_at: row.created_at, updated_at: row.updated_at },
      });
      return row;
    })();
  }

  /** Get-or-create the default profile — the importer/boot path when v11 had none. */
  function ensureDefault(name = 'Default'): ProfileRow {
    return db.transaction((): ProfileRow => {
      const existing = getDefault();
      if (existing) return existing;
      return create({ name, isDefault: true });
    })();
  }

  /** Swap the default to `id` atomically. Throws on an unknown profile. */
  function setDefault(id: string): ProfileRow {
    return db.transaction((): ProfileRow => {
      const row = getFull(id);
      if (!row) throw new Error(`profile not found: ${id}`);
      if (row.is_default === 1) return hydrate(row);
      const t = now();
      stmt('UPDATE profiles SET is_default = 0, updated_at = @t WHERE is_default = 1').run({ t });
      stmt('UPDATE profiles SET is_default = 1, updated_at = @t WHERE id = @id').run({ t, id });
      const updated = hydrate(getFull(id)!);
      emit({ table: 'profiles', op: 'update', id, patch: { id, is_default: true, updated_at: t } });
      return updated;
    })();
  }

  return { get, getDefault, list, create, ensureDefault, setDefault };
}

export type ProfilesDal = ReturnType<typeof makeProfilesDal>;
