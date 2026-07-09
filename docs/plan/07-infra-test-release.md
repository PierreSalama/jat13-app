# Pillar 7 — Repo Layout, Test Strategy, Release Pipeline

Status: DESIGN (implementation-ready)
Owner: infra pillar
Depends on: Pillar 1 (app/extension protocol), Pillar 2 (language/runtime choice), Pillar 3 (adapter DSL), Pillar 5 (DB schema + importer)
Feeds: every other pillar (this doc defines where their code lives, how it is tested, and how it ships)

---

## 0. Evidence base (what this design is built from)

Every decision below traces to a v11 production failure or a locked v12 decision:

| Evidence | Source | What it forces |
| --- | --- | --- |
| Deploy divergence: working tree drifted BEHIND the deployed `.v11-publish` mirror; a robocopy /MIR release would have regressed production | memory `reference_jat_deploy_divergence` | Kill the code-repo/publish-repo split. One repo, no mirror step. |
| CI test-list drift cost a release (v11.31.0): `release.yml` had an explicit `node --test <file list>` that diverged from `app/package.json`'s list → checks failed → build skipped → GitHub release published with **no installer** | memory `reference_jat_release_repo` | CI must run **the same single command** developers run (`npm test`), with **glob discovery**, never a hand-maintained file list. |
| Dashboard byte-mirror (`tools/mirror.mjs`, `extension/app/**` ↔ `app/src/app/**`) required a mirror gate in CI and caused "which copy is source of truth" bugs | memory `feedback_jat_dashboard_mirror`, v11 `tools/mirror.mjs` | v12 thin extension has **no dashboard** → the mirror and its entire failure class are deleted, not fixed. |
| CWS OAuth refresh token rots (~7 days, unverified Google app) and repeatedly blocked extension delivery | memory `reference_jat_v1181_v1182`, `reference_cws_private_distribution` | Pierre's release path must be **unpacked-first**; CWS is a secondary channel for Dad, never a release gate. |
| Windows-only must-pass builds; `CSC_LINK=''` breaks electron-builder; mac/linux failures must not fail a Windows release; Node runner deprecations break checks | v11 `.github/workflows/release.yml`, memory `reference_jat_release_repo` | Carry these hard-won workflow patterns forward verbatim. |
| Tagging the code repo (`Job-Board`) does NOT build; only the publish repo's root workflow fires | memory `reference_jat_release_repo` | Workflow must live at the root of the repo that gets tagged — trivially true once there is one repo. |
| `harness/run.mjs` (Playwright + real unpacked extension + fixtures served under real hostnames + mock app on 7744) caught real regressions (external-posting fast-skip, screening flows) | v11 `harness/run.mjs`, `harness/fixtures/*` | Evolve, don't discard: fixture-replay is the E2E backbone; v12's snapshot protocol makes fixture capture a built-in feature. |
| electron-updater auto-updates every install the moment a release publishes (Dad's machine included); local iteration must never accidentally release | memory `feedback_jat_dad_trial_no_deploy` | Releases only on explicit `v12.*` tag push; dev mode runs from source on an isolated userData/port. |
| v11 importer constraint: v11's jat.db is wasm-mkdir-locked while v11 runs; import must happen with v11 **stopped**, read-only | ground truth, vault decision 2026-07-03 | Cutover runbook freezes v11 first; importer opens the DB read-only via better-sqlite3. |
| v12 identity already reserved: port **7845**, userData **jat12-app**, hotkey Ctrl+Shift+K, protocol `jat12://`, header `X-JAT12-Token` | vault `2026-07-03 — jat-v12-sibling-coexistence-architecture` | Reuse these; add a **dev** identity (port 7846, userData `jat12-app-dev`) so dev and prod v12 coexist. |

---

## 1. Decisions at a glance

| # | Decision | One-line rationale |
| --- | --- | --- |
| D1 | **New public GitHub repo `PierreSalama/jat12-app`**; code repo == release repo; the local clone IS `…\job-application-tracker\v12\` | Kills the mirror/divergence class AND the electron-updater cross-talk hazard (v11 clients polling `Job-ext-app` `/releases/latest` must never see a v12 release). |
| D2 | **npm workspaces monorepo** (`app/`, `extension/`, `shared/`, `adapters/`, `tools/`, `tests/`) | Boring, zero extra tooling on Pierre's machine; workspaces give one `npm install`, one lockfile. |
| D3 | **TypeScript + esbuild** everywhere; extension always loads **unpacked from `extension/dist/`**, kept fresh by `npm run dev` watch | Pillar 2 wants TS; esbuild is the only bundler fast enough (<200 ms) that the "reload unpacked" loop stays as instant as v11's zero-build loop. |
| D4 | **Version single-source**: root `package.json` is the ONLY hand-edited version; `tools/stamp-version.mjs` writes it into `extension/static/manifest.json` + `app/package.json`; CI gate re-verifies | v11 bumped three files in lockstep and drifted anyway (publish root stuck at 11.0.0 blocked v11.8.0). Stamping > syncing. |
| D5 | **vitest** for unit+integration (glob discovery, TS-native, one `npm test`); **Playwright** for browser E2E; **node:test is retired** | The explicit-file-list drift that cost release v11.31.0 becomes structurally impossible: there is no list. |
| D6 | **Two-tier E2E**: (a) *protocol replay* — recorded snapshot/command transcripts replayed against the app brain with no browser (fast, always in CI); (b) *browser replay* — Playwright + real unpacked extension + saved page fixtures under real hostnames (v11 harness evolved) | The thin-extension architecture means most "site logic" is testable without a browser at all; the browser tier only has to prove the sensor/actuator layer. |
| D7 | **Live canary** = `tools/canary.mjs`, one real supervised apply per source, structured evidence bundle; required before any release that touches driver/adapters; never in CI | Fixture replay can't prove LinkedIn didn't change yesterday; one watched apply per source can. |
| D8 | **Adapters ship two ways**: bundled in the app at build time + hot-fetched from the repo via a CI-advanced git tag `adapters-stable` (raw.githubusercontent URL) | Adapter fixes must ship in minutes without an installer; a moving tag gives gating (only CI-validated commits) with zero release-object interference with electron-updater. |
| D9 | Versioning: app/extension **12.MINOR.PATCH** in lockstep; wire protocol has its own integer `PROTOCOL_VERSION` handshake; adapters have their own `bundleVersion` (date-serial) | Extension and app can skew (unpacked vs auto-update); the handshake converts skew from silent breakage into an explicit UI warning. |
| D10 | Rollback: draft-hide the bad GitHub release + re-tag last-good as a higher patch; DB migrations forward-only with automatic pre-migration backup `jat12-<ver>.db.bak`; every app release also carries the matching extension zip as an asset | electron-updater never downgrades; the only universal rollback is "ship the old code as a newer version", so make that a 2-command runbook. |
| D11 | Importer tested three ways: synthetic v11-schema fixture DB in CI; `test:import:real` against a copy of the live jat.db on Pierre's machine; count-verification step in the cutover runbook | Real jat.db has PII and can't live in a public repo; schema fidelity is testable synthetically, count fidelity is verified at cutover. |

---

## 2. Repo & remote strategy (D1)

### 2.1 The decision

Create **`PierreSalama/jat12-app`** (public). Clone it at:

```
F:\GITHUB\Perosnal\extensions\job-application-tracker\v12\      ← the repo root
```

There is **no publish mirror**. The tree you edit is the tree that tags, builds, and releases.

### 2.2 Why not "same repo (`Job-ext-app`), distinct `v12.*` tags"

Considered and rejected for three concrete reasons:

1. **electron-updater cross-talk.** The GitHub provider resolves updates from the repo's *latest* release (`latest.yml` on the newest non-prerelease). v11 installs (Dad's machine) point at `Job-ext-app`. The first `v12.0.0` release in that repo becomes "latest" and **auto-updates every v11 install to v12** — exactly the "don't break Dad's running app" hazard. Channels/prerelease flags can dodge this but are fragile config on both the publisher and every installed client; a separate repo makes the hazard impossible.
2. **Workflow collision.** `Job-ext-app`'s root workflow triggers on `v11.*`; adding v12 means either two workflows sharing one repo root fighting over `app/` layout, or reintroducing a subdirectory split — the exact "tagging the code repo doesn't build" trap.
3. **v11 must keep releasing during the transition.** The cutover runbook (§12) keeps v11 alive for weeks. Its release machinery must stay byte-untouched.

Public (not private) because the v11 clean-machine audit proved the tokenless story depends on it: installer download and electron-updater polling need **no GitHub account** for testers. No secrets ever live in the repo (BYO AI keys, per-install pairing tokens — unchanged v11 security lines).

### 2.3 Nesting note

The parent folder `job-application-tracker\` holds `v1…v11`, `.v11-publish` (each with their own git story). `v12\` is an independent clone. If the parent is itself tracked anywhere, add `v12/` to that tracker's ignore file. Never add `v12` as a submodule of `Job-Board`.

### 2.4 Branch model

- `main` — always releasable; CI (`ci.yml`) must be green to merge.
- Short-lived feature branches; no develop branch, no release branches. A release is a tag on `main`.
- The moving tag `adapters-stable` (§9) is the only non-semver ref CI manipulates.

---

## 3. Monorepo layout

```
v12/                                  # repo root == PierreSalama/jat12-app clone
├── package.json                      # workspaces root; THE version (D4); shared devDeps (typescript, esbuild, vitest, playwright)
├── package-lock.json
├── tsconfig.base.json                # strict, ES2022, bundler moduleResolution
├── .gitignore                        # extension/dist/, app/dist/, app/out/, node_modules/, tests/canary-runs/, *.local.*
├── .github/
│   └── workflows/
│       ├── ci.yml                    # push/PR: gates + unit + integration + protocol-replay + adapter validation
│       ├── release.yml               # tag v12.*: full gates → build matrix → GitHub release
│       └── adapters.yml              # push to main touching adapters/: validate + fast-forward adapters-stable
├── app/                              # Electron desktop app — THE BRAIN (Pillars 1,4,5,6)
│   ├── package.json                  # name jat12-app; version stamped by tools/stamp-version.mjs
│   ├── electron-builder.yml          # appId com.pierre.jat12, productName "JAT 12", publish: github jat12-app
│   ├── build/                        # icon.svg, make-icons.mjs, installer resources (NOT build output)
│   ├── src/
│   │   ├── main/                     # main process: scheduler, driver, db (better-sqlite3), server (7845), sources/
│   │   ├── preload/
│   │   └── renderer/                 # Aurora UI (WebGL galaxy, glass panels…) — lives ONLY here (no mirror, ever)
│   └── dist/                         # esbuild output (gitignored); electron-builder consumes this
├── extension/                        # thin MV3 sensor/actuator (Pillar 1)
│   ├── src/
│   │   ├── sw.ts                     # service worker: transport to app :7845, tab lifecycle relay
│   │   ├── content/sensor.ts         # DOM snapshot producer
│   │   ├── content/actuator.ts       # click/fill/scroll command executor
│   │   └── popup/                    # pairing status only
│   ├── static/                       # manifest.json (version placeholder "0.0.0"), icons, popup.html
│   └── dist/                         # gitignored; the ONLY load-unpacked target (chrome://extensions → this folder)
├── shared/                           # workspace pkg @jat12/shared — imported by app AND extension AND tests
│   ├── package.json
│   └── src/
│       ├── protocol/                 # message types + zod schemas + PROTOCOL_VERSION (single integer)
│       ├── adapter-schema/           # zod/JSON-Schema for the adapter DSL (Pillar 3 owns semantics)
│       └── constants.ts              # ports 7845/7846, header X-JAT12-Token, userData names
├── adapters/                         # SITE ADAPTERS AS DATA — plain JSON, no code
│   ├── index.json                    # { bundleVersion: "2026.07.07-1", adapters: [{id, file, sha256}] }
│   ├── linkedin-easyapply.json
│   ├── indeed-smartapply.json
│   ├── greenhouse.json
│   ├── lever.json
│   └── ashby.json
├── tools/
│   ├── stamp-version.mjs             # root version → manifest.json + app/package.json (writes)
│   ├── validate-versions.mjs         # same, --check mode (CI gate; fails on drift)
│   ├── validate-extension.mjs        # MV3 manifest sanity + forbidden-pattern scan (§7.2)
│   ├── validate-adapters.mjs         # every adapters/*.json vs shared/adapter-schema + index sha256s
│   ├── pack-extension.mjs            # extension/dist → dist/jat12-extension-v<ver>.zip (CWS-ready + release asset)
│   ├── capture-fixture.mjs           # freeze-dry a live page via the sensor snapshot channel → tests/fixtures/pages/
│   ├── record-transcript.mjs         # record a snapshot/command transcript from a live/harness run → tests/fixtures/transcripts/
│   ├── make-v11-fixture-db.mjs       # synthetic jat.db with the REAL v11 DDL + fake rows (importer CI tests)
│   ├── import-v11.mjs                # CLI importer (also invoked by the app's onboarding wizard) — Pillar 5 owns mapping
│   ├── dump-schema.mjs               # emits tests/fixtures/schemas/v<user_version>.sql at release time
│   ├── canary.mjs                    # live-canary runner (§6.5)
│   ├── release.ps1                   # thin: stamp → gate → commit → tag → push (§10) — NO robocopy, NO mirror
│   └── rollback.ps1                  # §11 automation: draft-hide release N, re-tag last-good as N+1
├── tests/
│   ├── unit/                         # *.test.ts — pure logic (vitest)
│   ├── integration/                  # *.test.ts — fake transport, migrations, importer (vitest)
│   ├── replay/                       # *.test.ts — protocol-replay E2E (vitest, no browser)
│   ├── e2e/                          # *.spec.ts — Playwright browser replay (real unpacked extension)
│   ├── fixtures/
│   │   ├── pages/<site>/<flow>/      # saved DOM fixtures: step-01.html … + flow.json (step graph + assertions)
│   │   ├── transcripts/<site>/*.jsonl# recorded snapshot/command streams for protocol replay
│   │   ├── schemas/v*.sql            # every released jat12 schema (migration-path tests)
│   │   └── v11/ddl.sql               # captured v11 schema DDL (importer tests)
│   ├── helpers/                      # FakeTransport, tempDb(), fixture server, extension launcher
│   └── canary-runs/                  # gitignored; live-canary evidence bundles
└── docs/
    ├── plan/                         # these pillar docs
    ├── RELEASING.md                  # §10 as an operator doc
    ├── ROLLBACK.md                   # §11
    ├── CUTOVER.md                    # §12
    └── EXTENSION-DEV.md              # load-unpacked walkthrough w/ screenshots
```

What is deliberately **absent** vs v11: `tools/mirror.mjs` (no dashboard mirror — renderer exists only in `app/src/renderer`), a publish mirror folder, `harness/` as a top-level oddity (absorbed into `tests/e2e` + `tools/`), any committed build output.

---

## 4. Build tooling (D2, D3)

### 4.1 The constraint being designed for

v11's superpower was **zero-build**: edit `extension/`, hit reload in `chrome://extensions`, change is live. Its cost was the byte-mirror and no types. v12 takes TypeScript (Pillar 2) but must keep the loop feeling zero-build. Budget: **file-save → reloadable dist in <1 s**.

### 4.2 Toolchain

- **npm workspaces** (root `package.json` `"workspaces": ["app", "extension", "shared"]`). One `npm install` at root, one lockfile. No pnpm/turbo/nx — nothing in this repo is big enough to earn them.
- **esbuild** (direct API, driven by `tools/build.mjs`, not a framework):
  - `extension/src/sw.ts` → `extension/dist/sw.js` (format `esm`, MV3 module service worker)
  - `extension/src/content/sensor.ts` + `actuator.ts` → `extension/dist/content.js` (format `iife`, single file — content scripts can't import)
  - `extension/static/**` → copied into `extension/dist/` (manifest.json gets the version stamped in-flight during builds; in watch/dev mode it keeps the dev placeholder)
  - `app/src/main/**` → `app/dist/main.js` (+ preload) — bundled, `platform:'node'`, `external: ['electron','better-sqlite3']` (native module stays unbundled; ships via electron-builder `asarUnpack`)
  - `app/src/renderer/**` → `app/dist/renderer/` (Three.js + Aurora bundle; code-split per page is fine, esbuild `splitting:true` + `format:'esm'`)
- **typecheck is separate from build**: `tsc --noEmit -p tsconfig.base.json` (esbuild strips types without checking; CI runs the check, dev loop doesn't block on it).

### 4.3 npm scripts (root — the complete surface)

| Script | Does |
| --- | --- |
| `npm run dev` | `tools/build.mjs --watch` (all targets) + Electron on **dev identity** (port 7846, userData `jat12-app-dev`, `JAT12_ENV=dev`). Extension stays reloadable from `extension/dist` the whole time. |
| `npm run build` | one-shot production build of all targets (used by CI + electron-builder `beforeBuild`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run` — **discovers `tests/{unit,integration,replay}/**/*.test.ts` by glob**; the ONE command CI and humans both run |
| `npm run test:e2e` | `playwright test tests/e2e` (builds extension first) |
| `npm run test:import:real` | local-only: copies `%APPDATA%\jat11-app\jat.db` → temp, runs importer, asserts live counts (§6.2) |
| `npm run canary -- --source <s>` | §6.5 |
| `npm run gates` | `validate-versions --check` + `validate-extension` + `validate-adapters` + `typecheck` (the CI `checks` job = `gates` + `test`) |
| `npm run pack:extension` | `tools/pack-extension.mjs` → `dist/jat12-extension-v<ver>.zip` |
| `npm run release -- 12.1.0 "msg"` | `tools/release.ps1` (§10) |

### 4.4 Unpacked-extension ergonomics (the non-negotiable)

- `extension/dist/` **always exists and always loads** — `tools/build.mjs` runs a full build before entering watch mode, and `postinstall` runs one build so a fresh clone is immediately loadable.
- `docs/EXTENSION-DEV.md` documents the one-time setup: `chrome://extensions` → Developer mode → Load unpacked → `…\v12\extension\dist`. This is Pierre's **primary** delivery channel (memory: CWS token rot must never block him).
- Reload-after-change stays manual (Chrome requires it for SW changes); the dev app's Mission Control shows the connected extension's `buildTime` so a stale-extension state is visible instead of mysterious (v11 lesson: "deploy+reload converts stale-extension failures to fast skips").
- If Pillar 2 had chosen plain JS: everything above still stands minus `typecheck` — esbuild is kept regardless because the content script must be a single-file IIFE and the renderer needs Three.js bundling. The build is an architecture requirement, not a TS tax.

---

## 5. Versioning (D4, D9)

Three independent version axes, each with one owner:

1. **Product version `12.MINOR.PATCH`** — lives ONLY in root `package.json`. `tools/stamp-version.mjs` writes it into `app/package.json` (electron-builder needs it there) and `extension/static/manifest.json`. `tools/validate-versions.mjs` is the `--check` twin; it runs in CI and in `release.ps1`, and **fails** if the three disagree — but unlike v11, drift can only happen if someone hand-edits a stamped file, because there is exactly one editable source.
   - MINOR = features / adapter-DSL capability bumps / schema migrations. PATCH = fixes. Starts at **12.0.0**.
2. **`PROTOCOL_VERSION`** — a single integer in `shared/src/protocol/version.ts`, bumped on any breaking wire change. Extension sends it in its hello; the app compares:
   - equal → connected;
   - unequal → the app serves a red Mission Control banner "Extension protocol vN, app expects vM — reload the unpacked extension / update the app" and refuses to dispatch applies (sensor-only mode still allowed for diagnostics). This converts the unavoidable unpacked-vs-autoupdate skew into a visible, safe state.
3. **Adapter `bundleVersion`** — date-serial `YYYY.MM.DD-n` in `adapters/index.json`, bumped by the adapter author in the same PR. The app records which bundleVersion produced every apply attempt (Pillar 4's telemetry), so "did the adapter update fix it" is answerable from data.

---

## 6. Test pyramid

### 6.0 Framework choice (D5)

**vitest** for everything non-browser: TS-native (no build step for tests), glob discovery (no file lists anywhere — the v11.31.0 class is dead), watch mode, workspace-aware. **Playwright `@playwright/test`** for the browser tier. Node's built-in runner is retired: it's what produced the explicit-file-list workaround (`node --test` glob support gated on Node 21+) that cost a release.

Coverage: `vitest --coverage` (v8 provider) reported in CI, **no hard threshold gate** initially (thresholds on a young codebase generate test-theater); revisit at 12.1.

### 6.1 Unit tier (`tests/unit`) — pure, no I/O, milliseconds

The v12 architecture was chosen to make the dangerous logic pure; unit tests exploit that:

- **Adapter DSL interpreter** (Pillar 3): given `(adapterJson, snapshotJson)` → expected `plan` (next command, extracted fields, step classification). Table-driven over `tests/fixtures/transcripts` snapshots. This is where the v11 heuristics that lived un-testably inside `executor.js` (anchored `/^continue$/` missing "Loading...Continue", 0×0 hidden radios, disabled-advance-means-waiting) become permanent regression rows.
- **Apply state machine** (Pillar 4): transition table tests — every `(state, event) → (state', actions)` including the resume-not-restart paths (SW eviction mid-flow, tab death, back/forward-cache port theft) as plain events.
- **Answer service**: profile-first resolution order (exact qa → fuzzy qa → profile_fields → AI-fallback-eligible), `aiAnswerConfidenceMin` gating, save-back dedup (asked-once-ever invariant), per-profile scoping (memory: every memory fn takes profileId).
- **Scheduler/pacing**: worker slots are in-flight-state-only (regression: v11.84 "open tab ≠ busy slot"), per-source lanes and gates (regression: v11.83 ATS-starves-LinkedIn), LinkedIn ~50/24h per-account cap pacing, host-cooldown breaker.
- **Projections**: the lean list projections (Pillar 6) have shape tests asserting heavy columns (description, transcript, attachments) are absent — the 16 MB `/jobs` bomb as a unit test.
- **Telemetry economy**: discovery batch recorded **only on yield** (regression: v11.85's 12.8k empty-scan rows/day).

### 6.2 Integration tier (`tests/integration`) — real modules, fake edges

- **Protocol over FakeTransport.** `tests/helpers/fake-transport.ts` implements the same duplex interface the real WS transport exposes (Pillar 1), in-memory, with fault injection: `dropNext()`, `evictWorker()` (simulate MV3 SW death mid-command), `delay(ms)`. Tests run the real app-side driver against a scripted fake extension and assert: idempotent command re-issue after reconnect, no duplicate submits after replay, hello/protocol-version handshake, token auth (`X-JAT12-Token`) rejection.
- **DB migrations** (better-sqlite3 on temp files):
  - fresh: empty → latest, assert `user_version` + full schema;
  - stepwise: for every `tests/fixtures/schemas/v*.sql` (dumped by `tools/dump-schema.mjs` at each release), load it, migrate to latest, assert;
  - pre-migration backup file created; failed-migration leaves the backup intact.
- **Importer** (Pillar 5's code, this pillar's harness):
  - CI: `tools/make-v11-fixture-db.mjs` builds a synthetic jat.db from `tests/fixtures/v11/ddl.sql` (the *real* v11 DDL, captured once from the live DB with v11 stopped) + generated fake rows covering every status, per-profile qa/profile_fields FK relationships, documents blobs, emails, events. Test asserts row-count and referential fidelity after import, idempotent re-run (no dupes), and read-only source (source file hash unchanged).
  - Local-only `npm run test:import:real`: refuses to run unless port 7744 is unowned (`Get-NetTCPConnection`) and no `jat.db.lock` directory exists; copies the real DB to temp; imports; asserts the live invariants (as of design time: 4,153 jobs / 483 submitted / 82 documents / 1,614 profile_fields / 2,314 qa / 497 emails — the script reads expected counts from the *source* DB, not hardcoded, and reports a diff table). This same code path is the cutover verifier (§12).
- **HTTP/SSE surface**: supertest-style against the real server on an ephemeral port + temp DB: lean payload budgets asserted numerically (e.g. `/jobs` list response < 1 MB at 5k synthetic jobs), SSE emits row-patches not refetch-pings.

### 6.3 Protocol-replay E2E (`tests/replay`) — the v12-only trick, browserless

Because the extension is a dumb sensor/actuator, a full apply flow is, from the brain's perspective, just a **transcript**: a sequence of `snapshot` frames in and `command` frames out. So:

- `tools/record-transcript.mjs` records `*.jsonl` transcripts (each line a timestamped protocol frame) from any live or browser-E2E run.
- A replay test feeds recorded snapshots through FakeTransport to the **real** brain (driver + interpreter + answer service + state machine) and asserts the emitted command sequence and terminal state (`submitted` / `parked:captcha` / `parked:unknown-page` / `skipped:external`).
- Site changes are captured as new transcripts; regressions ("Easy Apply form disappeared after advancing" ×155) become one recorded transcript + one assertion, forever.
- Runs in plain vitest, seconds per flow, always in CI. This tier carries most of the E2E burden.

### 6.4 Browser-replay E2E (`tests/e2e`) — Playwright + real extension + saved pages

Proves the layer protocol-replay can't: content-script injection, real DOM snapshotting, real click/fill events, SW lifecycle.

Evolved from `v11/harness/run.mjs` (same architecture, upgraded pieces):

- `chromium.launchPersistentContext` with `--load-extension=extension/dist` (headless `--headless=new` where it supports extensions; the CI job falls back to `xvfb-run` headed on ubuntu — decided by a capability probe in the Playwright config, not hardcoded).
- A **fixture server** (`tests/helpers/fixture-server.ts`) serves saved pages under their **real hostnames** via Playwright request routing (v11 technique — host-keyed adapter matching engages authentically).
- **Fixtures are step graphs**, not single pages: `tests/fixtures/pages/<site>/<flow>/flow.json` declares steps, and each step's HTML + a small per-step script that mutates the DOM on actuation (fill marks value, advance swaps to next step's DOM) — mirroring v11's `fixtures/*.html + *.js` pairs, but generated by `tools/capture-fixture.mjs` from real sensor snapshots instead of hand-authored.
- A **fake app** is NOT used (v11 used mock-app.mjs): v12 runs the **real app brain** headless (main-process modules bootstrapped without Electron windows, temp DB, port 7846) so browser E2E exercises the true end-to-end path: brain ↔ extension ↔ fixture page.
- Assertions per flow: terminal state, `window.__APPLIED` sentinel on submit fixtures, max wall time (the v11 fast-skip time budgets carry over, e.g. external-posting skip < 12 s), zero forbidden actions (no clicks on captcha iframes — the fixture plants one and asserts untouched).
- Launch fixture set (captured during v11 operation + first v12 canaries): `linkedin/easyapply-modal`, `linkedin/easyapply-fullpage`, `linkedin/external-posting`, `linkedin/screening-questions`, `indeed/smartapply`, `indeed/cloudflare-wall`, `greenhouse/standard`, `lever/standard`, `ashby/standard`, `generic/unknown-park`.

### 6.5 Live canary (`tools/canary.mjs`) — one real apply per source, human watching

- Invocation: `npm run canary -- --source linkedin --i-am-watching` (the flag is mandatory; without it the tool prints the policy and exits). Optional `--job <url>` to target a specific posting; otherwise it picks the top queued job for that source.
- Runs against the **dev identity** app connected to the real logged-in Chrome (unpacked extension), dispatches exactly ONE apply, and streams the transcript live to the terminal.
- Output: `tests/canary-runs/<ISO-ts>-<source>/` containing `transcript.jsonl`, `snapshots/*.json`, `screenshots/*.png` (Playwright-less: captured via `chrome.tabs.captureVisibleTab` through the sensor channel), `result.json` (`{source, jobUrl, outcome, wallMs, bundleVersion, appVersion, humanAck}`), where `humanAck` is a y/n prompt answered by the watcher at the end ("did what you saw match the transcript?").
- Policy hooks: canary refuses to run if auto-apply is enabled (no interleaving), and it counts against the LinkedIn daily cap like any apply.
- **Release gate** (checklist, §10): a green canary per source ≤ 7 days old is required for releases touching `app/src/main/driver`, `shared/protocol`, or `adapters/` — enforced socially via the checklist, not CI (CI can't watch a human watch).

### 6.6 Pyramid budget

| Tier | Count at launch (target) | Runtime | Where |
| --- | --- | --- | --- |
| unit | ~150 | < 10 s | CI every push |
| integration | ~40 | < 60 s | CI every push |
| protocol-replay | ~15 flows | < 30 s | CI every push |
| browser-replay | ~10 flows | < 8 min | CI every push (separate job, non-blocking for docs-only changes via `paths-ignore`) |
| canary | 4 sources | human-paced | pre-release, Pierre's machine |

---

## 7. CI — GitHub Actions

### 7.1 `ci.yml` (push + PR to main)

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }          # pinned; bump deliberately (v11 lesson: runner Node deprecations break checks)
      - run: npm ci
      - run: npm run gates                    # version stamp check + extension gate + adapter gate + typecheck
      - run: npm run build
      - run: npm test                         # vitest glob — the SAME command a human runs; no file lists (v11.31.0 lesson)
  browser-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm run build
      - run: npx playwright install chromium --with-deps
      - run: xvfb-run -a npm run test:e2e     # headed-under-xvfb is the reliable MV3 path; config auto-detects
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: e2e-traces, path: test-results/ }
```

### 7.2 Gates (the `npm run gates` content)

- `validate-versions.mjs --check` — root/app/manifest versions identical.
- `validate-extension.mjs` — MV3 manifest sanity (module SW, minimal permissions allowlist diffed against a committed golden set so a permission creep is a reviewed change) **plus forbidden-pattern scan of `extension/dist`**: no `fetch(`/`XMLHttpRequest` to non-`127.0.0.1:784[56]` origins, no `eval`, no `chrome.storage` writes of secrets, no captcha-related selectors in actuator code. The thin extension has no business talking to anything but the app; the gate makes that architectural claim executable.
- `validate-adapters.mjs` — every adapter validates against `shared/adapter-schema`; `index.json` sha256s match files; `bundleVersion` strictly increases vs `main` (fetched via `git show origin/main:adapters/index.json`).
- `tsc --noEmit`.

### 7.3 `release.yml` (tag `v12.*`)

Carries the v11 workflow's hard-won patterns forward, adapted:

```yaml
name: Build & Release JAT v12
on:
  push: { tags: ['v12.*'] }
  workflow_dispatch:
permissions: { contents: write }
jobs:
  checks:            # identical steps to ci.yml checks + browser-e2e (a release re-proves everything)
    ...
  build:
    needs: checks
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: windows-latest, artifact: '*setup*.exe', label: Windows }
          - { os: macos-latest,   artifact: '*.dmg',       label: macOS }
          - { os: ubuntu-latest,  artifact: '*.AppImage',  label: Linux }
    runs-on: ${{ matrix.os }}
    continue-on-error: ${{ matrix.os != 'windows-latest' }}   # Windows is the only must-pass installer (v11 pattern)
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm run build
      - name: Icons
        working-directory: app
        run: npm i sharp --no-save && node build/make-icons.mjs
      - name: Bundle JobSpy discovery worker            # jobspy stays a pyinstaller onefile (v11 pattern)
        shell: bash
        run: |
          python -m pip install --disable-pip-version-check --no-input "python-jobspy==<pin>" "pyinstaller==<pin>"
          python -m PyInstaller --noconfirm --clean --onefile --collect-all tls_client \
            --name jat12-discovery --distpath app/build/discovery app/src/main/sources/jobspy_worker.py
      - name: Configure Windows code-signing (only when a cert secret exists)
        if: matrix.os == 'windows-latest'
        shell: bash
        env: { SIGN_CERT: '${{ secrets.CSC_LINK }}', SIGN_PASS: '${{ secrets.CSC_KEY_PASSWORD }}' }
        run: |    # NEVER export empty CSC_LINK — electron-builder treats '' as a cert path and fails (v11 lesson)
          if [ -n "$SIGN_CERT" ]; then echo "CSC_LINK=$SIGN_CERT" >> "$GITHUB_ENV"; echo "CSC_KEY_PASSWORD=$SIGN_PASS" >> "$GITHUB_ENV"; fi
      - name: Build installer
        working-directory: app
        run: npx electron-builder --publish never
        env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}', CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
      - name: Pack extension zip (once, on Windows leg)
        if: matrix.os == 'windows-latest'
        run: npm run pack:extension
      - uses: actions/upload-artifact@v4
        with: { name: 'jat12-${{ matrix.label }}', path: 'app/dist/${{ matrix.artifact }}\napp/dist/latest*.yml\napp/dist/*.blockmap\ndist/jat12-extension-*.zip', if-no-files-found: error }
  release:
    needs: build
    if: always() && startsWith(github.ref, 'refs/tags/')   # publish even if mac/linux legs failed (v11 pattern)
    runs-on: ubuntu-latest
    steps:
      # download artifacts (continue-on-error), stage JAT12-setup.exe + latest.yml + blockmap +
      # jat12-extension-v*.zip + optional dmg/AppImage, SHA256SUMS.txt, then softprops/action-gh-release@v2
      # with generate_release_notes: true, fail_on_unmatched_files: false
```

Operator truth documented in `docs/RELEASING.md` (v11 lesson): the run's **overall** conclusion may show red when mac/linux legs fail — verify `build (windows-latest)` + `release` jobs green, and that the release contains `JAT12-setup.exe` + `latest.yml`. A release object **without an installer must never exist** — `if-no-files-found: error` on upload plus a final "assert release has latest.yml + .exe" step that deletes the release and fails loudly otherwise (the v11.31.0 empty-release failure gets an executable tombstone).

### 7.4 `adapters.yml` (adapter hot-channel)

```yaml
on:
  push:
    branches: [main]
    paths: ['adapters/**', 'shared/src/adapter-schema/**']
jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: node tools/validate-adapters.mjs
      - run: npm test -- tests/unit/adapter-interpreter tests/replay   # adapters must pass replay before promotion
      - name: Fast-forward adapters-stable
        run: |
          git tag -f adapters-stable HEAD
          git push -f origin adapters-stable
```

---

## 8. Extension packaging & delivery

Two channels, both first-class, neither blocking the other:

1. **Unpacked (Pierre, primary).** `extension/dist` loaded once via `chrome://extensions`; `npm run dev` keeps it built; changes need a manual reload which Mission Control makes visible via the `buildTime`/`PROTOCOL_VERSION` handshake (§5). This path has **zero external dependencies** — no token, no store, no review. Documented in `docs/EXTENSION-DEV.md`.
2. **Chrome Web Store Private (Dad, later).** Reuse the existing $5 publisher account (`pierresalama115@gmail.com`); create a **new listing** for v12 (new extension ID — pairing doesn't depend on the ID, proven by the v11 clean-machine audit). Upload `dist/jat12-extension-v<ver>.zip` from the GitHub release assets (every release carries it — §7.3 — so "which zip matches which app version" is never a question). Listing copy leads with **track + assist** (the CWS-rejection lesson). The CWS OAuth automation (`cws-publish`) may be ported, but **no release process step depends on it**: if the token has rotted, Dad's extension update waits; Pierre's never does. Token health (CWS + Gmail) surfaces in the app's Settings page per the pillar-6 design; this pillar only mandates that release tooling treats CWS as fire-and-forget.

Version skew policy: app auto-updates (electron-updater) while the CWS/unpacked extension lags → handled by the `PROTOCOL_VERSION` handshake, not by trying to keep them in lockstep. Breaking protocol changes are therefore MINOR releases with a release-note callout "reload/update the extension".

---

## 9. Adapter hot-update channel (D8)

- **Bundled**: `adapters/` is copied into the app's resources at build time (electron-builder `extraResources`) — the app always has a working offline set matching its build.
- **Hot**: on boot + every 6 h, the app fetches
  `https://raw.githubusercontent.com/PierreSalama/jat12-app/adapters-stable/adapters/index.json`
  (ETag-cached), compares `bundleVersion`, then fetches changed adapter files, verifies each against the `sha256` in the index, validates against the embedded adapter schema, and atomically swaps the in-memory set + persists to `userData/adapters-cache/`. Any verification failure → keep current set, log, surface a Settings badge.
- Why a **moving git tag + raw URL** instead of a GitHub release asset: a rolling release object in the same repo risks becoming `/releases/latest` and confusing electron-updater (or requires prerelease-flag discipline forever); a tag is invisible to the updater, free, versioned in git, and gated by `adapters.yml` (only CI-validated commits are ever tagged). Raw CDN staleness (~5 min) is irrelevant at adapter-fix timescales.
- Rollback of a bad adapter = `git tag -f adapters-stable <good-sha> && git push -f origin adapters-stable` (also wrapped in `tools/rollback.ps1 -AdaptersOnly`); clients pick it up within 6 h or immediately via Settings → "Refresh adapters".
- Schema evolution: `adapter.schema.json` carries `schemaVersion`; the app refuses adapters with a **newer** schemaVersion than it understands (old app + new adapter = keep bundled set) — hot updates can therefore never require a code update to be safe.

---

## 10. Release process

### 10.1 `tools/release.ps1` (thin — compare v11's mirror-heavy one)

```
.\tools\release.ps1 -Version 12.1.0 -Message "adapter hot-updates" [-NoPush]
```

1. Assert clean git tree on `main`, up to date with origin.
2. Assert `-Version` matches `^12\.\d+\.\d+$` and is greater than the latest `v12.*` tag.
3. Write version to root `package.json`; run `tools/stamp-version.mjs` (app/package.json + manifest).
4. Run `npm run gates && npm run build && npm test` locally (fail fast before tagging — CI re-runs everything anyway).
5. Run `tools/dump-schema.mjs` → commit `tests/fixtures/schemas/v<user_version>.sql` if the schema changed this release.
6. Print the **release checklist** and require interactive confirmation:
   - [ ] canaries green ≤ 7 days for all 4 sources (auto-checked by scanning `tests/canary-runs/`) — required if driver/protocol/adapters changed since last tag;
   - [ ] CHANGELOG entry written;
   - [ ] no open `needs-you` items depending on current behavior (Dad-trial rule: is anyone mid-run on auto-update?).
7. Commit `release: v12.x.y`, tag `v12.x.y`, push HEAD + tag (skipped with `-NoPush`).
8. Poll the Actions run; on completion verify via API that the release has `JAT12-setup.exe` + `latest.yml` + `jat12-extension-v12.x.y.zip`; print the release URL.

No robocopy. No mirror. No second repo. Steps 1–2 + the single-source version stamp are what structurally retire the deploy-divergence memory.

### 10.2 What auto-updates when

- App: electron-updater (GitHub provider → `jat12-app` `/releases/latest`) — every installed client, minutes after publish. This is why step 6's "is anyone mid-run" check exists.
- Extension: unpacked = manual reload (Pierre); CWS = store pipeline (Dad, days).
- Adapters: `adapters-stable` tag, decoupled entirely (§9).

---

## 11. Rollback story (D10)

`docs/ROLLBACK.md`, automated by `tools/rollback.ps1`:

**App (bad release v12.x.y):**
1. `gh release edit v12.x.y --draft` — instantly removes it from `/releases/latest`; clients that haven't updated never will.
2. For clients already updated (electron-updater **never downgrades** — semver compare): `tools/rollback.ps1 -To <last-good-tag>` checks out the last-good commit onto a `rollback/v12.x.z` branch, stamps version `12.x.(y+1)`, tags, pushes → CI ships the old code as a **newer** version. Wall time ≈ one CI run (~15 min).
3. If the bad release also migrated the DB: the app created `userData/backups/jat12-pre-<ver>.db.bak` before migrating (integration-tested, §6.2). The re-shipped old code either understands the new `user_version` (pure-additive migration — the default policy: migrations must be additive within a MINOR series) or, for a destructive migration, `docs/ROLLBACK.md` documents restoring the `.bak` manually. Destructive migrations therefore require a MAJOR-style call-out in the PR and the checklist.

**Extension:** unpacked = `git checkout <good>` + rebuild + reload. CWS = upload the previous release's `jat12-extension-*.zip` asset (kept forever on release objects).

**Adapters:** re-point `adapters-stable` (§9) — the fastest rollback in the system, by design, because adapters change most often.

---

## 12. v11 → v12 cutover runbook (`docs/CUTOVER.md`)

Pre-conditions: v12 ≥ 12.0.0 installed (or `npm run dev` for Pierre), all four canaries green, importer integration tests green, `test:import:real` green on this machine.

**Phase 0 — Freeze v11 (reversible).**
1. In v11: toggle auto-apply OFF; wait for `/auto-apply/live` to show zero active/scheduled; note the last-apply timestamp.
2. Quit v11 from the tray; verify: `Get-NetTCPConnection -LocalPort 7744` → none; no `Job Application Tracker` process; **no `%APPDATA%\jat11-app\jat.db.lock` directory** (a leftover lock dir means a dirty shutdown — resolve per v11 TROUBLESHOOTING before copying).
3. Copy `%APPDATA%\jat11-app\jat.db` → `%APPDATA%\jat12-app\import\jat11-snapshot-<date>.db`. The original is never opened for write by anything v12.

**Phase 1 — Import.**
4. Run the importer (app onboarding wizard "Import from v11", or `node tools/import-v11.mjs --db <snapshot> --into %APPDATA%\jat12-app\jat12.db`). It runs `--dry-run` first and prints the count table.
5. **Verify counts** — the importer's verifier reads expected values from the *source* snapshot and asserts the destination matches, row-for-row by category: jobs (expected live values at design time: 4,153; 483 submitted; status distribution preserved), documents (82, blob hashes equal), profile_fields (1,614) and qa (2,314) **with profile_id FK relationships intact** (per-profile scoping is the invariant, not just totals), emails (497), application-event timeline (ordering + timestamps preserved). Any mismatch → the importer aborts and rolls back its transaction; v11 remains untouched and restartable.
6. Spot-check in the v12 UI: open 3 known applications end-to-end (timeline, documents, answers).

**Phase 2 — Switch drivers.**
7. Chrome: disable (not remove) the v11 extension; load/enable the v12 extension; pair with the v12 app (consent click).
8. Run one live canary per source from the v12 app.
9. Enable v12 auto-apply with conservative caps for 48 h; watch Mission Control.

**Phase 3 — Park v11 (2-week safety window).**
10. Remove v11 from Startup; keep it installed. Rule during the window: if v11 must be relaunched (rollback), first disable v12 auto-apply — **two drivers never run concurrently** (the v11.46 freeze class).
11. After 2 clean weeks: uninstall v11 app, remove the v11 extension, archive `jat11-snapshot-<date>.db` to cold storage. Do **not** delete `%APPDATA%\jat11-app` until then.

**Dad's machine variant:** same phases via UI only — install v12 from the GitHub release, onboarding wizard detects `%APPDATA%\jat11-app\jat.db`, walks the freeze-check (refuses to import while port 7744 is alive), imports his own DB, verifies counts on-screen, then instructs the extension swap (CWS link once the v12 listing exists; until then Pierre assists with unpacked). No step requires a terminal.

---

## 13. Interlocks with other pillars (contract, not ownership)

- **Pillar 1 (protocol):** must expose `PROTOCOL_VERSION` + `buildTime` in the extension hello; must define the transport as an interface implementable by `FakeTransport`; must make snapshots/commands JSON-serializable (transcript recording depends on it).
- **Pillar 3 (adapter DSL):** interpreter must be a pure function of `(adapter, snapshot)` (unit tier depends on it); schema lives in `shared/adapter-schema` with `schemaVersion`.
- **Pillar 4 (driver):** every apply attempt records `appVersion` + `bundleVersion` + transcript reference (canary + replay capture depend on it).
- **Pillar 5 (DB/importer):** migrations forward-only + additive-within-MINOR; `user_version` discipline; importer exposes the count-verifier used by both `test:import:real` and the cutover wizard.
- **Pillar 6 (UI):** Mission Control shows protocol-skew banner, adapter bundleVersion + refresh button, token-health (Gmail/CWS) with one-click re-auth.

---

## 14. Open questions

1. **Playwright + MV3 headless on CI**: `--headless=new` extension support has been version-sensitive; the design ships the xvfb fallback, but someone should pin the working Playwright/Chromium pair during Phase-0 implementation and record it in `docs/EXTENSION-DEV.md`.
2. **Repo name**: `jat12-app` assumed (matches the reserved userData name); Pierre may prefer `JAT12` or keeping the `Job-ext-app` naming family — cosmetic, but must be fixed before D1 executes since the updater feed URL bakes into the first installer.
3. **Signed adapters**: §9 relies on HTTPS + sha256-in-index from Pierre's own repo. If the threat model ever includes a compromised GitHub account pushing malicious adapters to Dad, add ed25519 signing (public key baked into the app). Deferred as over-engineering for a two-user system — confirm.
4. **jobspy pinning**: release.yml pins `python-jobspy` + `pyinstaller`; the v11 pins (1.1.82 / 6.14.2) are 6+ months old — Pillar 4/discovery should confirm the v12 pins at implementation.
5. **Coverage thresholds**: deliberately none at 12.0 (see §6.0); decide at 12.1 whether to gate.
