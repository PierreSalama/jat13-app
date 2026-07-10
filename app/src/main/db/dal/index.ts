// DAL foundation + aggregate. Stage 1 adds the read/import data surfaces on top of Stage 0's
// settings+secrets: jobs, applications, runs (read-only until the Stage-2 engine), events, emails,
// documents, profiles, answers. Every module is a factory bound to the SAME DalContext — one db
// handle, one clock, one id source, one event sink — so there is exactly one writer path and event
// emission stays uniform. No raw SQL outside db/dal/ (grep-gated law; v13's law leaked without it).
//
// NOTE on module shape: every module imports the foundation back from this file, which is a benign
// ESM cycle — they only use hoisted function declarations + erased types, nothing at
// module-evaluation time. If that ever stops being true, split the foundation into dal/util.ts
// (the old tree's shape) and the cycle disappears.

import type { Database, Statement } from 'better-sqlite3';
import { makeSettingsDal } from './settings.js';
import { makeSecretsDal, type Sealer, type SecretsDal } from './secrets.js';
import { makeJobsDal } from './jobs.js';
import { makeApplicationsDal } from './applications.js';
import { makeRunsDal } from './runs.js';
import { makeEventsDal } from './events.js';
import { makeEmailsDal } from './emails.js';
import { makeDocumentsDal } from './documents.js';
import { makeProfilesDal } from './profiles.js';
import { makeAnswersDal } from './answers.js';

/** Event-sink payload: the CHANGED ROW (or a partial patch), never "refetch everything".
 *  `emit` is a no-op until a consumer (live UI updates — build-or-strike at Stage 0's PatchBus
 *  decision) subscribes; DALs emit unconditionally so the seam already exists either way. */
export interface DomainEvent {
  table: string;
  op: 'insert' | 'update' | 'delete';
  id: string;
  /** the changed lean row (or a partial patch); omitted for deletes. */
  patch?: Record<string, unknown>;
}

export interface DalContext {
  db: Database;
  /** epoch-ms; injectable so tests are deterministic and the importer can backfill historical times. */
  now: () => number;
  /** monotonic, sortable id with a table prefix (e.g. `run_01J…`). */
  newId: (prefix: string) => string;
  /** event-sink hook; no-op until a live consumer subscribes. */
  emit: (evt: DomainEvent) => void;
}

/** Every list read returns this — an explicit page with a total, never a bare unbounded array. */
export interface LeanPage<T> {
  rows: T[];
  total: number;
}

// ---- id generation (ULID: 48-bit time + 80-bit randomness, Crockford base32, lexically sortable) --
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID body (26 chars). Sortable-by-creation is what the timeline/queue ORDER BYs lean on. */
export function ulid(nowMs: number = Date.now()): string {
  let t = nowMs;
  const time = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = CROCKFORD[t % 32]!;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(Math.random() * 32)];
  return time.join('') + rand;
}

/** Default DalContext; real main-process wiring passes the same shapes (with a live emit). */
export function defaultContext(db: Database, emit: DalContext['emit'] = () => {}): DalContext {
  return { db, now: () => Date.now(), newId: (prefix) => `${prefix}_${ulid()}`, emit };
}

/**
 * Prepared-statement cache keyed by SQL text. better-sqlite3 does NOT cache prepares itself, so
 * each DAL builds one of these to avoid recompiling hot queries. Bound to a single db handle.
 */
export function makeStmtCache(db: Database) {
  const cache = new Map<string, Statement>();
  return (sql: string): Statement => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
}

/** Clamp a caller-supplied limit into a sane band (payload-cap discipline; no unbounded scans). */
export function clampLimit(limit: unknown, def: number, max = 1000): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : def;
  return Math.min(Math.max(n, 1), max);
}

/** Clamp a caller-supplied offset to a non-negative integer. */
export function clampOffset(offset: unknown): number {
  return typeof offset === 'number' && Number.isFinite(offset) && offset > 0
    ? Math.floor(offset)
    : 0;
}

// ---- normalizers (ported VERBATIM from v11 db.js via the cb25d19 shared/norm.ts) -------------------
// TEMPORARY HOME: these belong in @jat13/shared/norm (app + extension + importer + tests all need
// them). They live here until shared grows a norm module — when it does, re-point jobs.ts/answers.ts
// imports at the shared copy and DELETE these, so the dedup keys can never fork between two copies.

/** loose slug: lowercase, non-alphanumerics → single spaces. Used for company/label keys. */
export function normKey(s: string | null | undefined): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** query params that identify the posting and must survive URL normalization (id-in-query sites). */
const KEEP_PARAMS = new Set(['currentjobid', 'jk', 'gh_jid', 'gh_src', 'lever-source', 'id']);

/** canonical job URL for dedup: origin+path (no trailing slash), only id-bearing query params kept. */
export function normJobUrl(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (KEEP_PARAMS.has(k.toLowerCase())) keep.set(k.toLowerCase(), v);
    }
    const q = keep.toString();
    return (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase() + (q ? `?${q}` : '');
  } catch {
    return String(raw).toLowerCase();
  }
}

// EN/FR token canonicalization + fillers so "years of experience" == "annees experience", and
// word order / language don't fork the learned-answer key. Ported from v11 db.js QA_CANON/QA_FILLERS.
const QA_CANON: Record<string, string> = {
  francais: 'french', anglais: 'english', espagnol: 'spanish', allemand: 'german',
  annee: 'years', annees: 'years', ans: 'years', an: 'years',
  experiences: 'experience',
  courriel: 'email', mail: 'email', adresse: 'address',
  prenom: 'firstname', telephone: 'phone', tel: 'phone', portable: 'phone',
  ville: 'city', pays: 'country', langue: 'language', langues: 'language',
  numero: 'number', mois: 'months', semaine: 'weeks', semaines: 'weeks',
  niveau: 'level', nom: 'name', noms: 'name',
  parlez: 'speak', parler: 'speak', parle: 'speak', parlons: 'speak',
  salaire: 'salary', remuneration: 'salary', poste: 'position',
  diplome: 'degree', formation: 'education',
  competence: 'skill', competences: 'skill',
  autorisation: 'authorization', autorise: 'authorized',
  travail: 'work', travailler: 'work', travaille: 'work', emploi: 'work',
  disponibilite: 'availability', disponible: 'available', preavis: 'notice',
};

const QA_FILLERS = new Set(
  (
    'please kindly select choose enter provide specify the a an your you do did does ' +
    'are is have has had will would can could how many much what which with in for of to at on ' +
    'veuillez selectionnez choisissez entrez indiquez precisez votre vos le la les un une des du de ' +
    'est sont avez quel quelle quels quelles combien dans pour sur au aux et ou si vous tu ton ta tes'
  ).split(/\s+/),
);

/** bag-of-words key for a screening question: fold diacritics, canonicalize EN/FR, drop fillers,
 *  dedup + SORT so word order and language don't fork the key. Caps at 120 chars. */
export function normQuestion(q: string | null | undefined): string {
  const folded = String(q || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const toks = new Set<string>();
  for (let t of folded.split(/[^a-z0-9]+/)) {
    if (!t) continue;
    t = QA_CANON[t] || t;
    if (QA_FILLERS.has(t)) continue;
    toks.add(t);
  }
  return [...toks].sort().join(' ').slice(0, 120);
}

// ---- the aggregate -------------------------------------------------------------------------------

export interface Dal {
  jobs: ReturnType<typeof makeJobsDal>;
  applications: ReturnType<typeof makeApplicationsDal>;
  runs: ReturnType<typeof makeRunsDal>;
  events: ReturnType<typeof makeEventsDal>;
  emails: ReturnType<typeof makeEmailsDal>;
  documents: ReturnType<typeof makeDocumentsDal>;
  profiles: ReturnType<typeof makeProfilesDal>;
  answers: ReturnType<typeof makeAnswersDal>;
  settings: ReturnType<typeof makeSettingsDal>;
  secrets: SecretsDal;
  /** the shared context, so callers can run their own ctx.db.transaction / emit / newId. */
  ctx: DalContext;
}

/**
 * Build the DAL. Secrets needs a Sealer (Electron safeStorage in main; a fake in tests) —
 * the only external dependency any module takes; injected because safeStorage does not exist under
 * vitest and plaintext-fallback is forbidden.
 */
export function makeDal(ctx: DalContext, deps: { sealer: Sealer }): Dal {
  return {
    jobs: makeJobsDal(ctx),
    applications: makeApplicationsDal(ctx),
    runs: makeRunsDal(ctx),
    events: makeEventsDal(ctx),
    emails: makeEmailsDal(ctx),
    documents: makeDocumentsDal(ctx),
    profiles: makeProfilesDal(ctx),
    answers: makeAnswersDal(ctx),
    settings: makeSettingsDal(ctx),
    secrets: makeSecretsDal(ctx, deps.sealer),
    ctx,
  };
}

// Re-exports so consumers import the whole DAL surface from one place.
export type { Sealer, SecretsDal, SecretHealth, ReportUseInput, SecretFailureReason } from './secrets.js';
export type { SettingsSnapshot, SettingSpec, SettingType, SettingsRegistry } from './settings.js';
export { SETTINGS_REGISTRY, validate as validateSetting } from './settings.js';
export type {
  JobInput, JobLean, JobDetail, JobPatch, UpsertResult,
  ApplyCapability, WorkMode, PostingState,
} from './jobs.js';
export type {
  ApplicationStatus, ApplicationVia, ApplicationRow, ApplicationLean, ApplicationDetail,
  ApplicationPatch,
} from './applications.js';
export type { Run, RunLean, RunStep, RunState, RunLane, RunMode, RunRoute, ParkKind, EvidenceKind, StepPhase } from './runs.js';
export type { EventKind, EventRow, RecordEventInput } from './events.js';
export { EVENT_KINDS } from './events.js';
export type {
  EmailAccountLean, EmailLean, EmailSuggestion, EmailMatch, EmailCategory,
  UpsertEmailInput, SetMatchInput,
} from './emails.js';
export type { DocumentLean, DocumentRole, DocumentSource, GuardrailStatus, AddDocumentInput } from './documents.js';
export type { ProfileRow, ProfileLean, CreateProfileInput } from './profiles.js';
export type { LearnedAnswer, LearnedAnswerLean, AnswerKind, FieldType, Provenance, RecordInput } from './answers.js';
export { isSensitiveKey } from './answers.js';
