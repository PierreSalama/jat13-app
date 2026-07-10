# JAT 13 Rebuild — Master Implementation Plan (FINAL)

Date: 2026-07-10
Owner: Pierre
Status: **Awaiting Pierre's confirmation** (confidence ~90% — see §11)
Supersedes: the shipped v13.0.x tree (to be wiped at Stage 0, preserved in git history) and the v12 pillar corpus (reference only).
Research base: `research/v11-feature-inventory.md` · `research/engine-knowledge.md` · `research/v13-postmortem.md` · `research/ai-cli-integration.md` — the four inventories every section below is grounded in.

## 1. What we're building

**v11's product, recreated as one designed whole**: a desktop brain (Electron) + thin Chrome extension that discovers jobs across every lane, applies to them reliably in supervised *and* unattended modes, learns from Pierre continuously, answers/tailors with his **local AI subscriptions** (Claude Code + Codex — zero API keys), and tracks everything from discovery to interview — laid out big-picture-first instead of accreted. Production-ready and publishable; Pierre is user #1, not the only user.

## 2. Locked decisions (Pierre, 2026-07-10)

1. Both modes — **supervised excellence first**, then unattended (manual toggle + optional idle auto-start; hard caps + notifications always).
2. **All three lanes in the first auto-apply build**: LinkedIn Easy Apply + Indeed + ATS boards (Greenhouse/Lever/Ashby).
3. AI = **both local subscriptions**: Claude Code AND Codex CLI — auto-detected, best-for-task routing, one-click sign-in per backend, manual path fallback. No API keys, ever ([[reference_ai_subscription_constraint]]).
4. AI duties: screening answers (profile-first, ask-once-ever) · **résumé tailoring** · **cover letters** · **job-fit scoring**.
5. Tailored docs **auto-attach under a rephrase-only guardrail** — the AI may reorder/rephrase real experience, never invent facts/skills/dates; every generated doc saved + inspectable per application; supervised mode shows a diff.
6. Fit score **orders the queue best-first + configurable skip floor** (skips visible with reason; floor tunable/disable-able).
7. UI: **evolve Atelier Noir** (keep the warm-black/gold language) but the **layout/IA is redesigned from the whole picture** (§7 page map).
8. Killer extras designed-in: **Interview pipeline tools** + **Application autopsy & self-healing**. (Insights coach, follow-up automation → backlog §12.)
9. Identity: **rebuild as v13 in `PierreSalama/jat13-app`** — same releases/auto-update chain; ports 7860/7861; X-JAT13-Token; userData `jat13-app`.
10. **v11 keeps running** (port 7744) until the rebuild is proven with real submits; importer is copy-based so a live v11 is safe.
11. Delivery: **staged, every stage ends with a checkpoint Pierre personally tests and confirms** before the next begins (§8 / `02-STAGES.md`).

## 3. Architecture

```
                       Chrome (Pierre's real logged-in session)
   thin MV3 extension: content = dormant→observe→drive (lease-epoch actuator, triple-redacted recorder)
        service worker = transport only (port-aware WS + badge)          popup = pair/track/open
                     │ ws /drive + loopback HTTP (X-JAT13-Token)
                     ▼
 ┌────────────────────────── Electron main = THE BRAIN (single writer, tray-resident) ──────────────────────────┐
 │  SCHEDULER (per-lane: linkedin | indeed | ats)     DISCOVERY (4 sources, per-lane gates, freshness ramp,     │
 │   pump → queue → driver, apply_ledger caps,          saturation jump, source-scoped refill, yield-only       │
 │   serial + ONE foreground token (freeze-proof)       telemetry)                                              │
 │  RUNNER: 13-state FSM-as-data, resume-by-           AI ROUTER: ClaudeCodeBackend + CodexBackend behind one   │
 │   reclassification, submit-truth CHECK evidence       AiBackend trait; best-for-task routing; health probes  │
 │  ANSWER LADDER: sensitive→locked→learned→profile→   TAILOR: résumé/cover-letter generator, rephrase-only     │
 │   deterministic→AI→park (save-back, ask-once-ever)    guardrail, doc store + per-application inspection      │
 │  FIT: deterministic floor + AI scorer → queue order  AUTOPSY: every terminal run → readable post-mortem →    │
 │  GMAIL: OAuth + ordered classifier → status FSM       pattern miner → adapter-fix / learned-answer proposals │
 │  LEARN: watch-and-learn distiller (observe mode)     INTERVIEW: email→interview detection → AI brief + prep  │
 │  DEV-DRIVE: loopback remote-control + capturePage (devtools-gated) — the test harness, built at Stage 0      │
 └──────────────── better-sqlite3 WAL = single source of truth · Hono REST (enveloped) + ws on 7860 ────────────┘
                     ▲                                            ▲
        Atelier renderer (Electron window,             Browser dashboard (same origin, whole
        modular pages, virtualized lists)              renderer dir served) — same code
```

## 4. Tech stack (proven pillars — the post-mortem says the architecture held; the process failed)

Electron + TypeScript (tsc type-checks, esbuild emits) · better-sqlite3 WAL single-writer · Hono + ws loopback · zod contracts (shared/) · vitest · electron-builder + electron-updater (repo jat13-app) · vanilla-ES-module renderer **but modular**: one file per page + one shared vocabulary module (labels/enums rendered from ONE map), CI gate fails on any renderer file >400 lines or duplicated enum labels. API responses use ONE envelope convention (`{ok, data}` / `{ok:false, error}`) with contract tests — the `{rows:{rows}}` class becomes impossible.

## 5. Data model (v1 schema, one migration set — no accretion)

Everything the research inventoried, designed together: `jobs`, `applications` (+status FSM), `apply_runs` (13-state FSM columns, evidence CHECK, park vocab), `apply_ledger` (per-source cap authority), `learned_answers` (per-profile, kind field/qa, provenance, locked flag), `profiles` (+29 seed fields), `documents` (+**generated docs**: `derived_from`, `application_id`, `guardrail_hash`), `emails` + `email_matches`, `events` (append-only timeline), `discovery_sources`/`job_sightings` (per-lane state), `fit_scores` (score, reasons JSON, floor decision), `autopsies` (run post-mortems + pattern links), `interviews` (detected stage, brief doc, prep state), `ai_calls` (ledger: backend, task, latency, outcome), `settings` (per-key rows), `import_runs`. Migration runner: **loud on any non-matching .sql filename** + pre-migration backup wired (both v13 traps closed).

## 6. Reuse map (knowledge carries; code is rewritten into the new tree)

- **Respec verbatim from v13** (proven under fire): FSM-as-data + assertTransition; guarded runs DAL (atomic state+evidence UPDATE); transport-agnostic runner + resume-by-reclassification (survival test proved kill-mid-run recovery); adapters-as-data JSON + registry; lease-epoch actuator + dormant content script; sensitive-first answer ladder; apply_ledger; per-lane discovery; watch-and-learn redaction; copy-based v11 importer **with the 13.0.1 fidelity rules**; dev-drive harness.
- **Redesigned this time** (v13's process failures): scheduler/run-service (pump designed as part of the loop, E2E-tested: *discover→queue→drive→submit* ships as ONE tested pipeline); ws-gateway resume routing (multi-run safe); API envelope; modular renderer; PatchBus — **build it for real** (live UI updates) or strike it (decide at Stage 0 by measuring poll cost — default: polling with lean projections, PatchBus only if measured need).
- **From v11** (port the behavior, not the code): JobSpy discovery + browser-fallback + ATS JSON boards + freshness/saturation; ordered Gmail classifier regexes (order is load-bearing); per-ATS win/park matrix; needs-you self-healing intake; EEO/credential write-boundary; Codex prompt kinds (11) + deterministic floor; resume-tailor endpoint behavior.
- **Dropped**: WebGL galaxy/Aurora scope; v12 pillar corpus as living spec; qBit-era leftovers.

## 7. UI — the big-picture page map (Atelier Noir, redesigned IA)

Full spec in `01-ARCHITECTURE.md` §5. The shape: **Operate** (Command Center = today+live+needs-you-preview / Auto-Apply mission control = queue+live transcript+"robot sees"+honest-rate+discovery strip / Needs You = answer-and-requeue) · **Track** (Pipeline board / Applications table / Inbox / **Interviews** — new) · **You** (Profile+memory / Documents incl. generated-doc inspection) · **System** (Activity / **Autopsies** — new / Settings incl. the two AI cards). Every page designed knowing every feature exists — no bolt-ons.

## 8. Staged plan (detail + "You test" checklists in `02-STAGES.md`)

- **Stage 0 — Clean slate, skeleton, harness**: wipe tree (keep `docs/rebuild-plan/`), scaffold, schema v1, envelope+contract tests, CI, tray-resident boot, dev-drive, empty Atelier shell with the new IA.
- **Stage 1 — Data foundation**: v11 import (fidelity-audited against reality), all Track/You pages browsable on real data, browser dashboard, virtualization.
- **Stage 2 — Single-apply end-to-end**: extension pairing + watch-and-learn; "Apply now" on ONE chosen job driven E2E **per lane** (LinkedIn, Indeed, one ATS) with evidence + timeline + first autopsy.
- **Stage 3 — Full supervised auto-apply**: discovery (all 4 sources) + scheduler + pump + caps + pacing + needs-you + deterministic fit floor; mission-control UX live.
- **Stage 4 — The AI layer**: both backends (status cards, sign-in buttons, routing, health probes), AI screening answers, résumé tailoring + cover letters under the guardrail, AI fit scoring.
- **Stage 5 — Gmail + Interviews + self-healing**: Gmail connect + classifier + status transitions; interview detection + AI briefs; autopsy pattern-mining → self-healing proposals.
- **Stage 6 — Unattended + hardening + release**: idle auto-start + caps + notifications; soak tests; packaged release on jat13-app; extension store package; v11 cutover decision (Pierre's).

## 9. Risk/ops hardening

Serial apply + one foreground token (the freeze class stays dead) · apply_ledger is the only cap authority · submit-truth CHECK + quarantine · park-never-loop for walls (captcha/login/workday-class) · EEO/sensitive answers never auto-written, never sent to AI · rephrase-only guardrail enforced by prompt + post-check (fact whitelist from profile; violations park the doc for review) · payload discipline everywhere (lean projections, capped lists) · loud-on-unknown (unknown setting/kind/status throws, never silently defaults) · copy-based import, v11 never opened live · deploy: version-verify before publish; extension delivered via repo dist + CWS package.

## 10. Captured constants (this machine, 2026-07-10)

- v11 live at port 7744, data at `C:\Users\pierr\AppData\Roaming\jat11-app\jat.db` (4,510 jobs · 630 submitted · 4,241 answers · 77 docs · 497 emails · 2,674 runs)
- Codex CLI 0.144.0-alpha.4 — **logged in (ChatGPT sub)**; discovery needs a NEW ladder rung: `~/.codex/chrome-native-hosts-v2.json` → `~/.codex/plugins/.plugin-appserver/codex.exe`; measured: status 248ms · trivial gen 2.7s · schema screening 7.9s · cover letter 9.9s
- Claude Code 2.1.160 at `C:\Users\pierr\.local\bin\claude.exe` — creds file present but **OAuth token EXPIRED (2026-06-15): every headless call 401s. ACTION (Pierre): run `claude auth login` once.** Status probe: `claude auth status` (514ms, JSON) = "creds present"; verified = real 1-token gen ping.
- Repo `PierreSalama/jat13-app` (main @ v13.0.2); installed app `C:\Program Files\JAT 13`; extension loads unpacked from `extension/dist`.

## 11. Confirmation status — ~90%, pending Pierre

1. **Scope/AI/UI/stages**: ✅ locked (§2) from Pierre's 11 answers.
2. **Defaults Pierre may override** (else they stand): LinkedIn cap stays 45/24h; supervised pacing ~30/hr serial; fit skip-floor default 30/100 (tunable); session/device naming unchanged; Claude = default backend for tailoring + cover letters, Codex = default for screening answers + fit scoring (fastest measured), either covers the other when signed-out.
3. **Open action (Pierre)**: `claude auth login` (expired token) — the AI stage can't verify the Claude backend until then; Codex already works.
4. **Confirm to start**: reply confirming the plan (or corrections) → Stage 0 begins, which is when the old tree is wiped.

## 12. Feature backlog (explicitly NOT in this build)

Insights coach + deep analytics · follow-up/withdraw email automation · salary/comp intel · multi-user/team features · mobile companion. Logged here so they're designed-around, not bolted on later.
