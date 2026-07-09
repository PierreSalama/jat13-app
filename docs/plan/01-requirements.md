# JAT v12 — Pillar 1: Postmortem → Requirements

**Status:** Draft for architect review
**Author:** Pillar-1 design agent, 2026-07-07
**Evidence base:** `.v11-publish` source tree (v11.86 lineage), 16 distilled memory files under `C:\Users\pierr\.claude\projects\F--GITHUB-Perosnal\memory\`, vault notes `Chats/2026-07-03 — jat-v12-aurora-sibling.md` and `Decisions/2026-07-03 — jat-v12-sibling-coexistence-architecture.md`, 12-agent per-source capability audit (2026-07-01), live-DB postmortems v11.45→v11.86.

This is THE definitive requirements document for JAT v12. Every requirement is numbered, traced to the v11 production failure that motivated it, and carries acceptance criteria concrete enough to write the test first. Requirement IDs are stable — downstream pillar docs (architecture, protocol, adapters, UI) MUST reference them.

**Keyword convention:** MUST / MUST NOT are hard requirements (release-blocking). SHOULD is expected unless a documented tradeoff exists. Requirement classes:

| Prefix | Class |
|---|---|
| `R` | Failure-mode requirements — v11 broke in production this way; v12 makes it structurally impossible |
| `F` | Functional requirements — the locked launch scope |
| `N` | Non-functional requirements — throughput, latency, reliability, observability, security |
| `NG` | Explicit non-goals — things v12 deliberately does not do |

---

## 0. Locked user decisions (context, not negotiable)

1. **Apply driver:** thin Chrome MV3 extension = hands/eyes only (DOM snapshot up, click/fill/scroll commands down). ALL intelligence — state machines, adapters, answers, pacing — lives in the desktop Electron app ("app brain").
2. **Launch sources:** LinkedIn Easy Apply + Indeed (smartapply) + direct-ATS boards (Greenhouse / Lever / Ashby via their public JSON APIs), all from day one.
3. **UI:** full "Aurora" experience at launch — deep-space WebGL galaxy background, glass panels, 6 themes, animated canvas analytics, command palette, Mission Control, goals/streaks. (Aurora v1 code was lost in a disk restore; the design decisions survive in the vault. Identity reserved: port **7845**, userData **jat12-app**, hotkey **Ctrl+Shift+K**, protocol **jat12://**, header **X-JAT12-Token**.)
4. **Screening answers:** profile-first (learned memory) with cloud-AI fallback; every answer saved back so each question is asked **once ever** per profile.

---

## 1. Glossary (names used consistently across all v12 pillar docs)

| Term | Definition |
|---|---|
| **app brain** | The Electron main-process backend: scheduler, adapters engine, DB, answer ladder, discovery lanes, HTTP+SSE API on 127.0.0.1:7845 |
| **actuator** | The MV3 extension: content script (sensor/actuator) + minimal service worker (tab lifecycle relay). Holds no apply logic, no state machine |
| **apply run** | One attempt to submit one job. Owns a persisted state-machine record (`apply_runs` table) in the app DB |
| **step** | One node in an apply run's step graph (e.g. `open`, `ground_form`, `fill`, `answer_screening`, `advance`, `review`, `submit`, `verify`) |
| **snapshot** | The structured DOM digest the actuator sends up: candidate form roots, fields (with grounded labels), buttons (normalized labels + enabled/disabled), URL, page signals (captcha widget, login wall, confirmation copy) |
| **command** | An idempotent instruction sent down to the actuator: `click`, `fill`, `select`, `upload`, `scroll`, `navigate`, `snapshot`, each with a `commandId` |
| **site adapter** | A declarative data recipe (JSON) that parameterizes the generic driver for one host/flow: selectors, label patterns, step graph, park rules. Hot-updatable, never code |
| **supply lane** | One discovery source's independent pipeline: its own tick timer, refill gate, freshness state, and stats bucket. Lanes: `linkedin`, `indeed`, `ats-greenhouse`, `ats-lever`, `ats-ashby` |
| **slot** | A unit of apply concurrency, tracked **only** as in-flight `apply_runs` rows in the app DB (state `dispatched` or `running`) — never as open tabs |
| **park** | An honest terminal-for-now outcome that needs a human: `needs_answer`, `captcha`, `login_required`, `resume_required`, `account_walled`, `awaiting_review` |
| **evidence** | Structured proof attached to a run outcome: final URL, confirmation text match, screenshot-free DOM excerpt, step timings |
| **needs-you queue** | The UI surface listing all parked runs with one-click resolution |

---

## 2. Failure-mode requirements (R-series)

Each entry: the v11 failure (with evidence), the requirement, and acceptance criteria written as executable test descriptions.

### 2.1 Brain-in-content-script → App-owned state machine

**v11 evidence.** `extension/content/executor.js` (~4k lines) holds the entire apply state machine in the page. MV3 kills it constantly: service-worker eviction after ~30s idle wiped `discoverIdx` (discovery only ever searched combo #0 of 84 — the 2026-06-15 zero-submits bug C), reset learned concurrency to 1, rejected in-flight message channels ("A listener indicated an asynchronous response… but the message channel closed" — the v11.72 captcha-handoff crash), and back/forward-cache stole message ports mid-run. Every page death was a full restart, misclassified as a job failure.

- **R1 — All apply state persists in the app.** The complete state of every apply run (current step, filled fields, pending questions, answers given, retry counts, evidence so far) MUST live in the app DB (`apply_runs` + `apply_run_steps` tables), updated transactionally at every step boundary. The actuator MUST NOT hold any state the app cannot reconstruct.
  *Acceptance:* `AT-R1` — start an apply run on a 4-step LinkedIn fixture; at step 3, `chrome.runtime.reload()` the extension (hard-kill the SW and content script). Assert the app's run record still shows step 3 state, and after the actuator reconnects the run **resumes at step 3 within 5 seconds** (no re-click of the Easy Apply opener, no restart from step 1) and completes to `submitted`.
- **R2 — Snapshot-up / command-down protocol, versioned and idempotent.** The actuator↔app protocol MUST consist only of (a) snapshots and page events flowing up, (b) commands flowing down. Every command carries a `commandId`; the actuator MUST deduplicate re-sent commands (an ack lost to a dying port MUST NOT cause a double click). Protocol messages carry a `protocolVersion`; the app MUST refuse to drive an actuator with a mismatched major version and surface it in the UI (see R30).
  *Acceptance:* `AT-R2a` — send the same `click` command twice with one `commandId`; assert exactly one DOM click fires. `AT-R2b` — drop the ack of a `fill` command, let the app retry; assert the field value is set once and the run advances.
- **R3 — Transport survives every MV3 death mode.** The actuator's transport MUST reconnect automatically after SW eviction, content-script reinjection, tab navigation, and BFCache restore, and MUST resync by asking the app "what run/step owns this tab?" rather than assuming local memory. Long human waits (captcha) MUST NOT depend on a live message channel (poll or reconnect, never a held-open port — the v11.72 lesson).
  *Acceptance:* `AT-R3` — during a run, (i) idle the SW past eviction, (ii) navigate the tab and BFCache-restore it, (iii) reinject the content script. After each, assert the run resumes without a `failed` record and without a duplicate opener click. `AT-R3b` — simulate a 4-minute human wait with the SW asleep; assert no unhandled rejection and the run resumes on solve (v11.72 regression test).
- **R4 — A page death is a resume, not a failure.** Terminal classification MUST distinguish `transport_lost` (auto-resume, not user-visible) from real apply failures. A run MUST only be marked `failed` by the app brain after resume attempts are exhausted (default 3 within 10 min).
  *Acceptance:* `AT-R4` — kill the apply tab mid-run; assert the run enters `resuming`, a fresh tab is opened to the persisted step URL, and no `failed`/toast is emitted on first death.

### 2.2 Heuristic accretion → Site adapters as data

**v11 evidence.** Every LinkedIn DOM change required shipping code: modal→full-page `/apply/` (v11.27 — three prior releases chased a wrong occlusion theory), 0×0 hidden radios (v11.56), smartapply naked radios with `q_<hex>` names (v11.66), anchored `/^continue$/i` missing "Loading...Continue" (v11.86), and most recently "Easy Apply form disappeared after advancing" ×155 in 4h — a form-root tracking break. Each fix = an extension reload or CWS publish (blocked repeatedly by token rot, see R29/R30).

- **R5 — Site adapters are declarative data, not code.** Per-site behavior (apply-opener selectors, form-root derivation hints, field-label patterns, advance/submit button labels, step graphs, park rules, confirmation signals, honeypot markers) MUST be expressed in versioned JSON adapter recipes stored in the app DB and interpreted by ONE generic driver. Shipping a new/updated adapter MUST NOT require an extension republish, an app release, or a restart.
  *Acceptance:* `AT-R5` — with the app running, insert an adapter update via `PUT /adapters/:id` that changes a submit-button label pattern; assert the very next apply run uses it (no restart), and `chrome://extensions` shows no reload.
  *Schema sketch (normative names, full schema in Pillar-Adapters doc):*
  ```json
  {
    "adapterId": "linkedin-easyapply",
    "version": 12,
    "hosts": ["www.linkedin.com"],
    "flows": [{
      "flowId": "fullpage-apply",
      "match": { "urlPattern": "/jobs/(view|collections)/.*/apply" },
      "formRoot": { "strategy": "walk-up-from-advance-button", "fieldAware": true, "radioAware": true },
      "advance": { "labels": ["next", "review", "continue"], "final": ["submit application"] },
      "stepGraph": ["ground", "fill", "screening", "advance*", "review", "submit", "verify"],
      "confirm": { "signals": ["applicationSentCopy", "urlChange"] },
      "park": [{ "when": "captchaWidget", "as": "captcha" }]
    }]
  }
  ```
- **R6 — Adapter versioning, provenance, rollback.** Every adapter change MUST record `version`, `updatedAt`, `source` (`bundled` | `hot-update` | `learned` | `manual`), and the previous version MUST be restorable with one API call (`POST /adapters/:id/rollback`). A bad hot-update MUST be revertible without data loss.
  *Acceptance:* `AT-R6` — apply an update, roll back, assert byte-identical recipe to the prior version and the run engine picks it up on the next run.
- **R7 — Label normalization at one choke point.** The generic driver MUST extract and normalize ALL button/field labels through a single function (v12 name: `normalizeLabel()`), which strips loading-state prefixes ("Loading…"), collapses duplicated accessible text, folds accents, and lowercases — BEFORE any adapter pattern matching. Adapter label patterns MUST match against normalized labels only. A **disabled** advance button whose normalized label matches MUST be treated as *present-and-hydrating* (short re-poll, default cap 12s), never as *absent* (v11.86: the blind 30s wait × serial was the throughput killer).
  *Acceptance:* `AT-R7` — fixture button labeled "Loading...Continue", disabled: assert the driver reports `advance: present, waiting`, re-polls, and clicks within 1s of the button enabling; total stall ≤ 12s if it never enables.
- **R8 — Radio-aware, visibility-honest field grounding is a driver primitive.** Form grounding MUST count radio/checkbox groups by their visible affordance (styled labels) even when the native inputs are 0×0/opacity:0 (v11.56 LinkedIn, v11.62 smartapply), and MUST resolve group prompts via a generic resolver (aria-labelledby → smallest-group-container → preceding-sibling walk-up) with a guard that an option value / `q_<hex>` / uuid is NEVER used as the question text (v11.66 "yes yes q_<hex>"). This is generic driver behavior, available to every adapter, not per-site code.
  *Acceptance:* `AT-R8a` — radios-only page with hidden inputs grounds a form root (not `root=none`) and answers both radios. `AT-R8b` — naked smartapply-style radios: resolved prompt matches the visible heading; the dirty fallback label never reaches the answer ladder.
- **R9 — Form-root continuity across step advances.** After every advance, the driver MUST re-derive the form root from the CURRENT DOM (per the adapter's `formRoot` strategy) and reconcile with the persisted step state; a root that "disappeared" triggers re-derivation + snapshot diff, not an immediate failure (the ×155 "Easy Apply form disappeared after advancing" break class). Three consecutive re-derivation failures on the same step → capture + park (R10), never a silent retry loop.
  *Acceptance:* `AT-R9` — fixture that swaps the form container element identity between steps 2 and 3; assert the run advances to submit. Mutation-test: remove the root entirely; assert exactly one capture+park after 3 re-derivations, zero "repeated page-level action" loops.
- **R10 — Unknown pages degrade to capture + park + learn.** When no adapter flow matches, or grounding fails per R9, the driver MUST (a) capture a sanitized structural snapshot (tag/attr/label skeleton — NO field values, NO secrets; see N23), (b) park the run as `needs_adapter` with the snapshot attached as evidence, (c) queue it in an "adapter inbox" UI so a recipe can be authored/learned from the real DOM. It MUST NOT blind-retry.
  *Acceptance:* `AT-R10` — point a run at a fixture with an unknown ATS; assert one `needs_adapter` park with a snapshot ≥ the form's field skeleton, zero retries, and the snapshot contains no input values.

### 2.3 Slot/pacing bugs → One scheduler, app-side slots, no focus wars

**v11 evidence.** v11.84: the serial warm reuse-tab was counted as a busy slot → the pump waited for the 8-min tab reaper → ~9-min gaps between 40-second applies (2h = 14 applies). v11.45: parallel apply windows + front-to-hydrate fought for OS foreground and **froze Pierre's entire machine, mouse locked, ~7 minutes** — serial was force-clamped for weeks (v11.46 `parallelApplySafe` kill-switch) until the v11.78 single-focus arbiter. Pacing knobs were scattered (server gap gate, client pump, per-site caps, stale deep-merged user config silently overriding new defaults for months — v11.13).

- **R11 — Busy slots are in-flight runs in the app DB, ONLY.** Concurrency accounting MUST count `apply_runs` in state `dispatched`/`running`. Open tabs, warm reuse tabs, discovery tabs, and windows MUST NOT enter slot math anywhere.
  *Acceptance:* `AT-R11` — with concurrency 1 and a warm tab held open after a finished run, enqueue a new job; assert dispatch begins within 5s (not after any tab age-out). Source-level gate: a validator (`tools/validate.mjs` pattern from v11) MUST fail the build if tab enumeration feeds the scheduler's slot count.
- **R12 — Stranded in-flight rows self-heal fast.** A run in `dispatched` with no actuator heartbeat MUST be reclaimed within 2 minutes; `running` with no step progress within 8 minutes (configurable `scheduler.reclaim.dispatchedSec=120`, `runningSec=480`). Reclaim = resume per R4, then park honest.
  *Acceptance:* `AT-R12` — dispatch, then kill the actuator before first heartbeat; assert the slot frees and the next run dispatches ≤ 2 min later.
- **R13 — No apply path may ever require OS window focus.** The driver MUST operate on visible-but-unfocused tabs (dedicated background window, `chrome.windows.create({focused:false})`, apply tab `active:true` within that window — the proven v11 final architecture). Any code path that fronts a window MUST route through a single-focus arbiter granting at most one front per 1.5s and MUST exist only for explicit human handoffs (captcha, needs-you click) — never for hydration. `frontToHydrate`-class mechanisms MUST NOT exist.
  *Acceptance:* `AT-R13a` — unit: 6 simulated windows requesting front simultaneously → exactly 1 grant (port of v11 `focus-arbiter.test.mjs`). `AT-R13b` — source gate: any `chrome.windows.update({focused:true})` outside the arbiter module fails the build. `AT-R13c` — a full LinkedIn fixture run completes with the apply window never focused (assert focus-change event count for the apply window = 0).
- **R14 — Parallelism defaults off and never multiplies past per-account caps.** Default `concurrency=1` serial. Parallel (max one worker per SOURCE, `perSiteConcurrency=1`) is opt-in behind a settings flag and the R13 arbiter. The UI MUST state that LinkedIn's ~50/24h Easy-Apply cap is per-account and parallel workers cannot stack past it.
  *Acceptance:* `AT-R14` — enable concurrency 3 with only LinkedIn enabled; assert effective LinkedIn workers = 1 and the daily-cap projection shown in the UI does not scale with concurrency.
- **R15 — ALL pacing and caps live in one scheduler module.** Rate limits (per-hour, per-day, per-source rolling caps, inter-apply gaps, host cooldown breakers) MUST be enforced in exactly one app module (`scheduler/pacing.js`); the actuator and UI MUST NOT contain any pacing logic. LinkedIn Easy-Apply pacing MUST implement a **rolling 24h window budget of 50 per account** (config `pacing.linkedin.rolling24h=50`) with front-load smoothing (SHOULD spread, MUST hard-stop at the cap). Gap pacing MUST be start-based (finish-based stalls serial loops — v11.12 lesson).
  *Acceptance:* `AT-R15a` — simulate 50 submits in 20h; assert the 51st LinkedIn dispatch is deferred with reason `account_cap` until the window frees. `AT-R15b` — grep-gate: no `maxPerHour`/gap math outside `scheduler/pacing.js`. `AT-R15c` — config migration test: upgrading defaults MUST version pacing config explicitly (`pacingConfigVersion`) so stale user overrides do not silently pin old values forever (v11.13 deep-merge bug); user-customized values are kept but flagged in the UI as "custom, default changed".
- **R16 — Warm-tab reuse is a transport optimization, invisible to the scheduler.** Keeping one warm tab per lane (for Cloudflare `cf_clearance` continuity — v11.74) MUST be handled entirely in the actuator's tab manager; the scheduler MUST NOT know tabs exist.
  *Acceptance:* covered by `AT-R11`; additionally `AT-R16` — two consecutive Indeed runs reuse one tab (navigate, not create+close) and the second dispatches immediately after the first finishes.

### 2.4 Discovery starvation + telemetry churn → Per-source lanes, yield-only telemetry

**v11 evidence.** v11.83: the shared refill gate (`queue ≥ refillBelow(20)` → skip jobspy scrape) let the slow ATS feed keep the queue "full" of un-appliable-fast jobs, starving LinkedIn discovery: 30/hr → 1.6/hr over a 20h run, jobspy ran 3× in 24h. v11.85: the ATS feed wrote one `discovery_batches` row + one SSE broadcast per token per scan **even for empty scans** — 16,256 batches / 32,040 provenance rows for ~35 jobs, 12.8k junk rows/day, DB 74MB, every broadcast re-pulled a 2.95MB /queue → app-wide lag. v11.58/67: static 72h freshness window saturated combos forever; the ramp then climbed too slowly (73/110 combos stuck).

- **R17 — Every discovery source is an independent supply lane.** Each lane (`linkedin`, `indeed`, `ats-greenhouse`, `ats-lever`, `ats-ashby`) MUST own its tick timer, its refill gate computed over **its own** queued-job count, its freshness state, and its stats bucket. No shared gate; no lane's backlog may gate another lane's scan.
  *Acceptance:* `AT-R17` — fill the queue with 500 ATS-lane jobs, empty LinkedIn lane; assert the LinkedIn lane scans on its next tick (gate reads linkedin-queued = 0). Regression fixture named `ats-starves-linkedin` (the v11.83 scenario).
- **R18 — Telemetry rows only on yield.** A discovery-batch row (and its SSE event) MUST be written only when a scan **found jobs, was rate-limited, or errored**. Empty/dedup-only scans write nothing — no row, no provenance, no broadcast. Scan liveness is exposed via an in-memory `GET /discovery/lanes` status (lastScanAt, lastYieldAt per lane), not via rows.
  *Acceptance:* `AT-R18` — run 100 empty scans; assert `discovery_batches` row count delta = 0 and SSE event count = 0; `GET /discovery/lanes` still shows fresh `lastScanAt`.
- **R19 — Retention and pruning are designed in from day one.** A `maintenance()` job (launch + every 6h) MUST enforce config-versioned retention: discovery batches/provenance 5d, terminal run transcripts 3d (32KB on-write cap), ai_log 7d, application events 90d, VACUUM every 3d. `GET /health` MUST report DB size; crossing `db.sizeWarnMB=100` surfaces a UI warning.
  *Acceptance:* `AT-R19` — seed an aged dataset; run maintenance; assert each class pruned to its window and DB file shrank post-VACUUM.
- **R20 — Per-combo freshness ramp with saturation jump.** Discovery combos (source×keyword×location) MUST track per-combo freshness state; a saturated combo (previously scanned, no NEW accept in >6h) JUMPS to the widest window (30d) on its next visit; brand-new combos start at 72h; productive combos ramp gradually. The full combo space MUST be cycled (persisted cursor — never in-memory; v11 lost it to SW eviction, but in v12 the cursor lives in the app DB anyway per R1).
  *Acceptance:* `AT-R20` — mark a combo saturated; assert its next scan requests the 30d window. Cursor test: restart the app mid-cycle; assert the next scan resumes at combo N+1, not 0.
- **R21 — ATS board discovery has positive keyword AND location gates.** The GH/Lever/Ashby JSON feeds return every role worldwide; ingestion MUST pass a keyword gate and a location gate (user-country-local + generic-remote kept; foreign-locked dropped) before a job enters the queue. Gate outcomes MUST be counted per-lane (found → keywordPass → locationPass → accepted) so supply is diagnosable (v11.81's 14,550 → 1,976 → 155 → 47 funnel MUST be reproducible from stats).
  *Acceptance:* `AT-R21` — feed a fixture board response with SF/Bengaluru/Toronto/remote-Canada roles for a Canada user; assert only the latter two ingest and the funnel counters match.
- **R22 — Discovery runs alongside applies and self-heals supply.** Lanes MUST scan while applies are in flight (self-gated on their own queue depth, per R17 — never gated on `activeCount===0`, the v11.12 starvation bug). On exhaustion (found>0, enqueued=0 across a full combo cycle) the lane MUST trigger retry-stale (re-queue transient failed runs, attempts<3, job not submitted) and surface a "broaden your search" note.
  *Acceptance:* `AT-R22` — with one apply running, assert a lane tick fires on schedule; exhaustion fixture → retry-stale invoked once + UI note set.

### 2.5 DB engine → better-sqlite3, single writer

**v11 evidence.** node-sqlite3-wasm: mkdir-lock VFS invisible to native drivers, silently drops colliding writes, a crashed lock-holder leaves `jat.db.lock` bricking every subsequent launch, and dumps its entire minified source into logs on any throw. The 2026-07-03 sibling architecture had to route ALL shared access through v11's REST API purely to dodge this engine.

- **R23 — better-sqlite3, WAL mode, one writer.** v12's store is `%APPDATA%\jat12-app\jat12.db` opened with **better-sqlite3** in WAL mode by the Electron **main process only**. The renderer, the actuator, and any tool MUST access data exclusively through the app's HTTP API. No second process may open the DB file (a `PRAGMA application_id` + startup exclusive-open probe guards it).
  *Acceptance:* `AT-R23a` — build gate: `node-sqlite3-wasm` anywhere in the dependency tree fails validation; any `require`/`import` of better-sqlite3 outside `src/db/` fails a source gate. `AT-R23b` — crash the app mid-transaction (kill -9); relaunch; assert clean open (WAL recovery), no lock artifact, no data loss for committed transactions.
- **R24 — Migrations are forward-only, versioned, and backed up.** `user_version`-based migrations run in `db/migrations/`; before any migration the app MUST write a timestamped backup copy (`jat12.db.bak-<version>-<ts>`), and `wipe`/`import` operations MUST call `backupNow()` first and return the backup path (v11.14 data-safety pattern).
  *Acceptance:* `AT-R24` — run a migration on a seeded DB; assert backup exists and a deliberate mid-migration throw leaves the original restorable.

### 2.6 Payload bombs → Lean projections, targeted SSE

**v11 evidence.** v11.82: `/jobs` shipped 16MB (SELECT * incl. ~5MB descriptions), `/queue` 17MB (13.9MB transcript column across 3,194 tasks) on every SSE-triggered refetch; `/queue/parked` 1.62s and `/auto-apply/needs-you` 2.35s from N+1 per-question fuzzy full-scans. v11.68: the queue page rendered every transcript into hidden DOM (82 → 233,551 nodes in 60s → renderer OOM crashes dozens of times/day).

- **R25 — List endpoints return lean projections by default.** Every list endpoint (`GET /jobs`, `/runs`, `/queue`, `/emails`) MUST use an explicit column projection excluding heavy columns (description, transcript, evidence blobs, attachments, answers), MUST have a default limit (1000) and pagination, and MUST offer heavy data only via detail endpoints (`GET /jobs/:id`, `GET /runs/:id/transcript`). A `{full:true}` variant exists ONLY for `POST /export` (lossless backup).
  *Acceptance:* `AT-R25` — seed 5,000 jobs with 4KB descriptions; assert `GET /jobs` response < 500KB and < 150ms; `SELECT \*` against a list route fails a source gate.
- **R26 — SSE sends targeted patches, never "refetch everything".** Server-sent events MUST carry the changed entity (row-level patch: `{type:"run.updated", id, patch:{state,step,elapsed}}`) or a scoped invalidation (`{type:"jobs.page-dirty", page}`). The renderer MUST apply patches in place; a global refetch on SSE MUST NOT exist. Event fan-out MUST be coalesced (≤ 1 event per entity per 250ms).
  *Acceptance:* `AT-R26` — drive 100 run-state changes in 10s; assert renderer network transfer < 100KB total and zero full-list refetches (network log assertion).
- **R27 — Renderer DOM and heap budgets.** Transcripts and heavy detail render lazily on first open (capped 200 lines, "load more"); list virtualization above 200 rows. The app logs `usedJSHeapSize`/DOM-node-count/route every 60s to main.log (the v11.67 observability that caught the OOM in one crash).
  *Acceptance:* `AT-R27` — open the runs page with 3,000 runs; assert DOM nodes < 5,000 and heap growth < 20MB after 10 min idle on the page.

### 2.7 Cloudflare / human walls → Detect fast, park honest, never solve

**v11 evidence.** The 2026-07-04 overnight run: 27+ Cloudflare hits each waited 6 min for a sleeping human + spammed hundreds of AudioContext beep errors → 226 Indeed jobs touched, 0 submitted. v11.59: invisible-reCAPTCHA badge text false-positived every Indeed apply as `bot_challenge`. v11.73: the hard-cap killed the captcha tab mid-solve; notifications were suppressed by Focus Assist. Standing policy (Pierre + safety): never bypass bot detection.

- **R28 — NEVER auto-solve captcha/verification.** No code path may solve, click through, token-harvest, or otherwise bypass a captcha, Cloudflare challenge, or identity verification. This is a build-gated invariant (forbidden-pattern validator + adapter schema has no "solve" verb).
  *Acceptance:* `AT-R28` — adapter schema validation rejects any recipe containing an action on a challenge frame; source gate greps for known solver-service hosts.
- **R29 — Challenge detection requires a real widget or challenge copy.** A bare "reCAPTCHA"/"captcha" text marker MUST NOT trigger a park; detection requires a visible rendered widget (≥60×30, excluding `.grecaptcha-badge`/`[data-size=invisible]`) or explicit challenge copy ("verify you're human", "press and hold").
  *Acceptance:* `AT-R29` — fixture page with only the invisible-badge text applies to completion; fixture with a real interstitial parks as `captcha`.
- **R30 — Fast unattended probe, then honest park + cooldown.** On a detected challenge: ≤12s self-clear wait, then a **~30s user-presence probe** (input activity); if unattended → park `captcha` immediately (total unattended cost ≤ 60s, vs v11's 6 min), notify (R31), and trip a per-host cooldown breaker (default 30 min, exponential to 4h) that defers further dispatches to that host. If the user IS present, the wait may extend (default 6 min) with the run's hard-cap overridden by an `awaitingHuman` state so the tab is never reaped or the run never force-failed mid-solve (v11.73).
  *Acceptance:* `AT-R30a` — unattended fixture: park within 60s, breaker set, next same-host dispatch deferred with reason `host_cooldown`. `AT-R30b` — attended: simulate user input; assert the wait extends and a solved challenge resumes the run to submit. `AT-R30c` — during the wait, assert no reaper/hard-cap closes the tab.
- **R31 — Multi-channel, non-focus-stealing, non-spamming notify.** Human-needed alerts fire OS notification + taskbar flash (`drawAttention`) + toolbar badge + in-app needs-you counter — never a programmatic focus steal (R13), never an audio beep loop (audio MUST bail when AudioContext is suspended and is capped at 1 beep per park).
  *Acceptance:* `AT-R31` — 10 parks in a minute produce ≤ 10 notifications, 0 focus changes, ≤ 10 beep attempts with suspended-context bail verified.
- **R32 — Account-walled ATS park by design.** Workday, iCIMS, Taleo (and any adapter marked `account:"required"`) MUST park `account_walled` without ever looping the apply opener (the old 40× "Apply" bug), and MUST NOT create accounts (NG4). BambooHR-class flows fill everything then park `awaiting_review` at the captcha-gated submit.
  *Acceptance:* `AT-R32` — Workday fixture: exactly one opener click, one park, zero retries; BambooHR fixture: all fields filled, honeypot (`input[name^=nickname_]`) skipped, parked before submit.

### 2.8 Token/auth rot → Health surfaced, release paths token-independent

**v11 evidence.** Gmail OAuth and the CWS refresh token (unverified Google apps ≈ 7-day refresh-token life) silently expired repeatedly: email sync dead ("not authorized — connect Gmail in Settings") and extension publishing blocked 4+ sessions running (`invalid_grant`). Fixes shipped but undeliverable.

- **R33 — Token health is a first-class UI surface.** Every external credential (Gmail OAuth, optional CWS token, cloud-AI API key) MUST have a health record (lastSuccessAt, expiresAt-estimate, lastError) shown on a Settings "Connections" panel with a one-click re-auth button. A token failure MUST raise a needs-you item within one sync cycle — never fail silently.
  *Acceptance:* `AT-R33` — revoke the Gmail token in a test account; assert within one scheduled sync the UI shows "reconnect" and a needs-you entry exists; clicking re-auth completes the flow without touching config files.
- **R34 — Pierre's own machine never depends on a rot-prone token to get code.** The primary extension delivery for the dev machine is **unpacked load from the working tree**, documented and version-handshaked: the app's `GET /health` response includes `extensionVersion` (reported by the actuator on connect) and the UI warns on app↔extension version skew (the v11.71 "testing an old extension" gotcha). CWS private-listing publishing remains a secondary path for Dad-class users.
  *Acceptance:* `AT-R34` — connect an actuator with a stale `protocolVersion`/version; assert a persistent UI banner "extension vX behind app vY — reload it" and R2's refusal on major mismatch.
- **R35 — App auto-update never interrupts a run.** electron-updater idle-install gated on: mode `auto`, past grace, system idle ≥ 5 min, AND scheduler shows zero in-flight/scheduled runs and queue depth 0. A human "Later" opts out. Consecutive-version installs keep differential updates small.
  *Acceptance:* `AT-R35` — with one run in flight and the machine idle, a downloaded update MUST NOT install; with everything idle it installs within one timer cycle.

---

## 3. Functional requirements (F-series) — locked launch scope

### 3.1 Sources & apply capability

- **F1 — LinkedIn Easy Apply (volume lane).** Drive BOTH layouts: legacy modal (search/collections split-view) and full-page `/jobs/(view|collections)/<id>/apply` (URL-detected, root derived by walking up from the advance button — never class selectors, they rotate per session). Latch "form ever opened" on the `/apply/` URL so the opener is never re-clicked. External (non-Easy-Apply) LinkedIn postings fast-skip in easy-apply mode.
  *Acceptance:* fixtures `linkedin-modal`, `linkedin-fullpage`, `linkedin-eligibility` (radios-only), `linkedin-external-skip` all pass; per R5 all LinkedIn specifics live in the `linkedin-easyapply` adapter.
- **F2 — Indeed smartapply (marginal lane, human-adjacent).** Route Indeed-Apply widgets (no href, non-external label) to `smartapply.indeed.com` as an in-lane native flow (allowed in easy-apply mode); being on smartapply IS submit-grounding (post-apply URL `/beta/indeedapply/form/post-apply` = verified submit); disabled "Loading...Continue" handled per R7; Cloudflare per R28–R31; external company-site Indeed postings fast-skip; country-correct host (`ca.indeed.com` for Canada) in any browser-built search URL.
  *Acceptance:* fixtures `indeed-smartapply`, `-review` (direct-to-review), `-naked-radios`, `-loading-continue`, `-cloudflare`, `-external-skip` pass.
- **F3 — Direct ATS boards (the hands-off growth lane).** Greenhouse (`boards-api.greenhouse.io/v1/boards/{co}/jobs`), Lever (`api.lever.co/v0/postings/{co}?mode=json`), Ashby (`api.ashbyhq.com/posting-api/job-board/{co}`) discovery from a seeded, health-tracked company-token list (import the 113 live-verified tokens; dead tokens auto-demoted after N consecutive 404s); apply via adapters (Lever single page, Greenhouse label-mapped `#application-form`, Ashby React SPA container `.ashby-application-form-container` — no `<form>` element). No captcha, no login: these runs are fully unattended.
  *Acceptance:* `AT-F3` — one full sweep of a fixture token set reproduces the found→keyword→location→accepted funnel (R21); Lever/Greenhouse/Ashby apply fixtures submit end-to-end unattended.

### 3.2 Discovery

- **F4 — Three discovery mechanisms, per-lane (R17):** (a) jobspy python worker for LinkedIn/Indeed (with `easy_apply=true` under easy-apply mode; respect the Indeed one-of {hours_old, is_remote, easy_apply} constraint), (b) extension in-board f_AL scrape stamping `applyCapability:"easy-apply"`, (c) ATS board JSON feeds (F3). Dedup on ingest by canonical job URL + (title,company,location) fingerprint; discovery never re-queues jobs with an existing terminal/submitted state (retry-stale owns retries — R22).
- **F5 — Supply funnel observability.** `GET /discovery/lanes` returns per-lane: lastScanAt, lastYieldAt, current freshness tier, combo-cursor position, and 24h funnel counters (found/keywordPass/locationPass/accepted/duplicate/rejected). The dashboard shows a per-lane supply sparkline; "low applies" MUST be diagnosable as supply-vs-engine from the UI alone (the standing v11 debugging rule, now a feature).

### 3.3 Apply runs & verification

- **F6 — Run state machine (app-owned, R1).** States: `queued → dispatched → running → (submitted | parked(reason) | skipped(reason) | failed(reason))` plus `resuming` (R4). Every transition writes an `apply_run_steps` row: `{runId, step, startedAt, endedAt, outcome, evidence}`.
- **F7 — Submit verification (success-truth).** `submitted` requires positive evidence: confirmation copy match, post-apply URL, or adapter-declared confirm signal. Passive capture MUST NOT fire while a run drives the tab (v11 false-submit bug: the executor's own clicks triggered the passive detector). `awaiting_review` (unverified submit) is counted separately from `submitted`, never folded in.
  *Acceptance:* `AT-F7` — drive a fixture that opens the form but never completes; assert no `submitted` record from passive detection.
- **F8 — Per-source stats buckets.** Every run is attributed to its source lane; outcome/park-reason/route breakdowns are per-source (ATS sources never hide in "other").

### 3.4 Screening answers (profile-first, ask-once-ever)

- **F9 — The answer ladder (deterministic → memory → AI → park), in the app.** For each screening question: (1) **deterministic grounding** from structured profile (work authorization, sponsorship, ability-to-perform, referral="N/A"/No, notice period, salary-if-configured) — multilingual patterns (EN/FR/ES) as adapter-shared data; (2) **learned memory**: exact then fuzzy lookup against the per-profile `qa` store; (3) **cloud AI fallback** with `aiAnswerConfidenceMin` default **0.65**; numeric/range option matching ("6" → "5-10 years", never "16+"); (4) below-confidence or refused → park `needs_answer` with the question + options captured. Answers accepted at any rung are **saved back to per-profile memory immediately**, so each question is asked at most once ever per profile.
  *Acceptance:* `AT-F9a` — run a fixture with a work-auth radio: answered deterministically, never reaches AI. `AT-F9b` — park a question, answer it via the needs-you UI, re-run a job with the same question: answered from memory, zero AI calls. `AT-F9c` — AI at conf 0.5 parks; at 0.7 answers and records.
- **F10 — Per-profile memory scoping (never regress v11.10).** `profile_fields` and `qa` carry `profile_id` FK (`ON DELETE CASCADE`, `UNIQUE(profile_id, key_norm)` / `(profile_id, question_norm)`); every memory function requires a profileId (null → warn + no-op, never a global write); needs-you answers route into the memory of each profile that parked the question; profile↔memory bridges (fill-from-memory / push-to-memory) exist.
- **F11 — Sensitive-data hard guard.** EEO/demographic questions (race, gender, disability, veteran status, criminal history, SSN, DOB) are NEVER auto-answered from AI, never harvested into memory (a shared `SENSITIVE_RX` at snapshot-harvest AND a server-side backstop on every memory write/import). "Able to perform the duties with/without accommodation" is an ability screen (deterministic Yes), explicitly distinct from "do you have a disability / need an accommodation" (always parks).
  *Acceptance:* `AT-F11` — fixture with an EEO section: fields left untouched, nothing enters `qa`/`profile_fields`, run proceeds if optional / parks if required.
- **F12 — Cloud AI provider constraint.** The AI fallback uses an API key (Anthropic/OpenAI) or local Ollama — NEVER a consumer Claude/ChatGPT subscription session (server-side blocked; standing constraint). Provider health per R33. AI unavailability degrades gracefully: answer→park, cover-letter→skip, resume-parse→deterministic-only; no 500s.

### 3.5 Gmail status pipeline

- **F13 — Broad-by-default Gmail query** covering employer/ATS sender domains (greenhouse, lever, ashby, workday, icims, recruiters) + stage phrases, not just `jobs-noreply@linkedin.com`; mode-aware backfill caps (backfill ≤1200 ids over 30 days; incremental 300); sync every 15 min gated on app-background rules; watermark semantics that never advance past unfetched mail.
- **F14 — Classifier precedence with receipt guard:** offer / rejection → **strong-receipt confirmation** ("application was submitted successfully" + "copy of your application" pre-empts interview boilerplate) → assessment / interview → confirmation → other. Forward-only elevation on auto/manual-confidence matches; "suggested" matches require one-click user confirm. `POST /emails/reprocess` re-elevates the whole inbox. Ghosted sweep: still-`submitted` + no inbox response after 28d → `ghosted` (scheduled 6-hourly, gated on Gmail being connected). Email rows deep-link to Gmail (`rfc822msgid:`).
  *Acceptance:* `AT-F14` — classifier fixture set (CMiC receipt-with-interview-boilerplate, neutral-subject rejection, real invite) classifies per precedence; funnel moves on sync.

### 3.6 Aurora UI

- **F15 — Full Aurora at launch:** WebGL galaxy background (with a static-gradient fallback + reduced-motion toggle), glass panels, 6 themes, command palette (Ctrl+Shift+K), Mission Control (live runs: per-worker current step + elapsed, queue depth, session tally, effective rate + which cap binds), animated canvas analytics, goals/streaks. All pages obey R25–R27 budgets; the galaxy renderer MUST degrade (auto-pause when a run panel is busy or on battery) and MUST be OFF the apply-critical path (a renderer crash never touches the scheduler).
  *Acceptance:* `AT-F15` — kill the renderer process during 3 in-flight runs; assert all 3 complete and the reopened window reflects true state.
- **F16 — Needs-you queue as a primary surface:** every park lands here with question/options/evidence, one-click answer (writes memory per F9/F10), one-click open-tab for captcha/login parks, bulk-dismiss for `awaiting_review`. The standing habit ("clear the needs-you queue whenever auto-apply runs") becomes UI-affordant: a badge + Mission Control strip.
- **F17 — Adapter inbox (from R10):** parked `needs_adapter` snapshots listed with a structural preview; accepting a drafted recipe hot-installs it (R5/R6).

### 3.7 v11 data import (one-time, multi-user)

- **F18 — Importer contract.** `jat12 import --from "%APPDATA%\jat11-app\jat.db"` (also a first-run UI wizard): requires v11 **stopped** (probe: no `jat.db.lock` dir, no v11 process, health port 7744 dead — refuse otherwise), opens the file **read-only** via better-sqlite3, and maps: 4,153 jobs (statuses started/submitted/rejected preserved), 483 submitted with application-events timeline, 82 documents, 1,614 profile_fields + 2,314 qa **with profile_id scoping preserved** (v11 pre-v6 global rows → default profile), 497 emails + classifications. Idempotent (re-run = upsert by v11 row id kept in an `import_map` table), and machine-agnostic (Dad's jat.db imports the same way).
  *Acceptance:* `AT-F18` — import a copied production jat.db twice; assert counts match source exactly both times (no duplicates), per-profile memory isolation intact (spot-check a qa row's profile), and a refusal with a clear message when a `jat.db.lock` dir exists.
- **F19 — No live coexistence dependency.** v12 owns its own data after import. The v11-API live-bridge (the 2026-07-03 sibling architecture) is NOT a launch requirement; if a transition period needs both apps visible on the same data, that is a separate opt-in mode decided by the architect (see Open Questions).

### 3.8 Release & delivery

- **F20 — App releases:** dedicated GitHub repo (pattern of `PierreSalama/Job-ext-app`), `v12.*` tag → CI → Windows installer + latest.yml + SHA256SUMS → electron-updater. CI gates: version lockstep across manifest/app/root package.json (validator), unit + adapter-fixture harness green, and the test list defined in ONE place (package.json script; workflows invoke it — never a second hand-copied list, the v11.31 lost-installer bug). Partial-platform release allowed (Windows job green is the gate).
- **F21 — Extension delivery:** primary = unpacked from working tree with the R34 version handshake; secondary = CWS private listing (trusted-tester allowlist). Extension zips are reproducible from a tagged tree.

---

## 4. Non-functional requirements (N-series)

### 4.1 Throughput

- **N1** — LinkedIn lane sustains ≥ **25 applies/hr burst** (attempts dispatched) on fresh supply until the rolling 50/24h account cap binds; median inter-apply gap in serial mode ≤ **2 min** (the proven post-v11.84 number). *Test:* 3h fixture-supply soak at simulated apply duration 40s → ≥75 dispatches, median gap ≤2min.
- **N2** — ATS lane runs **continuously and unattended**: a 24h soak with only ATS supply completes every queued eligible job with zero human interactions and zero starvation of other lanes (R17).
- **N3** — A single wedged run (hung page, challenge wait) MUST NOT reduce other lanes' throughput: with lane A wedged, lane B's dispatch rate stays within 10% of baseline. (This kills the v11 "one 30s stall × serial = 4 applies/2h" class at the architecture level: per-lane workers.)
- **N4** — Honest ceiling messaging: the UI presents projected volume from measured per-source rates and caps (~80–140/day supervised, ~90% LinkedIn) — never a multiplied concurrency fantasy.

### 4.2 Latency & payload

- **N5** — Dashboard interaction (route change, panel open, filter) < **100ms** at p95 with 5,000 jobs / 3,000 runs seeded.
- **N6** — No dashboard HTTP response > **500KB**; list endpoints p95 < 150ms; detail endpoints p95 < 250ms (R25). Enforced by an integration test that seeds production-scale data and asserts `%{size_download}` on every registered route (the v11.82 curl playbook, automated).
- **N7** — SSE-driven UI updates apply within 500ms of the server event, with total renderer network transfer per event < 5KB (R26).

### 4.3 Reliability

- **N8** — The app remains fully usable during runs: with 2 lanes active, dashboard p95 stays within 2× idle p95 (single-writer contention budget; heavy writes batched/transactional).
- **N9** — Crash-safe by construction: kill -9 of the app at any moment loses at most the current step's in-flight transition; on relaunch every non-terminal run is resumed or honestly parked within 60s (R1/R12, WAL per R23).
- **N10** — The machine is never frozen or focus-stolen by JAT (R13). A whole-machine input lock is a P0 with a standing regression fixture (`AT-R13`).
- **N11** — 7-day unattended soak: DB growth < 30MB, zero unbounded table growth (R18/R19), zero renderer OOM (R27), memory RSS stable within 15%.

### 4.4 Observability ("observe first" as a product feature)

- **N12** — **Every apply run is a structured run record**: `apply_runs {id, jobId, source, adapterId+version, profileId, state, parkReason, startedAt, endedAt, evidence(json), tabMeta}` + `apply_run_steps {runId, seq, step, startedAt, endedAt, outcome, detail(json ≤32KB)}`. Step timings make "apply duration vs inter-apply gap" separable in one query (the v11.84 diagnostic, permanent).
- **N13** — Diagnostic endpoints: `GET /health` (versions, extensionVersion, DB size, token health), `GET /discovery/lanes` (F5), `GET /runs/live` (Mission Control feed), `GET /stats/breakdown?days=` (outcome × source × parkReason). All lean (N6).
- **N14** — Failure evidence is always captured: a `failed`/parked run stores the last snapshot digest + normalized-label set of visible buttons, sufficient to author an adapter fix without reproducing live (R10 sanitization applies).
- **N15** — Logs: structured (JSON lines) main.log with heap/DOM telemetry (R27); scheduler decisions (dispatch/defer + reason: gap, account_cap, host_cooldown, no_slot) logged at info. A "why is nothing applying?" panel surfaces the current binding constraint in plain language.

### 4.5 Security & privacy

- **N16** — No captcha/bot-wall solving, ever (R28). No stealth/fingerprint evasion.
- **N17** — No secrets in pages: the actuator never receives tokens, API keys, or profile data beyond the specific field values it is commanded to fill; the app API binds 127.0.0.1 only; auth via `X-JAT12-Token` issued through an explicit pairing-consent click (no silent grants).
- **N18** — No per-tenant/employer account creation (NG4); stored credentials for third-party sites are out of scope.
- **N19** — Sensitive-answer guard per F11 at every write path (harvest, import, needs-you intake).
- **N20** — Exports/backups are local files; no telemetry leaves the machine.

### 4.6 Maintainability & test infrastructure

- **N21** — The fixture harness is a launch deliverable: every adapter ships with DOM fixtures replaying its known variants (the v11 catalog ports over: `linkedin-eligibility`, `indeed-smartapply-naked-radios`, `indeed-cloudflare`, `ats-starves-linkedin`, …). A production incident's fix MUST land with a fixture that fails pre-fix (the observe-first doctrine, enforced in review).
- **N22** — Forbidden-pattern build gates (`tools/validate.mjs`): node-sqlite3-wasm, `SELECT *` on list routes, tab-count-as-slot, window-focus outside the arbiter, pacing outside the scheduler, solver hosts, adapter logic in extension code.
- **N23** — Snapshot sanitization is centrally implemented and unit-tested: captured DOM skeletons strip input values, emails, phone numbers before persistence.

---

## 5. Explicit non-goals (NG-series)

- **NG1 — No captcha/Cloudflare/verification solving or bypass.** Human-handoff only (R28–R30). Requests to "break through" are declined by policy.
- **NG2 — No Glassdoor.** Blocked scraping, no apply path, redirects elsewhere — a proven dead end (2/53 all-time). Not a source, not a board option.
- **NG3 — No Workday/iCIMS/Taleo driving.** Account walls; park-by-design (R32). At most a future sign-in-assist for a tenant the user already has — out of launch scope.
- **NG4 — No account creation on any employer/ATS/tenant**, ever.
- **NG5 — No parallel-window focus mechanics.** No front-to-hydrate, no multi-window foreground juggling; parallelism only within R13/R14's constraints.
- **NG6 — No consumer-subscription AI backends** (Anthropic/OpenAI block it server-side); API keys or local Ollama only (F12).
- **NG7 — No modification of v11.** v11 stays untouched and runnable; import is read-only with v11 stopped (F18). v12 never writes jat.db (v11's).
- **NG8 — No live v11↔v12 dual-writer data sharing at launch** (F19) — import supersedes the bridge unless the architect explicitly revives it.
- **NG9 — No unbounded historical retention** of transcripts/discovery telemetry (R19) — the export path is the archival mechanism.
- **NG10 — No throughput claims beyond the evidence:** the per-account LinkedIn cap and Indeed's Cloudflare reality are surfaced, not engineered around.

---

## 6. Traceability matrix (v11 failure → v12 requirement)

| # | v11 production failure (evidence) | v12 requirements |
|---|---|---|
| 1 | Brain-in-content-script; SW eviction/port death/BFCache killed runs (v11.72, discoverIdx reset, channel-closed crashes) | R1–R4 |
| 2 | Heuristic accretion: modal→/apply/ (v11.27), 0×0 radios (v11.56/62), naked radios (v11.66), Loading...Continue (v11.86), form-root break ×155 | R5–R10, F17, N21 |
| 3 | Tab-counted-as-slot 9-min gaps (v11.84); parallel focus war froze the machine (v11.45/46/78); scattered/stale pacing (v11.13) | R11–R16, N3, N10 |
| 4 | ATS lane starved LinkedIn 30→1.6/hr (v11.83); 12.8k junk batch rows/day + SSE storms (v11.85); static freshness saturation (v11.58/67) | R17–R22, F5 |
| 5 | node-sqlite3-wasm lock-brick, silent write drops, source-dump-on-throw | R23–R24 |
| 6 | 16MB /jobs + 17MB /queue payloads, N+1 scans, renderer OOM at 233k DOM nodes (v11.82/68) | R25–R27, N5–N7 |
| 7 | 6-min unattended Cloudflare waits ×27, beep spam, captcha-tab killed mid-solve, badge false positives (v11.59/70/72/73/74, 2026-07-04 overnight) | R28–R32, N16 |
| 8 | Gmail + CWS token rot killed sync and publishing repeatedly | R33–R35, F20–F21 |
| 9 | LinkedIn-only Gmail query froze the pipeline at 'submitted' (v11.48/49/64/65) | F13–F14 |
| 10 | False submits from passive detector during driven runs; awaiting_review folded into submitted | F7 |
| 11 | Global memory writes / unscoped qa (pre-v11.10); EEO harvest risk | F10–F11, N19 |
| 12 | Zero-submit triple bug: over-blocking dedup, misclassified transients, lost cursor (2026-06-15) | R20, R22, F4, F6 |

---

## 7. Acceptance-test index (normative naming)

Tests named `AT-<req>` above are release gates. They live in three suites:

1. **Unit** (`app/tests/*.test.mjs`, node:test): scheduler math (R11–R15), answer ladder (F9–F11), classifier precedence (F14), normalizeLabel (R7), sanitizer (N23), focus arbiter (R13a).
2. **Adapter harness** (`harness/fixtures/<name>/`): DOM fixture pages driven by the real generic driver end-to-end in a headless Chrome with the real actuator — every fixture listed in F1–F3, R7–R10, R29–R32.
3. **Soak/integration** (`tests/soak/`): N1–N3, N5–N8, N11, AT-R17/R18/R19 with seeded production-scale data; the payload-size sweep (N6).

CI runs suites 1+2 on every PR, suite 3 nightly and before any tagged release.

---

## 8. Open questions (for the architect / Pierre)

1. **Live v11 coexistence during transition (F19/NG8):** is import-and-switch acceptable on day one, or does Pierre want a read-only "mirror v11" mode (via v11's API, per the 2026-07-03 decision) while v12 stabilizes? The requirements assume import-only; reviving the bridge adds the bridge.js mode-arbiter scope.
2. **Adapter hot-update distribution:** launch scope is local-only recipe editing (adapter inbox + manual JSON). Is a signed remote adapter feed (so Dad's machine gets recipe fixes without a release) in scope for launch or v12.1? Affects R5's delivery story for non-dev users.
3. **Learned-adapter automation depth (R10):** does "LEARNS" mean AI-drafted recipes proposed in the adapter inbox (human approves), or is auto-promotion after N successful supervised runs desired? Requirements assume human-approved drafts.
4. **Multi-account LinkedIn:** the 50/24h cap is per-account; multi-account support (Dad's machine = his account = fine; multiple accounts on ONE machine) is intentionally unspecified — confirm it stays out of scope (ToS risk).
5. **Cloud-AI provider default:** API key (which vendor) vs local Ollama as the shipped default for the F9 fallback — cost/quality/privacy call for Pierre.
6. **Salary-question policy:** deterministic grounding (F9) can answer salary expectations from a configured range — confirm Pierre wants it auto-answered vs always parked.
7. **jobspy packaging:** the python worker is a heavyweight dependency (embedded python vs system install vs a port of the scrape to node). Pillar-Architecture owns the decision; requirement is only that the LinkedIn/Indeed lanes exist (F4).
8. **Aurora WebGL budget on low-end machines (Dad):** F15 requires a fallback; confirm the fallback threshold (GPU blocklist? FPS probe?) and whether Dad's machine class needs Aurora-lite as the default.
