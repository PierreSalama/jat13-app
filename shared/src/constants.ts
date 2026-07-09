// @jat13/shared — repo-wide constants. The ONE place ports/headers/identity live.
// Identity reserved in the 2026-07-03 vault decision; carried into the ground-up rebuild.

/** Wire protocol version — bumped on ANY breaking ext<->app message change; a mismatch
 *  surfaces a visible skew banner (failure mode #8) rather than a silent corruption. */
export const PROTOCOL_VERSION = 1 as const;

export const PORTS = {
  /** production app local server (Hono REST + /drive WebSocket) */
  app: 7860,
  /** dev identity, so `npm run dev` never collides with a prod install */
  dev: 7861,
} as const;

export const IDENTITY = {
  appId: 'com.pierre.jat13',
  productName: 'JAT 13',
  protocol: 'jat13',
  userData: 'jat13-app',
  userDataDev: 'jat13-app-dev',
  hotkey: 'Control+Shift+K',
  authHeader: 'X-JAT13-Token',
  wsPath: '/drive',
} as const;

/** electron-updater feed + adapter hot-fetch — the ONLY place v13 tags exist (never Job-ext-app). */
export const RELEASE = {
  repo: 'PierreSalama/jat13-app',
  adaptersRef: 'adapters-stable',
  adaptersIndexUrl:
    'https://raw.githubusercontent.com/PierreSalama/jat13-app/adapters-stable/adapters/index.json',
} as const;

/** apply-driving sources. Per-source lanes = independent gates/pacing/breakers (kills v11.83 starvation). */
export const SOURCES = ['linkedin', 'indeed', 'greenhouse', 'lever', 'ashby'] as const;
export type Source = (typeof SOURCES)[number];

/** scheduler lanes (a lane can carry >1 source; a wedged lane never starves another). */
export const LANES = ['linkedin', 'indeed', 'ats'] as const;
export type Lane = (typeof LANES)[number];

/** which lane drives which source. */
export const SOURCE_LANE: Record<Source, Lane> = {
  linkedin: 'linkedin',
  indeed: 'indeed',
  greenhouse: 'ats',
  lever: 'ats',
  ashby: 'ats',
};

/** LinkedIn enforces ~50 Easy-Applies / rolling 24h PER ACCOUNT. Ship 45 (tuned from the
 *  apply_ledger after 2 weeks). Parallelism can NEVER stack past this — it's a ledger cap. */
export const LINKEDIN_DAILY_CAP = 45 as const;

/** Snapshot/payload caps — enforced so a v11-style 16MB payload / 128KB snapshot is impossible. */
export const CAPS = {
  snapshotBytes: 128 * 1024,
  snapshotNodes: 400,
  patchFrameBytes: 4 * 1024,
  patchReplayRing: 500,
  listPayloadBytes: 64 * 1024,
} as const;

/** Human-wall timing (never solve captchas). Fast unattended park (~60s) vs v11's 6min. */
export const HUMAN_WALL = {
  selfClearMs: 12_000,
  presenceProbeMs: 30_000,
  unattendedParkMs: 60_000,
} as const;
