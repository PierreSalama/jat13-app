# JAT v12 — Pillar 2: Exact Stack, Tools & Repos

Status: DESIGN (implementation-ready)
Date: 2026-07-07
Author: stack pillar subagent
Evidence base: `.v11-publish` source (jat11-app v11.86.0), memory files (`reference_jat_v1181_v1182`, `reference_jat_pipeline_ceilings`, `reference_jat_autoapply_engine`, et al.), vault decision `2026-07-03 — jat-v12-sibling-coexistence-architecture`, live web research on 2026 versions (cited inline).

---

## 0. Decision summary (one screen)

| Concern | Decision | One-line why |
|---|---|---|
| Runtime | **Electron 42.x** (latest stable 42.5.2, 2026-06-30) | current stable, 3-major support window; v11 sat on 32 and rotted |
| Packaging | **electron-builder 26.15.x + electron-updater 6.8.x** | proven in v11; NSIS + GitHub-release auto-update pipeline already works |
| Release repo | **NEW GitHub repo `PierreSalama/JAT12-app`** — NOT Job-ext-app | electron-updater resolves "latest release by semver" per repo; a `v12.0.0` tag in Job-ext-app would auto-update Dad's live v11 into v12. Structural isolation, not convention |
| Language | **TypeScript everywhere** (typescript@~6.0.3, type-check only; esbuild emits) | the shared wire protocol + recipe schema + DB rows are exactly what types are for; tsc never in the runtime path |
| Database | **better-sqlite3 12.11.x**, WAL, main process = only writer | kills every node-sqlite3-wasm failure mode (mkdir-lock VFS, silent dropped writes, brick-on-crash, source-dump-on-throw) |
| Apply engine FSM | **XState v5 (xstate@^5.32.4)** for the per-application `ApplySession` actor; **site adapters stay pure data** interpreted inside FSM states | persisted actor snapshots = "page death is a resume, not a restart" for free; Mission Control can render real statecharts of stuck sessions |
| Dashboard UI | **Svelte 5 (runes) + Vite 8** | 12 pages of live-patching glass panels need reactivity; the v11 "no build step" constraint existed only because of the extension/app mirror — v12's thin extension dissolves the mirror, so a build step costs nothing |
| Galaxy / analytics | **three.js 0.185.x** (galaxy + bloom) + **hand-rolled canvas 2D** (analytics) | matches the lost Aurora aesthetic and Pierre's portfolio-site precedent; chart libs fight the bespoke animated look |
| Extension build | **esbuild 0.28.x** script (no Vite/CRXJS in the extension) | milliseconds rebuild, watch mode, zero config rot; output is a plain unpacked-loadable `dist/extension` |
| App⇄extension transport | **WebSocket (`ws@^8`) drive channel + small Hono REST** | bidirectional command/snapshot streaming with reconnect+resume; WS heartbeats also keep the MV3 SW alive during active applies |
| App⇄renderer transport | **Electron contextBridge IPC only** (typed) | no localhost hop, no token, no SSE storms; push = targeted row patches over `webContents.send` |
| Scheduling | **croner@^9** | zero-dep, Intl-based TZ handling; ONE scheduler instance in main = the single pacing/caps authority |
| Email | **@googleapis/gmail@^17 + google-auth-library** (drop imapflow/mailparser) | scoped package (not 100MB `googleapis`); one email path, token health surfaced in UI |
| Doc parsing | **mammoth@^1.11** (docx) + **unpdf** (pdf) | pdf-parse is abandoned (2018); unpdf is maintained pdfjs wrapping |
| Validation | **zod@^4.4** at every trust boundary | recipes are hot-updatable DATA — they MUST be schema-validated before the driver interprets them |
| Tests | **Vitest 4.1.x** (unit, workspace projects) + **Playwright 1.61.x** (extension E2E on captured fixtures) | v11's 50-file node:test list is unmanageable; Playwright loads the unpacked extension in a persistent context against offline DOM fixtures |
| Discovery sidecar | **KEEP speedyapply/JobSpy** (v1.1.79, MIT, active) bundled as in v11 | already integrated; actively maintained (Mar 2026 release); the freshness-ramp lesson carries over |
| AIHawk | **learn-only. Never vendor** (AGPL-3.0 + archived 2026-05-17) | license contamination + dead repo; mine its LinkedIn flow handling as reading, express everything in our own recipe data |

---

## 1. Repo & workspace layout

Monorepo with **npm workspaces** (not pnpm: electron-builder + native-module rebuild flows are least surprising under npm's hoisting; Pierre's muscle memory is npm).

```
v12/
├── package.json                  # workspaces root, engines: node >=22
├── tsconfig.base.json            # strict flags, shared compilerOptions
├── packages/
│   └── shared/                   # @jat12/shared — THE contract package
│       ├── package.json
│       ├── tsconfig.json         # composite, emits d.ts only
│       └── src/
│           ├── schema/           # zod schemas (single source of truth)
│           │   ├── recipe.ts     #   site-adapter recipe schema (data!)
│           │   ├── wire.ts       #   ext⇄app WS protocol messages
│           │   ├── rows.ts       #   DB row types (jobs, tasks, qa, …)
│           │   └── api.ts        #   REST DTOs + IPC payloads
│           ├── protocol/         # message builders, version negotiation
│           └── const.ts          # ports, header names, caps, source ids
├── apps/
│   ├── desktop/                  # jat12-app (Electron)
│   │   ├── package.json          # electron, better-sqlite3, xstate, …
│   │   ├── electron-builder.yml
│   │   ├── src/
│   │   │   ├── main/             # node side — the "app brain"
│   │   │   │   ├── db/           # better-sqlite3, migrations, repos
│   │   │   │   ├── engine/       # XState machines + recipe interpreter
│   │   │   │   ├── scheduler/    # croner + per-source supply lanes
│   │   │   │   ├── server/       # Hono REST + ws upgrade (port 7845)
│   │   │   │   ├── gmail/
│   │   │   │   └── importer/     # v11 jat.db read-only importer
│   │   │   ├── preload/          # contextBridge typed API
│   │   │   └── renderer/         # Aurora — Svelte 5 + Vite 8
│   │   │       ├── src/pages/    # 12 pages
│   │   │       ├── src/galaxy/   # three.js scene
│   │   │       └── src/charts/   # canvas 2D analytics modules
│   │   └── vite.config.ts        # renderer only
│   └── extension/                # thin MV3 hands/eyes
│       ├── package.json
│       ├── build.mjs             # esbuild script (dev = watch)
│       ├── manifest.template.json
│       └── src/
│           ├── sw.ts             # service worker: WS client + tab ops
│           ├── content/
│           │   ├── sensor.ts     # DOM snapshot serializer
│           │   └── actuator.ts   # click/fill/scroll command executor
│           └── popup/
├── recipes/                      # site-adapter recipe JSON (DATA, versioned)
│   ├── linkedin-easyapply.json
│   ├── indeed-smartapply.json
│   ├── greenhouse.json
│   ├── lever.json
│   └── ashby.json
├── tools/
│   ├── import-v11.ts             # CLI wrapper of apps/desktop importer
│   ├── seed-ats-tokens.json      # the 113 live-verified board tokens
│   └── validate.mjs              # forbidden-pattern gates (see §10)
├── tests/
│   ├── unit/                     # vitest projects per workspace
│   └── e2e/
│       ├── fixtures/             # captured LinkedIn/Indeed/ATS DOM pages
│       └── *.spec.ts             # playwright, unpacked-extension harness
└── docs/plan/                    # these pillar docs
```

Key structural point: **the dashboard exists in exactly one place** (`apps/desktop/src/renderer`). v11's byte-identical `extension/app ↔ app/src/app` mirror (and the mirror.mjs delete-then-copy footgun) is gone because the v12 extension has no dashboard — its popup is a ~200-line status pane. This is what buys us the right to use a build step at all.

---

## 2. Runtime platform: Electron 42

- **electron@^42.5.2** (stable line as of 2026-06-30; Electron supports the latest 3 majors — v11 shipped on Electron 32 which is now long out of support).
- **Upgrade policy**: bump one major per quarter inside the supported window; never skip more than one major (native-module ABI churn — see §3). Pin exact in `package.json` (`42.5.2`, no caret) because Electron minors have broken native ABI expectations before.
- ESM main process (`"type": "module"` in apps/desktop — Electron ≥28 supports ESM entry; v12 has no CJS legacy to drag).
- Security baseline (non-negotiable, enforced by validate.mjs): `contextIsolation: true`, `sandbox: true` on the renderer, `nodeIntegration: false`, single `preload` exposing a typed `window.jat12` API via `contextBridge`. No secrets ever cross into page-world (survives from v11's security lines).
- **electron-builder@^26.15.3** + **electron-updater@^6.8.9**. NSIS target on Windows, `asarUnpack` for `**/*.node` (better-sqlite3) and the bundled JobSpy sidecar under `extraResources/discovery` (same pattern as v11's `build/discovery`).

### Release identity (critical, learned the hard way)

electron-updater's GitHub provider resolves **the latest semver release in the repo**. v11 (11.86.0, Dad's machine, auto-updating) lives on `PierreSalama/Job-ext-app`. If v12 tags `v12.0.0` there, **every live v11 install auto-updates into v12**. Therefore:

- New repo: **`PierreSalama/JAT12-app`**, tags `v12.*`, artifact `JAT-v12-setup.exe`, appId `com.pierre.jat12`, productName "JAT Aurora", protocol `jat12://`, userData `jat12-app`, port `7845`, header `X-JAT12-Token`, hotkey `Ctrl+Shift+K` (all reserved in the 2026-07-03 vault decision — the identity survives even though the sibling-bridge architecture it belonged to is superseded by this ground-up rebuild).
- CI: tag push → GitHub Actions → `electron-builder --win --publish always`. Publishing uses the repo-scoped `GITHUB_TOKEN` inside Actions — **no rot-prone personal OAuth token in the loop** (that class of token killed both Gmail sync and CWS publishing in v11, repeatedly).
- Dad-safety rule carried forward: during any trial run on his machine, iterate locally; a tag push IS a production deploy.

---

## 3. Data layer: better-sqlite3, WAL, single writer

**better-sqlite3@^12.11.1** (Electron-41+ V8 compat fixed upstream via `Holder()`; prebuilds published per Electron ABI — 12.8.0 already shipped `electron-v143` binaries, so `prebuild-install` usually avoids a local toolchain; electron-builder's `postinstall`/`@electron/rebuild` covers the fallback).

Why native, stated against the concrete v11 wounds (node-sqlite3-wasm 0.8.x):

| v11 wasm failure | better-sqlite3 answer |
|---|---|
| mkdir-lock VFS (`jat.db.lock` dir) invisible to every other SQLite client | real POSIX/Windows file locking + WAL; standard tooling (DB Browser, sqlite3 CLI) can inspect the live DB read-only |
| colliding writes **silently dropped** (no retry) | synchronous API in one process = no collisions by construction; `busy_timeout` set anyway (5000ms) |
| crashed lock-holder **bricks every future launch** | WAL recovers automatically; no lock artifact to hand-delete |
| dumps its entire minified source on ANY throw (unreadable errors) | normal Error objects with SQLite result codes |
| async API tempted multi-writer patterns | synchronous, transaction-scoped, main-process-only |

Rules (enforced in code + validate.mjs):
1. `Database` is constructed **once**, in `apps/desktop/src/main/db/index.ts`. `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.
2. **Only the Electron main process writes.** Renderer goes through IPC; extension goes through REST/WS. There is no second door.
3. No ORM. Typed repository modules (`jobsRepo.ts`, `queueRepo.ts`, `memoryRepo.ts`, …) with prepared statements cached at module init; row types come from `@jat12/shared/schema/rows` so the renderer and extension agree with the DB by construction.
4. **Lean projections are the default** (v11.82 lesson: `SELECT *` shipped 16MB `/jobs`). Every list repo method takes an explicit column set; `{full:true}` exists only on export/backup paths.
5. **Telemetry rows only on yield** (v11.85 lesson: 12.8k empty-scan rows/day). Discovery batches are written on found/ratelimit/error only; retention windows (discovery 5d, transcripts 3d + 32KB write cap, tasks 14d, events 90d) and a scheduled `VACUUM` are in the schema migration plan from day one, not bolted on.

Alternative considered — Node's built-in `node:sqlite`: attractive (zero dep, no ABI rebuild), but younger and less battle-tested, missing better-sqlite3's mature statement caching and backup APIs, and its stability level inside Electron's bundled Node is not something to bet the single most load-bearing dependency on in 2026. Revisit at v12.5.

### v11 importer

`apps/desktop/src/main/importer/v11.ts` opens `%APPDATA%\jat11-app\jat.db` with better-sqlite3 in `{ readonly: true, fileMustExist: true }`. Preconditions (hard-fail with a human message, never work around):
- v11 process not running (probe `http://127.0.0.1:7744/health` + process scan) — the wasm mkdir lock is invisible to us, so we must *behaviorally* guarantee exclusivity;
- no `jat.db.lock` directory present (stale lock ⇒ tell the user to launch+quit v11 once or delete it consciously).

Imports (live counts as of design): 4,153 jobs (statuses preserved: started/submitted/rejected; 483 submitted), 82 documents, 1,614 profile_fields + 2,314 qa **keyed by profile_id** (the per-profile FK-cascade model from v11.10 carries over verbatim), 497 emails, application-events timeline. Same importer binary runs on Dad's machine against his own jat.db (path is a CLI arg / picker, not hardcoded). Import is idempotent (natural keys: job URL hash, question_norm per profile).

---

## 4. Language: TypeScript everywhere

- **typescript@~6.0.3** (current stable, Apr 2026; the transitional release toward the Go-native TS7 compiler — 7.0 RC exists but we don't ship RCs). Fallback position if any tool chokes on 6.0: pin `5.9.3`; the risk is near-zero because **tsc never emits** in this stack — it type-checks (`noEmit`) and generates `d.ts` for `@jat12/shared` only. All runtime JS is emitted by esbuild (extension, main, preload) or Vite/Rolldown (renderer).
- `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `isolatedModules`, `verbatimModuleSyntax`, `target ES2023`.
- **Project references**, one composite graph: `packages/shared` (environment-agnostic: no DOM lib, no node types — it must compile for both worlds) → `apps/desktop/main` (`types: ["node"]`), `apps/desktop/renderer` (`lib: ["DOM"]`, svelte-check), `apps/extension` (`types: ["chrome"]` via `@types/chrome`).
- `npm run typecheck` = `tsc -b` at root; wired into CI and the pre-tag gate.

Why TS at all, given v11 was plain JS: the three artifacts that broke v11 hardest — the ext⇄app message protocol, the recipe/adapter shapes, and DB row drift between backend and dashboard — are all **contract drift** bugs. A shared typed package plus zod runtime validation makes that whole class fail at compile time or at the boundary, not at 2am mid-run.

---

## 5. Apply-engine state machine: XState v5

**xstate@^5.32.4** (v5 line, actively maintained through 2026; requires TS ≥5.0 — satisfied).

The choice, deliberately made against hand-rolling:

| Requirement (from failure modes 1 & 3) | XState v5 mechanism |
|---|---|
| Page death / SW eviction / WS drop ⇒ **resume, not restart** | `actor.getPersistedSnapshot()` serialized to the `apply_sessions` table on every transition; on reconnect, `createActor(machine, { snapshot })` rehydrates mid-step |
| App owns ALL state; extension is stateless | machines live only in `apps/desktop/src/main/engine`; the extension never holds a step pointer |
| One place enforces pacing/caps/slots | the `Scheduler` machine is the single parent actor; worker slots are its child-actor count (in-flight state ONLY — never "open tab", the v11.84 slot-pinning bug is unrepresentable) |
| Stuck-session debuggability (Mission Control) | actors are introspectable; the renderer renders the live statechart + event log of any session from its persisted snapshot |
| Timeouts as first-class (hydration caps, 30s captcha probe, host cooldowns) | `after` delayed transitions instead of v11's scattered `setTimeout` webs |

Hand-rolled typed FSM was rejected: we'd re-implement persistence, delayed transitions, hierarchical states (LinkedIn's multi-step form IS hierarchical), and inspection — exactly the parts that rot. XState's cost (learning curve, `setup()` typing ceremony) is paid once; its VS Code tooling gaps for v5 don't matter because we don't depend on the visual editor.

Boundary discipline — **recipes are data, machines are code**: the `ApplySession` machine has a fixed, site-agnostic shape (`discovering → arming → navigating → sensing → acting → verifying → submitted | parked | needs_human`). What varies per site is the **recipe** (zod-validated JSON in `recipes/`, hot-updatable via the app without a code ship): selector sets, label patterns, step graphs, advance-button vocabularies (with the v11.86 `Loading...` normalization encoded as recipe-level label normalizers), park predicates (captcha/login/account-wall). The `acting` state invokes a generic `recipeInterpreter` actor that walks the recipe against the latest DOM snapshot. Unknown page shape ⇒ transition to `capture` (snapshot + park + learn queue), never a crash. This gives us MRU heuristics as *content updates*, killing failure mode 2.

Persistence schema (main DB): `apply_sessions(id, job_id, machine_snapshot JSON, recipe_id, recipe_version, status, updated_at)` — snapshot written in the same transaction as the status change, so a crash can never observe a half-advanced session.

---

## 6. Aurora UI stack: Svelte 5 + Vite 8 + three.js

**svelte@^5.56 + vite@^8.1** (Rolldown-powered; renderer only — nothing else in the repo touches Vite).

The evaluation the pillar brief asked for:

- **Vanilla TS (what the lost Aurora was)** — pro: zero framework, zero build (v11's virtue). Con: the virtue existed to serve the extension/app dashboard mirror, which v12 abolishes (§1). 12 pages × live targeted patches × glass-panel component reuse × command palette in vanilla means hand-writing a reactivity system — that's how v11's renderer accumulated its refetch-the-world SSE handlers (failure mode 6). Rejected.
- **React** — heaviest runtime, VDOM churn against a WebGL canvas background, no existing investment. Rejected.
- **SolidJS** — fastest fine-grained updates, but smaller ecosystem, and 2026 comparisons agree both compile-first frameworks are effectively instantaneous below data-grid-with-10k-rows scale (our biggest table is ~4k jobs behind lean pagination anyway). Rejected on DX/ecosystem, not perf.
- **Svelte 5 (chosen)** — runes give per-value reactivity that maps 1:1 onto the "SSE sends the changed row, patch that row" design: a `$state` map of rows, IPC patch handler mutates one entry, exactly one DOM region updates. ~3KB runtime, single-file components suit 12 themed pages, and `bind:this` on canvas elements makes the three.js/canvas islands trivial to mount.

Structure:
- **Galaxy background**: `three@^0.185.1`, one `WebGLRenderer` instance app-wide (created once in a layout component, never per page — v12 perf budget: galaxy ≤ 4ms/frame, paused via `document.hidden` and an FPS governor when the window is unfocused; the app must stay light while a 12h apply run happens). Bloom via `UnrealBloomPass` from `three/examples` (same approach as Pierre's portfolio-site — proven on his RTX 3080 and on Dad-class hardware with the governor).
- **Analytics**: hand-rolled canvas-2D chart modules (`renderer/src/charts/*`) — sparkline, streak heatmap, funnel, per-source lanes. No chart dependency at launch; the Aurora animated aesthetic is bespoke and libs fight it. If a dense time-series view later needs it, `uPlot` is the pre-approved escape hatch (40KB, canvas, MIT) — decision deferred, not taken.
- **6 themes**: CSS custom properties on `:root[data-theme]`; three.js uniforms read the same palette from a shared `theme.ts` so the galaxy recolors with the theme.
- **Command palette / Mission Control / goals & streaks**: plain Svelte components over the IPC API; no additional deps (fuzzy match is ~30 lines, not a package).

Renderer build ships as static files inside the asar; `vite dev` + `ELECTRON_RENDERER_URL` for HMR during development.

---

## 7. Extension stack (thin MV3)

Dependencies: effectively **none at runtime** beyond `@jat12/shared` (bundled in). Dev deps: `esbuild@^0.28.1`, `@types/chrome`.

- `build.mjs` (esbuild script): bundles `src/sw.ts` → `dist/sw.js` (ESM, MV3 module worker), `src/content/sensor.ts` + `actuator.ts` → IIFE bundles, popup as-is; stamps version from the workspace root into `manifest.json` from `manifest.template.json`. `node build.mjs --watch` = the dev loop (ms-scale rebuilds; Chrome "Reload" on `dist/extension` — the unpacked path stays first-class, per the CWS-token-rot reality).
- Manifest deltas vs v11: host_permissions narrowed to the sites we drive + `http://127.0.0.1:7845/*` (drop `<all_urls>` content-script injection — content scripts are injected **on demand** via `chrome.scripting.executeScript` when the app dispatches a session to a tab; v11's inject-everywhere loader was both a perf tax and a review liability).
- **No logic in the page.** `sensor.ts` serializes a bounded DOM snapshot (form region, interactables with geometry/visibility — encoding the 0×0-hidden-radio lesson as *sensor data* the app-side grounding checks) and streams it up; `actuator.ts` executes `{click|fill|select|scroll|upload}` commands by element handle. Both are stateless between messages.
- **WS keepalive**: the SW holds one WebSocket to `ws://127.0.0.1:7845/drive`; Chrome ≥116 extends SW lifetime while the socket is active, so a 20s app-side heartbeat keeps the worker alive during a run — but the protocol is designed for eviction anyway: every message carries `sessionId` + `seq`, reconnect sends `RESUME {sessionId, lastSeq}`, and the app replays from its persisted actor snapshot (§5). Eviction becomes a sub-second hiccup, not a restart.
- Delivery: (1) unpacked `dist/extension` — Pierre's primary path, documented; (2) CWS private listing — secondary, with the refresh-token re-auth runbook (`tools/cws-get-token`) copied over from v11 and token expiry surfaced in the app's Token Health panel alongside Gmail (§9, failure mode 8).

---

## 8. Transport & server

**hono@^4.12 + @hono/node-server@^1 + ws@^8.18**, all inside the Electron main process, bound to `127.0.0.1:7845`, guarded by `X-JAT12-Token` (pairing-consent flow identical in spirit to v11's — a human clicks Allow once; per-tenant account creation stays forbidden).

Three planes, each on the cheapest adequate transport:

1. **Renderer ⇄ main: Electron IPC only.** `ipcRenderer.invoke` for queries/commands (typed via `@jat12/shared/schema/api`), `webContents.send('patch', {table, op, row})` for push. **Targeted patches are the contract**: the payload is the changed row in its lean projection, never a "refetch" hint. This structurally retires v11's SSE-storm → 17MB-refetch loop (failure modes 4 & 6). Lists paginate; detail (description, transcript) is `invoke`-on-open.
2. **Extension ⇄ app: WebSocket `/drive`** for the sensor/actuator stream (zod-validated `wire.ts` messages, `seq`-numbered, resumable), plus a handful of REST routes (`POST /pair`, `GET /recipes/manifest`, `POST /discovery/found` for the in-board f_AL scrape lane).
3. **External clients (future v13 sibling, scripts): REST.** Same lean projections. SSE is **not shipped** in v12 — WS covers push, and every consumer we have is one of the two planes above.

Why Hono over raw `node:http` (v11) or Express: typed routes sharing the zod DTOs, ~14KB, middleware for the token guard in one place, and the same handlers are trivially unit-testable via `app.request()` without binding a port.

---

## 9. Scheduling, email, docs, AI

- **croner@^9** — all periodic work (per-source discovery lanes with **per-source gates** — the v11.83 starvation fix is now the architecture, not a patch; retention/VACUUM; Gmail sync; token-health probes) registers with ONE `Scheduler` module in main. Zero deps, Intl-correct DST handling. No `setInterval` anywhere else (validate.mjs greps for it).
- **@googleapis/gmail@^17 + google-auth-library@^10** — scoped Gmail client (not the 100MB `googleapis` meta-package). Loopback OAuth flow; refresh-token expiry (unverified-app ~7d rot) is a **first-class UI state**: a Token Health card (Gmail + CWS) with one-click re-auth, and the email pipeline answers `needsAuth` loudly instead of silently going stale (v11's email sync died this way twice). The v11.48 lesson carries into config: the sync **query** is broad (all ATS/employer domains), classification happens app-side. imapflow/mailparser are dropped — one email path.
- **mammoth@^1.11** (docx→text, BSD-2) and **unpdf** (pdf→text, MIT, maintained pdfjs) replace the abandoned `pdf-parse@1.1.1`.
- **AI screening fallback**: no vendor SDK. A ~100-line provider interface (`answerQuestion(q, ctx): {answer, confidence}`) with two fetch adapters: Anthropic Messages API via user-supplied API key, and local Ollama (`http://127.0.0.1:11434`). API-key-only is a hard constraint (subscription-powered third-party use is blocked server-side — memory `reference_ai_subscription_constraint`). `aiAnswerConfidenceMin` default 0.65 (proven v11 value). Every accepted answer writes back to `qa(profile_id, question_norm, answer)` so each question is asked **once ever** — profile-first, AI second, human last.

---

## 10. Test stack & guardrails

- **vitest@^4.1.10**, workspace projects (`shared`, `desktop-main`, `extension`): unit tests colocate per package. The engine gets the heaviest coverage: recipe-schema round-trips, FSM transition tables (XState actors are pure to test — feed events, assert snapshots), slot accounting (a regression test that literally encodes "open tab ≠ busy slot"), per-source gate isolation (ATS backlog must not block the LinkedIn lane), lean-projection shape locks (a test fails if a list endpoint ever gains a heavy column).
- **@playwright/test@^1.61.1** for E2E: `chromium.launchPersistentContext` with `--load-extension=dist/extension` against a local fixture server serving **captured DOM snapshots** of real LinkedIn Easy Apply (modal AND full-page `/apply/` variants), Indeed smartapply (including a scripted "Loading...Continue" hydration fixture), and Greenhouse/Lever/Ashby forms. Never drives live sites in CI. Fixture capture is a documented `tools/` flow so every new production DOM break becomes a permanent fixture (the v11 "×155/4h form-root break" would have been a fixture within the hour).
- **tools/validate.mjs** (pre-commit + CI): forbidden-pattern gates rewritten for v12 — no `SELECT *` in repos, no `setInterval` outside scheduler, no `new Database(` outside `db/index.ts`, no captcha-solving vocabulary, no non-localhost URLs in main, no `ipcRenderer` outside preload, extension src must not import from `desktop`. (The old v12-sibling gate that *banned* better-sqlite3 belonged to the superseded bridge architecture and is intentionally retired — v12 owns its own DB now; the importer touches v11's jat.db only read-only with v11 provably stopped.)

---

## 11. GitHub repos: reuse or learn

| Repo | License / health (verified 2026-07) | Verdict | What exactly we take |
|---|---|---|---|
| **speedyapply/JobSpy** | MIT; active — v1.1.79 (2026-03-21), 8 boards | **KEEP as discovery sidecar** | LinkedIn+Indeed scrapers, bundled as the frozen python sidecar under `extraResources/discovery` exactly as v11 does; our freshness-ramp windowing wraps it (v11.58 lesson). Glassdoor scraper unused (dead apply path). Upgrade cadence: on our schedule, pinned. |
| **feder-cr/Jobs_Applier_AI_Agent_AIHawk** | **AGPL-3.0; ARCHIVED 2026-05-17** | **LEARN-ONLY — never vendor a line** | Read its LinkedIn multi-step form walker + question-type taxonomy as a checklist against our recipe coverage. AGPL would virally capture the app, and the repo is dead (Selenium-based besides — wrong architecture for us). All expression goes into our own recipe JSON derived from live capture. |
| Community linkedin-easy-apply bots (various forks) | mostly MIT/unlicensed, low health | learn-only, low value | occasional selector reconnaissance when LinkedIn shifts; our own capture+park learning loop (§5) is the primary mechanism. |
| Greenhouse/Lever/Ashby "client" libs on npm | thin, mostly stale | **SKIP** | the three JSON APIs are single unauthenticated GETs (`boards-api.greenhouse.io/v1/boards/{co}/jobs`, `api.lever.co/v0/postings/{co}?mode=json`, `api.ashbyhq.com/posting-api/job-board/{co}`); we write ~60-line typed fetchers in `shared` and keep our 113 live-verified tokens in `tools/seed-ats-tokens.json` with the keyword+location positive gates (v11.81's Canada gate) as core logic. A dep here is pure liability. |
| mwilliamson/mammoth.js | BSD-2, mature | keep (docx) | as-is. |
| unjs/unpdf | MIT, maintained | adopt (pdf) | replaces abandoned pdf-parse. |
| WiseLibs/better-sqlite3 | MIT, active (12.11.1, Electron-41 fix landed) | adopt | §3. |
| statelyai/xstate | MIT, active (5.32.4) | adopt | §5. |

---

## 12. Exact dependency manifest

Versions researched 2026-07-07; pin exact at scaffold time (`npm i` resolves patch drift). Electron pinned exact; everything else caret within researched major.

### root `package.json` (dev-only)
```jsonc
{
  "devDependencies": {
    "typescript": "~6.0.3",        // type-check only; TS7-Go migration when GA
    "vitest": "^4.1.10",           // unit tests, workspace projects
    "@playwright/test": "^1.61.1", // extension E2E on captured fixtures
    "esbuild": "^0.28.1"           // extension + main/preload emit
  }
}
```

### `packages/shared`
```jsonc
{ "dependencies": { "zod": "^4.4.3" } }   // the ONLY runtime dep of the contract package
```

### `apps/desktop`
```jsonc
{
  "dependencies": {
    "better-sqlite3": "^12.11.1",   // native, WAL, single-writer (kills wasm pain, §3)
    "xstate": "^5.32.4",            // ApplySession actors + persisted snapshots (§5)
    "hono": "^4.12.27",             // typed local REST on 127.0.0.1:7845
    "@hono/node-server": "^1.19.0", // node adapter for hono
    "ws": "^8.18.0",                // /drive WebSocket (extension channel)
    "croner": "^9.0.0",             // the one scheduler (per-source lanes, retention)
    "@googleapis/gmail": "^17.0.0", // scoped Gmail client (not googleapis meta)
    "google-auth-library": "^10.0.0", // loopback OAuth + refresh handling
    "mammoth": "^1.11.0",           // docx resume parsing
    "unpdf": "^1.3.0",              // pdf resume parsing (pdf-parse is abandoned)
    "electron-updater": "^6.8.9",   // GitHub-release auto-update (NEW repo, §2)
    "electron-log": "^5.4.0",       // rotating file logs (kept from v11)
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "electron": "42.5.2",           // EXACT pin (native ABI)
    "electron-builder": "^26.15.3",
    "@electron/rebuild": "^4.0.0",  // fallback if prebuild-install misses ABI
    "vite": "^8.1.3",               // renderer only (Rolldown)
    "svelte": "^5.56.4",
    "@sveltejs/vite-plugin-svelte": "^6.0.0",
    "svelte-check": "^4.3.0",
    "three": "^0.185.1",            // galaxy + UnrealBloomPass
    "@types/three": "^0.185.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/ws": "^8.5.0",
    "@types/node": "^22.0.0"
  }
}
```
(`three` sits in devDependencies because Vite bundles it into the renderer output; nothing requires it at node runtime.)

### `apps/extension`
```jsonc
{
  "devDependencies": { "@types/chrome": "^0.0.330" }
  // zero runtime deps; @jat12/shared is bundled in by esbuild
}
```

### Sidecar (non-npm)
- **JobSpy v1.1.79** (python, MIT) — frozen exe/env under `extraResources/discovery`, same packaging as v11's `build/discovery`.

Version-pin policy: `package-lock.json` committed; Renovate-style manual review monthly; Electron majors quarterly; better-sqlite3 bumped **only together with** an Electron bump (ABI pairing), verified by a smoke test that opens/writes/vacuums a scratch DB in CI on Windows.

---

## 13. Risks & mitigations

1. **better-sqlite3 ABI vs Electron 42** — prebuilds for electron-v143 ABI exist upstream; CI smoke test on Windows catches a miss before tag; `@electron/rebuild` is the fallback. Low.
2. **TypeScript 6.0 ecosystem friction** — tsc is check-only, so worst case is pinning back to 5.9.3 with zero runtime impact. Low.
3. **XState learning curve / over-modeling** — confined: exactly two machine families (Scheduler, ApplySession); recipes stay data; a rule in the engine README: "if you're adding a state for a site quirk, it belongs in a recipe."
4. **Vite/Svelte renderer build divergence from main-process esbuild** — accepted dual-toolchain (Vite is renderer-only); both consume the same tsconfig graph and `@jat12/shared`.
5. **WS-keepalive behavior changes in future Chrome** — the resume protocol assumes eviction at any time regardless; keepalive is an optimization, not a correctness dependency.
6. **JobSpy upstream breakage (LinkedIn hostility)** — pinned sidecar; discovery also has two non-JobSpy lanes (extension in-board f_AL scrape, ATS board APIs), so no single-lane starvation (per-source gates, §9).

## 14. Open questions (for the architect / Pierre)

1. **New release repo name** — `PierreSalama/JAT12-app` proposed; needs Pierre to create it + confirm the name before CI wiring (the only human-gated step in §2).
2. **Coexistence period**: does v12 need live read access to v11's data *before* cutover (the 2026-07-03 bridge design), or is the one-time stopped-v11 import (§3) sufficient? This doc assumes import-only cutover; if live coexistence is wanted for a trial period, the paired-API bridge from the vault decision can be re-added as a small module without changing any stack choice.
3. **Ollama local model choice** for the AI fallback default (affects only docs/first-run UX, not the manifest).
4. **CWS listing**: reuse the existing private listing (new version, same extension ID — keeps Dad's install path) vs a new listing for v12 (clean ID, both extensions can coexist in one Chrome). Leaning new listing; needs Pierre's call since it costs a review cycle.
5. **uPlot escape hatch** — pre-approved but not shipped; confirm the analytics pages stay hand-rolled at launch.
