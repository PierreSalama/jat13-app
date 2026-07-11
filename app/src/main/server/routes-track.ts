// Stage-3 TRACK + PERMANENT-DISMISS surface — Pierre's #1 scar, at the extension's front door.
// Mounted by the integrator via mountApi's `extend` seam (exactly like mountDataRoutes / mountApplyRoutes):
//     extend: (api) => { mountDataRoutes(...); mountApplyRoutes(...); mountTrackRoutes(api, { dal, ingest, isJobPosting }); }
// so every route inherits the X-JAT13-Token guard AND lands before the enveloped 404 catch-all.
//
// TWO structural fixes for the v11 scar, both enforced on EVERY /track:
//   1) is-this-a-job GATE — the extension popup "Track this page" hits an arbitrary tab; a non-posting
//      must NEVER become a phantom job. `isJobPosting` (the ONE gate, shared with the discovery ingest
//      path — lives in discovery/ingest.ts) decides; a "no" returns { tracked:false, reason:'not_a_job' }
//      and the UI shows "this doesn't look like a job". NO row is created.
//   2) PERMANENT dismiss — a posting whose norm_key / job_url_norm / company_key is in `dismissals`
//      returns { tracked:false, reason:'dismissed' } and can never come back, even under a fresh row id.
//      The dismiss keys are computed with the SAME normalizers the jobs DAL dedups by, so a re-track of a
//      dismissed posting resolves to its dismissal every time.
//
// Conventions match the sibling route files: ONE envelope (ok/err from @jat13/shared), DAL taken as a
// STRUCTURAL port (this file never imports the engine / discovery concretes — the integrator wires the
// real Dal + ingest + gate), lean option objects built conditionally (exactOptionalPropertyTypes), every
// handler inside guard() so a throw answers an enveloped 500. The ONE concrete import is the pure
// normalizer pair from the DAL index (the shared dedup-key source until @jat13/shared grows a norm
// module) — importing THEM, not reimplementing, is what keeps the /track keys aligned with the stored ones.

import type { Context, Hono } from 'hono';
import { ok, err } from '@jat13/shared';
import { normKey, normJobUrl } from '../db/dal/index.js';

// ---------------------------------------------------------------------------------------------
// The DAL surface these routes consume — a structural PORT of db/dal/dismissals.ts. Method syntax
// (bivariant params) lets the real DismissalsDal (enum-typed reason) satisfy the looser string here.
// ---------------------------------------------------------------------------------------------

export interface LeanPage<T = unknown> {
  rows: T[];
  total: number;
}

export interface DismissalsPort {
  /** any of {normKey,urlNorm,companyKey} present in `dismissals` → true (the ingest gate). */
  isDismissed(keys: { normKey?: string; urlNorm?: string; companyKey?: string }): boolean;
  /** permanently dismiss a job by id; null when the id is unknown (→ 404). */
  dismiss(
    jobId: string,
    opts?: { reason?: string; note?: string | null },
  ): { dismissed: boolean } | null;
  /** recent dismissals, one entry per dismissed job. */
  listRecent(opts?: { limit?: number; offset?: number }): LeanPage;
}

export interface TrackDal {
  dismissals: DismissalsPort;
}

// ---------------------------------------------------------------------------------------------
// The job-GATE + the ingest function — injected (the integrator wires both from discovery/ingest.ts).
// isJobPosting is the ONE gate, shared with the discovery ingest path so /track and discovery reject
// the same non-postings. ingest owns dedup (jobs.upsert) + application ensure + the 'created' event.
// ---------------------------------------------------------------------------------------------

/** The is-this-a-job gate. Pure + host-neutral; returns true only for a real posting. */
export type JobGate = (input: { url: string; title?: string; company?: string }) => boolean;

export interface IngestInput {
  url: string;
  title?: string;
  company?: string;
  /** discovery lane / origin; ingest defaults it (e.g. 'extension') when omitted. */
  source?: string;
}

export interface IngestResult {
  applicationId: string;
  jobId: string;
}

/** Create-or-dedup a job from a tracked page and ensure its application (per default profile). */
export type IngestFn = (input: IngestInput) => IngestResult | Promise<IngestResult>;

export interface TrackDeps {
  dal: TrackDal;
  ingest: IngestFn;
  isJobPosting: JobGate;
}

// ---------------------------------------------------------------------------------------------
// dismiss reasons the /jobs/:id/dismiss route accepts (binds to dismissals.reason CHECK). Unknown =
// enveloped 400, never a silent 'user' default (loud-on-unknown law). Kept local — no cross-file leak.
// ---------------------------------------------------------------------------------------------
const DISMISS_REASONS: ReadonlySet<string> = new Set([
  'user', 'not_a_job', 'spam', 'irrelevant', 'off_target',
]);

// ---------------------------------------------------------------------------------------------
// helpers (self-contained copies — the sibling route files keep their own; no shared export leak)
// ---------------------------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function intParam(v: string | undefined, def: number): number {
  const n = v === undefined ? def : Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Body parse that never throws: malformed/absent JSON → {} so validation answers an enveloped 400. */
async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await c.req.json();
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

type TrackHandler = (c: Context) => Response | Promise<Response>;

/** Envelope-law backstop: NO handler may leak a throw to Hono's bare 500 text. */
function guard(h: TrackHandler): TrackHandler {
  return async (c) => {
    try {
      return await h(c);
    } catch (e) {
      return c.json(err('internal', errMsg(e)), 500);
    }
  };
}

// ---------------------------------------------------------------------------------------------
// the routes
// ---------------------------------------------------------------------------------------------

export function mountTrackRoutes(api: Hono, deps: TrackDeps): void {
  const { dal, ingest, isJobPosting } = deps;

  // ---- POST /track — the extension "Track this page" front door --------------------------------
  // GATE → DISMISS-CHECK → ingest. Either gate returns tracked:false WITHOUT creating a job (the scar:
  // v11 created phantom jobs from non-postings AND let dismissed ones come back). ok() every time — a
  // rejected track is a normal outcome the UI renders, not an HTTP error.
  api.post('/track', guard(async (c) => {
    const body = await readJson(c);
    const url = body.url;
    if (typeof url !== 'string' || url.trim() === '') {
      return c.json(err('bad_request', 'url (string) is required'), 400);
    }
    const title = typeof body.title === 'string' ? body.title : undefined;
    const company = typeof body.company === 'string' ? body.company : undefined;

    // 1) is-this-a-job GATE — reject non-postings BEFORE any row exists.
    const gateInput: { url: string; title?: string; company?: string } = { url };
    if (title !== undefined) gateInput.title = title;
    if (company !== undefined) gateInput.company = company;
    if (!isJobPosting(gateInput)) {
      return c.json(ok({ tracked: false, reason: 'not_a_job' }));
    }

    // 2) PERMANENT-DISMISS gate — a dismissed posting can never return. Keys computed with the SAME
    // normalizers the jobs DAL dedups by (norm_key = company+title, url = canonical, company = slug).
    const urlNorm = normJobUrl(url);
    const nk = normKey(`${company ?? ''} ${title ?? ''}`);
    const companyKey = normKey(company ?? '');
    const keys: { normKey?: string; urlNorm?: string; companyKey?: string } = {};
    if (nk) keys.normKey = nk;
    if (urlNorm) keys.urlNorm = urlNorm;
    if (companyKey) keys.companyKey = companyKey;
    if (dal.dismissals.isDismissed(keys)) {
      return c.json(ok({ tracked: false, reason: 'dismissed' }));
    }

    // 3) ingest → job (deduped) + application. ingest also consults dismissals as a belt (both ingest
    // paths gate), but the check above short-circuits before any work here.
    const ingestInput: IngestInput = { url };
    if (title !== undefined) ingestInput.title = title;
    if (company !== undefined) ingestInput.company = company;
    const res = await ingest(ingestInput);
    return c.json(ok({ tracked: true, applicationId: res.applicationId, jobId: res.jobId }));
  }));

  // ---- POST /jobs/:id/dismiss — the dismiss button (Applications table / Auto-Apply queue) ------
  // Permanent: writes all three identity keys + hides the row + withdraws its application. The button
  // in the UI (agent E) calls this.
  api.post('/jobs/:id/dismiss', guard(async (c) => {
    const id = c.req.param('id') ?? '';
    const body = await readJson(c);
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    if (reason !== undefined && !DISMISS_REASONS.has(reason)) {
      return c.json(
        err('bad_reason', `unknown dismiss reason "${reason}" (expected ${[...DISMISS_REASONS].join(' | ')})`),
        400,
      );
    }
    const opts: { reason?: string; note?: string | null } = {};
    if (reason !== undefined) opts.reason = reason;
    if (typeof body.note === 'string') opts.note = body.note;

    const res = dal.dismissals.dismiss(id, opts);
    if (res === null) return c.json(err('not_found', `no such job: ${id}`), 404);
    return c.json(ok({ dismissed: true }));
  }));

  // ---- GET /dismissals — the "recently dismissed" review list -----------------------------------
  api.get('/dismissals', guard((c) => {
    const limit = intParam(c.req.query('limit'), 100);
    const offset = intParam(c.req.query('offset'), 0);
    return c.json(ok(dal.dismissals.listRecent({ limit, offset })));
  }));
}
