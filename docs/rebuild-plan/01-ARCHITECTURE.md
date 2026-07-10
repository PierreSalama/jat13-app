# JAT 13 Rebuild — Architecture

Date: 2026-07-10 · Companion to `00-MASTER-PLAN.md` (locked decisions live there). Deep inventories: `research/`.

## 1. Process shell

One Electron main process = the brain: single DB writer, loopback Hono server (REST + `/drive` ws) on 7860 (dev 7861), **tray-resident** — closing the window never kills the brain; Quit lives in the tray. Renderer (Electron window) and browser dashboard are the SAME static app served from the same origin. Single-instance lock. `JAT_USERDATA` override for tests; dev-drive mounted when devtools.

## 2. Engine

**Scheduler (per-lane: linkedin / indeed / ats).** Each lane owns: a queue-supply *pump* (eligible = adapter-supported host + status Saved + no run + under cap + over fit floor, ordered fit-desc then freshness), pacing (serial global drive; ONE foreground token app-wide), and breakers (N consecutive failures → lane pause + notification). The pump is part of the drive loop and part of the E2E test — *a driver without a producer can never ship again*.

**Runner.** 13-state FSM as data (`queued → leased → navigating → classifying → driving → verifying → submitted | needs_human | parked | skipped | failed | waiting_page | ready_for_review`), transitions validated by one authority; state lives in `apply_runs` columns so "busy" is one SQL query. Resume-by-reclassification: extension death → `waiting_page` → fresh snapshot → re-classify → continue (proven by the survival test — it stays in the suite). Submit truth: `state='submitted'` requires trustworthy `evidence_kind` (CHECK constraint); anything else quarantines as `ready_for_review`.

**Adapters-as-data.** JSON docs (id, version, hosts[], classify pages, fieldMap, advance, evidence, park triggers) — DOM drift = data edit. v11 matrix carries: win Lever/Greenhouse/Ashby/LinkedIn/Indeed-smartapply; fill+park BambooHR (honeypot `nickname_`); park-never-loop Workday/iCIMS/Taleo. LinkedIn adapter handles modal AND full-page `/apply/` (URL + advance-root detection); radio-aware grounding counts 0×0 inputs; label normalization at one choke point; disabled-advance = waiting, not failure.

**Answer ladder** (order is law): sensitive-block (EEO/SSN/creds — never auto-written, never sent to AI) → locked answers → learned (per-profile, `profile_id`-scoped) → profile fields → deterministic derivations → **AI router** → park `needs_answer` with the exact question. Every accepted answer saves back with provenance (`user | harvest | ai | deterministic`) — ask-once-ever.

**Discovery (4 sources, per-lane state).** JobSpy subprocess (5 boards, typed failures) · browser-scrape fallback queue · ATS JSON boards (113 seeds, country gate, 14-min tick) · LinkedIn search. Rules from the scars doc: refill gates **source-scoped**; freshness ramp (72h→30d) wired into every path; saturation → 1-in-4 deprioritize + window jump; positive keyword+location gates on board feeds; ingest whitelist covers every source (a new source without ingest = loud error); telemetry writes only on yield.

## 3. AI layer (the new heart)

```
            AiRouter (one seam — nothing else talks to a CLI)
   task: screening | tailor_resume | cover_letter | fit_score | interview_brief | autopsy_summary
            │  route = per-task default → healthy fallback → park
   ┌────────┴────────┐
 ClaudeCodeBackend   CodexBackend            (both implement AiBackend)
 claude -p --output- codex exec --json --ephemeral
  format json --model  --skip-git-repo-check --ignore-user-config
  X --max-turns 1      -s read-only --output-schema
```

- **Health model** per backend: `not_installed → installed → creds_present → verified` — *verified only after a real 1-token gen ping* (the expired-Claude-token trap). Probes: `claude auth status` (JSON, ~0.5s) / `codex login status` (~0.25s); re-probe on interval + before first task of a run.
- **Discovery ladders**: Codex = chrome-native-hosts-**v2**.json → v1 → `%LOCALAPPDATA%/OpenAI/Codex/bin` → PATH; Claude = `~/.local/bin/claude.exe` → PATH → manual. Settings shows two cards: status dot, model, measured latency, **Sign in** (spawns the CLI's own interactive login in a terminal), Detect, manual path.
- **Task routing defaults** (measured 2026-07-10): screening answers + fit scoring → **Codex** (2.7–7.9s, schema output); résumé tailoring + cover letters + interview briefs → **Claude** (quality); autopsy summaries → whichever is idle. Either backend covers all tasks when the other is signed out; both signed out → ladder parks instead (never blocks).
- **Guardrail** (tailored docs): prompt constraint (rephrase/reorder only, no new facts/skills/dates/employers) + post-check — generated text is diffed against a fact whitelist extracted from the profile + master résumé; violations park the doc for review instead of attaching. Every generated doc stored with `derived_from`, `application_id`, `guardrail_hash`, viewable/downloadable per application.
- **Ledger**: every call → `ai_calls` (backend, task, latency, tokens if reported, outcome) — powers the Settings cards + autopsies.

## 4. Extension (thin, boring, port-aware)

Content script: 3-state lifecycle **dormant → observe → drive**; dormant does nothing (no snapshots, no observers — the v11 drain/self-refresh class stays dead). Drive requires a lease `{runId, epoch}`; actuator refuses any op without a matching epoch. Observe = watch-and-learn recorder, triple-redacted (values → shapes) at capture, uplinked over loopback HTTP. SW: transport only — ONE ws to the brain (port from storage, not hardcoded), ONE alarm, badge = needs-you count + connection state. Popup: pair (`/api/pair/token` → stores token+port), track page, open dashboard, and the permanent-URL installer download. Multi-run resume routing keyed by epoch→run map (not single-run heuristic).

## 5. UI — information architecture (Atelier Noir language, designed whole)

| Group | Page | Contents (designed-in from day one) |
|---|---|---|
| Operate | **Command Center** | Today's numbers (jobs/applied/interviews/offers), pacing rings per lane vs caps, auto-apply state + top-3 live runs, needs-you preview, activity stream, discovery pulse |
| Operate | **Auto-Apply** | Mission control: start/stop supervised · unattended toggle (+idle option) · live run theater (per-run transcript + "what the robot sees") · queue (fit-ordered, skip-floor visible with reasons) · honest-rate panel (per-lane submitted/parked/failed/skipped with WHY) · discovery strip (per-source yield/freshness/saturation) · caps + pacing controls |
| Operate | **Needs You** | The human queue: real questions (answer → learns → auto-requeue), walls (captcha/login → open tab), review queue (quarantined submits, guardrail-parked docs) — hygiene rules built in (captcha/login auto-skip stale, awaiting_review = usually done) |
| Track | **Pipeline** | Status board (human labels, drag between stages), counts from ONE funnel source of truth |
| Track | **Applications** | Virtualized table, filters (status/source/fit/date), row → detail drawer: timeline, run history, generated docs, emails, autopsy link |
| Track | **Inbox** | Matched emails + suggestion review, category chips (human labels), reprocess |
| Track | **Interviews** ★new | Every detected interview: stage, company, date-if-known, AI brief (company research + role recap + your matching stories), prep checklist |
| You | **Profile** | Identity + 29 seed fields + work auth + salary target; learned memory browser (search/edit/lock/delete, per-profile) |
| You | **Documents** | Library (roles, default flags) + **Generated** tab: every AI-tailored doc, its diff vs master, guardrail status, which application used it |
| System | **Activity** | Append-only ledger with kind filters |
| System | **Autopsies** ★new | Per-run post-mortems (what happened, where it stopped, page snapshot ref); pattern groups ("same failure ×N") with proposed fixes (adapter patch / new learned answer / setting change) — one-click apply of a proposal = self-healing |
| System | **Settings** | AI (two backend cards) · Auto-apply (keywords/locations/seniority/caps/floors/pacing) · Discovery (sources on/off, freshness) · Gmail · Appearance · Notifications · Maintenance (backups/retention) · Import/Export |

Renderer rules (CI-gated): one file per page, shared `vocab.js` (every enum→label lives once), envelope-checked API client, virtualization for any list that can exceed 200 rows, no inline styles fighting the theme.

## 6. Gmail + Interviews + Autopsy pipelines

**Gmail**: user-supplied OAuth desktop client (v11 flow) + migrated v11 creds; broad query (not sender-restricted — the v11.48 scar); ordered classifier regexes (order is load-bearing, ported as data with tests); forward-only status elevation; thread trace-back matching; auto-create from confirmations; suggestion review UI. **Interviews**: classifier category `interview` → creates/updates an `interviews` row → AI brief task (job + company + profile + matching learned answers) → prep checklist; calendar integration = backlog. **Autopsy**: every terminal run writes a structured post-mortem (final state, park kind, last page class, step trail, blocking control); a pattern miner groups recurring signatures; each group renders a human card with a proposed remedy — applying it edits adapter data / adds a learned answer / flags a setting. Self-healing = the loop *proposal → Pierre-approved apply → measured recurrence drop* (fully automatic apply is backlog until trust is earned).

## 7. Testing model (what "tested start to finish" means here)

Unit + integration on every subsystem (vitest, in-memory DB) · contract tests on every API envelope + adapter doc · the survival test (kill-mid-run) stays mandatory · E2E pipeline test: seeded jobs → pump → fake-gateway drive → evidence → funnel counts (the whole chain in one test) · soak test (10k rows, payload caps) · **dev-drive harness from Stage 0** — every stage's exit criteria include driving the real app UI + `capturePage` proof · live-fire checklists per lane before a stage is offered to Pierre (I run a real supervised apply against each lane with screenshots + evidence rows) · importer acceptance runs against a copy of the REAL v11 DB, verified by field-level spot-checks, never synthetic fixtures alone.
