// documents DAL — behavior + guard paths. Bytes live in the DB; dedup is by sha256; listLean never
// ships bytes; exactly one default per role. Each assertion below is a real requirement, not a smoke test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../app/src/main/db/index.js';
import { defaultContext } from '../../app/src/main/db/dal/util.js';
import { makeDocumentsDal } from '../../app/src/main/db/dal/documents.js';

const T = 1_700_000_000_000;

function seedProfile(db: Database, id = 'prof_1'): string {
  db.prepare('INSERT INTO profiles (id, name, is_default, created_at, updated_at) VALUES (?, ?, 0, ?, ?)').run(
    id,
    'Pierre',
    T,
    T,
  );
  return id;
}

describe('documents DAL', () => {
  let db: Database;
  let dal: ReturnType<typeof makeDocumentsDal>;
  let events: Array<{ table: string; op: string; id: string }>;

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    events = [];
    dal = makeDocumentsDal(defaultContext(db, (e) => events.push({ table: e.table, op: e.op, id: e.id })));
  });
  afterEach(() => db.close());

  it('adds a document and stores its bytes + computed sha256/size', () => {
    const bytes = Buffer.from('hello resume');
    const doc = dal.add({ name: 'resume.pdf', role: 'resume', bytes, mime: 'application/pdf' });

    expect(doc.id).toMatch(/^doc_/);
    expect(doc.name).toBe('resume.pdf');
    expect(doc.size_bytes).toBe(bytes.length);
    expect(doc.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(doc.is_default).toBe(true); // first of its role
    expect(events).toContainEqual({ table: 'documents', op: 'insert', id: doc.id });
  });

  it('dedupes identical bytes: same id returned, only ONE blob + ONE document row', () => {
    const bytes = Buffer.from('exact same content');
    const first = dal.add({ name: 'a.pdf', role: 'resume', bytes });
    const insertsAfterFirst = events.filter((e) => e.op === 'insert').length;

    const second = dal.add({ name: 'b-different-name.pdf', role: 'cover_letter', bytes });

    expect(second.id).toBe(first.id); // same content → same document
    expect(second.name).toBe('a.pdf'); // returns the EXISTING doc, not the new metadata
    // no second document, no second blob
    expect((db.prepare('SELECT COUNT(*) c FROM documents').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM document_blobs').get() as { c: number }).c).toBe(1);
    // no extra insert event for the dedup'd re-add
    expect(events.filter((e) => e.op === 'insert').length).toBe(insertsAfterFirst);
  });

  it('accepts a Uint8Array and round-trips the exact bytes via getBytes', () => {
    const u8 = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const doc = dal.add({ name: 'bin.dat', bytes: u8 });
    const back = dal.getBytes(doc.id);
    expect(back).toBeInstanceOf(Buffer);
    expect(Array.from(back!)).toEqual(Array.from(u8));
  });

  it('listLean returns metadata only — never bytes or extracted text', () => {
    dal.add({ name: 'r.pdf', role: 'resume', bytes: Buffer.from('one') });
    dal.add({ name: 'c.pdf', role: 'cover_letter', bytes: Buffer.from('two') });

    const page = dal.listLean();
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(2);
    for (const row of page.rows) {
      expect(row).not.toHaveProperty('bytes');
      expect(row).not.toHaveProperty('text');
      expect(row).not.toHaveProperty('keywords_json');
      expect(typeof row.size_bytes).toBe('number');
    }
  });

  it('setDefault flips exactly one default per role (and does not touch other roles)', () => {
    const r1 = dal.add({ name: 'r1.pdf', role: 'resume', bytes: Buffer.from('r1') }); // default
    const r2 = dal.add({ name: 'r2.pdf', role: 'resume', bytes: Buffer.from('r2') }); // not default
    const r3 = dal.add({ name: 'r3.pdf', role: 'resume', bytes: Buffer.from('r3') }); // not default
    const cover = dal.add({ name: 'cl.pdf', role: 'cover_letter', bytes: Buffer.from('cl') }); // its own default

    expect(dal.listLean().rows.find((d) => d.id === r1.id)!.is_default).toBe(true);

    dal.setDefault(r3.id);

    const rows = dal.listLean().rows;
    const defaultsForResume = rows.filter((d) => d.role === 'resume' && d.is_default);
    expect(defaultsForResume).toHaveLength(1);
    expect(defaultsForResume[0]!.id).toBe(r3.id);
    expect(rows.find((d) => d.id === r1.id)!.is_default).toBe(false);
    expect(rows.find((d) => d.id === r2.id)!.is_default).toBe(false);
    // cover_letter default untouched
    expect(rows.find((d) => d.id === cover.id)!.is_default).toBe(true);
    expect(events).toContainEqual({ table: 'documents', op: 'update', id: r3.id });
  });

  it('THROWS on oversized bytes (> 25 MiB) before any row is written', () => {
    const tooBig = Buffer.alloc(26_214_400 + 1);
    expect(() => dal.add({ name: 'huge.bin', bytes: tooBig })).toThrow(/exceeds max size/);
    expect((db.prepare('SELECT COUNT(*) c FROM documents').get() as { c: number }).c).toBe(0);
  });

  it('allows a document at exactly the 25 MiB boundary', () => {
    const atCap = Buffer.alloc(26_214_400);
    expect(() => dal.add({ name: 'cap.bin', bytes: atCap })).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) c FROM documents').get() as { c: number }).c).toBe(1);
  });

  it('addMissing records a metadata-only row with missing_file=1 and no blob', () => {
    const profileId = seedProfile(db);
    const doc = dal.addMissing({ name: 'gone.pdf', role: 'resume', originPath: 'C:/old/gone.pdf', profileId });

    expect(doc.missing_file).toBe(true);
    expect(doc.sha256).toBeNull();
    expect(doc.size_bytes).toBe(0);
    expect(doc.source).toBe('import_v11');
    expect(doc.origin_path).toBe('C:/old/gone.pdf');
    expect(doc.is_default).toBe(false); // nothing to attach → never default
    expect(dal.getBytes(doc.id)).toBeUndefined();
  });

  it('setText upserts extracted text + keywords and getText/getKeywords read them back', () => {
    const doc = dal.add({ name: 'r.pdf', role: 'resume', bytes: Buffer.from('pdf') });
    expect(dal.getText(doc.id)).toBeUndefined();

    dal.setText(doc.id, { text: 'senior engineer typescript', keywords: ['typescript', 'engineer'] });
    expect(dal.getText(doc.id)).toBe('senior engineer typescript');
    expect(dal.getKeywords(doc.id)).toEqual(['typescript', 'engineer']);

    // upsert overwrites, never duplicates
    dal.setText(doc.id, { text: 'updated body', keywords: [] });
    expect(dal.getText(doc.id)).toBe('updated body');
    expect(dal.getKeywords(doc.id)).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) c FROM document_text WHERE document_id=?').get(doc.id) as { c: number }).c).toBe(
      1,
    );
  });

  it('setText truncates text over the 512 KiB cap instead of throwing (schema CHECK would reject)', () => {
    const doc = dal.add({ name: 'r.pdf', role: 'resume', bytes: Buffer.from('pdf') });
    const huge = 'x'.repeat(524_288 + 100);
    expect(() => dal.setText(doc.id, { text: huge })).not.toThrow();
    expect(dal.getText(doc.id)!.length).toBe(524_288);
  });

  it('setText / setDefault THROW on an unknown document id', () => {
    expect(() => dal.setText('doc_nope', { text: 'x' })).toThrow(/no such document/);
    expect(() => dal.setDefault('doc_nope')).toThrow(/no such document/);
  });

  it('links a document to a profile (nullable FK) and persists the id', () => {
    const profileId = seedProfile(db);
    const doc = dal.add({ name: 'r.pdf', role: 'resume', bytes: Buffer.from('p'), profileId });
    expect(doc.profile_id).toBe(profileId);
  });

  it('a real add becomes the role default when the only prior doc of that role is a missing-file import', () => {
    const missing = dal.addMissing({ name: 'gone.pdf', role: 'resume', originPath: 'C:/x.pdf' });
    expect(missing.is_default).toBe(false); // missing-file rows are never default

    const real = dal.add({ name: 'real.pdf', role: 'resume', bytes: Buffer.from('real resume') });
    // role had NO default yet → the first real doc becomes it
    expect(real.is_default).toBe(true);
    const defaults = dal.listLean().rows.filter((d) => d.role === 'resume' && d.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(real.id);
  });

  it('getText / getKeywords are safe on a document that has no text sidecar row', () => {
    const doc = dal.add({ name: 'r.pdf', role: 'resume', bytes: Buffer.from('no text yet') });
    expect(dal.getText(doc.id)).toBeUndefined();
    expect(dal.getKeywords(doc.id)).toEqual([]); // defensive parse of an absent row → []
    // and on a completely unknown id
    expect(dal.getText('doc_nope')).toBeUndefined();
    expect(dal.getKeywords('doc_nope')).toEqual([]);
    expect(dal.getBytes('doc_nope')).toBeUndefined();
  });

  it('dedup across a different role does NOT fabricate a default for the other role', () => {
    const resume = dal.add({ name: 'a.pdf', role: 'resume', bytes: Buffer.from('shared bytes') });
    expect(resume.is_default).toBe(true);

    // same bytes re-added as a cover_letter → dedups to the existing RESUME doc, no cover_letter created
    const dup = dal.add({ name: 'b.pdf', role: 'cover_letter', bytes: Buffer.from('shared bytes') });
    expect(dup.id).toBe(resume.id);
    expect(dup.role).toBe('resume');

    const rows = dal.listLean().rows;
    expect(rows).toHaveLength(1);
    expect(rows.filter((d) => d.role === 'cover_letter')).toHaveLength(0);
  });

  it('getKeywords defensively drops non-string / non-array keywords_json (valid JSON, wrong shape)', () => {
    const doc = dal.add({ name: 'r.pdf', role: 'resume', bytes: Buffer.from('pdf') });
    dal.setText(doc.id, { text: 'body', keywords: ['ok'] });
    // valid JSON (passes the json_valid CHECK) but NOT an array of strings — the reader must not leak it
    db.prepare('UPDATE document_text SET keywords_json = ? WHERE document_id = ?').run('{"nope":1}', doc.id);
    expect(() => dal.getKeywords(doc.id)).not.toThrow();
    expect(dal.getKeywords(doc.id)).toEqual([]);

    // array with mixed types → only the strings survive
    db.prepare('UPDATE document_text SET keywords_json = ? WHERE document_id = ?').run('["a",2,null,"b"]', doc.id);
    expect(dal.getKeywords(doc.id)).toEqual(['a', 'b']);
  });
});
