// service.ts — the ATS-board discovery service. runOnce() scans each enabled ats_board lane's due company
// tokens, keyword/location-gates the postings, upserts the survivors as jobs, records provenance
// (job_sightings), and writes a yield-only telemetry batch — and NOTHING on a dry scan. start()/stop()
// schedule ONE croner tick PER LANE, so a wedged or rate-limited lane sets its own breaker and can never
// block another (the v11.83 shared-refill-gate starvation is structurally impossible here).
//
// The anti-starvation guarantees, made concrete:
//   • per-lane crons + a per-lane in-flight guard → lanes are independent; one hanging fetch can't stall
//     the others (croner `protect:true` also skips an overrun of the SAME lane).
//   • a 429/403 sets THAT lane's cooldown_until and stops scanning it — the other lanes keep running.
//   • an empty / no-match scan records no batch (yield-only telemetry) and bumps the token's dead_count;
//     5 consecutive dead scans auto-retire the token so dead boards stop consuming rotation slots.
//
// Everything network-facing goes through the injected fetchImpl (default globalThis.fetch), so tests feed
// canned JSON and real network is never hit.

import { Cron } from 'croner';
import type { Dal } from '../db/dal/index.js';
import type { JobInput } from '../db/dal/jobs.js';
import type { DiscoveryDal, TokenInput, SourcePatch } from '../db/dal/discovery.js';
import {
  fetchBoard,
  parseBoard,
  applyGates,
  type Ats,
  type AtsPosting,
  type FetchImpl,
  type Gate,
} from './ats.js';
import SEED_TOKENS_RAW from './seed-tokens.json';

/** the three JSON-board lanes this service owns. */
const ATS_LANES = ['greenhouse', 'lever', 'ashby'] as const satisfies readonly Ats[];

const DEFAULT_TOKENS_PER_TICK = 10; // round-robin N slugs per lane per tick (v11 proven)
const DEFAULT_INTERVAL_MIN = 15; // ~15-min lane cadence (v11's self-throttle floor rationale)
const COOLDOWN_MS = 30 * 60 * 1000; // 30-min lane breaker after a 429/403 (v11)

/** seed list, narrowed from the JSON to the ATS union (a stray/typo'd ats value is dropped, not trusted). */
const SEED_TOKENS: TokenInput[] = (SEED_TOKENS_RAW as { ats: string; token: string }[])
  .filter((t): t is { ats: Ats; token: string } =>
    t.ats === 'greenhouse' || t.ats === 'lever' || t.ats === 'ashby',
  )
  .map((t) => ({ ats: t.ats, token: t.token }));

export interface DiscoveryServiceDeps {
  dal: Dal;
  discoveryDal: DiscoveryDal;
  /** injected in tests (canned JSON); defaults to the platform fetch in prod. */
  fetchImpl?: FetchImpl;
  now?: () => number;
  log?: (msg: string) => void;
  /** tokens polled per lane per tick (default 10). */
  tokensPerTick?: number;
  /** ms between sequential fetches within a lane — politeness pacing (default 0; prod sets ~1500). */
  spacingMs?: number;
  /** lane cadence in minutes for the scheduled ticks (default 15). */
  intervalMinutes?: number;
  /** override the seed token set (tests inject a tiny list). */
  seedTokens?: readonly TokenInput[];
}

export interface LaneResult {
  ats: Ats;
  sourceId: string;
  scanned: number; // tokens fetched this tick
  found: number; // gated postings across those tokens
  accepted: number; // newly-inserted jobs
  duplicate: number; // re-sighted jobs
  batches: number; // telemetry rows written
  skipped?: 'disabled' | 'cooldown' | 'busy';
}

export interface RunOnceResult {
  ranAt: number;
  lanes: LaneResult[];
}

export interface DiscoveryService {
  /** scan every enabled ats_board lane once (sequentially). Bypasses the settings master switch — this is
   *  the explicit "run now" path (POST /api/discovery/run) as well as the body of a scheduled tick. */
  runOnce(): Promise<RunOnceResult>;
  /** scan a single lane once. */
  runLane(ats: Ats): Promise<LaneResult>;
  /** start the per-lane scheduled ticks (each gated on settings.discovery.enabled at fire time). */
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 1024);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** cron minute-list for lane `index` in an `interval`-minute cadence, staggered by 5 min so the three
 *  lanes don't all hammer their ATS at the same wall-clock minute. e.g. interval 15 → 0,15,30,45 /
 *  5,20,35,50 / 10,25,40,55. */
function lanePattern(index: number, interval: number): string {
  const step = Math.min(5, Math.max(1, Math.floor(interval / ATS_LANES.length) || 1));
  const start = (index * step) % Math.max(interval, 1);
  const minutes: number[] = [];
  for (let m = start; m < 60; m += interval) minutes.push(m);
  return `${minutes.join(',')} * * * *`;
}

export function makeDiscoveryService(deps: DiscoveryServiceDeps): DiscoveryService {
  const { dal, discoveryDal } = deps;
  const fetchImpl = deps.fetchImpl; // undefined → fetchBoard uses its own default
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const tokensPerTick = deps.tokensPerTick ?? DEFAULT_TOKENS_PER_TICK;
  const spacingMs = deps.spacingMs ?? 0;
  const intervalMinutes = deps.intervalMinutes ?? DEFAULT_INTERVAL_MIN;
  const seeds = deps.seedTokens ?? SEED_TOKENS;

  const inFlight = new Set<Ats>();
  let seeded = false;
  let crons: Cron[] = [];

  /** Idempotent: ensure the three ats_board lane rows exist and the seed tokens are loaded. Runs once. */
  function ensureSeeded(): void {
    if (seeded) return;
    for (const ats of ATS_LANES) {
      if (!discoveryDal.sourceGet(ats)) discoveryDal.sourceUpsert(ats); // kind ats_board, enabled 1
    }
    const inserted = discoveryDal.seedTokens(seeds);
    if (inserted > 0) log(`discovery: seeded ${inserted} company token(s)`);
    seeded = true;
  }

  /** the keyword + location gate, read fresh from settings each tick (so a settings change takes effect
   *  on the next scan without a restart). */
  function readGate(): Gate {
    return {
      keywords: asStringArray(dal.settings.getKey('autoApply', 'keywords')),
      locations: asStringArray(dal.settings.getKey('autoApply', 'locations')),
      country: asString(dal.settings.getKey('autoApply', 'country')),
    };
  }

  function masterEnabled(): boolean {
    return dal.settings.getKey('discovery', 'enabled') === true;
  }

  /** normalized AtsPosting → the jobs.upsert input shape (apply_capability pinned to 'ats_form'). */
  function toJobInput(p: AtsPosting): JobInput {
    return {
      source: p.source,
      job_url: p.job_url,
      external_id: p.external_id,
      title: p.title,
      company: p.company,
      location: p.location,
      work_mode: p.work_mode,
      employment_type: p.employment_type,
      apply_capability: 'ats_form',
      description: p.description,
    };
  }

  function skip(ats: Ats, sourceId: string, reason: 'disabled' | 'cooldown' | 'busy'): LaneResult {
    return { ats, sourceId, scanned: 0, found: 0, accepted: 0, duplicate: 0, batches: 0, skipped: reason };
  }

  async function runLane(ats: Ats): Promise<LaneResult> {
    ensureSeeded();
    let source = discoveryDal.sourceGet(ats);
    if (!source) source = discoveryDal.sourceUpsert(ats);

    if (source.enabled !== 1) return skip(ats, source.id, 'disabled');
    const startedAt = now();
    if (source.cooldown_until !== null && source.cooldown_until > startedAt) {
      return skip(ats, source.id, 'cooldown'); // lane breaker still open — other lanes are unaffected
    }
    if (inFlight.has(ats)) return skip(ats, source.id, 'busy'); // never run a lane concurrently with itself

    inFlight.add(ats);
    try {
      const gate = readGate();
      const due = discoveryDal.tokensDue(ats, tokensPerTick);
      let scanned = 0;
      let found = 0;
      let accepted = 0;
      let duplicate = 0;
      let batches = 0;
      let breakered = false;

      for (let i = 0; i < due.length; i++) {
        const tok = due[i]!;
        if (i > 0 && spacingMs > 0) await sleep(spacingMs); // be a good API citizen
        scanned += 1;

        let res;
        try {
          res = await fetchBoard(ats, tok.token, fetchImpl);
        } catch (e) {
          // a genuine network rejection — diagnostic 'error' batch (allowed by the CHECK), lane continues.
          discoveryDal.recordBatch({ sourceId: source.id, companyTokenId: tok.id, keyword: tok.token, status: 'error', error: errMsg(e) });
          batches += 1;
          continue;
        }

        if (res.status === 429 || res.status === 403) {
          // rate-limited → trip THIS lane's breaker and stop scanning it; the other lanes keep going.
          discoveryDal.recordBatch({ sourceId: source.id, companyTokenId: tok.id, keyword: tok.token, status: 'rate_limited', error: `HTTP ${res.status}` });
          batches += 1;
          discoveryDal.sourceUpsert(ats, { cooldown_until: startedAt + COOLDOWN_MS, breaker_reason: `rate_limited HTTP ${res.status}` });
          breakered = true;
          break;
        }

        if (!res.ok) {
          // other non-200 (404 / 5xx) → a dead scan: record nothing, bump dead_count (auto-retire at 5).
          discoveryDal.tokenScanned(tok.id, { yielded: false });
          continue;
        }

        const parsed = parseBoard(res.records, ats, tok.token);
        const gated = applyGates(parsed, gate);

        if (gated.length === 0) {
          // EMPTY / no-match scan → record NOTHING (no batch, no broadcast) — the yield-only law.
          discoveryDal.tokenScanned(tok.id, { yielded: false });
          continue;
        }

        let laneAccepted = 0;
        let laneDuplicate = 0;
        for (const p of gated) {
          const up = dal.jobs.upsert(toJobInput(p));
          discoveryDal.recordSighting({ jobId: up.job.id, sourceId: source.id, applyCapability: 'ats_form', rawUrl: p.job_url });
          if (up.action === 'inserted') laneAccepted += 1;
          else laneDuplicate += 1;
        }

        // YIELD → the single telemetry row for this scan (and the single discovery.updated broadcast).
        discoveryDal.recordBatch({
          sourceId: source.id,
          companyTokenId: tok.id,
          keyword: tok.token,
          location: gate.country ?? null,
          status: 'ok',
          found: gated.length,
          accepted: laneAccepted,
          duplicate: laneDuplicate,
          rejected: parsed.length - gated.length,
        });
        batches += 1;
        found += gated.length;
        accepted += laneAccepted;
        duplicate += laneDuplicate;
        discoveryDal.tokenScanned(tok.id, { yielded: true });
      }

      // Advance the lane cursor. Clear an EXPIRED breaker on a clean pass — but NEVER the one we just set
      // this tick (that would immediately re-open a rate-limited lane).
      const endPatch: SourcePatch = {
        last_tick_at: now(),
        cursor: { ...source.cursor, lastScanned: scanned, lastFound: found },
      };
      if (!breakered) {
        endPatch.cooldown_until = null;
        endPatch.breaker_reason = null;
      }
      discoveryDal.sourceUpsert(ats, endPatch);

      log(`discovery[${ats}] scanned=${scanned} found=${found} accepted=${accepted} dup=${duplicate}`);
      return { ats, sourceId: source.id, scanned, found, accepted, duplicate, batches };
    } finally {
      inFlight.delete(ats);
    }
  }

  async function runOnce(): Promise<RunOnceResult> {
    ensureSeeded();
    const lanes: LaneResult[] = [];
    for (const ats of ATS_LANES) {
      try {
        lanes.push(await runLane(ats));
      } catch (e) {
        // a lane body should never throw (fetch is guarded), but if it does it must not sink the others.
        log(`discovery[${ats}] tick error: ${errMsg(e)}`);
      }
    }
    return { ranAt: now(), lanes };
  }

  function start(): void {
    if (crons.length) return;
    ensureSeeded();
    crons = ATS_LANES.map((ats, i) =>
      new Cron(lanePattern(i, intervalMinutes), { name: `discovery.${ats}`, protect: true }, () => {
        if (!masterEnabled()) return; // settings master switch gates the SCHEDULED ticks (not runOnce)
        void runLane(ats).catch((e: unknown) => log(`discovery[${ats}] scheduled tick failed: ${errMsg(e)}`));
      }),
    );
    log(`discovery: started ${crons.length} lane scheduler(s) @ every ${intervalMinutes}m`);
  }

  function stop(): void {
    for (const c of crons) c.stop();
    crons = [];
  }

  function isRunning(): boolean {
    return crons.length > 0;
  }

  return { runOnce, runLane, start, stop, isRunning };
}
