// settings DAL tests — per-key merge over the registry (the stale-blob-shadow kill) + validation,
// plus the Stage-0 secrets surface (sealed pairing-token storage) since both ship in makeDal.

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../app/src/main/db/index.js';
import {
  defaultContext,
  makeDal,
  type DomainEvent,
  type Sealer,
} from '../../app/src/main/db/dal/index.js';

/** Reversible fake — vitest has no Electron safeStorage; the DAL treats sealed bytes as opaque. */
const fakeSealer: Sealer = {
  available: () => true,
  seal: (plaintext) => Buffer.from(`sealed:${plaintext}`, 'utf8'),
  open: (sealed) => sealed.toString('utf8').replace(/^sealed:/, ''),
};

const deadSealer: Sealer = {
  available: () => false,
  seal: () => {
    throw new Error('unreachable');
  },
  open: () => {
    throw new Error('unreachable');
  },
};

function freshDal(sealer: Sealer = fakeSealer) {
  const { db } = openDatabase({ file: ':memory:' });
  const events: DomainEvent[] = [];
  const ctx = defaultContext(db, (evt) => events.push(evt));
  return { dal: makeDal(ctx, { sealer }), db, events };
}

describe('settings: per-key merge over the registry', () => {
  it('unstored keys fall through to the registry default', () => {
    const { dal } = freshDal();
    expect(dal.settings.getKey('appearance', 'themeId')).toBe('atelier');
    expect(dal.settings.getKey('notifications', 'onApply')).toBe(true);
    expect(dal.settings.getKey('maintenance', 'backupDaily')).toBe(true);
  });

  it('set() persists one (section,key) row and getKey() reads it back', () => {
    const { dal, db } = freshDal();
    dal.settings.set('appearance', 'themeId', 'midnight');
    expect(dal.settings.getKey('appearance', 'themeId')).toBe('midnight');
    const rows = db.prepare('SELECT section, key, value_json FROM settings').all();
    expect(rows).toEqual([{ section: 'appearance', key: 'themeId', value_json: '"midnight"' }]);
  });

  it('get(section) merges stored-over-default PER KEY; other sections untouched', () => {
    const { dal } = freshDal();
    dal.settings.set('notifications', 'onApply', false);
    expect(dal.settings.get('notifications')).toEqual({ onApply: false });
    expect(dal.settings.get('maintenance')).toEqual({ backupDaily: true });
  });

  it('a stored row for an UNREGISTERED key cannot shadow the registry (the v11 stale-blob kill)', () => {
    const { dal, db } = freshDal();
    // simulate junk left behind by an older build that registered a key we since removed
    db.prepare(
      "INSERT INTO settings (section, key, value_json, schema_version, updated_at) VALUES ('appearance', 'legacyBlob', '{\"whole\":\"section\"}', 1, 0)",
    ).run();
    // reads only surface registered keys; the junk row is invisible
    expect(dal.settings.get('appearance')).toEqual({ themeId: 'atelier' });
    expect(dal.settings.all()['appearance']).toEqual({ themeId: 'atelier' });
    // and asking for it BY NAME is loud, not a silent undefined
    expect(() => dal.settings.getKey('appearance', 'legacyBlob')).toThrow(
      /unknown setting: appearance\.legacyBlob/,
    );
  });

  it('all() returns every registered section with stored-or-default per key', () => {
    const { dal } = freshDal();
    dal.settings.set('maintenance', 'backupDaily', false);
    const all = dal.settings.all();
    // the base sections merge stored-over-default per key...
    expect(all).toMatchObject({
      appearance: { themeId: 'atelier' },
      notifications: { onApply: true },
      maintenance: { backupDaily: false },
    });
    // ...and the Stage-3 engine sections are present too (count-agnostic — grows over stages).
    expect(all).toHaveProperty('autoApply');
    expect(all).toHaveProperty('discovery');
  });

  it('set() emits a DomainEvent carrying the accepted value', () => {
    const { dal, events } = freshDal();
    dal.settings.set('appearance', 'themeId', 'noir');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      table: 'settings',
      op: 'update',
      id: 'appearance.themeId',
      patch: { section: 'appearance', key: 'themeId', value: 'noir' },
    });
  });
});

describe('settings: validation is loud on writes', () => {
  it('rejects a wrong-typed value, naming the key', () => {
    const { dal } = freshDal();
    expect(() => dal.settings.set('notifications', 'onApply', 'yes')).toThrow(
      /notifications\.onApply must be a boolean/,
    );
    expect(() => dal.settings.set('appearance', 'themeId', 42)).toThrow(
      /appearance\.themeId must be a string/,
    );
    // nothing was written
    expect(dal.settings.getKey('notifications', 'onApply')).toBe(true);
  });

  it('rejects unknown keys and unknown sections (never silently defaults)', () => {
    const { dal } = freshDal();
    expect(() => dal.settings.set('appearance', 'nope', 1)).toThrow(/unknown setting: appearance\.nope/);
    expect(() => dal.settings.set('bogus', 'themeId', 'x')).toThrow(/unknown setting: bogus\.themeId/);
    expect(() => dal.settings.get('bogus')).toThrow(/unknown settings section: bogus/);
    expect(() => dal.settings.getKey('bogus', 'themeId')).toThrow(/unknown setting: bogus\.themeId/);
  });
});

describe('secrets: sealed pairing-token storage (Stage-0 surface)', () => {
  it('seal/open round-trips through the injected Sealer', () => {
    const { dal } = freshDal();
    dal.secrets.seal('pairing_token', 'tok_super_secret');
    expect(dal.secrets.open('pairing_token')).toBe('tok_super_secret');
    expect(dal.secrets.open('missing')).toBeUndefined();
  });

  it('REFUSES to store when the Sealer is unavailable (plaintext fallback is forbidden)', () => {
    const { dal } = freshDal(deadSealer);
    expect(() => dal.secrets.seal('pairing_token', 'tok')).toThrow(/Sealer unavailable/);
  });

  it('health() reports status, never the sealed bytes; emitted patches carry no plaintext', () => {
    const { dal, events } = freshDal();
    dal.secrets.seal('pairing_token', 'tok_super_secret');
    dal.secrets.reportUse('pairing_token', false, { error: 'HTTP 401', reason: 'expired' });

    const health = dal.secrets.health();
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ key: 'pairing_token', status: 'expired', last_error: 'HTTP 401' });
    expect(Object.keys(health[0]!)).not.toContain('sealed');

    // no event patch ever contains the plaintext or the sealed bytes
    for (const evt of events.filter((e) => e.table === 'secrets')) {
      const flat = JSON.stringify(evt);
      expect(flat).not.toContain('tok_super_secret');
      expect(flat).not.toContain('sealed:');
    }
  });
});
