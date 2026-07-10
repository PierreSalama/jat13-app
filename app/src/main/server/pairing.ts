// Loopback pairing token. The app mints ONE token (sealed via the secrets DAL), and the extension
// popup fetches it from the loopback-only /api/pair/token endpoint on a user click. Because the
// server binds 127.0.0.1 only, no remote page can reach it — the token authenticates the ext<->app
// HTTP + /drive ws traffic (header: X-JAT13-Token; extension stores it under chrome.storage key
// "jat13Token").
import { randomUUID } from 'node:crypto';

/**
 * The slice of the secrets DAL pairing depends on — structurally compatible with the real
 * `Dal['secrets']` (db/dal). Typed as a slice so this module compiles and tests without the full
 * DAL, and so the pairing contract is explicit: sealed at rest, never plaintext.
 */
export interface PairingSecrets {
  open(key: string): string | undefined;
  seal(key: string, plaintext: string): void;
}

export interface PairingDal {
  secrets: PairingSecrets;
}

const KEY = 'pairing.extensionToken';

/**
 * Return the pairing token, minting + sealing one on first call. Stable across restarts (it lives
 * sealed in the DB) so a paired extension never needs to re-pair after an app update.
 */
export function ensurePairingToken(dal: PairingDal): string {
  const existing = dal.secrets.open(KEY);
  if (existing) return existing;
  const token = randomUUID().replace(/-/g, '');
  dal.secrets.seal(KEY, token);
  return token;
}
