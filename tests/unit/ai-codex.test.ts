// ai-codex — the Codex-backed AI service, proven WITHOUT any real Codex CLI. The whole spawn/discovery
// path is behind ONE seam (`RunCodex`); every test injects a fake that returns canned JSONL, so we
// assert the real logic: status parsing (authorized / not-logged-in / missing), JSONL-stdout parsing,
// schema JSON coercion, typed CODEX_UNAUTHORIZED / CODEX_NOT_FOUND errors, the ai_calls ring row, and
// the SECURITY refusal (a sensitive question is refused and the model is NEVER invoked). The real
// discovery ladder is touched only via discoverCli's explicit-path rung (a temp file, no Codex).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../app/src/main/db/index.js';
import { defaultContext } from '../../app/src/main/db/dal/util.js';
import { makeAiService, discoverCli, type CodexCall, type CodexRaw, type RunCodex } from '../../app/src/main/ai/index.js';

/** Serialize events into the JSONL codex streams on stdout (one JSON object per line). */
function jsonl(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** A fake RunCodex: canned responses per mode, plus a record of the calls it received. */
function makeFakeRun(handlers: { exec?: () => CodexRaw; status?: () => CodexRaw }): { run: RunCodex; calls: CodexCall[] } {
  const calls: CodexCall[] = [];
  const run: RunCodex = (call) => {
    calls.push(call);
    const raw =
      call.mode === 'login-status'
        ? handlers.status?.() ?? ({ found: true, source: 'path', cli: 'codex', code: 0, stdout: 'Logged in', stderr: '' } satisfies CodexRaw)
        : handlers.exec?.() ?? ({ found: true, source: 'path', cli: 'codex', code: 0, stdout: '', stderr: '' } satisfies CodexRaw);
    return Promise.resolve(raw);
  };
  return { run, calls };
}

type Dal = { ctx: ReturnType<typeof defaultContext> };

describe('ai-codex service', () => {
  let db: Database;
  let dal: Dal;

  beforeEach(() => {
    ({ db } = openDatabase({ file: ':memory:' }));
    dal = { ctx: defaultContext(db) };
  });
  afterEach(() => db.close());

  // ---- status() -------------------------------------------------------------
  it('status() parses an authorized login-status and surfaces the discovery source', async () => {
    const { run } = makeFakeRun({
      status: () => ({ found: true, source: 'native-host', cli: 'C:/codex.exe', code: 0, stdout: 'Logged in using ChatGPT (Plus)\n', stderr: '' }),
    });
    const svc = makeAiService({ dal, settings: { model: 'gpt-5-codex' }, runCodex: run });
    const st = await svc.status();
    expect(st.available).toBe(true);
    expect(st.source).toBe('native-host');
    expect(st.model).toBe('gpt-5-codex');
  });

  it('status() reports unavailable when the CLI says "Not logged in" (not a false positive on "logged in")', async () => {
    const { run } = makeFakeRun({
      status: () => ({ found: true, source: 'path', cli: 'codex', code: 1, stdout: '', stderr: 'Not logged in. Run `codex login`.\n' }),
    });
    const svc = makeAiService({ dal, runCodex: run });
    const st = await svc.status();
    expect(st.available).toBe(false);
  });

  it('status() reports not-found when the CLI cannot be discovered', async () => {
    const { run } = makeFakeRun({ status: () => ({ found: false, code: null, stdout: '', stderr: '' }) });
    const svc = makeAiService({ dal, runCodex: run });
    const st = await svc.status();
    expect(st.available).toBe(false);
    expect(st.detail).toMatch(/not found/i);
  });

  // ---- generate() -----------------------------------------------------------
  it('generate() parses the FINAL assistant JSON out of the JSONL stdout stream', async () => {
    const payload = { value: 'Yes', confidence: 0.82, refuse: false, reason: 'resides in Canada' };
    const stdout = jsonl(
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(payload) } },
    );
    const { run } = makeFakeRun({ exec: () => ({ found: true, source: 'path', cli: 'codex', code: 0, stdout, stderr: '' }) });
    const svc = makeAiService({ dal, runCodex: run });
    const res = await svc.generate({ prompt: 'Q', schema: { type: 'object' } });
    expect(res.json).toEqual(payload);
    expect(res.text).toContain('"value"');
    expect(typeof res.ms).toBe('number');
  });

  it('generate() throws a typed CODEX_UNAUTHORIZED when the CLI reports unauthorized', async () => {
    const { run } = makeFakeRun({
      exec: () => ({ found: true, source: 'path', cli: 'codex', code: 1, stdout: '', stderr: 'stream error: unauthorized\n' }),
    });
    const svc = makeAiService({ dal, runCodex: run });
    await expect(svc.generate({ prompt: 'Q' })).rejects.toMatchObject({ code: 'CODEX_UNAUTHORIZED' });
  });

  it('generate() throws a typed CODEX_NOT_FOUND when the CLI is missing', async () => {
    const { run } = makeFakeRun({ exec: () => ({ found: false, code: null, stdout: '', stderr: '' }) });
    const svc = makeAiService({ dal, runCodex: run });
    await expect(svc.generate({ prompt: 'Q' })).rejects.toMatchObject({ code: 'CODEX_NOT_FOUND' });
  });

  // ---- ai_calls ring log ----------------------------------------------------
  it('writes an ai_calls row (provider codex, ok=1) for a successful generate', async () => {
    const stdout = jsonl({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } });
    const { run } = makeFakeRun({ exec: () => ({ found: true, source: 'path', cli: 'codex', code: 0, stdout, stderr: '' }) });
    const svc = makeAiService({ dal, settings: { model: 'gpt-5-codex' }, runCodex: run });
    await svc.generate({ prompt: 'Q', kind: 'unit' });

    const row = db.prepare('SELECT provider, model, kind, ok, response_chars FROM ai_calls ORDER BY id DESC LIMIT 1').get() as
      | { provider: string; model: string; kind: string; ok: number; response_chars: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.provider).toBe('codex');
    expect(row!.model).toBe('gpt-5-codex');
    expect(row!.kind).toBe('unit');
    expect(row!.ok).toBe(1);
    expect(row!.response_chars).toBe('hello'.length);
  });

  it('writes an ai_calls row (ok=0, error carries the code) for a failed generate', async () => {
    const { run } = makeFakeRun({ exec: () => ({ found: false, code: null, stdout: '', stderr: '' }) });
    const svc = makeAiService({ dal, runCodex: run });
    await expect(svc.generate({ prompt: 'Q' })).rejects.toBeTruthy();
    const row = db.prepare('SELECT ok, error FROM ai_calls ORDER BY id DESC LIMIT 1').get() as { ok: number; error: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.ok).toBe(0);
    expect(row!.error).toMatch(/CODEX_NOT_FOUND/);
  });

  // ---- answerScreeningQuestion ---------------------------------------------
  it('answerScreeningQuestion answers a non-sensitive question from the model response', async () => {
    const payload = { value: 'English', confidence: 0.9, refuse: false, reason: 'default language' };
    const stdout = jsonl({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(payload) } });
    const { run, calls } = makeFakeRun({ exec: () => ({ found: true, source: 'path', cli: 'codex', code: 0, stdout, stderr: '' }) });
    const svc = makeAiService({ dal, runCodex: run });

    const ans = await svc.answerScreeningQuestion(
      { label: 'What is your preferred language?', fieldType: 'select', options: ['English', 'French'] },
      { profile: { firstName: 'Pierre', country: 'Canada' } },
    );
    expect(ans).toEqual({ value: 'English', confidence: 0.9, refused: false, reason: 'default language' });
    // exactly one exec call (the model was invoked once).
    expect(calls.filter((c) => c.mode === 'exec').length).toBe(1);
    // and it was metered.
    expect((db.prepare('SELECT COUNT(*) c FROM ai_calls').get() as { c: number }).c).toBe(1);
  });

  it('answerScreeningQuestion REFUSES a sensitive question WITHOUT ever invoking the model', async () => {
    const { run, calls } = makeFakeRun({
      exec: () => {
        throw new Error('the model must never be called for a sensitive question');
      },
    });
    const svc = makeAiService({ dal, runCodex: run });

    const ans = await svc.answerScreeningQuestion({ label: 'What is your gender?' }, { profile: { firstName: 'Pierre' } });
    expect(ans.refused).toBe(true);
    expect(ans.value).toBeNull();
    expect(ans.reason).toBe('sensitive');
    expect(calls.length).toBe(0); // seam never touched
    expect((db.prepare('SELECT COUNT(*) c FROM ai_calls').get() as { c: number }).c).toBe(0); // no meter row
  });

  it('answerScreeningQuestion falls back to a refusal (not a throw) when Codex is unauthorized', async () => {
    const { run } = makeFakeRun({
      exec: () => ({ found: true, source: 'path', cli: 'codex', code: 1, stdout: '', stderr: 'unauthorized\n' }),
    });
    const svc = makeAiService({ dal, runCodex: run });
    const ans = await svc.answerScreeningQuestion({ label: 'Describe your ideal team' }, { profile: {} });
    expect(ans.refused).toBe(true);
    expect(ans.reason).toBe('CODEX_UNAUTHORIZED');
  });

  // ---- discovery ladder (explicit-path rung only — no real Codex needed) ----
  it('discoverCli resolves an explicit path as source "manual"', () => {
    const tmp = join(tmpdir(), `codex-fake-${Date.now()}.exe`);
    writeFileSync(tmp, 'x');
    try {
      expect(discoverCli(tmp)).toEqual({ cli: tmp, source: 'manual' });
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
