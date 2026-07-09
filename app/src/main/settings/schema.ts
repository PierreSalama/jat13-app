// The settings REGISTRY — the single source of truth for every user-tunable knob.
//
// Why this exists (the v11 bug it kills): v11 persisted a whole SECTION as one JSON blob and, on read,
// deepMerged the saved blob OVER the code defaults. A key added to the defaults LATER was always
// shadowed by the (key-less) saved blob — new defaults never appeared until the user re-saved. v12
// stores ONE ROW PER (section,key) and merges PER KEY: an unstored key always falls through to the
// registry default, so a newly-registered key is visible immediately with NO migration.
//
// This file is pure data + a pure validator (no db). The settings DAL binds to it.

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

// The starter set. EXTENSIBLE: append keys/sections freely — the DAL surfaces them through get()
// with zero migration, because merge is per-key against this map.
export const SETTINGS_REGISTRY = {
  autoApply: {
    keywords: {
      type: 'string[]',
      default: [] as string[],
      description: 'Search keywords the discovery + apply engine target.',
    },
    locations: {
      type: 'string[]',
      default: [] as string[],
      description: 'Location strings to search within.',
    },
    workModes: {
      type: 'string[]',
      default: ['remote', 'hybrid', 'onsite'] as string[],
      description: 'Acceptable work modes (subset of remote/hybrid/onsite).',
    },
    country: {
      type: 'string',
      default: 'Canada',
      description: 'Country gate for discovery + apply.',
    },
    seniorityMax: {
      type: 'enum',
      default: 'mid',
      enum: ['intern', 'entry', 'associate', 'mid', 'senior', 'lead', 'director'],
      description: 'Highest seniority level to apply to (ceiling).',
    },
    easyApplyOnly: {
      type: 'boolean',
      default: false,
      description: 'Restrict to one-click / Easy Apply postings only.',
    },
    maxPerDay: {
      type: 'number',
      default: 120,
      min: 0,
      max: 1000,
      description: 'Hard cap on submitted applications per calendar day.',
    },
    maxPerHour: {
      type: 'number',
      default: 20,
      min: 0,
      max: 500,
      description: 'Hard cap on submitted applications per rolling hour.',
    },
    aiAnswerConfidenceMin: {
      type: 'number',
      default: 0.7,
      min: 0,
      max: 1,
      description: 'Minimum AI answer confidence before auto-filling a screening question.',
    },
  },
  discovery: {
    enabled: {
      type: 'boolean',
      default: true,
      description: 'Whether the discovery engine runs.',
    },
    freshnessHours: {
      type: 'number',
      default: 72,
      min: 1,
      max: 720,
      description: 'Only consider postings first seen within this many hours.',
    },
  },
  ai: {
    codexModel: {
      type: 'string',
      default: 'gpt-5-codex',
      description: 'Codex CLI model id used for screening-answer fallback.',
    },
    enabled: {
      type: 'boolean',
      default: true,
      description: 'Whether AI answer synthesis is enabled at all.',
    },
  },
  gmail: {
    query: {
      type: 'string',
      default: 'newer_than:30d',
      description: 'Gmail search query the inbox pipeline fetches against.',
    },
    syncMinutes: {
      type: 'number',
      default: 15,
      min: 1,
      max: 1440,
      description: 'Minutes between Gmail inbox syncs.',
    },
  },
  appearance: {
    theme: {
      type: 'enum',
      default: 'aurora',
      enum: ['aurora', 'light', 'dark', 'system'],
      description: 'Renderer theme.',
    },
    themeId: {
      type: 'string',
      default: 'atelier',
      description: 'Free-form renderer theme id (Atelier theme registry — e.g. atelier, midnight, nord).',
    },
  },
  notifications: {
    onApply: {
      type: 'boolean',
      default: true,
      description: 'Native OS notification on every apply outcome.',
    },
    onNeedsYou: {
      type: 'boolean',
      default: true,
      description: 'Native OS notification when a run needs human attention.',
    },
  },
  maintenance: {
    backupDaily: {
      type: 'boolean',
      default: true,
      description: 'Take an automatic daily database backup.',
    },
  },
  goals: {
    dailyTarget: {
      type: 'number',
      default: 50,
      min: 0,
      max: 1000,
      description: 'Target number of applications per day (progress + goals UI).',
    },
  },
} satisfies SettingsRegistry;

export type RegistrySection = keyof typeof SETTINGS_REGISTRY;

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
  /** the coerced/accepted value when ok; untouched otherwise. */
  value?: unknown;
  /** human-readable reason when !ok, naming the offending section.key. */
  error?: string;
}

/**
 * Validate a candidate value for (section,key) against the registry spec.
 * Pure — no db, no throw. Returns {ok:false, error} on any mismatch (unknown key, wrong type,
 * bad enum, out-of-range number). The DAL turns a false result into a thrown Error.
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
