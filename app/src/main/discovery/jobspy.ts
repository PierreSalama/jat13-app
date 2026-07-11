// jobspy.ts — the subprocess wrapper around jobspy_worker.py (the MIT python-jobspy bridge). Ported from
// v11 discovery/index.js. It powers the linkedin + indeed lanes; the ATS lanes (ats-boards.ts) DO NOT go
// through here, so if python/jobspy is missing the ATS lanes still carry supply (§1.10 / lane independence).
//
// Every failure is TYPED and the wrapper NEVER throws — run() always resolves to a JobSpyResult. The
// launcher walk mirrors v11's WORKER_NONVIABLE_RX fall-through: try `py -3` → `python` → `python3`, and
// only fall through to the next launcher when the current one can't run at all (enoent) or lacks the jobspy
// module (ImportError) — a real provider failure (rate-limit / captcha / timeout) surfaces as its own type
// so the service can set the RIGHT lane cooldown (python_missing = long; timeout/rate_limited = short).
//
// The worker .py ships beside the bundle (build.mjs copies discovery/*.py → dist/main/discovery); the path
// resolver tries the source layout (dev/tests), the bundled layout (HERE=dist/main → discovery/), an
// explicit discoveryDir (main.ts passes resourceDir('discovery') for the packaged app), and the
// JAT_JOBSPY_WORKER env override. spawn is injectable so the service is testable without a real python.

import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** typed failure reasons — the service branches on these to pick the right breaker cooldown. */
export type JobSpyFailure =
  | 'python_missing'
  | 'jobspy_missing'
  | 'timeout'
  | 'rate_limited'
  | 'blocked'
  | 'parser_drift'
  | 'unavailable'
  | 'error';

/** one JobSpy scrape request (the service builds this from the planner combo + freshness tier). */
export interface JobSpyRequest {
  source: string; // 'linkedin' | 'indeed' | ...
  keyword: string;
  location: string; // ALWAYS a geography (never blank — the service falls back to country)
  limit: number;
  hoursOld: number; // freshness window in hours (72h floor … 720h ceiling)
  country: string;
  remote: boolean;
  easyApply: boolean;
  distance: number; // search radius in miles (0 = JobSpy default)
}

/** a normalized posting from JobSpy — already in the shape the ingest chokepoint maps to a candidate. */
export interface JobSpyJob {
  title: string;
  company: string;
  location: string;
  job_url: string;
  source: string;
  description: string;
  posted_at: string | null;
  remote: boolean;
  employment_type: string | null;
  direct_job_url: string | null;
}

export type JobSpyResult =
  | { ok: true; source: string; jobs: JobSpyJob[] }
  | { ok: false; reason: JobSpyFailure; error: string };

/** the seam the discovery service depends on (real impl below; tests inject a fake). */
export interface JobSpyRunner {
  run(request: JobSpyRequest): Promise<JobSpyResult>;
}

/** a launcher candidate: interpreter command + the leading args (script path lands last). */
interface Launcher {
  command: string;
  args: string[];
}

/** the raw JSON the worker prints on success. */
interface WorkerOk {
  ok: true;
  source?: string;
  jobs?: unknown[];
}

// ---- pure helpers (exported for unit tests) --------------------------------------------------------

function text(v: unknown): string {
  return v == null ? '' : String(v).trim();
}
function first(...xs: unknown[]): string {
  return xs.map(text).find(Boolean) ?? '';
}

/**
 * Map a raw JobSpy record to a normalized JobSpyJob. Returns null when it lacks an http(s) job_url or a
 * title (the two things that make it a real posting) — a malformed record is dropped, never ingested.
 */
export function normalizeJobSpyRecord(raw: unknown, requestedSource = ''): JobSpyJob | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const source = first(r.site, r.source, requestedSource).toLowerCase().replace(/\s+/g, '_');
  const jobUrl = first(r.job_url, r.job_url_direct, r.url);
  if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) return null;
  const title = first(r.title, r.job_title);
  if (!title) return null;
  return {
    title,
    company: first(r.company, r.company_name) || 'Unknown company',
    location: first(r.location, r.city, r.state),
    job_url: jobUrl,
    source: source === 'zip_recruiter' ? 'ziprecruiter' : source || text(requestedSource),
    description: text(r.description).slice(0, 30000),
    posted_at: first(r.date_posted, r.posted_at) || null,
    remote: r.is_remote === true,
    employment_type: first(r.job_type) || null,
    direct_job_url: first(r.job_url_direct) || null,
  };
}

/** Classify a worker/launcher error message into a typed failure. Order matters: the module-missing and
 *  interpreter-missing signatures are checked before the generic provider signatures. */
export function classifyFailure(message: unknown): JobSpyFailure {
  const s = text(message).toLowerCase();
  if (/no module named ['"]?jobspy|modulenotfounderror|importerror/.test(s)) return 'jobspy_missing';
  if (/enoent|is not recognized|cannot run program|no such file|cannot find|spawn .* failed|not on path/.test(s)) {
    return 'python_missing';
  }
  if (/timed?\s*out|timeout/.test(s)) return 'timeout';
  if (/429|rate.?limit|too many requests/.test(s)) return 'rate_limited';
  if (/403|blocked|captcha|access denied|forbidden/.test(s)) return 'blocked';
  if (/selector|parse|schema|column|attribute|none.?type/.test(s)) return 'parser_drift';
  if (/no module named|cannot find module|worker exited|worker unavailable/.test(s)) return 'unavailable';
  return 'error';
}

/** A launcher is "non-viable" — try the NEXT one — when it couldn't run (enoent) or ran but lacks jobspy.
 *  Anything else (rate-limit / captcha / network) is a genuine provider failure and must NOT fall through. */
const WORKER_NONVIABLE_RX =
  /enoent|not found|no module named|cannot find module|modulenotfounderror|importerror|is not recognized|no such file|cannot run program|worker exited|spawn .* failed/i;

/** stdin request payload → the worker's expected snake_case JSON. */
function toWorkerPayload(req: JobSpyRequest): Record<string, unknown> {
  return {
    source: req.source,
    keyword: req.keyword,
    location: req.location,
    limit: req.limit,
    hours_old: req.hoursOld,
    country: req.country,
    remote: req.remote,
    easy_apply: req.easyApply,
    distance: req.distance,
  };
}

// ---- the real subprocess runner --------------------------------------------------------------------

/** the injectable spawn seam (structural subset of node:child_process.spawn). */
export type SpawnFn = typeof spawn;

/** Resolve the worker .py path across dev (source), bundled (HERE=dist/main), packaged (discoveryDir), and
 *  an explicit env override. First existing wins; the source path is the last-resort default. */
export function resolveWorkerScript(discoveryDir?: string): string {
  const candidates = [
    process.env.JAT_JOBSPY_WORKER,
    discoveryDir ? join(discoveryDir, 'jobspy_worker.py') : undefined,
    join(HERE, 'jobspy_worker.py'), // source layout (dev / vitest) — HERE = src/main/discovery
    join(HERE, 'discovery', 'jobspy_worker.py'), // bundled layout — HERE = dist/main
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore and try the next candidate */
    }
  }
  return join(HERE, 'jobspy_worker.py');
}

/** the interpreter launchers to try, in order (Windows prefers the `py -3` shim). */
function launchers(script: string): Launcher[] {
  const list: Launcher[] = [];
  if (process.platform === 'win32') {
    list.push({ command: 'py', args: ['-3', script] });
    list.push({ command: 'python', args: [script] });
  } else {
    list.push({ command: 'python3', args: [script] });
    list.push({ command: 'python', args: [script] });
  }
  return list;
}

/** Spawn ONE launcher, feed the request on stdin, resolve the parsed worker JSON or reject a typed Error.
 *  Guards stdin 'error' (the documented Windows spawn-ENOENT-on-stdin uncaught-exception class) and kills
 *  on timeout so a hung scrape can never wedge a lane. */
function runProcess(
  launcher: Launcher,
  req: JobSpyRequest,
  timeoutMs: number,
  spawnImpl: SpawnFn,
): Promise<WorkerOk> {
  return new Promise<WorkerOk>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const opts: SpawnOptions = { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
    const child = spawnImpl(launcher.command, launcher.args, opts);
    const finish = (fn: (v: never) => void, value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      (fn as (v: unknown) => void)(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(reject as (v: never) => void, new Error(`JobSpy timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (e: Error) => finish(reject as (v: never) => void, e));
    child.stdin?.on('error', (e: Error) => finish(reject as (v: never) => void, e));
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('close', (code: number | null) => {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      let result: { ok?: boolean; error?: string } | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          result = JSON.parse(lines[i]!) as { ok?: boolean; error?: string };
          break;
        } catch {
          /* keep scanning older lines for the JSON result */
        }
      }
      if (result?.ok) finish(resolve as (v: never) => void, result as WorkerOk);
      else finish(reject as (v: never) => void, new Error(result?.error || stderr.trim() || `JobSpy worker exited ${code}`));
    });
    try {
      child.stdin?.end(JSON.stringify(toWorkerPayload(req)) + '\n');
    } catch (e) {
      finish(reject as (v: never) => void, e);
    }
  });
}

/**
 * Walk the launchers in order, trying the next ONLY when the current one is non-viable (couldn't launch /
 * lacks jobspy). Any other error is a genuine provider failure and propagates. `runProcessFn` is injected
 * so this is testable without spawning. Exported for the unit tests.
 */
export async function runWithLaunchers(
  list: Launcher[],
  runProcessFn: (l: Launcher) => Promise<WorkerOk>,
): Promise<WorkerOk> {
  let last: unknown = null;
  for (let i = 0; i < list.length; i++) {
    try {
      return await runProcessFn(list[i]!);
    } catch (e) {
      last = e;
      const more = i < list.length - 1;
      if (more && WORKER_NONVIABLE_RX.test(text(e instanceof Error ? e.message : e))) continue;
      throw e;
    }
  }
  throw last instanceof Error ? last : new Error('JobSpy worker unavailable');
}

export interface JobSpyDeps {
  /** explicit dir the worker .py ships in (packaged app: resourceDir('discovery')). */
  discoveryDir?: string;
  /** full path override for the worker script (wins over discoveryDir). */
  workerScript?: string;
  /** per-scrape timeout (default 90s — a JobSpy scrape is slow). */
  timeoutMs?: number;
  /** injected in tests so no real python is spawned. */
  spawnImpl?: SpawnFn;
  log?: (msg: string) => void;
}

/** Build the real JobSpy runner. run() NEVER throws — it always resolves to a typed JobSpyResult. */
export function makeJobSpy(deps: JobSpyDeps = {}): JobSpyRunner {
  const timeoutMs = deps.timeoutMs ?? 90_000;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const log = deps.log ?? (() => {});
  const script = deps.workerScript ?? resolveWorkerScript(deps.discoveryDir);

  async function run(request: JobSpyRequest): Promise<JobSpyResult> {
    try {
      const worker = await runWithLaunchers(launchers(script), (l) => runProcess(l, request, timeoutMs, spawnImpl));
      const jobs = (Array.isArray(worker.jobs) ? worker.jobs : [])
        .map((j) => normalizeJobSpyRecord(j, request.source))
        .filter((j): j is JobSpyJob => j !== null);
      return { ok: true, source: text(worker.source) || request.source, jobs };
    } catch (e) {
      const error = text(e instanceof Error ? e.message : e).slice(0, 1024);
      const reason = classifyFailure(error);
      log(`jobspy[${request.source}] failed: ${reason} — ${error}`);
      return { ok: false, reason, error };
    }
  }

  return { run };
}
