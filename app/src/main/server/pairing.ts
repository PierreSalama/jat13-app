// Loopback pairing token. The app mints ONE token (sealed via the secrets DAL), and the extension
// popup fetches it from the loopback-only /api/pair/token endpoint on a user click. Because the server
// binds 127.0.0.1 only, no remote page can reach it — the token authenticates the ext<->app socket.
import { randomUUID } from 'node:crypto';
import type { Dal } from '../db/dal/index.js';

const KEY = 'pairing.extensionToken';

/** Return the pairing token, minting + sealing one on first call. */
export function ensurePairingToken(dal: Dal): string {
  const existing = dal.secrets.open(KEY);
  if (existing) return existing;
  const token = randomUUID().replace(/-/g, '');
  dal.secrets.seal(KEY, token);
  return token;
}
