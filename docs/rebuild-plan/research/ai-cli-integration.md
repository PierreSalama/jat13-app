# AI CLI Integration — Local-Subscription Backends (Codex CLI + Claude Code)

Research date: 2026-07-10. All paths/versions/latencies verified LIVE on Pierre's machine (Windows 11, `pierr`).
Goal: v13 rebuild drives BOTH subscriptions with **zero API keys** — the CLIs own their credentials; the app never reads, stores, or forwards a token. Users click **Sign in** (spawns the CLI's browser login) or the app **auto-detects** an existing CLI login.

---

## 1. Machine inventory (verified today)

| Item | Value |
|---|---|
| Codex CLI version | `codex-cli 0.144.0-alpha.4` |
| Codex managed binary | `C:\Users\pierr\AppData\Local\OpenAI\Codex\bin\a7c12ebff69fb123\codex.exe` (only hash dir with codex.exe; 341 MB; mtime 2026-07-09) |
| Codex v2 pointer binary | `C:\Users\pierr\.codex\plugins\.plugin-appserver\codex.exe` (same 0.144.0-alpha.4) |
| Codex on PATH | **NO** (`codex` not recognized) — ladder rungs 1–3 are mandatory |
| Codex auth | `~\.codex\auth.json` (present, 2026-07-09); `codex login status` → `Logged in using ChatGPT`, exit 0 |
| Claude Code version | `2.1.160 (Claude Code)` |
| Claude binary | `C:\Users\pierr\.local\bin\claude.exe` (native installer location; IS on PATH) |
| Claude creds | `C:\Users\pierr\.claude\.credentials.json` — **file only; NO Windows Credential Manager entry** (`cmdkey /list` has no claude/anthropic items) |
| Claude auth state | `claude auth status` → `loggedIn:true, authMethod:"claude.ai", subscriptionType:"max"` — **BUT real calls 401** (see §4.3) |

---

## 2. CODEX — proven integration (port of v11 `app/src/ai/codex.js` → v13 `app/src/main/ai/codex.ts`)

Sources: `F:\GITHUB\Perosnal\extensions\job-application-tracker\v11\app\src\ai\codex.js`, `F:\GITHUB\Perosnal\extensions\job-application-tracker\v13\app\src\main\ai\codex.ts`.

### 2.1 Discovery ladder (first hit wins)

| Rung | Source | This machine today |
|---|---|---|
| 1 | explicit `settings.ai.codexPath` (v13 adds this rung) | unset |
| 2 | `~\.codex\chrome-native-hosts.json` → `chromeNativeHosts[0].codexCliPath` | **STALE** — points to `bin\716dda49c14d31a0\codex.exe` which no longer exists (file updatedAt 2026-06-02; hash dir rotated away). `existsSync` guard correctly falls through |
| 3 | newest `codex.exe` under `%LOCALAPPDATA%\OpenAI\Codex\bin\*\` (sort by mtime desc) | **HIT**: `bin\a7c12ebff69fb123\codex.exe` |
| 4 | `where.exe codex` / `which codex` on PATH (present if `npm i -g @openai/codex`) | miss |
| — | NEVER `~\.codex\.sandbox-bin` (stale build) | still true |

**NEW rung for the rebuild (between 2 and 3):** `~\.codex\chrome-native-hosts-v2.json` — schemaVersion 2, `entries[]`, each with `paths.codexCliPath`. On this machine ALL entries point to `C:\Users\pierr\.codex\plugins\.plugin-appserver\codex.exe` (exists, current version). Pick the entry with newest `presence.lastSeenAt`/`updatedAt`. The v1 file has stopped being updated (last write 2026-06-02) — v2 is the live pointer now. Ladder becomes: explicit → v2 json → v1 json → LOCALAPPDATA newest → PATH.

### 2.2 Login-status probe (proven)

```
spawn(cli, ['login','status'], { env: {...process.env, CODEX_HOME: ~\.codex}, windowsHide: true })
```
- Logged in ⇔ exit 0 AND `/logged in/i` in stdout+stderr — but test `/not logged in/i` FIRST ("Not logged in" contains "logged in").
- Timeout 10 s, kill on expiry. **Measured: 248 ms.**
- Sign-in button: spawn `codex login` detached (`detached:true, stdio:'ignore', windowsHide:false`), `child.unref()` → opens browser ChatGPT OAuth; user completes, clicks Re-check.

### 2.3 Invocation contract (verified against 0.144.0-alpha.4 — all v11 flags still present)

```
codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config
           -s read-only -C <fresh tmp dir> [-m <model>]
           [--output-schema <schema.json>] [-o <last-message.txt>]
prompt on stdin (or as arg; stdin appended as <stdin> block if both) ; env CODEX_HOME=~\.codex
```

| Flag | Why |
|---|---|
| `--json` | JSONL events on stdout |
| `--ephemeral` | no session files persisted |
| `--skip-git-repo-check` | tmp dir isn't a repo |
| `--ignore-user-config` | Pierre's `config.toml` declares MCP servers + `model = "gpt-5.4"`; must not spawn/pay for MCPs per call. Auth still resolves via `CODEX_HOME` |
| `-s read-only` | sandbox: no writes/exec |
| `-C <tmp>` | isolate cwd; `mkdtemp` per call, `rmSync` in finally |
| `--output-schema <file>` | JSON Schema constrains final message (schema written to the tmp dir) |
| `-o <file>` | v11 read the answer from this file; v13 parses stdout JSONL instead (both work) |
| NEW in 0.144: `--ignore-rules` | skip user/project execpolicy `.rules` — add for full isolation |

System prompt: prepended to user prompt as `${system}\n\n---\n\n${prompt}` (codex exec has no separate system flag).

### 2.4 Output parsing (v13 `extractAssistantText`, tolerant of alpha shape drift)

Current 0.144 shape (verified live): `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}`; terminal `{"type":"turn.completed","usage":{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}}`. Parser keeps the LAST agent_message across 4 historical shapes (A `item.completed/agent_message`, B `msg.agent_message`, C bare `agent_message`, D `role:assistant` content array). Non-JSON lines ("Reading prompt from stdin...") are skipped. JSON coercion when schema requested: bare parse → ```json fence → first `{`..last `}` → first `[`..last `]` → `CODEX_BADJSON`.

### 2.5 Failure modes (typed — callers branch on `.code`, never message strings)

| Code | Trigger | Retry? |
|---|---|---|
| `CODEX_NOT_FOUND` | ladder exhausted | no — show Detect/Install UI |
| `CODEX_UNAUTHORIZED` | `unauthorized` / `not logged in` / `login required` / `please run…login` in stdout+stderr | no — flip card to Sign in |
| `CODEX_TIMEOUT` | hard kill at timeoutMs (default 120 s) | once |
| `CODEX_EXIT` | exit ≠ 0 AND no text | once |
| `CODEX_EMPTY` | exit 0, no agent_message | once |
| `CODEX_BADJSON` | schema set, coercion failed | once |

v11 evidence: alpha CLI intermittently exits 1 with no output on LARGE structured prompts (~18/21 apply-rescue failures) while small prompts succeed ~99.8% — ONE retry after 900 ms recovers most. Never retry auth/missing.

### 2.6 Metering
Every generate → `ai_calls` row: `(at, provider='codex', model, kind, ms, ok, error≤512ch, prompt_chars, response_chars)`; inserts wrapped in try/catch — metering must never break a run.

---

## 3. CLAUDE CODE — new integration (verified on claude 2.1.160)

### 3.1 Binary discovery ladder

| Rung | Source | This machine |
|---|---|---|
| 1 | explicit `settings.ai.claudePath` | unset |
| 2 | `where.exe claude` (PATH) | **HIT**: `C:\Users\pierr\.local\bin\claude.exe` |
| 3 | direct probe `%USERPROFILE%\.local\bin\claude.exe` (native-installer default, covers PATH-less shells e.g. Electron launched from Explorer) | exists |
| 4 | npm global `%APPDATA%\npm\claude.cmd` (`npm i -g @anthropic-ai/claude-code`) | absent |

Version probe: `claude --version` → `2.1.160 (Claude Code)`. **Measured: 209 ms.**

### 3.2 Auth storage (Windows)

- Single file: `%USERPROFILE%\.claude\.credentials.json`. NOT in Credential Manager (verified `cmdkey /list`).
- Structure (keys only): `{ claudeAiOauth: { accessToken, refreshToken, expiresAt(ms), scopes[], subscriptionType, rateLimitTier }, organizationUuid, mcpOAuth{...} }`. Pierre's: `subscriptionType:"max"`, scopes `user:inference user:profile user:sessions:claude_code …`.
- **App must never read this file's token values.** Presence/`expiresAt` may inform a status hint, but validity is only proven by a real call (§3.3/§4.3).

### 3.3 Login-status probe

```
claude auth status        → JSON on stdout (no flag needed), exit 0
{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"…","orgId":"…","orgName":"…","subscriptionType":"max"}
```
**Measured: 514 ms.** Subcommands: `claude auth login [--claudeai|--console|--sso] [--email <e>]`, `claude auth logout`, `claude auth status`.

⚠️ **PROVEN ON THIS MACHINE: `loggedIn:true` does NOT mean calls will succeed.** See §4.3. Treat `auth status` as "credentials present" (state: signed-in?), and require one cheap real generation for state: verified.

### 3.4 Headless single-shot invocation (recommended arg set)

```
claude -p --output-format json
       --model <sonnet|opus|haiku|full-id>          # aliases per --help: 'sonnet','opus', or e.g. 'claude-opus-4-8'
       --max-turns 1                                # ACCEPTED by 2.1.160 though absent from --help (SDK flag); belt-and-braces vs tool loops
       --tools ""                                   # disable ALL built-in tools — pure text generation, no FS/Bash access
       --strict-mcp-config                          # with no --mcp-config ⇒ ZERO MCP servers spawn (Pierre has many configured — spawning them per call is slow + prompty)
       --setting-sources ""                         # skip user/project settings (hooks, statusline, 16 KB settings.json); auth unaffected (creds file ≠ settings)
       --disable-slash-commands                     # no skills
       --no-session-persistence                     # print-mode only; nothing written to ~/.claude/sessions
       --system-prompt "<JAT system prompt>"        # REPLACES the default Claude Code system prompt — ideal for generation workloads
       [--json-schema '<schema JSON>']              # structured output WITH validation (better than codex-side coerceJson)
       [--fallback-model haiku]                     # print-mode only; auto-fallback when primary overloaded
cwd = fresh empty tmp dir (no CLAUDE.md auto-discovery; trust dialog skipped in -p mode)
prompt: argv for short (<8 KB), stdin for long (Windows argv limit; write+end immediately)
```

**Gotchas (all verified or from 2.1.160 `--help`):**
- **DO NOT use `--bare`**: help states OAuth and keychain are NEVER read in bare mode (API-key only) — it silently kills subscription auth.
- **stdin must be closed**: with prompt-as-argv and an open stdin pipe, claude waits 3 s ("no stdin data received in 3s") → +3 s per call. Spawn with `stdio:['ignore','pipe','pipe']` when prompt is argv, or write+end stdin when piping.
- **Strip env before spawn**: this session proved `ANTHROPIC_BASE_URL` (and potentially `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, `CLAUDECODE`, `CLAUDE_CODE_*`) redirect/override auth → 401. Child env = clean `process.env` minus `ANTHROPIC_*` and `CLAUDE*`.
- `--permission-mode` not needed when `--tools ""` (nothing to permit). Do NOT ship `--dangerously-skip-permissions`.
- `--max-budget-usd` exists (print-mode) — harmless guard, but subscription usage isn't dollar-billed.

### 3.5 Output contract (`--output-format json`, single JSON object on stdout)

Verified shape (from live call; success differs only in `is_error:false`, `result` = final text):
```
{"type":"result","subtype":"success","is_error":bool,["api_error_status":401,]"duration_ms":N,"duration_api_ms":N,
 "num_turns":N,"result":"<final text or error>","stop_reason":…,"session_id":uuid,"total_cost_usd":N,
 "usage":{input_tokens,output_tokens,cache_…},"modelUsage":{…},"permission_denials":[],"terminal_reason":"completed","uuid":…}
```
- Parse: `JSON.parse(stdout)`; success ⇔ exit 0 AND `is_error===false`; answer = `.result`.
- Auth failure signature: exit 1 + `is_error:true` + `api_error_status:401` + `result:"Failed to authenticate…"` → map to `CLAUDE_UNAUTHORIZED`.
- `--output-format stream-json`: JSONL events (init/assistant/result) for progressive UI; `--include-partial-messages` adds deltas. Not needed for JAT's short calls; use for cover-letter live preview if desired.
- With `--json-schema`: `.result` conforms to schema (CLI-side validation) — still run a defensive `JSON.parse`.
- **Cost on subscription**: OAuth `claude.ai` auth bills NOTHING regardless of reported `total_cost_usd` (subscription rate limits apply instead; `rateLimitTier` in creds). Treat `total_cost_usd` as informational only.

### 3.6 Sign-in button

| Option | Command | Notes |
|---|---|---|
| Primary | spawn visible terminal: `cmd /c start "" cmd /k claude auth login --claudeai` (detached, unref) | Opens browser OAuth; needs a console for the code-paste fallback → visible terminal, not hidden spawn. Then user clicks Re-check |
| Secondary (headless envs/CI) | `claude setup-token` (interactive; requires subscription) → long-lived token used via env `CLAUDE_CODE_OAUTH_TOKEN` | NOT recommended for JAT default — app would hold a credential, violating "CLI owns auth". Document only. (Env-var honor not verifiable on this machine today — auth stale.) |
| Sign out | `claude auth logout` | |

### 3.7 Claude error taxonomy (mirror CodexError)

`CLAUDE_NOT_FOUND` (ladder miss) · `CLAUDE_UNAUTHORIZED` (exit 1 + api_error_status 401/403, or `auth status` loggedIn:false) · `CLAUDE_TIMEOUT` (hard kill; default 120 s, cover letters 180 s) · `CLAUDE_EXIT` (exit ≠ 0, no parseable result) · `CLAUDE_EMPTY` (exit 0, empty result) · `CLAUDE_BADJSON` (schema set, parse failed). Same single-retry policy for TIMEOUT/EXIT/EMPTY/BADJSON; never retry NOT_FOUND/UNAUTHORIZED.

---

## 4. Measured latencies (this machine, 2026-07-10)

| Probe | Command | Result | ms |
|---|---|---|---|
| Codex auth | `codex login status` | "Logged in using ChatGPT", exit 0 | **248** |
| Codex trivial gen | `codex exec --json --ephemeral … "say ok"` (default model) | "ok"; usage in=13,376 (cached 1,920) out=5 | **2,688** |
| Codex screening + schema | realistic JAT screening prompt + `--output-schema` (SCREENING_SCHEMA) | valid strict JSON `{"value":"8","confidence":0.9,…}`; in=13,582 out=61 | **7,864** |
| Codex cover letter | ~150-word prompt, `-m gpt-5.4`, ~220-word output | clean letter; in=11,455 out=258 | **9,877** |
| Claude version | `claude --version` | 2.1.160 | **209** |
| Claude auth probe | `claude auth status` | JSON, loggedIn:true, max | **514** |
| Claude gen (401 path) | `claude -p "say ok" --output-format json --max-turns 1`, clean env, stdin closed | exit 1, `api_error_status:401`; process+startup overhead to API ≈ 1.0–2.4 s (`duration_ms`) | **2,485–3,855 total** |
| Claude stdin penalty | same, stdin left open | "no stdin data received in 3s" warning | **+3,000** |

Notes: codex carries a ~11–14 K input-token agent-harness baseline even for tiny prompts (partially cached) — irrelevant for cost (subscription) but adds fixed latency. **Claude end-to-end generation latency could NOT be measured — auth on this machine is stale (§4.3); startup-to-API ≈ 1–2.4 s measured, so expect ~4–10 s for haiku/sonnet short answers once re-logged-in. Re-measure after `claude auth login`.**

### 4.3 ⚠️ Live finding: `auth status` lies when tokens rot

On this machine TODAY: `.credentials.json` `claudeAiOauth.expiresAt = 2026-06-15` (expired ~1 month; file last written 2026-06-22), `claude auth status` still reports `loggedIn:true / max`, and every `claude -p` (full env, cleaned env, all `ANTHROPIC_*`+`CLAUDE*` stripped, `--setting-sources` isolated) returns **401 "Invalid authentication credentials"** — the CLI's self-refresh is failing (refresh token likely rotated by the Claude Code Desktop host, which manages auth in-memory: env showed `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1`). Consequences for the rebuild:
1. `auth status` = "credentials present", never "valid".
2. state `verified` requires one real ping: `claude -p "ok" --output-format json --model haiku --tools "" --max-turns 1 --no-session-persistence` → `is_error:false`. Cache verified for ~15 min.
3. 401 on any call → immediately downgrade card to "Sign in required" (do not retry).
4. Pierre's machine needs a one-time `claude auth login` before the Claude backend goes green.

---

## 5. Routing — best backend per task

| Task | Backend | Model | Why |
|---|---|---|---|
| Screening answers (auto-apply hot path) | **Codex** primary | default (or `-m gpt-5.4`) | Proven 99.8% at small prompts in v11; `--output-schema` enforced JSON; measured 7.9 s incl. schema; battle-tested error/retry map |
| Screening fallback | Claude | `haiku` | `--json-schema` validation; likely faster once auth fixed; flip primary if measured faster |
| Fit scoring (bulk, dozens/sweep) | **Codex** | default | Cheap on subscription, schema output, parallelizable child procs; keep concurrency ≤2 (each spawn ≈ full agent boot) |
| Resume tailoring (long context: full resume + JD) | **Claude** | `sonnet` | 200 K context, strongest long-doc rewriting; `--system-prompt` replaces harness prompt cleanly (codex always carries its agent harness prompt) |
| Cover letters (prose quality) | **Claude** primary | `sonnet` (opus for "high-stakes" toggle) | Prose quality; stream-json enables live preview. Codex `-m gpt-5.4` measured 9.9 s = solid fallback |
| Self-healing selector repair / codegen (Codex-AI feature) | **Codex** | default | It's a coding agent; matches v13's existing Codex plumbing |

Cross-cutting: every task declares `{primary, fallback}`; on `*_UNAUTHORIZED`/`*_NOT_FOUND`/2×transient → route to the other backend if its cached state is `verified`, else park (v11 behavior). Log `provider` in `ai_calls` (extend the column beyond 'codex').

## 6. Health/status model (per backend)

```
not-installed ─(discover ok)→ installed ─(auth probe ok)→ signed-in ─(1 real gen ping ok)→ verified
     ▲                             │ auth probe fail → needs-login          │ 401 at any time → needs-login
     └───────── discover fail ─────┘                                        │ transient fail ×2 → degraded (retry w/ backoff)
```
- Probes: discovery (fs, ~0 ms) at app start + Detect click; auth probe (`codex login status` 248 ms / `claude auth status` 514 ms) at start + every 10 min + after Sign in; gen ping only on entry to signed-in or on Verify click (costs a subscription call — don't poll).
- `probing` is a transient UI state overlaying any node.

## 7. Settings UX — two provider cards (Codex / Claude Code)

Each card: **status dot** (grey not-installed · yellow installed/needs-login · blue probing · green verified · red degraded) + status line (version, source rung, e.g. "0.144.0-alpha.4 via LOCALAPPDATA" / "2.1.160 via PATH") + buttons: **Sign in** (spawns `codex login` / terminal `claude auth login --claudeai`; button flips to Re-check) · **Detect** (rerun ladder + auth probe) · **Verify** (gen ping) · **manual path** field (`settings.ai.codexPath` / `settings.ai.claudePath` = ladder rung 1) · model picker (codex: free text default empty; claude: haiku/sonnet/opus). Global: per-task routing table (primary/fallback dropdowns), default from §5.

## 8. Shared sensitive-question refusal rule (provider-agnostic — lives ABOVE both backends)

- Gate BEFORE any model call: `isSensitiveKey(normQuestion(label))` (v13 `app/src/main/db/dal/answers.ts:137`) → refuse locally; **the question text never reaches either model**. Tokens: gender, race, ethnic(ity), disability/disabled, veteran, ssn, dob, criminal, felony/felon; fragments: ethnic, disab, veteran, felon; pairs: salary+history, social+security, birth+date, sexual+orientation; lone "orientation".
- Same rule blocks learned-answer WRITES (`answers.ts:278`) — sensitive data is never stored either.
- Prompt-level second line of defense (both backends, same SYSTEM_BASE + HARD RULES text from codex.ts): demographic/EEO, salary history, SSN, citizenship/visa specifics not in facts, criminal history ⇒ `refuse:true`; only provided facts; refusal shape `{value:"", confidence, refuse:true, reason}`.
- Both providers return the same `ScreeningAnswer {value|null, confidence, refused, reason}`; provider errors surface as `refused:true, reason:<code>` so the runner's park path is provider-blind.

## 9. Provider interface (rebuild sketch)

One `AiProvider` shape: `{ name:'codex'|'claude', discover(explicit?):{cli,source}|null, status():{available,detail,source,version}, generate({prompt,system,schema,model,timeoutMs,kind}):{text,json?,ms} }` — both built on the v13 injectable `Run*` seam (tests inject canned stdout; no real CLI needed). Router owns retry-once, failover, `ai_calls` metering (with provider column), and the §8 gate. Timeouts: status 10 s; generate 120 s default, 180 s cover letters. Concurrency: ≤2 child procs per provider.

## 10. Open items

1. **Re-login Claude on this machine** (`claude auth login`) → then measure real `-p` latencies (haiku vs sonnet, ±`--json-schema`) and confirm `total_cost_usd` reporting under OAuth; revisit §5 primaries if claude-haiku beats codex on screening.
2. `--max-turns` accepted-but-undocumented in 2.1.160 — pin behavior per release; harmless if dropped (`--tools ""` already prevents loops).
3. Verify `CLAUDE_CODE_OAUTH_TOKEN` env honor before ever offering the setup-token path.
4. Add `chrome-native-hosts-v2.json` rung to codex.ts (v1 pointer proven stale on 2026-07-10); prefer newest `presence.lastSeenAt` entry.
5. Codex alpha churn: re-verify flag surface + JSONL shapes on version bumps (`extractAssistantText` already shape-tolerant); add `--ignore-rules`.
