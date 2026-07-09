# JAT v12 — Locked Decisions (Pierre, 2026-07-07)

These override any conflicting text in the master plan / pillar docs.

## Q1 — Release repo: **`PierreSalama/jat12-app`, public** ✓ confirmed
- Bakes into the electron-updater feed URL + the `adapters-stable` hot-fetch URL.
- **Pierre action (before M0 CI/installer):** create the empty public repo (steps in the chat).
- No PII in the repo (synthetic importer fixtures only; secrets never exported — enforced by build gate).

## Q2 — Cutover: **Hard cutover (A)** ✓
- When v12 is proven: freeze v11 → final import → v12 drives ALL sources → v11 stays installed-but-parked 2 weeks as safety net.
- Runbook = P7 §12 as written. `--refresh-statuses` importer flag is NOT needed (that was for phased mode B).

## Q3 — AI fallback: **Codex CLI (ChatGPT/OpenAI subscription login) ONLY. No Anthropic. No API keys.**
This SUPERSEDES the plan's "Anthropic vs Ollama" AI-rung design. Concrete contract (port v11 `.v11-publish/app/src/ai/codex.js` — proven, `codex/gpt-5.4`, ~7s/call, 0 failures in live logs):

- **Discovery order** for the Codex CLI binary (Windows):
  1. `~/.codex/chrome-native-hosts.json` → `chromeNativeHosts[0].codexCliPath`
  2. newest `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`
  3. `codex` on PATH
  (never `~/.codex/.sandbox-bin` — stale)
- **Invocation:** `codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config -s read-only -C <tmp> -m <model> [--output-schema <schema.json>] --output-last-message <out.txt>`; prompt on stdin; `CODEX_HOME=~/.codex` env; JSONL progress on stdout. `--ignore-user-config` matters (don't spin up the user's MCP servers).
- **Auth = the subscription login** resolved via `CODEX_HOME` — NOT an API key. Status probe: `codex login status`.
- **Local-first / "keep refreshing locally":** the Codex CLI runs entirely locally against the user's own signed-in subscription; the answer service prefers it and re-checks availability each session.
- **If Codex is NOT found or NOT logged in:** show the user a one-time WARNING (Settings token-health card: "Codex CLI not detected — sign in to the Codex app to enable AI answers"), then the answer ladder simply **parks** any brand-new screening question for the human to answer once (then it's saved to memory forever). No other AI fallback ships as the default.

**Amendments to the plan:** P3 answer-ladder AI rung + P2 stack "ai adapters (Anthropic + Ollama)" → replaced by a single `ai/codex.js` provider (ported from v11) behind the ladder's AI rung. Ollama MAY remain an optional escape hatch in Settings but is NOT the default and NOT recommended in first-run. The `secrets` table no longer needs an Anthropic key row.

## Reaffirmed from the master plan (no change)
- Thin extension + app brain; adapters-as-data; per-source lanes; better-sqlite3 WAL single-writer; PatchBus (no refetch); CHECK-constraint truth; full Aurora UI; v11 import (hard cutover); LinkedIn ledger cap 45/24h; profile-first answers; no captcha solving; no account creation.
