// answer-resolver — profile-first, NO AI. The resolution ORDER is a structural law (sensitive guard
// beats profile beats learned, unknowns park), so each rung is asserted against the REAL DAL and a
// real migrated in-memory DB — no mocks. A sensitive question must PARK even if it would otherwise
// match; an unknown question must PARK (never guess).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { SnapNode } from '@jat13/shared/protocol';
import type { PageDef, AdapterDoc, FieldRule } from '@jat13/shared/adapter-schema';
import { normQuestion } from '@jat13/shared/norm';
import { openDatabase } from '../../app/src/main/db/index.js';
import { defaultContext } from '../../app/src/main/db/dal/util.js';
import { makeAnswersDal } from '../../app/src/main/db/dal/answers.js';
import { makeResolver, controlKey } from '../../app/src/main/engine/answer-resolver.js';

const T = 1_700_000_000_000;
const PROFILE = 'prof_1';

// The runner passes (control, page, adapter) — the resolver only reads `control`, so page/adapter are
// inert stand-ins here (typed, not `any`, to honor the real ResolveControl signature).
const PAGE = { key: 'form', kind: 'form', classify: {}, next: [] } as unknown as PageDef;
const ADAPTER = {} as unknown as AdapterDoc;

let nid = 0;
function node(role: SnapNode['role'], name: string, extra: Partial<SnapNode> = {}): SnapNode {
  return { nid: nid++, role, name, rect: [0, 0, 100, 30], path: `p${nid}`, ...extra };
}

function seedProfile(db: Database, data: Record<string, unknown>): void {
  db.prepare(
    'INSERT INTO profiles (id, name, is_default, data_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)',
  ).run(PROFILE, 'Pierre', JSON.stringify(data), T, T);
}

describe('answer-resolver', () => {
  let db: Database;
  let answers: ReturnType<typeof makeAnswersDal>;

  beforeEach(() => {
    nid = 0;
    ({ db } = openDatabase({ file: ':memory:' }));
    seedProfile(db, {
      email: 'pierre@example.com',
      phone: '514-555-0100',
      firstName: 'Pierre',
      lastName: 'Salama',
      city: 'Montreal',
      linkedin: 'https://linkedin.com/in/pierre',
      workAuthorization: true,
      yearsOfExperience: 8,
    });
    answers = makeAnswersDal(defaultContext(db));
    // A couple of learned answers (ask-once-ever memory). One high-confidence, one below the floor.
    answers.record(PROFILE, {
      kind: 'qa',
      label: 'Are you willing to relocate?',
      value: 'Yes',
      confidence: 0.9,
      provenance: 'user',
    });
    answers.record(PROFILE, {
      kind: 'qa',
      label: 'What is your desired start date?',
      value: 'Immediately',
      confidence: 0.2, // below the default 0.5 floor → must be ignored
      provenance: 'harvest',
    });
  });
  afterEach(() => db.close());

  function resolver(over: Partial<Parameters<typeof makeResolver>[0]> = {}) {
    const rawProfile = db.prepare('SELECT data_json FROM profiles WHERE id = ?').get(PROFILE) as {
      data_json: string;
    };
    return makeResolver({
      answers,
      profile: { data: JSON.parse(rawProfile.data_json) as Record<string, unknown> },
      profileId: PROFILE,
      ...over,
    });
  }

  // ---- controlKey helper ----------------------------------------------------
  it('controlKey normalizes the group prompt, falling back to the name', () => {
    expect(controlKey(node('textbox', 'Email Address'))).toBe(normQuestion('Email Address'));
    // groupPrompt wins over name when both are present.
    expect(controlKey(node('radiogroup', 'radio-group', { groupPrompt: 'Willing to relocate?' }))).toBe(
      normQuestion('Willing to relocate?'),
    );
  });

  // ---- 2) PROFILE fills -----------------------------------------------------
  it('fills an email textbox from the profile', () => {
    const r = resolver();
    const ans = r(node('textbox', 'Email Address'), PAGE, ADAPTER);
    expect(ans).toEqual({ kind: 'fill', value: 'pierre@example.com' });
  });

  it('fills first name, city, and phone from the profile', () => {
    const r = resolver();
    expect(r(node('textbox', 'First Name'), PAGE, ADAPTER)).toEqual({ kind: 'fill', value: 'Pierre' });
    expect(r(node('textbox', 'City'), PAGE, ADAPTER)).toEqual({ kind: 'fill', value: 'Montreal' });
    expect(r(node('textbox', 'Phone number'), PAGE, ADAPTER)).toEqual({ kind: 'fill', value: '514-555-0100' });
  });

  it('answers a work-authorization radio group with Yes from the profile', () => {
    const r = resolver();
    const grp = node('radiogroup', 'auth', { groupPrompt: 'Are you legally authorized to work in Canada?' });
    expect(r(grp, PAGE, ADAPTER)).toEqual({ kind: 'radio', byText: 'Yes' });
  });

  it('coerces a numeric years-of-experience profile value to a fill string', () => {
    const r = resolver();
    expect(r(node('textbox', 'Years of experience'), PAGE, ADAPTER)).toEqual({ kind: 'fill', value: '8' });
  });

  // ---- 3) LEARNED answers ---------------------------------------------------
  it('fills a known screening question from learned answers (>= confidence floor)', () => {
    const r = resolver();
    // A textbox variant of the learned "willing to relocate" question.
    const ans = r(node('textbox', 'Willing to relocate?'), PAGE, ADAPTER);
    expect(ans).toEqual({ kind: 'fill', value: 'Yes' });
  });

  it('answers a learned question as a radio when the control is a radio group', () => {
    const r = resolver();
    const grp = node('radiogroup', 'reloc', { groupPrompt: 'Are you willing to relocate?' });
    expect(r(grp, PAGE, ADAPTER)).toEqual({ kind: 'radio', byText: 'Yes' });
  });

  it('PARKS a learned answer whose confidence is below the floor', () => {
    const r = resolver();
    const ans = r(node('textbox', 'Desired start date'), PAGE, ADAPTER);
    expect(ans).toEqual({ kind: 'park', reason: 'unknown' });
  });

  it('honors a custom confidenceMin that admits the low-confidence learned answer', () => {
    const r = resolver({ confidenceMin: 0.1 });
    const ans = r(node('textbox', 'Desired start date'), PAGE, ADAPTER);
    expect(ans).toEqual({ kind: 'fill', value: 'Immediately' });
  });

  // ---- 1) SENSITIVE guard beats everything ----------------------------------
  it("PARKS a 'What is your gender?' radio as sensitive (never autofills)", () => {
    const r = resolver();
    const grp = node('radiogroup', 'gender', { groupPrompt: 'What is your gender?' });
    expect(r(grp, PAGE, ADAPTER)).toEqual({ kind: 'park', reason: 'sensitive' });
  });

  it('PARKS date-of-birth / SSN / criminal-history controls as sensitive', () => {
    const r = resolver();
    expect(r(node('textbox', 'Date of birth'), PAGE, ADAPTER)).toEqual({ kind: 'park', reason: 'sensitive' });
    expect(r(node('textbox', 'Social Security Number'), PAGE, ADAPTER)).toEqual({
      kind: 'park',
      reason: 'sensitive',
    });
    expect(r(node('textbox', 'Have you ever committed a felony?'), PAGE, ADAPTER)).toEqual({
      kind: 'park',
      reason: 'sensitive',
    });
  });

  it('PARKS a fieldMap rule marked neverAutofill even for an otherwise-fillable control', () => {
    // 'veteran status' is already sensitive, so use a NON-sensitive label that only the adapter marks off.
    const fieldMap: FieldRule[] = [{ labelRx: 'internal referral code', neverAutofill: true }];
    const r = resolver({ fieldMap });
    const ans = r(node('textbox', 'Internal referral code'), PAGE, ADAPTER);
    expect(ans).toEqual({ kind: 'park', reason: 'sensitive' });
  });

  it('sensitive guard wins even when a learned answer exists for the same key', () => {
    // Seed a learned answer under a sensitive key path — the DAL DROPS sensitive keys, so this insert is
    // a no-op; the resolver must STILL park on the sensitive guard, not fall through to a profile/learned hit.
    answers.record(PROFILE, { kind: 'qa', label: 'What is your gender?', value: 'prefer not to say' });
    const r = resolver();
    const grp = node('radiogroup', 'gender', { groupPrompt: 'What is your gender?' });
    expect(r(grp, PAGE, ADAPTER)).toEqual({ kind: 'park', reason: 'sensitive' });
  });

  it('sensitive guard beats a coincidental PROFILE key (a profile that carries gender must never leak)', () => {
    // A profile bag that literally holds a demographic value AND a name. The sensitive guard runs FIRST,
    // so neither the fullName concept (tokens {gender} carry no name) nor a stray key can autofill it.
    const raw = db.prepare('SELECT data_json FROM profiles WHERE id = ?').get(PROFILE) as { data_json: string };
    const data = { ...(JSON.parse(raw.data_json) as Record<string, unknown>), gender: 'Male', name: 'Pierre Salama' };
    const r = makeResolver({ answers, profile: { data }, profileId: PROFILE });
    expect(r(node('select', 'Gender'), PAGE, ADAPTER)).toEqual({ kind: 'park', reason: 'sensitive' });
    expect(r(node('textbox', 'Gender identity'), PAGE, ADAPTER)).toEqual({ kind: 'park', reason: 'sensitive' });
  });

  it('answers a work-authorization control with No when the profile value is falsey', () => {
    const raw = db.prepare('SELECT data_json FROM profiles WHERE id = ?').get(PROFILE) as { data_json: string };
    const data = { ...(JSON.parse(raw.data_json) as Record<string, unknown>), workAuthorization: false };
    const r = makeResolver({ answers, profile: { data }, profileId: PROFILE });
    const grp = node('radiogroup', 'auth', { groupPrompt: 'Are you legally authorized to work in Canada?' });
    expect(r(grp, PAGE, ADAPTER)).toEqual({ kind: 'radio', byText: 'No' });
  });

  // ---- 4) unknown parks -----------------------------------------------------
  it('PARKS an unknown question with reason "unknown"', () => {
    const r = resolver();
    const ans = r(node('textbox', 'Describe your most challenging project'), PAGE, ADAPTER);
    expect(ans).toEqual({ kind: 'park', reason: 'unknown' });
  });

  it('PARKS a known concept the profile does not carry (no fabricated value)', () => {
    // The seeded profile has no `website`, so a portfolio-URL control has no source → park.
    const r = resolver();
    const ans = r(node('textbox', 'Portfolio website'), PAGE, ADAPTER);
    expect(ans).toEqual({ kind: 'park', reason: 'unknown' });
  });
});
