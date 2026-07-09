// answers DAL — behavior + guard-path tests. The SECURITY rule (drop sensitive keys) and the
// provenance/locked merge rules are structural laws, so the rejections are asserted, not just happy paths.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { defaultContext } from '../../app/src/main/db/dal/util.js';
import type { DomainEvent } from '../../app/src/main/db/dal/util.js';
import { makeAnswersDal, isSensitiveKey } from '../../app/src/main/db/dal/answers.js';
import { normQuestion, normKey } from '@jat13/shared/norm';

const T = 1_700_000_000_000;
const PROFILE = 'prof_1';

function seedProfile(db: Database): void {
  db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
    .run(PROFILE, 'Pierre', T, T);
}

describe('answers DAL', () => {
  let db: Database;
  let events: DomainEvent[];
  let clock: number;
  let dal: ReturnType<typeof makeAnswersDal>;

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    seedProfile(db);
    events = [];
    clock = T;
    dal = makeAnswersDal({
      db,
      now: () => clock,
      newId: (prefix) => `${prefix}_${events.length}_${clock}`,
      emit: (evt) => events.push(evt),
    });
  });
  afterEach(() => db.close());

  // ---- isSensitiveKey unit coverage ----------------------------------------
  describe('isSensitiveKey', () => {
    it('flags demographic / regulated attributes', () => {
      for (const k of [
        'gender',
        'what is your race',
        'ethnicity',
        'do you have a disability',
        'are you a veteran',
        'sexual orientation',
        'ssn',
        'social security number',
        'date of birth',
        'dob',
        'salary history',
        'criminal record',
        'have you ever committed a felony',
      ]) {
        expect(isSensitiveKey(normQuestion(k))).toBe(true);
      }
    });

    it('does not flag benign screening keys', () => {
      for (const k of ['years experience', 'work authorization', 'preferred name', 'notice period', 'city']) {
        expect(isSensitiveKey(normQuestion(k))).toBe(false);
      }
    });

    it('is also exported on the DAL instance', () => {
      expect(dal.isSensitiveKey(normKey('gender'))).toBe(true);
    });
  });

  // ---- SECURITY: sensitive answers are dropped, never inserted -------------
  describe('record() drops sensitive answers', () => {
    it('returns null and inserts nothing for gender', () => {
      const r = dal.record(PROFILE, { kind: 'qa', label: 'What is your gender?', value: 'male' });
      expect(r).toBeNull();
      const n = db.prepare('SELECT COUNT(*) c FROM learned_answers').get() as { c: number };
      expect(n.c).toBe(0);
      expect(events).toHaveLength(0);
    });

    it('returns null for an SSN field', () => {
      const r = dal.record(PROFILE, { kind: 'field', label: 'Social Security Number', value: '000-00-0000' });
      expect(r).toBeNull();
      expect((db.prepare('SELECT COUNT(*) c FROM learned_answers').get() as { c: number }).c).toBe(0);
    });

    it('returns null for date of birth (DOB)', () => {
      expect(dal.record(PROFILE, { kind: 'qa', label: 'Date of birth', value: '1990-01-01' })).toBeNull();
      expect(dal.record(PROFILE, { kind: 'field', label: 'DOB', value: '1990-01-01' })).toBeNull();
      expect((db.prepare('SELECT COUNT(*) c FROM learned_answers').get() as { c: number }).c).toBe(0);
    });

    it('drops a sensitive key even when the caller passes an explicit keyNorm', () => {
      const r = dal.record(PROFILE, {
        kind: 'qa',
        label: 'anything',
        keyNorm: 'criminal history',
        value: 'no',
      });
      expect(r).toBeNull();
    });

    it('does NOT drop a benign salary-expectations key (no "history" token)', () => {
      const r = dal.record(PROFILE, {
        kind: 'qa',
        label: 'What are your salary expectations?',
        value: '90k',
      });
      expect(r).not.toBeNull();
      expect((db.prepare('SELECT COUNT(*) c FROM learned_answers').get() as { c: number }).c).toBe(1);
    });
  });

  // ---- key derivation ------------------------------------------------------
  it('computes a qa key via normQuestion (word-order independent)', () => {
    const a = dal.record(PROFILE, { kind: 'qa', label: 'How many years of experience?', value: '5' });
    expect(a).not.toBeNull();
    expect(a!.key_norm).toBe(normQuestion('How many years of experience?'));
    // normQuestion sorts tokens + drops fillers, so a reworded variant lands on the SAME key
    // ("experience years") → upsert, not a new row.
    const b = dal.record(PROFILE, { kind: 'qa', label: 'Experience in years?', value: '6' });
    expect(b!.key_norm).toBe(a!.key_norm);
    expect((db.prepare('SELECT COUNT(*) c FROM learned_answers').get() as { c: number }).c).toBe(1);
  });

  it('computes a field key via normKey', () => {
    const a = dal.record(PROFILE, { kind: 'field', label: 'First Name', value: 'Pierre' });
    expect(a!.key_norm).toBe(normKey('First Name'));
  });

  // ---- upsert bumps seen_count ---------------------------------------------
  it('upsert on (profile, kind, key_norm) bumps seen_count instead of inserting', () => {
    const first = dal.record(PROFILE, { kind: 'field', label: 'City', value: 'Montreal', provenance: 'harvest' });
    expect(first!.seen_count).toBe(1);
    const second = dal.record(PROFILE, { kind: 'field', label: 'City', value: 'Montreal', provenance: 'harvest' });
    expect(second!.id).toBe(first!.id);
    expect(second!.seen_count).toBe(2);
    expect((db.prepare('SELECT COUNT(*) c FROM learned_answers').get() as { c: number }).c).toBe(1);
  });

  // ---- provenance rank + locked merge rules --------------------------------
  it('respects provenance rank: higher overwrites the value, lower does not', () => {
    // ai (rank 2) writes first
    const ai = dal.record(PROFILE, { kind: 'qa', label: 'Willing to relocate?', value: 'maybe', provenance: 'ai' });
    expect(ai!.value).toBe('maybe');

    // harvest (rank 1, lower) must NOT overwrite the ai value — but seen_count still bumps
    const harvest = dal.record(PROFILE, {
      kind: 'qa',
      label: 'Willing to relocate?',
      value: 'no',
      provenance: 'harvest',
    });
    expect(harvest!.value).toBe('maybe');
    expect(harvest!.provenance).toBe('ai');
    expect(harvest!.seen_count).toBe(2);

    // teach (rank 5, higher) overwrites
    const teach = dal.record(PROFILE, {
      kind: 'qa',
      label: 'Willing to relocate?',
      value: 'yes',
      provenance: 'teach',
    });
    expect(teach!.value).toBe('yes');
    expect(teach!.provenance).toBe('teach');
    expect(teach!.seen_count).toBe(3);
  });

  it('allows an equal-rank write to overwrite the value', () => {
    dal.record(PROFILE, { kind: 'qa', label: 'Notice period?', value: '2 weeks', provenance: 'user' });
    const again = dal.record(PROFILE, { kind: 'qa', label: 'Notice period?', value: '4 weeks', provenance: 'user' });
    expect(again!.value).toBe('4 weeks');
  });

  it('does NOT overwrite a locked row, even from a harvest sighting', () => {
    const locked = dal.record(PROFILE, {
      kind: 'field',
      label: 'Email',
      value: 'me@correct.com',
      provenance: 'user',
      locked: true,
    });
    expect(locked!.locked).toBe(true);

    // Even a same-or-higher provenance can't touch a locked value via record(); seen_count still bumps.
    const attempt = dal.record(PROFILE, {
      kind: 'field',
      label: 'Email',
      value: 'wrong@harvested.com',
      provenance: 'user',
    });
    expect(attempt!.value).toBe('me@correct.com');
    expect(attempt!.locked).toBe(true);
    expect(attempt!.seen_count).toBe(2);
  });

  // ---- provenance metadata persisted on the FIRST insert (not just on merge) ----
  it('persists source_host and source_job_id on a brand-new insert', () => {
    // seed the FK parent job so source_job_id is a real reference-shaped value.
    db.prepare(
      'INSERT INTO jobs (id, source, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('job_1', 'linkedin', T, T, T, T);
    const a = dal.record(PROFILE, {
      kind: 'field',
      label: 'City',
      value: 'Montreal',
      sourceHost: 'linkedin.com',
      sourceJobId: 'job_1',
    });
    expect(a).not.toBeNull();
    const row = db
      .prepare('SELECT source_host, source_job_id FROM learned_answers WHERE id = ?')
      .get(a!.id) as { source_host: string | null; source_job_id: string | null };
    expect(row.source_host).toBe('linkedin.com');
    expect(row.source_job_id).toBe('job_1');
  });

  // ---- lookup / snapshot / list -------------------------------------------
  it('lookup returns the exact-key row or undefined', () => {
    const a = dal.record(PROFILE, { kind: 'field', label: 'Phone', value: '555' });
    expect(dal.lookup(PROFILE, a!.key_norm)?.value).toBe('555');
    expect(dal.lookup(PROFILE, 'no-such-key')).toBeUndefined();
    // Scoped by profile: another profile can't read prof_1's key.
    db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
      .run('prof_2', 'Dad', T, T);
    expect(dal.lookup('prof_2', a!.key_norm)).toBeUndefined();
  });

  it('snapshot returns all rows for the profile with parsed options', () => {
    dal.record(PROFILE, { kind: 'field', label: 'Country', value: 'CA', options: ['CA', 'US'] });
    dal.record(PROFILE, { kind: 'qa', label: 'Sponsorship needed?', value: 'no' });
    const snap = dal.snapshot(PROFILE);
    expect(snap).toHaveLength(2);
    const country = snap.find((r) => r.key_norm === normKey('Country'));
    expect(country?.options).toEqual(['CA', 'US']);
  });

  it('list returns a LeanPage with total, honoring q + kind filters and default limit', () => {
    dal.record(PROFILE, { kind: 'field', label: 'City', value: 'Montreal' });
    dal.record(PROFILE, { kind: 'field', label: 'Postal Code', value: 'H0H0H0' });
    dal.record(PROFILE, { kind: 'qa', label: 'Years of experience?', value: '5' });

    const all = dal.list(PROFILE);
    expect(all.total).toBe(3);
    expect(all.rows).toHaveLength(3);
    // Lean rows carry no `value` property.
    expect(all.rows[0]).not.toHaveProperty('value');

    const onlyFields = dal.list(PROFILE, { kind: 'field' });
    expect(onlyFields.total).toBe(2);

    const cityMatch = dal.list(PROFILE, { q: 'city' });
    expect(cityMatch.total).toBe(1);
    expect(cityMatch.rows[0]?.label).toBe('City');
  });

  // ---- promoteToProfile / markUsed ----------------------------------------
  it('promoteToProfile locks the row, sets provenance=user, and emits', () => {
    const a = dal.record(PROFILE, { kind: 'qa', label: 'Relocation?', value: 'yes', provenance: 'harvest' });
    events.length = 0;
    clock = T + 1000;
    const promoted = dal.promoteToProfile(a!.id);
    expect(promoted?.locked).toBe(true);
    expect(promoted?.provenance).toBe('user');
    expect(promoted?.updated_at).toBe(T + 1000);
    expect(events.at(-1)).toMatchObject({ table: 'learned_answers', op: 'update', id: a!.id });
    // Missing id → undefined, no throw.
    expect(dal.promoteToProfile('nope')).toBeUndefined();
  });

  it('markUsed increments used_count and stamps last_used_at', () => {
    const a = dal.record(PROFILE, { kind: 'field', label: 'City', value: 'Montreal' });
    clock = T + 500;
    const used = dal.markUsed(a!.id);
    expect(used?.used_count).toBe(1);
    expect(used?.last_used_at).toBe(T + 500);
    const again = dal.markUsed(a!.id);
    expect(again?.used_count).toBe(2);
    expect(dal.markUsed('nope')).toBeUndefined();
  });

  // ---- events emitted on mutation ------------------------------------------
  it('emits insert then update DomainEvents on record()', () => {
    const a = dal.record(PROFILE, { kind: 'field', label: 'City', value: 'Montreal' });
    expect(events[0]).toMatchObject({ table: 'learned_answers', op: 'insert', id: a!.id });
    dal.record(PROFILE, { kind: 'field', label: 'City', value: 'Montreal' });
    expect(events[1]).toMatchObject({ table: 'learned_answers', op: 'update', id: a!.id });
  });
});
