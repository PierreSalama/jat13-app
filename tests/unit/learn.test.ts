// Watch-and-learn distiller + config. Asserts the STRUCTURAL laws:
//   1. a normal Q/A becomes a learned_answer (provenance 'harvest'),
//   2. a REDACTED event is DROPPED (never in learned_answers),
//   3. a sensitive LABEL is dropped even if the client forgot to mark it redacted (DAL belt),
//   4. re-ingesting the same Q/A upserts (no duplicate row), and
//   5. learnConfig reflects settings.learn.enabled (and defaults ON).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { makeDal, defaultContext, type Dal, type Sealer } from '../../app/src/main/db/dal/index.js';
import { makeLearnDistiller } from '../../app/src/main/learn/distiller.js';
import { learnConfig } from '../../app/src/main/learn/index.js';
import { normQuestion } from '@jat13/shared/norm';

const T = 1_700_000_000_000;
const PROFILE = 'prof_1';

// A no-op sealer (secrets aren't exercised here); matches the Sealer contract.
const sealer: Sealer = {
  available: () => false,
  seal: (p: string) => Buffer.from(p, 'utf8'),
  open: (b: Buffer) => Buffer.from(b).toString('utf8'),
};

function seedDefaultProfile(db: Database): void {
  db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
    .run(PROFILE, 'Pierre', T, T);
}

function countAnswers(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM learned_answers').get() as { c: number }).c;
}

describe('learn distiller', () => {
  let db: Database;
  let dal: Dal;
  let distiller: ReturnType<typeof makeLearnDistiller>;

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    seedDefaultProfile(db);
    dal = makeDal(defaultContext(db), { sealer });
    distiller = makeLearnDistiller({ dal });
  });
  afterEach(() => db.close());

  it('learns a normal Q/A, drops a redacted event, and does not duplicate on re-ingest', () => {
    const batch = {
      sessionId: 'ls_1',
      url: 'https://boards.greenhouse.io/acme/jobs/12345',
      host: 'boards.greenhouse.io',
      events: [
        { kind: 'fill' as const, label: 'How many years of experience?', fieldType: 'number', value: '5', choice: null, at: T },
        // a redacted (gender) event — LABEL only, value null: MUST be dropped.
        { kind: 'choose' as const, label: 'What is your gender?', fieldType: 'select', value: null, choice: null, redacted: true, at: T },
        // the submit transition — not an answer.
        { kind: 'advance' as const, label: 'Submit application', fieldType: 'button', value: null, choice: null, at: T },
      ],
    };

    const r1 = distiller.ingest(batch);
    expect(r1.learned).toBe(1);
    expect(r1.dropped).toBe(1); // the redacted gender event (advance is skipped, not "dropped")

    // exactly one learned answer, and it's the years-of-experience one, provenance 'harvest'.
    expect(countAnswers(db)).toBe(1);
    const row = db
      .prepare('SELECT kind, key_norm, value, provenance, confidence, source_host FROM learned_answers')
      .get() as { kind: string; key_norm: string; value: string; provenance: string; confidence: number; source_host: string };
    expect(row.kind).toBe('qa');
    expect(row.key_norm).toBe(normQuestion('How many years of experience?'));
    expect(row.value).toBe('5');
    expect(row.provenance).toBe('harvest');
    expect(row.confidence).toBeCloseTo(0.6);
    expect(row.source_host).toBe('boards.greenhouse.io');

    // the gender answer NEVER reached the table.
    const gender = db
      .prepare("SELECT COUNT(*) AS c FROM learned_answers WHERE key_norm LIKE '%gender%'")
      .get() as { c: number };
    expect(gender.c).toBe(0);

    // re-ingesting the SAME batch upserts (seen_count bumps) — no duplicate row.
    const r2 = distiller.ingest(batch);
    expect(r2.learned).toBe(1);
    expect(countAnswers(db)).toBe(1);
    const after = db.prepare('SELECT seen_count FROM learned_answers').get() as { seen_count: number };
    expect(after.seen_count).toBe(2);
  });

  it('drops a sensitive LABEL even if the client failed to mark it redacted (DAL belt)', () => {
    const r = distiller.ingest({
      host: 'jobs.lever.co',
      events: [
        // NOT flagged redacted, but the label is sensitive — the DAL must still refuse it.
        { kind: 'choose' as const, label: 'Are you a protected veteran?', fieldType: 'radio', value: 'No', choice: 'No', at: T },
        { kind: 'fill' as const, label: 'Preferred name', fieldType: 'text', value: 'Pierre', choice: null, at: T },
      ],
    });
    expect(r.learned).toBe(1); // only "Preferred name"
    expect(countAnswers(db)).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM learned_answers WHERE key_norm LIKE '%veteran%'").get() as { c: number }).c,
    ).toBe(0);
  });

  it('drops empty values and does nothing without a default profile', () => {
    // empty value → dropped.
    const r1 = distiller.ingest({ host: 'x.io', events: [{ kind: 'fill', label: 'City', value: '', choice: null, at: T }] });
    expect(r1.learned).toBe(0);
    expect(countAnswers(db)).toBe(0);

    // no default profile → nothing learned (and no throw).
    const db2 = openDatabase({ file: ':memory:' }).db;
    const dal2 = makeDal(defaultContext(db2), { sealer });
    const distiller2 = makeLearnDistiller({ dal: dal2 });
    const r2 = distiller2.ingest({ host: 'x.io', events: [{ kind: 'fill', label: 'City', value: 'Montreal', choice: null, at: T }] });
    expect(r2.learned).toBe(0);
    db2.close();
  });
});

describe('learn config', () => {
  let db: Database;
  let dal: Dal;

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    seedDefaultProfile(db);
    dal = makeDal(defaultContext(db), { sealer });
  });
  afterEach(() => db.close());

  it('defaults enabled=true and exposes apply-host patterns', () => {
    const cfg = learnConfig(dal);
    expect(cfg.enabled).toBe(true);
    expect(cfg.applyHosts.length).toBeGreaterThan(0);
    expect(cfg.applyHosts.some((p) => p.host === 'linkedin.com')).toBe(true);
  });

  it('reflects settings.learn.enabled=false (read even before the section is registered)', () => {
    // Raw settings row so the test works whether or not the `learn` section is in the schema registry.
    db.prepare("INSERT INTO settings (section, key, value_json, schema_version, updated_at) VALUES ('learn', 'enabled', 'false', 1, ?)")
      .run(T);
    expect(learnConfig(dal).enabled).toBe(false);
  });
});
