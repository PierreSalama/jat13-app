// documents DAL — bytes live IN the database (a disk restore already cost Aurora once). Three tables:
//   documents      — LEAN metadata row (what listLean ships; NEVER the bytes)
//   document_blobs  — the file bytes (BLOB), 1:1 with a document, dedup'd by sha256
//   document_text   — extracted plaintext + keywords for the command palette / matching
//
// Dedup law: identical bytes (same sha256) yield ONE blob. `add` of already-stored bytes returns the
// existing document instead of inserting a second copy. Default law: exactly one is_default per role.

import { createHash } from 'node:crypto';
import type { DalContext, DomainEvent, LeanPage } from './util.js';
import { makeStmtCache } from './util.js';

// ---- caps (mirror the migration-001 CHECK constraints; we reject BEFORE hitting SQLite) ----------
const MAX_BYTES = 26_214_400; // documents.size_bytes CHECK (<= 25 MiB)
const MAX_TEXT = 524_288; //     document_text.text CHECK (<= 512 KiB)

/** documents.role vocabulary (CHECK in 001). */
export type DocumentRole = 'resume' | 'cover_letter' | 'portfolio' | 'transcript' | 'other';
/** documents.source vocabulary (CHECK in 001). */
export type DocumentSource = 'upload' | 'application' | 'folder' | 'import_v11';

/** The LEAN metadata row — everything listLean/get returns. NO bytes, NO extracted text. */
export interface DocumentLean {
  id: string;
  profile_id: string | null;
  name: string;
  role: DocumentRole;
  label: string | null;
  mime: string | null;
  size_bytes: number;
  sha256: string | null;
  is_default: boolean;
  source: DocumentSource;
  origin_path: string | null;
  missing_file: boolean;
  created_at: number;
  updated_at: number;
}

export interface AddDocumentInput {
  name: string;
  role?: DocumentRole;
  label?: string;
  bytes: Buffer | Uint8Array;
  mime?: string;
  profileId?: string;
  source?: DocumentSource;
  originPath?: string;
}

export interface AddMissingInput {
  name: string;
  role: DocumentRole;
  originPath: string;
  profileId?: string;
}

export interface SetTextInput {
  text: string;
  keywords?: string[];
}

// ---- row shapes as they come back from SQLite (snake_case, 0/1 ints) ------------------------------
interface DocumentRow {
  id: string;
  profile_id: string | null;
  name: string;
  role: DocumentRole;
  label: string | null;
  mime: string | null;
  size_bytes: number;
  sha256: string | null;
  is_default: number;
  source: DocumentSource;
  origin_path: string | null;
  missing_file: number;
  created_at: number;
  updated_at: number;
}

const LEAN_COLS =
  'id, profile_id, name, role, label, mime, size_bytes, sha256, is_default, source, origin_path, missing_file, created_at, updated_at';

function toLean(r: DocumentRow): DocumentLean {
  return {
    id: r.id,
    profile_id: r.profile_id,
    name: r.name,
    role: r.role,
    label: r.label,
    mime: r.mime,
    size_bytes: r.size_bytes,
    sha256: r.sha256,
    is_default: r.is_default === 1,
    source: r.source,
    origin_path: r.origin_path,
    missing_file: r.missing_file === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Normalize whatever bytes arrive to a Buffer once, so hashing + the BLOB bind agree. */
function asBuffer(bytes: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

/** Defensive JSON.parse for a string[] column; anything non-array-of-strings collapses to []. */
function parseKeywords(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

export function makeDocumentsDal(ctx: DalContext) {
  const stmt = makeStmtCache(ctx.db);

  function emit(op: DomainEvent['op'], id: string, patch?: Record<string, unknown>): void {
    const evt: DomainEvent = patch === undefined ? { table: 'documents', op, id } : { table: 'documents', op, id, patch };
    ctx.emit(evt);
  }

  function getRow(id: string): DocumentRow | undefined {
    return stmt(`SELECT ${LEAN_COLS} FROM documents WHERE id = ?`).get(id) as DocumentRow | undefined;
  }

  function findBySha(sha256: string): DocumentRow | undefined {
    return stmt(`SELECT ${LEAN_COLS} FROM documents WHERE sha256 = ?`).get(sha256) as DocumentRow | undefined;
  }

  /** True when this role has NO default document yet (so the first insert becomes the default). */
  function roleHasDefault(role: DocumentRole): boolean {
    const row = stmt('SELECT 1 AS x FROM documents WHERE role = ? AND is_default = 1 LIMIT 1').get(role) as
      | { x: number }
      | undefined;
    return row !== undefined;
  }

  /**
   * Store bytes as a document. If a document with these exact bytes (same sha256) already exists,
   * return THAT document — no second blob is written (content-addressed dedup). Otherwise insert the
   * metadata row + the blob atomically. First document of a role becomes that role's default.
   */
  function add(input: AddDocumentInput): DocumentLean {
    const buf = asBuffer(input.bytes);
    const size = buf.length;
    if (size > MAX_BYTES) {
      throw new Error(`document exceeds max size: ${size} > ${MAX_BYTES} bytes`);
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');

    // Fast path OUTSIDE the tx: identical content already stored → hand back the existing doc.
    const existing = findBySha(sha256);
    if (existing) return toLean(existing);

    const role: DocumentRole = input.role ?? 'resume';
    const now = ctx.now();
    const id = ctx.newId('doc');
    const isDefault = roleHasDefault(role) ? 0 : 1;

    const insert = ctx.db.transaction((): DocumentRow => {
      // Re-check inside the tx (another writer could have inserted the same sha between check and here).
      const raced = findBySha(sha256);
      if (raced) return raced;

      stmt(
        `INSERT INTO documents
           (id, profile_id, name, role, label, mime, size_bytes, sha256, is_default, source, origin_path, missing_file, created_at, updated_at)
         VALUES
           (@id, @profile_id, @name, @role, @label, @mime, @size_bytes, @sha256, @is_default, @source, @origin_path, 0, @created_at, @updated_at)`,
      ).run({
        id,
        profile_id: input.profileId ?? null,
        name: input.name,
        role,
        label: input.label ?? null,
        mime: input.mime ?? null,
        size_bytes: size,
        sha256,
        is_default: isDefault,
        source: input.source ?? 'upload',
        origin_path: input.originPath ?? null,
        created_at: now,
        updated_at: now,
      });
      stmt('INSERT INTO document_blobs (document_id, bytes) VALUES (?, ?)').run(id, buf);
      return getRow(id)!;
    });

    const row = insert();
    // If the tx returned a raced-in existing row, it isn't ours — don't emit an insert for it.
    if (row.id !== id) return toLean(row);
    const lean = toLean(row);
    emit('insert', id, lean as unknown as Record<string, unknown>);
    return lean;
  }

  /**
   * Importer path: record a document whose FILE is missing (no bytes on disk to carry over). Writes a
   * metadata-only row with missing_file=1 and no blob. Never made default (there's nothing to attach).
   */
  function addMissing(input: AddMissingInput): DocumentLean {
    const now = ctx.now();
    const id = ctx.newId('doc');
    stmt(
      `INSERT INTO documents
         (id, profile_id, name, role, label, mime, size_bytes, sha256, is_default, source, origin_path, missing_file, created_at, updated_at)
       VALUES
         (@id, @profile_id, @name, @role, NULL, NULL, 0, NULL, 0, 'import_v11', @origin_path, 1, @created_at, @updated_at)`,
    ).run({
      id,
      profile_id: input.profileId ?? null,
      name: input.name,
      role: input.role,
      origin_path: input.originPath,
      created_at: now,
      updated_at: now,
    });
    const lean = toLean(getRow(id)!);
    emit('insert', id, lean as unknown as Record<string, unknown>);
    return lean;
  }

  /** Upsert the extracted-text sidecar for a document. Text is capped at 512 KiB (truncated, not thrown). */
  function setText(id: string, input: SetTextInput): void {
    const doc = getRow(id);
    if (!doc) throw new Error(`no such document: ${id}`);
    const text = input.text.length > MAX_TEXT ? input.text.slice(0, MAX_TEXT) : input.text;
    const keywords = Array.isArray(input.keywords) ? input.keywords.filter((k) => typeof k === 'string') : [];
    const now = ctx.now();
    ctx.db.transaction(() => {
      stmt(
        `INSERT INTO document_text (document_id, text, keywords_json, indexed_at)
         VALUES (@document_id, @text, @keywords_json, @indexed_at)
         ON CONFLICT(document_id) DO UPDATE SET
           text = excluded.text,
           keywords_json = excluded.keywords_json,
           indexed_at = excluded.indexed_at`,
      ).run({ document_id: id, text, keywords_json: JSON.stringify(keywords), indexed_at: now });
    })();
    emit('update', id, { indexedAt: now });
  }

  /** All document metadata (NEVER bytes, NEVER extracted text), newest role-default first. */
  function listLean(): LeanPage<DocumentLean> {
    const rows = stmt(
      `SELECT ${LEAN_COLS} FROM documents ORDER BY role ASC, is_default DESC, updated_at DESC`,
    ).all() as DocumentRow[];
    const total = (stmt('SELECT COUNT(*) AS c FROM documents').get() as { c: number }).c;
    return { rows: rows.map(toLean), total };
  }

  /** The raw file bytes for a document, or undefined if there's no blob (e.g. a missing-file import). */
  function getBytes(id: string): Buffer | undefined {
    const row = stmt('SELECT bytes FROM document_blobs WHERE document_id = ?').get(id) as
      | { bytes: Buffer }
      | undefined;
    return row?.bytes;
  }

  /** The extracted plaintext for a document, or undefined if none has been set. */
  function getText(id: string): string | undefined {
    const row = stmt('SELECT text FROM document_text WHERE document_id = ?').get(id) as
      | { text: string }
      | undefined;
    return row?.text;
  }

  /** The extracted keywords for a document (empty array if none set). */
  function getKeywords(id: string): string[] {
    const row = stmt('SELECT keywords_json FROM document_text WHERE document_id = ?').get(id) as
      | { keywords_json: string }
      | undefined;
    return parseKeywords(row?.keywords_json);
  }

  /**
   * Make `id` the default document for ITS role: clear is_default on every doc of that role, then set
   * it on this one. Atomic, so the "exactly one default per role" invariant never briefly breaks (and
   * the partial unique index idx_documents_default-style guard can't fire mid-flight).
   */
  function setDefault(id: string): void {
    const doc = getRow(id);
    if (!doc) throw new Error(`no such document: ${id}`);
    const now = ctx.now();
    ctx.db.transaction(() => {
      stmt('UPDATE documents SET is_default = 0, updated_at = @now WHERE role = @role AND is_default = 1').run({
        now,
        role: doc.role,
      });
      stmt('UPDATE documents SET is_default = 1, updated_at = @now WHERE id = @id').run({ now, id });
    })();
    emit('update', id, { is_default: true, role: doc.role });
  }

  return {
    add,
    addMissing,
    setText,
    listLean,
    getBytes,
    getText,
    getKeywords,
    setDefault,
  };
}
