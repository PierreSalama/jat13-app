# JAT 13 (Aurora)

Ground-up rebuild of the job auto-apply system. **The desktop app is the brain; the Chrome extension is only hands and eyes.** Site knowledge is hot-updatable JSON data, not code. Replaces v11 after cutover.

> Full design: [`docs/plan/00-MASTER-PLAN.md`](docs/plan/00-MASTER-PLAN.md) + pillars `01`–`07` + [`DECISIONS-LOCKED.md`](docs/plan/DECISIONS-LOCKED.md).

## The eight structural laws (each kills a v11 production failure class)

1. **The page never thinks** — extension is a stateless sensor/actuator; the app owns a 13-state apply-run machine persisted per step; any extension death = *resume by re-reading the live page*, never restart.
2. **Site knowledge is data** — versioned JSON adapters, hot-reloadable; a LinkedIn DOM change is a data edit, unknown pages capture-and-park to learn.
3. **Busy = one SQL query** — worker slots are `apply_runs` rows, never open tabs; all pacing in one scheduler.
4. **Supply lanes are independent** — per-source refill gates; a wedged lane never starves another; telemetry rows only on yield.
5. **One writer, honest truth** — better-sqlite3 WAL, main-process only; `submitted` requires real evidence *by CHECK constraint*.
6. **Push is a patch** — PatchBus sends the changed row over IPC; "refetch everything" doesn't exist.
7. **Humans solve walls** — never solve captchas; ~60s unattended park + breaker.
8. **Tokens rot, releases don't** — token-health UI + one-click re-auth; tokenless public-repo auto-update; unpacked-extension path.

## Stack

Electron 42 · TypeScript (type-check only; esbuild emits) · better-sqlite3 (WAL) · vanilla renderer + raw WebGL2 (no framework) · Hono REST + `ws` on 127.0.0.1:**7860** · zod contracts · vitest + Playwright. **AI = Codex CLI (your ChatGPT/OpenAI subscription login), no API keys** — if Codex isn't signed in, brand-new screening questions park for you.

## Layout

```
shared/   @jat13/shared — contracts, constants, normalizers (the anti-drift package)
app/      Electron brain: src/main (scheduler, engine, db, server), src/preload, src/renderer (Aurora)
extension/ thin MV3: sensor.ts, actuator.ts, sw.ts (dist/ is the load-unpacked target)
adapters/ site recipes as JSON data
tools/    build, gates, importer, canary, release
tests/    unit · integration · replay · e2e (fixture-replay) · fixtures
```

## Dev

```bash
npm install          # workspaces; native better-sqlite3 builds/prebuild
npm run typecheck
npm test             # vitest unit/integration
npm run dev          # dev identity (port 7861, userData jat13-app-dev)
npm run build:ext    # extension -> extension/dist ; load unpacked in chrome://extensions
```

Release: tag `v13.*` on **`PierreSalama/jat13-app`** → CI → GitHub release + electron-updater. v11 (`Job-ext-app`) is never touched.

## Status

**M0 done; data layer (task #3) done.** Shipped: workspaces + shared contracts; migration `001-core` (CHECK-constrained schema — submit-truth as a constraint, 13-state apply_runs, ring caps) + forward-only migration runner; `/health` server on 7860; esbuild build + per-project typecheck + GitHub Actions CI. The **DAL** — 8 aggregate modules (`jobs, applications, runs, answers, documents, settings, secrets, events`) over one shared context, snake_case DTOs, run-FSM transition guard, forward-only status, sensitive-answer drop, typed settings registry, Sealer-injected secrets — plus time-based retention. **189 tests green.** Next: **M1 — a real LinkedIn apply that survives an extension-kill** (the milestone that retires the architecture risk); migrations 002-discovery/003-inbox/004-fts arrive with their features.
