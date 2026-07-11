// ats-boards.ts — public-JSON-board fetch + parse + gates for the three high-conversion ATSes. Ported
// from v11 discovery/ats-boards.js (the module that fixed Greenhouse/Lever/Ashby sitting STARVED at ~0
// done because nothing ever queried their public boards). No scraping, no API key: each ATS exposes an
// unauthenticated JSON endpoint that returns EVERY role at a company.
//
//   Greenhouse  GET https://boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true   → { jobs: [...] }
//   Lever       GET https://api.lever.co/v0/postings/<token>?mode=json                     → [...]
//   Ashby       GET https://api.ashbyhq.com/posting-api/job-board/<token>?includeCompensation=true → { jobs: [...] }
//
// Because a board returns roles WORLDWIDE with no query scoping (unlike a LinkedIn/Indeed search whose
// query already constrains keyword+location), the two positive gates here are load-bearing (§1.11): without
// them a Canada user's queue floods with SF/London/Bengaluru roles. `fetchImpl` is injected so tests feed
// canned JSON and real network is never hit.

/** the three public-JSON-board ATSes (== company_tokens.ats). Duplicated from the DAL's union to keep this
 *  fetch/parse layer free of a db-layer import; the unions are identical so values cross the boundary. */
export type Ats = 'greenhouse' | 'lever' | 'ashby';

/** A normalized posting — already in the shape the ingest chokepoint consumes (plus `remote`, which the
 *  location gate needs). apply_capability is always 'ats_form': these are hosted ATS application forms. */
export interface AtsPosting {
  source: Ats;
  external_id: string; // '<ats>:<board-native id>' — stable per posting
  title: string;
  company: string;
  location: string;
  work_mode: 'remote' | null; // boards don't reliably distinguish hybrid/onsite → remote|null only
  job_url: string;
  apply_capability: 'ats_form';
  employment_type: string | null;
  description: string;
  posted_at: number | null; // epoch-ms
  remote: boolean; // gate input only (not persisted on jobs)
}

/** The keyword + location gate the service reads from settings.autoApply. Empty arrays/blank = keep all. */
export interface Gate {
  keywords?: string[];
  locations?: string[];
  country?: string;
}

/** Minimal response contract fetchImpl must satisfy — structurally a subset of the DOM `Response`, so the
 *  default (globalThis.fetch) drops in and a test fake is `{ ok, status, json: async () => canned }`. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchImpl = (url: string) => Promise<FetchResponse>;

/** default: the platform fetch (Node 22 / Electron main both provide it), with a 15s abort so a hung ATS
 *  can never wedge a lane. Wrapped so `this` never rebinds; tests inject their own fetchImpl instead. */
export const defaultFetch: FetchImpl = (url) => fetch(url, { signal: AbortSignal.timeout(15_000) });

/** result of a single board fetch: transport status + the raw records array (already unwrapped per ATS). */
export interface BoardFetch {
  ok: boolean;
  status: number;
  records: unknown[];
}

const DESCRIPTION_MAX = 16000; // keep sightings light; jobs.upsert would clamp far higher anyway
const REMOTE_RX = /\bremote\b|\bwork from home\b|\bwfh\b|\banywhere\b/i;

function text(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

// ---- endpoints -------------------------------------------------------------------------------------

export function boardUrl(ats: Ats, token: string): string {
  const t = encodeURIComponent(text(token));
  switch (ats) {
    case 'greenhouse':
      return `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`;
    case 'lever':
      return `https://api.lever.co/v0/postings/${t}?mode=json`;
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`;
  }
}

/** Unwrap the ATS-specific envelope to a bare records array. Greenhouse/Ashby wrap in `{ jobs }`; Lever
 *  returns a bare array. Anything unexpected → [] (a bad token can't crash a scan). */
function extractRecords(data: unknown, ats: Ats): unknown[] {
  if (ats === 'lever') return Array.isArray(data) ? data : [];
  const jobs = (data as { jobs?: unknown } | null)?.jobs;
  return Array.isArray(jobs) ? jobs : [];
}

/**
 * Fetch one board. NEVER throws on an HTTP-level problem: a non-200 resolves to {ok:false, status,
 * records:[]} so the caller can branch on 429/403 (breaker) vs other non-200 (dead token) without a
 * try/catch. A genuine network rejection DOES throw (the caller wraps the fetch in try/catch to record
 * an 'error' batch). A 200 whose body isn't parseable JSON resolves to ok:true with records:[].
 */
export async function fetchBoard(
  ats: Ats,
  token: string,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<BoardFetch> {
  const res = await fetchImpl(boardUrl(ats, token));
  if (!res.ok) return { ok: false, status: res.status, records: [] };
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: true, status: res.status, records: [] };
  }
  return { ok: true, status: res.status, records: extractRecords(data, ats) };
}

// ---- normalization ---------------------------------------------------------------------------------

/** Strip HTML → plain text for a board description (the content field is raw HTML on Greenhouse/Ashby). */
export function stripHtml(html: unknown): string {
  return text(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** ISO string / epoch-number → epoch-ms, or null. Lever's createdAt is already ms; the others are ISO. */
function toEpochMs(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Map ONE raw board record to an AtsPosting. Returns null if the record lacks the identity trio
 *  (id + url + title) — a malformed record is skipped, never upserted. */
export function normalizeAtsRecord(raw: unknown, ats: Ats, token: string): AtsPosting | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tok = text(token);

  if (ats === 'greenhouse') {
    const id = r.id != null ? String(r.id) : '';
    const jobUrl = text(r.absolute_url);
    const title = text(r.title);
    if (!id || !jobUrl || !title) return null;
    const location = text((r.location as { name?: unknown } | null)?.name);
    const remote = REMOTE_RX.test(location) || REMOTE_RX.test(title);
    return {
      source: 'greenhouse',
      external_id: `greenhouse:${id}`,
      title,
      company: tok,
      location,
      work_mode: remote ? 'remote' : null,
      job_url: jobUrl,
      apply_capability: 'ats_form',
      employment_type: null,
      description: stripHtml(r.content).slice(0, DESCRIPTION_MAX),
      posted_at: toEpochMs(r.updated_at),
      remote,
    };
  }

  if (ats === 'lever') {
    const id = text(r.id);
    const jobUrl = text(r.hostedUrl) || text(r.applyUrl);
    const title = text(r.text);
    if (!id || !jobUrl || !title) return null;
    const categories = (r.categories as Record<string, unknown> | null) ?? {};
    const location = text(categories.location);
    const remote = REMOTE_RX.test(location) || REMOTE_RX.test(title);
    return {
      source: 'lever',
      external_id: `lever:${id}`,
      title,
      company: tok,
      location,
      work_mode: remote ? 'remote' : null,
      job_url: jobUrl,
      apply_capability: 'ats_form',
      employment_type: text(categories.commitment) || null,
      description: stripHtml(r.descriptionPlain ?? r.description).slice(0, DESCRIPTION_MAX),
      posted_at: toEpochMs(r.createdAt),
      remote,
    };
  }

  // ashby
  const id = text(r.id);
  const jobUrl = text(r.jobUrl) || text(r.applyUrl);
  const title = text(r.title);
  if (!id || !jobUrl || !title) return null;
  const location = text(r.location);
  const remote = r.isRemote === true || REMOTE_RX.test(location) || REMOTE_RX.test(title);
  return {
    source: 'ashby',
    external_id: `ashby:${id}`,
    title,
    company: tok,
    location,
    work_mode: remote ? 'remote' : null,
    job_url: jobUrl,
    apply_capability: 'ats_form',
    employment_type: text(r.employmentType) || null,
    description: stripHtml(r.descriptionPlain ?? r.description).slice(0, DESCRIPTION_MAX),
    posted_at: toEpochMs(r.publishedAt),
    remote,
  };
}

/** Parse a raw records array into normalized postings, dropping malformed records. */
export function parseBoard(records: unknown[], ats: Ats, token: string): AtsPosting[] {
  const out: AtsPosting[] = [];
  for (const rec of records) {
    const p = normalizeAtsRecord(rec, ats, token);
    if (p) out.push(p);
  }
  return out;
}

// ---- gates -----------------------------------------------------------------------------------------

/** Positive TITLE gate: keep a posting whose title contains ANY configured keyword (case-insensitive).
 *  Empty keyword list = keep all (never surprises a user who set none). */
export function titleMatchesKeywords(title: string, keywords?: string[]): boolean {
  const list = (keywords ?? []).map((k) => text(k).toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const t = text(title).toLowerCase();
  return list.some((k) => t.includes(k));
}

/**
 * Positive LOCATION gate (the location-analogue of the keyword gate). A posting is eligible if EITHER
 * its location text contains one of the target terms (locations + country — e.g. "toronto"/"canada"
 * matches "Toronto, ON, Canada"), OR it's a remote role with NO foreign country named (strip the
 * remote/region filler; if nothing meaningful remains it's a generic remote, plausibly local-eligible —
 * but "United States - Remote" / "EMEA" leaves a residual → NOT eligible). Empty targets = keep all.
 */
export function locationEligible(posting: AtsPosting, locations?: string[], country?: string): boolean {
  const terms = [...(locations ?? []), country ?? '']
    .map((x) => text(x).toLowerCase())
    .filter(Boolean);
  if (!terms.length) return true;
  const loc = text(posting.location).toLowerCase();
  if (terms.some((t) => loc.includes(t))) return true;
  if (posting.remote) {
    const residual = loc
      .replace(/\b(remote|work from home|wfh|anywhere|worldwide|global|distributed|hybrid|on-?site|in office)\b/g, ' ')
      .replace(/\b(north america|americas|n\.?a\.?)\b/g, ' ')
      .replace(/[^a-z]+/g, ' ')
      .trim();
    if (!residual) return true; // generic remote, no foreign country named
  }
  return false;
}

/** Apply BOTH gates to a batch of postings (the exact filter the service runs post-parse). */
export function applyGates(postings: AtsPosting[], gate: Gate): AtsPosting[] {
  return postings.filter(
    (p) => titleMatchesKeywords(p.title, gate.keywords) && locationEligible(p, gate.locations, gate.country),
  );
}
