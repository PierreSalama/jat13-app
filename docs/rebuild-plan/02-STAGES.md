# JAT 13 Rebuild — Stages & Your Test Checklists

Date: 2026-07-10 · Rule: **a stage is DONE only when Pierre has run its checklist and said so.** I report at the end of each stage with proof (screenshots via dev-drive, test counts, live-fire evidence); you verify; only then the next stage starts. Corrections at any gate amend the plan docs — decisions stay written down.

---

## Stage 0 — Clean slate, skeleton, harness
**Builds:** wipe the v13 tree (git history preserves the old code; `docs/rebuild-plan/` survives) · fresh monorepo (shared/app/extension) · schema v1 (all tables of `00 §5`, loud migration runner + pre-migration backup) · API envelope + contract tests · CI (typecheck, tests, renderer gates) · tray-resident boot · dev-drive harness · empty Atelier shell with the full new nav (§5 page map, pages stubbed "coming in Stage N") · PatchBus decision recorded (measure, then build-or-strike).
**You test (~5 min):**
- [ ] Launch the dev build — the new shell renders with the full nav; nothing broken-looking
- [ ] Close the window → app stays in the tray; tray → Open dashboard reopens it; tray → Quit actually quits
- [ ] `http://127.0.0.1:7861/` shows the same dashboard in your browser
- [ ] Tell me the layout feels right as a skeleton (this is the moment to move nav/pages around — cheap now)

## Stage 1 — Data foundation: your life imported and browsable
**Builds:** copy-based v11 importer with every fidelity rule (status reconcile, run source/lane from job, event kinds incl. `email`/`resume_tailored`, timestamps, Gmail creds migration) verified against your REAL jat.db · Applications (virtualized) + Pipeline + Inbox (read-only) + Profile (incl. memory browser) + Documents + Activity pages live on real data · funnel = one source of truth.
**You test (~10 min):**
- [ ] All your numbers match reality: ~4,510 jobs, ~630 applied, 77 docs, 497 emails, 4,241 learned answers
- [ ] Pick 3 jobs you remember → status, timeline, and emails on each look right
- [ ] Applied filter shows applied jobs; Pipeline columns add up; fullscreen + windowed both look right
- [ ] Profile shows your fields + memory is searchable; Documents lists all 77 with working download

## Stage 2 — Single-apply end-to-end (the heart, proven small)
**Builds:** extension pairing + port-aware SW + watch-and-learn (observe mode records + distills, redacted) · "Apply now" on one chosen job: full drive loop with live transcript, submit-truth evidence, timeline entry, first autopsy card · all three lane adapters exercised (LinkedIn modal + full-page, Indeed smartapply, one of Greenhouse/Lever/Ashby) · survival test green (kill extension mid-run → resumes).
**You test (~20 min):**
- [ ] Load the extension → popup pairs instantly; badge shows connected
- [ ] Pick a real LinkedIn job → Apply now → watch it fill and submit; evidence + timeline recorded
- [ ] Same for one Indeed and one ATS job (I'll pre-stage candidates)
- [ ] Fill one application YOURSELF with observe mode on → the answers appear in learned memory (redacted properly)
- [ ] Mid-run, kill the extension (reload it) → the run recovers or parks honestly — never lies about submitting

## Stage 3 — Full supervised auto-apply (all three lanes)
**Builds:** discovery all 4 sources with per-lane gates/freshness/saturation · scheduler + pump + apply_ledger caps + serial pacing + breakers · deterministic fit floor + queue ordering · needs-you intake→learn→auto-requeue · mission-control page fully live (run theater, honest-rate, discovery strip, queue with skip reasons).
**You test (~30 min, supervised):**
- [ ] Flip auto-apply ON → queue fills visibly, runs stream with transcripts, ≥10 real submits across lanes in the session
- [ ] Honest-rate panel explains every non-submit (parked/skipped/failed with reasons you believe)
- [ ] Needs-you: answer one real question → it saves, the run requeues and completes
- [ ] Caps: LinkedIn ring fills toward 45/24h and the lane pauses at cap; discovery strip shows fresh supply
- [ ] Stop button stops cleanly; nothing freezes your machine at any point

## Stage 4 — The AI layer (both subscriptions)
**Builds:** AiRouter + both backends + health probes ("verified" = real gen ping) · Settings AI cards (status/sign-in/detect/manual/latency) · AI screening answers in the ladder (confidence-gated, save-back) · résumé tailoring + cover letters under the rephrase-only guardrail + Generated-docs tab with diffs · AI fit scoring upgrading the floor.
**Prereq (you):** run `claude auth login` once (your token expired 2026-06-15; Codex already works).
**You test (~20 min):**
- [ ] Settings shows both cards; both reach **verified** (Claude after your login); Sign out one → tasks visibly route to the other
- [ ] Run applies that hit unknown questions → AI answers appear, look sane, and are saved (asked once ever)
- [ ] Open a tailored résumé's diff → ONLY rephrasing/reordering of your real experience — zero invented facts
- [ ] Queue is ordered by fit with believable reasons; floor skips are explained

## Stage 5 — Gmail, Interviews, self-healing
**Builds:** Gmail connect + migrated creds + broad query + ordered classifier + forward-only status transitions + suggestion review · Interviews page (detection → AI brief → prep checklist) · Autopsies page with pattern groups + one-click-apply proposals (adapter patch / learned answer / setting).
**You test (~15 min):**
- [ ] Connect Gmail (one consent) → sync runs; recent employer emails matched; statuses moved correctly on real examples
- [ ] An interview email produced an Interview entry with a brief worth reading before a call
- [ ] Autopsies show grouped failures from Stage-3/4 runs; apply one proposal → the pattern stops recurring

## Stage 6 — Unattended mode, hardening, release
**Builds:** unattended toggle + optional idle auto-start + hard caps + OS notifications on every outcome + morning summary · soak (10k rows) + payload audits + backup ring · packaged release on jat13-app (auto-update from your installed 13.0.2) · extension CWS-ready zip · cutover checklist.
**You test (overnight + 10 min):**
- [ ] Evening: enable unattended → walk away. Morning: summary notification; caps respected; needs-you queue is small and honest; zero freezes
- [ ] Auto-update: your installed app updated itself to the rebuild
- [ ] You decide: retire v11 (its data is final-imported) or keep it one more cycle

---

**After Stage 6:** backlog items (`00 §12`) get their own mini-stages on the same gate rule.
