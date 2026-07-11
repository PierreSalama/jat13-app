// The run-service — Stage 3 SUPERVISED AUTO-APPLY ENGINE (built on the Stage-2 single-apply spine).
//
// Stage 2 gave us `applyOne` — enqueue ONE run and drive it to a truthful terminal. Stage 3 turns that
// same drive path into a self-driving engine: a poll loop that PUMPS eligible applications into per-lane
// queues and DRIVES them one at a time, under a per-account submit cap, with a per-lane circuit breaker.
// Everything still depends only on the RunGateway INTERFACE, so the whole scheduler is proven headlessly
// with a FakeExtension (scheduler.test.ts) and the live WsGateway plugs in unchanged.
//
// THE LAWS THIS FILE ENCODES (engine-knowledge.md — every one is a scar):
//   §3.1  SERIAL default: ONE drive at a time, ONE app-side foreground token. A frozen machine outranks
//         any throughput win — never two concurrent drives, never front-to-hydrate. The token gates BOTH
//         the scheduler loop AND a manual `applyOne`, so the two can never overlap.
//   §2.2  The apply_ledger is the ONE per-account cap authority (45/24h for LinkedIn). Parallelism can
//         NEVER stack past it — the cap is checked at both pump (don't feed a capped lane) and dispatch.
//   §1.2/§1.83  SOURCE-SCOPED breakers: a lane that fails repeatedly pauses ITSELF; the other lanes keep
//         going. One weird page / one throttled source never wedges the whole engine.
//   §14.1 Every consumer needs a proven producer: `pump()` is the queue populator the driver was missing.
//   ★ Pierre's dismiss scar: the pump is an ingest-adjacent path, so it consults `dismissals` (by
//     norm_key / job_url_norm / company_key) AND jobs.dismissed_at — a dismissed posting can NEVER be
//     re-queued for apply.
//
// SCOPE FENCE: the answer ladder still has NO AI rung (Stage 4 wraps makeResolver with
// makeAiAwareResolver); this file keeps the Stage-2 profile-first resolver verbatim. Discovery SUPPLY
// (jobspy / ATS boards) is a separate service — the pump only consumes applications that already exist.
import type { Dal } from '../db/dal/index.js';
import type { RunGateway } from './gateway.js';
import { driveRun, type DriveOutcome } from './runner.js';
import { makeResolver } from './answer-resolver.js';
import type { Registry } from '../adapters/registry.js';
import type { RunLane, EnqueueInput, Run } from '../db/dal/runs.js';
import { writeAutopsy } from './autopsy.js';

const DAY_MS = 86_400_000;

/**
 * LinkedIn rolling-24h Easy-Apply budget — the ONE authority (engine-knowledge §2.2, §18). 45 keeps a
 * margin under LinkedIn's ~50 per-account ceiling so a supervised run never trips a lockout. Defined
 * here (not @jat13/shared) so this file compiles standalone; if shared grows a caps module, re-point.
 */
export const LINKEDIN_DAILY_CAP = 45;

/** Rolling per-account submit caps, keyed by LANE (normalized) — indeed/ats are uncapped by us. */
const CAP_BY_LANE: Partial<Record<RunLane, number>> = { linkedin: LINKEDIN_DAILY_CAP };

/** Route a job source onto one of the three drive lanes (apply_runs.lane CHECK vocab). */
function laneFor(source: string): RunLane {
  const s = (source || '').toLowerCase();
  if (s.includes('linkedin')) return 'linkedin';
  if (s.includes('indeed')) return 'indeed';
  return 'ats'; // greenhouse / lever / ashby / everything else
}

const LANES: readonly RunLane[] = ['linkedin', 'indeed', 'ats'];

/**
 * The fit port (agent C's makeFitService, typed STRUCTURALLY so this compiles standalone — we never
 * import the concrete module). `scoreFor` returns 0..100 or null when a job hasn't been scored yet;
 * `floor()` is the current skip threshold. A null score is NOT a floor failure (unscored ≠ below floor)
 * — it rides through so fresh discoveries aren't blocked while the scorer catches up, just ranked last.
 */
export interface FitPort {
  scoreFor(jobId: string, profileId: string): number | null;
  floor(): number;
}

/** No-op fit when the scheduler runs without a fit service (Stage-2 callers): everything passes floor. */
const NO_FIT: FitPort = { scoreFor: () => null, floor: () => 0 };

/** Per-lane circuit breaker — source-scoped so one bad lane never pauses the others (§1.83). */
export interface LaneBreaker {
  paused: boolean;
  reason: string | null;
  consecutiveFailures: number;
}

/** Per-lane snapshot for the auto-apply theater (GET /apply/state). */
export interface LaneState {
  queued: number;
  inflight: number;
  submittedToday: number;
  /** remaining submits before the lane's rolling cap; null when the lane is uncapped. */
  capRemaining: number | null;
  breaker: LaneBreaker;
}

/** The /apply/state payload — Stage-2's {running, activeRun} plus the Stage-3 per-lane strip. */
export interface SchedulerState {
  running: boolean;
  activeRun: Run | null;
  lanes: Record<RunLane, LaneState>;
}

/** One row of the mission-control upcoming queue (already-queued run, or a next-up eligible candidate). */
export interface QueueEntry {
  runId?: string;
  jobId: string;
  applicationId?: string;
  title: string | null;
  company: string | null;
  lane: string;
  source: string;
  fit: number | null;
  reasons: string[];
  state?: string;
}
/** One eligible candidate the pump would NOT apply to, and why (the honest skip-floor readout). */
export interface SkipEntry {
  jobId: string;
  title: string | null;
  company: string | null;
  fit: number | null;
  floor?: number | null;
  reason: string;
}
export interface QueueReport {
  upcoming: QueueEntry[];
  skipped: SkipEntry[];
}

interface EligibleRow {
  application_id: string;
  job_id: string;
  profile_id: string | null;
  source: string;
  job_url: string;
  last_seen_at: number;
}

export interface RunServiceDeps {
  dal: Dal;
  gateway: RunGateway;
  registry: Registry;
  /** agent C's fit service (structural). Absent ⇒ NO_FIT (no floor filtering, no fit ordering). */
  fit?: FitPort;
  /** self-gate: the loop pumps+drives only while this returns true (§1.10 "start at boot, gate inside").
   *  Absent ⇒ always enabled; the integrator wires the auto-apply settings flag here. */
  enabled?: () => boolean;
  /** ms between idle poll ticks. Default 4000. */
  pollMs?: number;
  /** per-LANE queued-run target the pump tops up to. Default 12. */
  queueTarget?: number;
  /** how many eligible applications the pump scores per tick (freshest-first window). Default 200. */
  pumpWindow?: number;
  /** consecutive failed drives in a lane before its breaker pauses it. Default 5. */
  breakerThreshold?: number;
  /** how long a tripped breaker stays paused before auto-resuming (cooldown → pivot, §2.2). Default 15m. */
  breakerCooldownMs?: number;
  /** reclaim a waiting_page run stranded past this TTL back to queued/failed (§11 watchdog). Default 120s. */
  reclaimTtlMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** The full engine surface: the Stage-2 apply methods + the Stage-3 scheduler. */
export interface RunService {
  // ---- Stage-2 single-apply surface (routes-apply.ts drives these) ----
  /** enqueue ONE run for an application + start driving it (fire-and-forget); returns the runId now. */
  applyOne(applicationId: string): Promise<{ runId: string }>;
  /** cooperative stop — the loop stops feeding/driving; an in-flight drive finishes/parks. */
  stop(): void;
  /** the /apply/state payload (running + active run + per-lane strip). */
  state(): SchedulerState;
  /** a human answered a parked run: needs_human → queued, then resume the drive. false if not parked. */
  requeue(runId: string): Promise<boolean>;
  isRunning(): boolean;
  // ---- Stage-3 scheduler surface ----
  /** start the poll loop (pump → drive). Idempotent; safe to call at boot (self-gates on `enabled`). */
  start(): void;
  /** top each lane's queue up to `queueTarget` from eligible applications; returns runs enqueued. */
  pump(): number;
  /** lease the oldest queued, under-cap, non-paused run and drive it; null when nothing is drivable. */
  driveNext(): Promise<DriveOutcome | null>;
  /** read-only mission-control queue: upcoming (queued + next eligible) + honest skip-floor decisions. */
  queue(): QueueReport;
}

/** Back-compat alias: Stage 2 exported the surface as `ApplyRunService`. The Stage-3 `RunService` is a
 *  superset (adds start/pump/driveNext), so existing `ApplyRunService` annotations still type-check. */
export type ApplyRunService = RunService;

export function makeRunService(deps: RunServiceDeps): RunService {
  const { dal, gateway, registry } = deps;
  const fit = deps.fit ?? NO_FIT;
  const enabled = deps.enabled ?? (() => true);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const pollMs = deps.pollMs ?? 4000;
  const queueTarget = deps.queueTarget ?? 12;
  const pumpWindow = deps.pumpWindow ?? 200;
  const breakerThreshold = deps.breakerThreshold ?? 5;
  const breakerCooldownMs = deps.breakerCooldownMs ?? 15 * 60_000;
  const reclaimTtlMs = deps.reclaimTtlMs ?? 120_000;

  let running = false; // the poll loop
  let foreground = false; // THE single foreground token (§3.1) — held for the whole of one drive
  let activeRunId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const breakers: Record<RunLane, LaneBreaker> = {
    linkedin: freshBreaker(),
    indeed: freshBreaker(),
    ats: freshBreaker(),
  };
  const breakerUntil: Record<RunLane, number> = { linkedin: 0, indeed: 0, ats: 0 };

  function freshBreaker(): LaneBreaker {
    return { paused: false, reason: null, consecutiveFailures: 0 };
  }

  // ---- profiles ------------------------------------------------------------------------------------

  function defaultProfileId(): string {
    const row = dal.ctx.db.prepare('SELECT id FROM profiles WHERE is_default = 1 LIMIT 1').get() as { id: string } | undefined;
    return row?.id ?? (dal.ctx.db.prepare('SELECT id FROM profiles LIMIT 1').get() as { id: string } | undefined)?.id ?? '';
  }

  function profileData(profileId: string): Record<string, unknown> {
    const prow = dal.ctx.db.prepare('SELECT data_json FROM profiles WHERE id = ?').get(profileId) as { data_json: string } | undefined;
    try {
      return prow ? (JSON.parse(prow.data_json) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  // ---- caps (apply_ledger is the ONE authority; joined to apply_runs for the normalized lane) -------

  /** Rolling-24h submits in a lane, straight from the ledger — never worker slots (§3.3). */
  function submitsInWindow(lane: RunLane): number {
    const since = now() - DAY_MS;
    return (
      dal.ctx.db
        .prepare(
          'SELECT COUNT(*) c FROM apply_ledger l JOIN apply_runs r ON r.id = l.run_id ' +
            'WHERE r.lane = ? AND l.submitted_at > ?',
        )
        .get(lane, since) as { c: number }
    ).c;
  }

  function capFor(lane: RunLane): number | null {
    return CAP_BY_LANE[lane] ?? null;
  }
  function overCap(lane: RunLane): boolean {
    const cap = capFor(lane);
    return cap !== null && submitsInWindow(lane) >= cap;
  }
  function capRemaining(lane: RunLane): number | null {
    const cap = capFor(lane);
    return cap === null ? null : Math.max(0, cap - submitsInWindow(lane));
  }

  // ---- breaker (source-scoped; N consecutive failures → pause that lane, others keep going) ---------

  /** A tripped breaker auto-resumes once its cooldown elapses (detect → cooldown → pivot, §2.2). */
  function lanePaused(lane: RunLane): boolean {
    const b = breakers[lane];
    if (b.paused && now() >= breakerUntil[lane]) {
      breakers[lane] = freshBreaker(); // cooldown over → the lane is live again
      return false;
    }
    return b.paused;
  }

  function pauseLane(lane: RunLane, reason: string): void {
    const b = breakers[lane];
    b.paused = true;
    b.reason = reason;
    breakerUntil[lane] = now() + breakerCooldownMs;
    log(`breaker: lane ${lane} PAUSED — ${reason} (cooldown ${Math.round(breakerCooldownMs / 1000)}s)`);
  }

  /** Fold one drive's terminal into its lane's breaker. `failed` (and an unattended rate/CF park) counts
   *  against the lane; any healthy terminal resets the streak. `driveThrew` = an exception escaped the
   *  drive (gateway/transport death that isn't a clean resume) — treated as a failure for the lane. */
  function recordLaneOutcome(lane: RunLane, outcome: DriveOutcome | null, driveThrew: boolean): void {
    const b = breakers[lane];
    const failed = driveThrew || outcome?.state === 'failed';
    const rateWall =
      outcome?.state === 'parked' && (outcome.parkKind === 'rate_limited' || outcome.parkKind === 'cloudflare');
    if (failed) {
      b.consecutiveFailures += 1;
      if (b.consecutiveFailures >= breakerThreshold) {
        pauseLane(lane, `${b.consecutiveFailures} consecutive failures`);
      }
    } else if (rateWall) {
      // an unattended rate-limit / Cloudflare wall trips the lane immediately (§2.4).
      pauseLane(lane, `rate/cloudflare wall (${outcome?.parkKind})`);
    } else {
      b.consecutiveFailures = 0; // healthy terminal — the lane is fine
    }
  }

  // ---- the drive (the Stage-2 spine, unchanged except: NO manual ledger insert) --------------------
  // The runner's runs.recordSubmitted writes the apply_ledger row itself (the DAL is the sole ledger
  // writer). The Stage-2 file ALSO inserted one here — a double row that would trip the 45/24h cap at
  // ~23 real submits. Removed: the ledger is written exactly once, inside driveRun.

  /** Drive an already-enqueued run to a truthful terminal. Shared by applyOne, requeue, and driveNext. */
  async function drive(runId: string): Promise<DriveOutcome | null> {
    const run = dal.runs.get(runId);
    if (!run) return null;

    const detail = dal.jobs.getDetail(run.job_id);
    const jobUrl = detail?.job_url ?? '';
    const adapter = jobUrl ? registry.resolveForUrl(jobUrl) : null;
    if (!adapter) {
      // no adapter for this host = never attempted = an honest relevance skip (queued→skipped is legal;
      // queued→parked is not — parks only come mid-drive).
      dal.runs.transition(run.id, 'skipped', { error: 'no_adapter_for_host' });
      log(`run ${run.id}: no adapter for ${jobUrl} → skipped`);
      const skipped = dal.runs.get(run.id);
      if (skipped) writeAutopsy(dal, skipped, { state: 'skipped', steps: 0, resumes: 0 });
      return { state: 'skipped', steps: 0, resumes: 0 };
    }

    const profileId = run.profile_id || defaultProfileId();
    const resolve = makeResolver({ answers: dal.answers, profile: { data: profileData(profileId) }, fieldMap: adapter.fieldMap, profileId });

    log(`run ${run.id}: driving ${jobUrl} via ${adapter.id}`);
    const outcome = await driveRun(run.id, { runs: dal.runs, gateway, adapter, resolve, jobUrl, now });

    // every terminal writes a post-mortem — the Autopsies page + Stage-5 pattern miner read these.
    const finished = dal.runs.get(run.id);
    if (finished) writeAutopsy(dal, finished, outcome);
    return outcome;
  }

  /**
   * THE serial gate. Acquire the single foreground token (synchronously, before any await), drive one
   * run, fold its outcome into the lane breaker, release the token. If the token is already held this
   * returns null WITHOUT driving — the guarantee that two drives never overlap (§3.1 freeze scar).
   */
  async function driveGuarded(runId: string, lane: RunLane): Promise<DriveOutcome | null> {
    if (foreground) return null; // token held → never a second concurrent drive
    foreground = true;
    activeRunId = runId;
    let outcome: DriveOutcome | null = null;
    let threw = false;
    try {
      outcome = await drive(runId);
      return outcome;
    } catch (e) {
      threw = true;
      log(`drive error ${runId}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      recordLaneOutcome(lane, outcome, threw);
      foreground = false;
      if (activeRunId === runId) activeRunId = null;
    }
  }

  // ---- pump: top each lane's queue from ELIGIBLE applications ---------------------------------------
  // eligible = tracked (never applied) + NOT dismissed (jobs.dismissed_at IS NULL AND not in the
  // permanent `dismissals` block by norm_key/job_url_norm/company_key — Pierre's scar) + a real URL +
  // no existing run. From that fresh-ordered candidate window we further require: an adapter for the
  // host, the lane under cap, the lane not paused, and fit >= floor; then enqueue best-fit-first up to
  // each lane's target. Newest sightings lead, so fresh discoveries get applied first.

  function pump(): number {
    // per-lane budget for this tick (0 for a full / capped / paused lane).
    const need: Record<RunLane, number> = { linkedin: 0, indeed: 0, ats: 0 };
    for (const lane of LANES) {
      if (overCap(lane) || lanePaused(lane)) continue;
      const depth = dal.runs.listLean({ state: 'queued', lane, limit: 1 }).total;
      need[lane] = Math.max(0, queueTarget - depth);
    }
    if (need.linkedin + need.indeed + need.ats === 0) return 0;

    const rows = dal.ctx.db
      .prepare(
        `SELECT a.id AS application_id, a.job_id AS job_id, a.profile_id AS profile_id,
                j.source AS source, j.job_url AS job_url, j.last_seen_at AS last_seen_at
           FROM applications a JOIN jobs j ON j.id = a.job_id
          WHERE a.status = 'tracked' AND a.submitted_at IS NULL
            AND j.job_url IS NOT NULL AND j.job_url <> ''
            AND j.dismissed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM apply_runs r WHERE r.application_id = a.id)
            AND NOT EXISTS (
              SELECT 1 FROM dismissals d WHERE
                (j.norm_key     <> '' AND d.dismiss_key = 'nk:'  || j.norm_key) OR
                (j.job_url_norm <> '' AND d.dismiss_key = 'url:' || j.job_url_norm) OR
                (j.company_key  <> '' AND d.dismiss_key = 'co:'  || j.company_key)
            )
          ORDER BY j.last_seen_at DESC
          LIMIT @window`,
      )
      .all({ window: pumpWindow }) as EligibleRow[];

    const floor = fit.floor();
    interface Scored { row: EligibleRow; lane: RunLane; adapterId: string; adapterVersion: number; profileId: string; fit: number; fresh: number; }
    const scored: Scored[] = [];
    for (const r of rows) {
      const lane = laneFor(r.source);
      if (need[lane] <= 0) continue; // lane full / capped / paused this tick
      const adapter = registry.resolveForUrl(r.job_url);
      if (!adapter) continue; // no adapter for this host — don't flood the queue with sure-skips
      const profileId = r.profile_id || defaultProfileId();
      const score = fit.scoreFor(r.job_id, profileId);
      if (score !== null && score < floor) continue; // explicitly below floor — skip (unscored rides on)
      scored.push({ row: r, lane, adapterId: adapter.id, adapterVersion: adapter.version, profileId, fit: score ?? -1, fresh: r.last_seen_at });
    }

    // best fit first, then freshest first — the queue ordering the driver then leases FIFO.
    scored.sort((a, b) => b.fit - a.fit || b.fresh - a.fresh);

    let enq = 0;
    for (const s of scored) {
      if (need[s.lane] <= 0) continue;
      const input: EnqueueInput = {
        source: s.row.source,
        lane: s.lane,
        jobId: s.row.job_id,
        profileId: s.profileId,
        adapterId: s.adapterId,
        adapterVersion: s.adapterVersion,
        mode: 'auto',
      };
      dal.runs.enqueue(s.row.application_id, input);
      need[s.lane] -= 1;
      enq += 1;
    }
    if (enq) log(`pump: enqueued ${enq} run(s) (target ${queueTarget}/lane)`);
    return enq;
  }

  // ---- driveNext: lease the oldest drivable queued run ----------------------------------------------

  async function driveNext(): Promise<DriveOutcome | null> {
    // oldest queued first (FIFO fairness), skipping any lane that is at its cap or paused. A capped /
    // paused lane's runs stay queued — the account limit can never be exceeded (v11 lockout lesson).
    const candidates = dal.ctx.db
      .prepare('SELECT id, source, lane FROM apply_runs WHERE state = ? ORDER BY queued_at ASC LIMIT 50')
      .all('queued') as Array<{ id: string; source: string; lane: RunLane }>;
    const pick = candidates.find((r) => !overCap(r.lane) && !lanePaused(r.lane));
    if (!pick) return null;
    return driveGuarded(pick.id, pick.lane);
  }

  // ---- the poll loop -------------------------------------------------------------------------------

  async function tick(): Promise<void> {
    if (!running) return;
    try {
      if (enabled()) {
        dal.runs.reclaimStranded({ ttlMs: reclaimTtlMs }); // free slots stranded in waiting_page (§11)
        pump(); // keep the lanes fed (never gated on apply-worker idleness, §1.8)
        await driveNext(); // no-ops (returns null) if the foreground token is already held
      }
    } catch (e) {
      log(`run-service tick error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (running) timer = setTimeout(() => void tick(), pollMs);
    }
  }

  // ---- the Stage-2 apply surface (kept working) ----------------------------------------------------

  async function applyOne(applicationId: string): Promise<{ runId: string }> {
    const row = dal.ctx.db
      .prepare(
        `SELECT a.job_id AS jobId, a.profile_id AS profileId, j.source AS source, j.job_url AS jobUrl
           FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
      )
      .get(applicationId) as { jobId: string; profileId: string | null; source: string; jobUrl: string } | undefined;
    if (!row) throw new Error(`no such application: ${applicationId}`);

    const adapter = row.jobUrl ? registry.resolveForUrl(row.jobUrl) : null;
    const lane = laneFor(row.source);
    const input: EnqueueInput = {
      source: row.source,
      lane,
      jobId: row.jobId,
      profileId: row.profileId || defaultProfileId(),
      mode: 'auto',
      ...(adapter ? { adapterId: adapter.id, adapterVersion: adapter.version } : {}),
    };
    const run = dal.runs.enqueue(applicationId, input);
    // fire-and-forget through the SAME serial token the loop uses — a manual apply and the scheduler can
    // never overlap. If the token is momentarily held the run stays queued and the loop leases it next.
    void driveGuarded(run.id, lane).catch((e) => log(`applyOne drive error ${run.id}: ${e instanceof Error ? e.message : String(e)}`));
    return { runId: run.id };
  }

  function stop(): void {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    log('run-service stopped');
  }

  function laneState(lane: RunLane): LaneState {
    return {
      queued: dal.runs.listLean({ state: 'queued', lane, limit: 1 }).total,
      inflight: dal.runs.slotCount(lane),
      submittedToday: submitsInWindow(lane),
      capRemaining: capRemaining(lane),
      breaker: { ...breakers[lane], paused: lanePaused(lane) },
    };
  }

  function state(): SchedulerState {
    return {
      running: running || activeRunId !== null,
      activeRun: activeRunId ? dal.runs.get(activeRunId) : null,
      lanes: { linkedin: laneState('linkedin'), indeed: laneState('indeed'), ats: laneState('ats') },
    };
  }

  async function requeue(runId: string): Promise<boolean> {
    const run = dal.runs.get(runId);
    if (!run || run.state !== 'needs_human') return false; // only a parked-for-human run can be rescued
    dal.runs.transition(runId, 'queued', {});
    // resume the drive where the page actually IS (resume-by-reclassify) — through the serial token.
    void driveGuarded(runId, run.lane).catch((e) => log(`requeue drive error ${runId}: ${e instanceof Error ? e.message : String(e)}`));
    return true;
  }

  function start(): void {
    if (running) return;
    running = true;
    log('run-service started');
    timer = setTimeout(() => void tick(), 0);
  }

  // ---- queue(): the mission-control read-out (never mutates) ---------------------------------------
  // The already-queued runs (the immediate upcoming) + a preview of the next eligible candidates the
  // pump would take, with the honest skip reasons for those it would NOT (below floor / no adapter /
  // over cap). Fit reasons come from the fit_scores cache. Same eligibility as pump() — kept in sync.
  function fitReasons(jobId: string, profileId: string): string[] {
    const row = dal.ctx.db.prepare('SELECT reasons_json FROM fit_scores WHERE job_id=? AND profile_id=?').get(jobId, profileId) as { reasons_json: string } | undefined;
    try {
      return row ? (JSON.parse(row.reasons_json) as string[]) : [];
    } catch {
      return [];
    }
  }
  function queue(): QueueReport {
    const profileId = defaultProfileId();
    const upcoming: QueueEntry[] = [];
    const skipped: SkipEntry[] = [];
    for (const r of dal.runs.listLean({ state: 'queued', limit: 60 }).rows) {
      const d = dal.jobs.getDetail(r.job_id);
      upcoming.push({ runId: r.id, jobId: r.job_id, applicationId: r.application_id, title: d?.title ?? null, company: d?.company ?? null, lane: r.lane, source: r.source, fit: fit.scoreFor(r.job_id, profileId), reasons: fitReasons(r.job_id, profileId), state: r.state });
    }
    const floor = fit.floor();
    const rows = dal.ctx.db
      .prepare(
        `SELECT a.id AS application_id, a.job_id AS job_id, j.source AS source, j.job_url AS job_url, j.title AS title, j.company AS company
           FROM applications a JOIN jobs j ON j.id = a.job_id
          WHERE a.status = 'tracked' AND a.submitted_at IS NULL
            AND j.job_url IS NOT NULL AND j.job_url <> '' AND j.dismissed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM apply_runs r WHERE r.application_id = a.id)
            AND NOT EXISTS (SELECT 1 FROM dismissals d WHERE
                (j.norm_key <> '' AND d.dismiss_key = 'nk:'||j.norm_key) OR
                (j.job_url_norm <> '' AND d.dismiss_key = 'url:'||j.job_url_norm) OR
                (j.company_key <> '' AND d.dismiss_key = 'co:'||j.company_key))
          ORDER BY j.last_seen_at DESC LIMIT 60`,
      )
      .all() as Array<{ application_id: string; job_id: string; source: string; job_url: string; title: string; company: string }>;
    for (const row of rows) {
      const lane = laneFor(row.source);
      const title = row.title || null;
      const company = row.company || null;
      const score = fit.scoreFor(row.job_id, profileId);
      if (!registry.resolveForUrl(row.job_url)) { skipped.push({ jobId: row.job_id, title, company, fit: score, reason: 'no_adapter' }); continue; }
      if (overCap(lane)) { skipped.push({ jobId: row.job_id, title, company, fit: score, reason: 'over_cap' }); continue; }
      if (score !== null && score < floor) { skipped.push({ jobId: row.job_id, title, company, fit: score, floor, reason: 'below_fit_floor' }); continue; }
      upcoming.push({ jobId: row.job_id, applicationId: row.application_id, title, company, lane, source: row.source, fit: score, reasons: fitReasons(row.job_id, profileId) });
    }
    return { upcoming, skipped };
  }

  return {
    applyOne,
    stop,
    state,
    requeue,
    isRunning: () => running || activeRunId !== null,
    start,
    pump,
    driveNext,
    queue,
  };
}
