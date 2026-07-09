// secrets DAL — BEHAVIOR + guard/rejection paths. The security law under test: plaintext never lands
// in the DB, never in a health row, never in an emitted event. safeStorage is absent under vitest, so
// we drive the DAL with a tiny base64 FakeSealer to exercise the seal/open round-trip end to end.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { defaultContext } from '../../app/src/main/db/dal/util.js';
import type { DomainEvent } from '../../app/src/main/db/dal/util.js';
import { makeSecretsDal } from '../../app/src/main/db/dal/secrets.js';
import type { Sealer, SecretsDal, SecretHealth } from '../../app/src/main/db/dal/secrets.js';

const T = 1_700_000_000_000; // fixed epoch-ms

/** base64 "sealing" — obviously reversible, but the plaintext is NOT stored literally, which is enough
 *  to prove the DAL treats the blob as opaque and round-trips through the Sealer. Buffer-honest so the
 *  round-trip matches production semantics (BLOB in, BLOB out). */
function makeBufferSealer(available = true): Sealer {
  return {
    available: () => available,
    seal: (plaintext: string) => Buffer.from(`b64:${Buffer.from(plaintext, 'utf8').toString('base64')}`, 'utf8'),
    open: (sealed: Buffer) => {
      const s = sealed.toString('utf8');
      const b64 = s.startsWith('b64:') ? s.slice(4) : s;
      return Buffer.from(b64, 'base64').toString('utf8');
    },
  };
}

describe('secrets DAL', () => {
  let db: Database;
  let events: DomainEvent[];
  let dal: SecretsDal;

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    events = [];
    const ctx = defaultContext(db, (evt) => events.push(evt));
    // fixed clock so timestamps are deterministic
    ctx.now = () => T;
    dal = makeSecretsDal(ctx, makeBufferSealer());
  });
  afterEach(() => db.close());

  it('seal + open round-trips the plaintext', () => {
    dal.seal('gmail_oauth', 'ya29.super-secret-token');
    expect(dal.open('gmail_oauth')).toBe('ya29.super-secret-token');
  });

  it('open returns undefined for an absent key', () => {
    expect(dal.open('nope')).toBeUndefined();
  });

  it('seal upserts — a re-seal replaces the sealed blob and keeps status ok', () => {
    dal.seal('k', 'first');
    dal.seal('k', 'second');
    expect(dal.open('k')).toBe('second');
    const n = db.prepare('SELECT COUNT(*) c FROM secrets WHERE key=?').get('k') as { c: number };
    expect(n.c).toBe(1);
  });

  it('seal stores status ok and the sealed BLOB is NOT the literal plaintext', () => {
    const plaintext = 'AKIA-not-in-the-clear';
    dal.seal('aws', plaintext);
    const row = db.prepare('SELECT status, sealed FROM secrets WHERE key=?').get('aws') as {
      status: string;
      sealed: Buffer;
    };
    expect(row.status).toBe('ok');
    // the at-rest bytes must not contain the plaintext verbatim
    expect(row.sealed.toString('utf8')).not.toContain(plaintext);
  });

  it('REFUSES to store when the Sealer is unavailable (never plaintext fallback)', () => {
    const ctx = defaultContext(db, (evt) => events.push(evt));
    const dal2 = makeSecretsDal(ctx, makeBufferSealer(false));
    expect(() => dal2.seal('k', 'secret')).toThrow(/unavailable/i);
    // nothing was written, nothing emitted
    const n = db.prepare('SELECT COUNT(*) c FROM secrets').get() as { c: number };
    expect(n.c).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('health() returns the health projection and NEVER exposes sealed bytes or plaintext', () => {
    const plaintext = 'ya29.leak-me-not';
    dal.seal('gmail_oauth', plaintext);
    dal.reportUse('gmail_oauth', true, {});
    const rows: SecretHealth[] = dal.health();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.key).toBe('gmail_oauth');
    expect(r.status).toBe('ok');
    expect(r.last_ok_at).toBe(T);
    // structural: no `sealed` key on the health row at all
    expect(Object.prototype.hasOwnProperty.call(r, 'sealed')).toBe(false);
    // and the plaintext never appears anywhere in the serialized health payload
    expect(JSON.stringify(rows)).not.toContain(plaintext);
  });

  it('reportUse(ok=true) sets status=ok, last_ok_at=now, clears last_error', () => {
    dal.seal('k', 'v');
    // first fail to plant an error
    dal.reportUse('k', false, { error: 'boom' });
    // then a success clears it
    dal.reportUse('k', true, {});
    const r = dal.health()[0]!;
    expect(r.status).toBe('ok');
    expect(r.last_ok_at).toBe(T);
    expect(r.last_error).toBeNull();
  });

  it('reportUse(ok=false) flips status to expired by default and records the capped error', () => {
    dal.seal('k', 'v');
    dal.reportUse('k', false, { error: 'token expired' });
    const r = dal.health()[0]!;
    expect(r.status).toBe('expired');
    expect(r.last_error).toBe('token expired');
    expect(r.last_ok_at).toBeNull();
  });

  it('reportUse(ok=false, reason=revoked) flips status to revoked', () => {
    dal.seal('k', 'v');
    dal.reportUse('k', false, { error: 'user revoked access', reason: 'revoked' });
    const r = dal.health()[0]!;
    expect(r.status).toBe('revoked');
  });

  it('reportUse caps last_error at 512 chars (column CHECK safety)', () => {
    dal.seal('k', 'v');
    dal.reportUse('k', false, { error: 'x'.repeat(1000) });
    const r = dal.health()[0]!;
    expect(r.last_error).toHaveLength(512);
  });

  it('reportUse records expires_hint_at and preserves it when not re-supplied', () => {
    dal.seal('k', 'v');
    dal.reportUse('k', false, { error: 'expired', expiresHintAt: T + 60_000 });
    expect(dal.health()[0]!.expires_hint_at).toBe(T + 60_000);
    // a later success without a hint keeps the prior hint (COALESCE)
    dal.reportUse('k', true, {});
    expect(dal.health()[0]!.expires_hint_at).toBe(T + 60_000);
  });

  it('reportUse(ok=false) with no error yields null last_error and never touches the sealed blob', () => {
    dal.seal('k', 'still-openable');
    // a failure report without an error string must not throw and must leave last_error null
    dal.reportUse('k', false);
    const r = dal.health()[0]!;
    expect(r.status).toBe('expired');
    expect(r.last_error).toBeNull();
    // the sealed credential is untouched by reportUse — open still round-trips
    expect(dal.open('k')).toBe('still-openable');
  });

  it('reportUse can flip a revoked secret back to ok (status is not sticky)', () => {
    dal.seal('k', 'v');
    dal.reportUse('k', false, { error: 'gone', reason: 'revoked' });
    expect(dal.health()[0]!.status).toBe('revoked');
    dal.reportUse('k', true);
    const r = dal.health()[0]!;
    expect(r.status).toBe('ok');
    expect(r.last_ok_at).toBe(T);
    // success clears the prior error
    expect(r.last_error).toBeNull();
  });

  it('reportUse on a missing key is a no-op: no row created, no event emitted', () => {
    events.length = 0;
    dal.reportUse('ghost', true, {});
    const n = db.prepare('SELECT COUNT(*) c FROM secrets').get() as { c: number };
    expect(n.c).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('emits a secrets DomainEvent on seal whose patch carries NO plaintext and NO sealed bytes', () => {
    const plaintext = 'ya29.absolutely-secret';
    events.length = 0;
    dal.seal('gmail_oauth', plaintext);
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.table).toBe('secrets');
    expect(evt.op).toBe('update');
    expect(evt.id).toBe('gmail_oauth');
    // the full serialized event must not leak the plaintext or contain the sealed blob field
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain(plaintext);
    expect(evt.patch).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(evt.patch!, 'sealed')).toBe(false);
    expect(evt.patch!.status).toBe('ok');
  });

  it('emits on reportUse with a patch that never carries plaintext', () => {
    dal.seal('k', 'topsecret');
    events.length = 0;
    dal.reportUse('k', false, { error: 'expired', reason: 'expired' });
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.table).toBe('secrets');
    expect(evt.id).toBe('k');
    expect(JSON.stringify(evt)).not.toContain('topsecret');
    expect(evt.patch!.status).toBe('expired');
  });
});
