// settings DAL — typed, per-key, registry-merged. The ONLY writer of the `settings` table.
//
// The v11 "stale saved blob shadows new defaults forever" bug is killed here structurally: nothing
// is stored per-SECTION. Each knob is its own (section,key) row and reads merge PER KEY over the
// registry default — an unstored key (including one registered AFTER the DB was written) always
// falls through to its code default with no migration. A stored row whose key is no longer (or was
// never) registered is simply invisible — junk in the table cannot shadow the registry.
//
// The REGISTRY lives in this file for Stage 0 (three knobs). It is pure data + a pure validator;
// when it grows past a screenful, split it to app/src/main/settings/schema.ts (the old tree's
// shape) and re-export from here — the DAL surface doesn't change.
//
// Module note: imports from './index.js' form a benign ESM cycle (index → settings → index); only
// hoisted function declarations + erased types cross it, nothing at module-evaluation time.

import type { DalContext } from './index.js';
import { makeStmtCache } from './index.js';

// ---- the registry (single source of truth for every user-tunable knob) ---------------------------

export type SettingType = 'string' | 'number' | 'boolean' | 'string[]' | 'enum';

/** One registered knob. `default` is the code default merged in when nothing is stored. */
export interface SettingSpec {
  readonly type: SettingType;
  readonly default: unknown;
  /** numbers: inclusive bound. */
  readonly min?: number;
  readonly max?: number;
  /** enum: the allowed string values (required when type==='enum'). */
  readonly enum?: readonly string[];
  readonly description: string;
}

export type SettingsSection = Record<string, SettingSpec>;
export type SettingsRegistry = Record<string, SettingsSection>;

// Stage-0 starter set. EXTENSIBLE: append keys/sections freely as stages land — the DAL surfaces
// them through get() with zero migration, because merge is per-key against this map.
export const SETTINGS_REGISTRY = {
  appearance: {
    themeId: {
      type: 'string',
      default: 'atelier',
      description: 'Atelier renderer theme id (theme registry — e.g. atelier).',
    },
  },
  notifications: {
    onApply: {
      type: 'boolean',
      default: true,
      description: 'Native OS notification on every apply outcome.',
    },
  },
  maintenance: {
    backupDaily: {
      type: 'boolean',
      default: true,
      description: 'Take an automatic daily database backup.',
    },
  },
} satisfies SettingsRegistry;

/** Look up a spec, or undefined if the (section,key) pair is not registered. */
export function getSpec(section: string, key: string): SettingSpec | undefined {
  const sec = (SETTINGS_REGISTRY as SettingsRegistry)[section];
  if (!sec) return undefined;
  return sec[key];
}

/** True when the section name is registered. */
export function hasSection(section: string): boolean {
  return Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY, section);
}

export interface ValidateResult {
  ok: boolean;
  /** the accepted value when ok; untouched otherwise. */
  value?: unknown;
  /** human-readable reason when !ok, naming the offending section.key. */
  error?: string;
}

/**
 * Validate a candidate value for (section,key) against the registry spec.
 * Pure — no db, no throw. Returns {ok:false, error} on any mismatch (unknown key, wrong type,
 * bad enum, out-of-range number). The DAL turns a false result into a thrown Error — writes are
 * loud-on-unknown; reads fall through to defaults.
 */
export function validate(section: string, key: string, value: unknown): ValidateResult {
  const spec = getSpec(section, key);
  if (!spec) {
    return { ok: false, error: `unknown setting: ${section}.${key}` };
  }
  const where = `${section}.${key}`;
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') return { ok: false, error: `${where} must be a string` };
      return { ok: true, value };
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return { ok: false, error: `${where} must be a boolean` };
      return { ok: true, value };
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: `${where} must be a finite number` };
      }
      if (spec.min !== undefined && value < spec.min) {
        return { ok: false, error: `${where} must be >= ${spec.min}` };
      }
      if (spec.max !== undefined && value > spec.max) {
        return { ok: false, error: `${where} must be <= ${spec.max}` };
      }
      return { ok: true, value };
    }
    case 'enum': {
      if (typeof value !== 'string') return { ok: false, error: `${where} must be a string (enum)` };
      const allowed = spec.enum ?? [];
      if (!allowed.includes(value)) {
        return { ok: false, error: `${where} must be one of: ${allowed.join(', ')}` };
      }
      return { ok: true, value };
    }
    case 'string[]': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        return { ok: false, error: `${where} must be an array of strings` };
      }
      return { ok: true, value };
    }
    default: {
      // exhaustiveness guard — a new SettingType must extend this switch.
      return { ok: false, error: `${where} has an unsupported type` };
    }
  }
}

// ---- the DAL --------------------------------------------------------------------------------------

/** The settings table caps value_json at 16384 chars (migration 001 CHECK); reject before we hit it. */
const MAX_VALUE_JSON = 16384;

interface SettingRow {
  section: string;
  key: string;
  value_json: string;
}

/** Nested {section: {key: value}} view. */
export type SettingsSnapshot = Record<string, Record<string, unknown>>;

export function makeSettingsDal(ctx: DalContext) {
  const stmt = makeStmtCache(ctx.db);
  const registry = SETTINGS_REGISTRY as SettingsRegistry;

  // Parse a stored value_json defensively; on any corruption fall back to the registry default.
  function parseStored(raw: string, fallback: unknown): unknown {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return fallback;
    }
  }

  function readRow(section: string, key: string): SettingRow | undefined {
    return stmt('SELECT section, key, value_json FROM settings WHERE section = ? AND key = ?').get(
      section,
      key,
    ) as SettingRow | undefined;
  }

  /** stored value merged over the registry default; registry default when nothing is stored.
   *  Throws Error naming the key when (section,key) is not registered. */
  function getKey(section: string, key: string): unknown {
    const spec = getSpec(section, key);
    if (!spec) {
      throw new Error(`unknown setting: ${section}.${key}`);
    }
    const row = readRow(section, key);
    if (!row) return spec.default;
    return parseStored(row.value_json, spec.default);
  }

  /** every registered key in the section = stored-or-default. Throws when the section is unknown. */
  function get(section: string): Record<string, unknown> {
    if (!hasSection(section)) {
      throw new Error(`unknown settings section: ${section}`);
    }
    const specs = registry[section]!;
    // one query for the section, then merge per key so unstored keys fall through to defaults.
    const stored = stmt('SELECT section, key, value_json FROM settings WHERE section = ?').all(
      section,
    ) as SettingRow[];
    const byKey = new Map<string, string>();
    for (const r of stored) byKey.set(r.key, r.value_json);

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(specs)) {
      const def = specs[key]!.default;
      const raw = byKey.get(key);
      out[key] = raw === undefined ? def : parseStored(raw, def);
    }
    return out;
  }

  /** validate against the registry, then upsert value_json + schema_version + updated_at. Emits.
   *  Throws Error naming the offending key on unknown/invalid/oversized values. */
  function set(section: string, key: string, value: unknown): void {
    const result = validate(section, key, value);
    if (!result.ok) {
      // validate() already names section.key in its message.
      throw new Error(result.error ?? `invalid setting: ${section}.${key}`);
    }
    const accepted = result.value;
    const valueJson = JSON.stringify(accepted);
    if (valueJson === undefined) {
      // JSON.stringify returns undefined for e.g. a bare function — validation should have rejected
      // these already, but never write a non-JSON value into a json_valid()-checked column.
      throw new Error(`setting ${section}.${key} is not JSON-serializable`);
    }
    if (valueJson.length > MAX_VALUE_JSON) {
      throw new Error(
        `setting ${section}.${key} exceeds ${MAX_VALUE_JSON} chars when serialized (${valueJson.length})`,
      );
    }
    const now = ctx.now();
    stmt(
      `INSERT INTO settings (section, key, value_json, schema_version, updated_at)
       VALUES (@section, @key, @value_json, 1, @updated_at)
       ON CONFLICT(section, key) DO UPDATE SET
         value_json = excluded.value_json,
         schema_version = excluded.schema_version,
         updated_at = excluded.updated_at`,
    ).run({ section, key, value_json: valueJson, updated_at: now });

    ctx.emit({
      table: 'settings',
      op: 'update',
      id: `${section}.${key}`,
      patch: { section, key, value: accepted, updated_at: now },
    });
  }

  /** the full nested view: every registered key in every section, stored-or-default. */
  function all(): SettingsSnapshot {
    const stored = stmt('SELECT section, key, value_json FROM settings').all() as SettingRow[];
    // '::' separator: registry sections/keys are plain identifiers, so composite keys never collide.
    const byPair = new Map<string, string>();
    for (const r of stored) byPair.set(r.section + '::' + r.key, r.value_json);

    const out: SettingsSnapshot = {};
    for (const section of Object.keys(registry)) {
      const specs = registry[section]!;
      const sectionOut: Record<string, unknown> = {};
      for (const key of Object.keys(specs)) {
        const def = specs[key]!.default;
        const raw = byPair.get(section + '::' + key);
        sectionOut[key] = raw === undefined ? def : parseStored(raw, def);
      }
      out[section] = sectionOut;
    }
    return out;
  }

  return { getKey, get, set, all };
}
