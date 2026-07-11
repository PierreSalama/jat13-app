// ingest.ts — THE one ingest chokepoint. EVERY source (jobspy lanes, ATS lanes) AND the extension's
// "track this page" route funnel through ingestOne/ingestBatch, in this exact order:
//
//   (1) is-this-a-job GATE (isJobPosting): reject anything that is not a real posting — needs a title, a
//       company, and a plausible http(s) job_url on a KNOWN job/ATS host (registry adapter host OR the
//       curated known-host list). A bare unrelated URL / arbitrary page is rejected, reason 'not_a_job'.
//       This is Pierre's 2026-07-10 scar #1: v11 tracked pages that were NOT jobs.
//
//   (2) DISMISS CHECK (dismissals.isDismissed): if ANY of the posting's dedup identities (nk:/url:/co:)
//       is in `dismissals`, skip it — it can NEVER be re-created or revived, even under a fresh row id /
//       new external_id. This is Pierre's scar #2: dismissing didn't stick in v11 (it came back next scan).
//       The permanent-block DAL is the AUTHORITATIVE db/dal/dismissals.ts (makeDismissalsDal), injected as
//       a port so this chokepoint and the /track route share exactly one dismiss surface.
//
//   (3) UPSERT + PROVENANCE: dal.jobs.upsert (the single dedup gate) then discoveryDal.recordSighting so
//       every source that saw the posting is recorded (freshness = first_seen/last_seen kept by upsert).
//
// Non-jobs and dismissed postings are COUNTED, never thrown — one weird candidate never wedges a lane.
// isJobPosting is exported so the /track route runs the exact same gate the discovery lanes run; track()
// is the /track chokepoint (job dedup + application ensure — routes-track.ts wires it as its IngestFn).

import type { Dal } from '../db/dal/index.js';
import { normKey, normJobUrl } from '../db/dal/index.js';
import type { JobInput, ApplyCapability, WorkMode } from '../db/dal/jobs.js';
import type { DiscoveryDal } from '../db/dal/discovery.js';
import type { Registry } from '../adapters/registry.js';

/** The authoritative permanent-block surface (db/dal/dismissals.ts) reduced to what the chokepoint needs.
 *  The integrator injects makeDismissalsDal(ctx), which satisfies this. */
export interface DismissalsPort {
  isDismissed(keys: { normKey?: string; urlNorm?: string; companyKey?: string }): boolean;
}

/** the is-this-a-job gate in the shape routes-track.ts injects (boolean, {url,title?,company?}). */
export type JobGate = (input: { url: string; title?: string; company?: string; source?: string }) => boolean;

/** the /track ingest input + result (routes-track.ts's IngestFn contract). */
export interface TrackInput {
  url: string;
  title?: string;
  company?: string;
  source?: string;
}
export interface TrackResult {
  applicationId: string;
  jobId: string;
}

/** the neutral shape every source normalizes into before the chokepoint. Both AtsPosting and JobSpyJob
 *  map to this; the extension /track route builds one from the page it observed. */
export interface IngestCandidate {
  source: string; // board/lane id: 'linkedin' | 'indeed' | 'greenhouse' | 'lever' | 'ashby' | ...
  job_url: string;
  title?: string;
  company?: string;
  location?: string;
  work_mode?: WorkMode | null;
  employment_type?: string | null;
  compensation?: string | null;
  apply_capability?: ApplyCapability;
  external_id?: string | null;
  description?: string;
  raw?: unknown;
}

export type GateReason = 'not_a_job';

export interface GateResult {
  ok: boolean;
  reason: GateReason | null;
  /** a human-readable sub-detail for telemetry (WHY it wasn't a job) — never a hard failure vocab. */
  detail?: string;
}

export type IngestOutcome = 'accepted' | 'duplicate' | 'rejected' | 'dismissed';

export interface IngestResult {
  outcome: IngestOutcome;
  jobId?: string;
  reason?: string;
}

export interface IngestBatchResult {
  found: number; // candidates handed in
  accepted: number; // newly-inserted jobs
  duplicate: number; // re-sighted existing jobs
  rejected: number; // failed the is-a-job gate (not_a_job)
  dismissed: number; // permanently dismissed — skipped
  jobIds: string[]; // ids of accepted + duplicate jobs (for the caller's downstream)
}

// Curated known job/ATS hosts (the location-analogue safety net beside the registry). A URL whose host
// matches an adapter (registry.resolveForUrl) is already known; this catches plausible postings on hosts
// jobspy returns that we may not have an adapter for yet (glassdoor/ziprecruiter/workday/…) so they still
// pass the "is this a job" gate. A bare blog/marketing/random page host matches NEITHER → rejected.
const KNOWN_JOB_HOST_RX =
  /(^|\.)(linkedin\.com|indeed\.com|greenhouse\.io|lever\.co|ashbyhq\.com|glassdoor\.[a-z.]+|ziprecruiter\.com|myworkdayjobs\.com|workday\.com|icims\.com|smartrecruiters\.com|jobvite\.com|bamboohr\.com|taleo\.net|workable\.com|breezy\.hr|recruitee\.com|jobs\.[a-z0-9-]+\.[a-z]+)$/i;

function text(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/** posting-identity keys, computed the SAME way jobs.upsert + a dismiss compute them, so a dismiss and a
 *  re-sighting resolve to identical dismiss_keys. */
export function candidateKeys(candidate: IngestCandidate): {
  normKey: string;
  urlNorm: string;
  companyKey: string;
} {
  const company = text(candidate.company);
  const title = text(candidate.title);
  return {
    normKey: normKey(`${company} ${title}`),
    urlNorm: normJobUrl(candidate.job_url),
    companyKey: normKey(company),
  };
}

/**
 * THE reusable is-this-a-job gate (the /track route imports this). A candidate is a real posting when it
 * has a title, a company, and an http(s) job_url whose host is known (an adapter host OR a curated job
 * host). Everything else — a bare page, a marketing URL, a mailto, a title-less card — is 'not_a_job'.
 */
export function isJobPosting(candidate: IngestCandidate, registry: Registry): GateResult {
  const title = text(candidate.title);
  const company = text(candidate.company);
  const url = text(candidate.job_url);
  if (!title) return { ok: false, reason: 'not_a_job', detail: 'missing title' };
  if (!company) return { ok: false, reason: 'not_a_job', detail: 'missing company' };
  if (!url) return { ok: false, reason: 'not_a_job', detail: 'missing url' };

  let host = '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, reason: 'not_a_job', detail: `non-http url (${u.protocol})` };
    }
    host = u.host.toLowerCase();
  } catch {
    return { ok: false, reason: 'not_a_job', detail: 'unparseable url' };
  }
  if (!host) return { ok: false, reason: 'not_a_job', detail: 'no host' };

  // known host = we have an adapter for it OR it's a curated job/ATS host.
  const knownByAdapter = registry.resolveForUrl(url) !== null;
  if (!knownByAdapter && !KNOWN_JOB_HOST_RX.test(host)) {
    return { ok: false, reason: 'not_a_job', detail: `unknown host ${host}` };
  }
  return { ok: true, reason: null };
}

export interface IngestDeps {
  dal: Dal;
  discoveryDal: DiscoveryDal;
  registry: Registry;
  /** the authoritative permanent-block DAL (db/dal/dismissals.ts) — shared with the /track route. */
  dismissals: DismissalsPort;
  log?: (msg: string) => void;
}

export interface IngestContext {
  /** discovery_sources.id the sighting is recorded under. Omit for a /track ingest with no lane row. */
  sourceId?: string;
}

export interface Ingest {
  /** run ONE candidate through gate → dismiss → upsert. Never throws on a bad candidate. */
  ingestOne(candidate: IngestCandidate, ctx?: IngestContext): IngestResult;
  /** run a batch, tallying the funnel (found/accepted/duplicate/rejected/dismissed). */
  ingestBatch(candidates: readonly IngestCandidate[], ctx?: IngestContext): IngestBatchResult;
  /** the reusable gate, bound to this registry — the /track route calls this (via `jobGate`). */
  isJobPosting(candidate: IngestCandidate): GateResult;
  /** the boolean {url,title,company} gate routes-track.ts injects as its JobGate. */
  jobGate: JobGate;
  /** the /track chokepoint: dedup the job + ensure its application (default profile). routes-track.ts
   *  wires this as its IngestFn. The route already gated (isJobPosting + isDismissed); track() re-runs
   *  the belt so a direct caller can't create a phantom/dismissed job either. */
  track(input: TrackInput): TrackResult;
}

/** Build JobInput from a candidate WITHOUT ever passing `undefined` (exactOptionalPropertyTypes): only
 *  present, meaningful fields are included, so a bare re-sighting can't blank a previously-known column. */
function toJobInput(candidate: IngestCandidate): JobInput {
  const title = text(candidate.title);
  const company = text(candidate.company);
  const location = text(candidate.location);
  const description = text(candidate.description);
  return {
    source: candidate.source,
    job_url: candidate.job_url,
    ...(title ? { title } : {}),
    ...(company ? { company } : {}),
    ...(location ? { location } : {}),
    ...(candidate.work_mode != null ? { work_mode: candidate.work_mode } : {}),
    ...(candidate.employment_type != null ? { employment_type: candidate.employment_type } : {}),
    ...(candidate.compensation != null ? { compensation: candidate.compensation } : {}),
    ...(candidate.external_id != null ? { external_id: candidate.external_id } : {}),
    ...(candidate.apply_capability ? { apply_capability: candidate.apply_capability } : {}),
    ...(description ? { description } : {}),
    ...(candidate.raw !== undefined ? { raw: candidate.raw } : {}),
  };
}

export function makeIngest(deps: IngestDeps): Ingest {
  const { dal, discoveryDal, registry, dismissals } = deps;
  const log = deps.log ?? (() => {});

  function gate(candidate: IngestCandidate): GateResult {
    return isJobPosting(candidate, registry);
  }

  /** default profile id (is_default first, else any) — the /track application is scoped to it. */
  function defaultProfileId(): string {
    const row = dal.ctx.db.prepare('SELECT id FROM profiles WHERE is_default = 1 LIMIT 1').get() as { id: string } | undefined;
    return row?.id ?? (dal.ctx.db.prepare('SELECT id FROM profiles LIMIT 1').get() as { id: string } | undefined)?.id ?? '';
  }

  function ingestOne(candidate: IngestCandidate, ctx: IngestContext = {}): IngestResult {
    // (1) is-this-a-job GATE — reject non-postings (counted, never thrown).
    const g = gate(candidate);
    if (!g.ok) {
      return { outcome: 'rejected', reason: g.detail ?? g.reason ?? 'not_a_job' };
    }

    // (2) DISMISS CHECK — a dismissed posting can never return (any of nk:/url:/co:).
    const keys = candidateKeys(candidate);
    if (dismissals.isDismissed(keys)) {
      return { outcome: 'dismissed' };
    }

    // (3) UPSERT (single dedup gate) + PROVENANCE (job_sightings). freshness = first/last_seen via upsert.
    const up = dal.jobs.upsert(toJobInput(candidate));
    if (ctx.sourceId) {
      discoveryDal.recordSighting({
        jobId: up.job.id,
        sourceId: ctx.sourceId,
        applyCapability: candidate.apply_capability ?? up.job.apply_capability,
        rawUrl: candidate.job_url,
      });
    }
    // (4) BRIDGE discovery → the apply pump: ensure a 'tracked' application (idempotent). Without this a
    // discovered job is an orphan jobs-row the pump (which reads applications) never sees.
    const profileId = defaultProfileId();
    if (profileId) dal.applications.ensure(up.job.id, profileId);

    return { outcome: up.action === 'inserted' ? 'accepted' : 'duplicate', jobId: up.job.id };
  }

  /** map a /track input to a candidate (source defaults to 'extension'). */
  function trackToCandidate(input: TrackInput): IngestCandidate {
    return {
      source: text(input.source) || 'extension',
      job_url: input.url,
      ...(input.title ? { title: input.title } : {}),
      ...(input.company ? { company: input.company } : {}),
    };
  }

  function track(input: TrackInput): TrackResult {
    const candidate = trackToCandidate(input);
    // belt (both ingest paths gate): routes-track pre-gates, but a direct caller must not create a
    // phantom or a dismissed job either. These throws are unreachable through the wired /track route.
    const g = gate(candidate);
    if (!g.ok) throw new Error(`ingest.track: not_a_job (${g.detail ?? ''})`);
    if (dismissals.isDismissed(candidateKeys(candidate))) throw new Error('ingest.track: dismissed');
    const up = dal.jobs.upsert(toJobInput(candidate));
    const appl = dal.applications.ensure(up.job.id, defaultProfileId()); // get-or-create; emits its own insert event
    return { applicationId: appl.id, jobId: up.job.id };
  }

  const jobGate: JobGate = (input) =>
    gate({
      source: text(input.source) || 'extension',
      job_url: input.url,
      ...(input.title ? { title: input.title } : {}),
      ...(input.company ? { company: input.company } : {}),
    }).ok;

  function ingestBatch(candidates: readonly IngestCandidate[], ctx: IngestContext = {}): IngestBatchResult {
    const result: IngestBatchResult = {
      found: candidates.length,
      accepted: 0,
      duplicate: 0,
      rejected: 0,
      dismissed: 0,
      jobIds: [],
    };
    for (const c of candidates) {
      let r: IngestResult;
      try {
        r = ingestOne(c, ctx);
      } catch (e) {
        // a single malformed candidate must never sink the batch (or the lane). Count it as rejected.
        log(`ingest: candidate error (${text(c.job_url)}): ${e instanceof Error ? e.message : String(e)}`);
        result.rejected += 1;
        continue;
      }
      if (r.outcome === 'accepted') {
        result.accepted += 1;
        if (r.jobId) result.jobIds.push(r.jobId);
      } else if (r.outcome === 'duplicate') {
        result.duplicate += 1;
        if (r.jobId) result.jobIds.push(r.jobId);
      } else if (r.outcome === 'dismissed') {
        result.dismissed += 1;
      } else {
        result.rejected += 1;
      }
    }
    return result;
  }

  return { ingestOne, ingestBatch, isJobPosting: gate, jobGate, track };
}
