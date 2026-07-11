// Stage-3 settings registry: the auto-apply ENGINE dials + the DISCOVERY controls.
//
// These two sections live here (the old tree's app/src/main/settings/ home) instead of swelling
// db/dal/settings.ts; that file imports them into SETTINGS_REGISTRY, so the DAL stays the ONE settings
// writer/validator and reads/writes merge per-key over these defaults with ZERO migration (the v11
// "stale saved blob shadows new defaults forever" class is impossible — engine-knowledge §1.7).
//
// DESIGN LAW (research/engine-knowledge.md §1.7 + reference_jat_autoapply_engine): over-restrictive
// USER filters are the #1 throughput loss ("seniorityMax entry + easyApplyOnly off" starved v11). So
// every default below is deliberately PERMISSIVE — an EMPTY keyword/location/workMode list means
// "don't filter on this axis"; the caps are a SOFT ceiling only (apply_ledger stays the single HARD
// per-account authority, §2.2); easyApplyOnly keeps the PROVEN hands-off baseline (LinkedIn Easy
// Apply + Indeed smartapply + ATS forms — greenhouse/lever/ashby are easy-apply-eligible, §1.7 —
// while the external/account-wall flood that cratered the 2026-07-04 overnight run stays excluded).

import type { SettingsSection } from '../db/dal/settings.js';

/** Seniority ceiling to INCLUDE. 'any' disables the cap (widest). Default 'mid' (Stage-3 plan);
 *  'entry' was the single biggest v11 throughput loss, so it is never the default. */
export const SENIORITY_LEVELS = ['entry', 'mid', 'senior', 'lead', 'any'] as const;
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];

/** Work modes mirror jobs.work_mode (migration 001). An EMPTY selection = all three (permissive). */
export const WORK_MODES = ['remote', 'hybrid', 'onsite'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

/** section `autoApply` — the engine's user-facing dials. */
export const AUTO_APPLY_SECTION = {
  keywords: {
    type: 'string[]',
    default: [],
    description:
      'Positive title keywords to search for and keep. Empty = broad (the engine derives targets from your profile). A positive keyword gate is what stops ATS boards flooding the queue with unrelated roles (§1.11).',
  },
  locations: {
    type: 'string[]',
    default: [],
    description: 'Target locations. Empty = country-wide plus generic-remote (permissive positive location gate).',
  },
  country: {
    type: 'string',
    default: 'Canada',
    description: 'Country scope for every board URL builder — the North-York-PENNSYLVANIA scar (§1.14).',
  },
  workModes: {
    type: 'string[]',
    default: [],
    description: 'Allowed work modes (remote / hybrid / onsite). Empty = all three.',
  },
  seniorityMax: {
    type: 'enum',
    enum: SENIORITY_LEVELS,
    default: 'mid',
    description: 'Highest seniority to include. "any" turns the cap off. (An "entry" cap was the #1 v11 throughput loss.)',
  },
  maxPerDay: {
    type: 'number',
    default: 120,
    min: 1,
    max: 500,
    description: 'SOFT daily apply ceiling across all lanes. apply_ledger is the HARD per-account authority (§2.2).',
  },
  maxPerHour: {
    type: 'number',
    default: 40,
    min: 1,
    max: 200,
    description: 'SOFT hourly burst ceiling. Per-lane pacing (LinkedIn sits ~30/hr, §2.1) throttles below this.',
  },
  fitFloor: {
    type: 'number',
    default: 30,
    min: 0,
    max: 100,
    description: 'Skip any job whose fit score is below this. Set 0 to disable; every skip is shown with its reason (§ locked-decision 6).',
  },
  easyApplyOnly: {
    type: 'boolean',
    default: true,
    description:
      'Only the easy-apply subset: LinkedIn Easy Apply, Indeed smartapply, and account-free ATS forms (greenhouse/lever/ashby). Excludes the external/Workday/aggregator flood — the proven hands-off baseline (§2.4).',
  },
} satisfies SettingsSection;

/** section `discovery` — the four-source supply engine's user-facing switches. */
export const DISCOVERY_SECTION = {
  enabled: {
    type: 'boolean',
    default: true,
    description: 'Run discovery (all four sources, per-lane source-scoped gates). Off = apply only from what is already saved.',
  },
  freshnessHours: {
    type: 'number',
    default: 72,
    min: 1,
    max: 720,
    description: 'Starting freshness window for the ramp (72h → 30d). Saturated combos widen the window automatically (§1.3/§1.4).',
  },
} satisfies SettingsSection;
