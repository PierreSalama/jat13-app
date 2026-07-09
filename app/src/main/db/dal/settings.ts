// settings DAL — typed, per-key, registry-merged. The ONLY writer of the `settings` table.
//
// The v11 "stale saved blob shadows new defaults forever" bug is killed here structurally: nothing is
// stored per-SECTION. Each knob is its own (section,key) row and reads merge PER KEY over the registry
// default — an unstored key (including one registered AFTER the DB was written) always falls through to
// its code default with no migration. See app/src/main/settings/schema.ts for the registry + validator.

import type { DalContext } from '../dal/util.js';
import { makeStmtCache } from '../dal/util.js';
import {
  SETTINGS_REGISTRY,
  getSpec,
  hasSection,
  validate,
  type SettingsRegistry,
} from '../../settings/schema.js';

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

  // Parse a stored value_json defensively; on any corruption fall back to the caller's default.
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
      // JSON.stringify returns undefined for e.g. a bare function/undefined — validation should have
      // rejected these already, but never write a non-JSON value into a json_valid()-checked column.
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
    const byPair = new Map<string, string>();
    for (const r of stored) byPair.set(`${r.section}\u0000${r.key}`, r.value_json);

    const out: SettingsSnapshot = {};
    for (const section of Object.keys(registry)) {
      const specs = registry[section]!;
      const sectionOut: Record<string, unknown> = {};
      for (const key of Object.keys(specs)) {
        const def = specs[key]!.default;
        const raw = byPair.get(`${section}\u0000${key}`);
        sectionOut[key] = raw === undefined ? def : parseStored(raw, def);
      }
      out[section] = sectionOut;
    }
    return out;
  }

  return { getKey, get, set, all };
}
