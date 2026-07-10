// Stage-1 data surface: READ-ONLY projections over the DAL + the v11 import wizard.
// Mounted by the integrator via mountApi's `extend` seam (or a direct call in api.ts):
//     extend: (api) => mountDataRoutes(api, deps)
// so every route here inherits the X-JAT13-Token guard AND lands before the enveloped 404
// catch-all. Behavior is ported from the proven v13.0.x api.ts (git cb25d19) into the rebuild
// conventions: ONE envelope (ok/err from @jat13/shared), lean params built conditionally
// (exactOptionalPropertyTypes), DAL-only data access (no raw SQL here — grep-gated law).
//
// The ONE non-envelope route: GET /documents/:id/download streams raw bytes (like the dev-drive
// screenshot) — everything else, success or failure, is the envelope. Every handler runs inside
// guard(): a storage/DAL throw answers an enveloped 500, never Hono's bare "Internal Server Error"
// (the route-walk contract test fires these routes against arbitrary DBs and must always parse).

import type { Context, Hono } from 'hono';
import { ok, err } from '@jat13/shared';
import type { ApiDeps } from './api.js';

// ---------------------------------------------------------------------------------------------
// The DAL surface these routes consume — a structural PORT of the proven Stage-1 DAL modules.
// Declared with METHOD syntax on purpose: method params check bivariantly, so the real DAL's
// narrower enum-typed filters (status: ApplicationStatus, state: RunState, …) still satisfy the
// plain-string filters routes pass through (unknown values just match zero rows — read-side).
// The real `Dal` aggregate plugs in structurally; tests pin the semantics with a real schema-v1 DB.
// ---------------------------------------------------------------------------------------------

export interface LeanPage<T = unknown> {
  rows: T[];
  total: number;
}

/** the metadata fields the download route reads — structural subset of the DAL's DocumentLean. */
export interface DocumentMeta {
  id: string;
  name: string;
  mime: string | null;
}

export interface DataDal {
  jobs: {
    listLean(params?: { limit?: number; offset?: number; q?: string; source?: string }): LeanPage;
    /** lean row + quarantined heavy text (description/fit); undefined when absent. */
    getDetail(id: string): unknown;
  };
  applications: {
    /** `q` matches the JOINED job title/company (applications carry neither). */
    listLean(opts?: { status?: string; q?: string; limit?: number; offset?: number }): LeanPage;
    /** zero-filled per-status counts inside a trailing window — THE funnel source of truth. */
    funnel(opts?: { days?: number }): Record<string, number>;
  };
  runs: {
    listLean(input?: { state?: string; limit?: number; offset?: number }): LeanPage;
  };
  emails: {
    listLean(opts?: { category?: string; limit?: number; offset?: number }): LeanPage;
    /** emails matched to one application — a page, newest-sent first. */
    listForApplication(applicationId: string): LeanPage;
    /** the suggestion review queue (match source = 'suggested'), joined to the pending match. */
    suggestions(opts?: { limit?: number; offset?: number }): LeanPage;
  };
  documents: {
    listLean(): LeanPage<DocumentMeta>;
    /** lean metadata for one document; undefined when absent. */
    get(id: string): DocumentMeta | undefined;
    add(input: {
      name: string;
      role?: string;
      label?: string;
      bytes: Buffer | Uint8Array;
      mime?: string;
      profileId?: string;
      source?: string;
    }): unknown;
    getBytes(id: string): Buffer | undefined;
    /** throws on an unknown id (routes translate to an enveloped 404). */
    setDefault(id: string): void;
    remove(id: string): boolean;
  };
  answers: {
    /** LEAN rows (no value/options text — payload discipline). */
    list(profileId: string, input?: { q?: string; limit?: number; offset?: number }): LeanPage;
    /** the FULL answer including value; undefined when absent. */
    get(id: string): unknown;
  };
  events: {
    timeline(applicationId: string, opts?: { limit?: number }): LeanPage;
    recent(opts?: { limit?: number; kinds?: readonly string[] }): LeanPage;
  };
  profiles: {
    /** default profile with PARSED data_json fields; undefined pre-import. */
    getDefault(): ({ id: string } & Record<string, unknown>) | undefined;
    /** lean list (no data_json) for the profile switcher. */
    list(): LeanPage;
    /** one hydrated profile; undefined when absent. */
    get(id: string): ({ id: string } & Record<string, unknown>) | undefined;
  };
}

/** The importer seam. The integrator wraps importer/v11.ts + gmail-creds.ts behind these two calls
 *  (closing over db/dal/unsealV11) so routes never import engine modules directly. */
export interface ImporterPort {
  /** the importer copies/snapshots the source itself → the live-v11 refusal is skipped. */
  snapshots?: boolean;
  /** dry-run: returns the ImportReport. Throws typed { code, message } on precondition failures. */
  plan(sourcePath: string): unknown;
  /** real import (+ optional Gmail creds migration). Returns ExecuteResult (+ gmail sub-result). */
  execute(sourcePath: string, opts: { migrateGmail: boolean }): unknown;
}

export interface DataDeps extends ApiDeps {
  dal: DataDal;
  importer: ImporterPort;
  /** override the "is v11 running?" gate (tests inject a deterministic stub). */
  v11Probe?: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** v11's loopback port — a FOREIGN identity (the legacy app we import from), deliberately not in
 *  @jat13/shared identity.ts, which owns only v13's own ports. */
const V11_HEALTH_URL = 'http://127.0.0.1:7744/health';

/** Live-process gate: a running v11 answers on :7744; importing then could read a half-written
 *  WAL snapshot. Belt to the importer's own lock-dir/copy suspenders. */
async function v11IsRunning(): Promise<boolean> {
  try {
    const res = await fetch(V11_HEALTH_URL, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

function intParam(v: string | undefined, def: number): number {
  const n = v === undefined ? def : Number(v);
  return Number.isFinite(n) ? n : def;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Map a thrown importer code ('V11_LOCK_PRESENT', 'NOT_FOUND', …) onto the envelope's snake_case
 *  contract; anything that can't be normalized falls back rather than breaking the shape. */
function snakeCode(e: unknown, fallback: string): string {
  const raw = (e as { code?: unknown } | null)?.code;
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  const code = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return /^[a-z][a-z0-9_]*$/.test(code) ? code : fallback;
}

/** Body parse that never throws: malformed/absent JSON degrades to {} so validation answers an
 *  enveloped 400 instead of a bare Hono 500 (the route walk fires '{}' at every POST). */
async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await c.req.json();
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type DataHandler = (c: Context) => Response | Promise<Response>;

/** Envelope-law backstop: NO handler may leak a throw to Hono's bare 500 text. */
function guard(h: DataHandler): DataHandler {
  return async (c) => {
    try {
      return await h(c);
    } catch (e) {
      return c.json(err('internal', errMsg(e)), 500);
    }
  };
}

/** roles a human may upload (schema also allows 'brief', which only the AI generator writes).
 *  Unknown role = enveloped 400, never a silent 'resume' default (loud-on-unknown law). */
const UPLOAD_ROLES = new Set(['resume', 'cover_letter', 'portfolio', 'transcript', 'other']);

// ---------------------------------------------------------------------------------------------
// the routes
// ---------------------------------------------------------------------------------------------

export function mountDataRoutes(api: Hono, deps: DataDeps): void {
  const { dal, importer } = deps;
  const probe = deps.v11Probe ?? v11IsRunning;

  // ---- summary (Command Center header): 90d funnel + needs-you stub + cheap totals -------------
  api.get('/summary', guard((c) => {
    const prof = dal.profiles.getDefault();
    return c.json(
      ok({
        funnel: dal.applications.funnel({ days: 90 }),
        // Stage-1 is read-only — the engine that parks runs on humans arrives in Stage 2/3. The key
        // ships now (stubbed 0) so the renderer contract is stable across stages.
        needsYou: 0,
        counts: {
          jobs: dal.jobs.listLean({ limit: 1 }).total,
          applications: dal.applications.listLean({ limit: 1 }).total,
          runs: dal.runs.listLean({ limit: 1 }).total,
          documents: dal.documents.listLean().total,
          emails: dal.emails.listLean({ limit: 1 }).total,
          answers: prof ? dal.answers.list(prof.id, { limit: 1 }).total : 0,
        },
      }),
    );
  }));

  // ---- jobs -------------------------------------------------------------------------------------
  api.get('/jobs', guard((c) => {
    const q = c.req.query();
    const p: { limit: number; offset: number; q?: string; source?: string } = {
      limit: intParam(q.limit, 100),
      offset: intParam(q.offset, 0),
    };
    if (q.q) p.q = q.q;
    if (q.source) p.source = q.source;
    return c.json(ok(dal.jobs.listLean(p)));
  }));

  api.get('/jobs/:id', guard((c) => {
    const id = c.req.param('id') ?? '';
    const d = dal.jobs.getDetail(id);
    return d === undefined ? c.json(err('not_found', `no such job: ${id}`), 404) : c.json(ok(d));
  }));

  // ---- applications -----------------------------------------------------------------------------
  api.get('/applications', guard((c) => {
    const q = c.req.query();
    const p: { status?: string; q?: string; limit: number; offset: number } = {
      limit: intParam(q.limit, 100),
      offset: intParam(q.offset, 0),
    };
    if (q.status) p.status = q.status;
    if (q.q) p.q = q.q;
    return c.json(ok(dal.applications.listLean(p)));
  }));

  // detail drawer: the append-only event history + matched emails, in one round-trip.
  // both halves are pages ({rows,total}) so the drawer can paginate either side.
  api.get('/applications/:id/timeline', guard((c) => {
    const id = c.req.param('id') ?? '';
    return c.json(ok({ events: dal.events.timeline(id), emails: dal.emails.listForApplication(id) }));
  }));

  // ---- runs (read-only at Stage 1 — imported history) --------------------------------------------
  api.get('/runs', guard((c) => {
    const q = c.req.query();
    const p: { state?: string; limit: number; offset: number } = {
      limit: intParam(q.limit, 100),
      offset: intParam(q.offset, 0),
    };
    if (q.state) p.state = q.state;
    return c.json(ok(dal.runs.listLean(p)));
  }));

  // ---- inbox ------------------------------------------------------------------------------------
  api.get('/emails', guard((c) => {
    const q = c.req.query();
    const p: { category?: string; limit: number; offset: number } = {
      limit: intParam(q.limit, 100),
      offset: intParam(q.offset, 0),
    };
    if (q.category) p.category = q.category;
    return c.json(ok(dal.emails.listLean(p)));
  }));

  api.get('/emails/suggestions', guard((c) => c.json(ok(dal.emails.suggestions()))));

  // ---- documents (the ONE list mutation surface Stage 1 ships: library management) ---------------
  api.get('/documents', guard((c) => c.json(ok(dal.documents.listLean())))); // page → ok() straight, never re-wrapped

  api.post('/documents', guard(async (c) => {
    // multipart upload: file + optional role/label. The browser FormData carries the bytes.
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json(err('bad_form', 'expected multipart/form-data with a "file" field'), 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) return c.json(err('no_file', 'multipart field "file" is required'), 400);

    const roleRaw = form.get('role');
    const role = typeof roleRaw === 'string' && roleRaw.length > 0 ? roleRaw : 'resume';
    if (!UPLOAD_ROLES.has(role)) {
      return c.json(err('bad_role', `unknown document role "${role}" (expected ${[...UPLOAD_ROLES].join(' | ')})`), 400);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const prof = dal.profiles.getDefault();
    const add: Parameters<DataDal['documents']['add']>[0] = {
      name: (file.name || 'document').slice(0, 256),
      role,
      bytes,
      source: 'upload',
    };
    if (file.type) add.mime = file.type;
    if (prof) add.profileId = prof.id;
    const label = form.get('label');
    if (typeof label === 'string' && label) add.label = label.slice(0, 128);

    try {
      return c.json(ok({ doc: dal.documents.add(add) }));
    } catch (e) {
      return c.json(err('upload_failed', errMsg(e)), 400);
    }
  }));

  // THE one non-envelope data route: raw bytes with real content-type/disposition, exactly like
  // the dev-drive screenshot. Errors (no blob / missing-file import) stay enveloped JSON.
  api.get('/documents/:id/download', guard((c) => {
    const id = c.req.param('id') ?? '';
    const bytes = dal.documents.getBytes(id);
    if (!bytes) return c.json(err('not_found', `no stored bytes for document: ${id}`), 404);
    const meta = dal.documents.get(id);
    // sanitize for the quoted filename param: strip quotes/backslashes AND CR/LF (header injection).
    const filename = (meta?.name ?? 'document').replace(/[\r\n"\\]/g, '').slice(0, 200) || 'document';
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': meta?.mime ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  }));

  api.post('/documents/:id/default', guard((c) => {
    const id = c.req.param('id') ?? '';
    try {
      dal.documents.setDefault(id);
      return c.json(ok({ id, is_default: true }));
    } catch (e) {
      return c.json(err('not_found', errMsg(e)), 404);
    }
  }));

  api.delete('/documents/:id', guard((c) => {
    const id = c.req.param('id') ?? '';
    return dal.documents.remove(id)
      ? c.json(ok({ deleted: true }))
      : c.json(err('not_found', `no such document: ${id}`), 404);
  }));

  // ---- profile + learned memory -------------------------------------------------------------------
  api.get('/profile', guard((c) => {
    const prof = dal.profiles.getDefault();
    return prof
      ? c.json(ok(prof))
      : c.json(err('no_profile', 'no default profile yet — run the v11 import (or create a profile)'), 404);
  }));
  // the Profile page uses the plural surface: a lean list + the hydrated one it opens.
  api.get('/profiles', guard((c) => c.json(ok(dal.profiles.list()))));
  api.get('/profiles/:id', guard((c) => {
    const p = dal.profiles.get(c.req.param('id') ?? '');
    return p === undefined ? c.json(err('not_found', 'no such profile'), 404) : c.json(ok(p));
  }));

  api.get('/answers', guard((c) => {
    const q = c.req.query();
    // scoped to the default profile (learned memory is per-profile, FK-cascaded); explicit
    // ?profileId overrides for the multi-profile future. Pre-import: an empty page, not an error.
    const profileId = q.profileId || dal.profiles.getDefault()?.id;
    if (!profileId) return c.json(ok({ rows: [], total: 0 }));
    const p: { q?: string; limit: number } = { limit: intParam(q.limit, 200) };
    if (q.q) p.q = q.q;
    return c.json(ok(dal.answers.list(profileId, p)));
  }));

  // the FULL answer (value included) — loaded on demand by the memory browser, never in the list.
  api.get('/answers/:id', guard((c) => {
    const id = c.req.param('id') ?? '';
    const a = dal.answers.get(id);
    return a === undefined ? c.json(err('not_found', `no such answer: ${id}`), 404) : c.json(ok(a));
  }));

  // ---- activity ledger ------------------------------------------------------------------------------
  const recentEvents = (c: import('hono').Context) => {
    const q = c.req.query();
    const p: { limit: number; kinds?: readonly string[] } = { limit: intParam(q.limit, 100) };
    if (q.kind) p.kinds = [q.kind]; // unknown kinds yield an empty page (DAL filters them out)
    return c.json(ok(dal.events.recent(p)));
  };
  api.get('/events', guard(recentEvents));
  api.get('/events/recent', guard(recentEvents)); // Activity page uses the explicit /recent name

  // ---- v11 import wizard ------------------------------------------------------------------------------
  api.post('/import/plan', guard(async (c) => {
    const body = await readJson(c);
    const sourcePath = body.sourcePath;
    if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
      return c.json(err('bad_request', 'sourcePath (string) is required'), 400);
    }
    if (!importer.snapshots && (await probe())) {
      return c.json(err('v11_running', 'JAT v11 is running (answers on :7744) — quit it first so the import reads a consistent snapshot.'), 409);
    }
    try {
      return c.json(ok(await importer.plan(sourcePath)));
    } catch (e) {
      return c.json(err(snakeCode(e, 'import_plan_failed'), errMsg(e)), 400);
    }
  }));

  api.post('/import/execute', guard(async (c) => {
    const body = await readJson(c);
    const sourcePath = body.sourcePath;
    if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
      return c.json(err('bad_request', 'sourcePath (string) is required'), 400);
    }
    if (!importer.snapshots && (await probe())) {
      return c.json(err('v11_running', 'JAT v11 is running (answers on :7744) — quit it first so the import reads a consistent snapshot.'), 409);
    }
    try {
      return c.json(ok(await importer.execute(sourcePath, { migrateGmail: body.migrateGmail === true })));
    } catch (e) {
      return c.json(err(snakeCode(e, 'import_failed'), errMsg(e)), 400);
    }
  }));
}
