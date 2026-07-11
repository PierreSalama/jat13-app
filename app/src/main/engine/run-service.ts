// The run-service — Stage 2 SINGLE-APPLY spine. `applyOne` enqueues ONE run for a chosen application
// and drives it to a truthful terminal; the UI watches via /runs/:id/steps + /needs-you. It depends
// only on the RunGateway INTERFACE, so the same drive path is proven headlessly by survival.test with a
// FakeExtension, and the live WsGateway plugs in unchanged.
//
// SCOPE FENCE: no pump, no lane scheduler, no cap enforcement (Stage 3 adds those to THIS file); the
// answer ladder has no AI rung yet (Stage 4 wraps makeResolver with makeAiAwareResolver). What IS here
// is the whole truthful drive: adapter resolve → profile-first resolver → driveRun → submit-truth
// ledger row → autopsy on every terminal.
import type { Dal } from '../db/dal/index.js';
import type { RunGateway } from './gateway.js';
import { driveRun, type DriveOutcome } from './runner.js';
import { makeResolver } from './answer-resolver.js';
import type { Registry } from '../adapters/registry.js';
import type { RunLane, EnqueueInput, Run } from '../db/dal/runs.js';
import { writeAutopsy } from './autopsy.js';

/** Route a job source onto one of the three drive lanes (apply_runs.lane CHECK vocab). */
function laneFor(source: string): RunLane {
  const s = (source || '').toLowerCase();
  if (s.includes('linkedin')) return 'linkedin';
  if (s.includes('indeed')) return 'indeed';
  return 'ats'; // greenhouse / lever / ashby / everything else
}

export interface RunServiceDeps {
  dal: Dal;
  gateway: RunGateway;
  registry: Registry;
  now?: () => number;
  log?: (msg: string) => void;
}

/** The Stage-2 apply surface the API (routes-apply.ts) drives. */
export interface ApplyRunService {
  /** enqueue ONE run for an application + start driving it (fire-and-forget); returns the runId now. */
  applyOne(applicationId: string): Promise<{ runId: string }>;
  /** cooperative stop — the in-flight drive finishes/parks; no new drive starts. */
  stop(): void;
  /** the /apply/state payload. */
  state(): { running: boolean; activeRun: Run | null };
  /** a human answered a parked run: needs_human → queued, then resume the drive. false if not parked. */
  requeue(runId: string): Promise<boolean>;
  isRunning(): boolean;
}

export function makeRunService(deps: RunServiceDeps): ApplyRunService {
  const { dal, gateway, registry } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  let activeRunId: string | null = null;
  let stopped = false;

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

  /** Drive an already-enqueued run to a truthful terminal — the shared spine of applyOne + requeue. */
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
    activeRunId = run.id;
    let outcome: DriveOutcome;
    try {
      outcome = await driveRun(run.id, { runs: dal.runs, gateway, adapter, resolve, jobUrl, now });
    } finally {
      if (activeRunId === run.id) activeRunId = null;
    }

    if (outcome.state === 'submitted') {
      // one ledger row per REAL submit — the cap authority Stage 3 reads (never worker slots).
      dal.ctx.db
        .prepare("INSERT INTO apply_ledger (run_id, source, account_key, submitted_at) VALUES (?, ?, 'default', ?)")
        .run(run.id, run.source, now());
    }
    // every terminal writes a post-mortem — the Autopsies page + Stage-5 pattern miner read these.
    const finished = dal.runs.get(run.id);
    if (finished) writeAutopsy(dal, finished, outcome);
    return outcome;
  }

  async function applyOne(applicationId: string): Promise<{ runId: string }> {
    const row = dal.ctx.db
      .prepare(
        `SELECT a.job_id AS jobId, a.profile_id AS profileId, j.source AS source, j.job_url AS jobUrl
           FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
      )
      .get(applicationId) as { jobId: string; profileId: string | null; source: string; jobUrl: string } | undefined;
    if (!row) throw new Error(`no such application: ${applicationId}`);

    const adapter = row.jobUrl ? registry.resolveForUrl(row.jobUrl) : null;
    const input: EnqueueInput = {
      source: row.source,
      lane: laneFor(row.source),
      jobId: row.jobId,
      profileId: row.profileId || defaultProfileId(),
      mode: 'auto',
      ...(adapter ? { adapterId: adapter.id, adapterVersion: adapter.version } : {}),
    };
    const run = dal.runs.enqueue(applicationId, input);
    stopped = false;
    void drive(run.id).catch((e) => log(`drive error ${run.id}: ${e instanceof Error ? e.message : String(e)}`));
    return { runId: run.id };
  }

  function stop(): void {
    stopped = true;
    log('run-service stop requested');
  }

  function state(): { running: boolean; activeRun: Run | null } {
    return { running: activeRunId !== null, activeRun: activeRunId ? dal.runs.get(activeRunId) : null };
  }

  async function requeue(runId: string): Promise<boolean> {
    const run = dal.runs.get(runId);
    if (!run || run.state !== 'needs_human') return false; // only a parked-for-human run can be rescued
    if (stopped) stopped = false;
    dal.runs.transition(runId, 'queued', {});
    void drive(runId).catch((e) => log(`requeue drive error ${runId}: ${e instanceof Error ? e.message : String(e)}`));
    return true;
  }

  return { applyOne, stop, state, requeue, isRunning: () => activeRunId !== null };
}
