// Stage-3 MISSION-CONTROL surface: full supervised auto-apply (the lane scheduler start/stop + its
// per-lane state), the fit-ordered queue with skip-floor reasons, the four-source discovery status +
// manual sweep, the auto-apply/discovery SETTINGS read/write, the Needs-You wall-dismiss hygiene edge,
// and Pierre's PERMANENT job dismiss. Mounted by the integrator via mountApi's `extend` seam alongside
// the sibling Stage-1/2 route files:
//     extend: (api) => { mountDataRoutes(...); mountApplyRoutes(...); mountLearnApi(...); mountAutoRoutes(api, { dal, runService, discovery }); }
// so every route inherits the X-JAT13-Token guard AND lands before the enveloped 404 catch-all.
//
// PATH NOTE (deliberate, documented): the supervised controls live under `/auto/*`, NOT `/apply/*`.
// routes-apply.ts (shipped Stage 2) already owns `POST /apply/stop` and `GET /apply/state` for the
// single-apply spine; re-registering those exact method+path pairs here would double-register on the
// same Hono sub-app (first handler wins — a latent, order-dependent bug). `/auto/*` is collision-free
// and reads honestly ("auto-apply", the supervised scheduler) next to `/apply/one` (drive one job).
//
// CONVENTIONS (ported from routes-apply.ts): ONE envelope (ok/err from @jat13/shared); every handler
// wrapped in guard() so a throw answers an enveloped 500, never Hono's bare text; the run-service /
// discovery / dal are consumed through STRUCTURAL ports (method syntax → bivariant params), so this
// file never imports the engine and the real objects plug in unchanged; lean params built conditionally
// (exactOptionalPropertyTypes); no raw SQL (grep-gated law — every DB touch is a DAL method).

import type { Context, Hono } from 'hono';
import { ok, err } from '@jat13/shared';

// ---------------------------------------------------------------------------------------------
// the supervised auto-apply scheduler (Stage 3). The real engine/run-service.ts — the Stage-2
// single-apply spine with the cb25d19 pump + lane scheduler restored — plugs in structurally.
// ---------------------------------------------------------------------------------------------

/** One lane's live pacing card (GET /auto/state). All counts are within a rolling 24h window; caps
 *  read the apply_ledger (the ONE authority). `breaker` is null when healthy, else the pause reason. */
export interface LaneState {
  lane: string; // 'linkedin' | 'indeed' | 'ats'
  queued: number;
  inflight: number; // slot-holding runs (busy = one SQL query, §3.3)
  submittedToday: number;
  parkedToday?: number;
  failedToday?: number;
  skippedToday?: number;
  needsYou?: number;
  cap?: number | null; // rolling-24h submit cap (linkedin 45); null/absent = uncapped lane
  capRemaining?: number | null;
  breaker?: string | null; // null = healthy; else the consecutive-failure pause reason
  pausedUntil?: number | null;
}

/** GET /auto/state payload — the whole mission-control status in one lean read. */
export interface AutoState {
  running: boolean;
  lanes: LaneState[];
  /** optional single-apply spine bridge (routes-apply's activeRun) so one poll covers the theater too. */
  activeRun?: unknown;
}

/** One upcoming apply the scheduler will drive next (GET /auto/queue) — the fit×freshness ordering. */
export interface QueueEntry {
  runId?: string; // present once enqueued; absent for a not-yet-enqueued eligible job
  jobId: string;
  applicationId?: string;
  title: string | null;
  company: string | null;
  lane: string;
  source: string;
  fit: number | null; // 0..100
  reasons: string[]; // why this fit (fit_scores.reasons_json)
  state?: string; // run state when already enqueued
}

/** A job the skip-floor / cap / adapter gate held back — shown with its reason (locked-decision 6). */
export interface SkipEntry {
  jobId: string;
  title: string | null;
  company: string | null;
  fit: number | null;
  floor?: number | null;
  reason: string; // e.g. 'below_fit_floor' | 'over_cap' | 'no_adapter' | 'saturated' | 'already_applied'
}

export interface AutoQueue {
  upcoming: QueueEntry[];
  skipped: SkipEntry[];
}

export interface AutoRunService {
  /** begin full supervised auto-apply (pump → lane scheduler → driver). */
  start(): void | Promise<void>;
  /** cooperative stop — in-flight drives finish/park; no new drive or pump runs. */
  stop(): void | Promise<void>;
  /** the mission-control status: running + per-lane pacing/caps/breakers. */
  state(): AutoState | Promise<AutoState>;
  /** the fit-ordered upcoming queue + the skip-floor decisions (with reasons). */
  queue(): AutoQueue | Promise<AutoQueue>;
}

// ---------------------------------------------------------------------------------------------
// the four-source discovery engine. The real engine/discovery service (JobSpy subprocess +
// browser-scrape + ATS JSON boards + LinkedIn search, per-lane source-scoped gates) plugs in.
// ---------------------------------------------------------------------------------------------

/** One discovery source's live health (GET /discovery/status), read from discovery_sources. */
export interface DiscoverySourceStatus {
  id: string;
  board: string; // 'linkedin' | 'indeed' | 'greenhouse' | 'lever' | 'ashby'
  kind: string; // 'jobspy' | 'extension_scrape' | 'ats_board'
  enabled: boolean;
  lastTickAt: number | null;
  /** accepted (net-new) jobs in the recent window — the yield-only telemetry (§1.13). */
  yield: number;
  found?: number;
  freshnessHours: number | null; // the current ramp tier
  /** 0..1 fraction of this source's combos saturated (or a source-provided scalar). */
  saturation: number | null;
  breaker: string | null; // null = healthy; else rate-limit / cooldown reason
  cooldownUntil: number | null;
  nextEarliestAt?: number | null;
}

export interface DiscoveryStatus {
  enabled: boolean;
  sources: DiscoverySourceStatus[];
}

export interface DiscoveryService {
  status(): DiscoveryStatus | Promise<DiscoveryStatus>;
  /** kick ONE discovery sweep (fire-and-forget from the route's view; the service self-throttles). */
  runOnce(): unknown;
}

// ---------------------------------------------------------------------------------------------
// the DAL surface these routes consume — a STRUCTURAL port (method syntax → bivariant params) so the
// real Dal aggregate plugs in unchanged. settings + a run-state writer (for the wall-dismiss edge) +
// jobs.dismiss (the ingest agent's permanent-dismiss method, keyed by norm_key/url_norm/company_key).
// ---------------------------------------------------------------------------------------------

/** structural subset of the settings DAL (db/dal/settings.ts). */
export interface AutoSettingsDal {
  /** every registered section = stored-or-default per key (the config cards' initial read). */
  all(): Record<string, Record<string, unknown>>;
  /** one section, stored-over-default per key. Throws on an unknown section (loud-on-unknown). */
  get(section: string): Record<string, unknown>;
  /** validate against the registry, then persist one (section,key). Throws on unknown/invalid. */
  set(section: string, key: string, value: unknown): void;
}

/** structural subset of the runs DAL — get + the guarded transition writer (FSM authority upstream). */
export interface AutoRunsDal {
  get(id: string): { state: string; park_kind?: string | null } | null;
  /** guarded state writer (routes through assertTransition); return widened to unknown here. */
  transition(id: string, to: string, patch?: Record<string, unknown>): unknown;
}

/** the ingest agent's PERMANENT-dismiss module (db/dal/dismissals.ts, makeDismissalsDal): stamps
 *  jobs.dismissed_at AND writes the dismissal KEYS (nk:/url:/co:) so a re-post can never revive it
 *  (migration 002). Returns null when the job id is unknown (→ 404); a DismissResult otherwise. */
export interface AutoDismissalsDal {
  dismiss(jobId: string, opts: { reason?: string; note?: string | null }): { dismissed: boolean } | null | unknown;
}

export interface AutoDal {
  settings: AutoSettingsDal;
  runs: AutoRunsDal;
  dismissals: AutoDismissalsDal;
}

export interface AutoDeps {
  dal: AutoDal;
  runService: AutoRunService;
  discovery: DiscoveryService;
}

// ---------------------------------------------------------------------------------------------
// helpers (self-contained — sibling route files keep their own copies; no shared export leak)
// ---------------------------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Body parse that never throws: malformed/absent JSON degrades to {} so validation answers an
 *  enveloped 400 instead of a bare Hono 500 (the route walk fires '{}' at every POST/PUT). */
async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await c.req.json();
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type AutoHandler = (c: Context) => Response | Promise<Response>;

/** Envelope-law backstop: NO handler may leak a throw to Hono's bare 500 text. */
function guard(h: AutoHandler): AutoHandler {
  return async (c) => {
    try {
      return await h(c);
    } catch (e) {
      return c.json(err('internal', errMsg(e)), 500);
    }
  };
}

/** dismissals.reason CHECK vocab (migration 002) — unknown reason is loud, never a silent 'user'. */
const DISMISS_REASONS = new Set(['user', 'not_a_job', 'spam', 'irrelevant', 'off_target']);

// ---------------------------------------------------------------------------------------------
// the routes
// ---------------------------------------------------------------------------------------------

export function mountAutoRoutes(api: Hono, deps: AutoDeps): void {
  const { dal, runService, discovery } = deps;

  // ---- supervised auto-apply: start / stop / state / queue -------------------------------------
  api.post('/auto/start', guard(async (c) => {
    await runService.start();
    return c.json(ok(await runService.state()));
  }));

  api.post('/auto/stop', guard(async (c) => {
    await runService.stop();
    return c.json(ok(await runService.state()));
  }));

  // the mission-control status: running + per-lane {queued, inflight, submittedToday, capRemaining,
  // breaker, …}. Polled ~1.5s by the Auto-Apply page; a lean read (no blobs).
  api.get('/auto/state', guard(async (c) => c.json(ok(await runService.state()))));

  // the fit-ordered upcoming queue + the skip-floor decisions (each skip carries its reason). Polled
  // alongside /auto/state; the run-service joins queued runs + fit_scores and applies the skip floor.
  api.get('/auto/queue', guard(async (c) => c.json(ok(await runService.queue()))));

  // ---- discovery: per-source status + a manual sweep -------------------------------------------
  api.get('/discovery/status', guard(async (c) => c.json(ok(await discovery.status()))));

  // Kick ONE sweep. Fire-and-forget: a full sweep can be slow, so we do NOT await it — the service
  // self-throttles and writes yield-only telemetry. Any async rejection is swallowed (logged upstream)
  // so the route answers immediately and never leaves an unhandled rejection.
  api.post('/discovery/run', guard((c) => {
    const p = discovery.runOnce();
    if (p && typeof (p as { then?: unknown }).then === 'function') {
      void (p as Promise<unknown>).catch(() => {});
    }
    return c.json(ok({ started: true }));
  }));

  // ---- settings: the auto-apply + discovery config cards read/write here -----------------------
  // GET returns the FULL registry snapshot (every section, stored-or-default per key) so the cards can
  // hydrate autoApply + discovery in one read. PUT writes ONE (section,key); the DAL validates against
  // the registry (loud-on-unknown) and a validation failure answers a 400, not a 500.
  api.get('/settings', guard((c) => c.json(ok(dal.settings.all()))));

  api.put('/settings/:pair', guard(async (c) => {
    const pair = c.req.param('pair') ?? '';
    const dot = pair.indexOf('.');
    if (dot <= 0 || dot === pair.length - 1) {
      return c.json(err('bad_request', 'settings key must be "section.key" (e.g. autoApply.maxPerDay)'), 400);
    }
    const section = pair.slice(0, dot);
    const key = pair.slice(dot + 1);
    const body = await readJson(c);
    if (!('value' in body)) {
      return c.json(err('bad_request', 'body must carry a "value" field'), 400);
    }
    try {
      dal.settings.set(section, key, body.value);
    } catch (e) {
      // the DAL is loud-on-unknown/invalid — surface that as a 400 (client fixable), not a 500.
      return c.json(err('bad_setting', errMsg(e)), 400);
    }
    return c.json(ok({ section, key, value: body.value }));
  }));

  // ---- Needs-You hygiene: dismiss a wall the engine can't clear (needs_human → parked) ----------
  // captcha/login/cloudflare/account_wall are never auto-solved (§9.4); when one goes stale the human
  // clears it here so it leaves the active queue (the "needs-you pile clogs the run" scar, §8).
  // needs_human → parked is the FSM-legal "dismissed-or-stale" edge (run-fsm.ts); the guarded DAL
  // writer enforces it. Only a needs_human run can be dismissed this way.
  api.post('/runs/:id/dismiss', guard((c) => {
    const id = c.req.param('id') ?? '';
    const run = dal.runs.get(id);
    if (!run) return c.json(err('not_found', `no such run: ${id}`), 404);
    if (run.state !== 'needs_human') {
      return c.json(err('bad_state', `run ${id} is ${run.state}, not needs_human — nothing to dismiss`), 409);
    }
    dal.runs.transition(id, 'parked', { park_detail: 'Dismissed from Needs You — the engine cannot clear this wall' });
    return c.json(ok({ id, state: 'parked' }));
  }));

  // ---- Pierre's PERMANENT job dismiss (Applications drawer → row vanishes for good) --------------
  // Sets jobs.dismissed_at AND writes the dismissal KEYS (nk:/url:/co:) so a re-sighting under a fresh
  // row id resolves to the same dismissal — a dismissed posting can NEVER return (migration 002, the
  // 2026-07-10 standing scar). Reason vocab is validated (loud-on-unknown), defaulting to 'user'.
  api.post('/jobs/:id/dismiss', guard(async (c) => {
    const id = c.req.param('id') ?? '';
    const body = await readJson(c);
    const reason = typeof body.reason === 'string' && body.reason ? body.reason : 'user';
    if (!DISMISS_REASONS.has(reason)) {
      return c.json(err('bad_reason', `unknown dismiss reason "${reason}" (expected ${[...DISMISS_REASONS].join(' | ')})`), 400);
    }
    const opts: { reason: string; note?: string } = { reason };
    if (typeof body.note === 'string' && body.note.trim()) opts.note = body.note.slice(0, 512);

    // the dismissals DAL returns null for an unknown job id (→ 404); any DismissResult means done.
    const result = dal.dismissals.dismiss(id, opts) as { dismissed?: boolean } | null | undefined;
    if (!result || result.dismissed === false) {
      return c.json(err('not_found', `no such job: ${id}`), 404);
    }
    return c.json(ok({ id, dismissed: true, reason }));
  }));
}
