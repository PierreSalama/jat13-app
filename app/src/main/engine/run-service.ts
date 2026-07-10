// The run-service — the minimal driver that turns queued apply_runs into driven applies. It leases ONE
// queued run at a time, resolves its adapter (by the job URL) and a profile-first answer resolver, and
// hands it to driveRun(). The FULL lane scheduler (concurrency, per-source gates, the 45/24h ledger
// cap, pacing/breakers) is task #4 — this is the single-lane spine that M1 needs to actually apply.
// Depends only on the RunGateway INTERFACE, so it's testable with the same FakeExtension the survival
// test uses; the live WsGateway plugs in unchanged.
import type { Dal } from '../db/dal/index.js';
import type { RunGateway } from './gateway.js';
import { driveRun, type DriveOutcome } from './runner.js';
import { makeResolver, makeAiAwareResolver } from './answer-resolver.js';
import type { AiService } from '../ai/index.js';
import type { Registry } from '../adapters/registry.js';
import type { RunLane, EnqueueInput } from '../db/dal/runs.js';
import { LINKEDIN_DAILY_CAP } from '@jat13/shared';

const DAY_MS = 86_400_000;
/** Rolling per-account submit caps (apply_ledger is the authority; parallelism can't stack past these). */
const CAP_BY_SOURCE: Record<string, number> = { linkedin: LINKEDIN_DAILY_CAP };

/** Route a job source onto one of the three drive lanes. */
function laneFor(source: string): RunLane {
  const s = (source || '').toLowerCase();
  if (s.includes('linkedin')) return 'linkedin';
  if (s.includes('indeed')) return 'indeed';
  return 'ats'; // greenhouse / lever / ashby / everything else
}

interface EligibleRow {
  application_id: string;
  job_id: string;
  profile_id: string | null;
  source: string;
  job_url: string;
}

export interface RunServiceDeps {
  dal: Dal;
  gateway: RunGateway;
  registry: Registry;
  /** the Codex AI service — when present, adds the AI fallback rung to screening answers. */
  ai?: AiService;
  /** ms between idle polls for a queued run. */
  pollMs?: number;
  /** keep this many runs queued (the pump tops up from eligible applications). Default 20. */
  queueTarget?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface RunService {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /** top the queue up to `queueTarget` from eligible applications; returns how many runs were enqueued. */
  pump(): number;
  /** drive exactly one queued run if present; returns its outcome or null when the queue is empty. */
  driveNext(): Promise<DriveOutcome | null>;
}

export function makeRunService(deps: RunServiceDeps): RunService {
  const { dal, gateway, registry } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const pollMs = deps.pollMs ?? 4000;
  const queueTarget = deps.queueTarget ?? 20;
  let running = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function defaultProfileId(): string {
    const row = dal.ctx.db.prepare('SELECT id FROM profiles WHERE is_default = 1 LIMIT 1').get() as { id: string } | undefined;
    return row?.id ?? (dal.ctx.db.prepare('SELECT id FROM profiles LIMIT 1').get() as { id: string } | undefined)?.id ?? '';
  }

  /** Rolling-24h submit count from the ledger (the ONE cap authority). */
  function submitsInWindow(source: string): number {
    const cap = CAP_BY_SOURCE[source];
    if (cap === undefined) return 0;
    const since = now() - DAY_MS;
    return (dal.ctx.db.prepare("SELECT COUNT(*) c FROM apply_ledger WHERE source=? AND account_key='default' AND submitted_at > ?").get(source, since) as { c: number }).c;
  }
  function overCap(source: string): boolean {
    const cap = CAP_BY_SOURCE[source];
    return cap !== undefined && submitsInWindow(source) >= cap;
  }

  // THE queue populator (the piece that was missing — the driver had nothing to drive). When auto-apply
  // is on, top the queue up to `queueTarget` from applications that are: still just Saved (never applied),
  // on a host we actually have an adapter for, with NO existing run, and whose source is under its cap.
  // Newest-tracked first, so fresh discoveries lead. The driver leases what this enqueues.
  function pump(): number {
    const depth = dal.runs.listLean({ state: 'queued', limit: 1 }).total;
    const need = queueTarget - depth;
    if (need <= 0) return 0;
    const rows = dal.ctx.db
      .prepare(
        `SELECT a.id AS application_id, a.job_id AS job_id, a.profile_id AS profile_id, j.source AS source, j.job_url AS job_url
           FROM applications a JOIN jobs j ON j.id = a.job_id
          WHERE a.status = 'tracked' AND a.submitted_at IS NULL
            AND j.job_url IS NOT NULL AND j.job_url <> ''
            AND NOT EXISTS (SELECT 1 FROM apply_runs r WHERE r.application_id = a.id)
          ORDER BY a.updated_at DESC
          LIMIT 80`,
      )
      .all() as EligibleRow[];

    let enq = 0;
    for (const r of rows) {
      if (enq >= need) break;
      const adapter = registry.resolveForUrl(r.job_url);
      if (!adapter) continue; // no adapter for this host — skip enqueuing (don't flood the queue with sure-skips)
      if (overCap(r.source)) continue; // source at its rolling cap — leave it queued-worthy for later
      const input: EnqueueInput = {
        source: r.source,
        lane: laneFor(r.source),
        jobId: r.job_id,
        profileId: r.profile_id || defaultProfileId(),
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        mode: 'auto',
      };
      dal.runs.enqueue(r.application_id, input);
      enq++;
    }
    if (enq) log(`pump: enqueued ${enq} run(s) (queue ${depth}→${depth + enq}, target ${queueTarget})`);
    return enq;
  }

  async function driveNext(): Promise<DriveOutcome | null> {
    // pick the oldest queued run whose source is UNDER its rolling cap (a capped source is left queued,
    // not driven — the account limit can never be exceeded, v11 lockout lesson).
    const candidates = dal.runs.listLean({ state: 'queued', limit: 25 }).rows;
    const pick = candidates.find((r) => !overCap(r.source));
    if (!pick) return null;
    const run = dal.runs.get(pick.id);
    if (!run) return null;

    const detail = dal.jobs.getDetail(run.job_id);
    const jobUrl = detail?.job_url ?? '';
    const adapter = jobUrl ? registry.resolveForUrl(jobUrl) : null;
    if (!adapter) {
      // no adapter for this host = we can't attempt it = a relevance skip (never attempted). queued→skipped
      // is the legal, honest terminal (queued→parked is not a legal transition — parks come mid-drive).
      dal.runs.transition(run.id, 'skipped', { error: 'no_adapter_for_host' });
      log(`run ${run.id}: no adapter for ${jobUrl} → skipped`);
      return { state: 'skipped', steps: 0, resumes: 0 };
    }

    const profileId = run.profile_id || defaultProfileId();
    const prow = dal.ctx.db.prepare('SELECT data_json FROM profiles WHERE id = ?').get(profileId) as { data_json: string } | undefined;
    let profileData: Record<string, unknown> = {};
    try {
      profileData = prow ? (JSON.parse(prow.data_json) as Record<string, unknown>) : {};
    } catch {
      profileData = {};
    }

    const baseArgs = { answers: dal.answers, profile: { data: profileData }, fieldMap: adapter.fieldMap, profileId };
    let resolve;
    if (deps.ai) {
      const aiCfg = dal.settings.get('ai') as { enabled?: boolean; answerConfidenceMin?: number };
      const job: NonNullable<Parameters<typeof makeAiAwareResolver>[0]['aiContext']>['job'] = {};
      if (detail?.title) job.title = detail.title;
      if (detail?.company) job.company = detail.company;
      if (detail?.location) job.location = detail.location;
      resolve = makeAiAwareResolver({
        ...baseArgs,
        ai: deps.ai,
        aiEnabled: aiCfg.enabled !== false,
        answerConfidenceMin: aiCfg.answerConfidenceMin ?? 0.6,
        aiContext: { job },
      });
    } else {
      resolve = makeResolver(baseArgs);
    }

    log(`run ${run.id}: driving ${jobUrl} via ${adapter.id}`);
    const outcome = await driveRun(run.id, { runs: dal.runs, gateway, adapter, resolve, jobUrl, now });
    if (outcome.state === 'submitted') {
      // one ledger row per REAL submit — this is what the cap reads next time (never worker slots).
      dal.ctx.db
        .prepare("INSERT INTO apply_ledger (run_id, source, account_key, submitted_at) VALUES (?, ?, 'default', ?)")
        .run(run.id, run.source, now());
    }
    return outcome;
  }

  async function tick(): Promise<void> {
    if (!running || inFlight) return;
    inFlight = true;
    try {
      pump(); // keep the queue fed from eligible applications, THEN drive the oldest queued run
      const outcome = await driveNext();
      if (outcome) log(`run finished: ${outcome.state}`);
    } catch (e) {
      log(`run-service tick error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight = false;
      if (running) timer = setTimeout(() => void tick(), pollMs);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      log('run-service started');
      timer = setTimeout(() => void tick(), 0);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      log('run-service stopped');
    },
    isRunning: () => running,
    pump,
    driveNext,
  };
}
