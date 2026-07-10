// @jat13/shared — the ONE place identity lives (ports, product name, header, storage keys).
// Scar (v13.0.1): sw.ts hardcoded port 7860 while the popup paired on dev 7861 — the SW dialed
// prod, pairing looked dead. Zero hardcoded identity anywhere else, ever; grep-gates reject
// identity/port literals outside this file (postmortem rule 7).

/** Wire protocol version — bumped on ANY breaking ext<->app message change; a mismatch
 *  surfaces a visible skew banner rather than a silent corruption. */
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
  /** Electron userData dir names — dev is split so a dev session never touches the prod DB. */
  userData: 'jat13-app',
  userDataDev: 'jat13-app-dev',
  hotkey: 'Control+Shift+K',
  /** loopback auth header; every REST/ws request carries the paired token under this name. */
  authHeader: 'X-JAT13-Token',
  /** WebSocket upgrade path on the app server. */
  wsPath: '/drive',
} as const;

/** chrome.storage.local keys the extension persists pairing under. The popup writes BOTH at
 *  pair time (token + the port it actually paired on) and the SW reads them — never PORTS
 *  directly (that is exactly the wrong-port scar above). */
export const STORAGE_KEYS = {
  token: 'jat13Token',
  port: 'jat13Port',
} as const;

/** electron-updater feed — the ONLY place v13 tags exist (never Job-ext-app / v11 repos).
 *  Adapter hot-fetch refs return with the adapter-lifecycle stage; nothing dormant ships. */
export const RELEASE = {
  repo: 'PierreSalama/jat13-app',
} as const;
