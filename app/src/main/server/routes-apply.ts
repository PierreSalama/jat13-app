// Stage-2 APPLY + LEARN surface: the "Apply now" spine (drive ONE chosen job end-to-end), the
// Needs-You human queue, the answer-and-requeue loop, and the autopsy reads. Mounted by the
// integrator via mountApi's `extend` seam (exactly like mountDataRoutes):
//     extend: (api) => { mountDataRoutes(api, dataDeps); mountApplyRoutes(api, applyDeps); ... }
// so every route here inherits the X-JAT13-Token guard AND lands before the enveloped 404 catch-all.
//
// SCOPE (Stage 2): a SINGLE supervised apply. "Apply now" → runService.applyOne drives one run through
// the full loop; the answer ladder ENDS at park(needs_answer) (NO AI rung — Stage 4; NO discovery /
// scheduler / caps — Stage 3). Behavior ported from the proven v13.0.x api.ts (git cb25d19) into the
// rebuild conventions: ONE envelope (ok/err from @jat13/shared), lean params built conditionally
// (exactOptionalPropertyTypes), DAL-only data access (no raw SQL — grep-gated law). Every handler runs
// inside guard(): any throw answers an enveloped 500, never Hono's bare "Internal Server Error".

import type { Context, Hono } from 'hono';
import { ok, err } from '@jat13/shared';

// ---------------------------------------------------------------------------------------------
// The DAL surface these routes consume — a structural PORT of the Stage-1 DAL modules (like
// routes-data's DataDal). Declared with METHOD syntax on purpose: method params check bivariantly,
// so the real DAL's narrower enum-typed filters (state: RunState, …) still satisfy the plain-string
// filters routes pass through. The real `Dal` aggregate plugs in structurally; `autopsies` is the ONE
// module Stage 1 didn't ship — the integrator wires a real autopsies DAL that satisfies this shape
// (the runner writes autopsies on terminal runs; these routes only READ them).
// ---------------------------------------------------------------------------------------------

export interface LeanPage<T = unknown> {
  rows: T[];
  total: number;
}

/** The lean run fields the Needs-You enrichment spreads through + the state/apply reads use. */
export interface RunLeanRow {
  id: string;
  application_id: string;
  job_id: string;
  source: string;
  lane: string;
  state: string;
  park_kind: string | null;
  steps_count: number;
  queued_at: number;
  updated_at: number;
}

/** The hydrated run fields the enrichment + requeue reads need (dal.runs.get). */
export interface RunDetailRow {
  id: string;
  job_id: string;
  profile_id: string;
  state: string;
  park_kind: string | null;
  park_detail: string | null;
  pending_questions: unknown[];
}

/** Structural subset of the DAL's JobDetail — enrichment only reads title/company. */
export interface JobDetailRow {
  title?: string;
  company?: string;
}

/** Structural subset of answers.RecordInput used by POST /answers. */
export interface AnswerRecordInput {
  kind: 'qa' | 'field';
  label: string;
  value: string | null;
  keyNorm?: string;
  provenance?: string;
  locked?: boolean;
}

export interface ApplyDal {
  runs: {
    /** hydrated run (park fields + pending questions), or null. */
    get(id: string): RunDetailRow | null;
    /** lean page of runs; `state` filters to one FSM state (idx_runs_state). */
    listLean(input?: {
      state?: string;
      lane?: string;
      limit?: number;
      offset?: number;
    }): LeanPage<RunLeanRow>;
    /** per-run step transcript, ring-capped at 500 by the schema trigger. */
    getSteps(runId: string, opts?: { limit?: number }): unknown[];
  };
  jobs: {
    /** lean row + quarantined heavy text; undefined when absent. */
    getDetail(id: string): JobDetailRow | undefined;
  };
  answers: {
    /** upsert a learned answer; returns null when the DAL DROPS a sensitive key (never stored). */
    record(profileId: string, input: AnswerRecordInput): { id: string } | null;
  };
  profiles: {
    /** default profile (learned memory scope), or undefined pre-import. */
    getDefault(): { id: string } | undefined;
  };
  autopsies: {
    /** recent terminal-run post-mortems, newest first — a lean page. */
    listRecent(opts?: { limit?: number; offset?: number }): LeanPage;
    /** one full autopsy (step trail + proposal), or undefined when absent. */
    get(id: string): unknown;
  };
}

// ---------------------------------------------------------------------------------------------
// The run-service the "Apply now" spine drives through. A structural port so the route file never
// imports the engine; the integrator's real run-service (ported from cb25d19 engine/run-service.ts,
// narrowed to Stage-2 single-apply) plugs in. requeue owns the needs_human→queued transition AND
// wakes the driver — so the answer loop resumes where the page actually IS (resume-by-reclassify).
// ---------------------------------------------------------------------------------------------

export interface ApplyOneResult {
  runId: string;
}

export interface ApplyState {
  running: boolean;
  /** the run currently being driven (lean), or null when idle. */
  activeRun: unknown;
}

export interface ApplyRunService {
  /** drive ONE chosen application through the full apply loop; returns the created run id. */
  applyOne(applicationId: string): ApplyOneResult | Promise<ApplyOneResult>;
  /** stop the in-flight apply (best-effort; a needs_human wait is not force-killed). */
  stop(): void;
  /** snapshot: is the driver running + the active run, for GET /apply/state. */
  state(): ApplyState;
  /** re-queue a needs_human run after its question was answered (needs_human → queued). Returns
   *  true only if the run actually moved (not-found / wrong-state → false, never a throw). */
  requeue(runId: string): boolean | Promise<boolean>;
}

export interface ApplyDeps {
  dal: ApplyDal;
  runService: ApplyRunService;
}

// ---------------------------------------------------------------------------------------------
// helpers (self-contained — the sibling route files keep their own copies; no shared export leak)
// ---------------------------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function intParam(v: string | undefined, def: number): number {
  const n = v === undefined ? def : Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Body parse that never throws: malformed/absent JSON degrades to {} so validation answers an
 *  enveloped 400 instead of a bare Hono 500. */
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

type ApplyHandler = (c: Context) => Response | Promise<Response>;

/** Envelope-law backstop: NO handler may leak a throw to Hono's bare 500 text. */
function guard(h: ApplyHandler): ApplyHandler {
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

export function mountApplyRoutes(api: Hono, deps: ApplyDeps): void {
  const { dal, runService } = deps;

  // ---- "Apply now": drive ONE chosen application end-to-end -------------------------------------
  api.post('/apply/one', guard(async (c) => {
    const body = await readJson(c);
    const applicationId = body.applicationId;
    if (typeof applicationId !== 'string' || applicationId.trim() === '') {
      return c.json(err('bad_request', 'applicationId (string) is required'), 400);
    }
    const result = await runService.applyOne(applicationId);
    return c.json(ok({ runId: result.runId }));
  }));

  api.post('/apply/stop', guard((c) => {
    runService.stop();
    return c.json(ok({ running: false }));
  }));

  api.get('/apply/state', guard((c) => c.json(ok(runService.state()))));

  // ---- per-run step transcript (the live run theater + autopsy drawer) --------------------------
  // Bounded by the schema's 500-step ring; the DAL clamps the limit regardless of the query.
  api.get('/runs/:id/steps', guard((c) => {
    const id = c.req.param('id') ?? '';
    const limit = intParam(c.req.query('limit'), 500);
    return c.json(ok({ steps: dal.runs.getSteps(id, { limit }) }));
  }));

  // ---- Needs-You: the human queue, ENRICHED so the UI renders a real answer form ----------------
  // Ported from cb25d19 /needs-you: each needs_human (walls / real questions) and ready_for_review
  // (quarantined submits) run carries its park kind/detail, the exact pending questions, and the job
  // title+company — a generic form can't ask "was the CAPTCHA solved?" or the actual screening Q.
  api.get('/needs-you', guard((c) => {
    const enrich = (r: RunLeanRow) => {
      const full = dal.runs.get(r.id);
      const detail = full ? dal.jobs.getDetail(full.job_id) : undefined;
      return {
        ...r,
        park_kind: full?.park_kind ?? null,
        park_detail: full?.park_detail ?? null,
        questions: full?.pending_questions ?? [],
        job_title: detail?.title ?? null,
        company: detail?.company ?? null,
      };
    };
    const needsHuman = dal.runs.listLean({ state: 'needs_human', limit: 200 }).rows.map(enrich);
    const readyForReview = dal.runs.listLean({ state: 'ready_for_review', limit: 200 }).rows.map(enrich);
    return c.json(ok({ needsHuman, readyForReview }));
  }));

  // ---- answer a parked question → learn it (user, locked) → optionally requeue the run -----------
  // The answer saves to learned_answers with provenance 'user' + locked (the human's own truth,
  // ask-once-ever). SECURITY: a sensitive key is DROPPED by the DAL (record → null) → saved:false, so
  // an EEO/SSN/DOB/salary-history value never reaches the store even here. If runId is given the run
  // requeues (needs_human → queued) via the run-service, which resumes the drive by reclassifying the
  // live page.
  api.post('/answers', guard(async (c) => {
    const body = await readJson(c);
    const question = body.question;
    const value = body.value;
    if (typeof question !== 'string' || question.trim() === '') {
      return c.json(err('bad_request', 'question (string) is required'), 400);
    }
    if (typeof value !== 'string') {
      return c.json(err('bad_request', 'value (string) is required'), 400);
    }
    const runId = typeof body.runId === 'string' && body.runId ? body.runId : undefined;
    const keyNorm = typeof body.keyNorm === 'string' && body.keyNorm ? body.keyNorm : undefined;

    // Prefer the run's own profile when requeuing; else the default profile (memory is per-profile).
    let profileId: string | undefined;
    if (runId) profileId = dal.runs.get(runId)?.profile_id;
    profileId ??= dal.profiles.getDefault()?.id;
    if (!profileId) {
      return c.json(err('no_profile', 'no profile to attach the answer to (run the v11 import first)'), 404);
    }

    const input: AnswerRecordInput = {
      kind: 'qa',
      label: question,
      value,
      provenance: 'user',
      locked: true,
    };
    if (keyNorm) input.keyNorm = keyNorm;
    const rec = dal.answers.record(profileId, input);

    // requeue is explicitly gated on a given runId (proven cb25d19 behavior); the run-service's own
    // requeue is a no-op unless the run is actually in needs_human, so a stray runId can't corrupt state.
    const requeued = runId ? await runService.requeue(runId) : false;

    return c.json(ok({ saved: rec !== null, answerId: rec?.id ?? null, requeued }));
  }));

  // ---- autopsies: per-run post-mortems (System › Autopsies + the Applications drawer link) -------
  api.get('/autopsies', guard((c) => {
    const limit = intParam(c.req.query('limit'), 100);
    const offset = intParam(c.req.query('offset'), 0);
    return c.json(ok(dal.autopsies.listRecent({ limit, offset })));
  }));

  api.get('/autopsies/:id', guard((c) => {
    const id = c.req.param('id') ?? '';
    const a = dal.autopsies.get(id);
    return a === undefined || a === null
      ? c.json(err('not_found', `no such autopsy: ${id}`), 404)
      : c.json(ok(a));
  }));
}
