// settings DAL behavior — happy path AND every guard. Each rejection here is a v11 failure that the
// registry-driven, per-key merge makes impossible: unknown keys can't be written, saved blobs can't
// shadow new defaults, and out-of-range/enum values can't be persisted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { defaultContext, type DomainEvent } from '../../app/src/main/db/dal/util.js';
import { makeSettingsDal } from '../../app/src/main/db/dal/settings.js';
import { SETTINGS_REGISTRY, validate } from '../../app/src/main/settings/schema.js';

const T = 1_700_000_000_000;

describe('settings DAL', () => {
  let db: Database;
  let dal: ReturnType<typeof makeSettingsDal>;
  let events: DomainEvent[];

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    events = [];
    const ctx = { ...defaultContext(db, (e) => events.push(e)), now: () => T };
    dal = makeSettingsDal(ctx);
  });
  afterEach(() => db.close());

  describe('getKey', () => {
    it('returns the registry default when nothing is stored', () => {
      expect(dal.getKey('autoApply', 'maxPerDay')).toBe(SETTINGS_REGISTRY.autoApply.maxPerDay.default);
      expect(dal.getKey('appearance', 'theme')).toBe('aurora');
      expect(dal.getKey('autoApply', 'keywords')).toEqual([]);
    });

    it('throws naming the offending key on an unknown key', () => {
      expect(() => dal.getKey('autoApply', 'nope')).toThrow(/autoApply\.nope/);
    });

    it('throws on an unknown section', () => {
      expect(() => dal.getKey('nosuch', 'x')).toThrow(/nosuch\.x/);
    });

    it('returns the stored value once set (merged over default)', () => {
      dal.set('autoApply', 'maxPerDay', 42);
      expect(dal.getKey('autoApply', 'maxPerDay')).toBe(42);
    });
  });

  describe('get(section)', () => {
    it('returns every registered key stored-or-default', () => {
      const sec = dal.get('autoApply');
      expect(Object.keys(sec).sort()).toEqual(Object.keys(SETTINGS_REGISTRY.autoApply).sort());
      expect(sec.maxPerHour).toBe(SETTINGS_REGISTRY.autoApply.maxPerHour.default);
      expect(sec.easyApplyOnly).toBe(false);
    });

    it('overlays stored values onto defaults per key', () => {
      dal.set('autoApply', 'country', 'United States');
      const sec = dal.get('autoApply');
      expect(sec.country).toBe('United States');
      // an untouched key still shows its default
      expect(sec.maxPerDay).toBe(SETTINGS_REGISTRY.autoApply.maxPerDay.default);
    });

    it('throws on an unknown section', () => {
      expect(() => dal.get('nosuch')).toThrow(/nosuch/);
    });
  });

  describe('set + get round-trips', () => {
    it('round-trips a boolean', () => {
      dal.set('autoApply', 'easyApplyOnly', true);
      expect(dal.getKey('autoApply', 'easyApplyOnly')).toBe(true);
    });

    it('round-trips a string[]', () => {
      dal.set('autoApply', 'keywords', ['react', 'typescript']);
      expect(dal.getKey('autoApply', 'keywords')).toEqual(['react', 'typescript']);
    });

    it('round-trips an enum', () => {
      dal.set('appearance', 'theme', 'dark');
      expect(dal.getKey('appearance', 'theme')).toBe('dark');
    });

    it('persists value_json + schema_version + updated_at and emits', () => {
      dal.set('goals', 'dailyTarget', 80);
      const row = db
        .prepare('SELECT value_json, schema_version, updated_at FROM settings WHERE section=? AND key=?')
        .get('goals', 'dailyTarget') as { value_json: string; schema_version: number; updated_at: number };
      expect(JSON.parse(row.value_json)).toBe(80);
      expect(row.schema_version).toBe(1);
      expect(row.updated_at).toBe(T);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        table: 'settings',
        op: 'update',
        id: 'goals.dailyTarget',
        patch: { section: 'goals', key: 'dailyTarget', value: 80 },
      });
    });

    it('upserts (second set overwrites, still one row)', () => {
      dal.set('goals', 'dailyTarget', 10);
      dal.set('goals', 'dailyTarget', 25);
      expect(dal.getKey('goals', 'dailyTarget')).toBe(25);
      const n = db
        .prepare('SELECT COUNT(*) c FROM settings WHERE section=? AND key=?')
        .get('goals', 'dailyTarget') as { c: number };
      expect(n.c).toBe(1);
    });
  });

  describe('set validation guards', () => {
    it('throws naming the key on an unknown key', () => {
      expect(() => dal.set('autoApply', 'bogus', 1)).toThrow(/autoApply\.bogus/);
    });

    it('throws naming the section on an unknown section', () => {
      expect(() => dal.set('nosuch', 'x', 1)).toThrow(/nosuch\.x/);
    });

    it('rejects a wrong-typed value', () => {
      expect(() => dal.set('autoApply', 'easyApplyOnly', 'yes')).toThrow(/autoApply\.easyApplyOnly/);
      expect(() => dal.set('autoApply', 'maxPerDay', 'lots')).toThrow(/autoApply\.maxPerDay/);
      expect(() => dal.set('autoApply', 'keywords', 'react')).toThrow(/autoApply\.keywords/);
    });

    it('rejects a number below min', () => {
      expect(() => dal.set('autoApply', 'aiAnswerConfidenceMin', -0.1)).toThrow(/>= 0/);
    });

    it('rejects a number above max', () => {
      expect(() => dal.set('autoApply', 'aiAnswerConfidenceMin', 1.5)).toThrow(/<= 1/);
    });

    it('rejects a value outside the enum', () => {
      expect(() => dal.set('appearance', 'theme', 'neon')).toThrow(/appearance\.theme/);
      expect(() => dal.set('autoApply', 'seniorityMax', 'overlord')).toThrow(/seniorityMax/);
    });

    it('rejects a value whose JSON exceeds 16384 chars', () => {
      const huge = Array.from({ length: 2000 }, (_, i) => `keyword-${i}-padpadpadpad`);
      expect(() => dal.set('autoApply', 'keywords', huge)).toThrow(/exceeds 16384/);
      // and nothing was written
      const n = db
        .prepare('SELECT COUNT(*) c FROM settings WHERE section=? AND key=?')
        .get('autoApply', 'keywords') as { c: number };
      expect(n.c).toBe(0);
    });

    it('does not emit when a set is rejected', () => {
      try {
        dal.set('autoApply', 'maxPerDay', -1);
      } catch {
        /* expected */
      }
      expect(events).toHaveLength(0);
    });

    it('writes no row and emits nothing when an unknown key is set', () => {
      expect(() => dal.set('autoApply', 'ghostKnob', 1)).toThrow(/autoApply\.ghostKnob/);
      const n = db.prepare('SELECT COUNT(*) c FROM settings').get() as { c: number };
      expect(n.c).toBe(0);
      expect(events).toHaveLength(0);
    });

    it('writes no row and emits nothing when an unknown section is set', () => {
      expect(() => dal.set('nosuch', 'x', 1)).toThrow(/nosuch\.x/);
      const n = db.prepare('SELECT COUNT(*) c FROM settings').get() as { c: number };
      expect(n.c).toBe(0);
      expect(events).toHaveLength(0);
    });
  });

  describe('all()', () => {
    it('returns the full nested stored-or-default view', () => {
      dal.set('appearance', 'theme', 'light');
      const snap = dal.all();
      expect(Object.keys(snap).sort()).toEqual(Object.keys(SETTINGS_REGISTRY).sort());
      expect(snap.appearance!.theme).toBe('light');
      // an unset section still fully populated from defaults
      expect(snap.discovery!.freshnessHours).toBe(SETTINGS_REGISTRY.discovery.freshnessHours.default);
    });
  });

  describe('a NEW registry key is visible without migration (the v11 bug)', () => {
    // Simulate a key registered in a LATER app build, against a DB that has no row for it.
    const section = 'autoApply';
    const newKey = 'experimentalKnob';

    beforeEach(() => {
      (SETTINGS_REGISTRY as unknown as Record<string, Record<string, unknown>>)[section]![newKey] = {
        type: 'number',
        default: 7,
        min: 0,
        max: 10,
        description: 'added after the DB was first written',
      };
    });
    afterEach(() => {
      delete (SETTINGS_REGISTRY as unknown as Record<string, Record<string, unknown>>)[section]![newKey];
    });

    it('surfaces the new default via getKey() with no stored row and no migration', () => {
      expect(dal.getKey(section, newKey)).toBe(7);
    });

    it('surfaces the new key via get(section)', () => {
      expect(dal.get(section)[newKey]).toBe(7);
    });

    it('accepts a set against the new key and round-trips it', () => {
      dal.set(section, newKey, 3);
      expect(dal.getKey(section, newKey)).toBe(3);
    });
  });

  describe('validate() helper (pure)', () => {
    it('accepts a valid value and returns it', () => {
      expect(validate('autoApply', 'maxPerDay', 100)).toEqual({ ok: true, value: 100 });
    });
    it('rejects an unknown key by name', () => {
      const r = validate('autoApply', 'ghost', 1);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/autoApply\.ghost/);
    });
  });
});
