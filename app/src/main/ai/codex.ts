// JAT 13 — Codex CLI AI service (cloud, Pierre's ChatGPT/Codex subscription; NO API keys).
//
// This is the TS port of v11 app/src/ai/codex.js. The Codex desktop app ships a managed CLI at a
// hash-rotating path; we resolve it via a discovery ladder, run it as a child process, and let the
// CLI own its own credentials in CODEX_HOME (~/.codex) — we never read, store, or hardcode a token.
//
// Invocation contract (verified against codex-cli 0.13x alpha):
//   codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config
//              -s read-only -C <tmp> [-m <model>] [--output-schema <schema.json>]
//   prompt on stdin; env CODEX_HOME; JSONL progress events on stdout — we parse the FINAL
//   assistant message out of that stream (v13 reads stdout directly, not a --output-last-message file).
//   --ignore-user-config matters: Pierre's config.toml spins up MCP servers we must not pay for on
//   every call; auth still resolves via CODEX_HOME.
//
// TESTABILITY: every real spawn/discovery goes through ONE seam — `RunCodex`. The default impl does
// the discovery + child_process work; tests inject a fake that returns canned JSONL, so no real Codex
// is ever needed to exercise status parsing, generation, unauthorized detection, or the ai_calls log.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DalContext } from '../db/dal/util.js';
import { isSensitiveKey } from '../db/dal/answers.js';
import { normQuestion } from '@jat13/shared/norm';

// ---- constants --------------------------------------------------------------
const CODEX_HOME = join(homedir(), '.codex');
const STATUS_TIMEOUT_MS = 10_000;
const DEFAULT_GENERATE_TIMEOUT_MS = 120_000;

// ---- typed errors -----------------------------------------------------------
export type CodexErrorCode =
  | 'CODEX_NOT_FOUND'
  | 'CODEX_UNAUTHORIZED'
  | 'CODEX_TIMEOUT'
  | 'CODEX_EXIT'
  | 'CODEX_EMPTY'
  | 'CODEX_BADJSON';

/** A typed error carrying a stable `code` — callers branch on `.code`, never on the message string. */
export class CodexError extends Error {
  readonly code: CodexErrorCode;
  constructor(code: CodexErrorCode, message: string) {
    super(message);
    this.name = 'CodexError';
    this.code = code;
  }
}

// ---- discovery --------------------------------------------------------------
export type CodexSource = 'manual' | 'native-host' | 'localappdata' | 'path';

export interface DiscoveredCli {
  cli: string;
  source: CodexSource;
}

/**
 * Resolve the Codex CLI via the ladder (first hit wins):
 *   1. `explicitPath` — a user-set settings.ai.codexPath (published users who point us at their binary).
 *   2. ~/.codex/chrome-native-hosts.json → chromeNativeHosts[0].codexCliPath (the desktop app's pointer).
 *   3. newest codex.exe under %LOCALAPPDATA%/OpenAI/Codex/bin (the managed, hash-rotating install).
 *   4. `codex` on PATH (present if `npm i -g @openai/codex`).
 * Never ~/.codex/.sandbox-bin (a stale build). Returns null when nothing resolves.
 */
export function discoverCli(explicitPath?: string): DiscoveredCli | null {
  // 1. explicit path
  if (explicitPath && existsSync(explicitPath)) return { cli: explicitPath, source: 'manual' };

  // 2. chrome-native-hosts.json pointer
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(CODEX_HOME, 'chrome-native-hosts.json'), 'utf8'));
    const rec = asRecord(parsed);
    const hosts = rec ? rec['chromeNativeHosts'] : undefined;
    const first = Array.isArray(hosts) ? asRecord(hosts[0]) : null;
    const p = first && typeof first['codexCliPath'] === 'string' ? (first['codexCliPath'] as string) : '';
    if (p && existsSync(p)) return { cli: p, source: 'native-host' };
  } catch {
    /* missing/corrupt pointer — fall through */
  }

  // 3. newest managed binary under LOCALAPPDATA
  try {
    const binRoot = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
    const candidates = readdirSync(binRoot)
      .map((d) => join(binRoot, d, 'codex.exe'))
      .filter((p) => existsSync(p))
      .map((p) => ({ p, m: statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    const top = candidates[0];
    if (top) return { cli: top.p, source: 'localappdata' };
  } catch {
    /* no managed install — fall through */
  }

  // 4. `codex` on PATH
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const r = spawnSync(cmd, ['codex'], { encoding: 'utf8' });
    const p = (r.stdout ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (p && existsSync(p)) return { cli: p, source: 'path' };
  } catch {
    /* no PATH entry */
  }

  return null;
}

// ---- the injectable seam ----------------------------------------------------
export interface CodexCall {
  /** 'exec' → a generation; 'login-status' → the auth probe. */
  mode: 'exec' | 'login-status';
  /** the prompt written to stdin (exec only). */
  prompt?: string | undefined;
  model?: string | undefined;
  /** JSON schema for --output-schema (exec only); also signals the parse layer to coerce JSON. */
  schema?: unknown;
  timeoutMs: number;
  /** overrides discovery rung 1 (settings.ai.codexPath). */
  explicitPath?: string | undefined;
}

export interface CodexRaw {
  /** was the CLI discovered? false → CODEX_NOT_FOUND upstream. */
  found: boolean;
  source?: CodexSource | undefined;
  cli?: string | undefined;
  /** process exit code (null when killed/timed-out/spawn-error). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean | undefined;
}

/** The one seam the whole service is built on. The default impl discovers + spawns; tests fake it. */
export type RunCodex = (call: CodexCall) => Promise<CodexRaw>;

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawn a child, feed optional stdin, collect stdout/stderr, enforce a hard timeout. Never rejects. */
function spawnCollect(
  cli: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; stdin?: string | undefined; timeoutMs: number },
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const child = spawn(cli, args, { env: opts.env, windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, opts.timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }));
    child.on('error', (e: Error) => finish({ code: null, stdout, stderr: `${stderr}\n${e.message}`, timedOut: false }));

    if (opts.stdin !== undefined) {
      try {
        child.stdin?.write(opts.stdin);
        child.stdin?.end();
      } catch {
        /* stdin closed early */
      }
    } else {
      try {
        child.stdin?.end();
      } catch {
        /* noop */
      }
    }
  });
}

/** The real seam: resolve the CLI and run it (login status or an ephemeral exec). */
export const defaultRunCodex: RunCodex = async (call) => {
  const found = discoverCli(call.explicitPath);
  if (!found) return { found: false, code: null, stdout: '', stderr: '' };

  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME };

  if (call.mode === 'login-status') {
    const r = await spawnCollect(found.cli, ['login', 'status'], { env, timeoutMs: call.timeoutMs });
    return { found: true, source: found.source, cli: found.cli, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
  }

  // exec: ephemeral, read-only, ignore user config, JSONL to stdout.
  const work = mkdtempSync(join(tmpdir(), 'jat13-codex-'));
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '-s',
    'read-only',
    '-C',
    work,
  ];
  if (call.model) args.push('-m', call.model);
  if (call.schema !== undefined) {
    const schemaFile = join(work, 'schema.json');
    writeFileSync(schemaFile, JSON.stringify(call.schema));
    args.push('--output-schema', schemaFile);
  }
  try {
    const r = await spawnCollect(found.cli, args, { env, stdin: call.prompt ?? '', timeoutMs: call.timeoutMs });
    return { found: true, source: found.source, cli: found.cli, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* best-effort tmp cleanup */
    }
  }
};

// ---- parsing helpers --------------------------------------------------------
function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** Pull assistant text out of one JSONL event, tolerating the several shapes the alpha CLI has used. */
function pickAssistantText(ev: unknown): string | null {
  const rec = asRecord(ev);
  if (!rec) return null;

  // A) {type:'item.completed', item:{type:'agent_message', text:'...'}}
  const item = asRecord(rec['item']);
  if (item && item['type'] === 'agent_message' && typeof item['text'] === 'string') return item['text'];

  // B) {msg:{type:'agent_message', message:'...'}}
  const msg = asRecord(rec['msg']);
  if (msg && msg['type'] === 'agent_message') {
    if (typeof msg['message'] === 'string') return msg['message'];
    if (typeof msg['text'] === 'string') return msg['text'];
  }

  // C) {type:'agent_message', message|text:'...'}
  if (rec['type'] === 'agent_message') {
    if (typeof rec['message'] === 'string') return rec['message'];
    if (typeof rec['text'] === 'string') return rec['text'];
  }

  // D) {role:'assistant'|type:'message', content: string | [{type:'text', text:'...'}]}
  if (rec['role'] === 'assistant' || rec['type'] === 'message') {
    const content = rec['content'];
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = content
        .map((c) => {
          if (typeof c === 'string') return c;
          const cr = asRecord(c);
          return cr && typeof cr['text'] === 'string' ? (cr['text'] as string) : '';
        })
        .filter(Boolean);
      if (parts.length) return parts.join('');
    }
  }

  return null;
}

/** Parse JSONL stdout and return the LAST assistant message (trimmed), or '' if none. */
export function extractAssistantText(stdout: string): string {
  let last = '';
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(t);
    } catch {
      continue; // non-JSON progress noise
    }
    const text = pickAssistantText(ev);
    if (text) last = text;
  }
  return last.trim();
}

/** Coerce JSON out of a model response — handles a bare object, ```json fences, or JSON amid prose. */
function coerceJson(text: string): unknown {
  const candidates = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) candidates.push(text.slice(firstBracket, lastBracket + 1));

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next candidate */
    }
  }
  throw new CodexError('CODEX_BADJSON', 'codex output did not parse as JSON despite a schema');
}

/** Auth failure signalled anywhere in the CLI output? (login required / unauthorized / not logged in) */
function looksUnauthorized(raw: CodexRaw): boolean {
  const blob = `${raw.stdout}\n${raw.stderr}`.toLowerCase();
  if (blob.includes('unauthorized')) return true;
  if (blob.includes('not logged in')) return true;
  if (blob.includes('login required')) return true;
  if (blob.includes('please run') && blob.includes('login')) return true;
  return blob.includes('login') && blob.includes('required');
}

// ---- core status / generate (built on the seam) -----------------------------
export interface CodexStatus {
  available: boolean;
  model?: string | undefined;
  source?: CodexSource | undefined;
  detail: string;
}

async function coreStatus(
  runCodex: RunCodex,
  opts: { explicitPath?: string | undefined; model?: string | undefined; timeoutMs?: number },
): Promise<CodexStatus> {
  let raw: CodexRaw;
  try {
    raw = await runCodex({ mode: 'login-status', timeoutMs: opts.timeoutMs ?? STATUS_TIMEOUT_MS, explicitPath: opts.explicitPath });
  } catch (e) {
    return { available: false, detail: e instanceof Error ? e.message : String(e) };
  }
  if (!raw.found) return { available: false, detail: 'codex CLI not found' };

  const blob = `${raw.stdout}\n${raw.stderr}`;
  // "Not logged in" contains "logged in", so the negative test must run first.
  const unauth = looksUnauthorized(raw) || /not logged in/i.test(blob);
  const authorized = !unauth && raw.code === 0 && /(logged in|authorized|signed in)/i.test(blob);
  const detail = authorized
    ? `authorized${raw.source ? ` (${raw.source})` : ''}`
    : (blob.trim().split(/\r?\n/)[0] ?? '').slice(0, 200) || (raw.code === null ? 'no response' : `exit ${raw.code}`);

  return {
    available: authorized,
    ...(opts.model ? { model: opts.model } : {}),
    ...(raw.source ? { source: raw.source } : {}),
    detail,
  };
}

export interface GenerateOpts {
  prompt: string;
  system?: string | undefined;
  schema?: unknown;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  /** short label recorded in ai_calls.kind (e.g. 'answer-question'). */
  kind?: string | undefined;
  /** overrides discovery rung 1. */
  explicitPath?: string | undefined;
}

export interface GenerateResult {
  text: string;
  json?: unknown;
  ms: number;
}

async function coreGenerate(runCodex: RunCodex, opts: GenerateOpts): Promise<GenerateResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS;
  const fullPrompt = opts.system ? `${opts.system}\n\n---\n\n${opts.prompt}` : opts.prompt;

  const started = Date.now();
  const raw = await runCodex({
    mode: 'exec',
    prompt: fullPrompt,
    model: opts.model,
    schema: opts.schema,
    timeoutMs,
    explicitPath: opts.explicitPath,
  });
  const ms = Date.now() - started;

  if (!raw.found) throw new CodexError('CODEX_NOT_FOUND', 'codex CLI not found — install it or sign into the Codex desktop app');
  if (looksUnauthorized(raw)) throw new CodexError('CODEX_UNAUTHORIZED', 'codex not authorized — run `codex login`');
  if (raw.timedOut) throw new CodexError('CODEX_TIMEOUT', `codex timed out after ${timeoutMs}ms`);

  const text = extractAssistantText(raw.stdout);
  if (!text) {
    if (raw.code !== 0 && raw.code !== null) {
      throw new CodexError('CODEX_EXIT', `codex exited ${raw.code}: ${raw.stderr.trim().slice(0, 300)}`);
    }
    throw new CodexError('CODEX_EMPTY', 'codex returned no output');
  }

  if (opts.schema !== undefined) {
    const json = coerceJson(text);
    return { text, json, ms };
  }
  return { text, ms };
}

/** Standalone status probe using the real seam (direct callers / the /detect route may use this). */
export function status(explicitPath?: string): Promise<CodexStatus> {
  return coreStatus(defaultRunCodex, { explicitPath });
}

/** Standalone generate using the real seam. */
export function generate(opts: GenerateOpts): Promise<GenerateResult> {
  return coreGenerate(defaultRunCodex, opts);
}

// ---- the screening-answer prompt --------------------------------------------
const SYSTEM_BASE =
  'You are a careful assistant completing a job application on behalf of a candidate. Answer AS the ' +
  'candidate. Be concise and factual. Use ONLY the facts provided about the candidate — never invent ' +
  'employers, dates, numbers, credentials, or claims. If you cannot answer truthfully from the provided ' +
  'facts, refuse.';

/** JSON schema for a single screening answer — {value, confidence, refuse, reason}. */
export const SCREENING_SCHEMA = {
  type: 'object',
  required: ['value', 'confidence', 'refuse', 'reason'],
  additionalProperties: false,
  properties: {
    value: { type: 'string', description: 'the answer as the candidate would give it ("" if refusing)' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    refuse: { type: 'boolean' },
    reason: { type: 'string', description: 'one line: why this answer / why refused' },
  },
} as const;

export interface ScreeningControl {
  /** the question text (the runner passes control.groupPrompt || control.name). */
  label: string;
  /** text/textarea/select/radio/checkbox/number/date — shapes the instruction. */
  fieldType?: string | undefined;
  /** choice options, when the control is a select/radio; the model must pick one verbatim. */
  options?: readonly string[] | undefined;
  /** precomputed normalized key; defaults to normQuestion(label). Used for the sensitive guard. */
  keyNorm?: string | undefined;
}

export interface ScreeningContext {
  /** the active profile's free-form field bag (profile.data). */
  profile: Record<string, unknown>;
  context?: {
    job?: { title?: string; company?: string; location?: string };
    resumeText?: string;
    qaHistory?: readonly { question: string; answer: string }[];
  };
}

export interface ScreeningAnswer {
  value: string | null;
  confidence: number;
  refused: boolean;
  reason: string;
}

function clip(s: unknown, n: number): string {
  return String(s ?? '').slice(0, n);
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Render the known profile facts into a compact block (mirrors v11 prompts.profileBlock). */
function profileFacts(profile: Record<string, unknown>): string {
  const g = (k: string): string => {
    const v = profile[k];
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return '';
  };
  const lines: string[] = [];
  const add = (label: string, v: string): void => {
    if (v) lines.push(`${label}: ${clip(v, 400)}`);
  };
  add('Name', [g('firstName'), g('lastName')].filter(Boolean).join(' ') || g('fullName') || g('name'));
  add('Headline', g('headline'));
  add('Summary', g('summary'));
  add('Location', [g('city'), g('region') || g('state'), g('country')].filter(Boolean).join(', ') || g('location'));
  add('Email', g('email'));
  add('Phone', g('phone'));
  add('LinkedIn', g('linkedin') || g('linkedinUrl'));
  add('Website', g('website') || g('portfolioUrl') || g('portfolio'));
  add('Years of experience', g('yearsOfExperience') || g('yearsExperience'));
  add('Work authorization', g('workAuthorization'));
  add('Notice period', g('noticePeriod'));
  add('Education', [g('highestDegree') || g('degree'), g('major'), g('university')].filter(Boolean).join(', '));
  const skills = profile['skills'];
  if (Array.isArray(skills) && skills.length) add('Skills', skills.map((s) => String(s)).join(', '));
  return lines.join('\n') || '(no profile facts provided)';
}

function buildScreeningPrompt(control: ScreeningControl, ctx: ScreeningContext): string {
  const options = control.options ?? [];
  const choice = options.length
    ? `The form is a choice field. Your value MUST be exactly one of these options, verbatim: ${JSON.stringify(options.slice(0, 30))}`
    : 'Free-text field: keep the answer short and natural (a single value for factual questions).';
  const job = ctx.context?.job;
  const jobBlock = job
    ? [job.title ? `Title: ${clip(job.title, 160)}` : '', job.company ? `Company: ${clip(job.company, 160)}` : '', job.location ? `Location: ${clip(job.location, 120)}` : '']
        .filter(Boolean)
        .join('\n') || '(none)'
    : '(none)';
  const history = (ctx.context?.qaHistory ?? [])
    .slice(0, 10)
    .map((q) => `Q: ${clip(q.question, 160)}\nA: ${clip(q.answer, 160)}`)
    .join('\n');

  return `Answer ONE job-application question as the candidate.

HARD RULES:
- Ground the answer ONLY in the candidate facts, job context, resume, and previous answers below.
- If the question is demographic/EEO, salary history, SSN, citizenship/visa specifics not in the facts, or criminal history: set refuse=true.
- If you cannot answer truthfully from the provided data: set refuse=true.
- ${choice}
- confidence (0..1): how certain you are the answer is truthful and appropriate.

THESE COMMON QUESTIONS ARE SAFE to derive from the facts — answer them with HIGH confidence:
- LOCATION / RESIDENCY ("located in / residing in / a resident of <place>?"): derive from the candidate's city/region/country.
- WHICH-LOCATION ("what country/province/city are you in?"): the candidate's country / region / city (match an option verbatim if given).
- PREFERRED LANGUAGE: "English" unless the facts say otherwise.
- RELOCATION / REMOTE / ONSITE ("willing to relocate? / work remotely?"): default Yes — a candidate who applied is presumed open to the arrangement.
- YEARS WITH A SKILL: estimate from the facts/resume; give a concrete number (round down). Never a URL — a number.
- EDUCATION ("hold a <degree>? / highest level?"): from the resume — if the candidate holds that level OR higher → Yes.

== QUESTION ==
${clip(control.label, 500)}${control.fieldType ? `\n(field type: ${control.fieldType})` : ''}

== JOB CONTEXT ==
${jobBlock}

== CANDIDATE FACTS ==
${profileFacts(ctx.profile)}

== RESUME (snippet) ==
${clip(ctx.context?.resumeText, 3000) || '(none)'}

== PREVIOUSLY GIVEN ANSWERS ==
${history || '(none)'}

Return STRICT JSON only: {"value": string, "confidence": number, "refuse": boolean, "reason": string}.`;
}

// ---- the AI service ----------------------------------------------------------
export interface AiSettings {
  /** settings.ai.codexPath — an explicit CLI path (published users). */
  codexPath?: string | undefined;
  /** settings.ai.model — the Codex model id. */
  model?: string | undefined;
  /** settings.ai.codexModel — legacy/registry name for the same thing. */
  codexModel?: string | undefined;
  enabled?: boolean | undefined;
}

export interface AiServiceDeps {
  /** the DAL (or anything exposing ctx.db + ctx.now) — used to write the ai_calls ring row. */
  dal: { ctx: Pick<DalContext, 'db' | 'now'> };
  /** current ai settings section (codexPath / model). Optional; discovery + CLI default still work. */
  settings?: AiSettings | undefined;
  /** INJECTABLE seam — tests pass a fake; production omits it and gets the real spawn/discovery. */
  runCodex?: RunCodex | undefined;
}

export interface AiService {
  /** Auth + discovery probe. `explicitPath` (fresh settings.ai.codexPath) overrides the stored one. */
  status(explicitPath?: string): Promise<CodexStatus>;
  generate(opts: GenerateOpts): Promise<GenerateResult>;
  answerScreeningQuestion(control: ScreeningControl, ctx: ScreeningContext): Promise<ScreeningAnswer>;
}

export function makeAiService(deps: AiServiceDeps): AiService {
  const runCodex: RunCodex = deps.runCodex ?? defaultRunCodex;
  const modelOf = (): string | undefined => deps.settings?.model || deps.settings?.codexModel || undefined;
  const pathOf = (): string | undefined => deps.settings?.codexPath || undefined;

  function logCall(row: {
    model?: string | undefined;
    kind?: string | undefined;
    ms?: number | undefined;
    ok: boolean;
    error?: string | undefined;
    promptChars?: number | undefined;
    responseChars?: number | undefined;
  }): void {
    try {
      deps.dal.ctx.db
        .prepare(
          `INSERT INTO ai_calls (at, provider, model, kind, ms, ok, error, prompt_chars, response_chars)
           VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deps.dal.ctx.now(),
          row.model ?? null,
          row.kind ?? null,
          row.ms ?? null,
          row.ok ? 1 : 0,
          row.error ? row.error.slice(0, 512) : null,
          row.promptChars ?? null,
          row.responseChars ?? null,
        );
    } catch {
      /* metering must never break a run */
    }
  }

  async function status(explicitPath?: string): Promise<CodexStatus> {
    return coreStatus(runCodex, { explicitPath: explicitPath ?? pathOf(), model: modelOf() });
  }

  /** Every generation is metered to ai_calls (ok on success, ok=0 + code/message on failure). */
  async function generate(opts: GenerateOpts): Promise<GenerateResult> {
    const model = opts.model ?? modelOf();
    const kind = opts.kind ?? 'generate';
    const started = Date.now();
    try {
      const res = await coreGenerate(runCodex, { ...opts, model, explicitPath: opts.explicitPath ?? pathOf() });
      logCall({ model, kind, ms: res.ms, ok: true, promptChars: opts.prompt.length, responseChars: res.text.length });
      return res;
    } catch (e) {
      const code = e instanceof CodexError ? e.code : undefined;
      const message = e instanceof Error ? e.message : String(e);
      logCall({ model, kind, ms: Date.now() - started, ok: false, error: `${code ? `${code}: ` : ''}${message}`, promptChars: opts.prompt.length });
      throw e;
    }
  }

  /**
   * Answer one screening question AS the candidate. SECURITY: a sensitive key (EEO/SSN/DOB/salary-
   * history/criminal/etc.) is REFUSED here — the question text never reaches the model. Non-sensitive
   * questions are sent with the careful prompt + schema; the parsed {value, confidence} is returned.
   */
  async function answerScreeningQuestion(control: ScreeningControl, ctx: ScreeningContext): Promise<ScreeningAnswer> {
    const label = (control.label ?? '').trim();
    const keyNorm = control.keyNorm ?? normQuestion(label);

    // SECURITY-CRITICAL: never send protected/regulated attributes to the model.
    if (isSensitiveKey(keyNorm)) {
      return { value: null, confidence: 0, refused: true, reason: 'sensitive' };
    }

    let res: GenerateResult;
    try {
      res = await generate({ prompt: buildScreeningPrompt(control, ctx), system: SYSTEM_BASE, schema: SCREENING_SCHEMA, kind: 'answer-question' });
    } catch (e) {
      // Unavailable / unauthorized / transient → let the caller fall back to its park path.
      return { value: null, confidence: 0, refused: true, reason: e instanceof CodexError ? e.code : 'ai unavailable' };
    }

    const parsed = asRecord(res.json);
    if (!parsed) return { value: null, confidence: 0, refused: true, reason: 'unparseable AI response' };

    const refuse = parsed['refuse'] === true;
    const rawValue = typeof parsed['value'] === 'string' ? (parsed['value'] as string) : typeof parsed['answer'] === 'string' ? (parsed['answer'] as string) : '';
    const value = rawValue.trim();
    const confidence = typeof parsed['confidence'] === 'number' ? clamp01(parsed['confidence'] as number) : 0;
    const reason = typeof parsed['reason'] === 'string' ? (parsed['reason'] as string) : '';

    if (refuse || value === '') {
      return { value: null, confidence, refused: true, reason: reason || 'AI refused' };
    }
    return { value, confidence, refused: false, reason };
  }

  return { status, generate, answerScreeningQuestion };
}
