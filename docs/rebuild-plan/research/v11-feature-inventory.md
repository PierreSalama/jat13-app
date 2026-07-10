# v11 Feature Parity Inventory — the rebuild contract

_Source of truth: `F:/GITHUB/Perosnal/extensions/job-application-tracker/v11` (live product ≈ v11.83+). `extension/` = MV3 Chrome/Firefox, `app/` = Electron desktop (REST+SSE on 127.0.0.1:7744, token-auth, SQLite via node-sqlite3-wasm). Dashboard SPA is byte-identical mirrored: `extension/app/*` (source) ↔ `app/src/app/*`. Docs skimmed: FEATURE-MAP.md (v11.42 snapshot), MASTER-REFERENCE.md, ARCHITECTURE.md, EXTERNAL-ATS-PLAYBOOK.md._

Legend: **MH** = must-have, **NTH** = nice-to-have.

---

## 1. Dashboard pages (hash-routed SPA, 10 routes in `extension/app/app.js` ~4.2k lines)

### 1.1 `#/` Dashboard (Overview)
| Feature | Where in v11 | What it does | Priority |
|---|---|---|---|
| Stats row (5 tiles) | app.js route `/` | Submitted total (+today/+started), Via auto-apply (count, %, submitted vs captured), By hand, Response rate (replied+interviews), Needs review (clickable → filtered list) | MH |
| System strip chips | app.js `/` | Codex/Ollama availability dots, Gmail sync recency, auto-apply queue depth + "N need you" | MH |
| Submissions-this-week chart | app.js `/` | 7-day stacked bars (auto vs by-hand) with per-day counts + weekday labels; 30-day completed mini-bars | NTH |
| Auto-apply health panel | app.js `/` | Live status (Off/Running/Idle/Hourly-cap/Pacing), submitted today, queue depth, needs-you, session open-rate, auto-vs-manual split bar, Top blockers (7d top-3 reasons), live worker chips | MH |
| Pipeline funnel | app.js `/` | Discrete cumulative stages Submitted→Assessment→Interview→Offer with conversion % | MH |
| Sources breakdown | app.js `/` | Top-6 sources bar list from `stats.bySource` | NTH |
| Recent applications table | app.js `/` | Last 8 jobs: title/company/status/via/source/updated; row click → detail; right-click context menu (open, set status ×12, queue auto-apply, delete) | MH |

### 1.2 `#/applications` (Ledger)
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Filterable table (≤500 rows) | app.js `/applications` | Columns: sel-checkbox, Title(⚠needs-review), Company, Status chip, Via badge, Fit badge, Source, Applied, Updated. Sortable headers w/ direction toggle | MH |
| Filters | same | Text search (debounced, `/` hotkey), status dropdown (incl. `needs_review`), source dropdown (dynamic), via filter (auto/manual/all — client-side) — all persisted | MH |
| Bulk bar | same | Select-all, bulk set-status, bulk queue-for-auto-apply, bulk delete with undo-toast (recreates snapshots) | MH |
| "Needs your input" cards | same | Parked/awaiting auto-apply tasks inline: park reason, pending questions rendered as input/select, Save&continue → `/auto-apply/intake` (answers saved to profile + task requeued), Open job, Details, Dismiss | MH |
| Sync past applications | same (extension host only) | Scrapes LinkedIn/Indeed "applied jobs" pages in a background tab (`applied-sync.js` via SW `sync-applied`); picker: boards + range (30/90/180d/all); dedup import marked submitted with real date | MH |
| Export CSV | same | 12 columns, formula-injection guard, UTF-8 BOM for Excel FR names | MH |
| New application button | same | → `#/applications/new` manual entry | MH |

### 1.3 `#/applications/:id` (Detail / New)
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Posting form | app.js detail route | Title, Company, Location, Compensation, Source, Job URL (+open ↗), Work mode, Type; Title+Company required | MH |
| Status panel | same | Status select (12-state FSM), Next action, Due date, Tags chips, Submitted timestamp | MH |
| Notes textarea | same | Freeform marginalia | MH |
| Needs-review banner | same | "Sparse capture" banner + "Looks good" clears flag | MH |
| Attachments list | same | Files captured with the application (role badge, name, size) | MH |
| Captured form answers | same | Read-only render of `job.answers` | MH |
| AI actions | same | Fit score (renders score+summary+strengths+gaps+deterministic overlap), Summarize, Cover letter (modal+download), **Tailor resume** (modal+download, records `resume_tailored` event), Follow-up draft, Queue auto-apply | MH |
| Timeline | same | Events feed for the job (summary, rel-time, source) | MH |
| Emails panel | same | Matched emails (category chip, Gmail deep-link via rfc822msgid, unlink), Suggested matches (Yes-link-it / Not-this), manual link via search over unmatched synced emails | MH |
| Delete w/ undo | same | Delete + undo-toast restores snapshot | MH |

### 1.4 `#/pipeline` (Kanban board)
| Feature | Where | What it does | Priority |
|---|---|---|---|
| 12 status columns grouped | app.js `/pipeline` | Groups Pre/Active/Interviews/Closing/Closed; drag-drop card → PATCH status (optimistic move, no re-render flicker) | MH |
| Cards | same | Company-initial avatar (hash hue), title/company, fit badge + color class, source/location/via badges, top-3 tags, stale marker (>14d non-terminal), needs-review ⚠ | MH |
| Board toolbar | same | Search, source filter, min-fit filter (45+/70+), sort (updated/newest/fit/title) + direction, density toggle (compact/comfortable) — persisted | MH |
| Column mgmt | same | Collapse per column, Columns modal (show/hide each, "Hide closed" shortcut) — persisted | NTH |
| Connect-email banner | same | Shown until an IMAP account or Gmail OAuth is connected; dismissible (localStorage) | NTH |
| Card context menu | same | Open, set status ×12, queue auto-apply, delete | MH |

### 1.5 `#/queue` (Auto-apply)
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Start/Stop master button + run timer | app.js `/queue` | Single power button: Start = enable; Stop = disable + skip queued/running + close apply tabs; elapsed "running for" timer | MH |
| Live "Running now" panel (2.5s poll) | same, `/auto-apply/live` | Status dot, active/concurrency workers, session tally (submitted/to-review/needs-you/skipped/failed/in-queue), effective apps/hour + binding cap + "⚡ Max speed" one-click preset (60/hr, 200/day, 0.25–0.6min gap, aiConf 0.7) | MH |
| Honest run breakdown (R3) | same | Raw verified rate (verified÷dispatched) + supported rate (of drivable); counts: verified submits, submitted-needs-confirm, blocked-by-site (Cloudflare/CAPTCHA), flow-failed, skipped, needs-you | MH |
| Per-worker live cards | same | Title/company, route chip, siteKey, attempt #, elapsed, streaming transcript trail (last lines, current action), "Robot sees" (page text, fields, buttons), pending questions, failure policy label | MH |
| Watchdog/health line | same | Stale tasks + invalid waits count, discovery last-healthy, pending browser fallbacks | MH |
| Discovery strip | same | Last search (provider/source/keyword/status/found/queued/error/when), "Search now" (`/auto-apply/discover-now`), "Apply next now" (extension host, skips pacing), "Open Control Studio for next application" (arms one-shot supervised dispatch, `/auto-apply/supervise-next`) | MH |
| Self-healing intake | same | Parked questions aggregated across tasks; answers → saved to profile memory + all set-aside jobs requeued | MH |
| Targeting controls | same | Keywords chips, Locations chips, Work-mode checkboxes (remote/hybrid/onsite), Country (hard clamp), Mode (auto/review), Boards (LinkedIn/Indeed/Glassdoor/Google/ZipRecruiter), Easy-Apply-only toggle, Profile select, Résumé select, Experience years, Max seniority (any/entry/mid/senior), Exclude titles/companies/locations chips | MH |
| Advanced pacing | same | Run anytime 24/7 vs windowStart/End, Idle-only toggle + idle threshold secs, max/day, max/hour, gap min/max, Parallel applications (1–5, confirm-modal on raise), Max-same-site, Bring-to-front-to-hydrate, Keep PC awake, Keep display awake | MH |
| Queue ↔ History tabs | same | Queue: task cards grouped by state (mode, attempts, park reason, last error, last transcript line; Retry/Cancel/Transcript(lazy, last-200 lines)/Open job/Remove + context menu). History: range picker (1/7/30/90d/all), rollup chips, breakdown chart (outcome stacked bar, by-board, by-route easy/external, failure-policy, top skip/fail reasons), item list | MH |
| Idle-pause banner | same | When idleOnly + paused: reason ("you're using the computer" / "media is playing") + auto-resume note | MH |

### 1.6 `#/procedures` (Taught Procedures — Apprenticeship audit)
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Recipe browser | app.js `/procedures`, `/recipes` API | Grouped ATS → company (ATS-scope recipe heads group, company overlays follow); per-recipe: scope chip, confidence chip, ✓/✕ success/fail counts | MH |
| Step rows | same | Screenshot thumbnail (`/teach-shot/:id`), label, field type/action, confidence %, source (manual/teach/correction/distilled), value, CSS selector, xpath (expandable) | MH |
| Step editing | same | Edit value, edit label, flip scope (ats↔company), move up/down (step_index swap), delete — via PATCH/DELETE `/recipe-step/:id` | MH |
| Needs-attention filter | same | Surfaces low-confidence / recently-corrected / fail-prone steps; per-profile selector | MH |

### 1.7 `#/profile`
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Multi-profile list | app.js `/profile` | Profile sidebar, + New profile, default flag, delete | MH |
| Structured fields | same | 29 seed fields in 6 groups (Identity, Contact & location, Links, Work eligibility, Compensation & experience, Education) + custom fields (add/remove) + Summary textarea + Skills chips | MH |
| Source assignments | same | "Use on sites" chips (hostname-contains) → per-source profile pick (`/profiles/for-source`) | MH |
| Work / education history | same | Editable multi-row records (title/company/location/dates/description; degree/school/field/years/gpa) | MH |
| Experience timeline chart | same | SVG gantt of work+edu spans across years ("Present" aware) | NTH |
| Learned answers table | same, `/profile-fields?profileId=` | Per-profile memory: EN/FR badge, question, editable answer, seen count; live search filter; lock 🔒 (harvest won't overwrite), forget ✕, "↑ Profile" promote (regex label→profile-key map, EN+FR accent-folded) | MH |
| Memory bridges | same | "Fill from memory" (memory→empty profile fields), "Save profile → memory", "Build from past applications" (backfill harvest across all jobs) | MH |
| Import from résumé | same, `/ai/resume-parse` | AI-parse the active résumé into profile fields | MH |
| Autofill master strip | same | Toggle `autofill.enabled` inline (never submits) | MH |

### 1.8 `#/documents`
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Library table | app.js `/documents` | Role tabs w/ counts (All + resume/cover_letter/other…), search name/keyword, columns: ★active, name+designation+source tag, role select, keywords chips, size, modified, actions | MH |
| Upload | same | Button + drag-drop zone; .pdf/.docx/.doc/.txt/.md/.rtf, 10MB cap; text extraction w/ char-count feedback | MH |
| Linked local folders | same, `/document-folders` | Link path (Browse… on desktop) + role hint (auto-detect); read-only smart indexing (résumé/cover-letter name recognition, junk skip, auto-updates via folder watch); Re-index, Unlink(+prune) | MH |
| Active document per role | same | ★ star sets `isDefault` — what autofill / auto-apply / tailoring attach | MH |
| Per-doc actions | same | View extracted text (modal + download), Download raw, set designation label ("Master CV"), change role, delete (permanent for uploads, entry-only for folder docs) | MH |

### 1.9 `#/activity`
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Event feed | app.js `/activity`, `/events/recent` | Last 120 events with type icons (created/status_changed/reopened/email/progressing/resume_tailored/note) | MH |
| AI usage meter | same, `/ai/usage` | Per-provider calls/OK/total-time table + last-20 AI calls (kind, provider+model, duration, ok/failed w/ error, when) | MH |

### 1.10 `#/settings` — see §2 (every control listed there)

### 1.11 Extension popup (`extension/popup/`)
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Connection state + pair | popup.js | Health dot with grace window (no flicker on blips), Connect button → `/pair` | MH |
| Finish-setup card | popup | Install-the-app CTA when unpaired (downloads installer, launch app, onboarding link) | MH |
| Current-page capture | popup | Reads page detection state; "📌 Track this page" manual capture | MH |
| Mini stats | popup | Total, this-week, needs-review — deep-link into dashboard | NTH |
| Auto-apply state row | popup | Current engine state at a glance | NTH |
| Control Studio launcher | popup | "Watch & teach" → supervised run on current tab (must be a job page; clear error otherwise) | MH |
| Update banners | popup | Extension version drift banner + app update banner (Update now / Later) | MH |

### 1.12 Onboarding (`extension/onboarding/`)
| Feature | Where | What it does | Priority |
|---|---|---|---|
| 3-step wizard | onboarding.html/js | 1 Get the app (download installer) → 2 Install → 3 Connect (polls health, auto-pairs, 🎉 connected) | MH |

### 1.13 In-page UI (content scripts)
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Job-page detection | content/detector.js + signals/{forms,intent,json-ld,success}.js, lib/jobpage.js | Multi-signal job-posting detection; SPA re-detect via webNavigation history/fragment | MH |
| Capture panel | content/panel.js | Silent until Apply click (configurable); mid-confidence "Track this application?" ask-once; "Not a job" silences site forever | MH |
| Autofill | content/autofill.js | Fill empty fields from profile+learned memory (fuzzy, confidence-gated); EEO/sensitive skip; highlight filled; never submits | MH |
| Recorder (Teach Mode) | content/recorder.js | Always-on answer harvest + full-fidelity Teach capture (selector+xpath+attrs+HTML+screenshot+value+timing); floating "● Teaching" pill + per-step toast | MH |
| Control Studio overlay | content/supervise.js | Supervised Step/Run, live robot-vision panel, pause, correction ("Fix this" element-picker rewrites recipe at conf 0.95), recovery, skip, explicit submit | MH |
| Applied-sync scraper | content/applied-sync.js | Reads LinkedIn/Indeed applied-jobs pages for import | MH |

---

## 2. Settings (defaults in `app/src/config.js`; all overridable via PATCH /settings; UI in `#/settings` + `#/queue`)

### 2.1 App / server
| Setting | Default | Gates |
|---|---|---|
| `server.port` | 7744 | REST+SSE port (restart to change) |
| `app.closeToTray` | true | closing window keeps engine alive in tray |
| `app.autoLaunch` | false | start with Windows |
| `app.globalHotkey` | true | Ctrl+Shift+J toggles dashboard window |
| `autoUpdate.mode` | 'auto' | auto/prompt/manual updater behavior |
| `autoUpdate.idleMinutes / graceMinutes / checkEveryMinutes / checkOnFocus` | 5 / 10 / 30 / true | unattended-install safety + poll cadence |
| `appearance.theme` | 'atelier' | theme picker (multi-theme grid w/ swatches, `lib/themes.js`) |
| `backups.keep` | 14 | daily DB backup rotation |

### 2.2 AI (`ai.*`)
| Setting | Default | Gates |
|---|---|---|
| `ai.order` | ['chatgpt','claude','local'] | provider priority, reorderable ↑↓ in UI (legacy string orders bridged) |
| `ai.claude.useSubscription` | true | Claude Code CLI subprocess path |
| `ai.claude.cliModel / apiKey / model / timeoutMs` | '' / '' / claude-sonnet-4-6 / 120000 | Anthropic API fallback |
| `ai.chatgpt.useSubscription` | true | Codex CLI (ChatGPT subscription) path |
| `ai.chatgpt.apiKey / model / timeoutMs` | '' / gpt-5.4 / 120000 | OpenAI API fallback (legacy `ai.cloud` bridged field-by-field) |
| `ai.local.provider/url` | ollama / localhost:11434 | local chain |
| `ai.local.autoPick` | true | model picked for hardware (RAM/VRAM probe → tier) |
| `ai.local.autoSetup` | true | background auto-download Ollama+models when no cloud key |
| `ai.local.structuredModel / proseModel` | '' (= hw recommendation) | Qwen-structured / Gemma-prose split |
| `ai.local.timeoutMs/numCtx/keepAlive/trySpawn/exePath` | 90000/8192/15m/true/'' | ollama runtime knobs |

### 2.3 Capture / harvest / autofill
| Setting | Default | Gates |
|---|---|---|
| `capture.panelOnDetect` | false | silent-mode; panel only on Apply click |
| `capture.askWhenUnsure` | true | mid-confidence ask-once |
| `capture.successRescanMs` | 2000 | success re-scan cadence |
| `harvest.enabled` | true | learn answers from applications into profile memory |
| `harvest.minLen` | 1 | ignore shorter answers |
| `autofill.enabled` | true | master autofill switch |
| `autofill.autoSubmit` | false | HARD invariant — filling never clicks submit |
| `autofill.fillProfile / fillLearned` | true / true | which sources fill |
| `autofill.minConfidence` | 0.6 | fuzzy-match floor |
| `autofill.skipSensitive` | true | never touch EEO/demographic/identity |
| `autofill.highlight` | true | outline filled fields |

### 2.4 Auto-apply (`autoApply.*`)
| Setting | Default | Gates |
|---|---|---|
| `enabled` / `startedAt` | false / '' | master switch + run timer |
| `mode` | 'auto' | auto-submit vs 'review' (stop before submit) |
| `maxPerDay / maxPerHour` | 150 / 30 | successful-submit caps |
| `dailyCap` | 120 | soft cap on ALL dispatches (rolling 24h, anti-ban); 0=off |
| `minGapMinutes / maxGapMinutes` | 1 / 3 | randomized human-like gap between starts (÷ concurrency) |
| `concurrency` | 1 | worker pool size 1–5 (UI confirm on raise; tiled windows) |
| `perSiteConcurrency` | 2 | max simultaneous applies per siteKey (all LinkedIn = one site) |
| `parallelApplySafe` | **false** | KILL-SWITCH: false forces serial regardless (multi-window focus-steal froze machine v11.46) |
| `keepAwake / keepDisplayAwake` | true / false | powerSaveBlocker session-scoped |
| `bringToFrontToHydrate` | false | opt-in: front the apply window while applying |
| `frontToHydrate` | true | reactive: front only while occluded+unhydrated, self-releasing |
| `runAnytime / windowStart / windowEnd` | true / '' / '' | 24/7 vs daily time window |
| `idleOnly` | false | pause on input OR audible tab; resume on full idle+silence (`lib/idle-gate.js`) |
| `idleThresholdSeconds` | 60 | chrome.idle threshold (15s floor) |
| `aiAnswerConfidenceMin` | 0.7 | AI answers screening Qs above this; below → park |
| `easyApplyOnly` | false | on = 1-click/in-page only; off = external/ATS handoff too |
| `keywords / locations / workModes / country` | [] / [] / [] / 'Canada' | targeting; locations = geography only; country = hard geo clamp |
| `boards` | ['linkedin','indeed'] | jobspy boards (+glassdoor/google/zip_recruiter) |
| `experienceYears` | 0 | skip jobs demanding far more years (0=off) |
| `seniorityMax` | 'any' | any/entry/mid/senior title-level cap |
| `excludeKeywords / excludeLocations` | [] / [] | substring skips |
| `excludeCompanies` | curated 12-entry staffing/reposter blocklist | skip flooding recruiters (user-editable) |
| `profileId / resumeDocId` | '' / '' | which profile/résumé to apply with ('' = default/active) |
| `discovery.enabled / provider` | true / 'jobspy' | app-side discovery; browser scrape = failure-only fallback |
| `discovery.perRunLimit / refillBelow / intervalMinutes / hoursOld` | 25 / 3 / 1 / 72 | supply pump knobs |
| `discovery.atsBoardsEnabled` | true | direct Greenhouse/Lever/Ashby JSON-board lane |
| `sites` | {} | per-host overrides (e.g. mode per host) |

### 2.5 Email / Gmail
| Setting | Default | Gates |
|---|---|---|
| `gmail.enabled` | false | legacy OAuth Gmail sync |
| `gmail.query` | broad job-mail query (LinkedIn noreply OR 14 ATS sender domains OR ~20 stage phrases) | what gets fetched — the v11.48 starvation fix |
| `gmail.includeRecruiterMail` | false | 2nd-stage AI classification of generic recruiter mail |
| `gmail.intervalMinutes / clientId / clientSecret` | 30 / '' / '' | user-supplied Google OAuth desktop creds |
| `email.syncIntervalMinutes` | 15 | IMAP background sync cadence |
| `email.autoLinkThreshold` | 0.7 | ≥ → auto-associate email→job |
| `email.suggestThreshold` | 0.4 | ≥ (but <auto) → "suggested" match |
| `followUp.days` | 7 | auto follow-up due date after submit; 0=off |

### 2.6 Notifications / maintenance
| Setting | Default | Gates |
|---|---|---|
| `notifications.statusChanges` | false | toast on status change |
| `notifications.autoApply` | true | in-app auto-apply toasts |
| `notifications.autoApplyDesktop` | true | NATIVE OS notification (Action Center) on every apply outcome (submitted/failed/needs-you) |
| `notifications.updates / followUps` | true / false | update + follow-up reminders |
| `maintenance.eventRetentionDays` | 90 | prune timeline events |
| `maintenance.taskRetentionDays / transcriptClearDays` | 14 / 3 | prune terminal tasks / null transcript blobs |
| `maintenance.aiLogRetentionDays / discoveryRetentionDays / emailRetentionDays` | 7 / 5 / 365 | telemetry pruning (unmatched emails only) |
| `maintenance.vacuumEveryDays` | 3 | periodic VACUUM |
| `maintenance.pauseBackgroundOnBattery / memoryGuardMB` | false / 1400 | battery saver + RSS guard skips sync ticks |

---

## 3. Auto-apply engine

### 3.1 Discovery (supply)
| Feature | Where | What it does | Priority |
|---|---|---|---|
| JobSpy subprocess provider | app/src/discovery/index.js + jobspy_worker.py | Python JobSpy: linkedin, indeed, glassdoor, google, zip_recruiter; normalizes records (board URL kept for Easy-Apply verification, direct URL as metadata); typed error classes (timeout/rate_limited/blocked/parser_drift/unavailable/failed) | MH |
| Browser-scrape fallback | discovery_fallbacks table + extension content/discover.js + `/auto-apply/discovery-fallback/next` | Only on typed provider failure; extension claims fallback rows and scrapes in Chrome session | MH |
| Direct-ATS JSON boards | app/src/discovery/ats-boards.js + ats-seed-companies.json | Public unauth JSON APIs: Greenhouse boards-api, Lever v0/postings, Ashby posting-api; curated + DB-harvested tokens (113 live seeds); round-robin 10 tokens/tick, ~14min tick floor, 2s spacing, 30-min cooldown per 429/403 token; keyword-filtered; **country/location eligibility gate** (Canada-local or generic-remote only); boot-start | MH |
| Freshness ramp | discovery/index.js (mirrors extension/lib/freshness.js) | Per (board×keyword×location) combo: 72h floor → widen 7d→14d→30d on each 0-new scan, reset to 72h on fresh accept; saturated combo (no new in 6h) jumps straight to 30d | MH |
| Saturation de-prioritization | discovery/index.js `shouldSkipSaturatedCombo` | Fully-saturated combo (widest tier all boards + dry) visited only 1-in-4 planner passes; deterministic kv counter | MH |
| Source-aware refill gate | discovery/index.js ~L264 (v11.83) | jobspy refill counts only jobspy-sourced queued jobs — ATS-board supply can no longer starve LinkedIn discovery | MH |
| Keyword×location rotation | extension/lib/search-url.js + freshness.js | Combo planner rotation, search-URL builder | MH |
| Board selection vs easyApplyOnly | discovery/index.js | easyApplyOnly ON → non-LinkedIn jobspy boards suppressed (no Easy-Apply concept → would flood queue) | MH |
| Self-throttle | discovery `runTick` time gate | Prevents subprocess storms (anti-freeze) | MH |
| Durable discovery ledger | discovery_batches/job_discovery_provenance tables + queue-page strip | Every batch recorded (found/accepted/duplicate/rejected/error/diagnostics); provenance per job with apply_capability | MH |
| Manual "Search now" | `/auto-apply/discover-now` | One-shot discovery run from UI | MH |

### 3.2 Eligibility & filters (both at ingest and re-checked at dispatch)
| Feature | Where | What it does | Priority |
|---|---|---|---|
| jobFit relevance filter | server.js `jobFit` | seniorityMax title-level cap, excludeKeywords (whole-word), excludeCompanies, excludeLocations, experienceYears vs demanded, academic/postdoc auto-skip; re-checked at dispatch (settings edited after queueing still apply) | MH |
| Country/geo gate | discovery + rankJob truthful geo gate | hard country clamp on searches; location-eligibility on ATS-board results | MH |
| Easy-Apply eligibility grounding | executor + queueNext (v11.56) | radio-aware countFields; main-pass eligibility grounding; parked-then-rescued → terminal park | MH |
| Punishments | punishments table, `/punish` `/unpunish` `/punishments` | user "never this job / job-type / company" with weight + decay (default 90d); feeds rankJob | MH |
| rankJob scoring | db.js (P7) | fit + reward − punish − geo − staleness; consumed by queueNext + discovery | MH |
| Duplicate detection | jobs.norm_key + job_url_norm indexes | dedup at ingest across boards | MH |

### 3.3 Worker pool, pacing, caps (`extension/background.js` + server.js queueNext)
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Dispatch gates | server.js queueNext | ordered reasons: disabled → outside-window → daily-cap → hourly-cap → daily-soft-cap → gap (÷concurrency) → empty → easyapply-cooldown → site-gap → site-busy | MH |
| Serial + parallel pool | background.js | concurrency 1–5, site-spread (taskSiteKey active-site dedup, perSiteConcurrency), kill-switch parallelApplySafe=false forces serial | MH |
| Dedicated apply windows + tiling | lib/window-place.js | own Chrome window per worker, tiled side-by-side (visible ⇒ not occlusion-throttled) | MH |
| Front-to-hydrate | background msgs `jat11.front-until-hydrated` / `apply-hydrated` | reactive fronting only while occluded+unhydrated, self-releasing; tab reaper | MH |
| Hard caps per run | extension/lib/apply-cap.js | 5.5min visible cap, 90s hidden-stall cap, 12min human-CAPTCHA cap (`jat11.human-challenge`) | MH |
| Per-host circuit breaker | extension/lib/host-breaker.js | trips on repeat failures per host; nav resets | MH |
| LinkedIn Easy-Apply daily-limit pivot | T6, kv easyApplyLimitUntil | detect ~50/24h limit → cooldown → pivot to external jobs | MH |
| Retry-stale watchdog | `/auto-apply/retry-stale` + watchdog | re-queues retriable failures; stale/invalid-wait detection surfaced in live health | MH |
| Terminal-integrity + submit quarantine | db.js migrations + tests | untrustworthy `done` rows downgraded to awaiting_review; race-lost verified submissions recovered from transcript evidence | MH |
| Success-truth verification | content/signals/success.js | submit verified by post-click evidence (R1), never static text match; never blind-submits | MH |
| Keep-awake | main.js powerSaveBlocker | session-scoped sleep/display block while running | MH |
| Test hooks | `run-autoapply-now` msg, harness/ | apply-next-now skipping pacing; dev harness (linkedin-handoff, indeed-popup, etc.) | NTH |

### 3.4 Apply execution & per-ATS adapters
| Feature | Where | What it does | Priority |
|---|---|---|---|
| LinkedIn Easy Apply | content/lib/linkedin-apply.js | Modal AND full-page `/apply/` flow (URL + advance-button root detection) | MH |
| Indeed | sites/indeed.js (v11.57) | indeed_native → smartapply.indeed.com drive via findApplyDialog ("Submit your application" keyword); resume_required parks | MH |
| Lever / Greenhouse / Ashby | sites/{lever,greenhouse,ashby}.js | WIN: full auto-submit (harness-proven) | MH |
| BambooHR | sites/bamboohr.js | fill + park awaiting_review (CAPTCHA gate) | MH |
| Workday / iCIMS / Taleo | sites/walls.js | account:'required' → park awaiting_input with human parkReason before driving | MH |
| Glassdoor | sites/glassdoor.js | context hints (selector rot risk) | NTH |
| Generic unknown-ATS drive | content/lib/ats-drive.js | account-wall/form-root/honeypot-hardened generic flow | MH |
| External handoff | background waitForExternalTarget, replay.externalTargetFromNav, MAIN-world window.open hook | LinkedIn/Indeed → company site: same-tab detect, new-tab child adoption, popup-URL recovery | MH |
| Interstitial/opener-stall breakers | content/lib/{interstitial,opener-stall}.js | break through interstitials and stalled-opener flows | MH |
| Screening answers ladder | executor.js + `/ai/answer-question` | learned memory → deterministic floor (location/residency/education/years/auth from profile, never fabricates) → AI (confidence-gated) → park | MH |
| AI apply-rescue | `/ai/apply-rescue` | token-bounded escalation for stuck flows (60s dedup, prompt-size cap) | MH |
| Résumé attach | executor + isResumeFileInput | uploads active/selected résumé incl. styled file inputs | MH |
| Site-chrome guard | isSiteChromeInput (T0) | never fills search bars / site chrome | MH |

### 3.5 Needs-you queue & self-healing
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Park with structured questions | auto_apply_tasks.park_reason + pending_questions JSON | task parks (awaiting_input/awaiting_review) with question/fieldType/options/reason | MH |
| Intake endpoint | `/auto-apply/intake` | answers → profile memory (per-profile) → all matching parked tasks auto-requeued | MH |
| Needs-you surfacing | `/auto-apply/needs-you`, dashboard + applications + queue pages | inline answer cards everywhere | MH |
| Standing operator habit | memory: feedback_autoapply_answer_screening | proactively answer screening Qs + clear needs-you queue during runs | NTH (doc) |

### 3.6 Learned memory & apprenticeship
| Feature | Where | What it does | Priority |
|---|---|---|---|
| profile_fields + qa per-profile | db.js v6 migration | FK-cascade to profiles, UNIQUE(profile_id,key_norm); EN+FR normalization; locks; seen_count; confidence | MH |
| Observer | recorder.js + `/observe` `/observe/screenshot` | always-on harvest with answer_lineage; nav_events (P2, board→ATS handoff edges, 2000/profile rolling) | MH |
| Distiller | app/src/distiller.js | demonstrations → ats_recipes + recipe_steps (ATS scope transfers to unseen companies; company overlay wins); selector-first enrichment | MH |
| Replayer | content/replay.js + executor attemptReplay | pure plan/resolve/pace; strictly additive + gated; falls back on divergence | MH |
| Reward engine | db.js recordOutcome (P6) | interview/offer email = reward; fractional confidence-weighted clipped credit ([-1,1]) to qa + recipe; suggested-link rewards HELD until confirmed | MH |
| Teach & Correct | supervise.js + `/recipe/correction` `/recipe/outcome` | live Step/Run, Fix-this picker rewrites recipe authoritatively (conf 0.95) | MH |
| EEO / credential write-boundary rail | db.js SENSITIVE_RX (~L1859) | ethnicity/race/gender/disability/veteran/criminal/DOB/SSN/passwords/payment/CVV/PIN/security-answers NEVER persisted (value, HTML, or screenshot) — enforced at DB write AND client-side | MH |
| Redaction | content/lib/redact.js | traces/exports redacted | MH |

### 3.7 Idle-only, notifications, backups
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Idle gate | extension/lib/idle-gate.js | pure rule: busy = chrome.idle 'active' OR audible tab count>0; pauses dispatch+discovery; UI banner with reason | MH |
| Native OS notifications | app/src/main.js notify (Notification API) | Action Center notification per apply outcome (gated by notifications.autoApplyDesktop) | MH |
| DB backups | `/backup`, db backupNow | manual + daily rotating (backups.keep=14) + pre-migration backups | MH |
| Backups before wipe/import | server.js | automatic safety snapshot | MH |

---

## 4. Gmail / email pipeline (`app/src/gmail.js` OAuth, `app/src/email.js` IMAP multi-provider)

| Feature | Where | What it does | Priority |
|---|---|---|---|
| IMAP + App-Password accounts | email.js, `/email/accounts` (+`/test`, `/sync`) | Gmail/Outlook/Yahoo presets + custom IMAP host/port; passwords in kv (never exported); resumable background sync every 15min; per-account synced stats | MH |
| Gmail OAuth (legacy/advanced) | gmail.js, `/gmail/{status,auth-url,sync}` | loopback desktop OAuth w/ user-supplied client; broad query (see §2.5) | NTH |
| Classifier | email.js CATEGORY_RX (ordered) | offer → rejection → strong-receipt confirmation → assessment → interview (strict invite language) → confirmation → recruiter → other; order is load-bearing (documented false-positive fixes) | MH |
| Reward sign mapping | email.js classifyEmailReward | category → reward sign for the P6 loop | MH |
| Job matching | email.js matchEmailToJob | thread/reply-chain trace-back (findJobByThread) → sender-domain + time-window + title/company scoring; ≥0.6+clear → auto (conf .7–.96); else suggested (.4–.69) | MH |
| AI disambiguation | pickEmailJob prompt, bounded | only for high-value suggested (interview/offer/assessment), capped; never forces a match | MH |
| Stage elevation | db.js elevateJobFromEmailRow + gmailStatusFromCategory | forward-only, terminal-respecting: confirmation→submitted, assessment→assessment, interview→interview_1, offer→offer, rejection→rejected (rejection may move from any non-terminal) | MH |
| Auto-create job | ensureJobForConfirmation | unmatched application_confirmation creates the job (captures applies made outside JAT) | MH |
| Suggestion review UI | detail-page email panel + `/emails/needs-confirm` `/emails/confirm` `/emails/match` | confirm/dismiss/unlink/manual-link; confirmed link releases held reward + elevates | MH |
| Reprocess stored inbox | `/emails/reprocess` | one-shot re-classify + re-match + re-elevate after classifier upgrades | MH |
| Gmail deep links | app.js gmailLink | rfc822msgid search URL (fallback threadId) opens the real message | NTH |

---

## 5. Documents & resume features

| Feature | Where | What it does | Priority |
|---|---|---|---|
| Text extraction + keywords | server.js `/documents` POST, documents.keywordCount | pdf/docx/txt extraction; top-12 keywords per doc | MH |
| Folder watch indexing | document_folders + fs watch | maxFolderFiles 2000, depth 6, role auto-detect by name, importance ranking | MH |
| Active (default) doc per role | documents.is_default | drives autofill, auto-apply attach, and tailoring source | MH |
| Résumé field extraction | app/src/resumefields.js + `/ai/resume-parse` | résumé → structured profile fields | MH |
| **Resume tailoring** | `/ai/tailor-resume` (prompts.tailorResume), detail page "Tailor resume" | AI rewrites active résumé for the job; text modal + download `resume-<company>.txt`; records `resume_tailored` event (Activity icon ✎) | MH |
| Cover letter generation | `/ai/cover-letter` | AI letter from profile+job; download | MH |
| Attachment capture from applications | documents.source='application' | files used in real applies land in the library | MH |

---

## 6. Profile system

| Feature | Where | What it does | Priority |
|---|---|---|---|
| Multi-profile | profiles table, `/profiles` | name, is_default, per-profile data JSON | MH |
| Source assignments | source_assignments JSON, `/profiles/for-source` | hostname-contains → which profile autofills/applies on that site | MH |
| 29 seed structured fields | app.js PROFILE_FIELDS | identity, contact, links, work eligibility (auth/sponsorship/citizenship/clearance), comp & experience, education, headline | MH |
| Custom fields + summary + skills + work/education history | profiles.data JSON | arbitrary keys; history arrays power the timeline chart + deterministic AI answers | MH |
| Per-profile memory scoping | qa + profile_fields profile_id FK | every memory fn scoped by profileId (reference_jat_profile_memory) | MH |
| Memory ↔ profile bridges | `/profile/from-memory`, `/profile/to-memory`, `/profile-fields/backfill` | fill-from-memory / save-to-memory / harvest all past applications | MH |
| Autofill bundle | `/autofill/bundle` | one call: profile + learned + settings for content-script fill | MH |

---

## 7. Import/export, diagnostics, AI integration

### 7.1 Data portability & diagnostics
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Export everything (JSON) | GET `/export` | full data dump; never includes API keys / OAuth secrets / kv passwords | MH |
| Import JSON | POST `/import` | full restore with fidelity (status/source/events/created_at preserved — v13.0.1 lesson) | MH |
| Import applications only | POST `/import/applications` | partial import lane | MH |
| Backup now | POST `/backup` | manual DB snapshot | MH |
| Wipe (danger zone) | POST `/wipe` | delete everything + disconnect email/Gmail, pre-backup, confirm modal | MH |
| CSV export | applications page | see §1.2 | MH |
| Logs folder | Settings (desktop) | opens `%APPDATA%/jat11-app/logs` | NTH |
| Health/pair | GET `/health`, POST `/pair` | only unauthenticated routes; token pairing | MH |
| SSE stream | GET `/stream` | live dashboard refresh (soft morph; guards against wiping in-progress edits) | MH |
| AI usage telemetry | ai_log + `/ai/usage` | per-provider meter + recent calls | MH |
| Version/updates | Settings About + electron-updater + popup banners | check/download/restart; auto every 4h; extension CWS auto-update | MH |

### 7.2 AI integration (`app/src/ai/`)
| Feature | Where | What it does | Priority |
|---|---|---|---|
| Provider chain | provider.js `run({kind,prompt,system,schema,prose})` | order from settings; first configured+working wins; every attempt logged; legacy shapes bridged | MH |
| Codex CLI (ChatGPT subscription) | codex.js | **detection ladder:** 1) `~/.codex/chrome-native-hosts.json` → codexCliPath, 2) newest `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`, 3) `codex` on PATH. **Invocation:** `codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config -s read-only -C <tmp> -m <model> [--output-schema] --output-last-message`, prompt on stdin, CODEX_HOME env; `login status` probe | MH |
| Claude Code CLI + Anthropic API | claude.js, anthropic.js | subscription via official CLI subprocess; API-key fallback | MH |
| OpenAI API | openai.js | key fallback for chatgpt slot | MH |
| Ollama local | ollama.js + hardware.js + localsetup.js | HW probe (RAM/VRAM/GPU→tier) → structured (Qwen) + prose (Gemma) recommendation; auto-setup download; try-spawn `ollama serve`; setup progress bar in Settings | MH |
| Deterministic floor | deterministic.js | zero-AI answers from profile (location/residency/education/years/relocation/auth); never fabricates, never a URL for years | MH |
| Prompt library | prompts.js | fitScore, coverLetter, tailorResume, answerQuestion, applyRescue, classifyEmail, pickEmailJob, summarizeJob, followUp, resumeParse, validateCapture | MH |
| AI endpoints | server.js `/ai/*` | generate, fit-score, cover-letter, tailor-resume, answer-question, apply-rescue, classify-email, summarize, follow-up, resume-parse, validate-capture, status, usage, local/{state,detect,setup}, connect/codex | MH |
| Callers | — | detail-page AI buttons (fit/summarize/cover/tailor/followup); executor screening-answer + apply-rescue; email disambiguation + recruiter classification; résumé import; capture validation | MH |
| Structured-output enforcement | provider + schema param | JSON-schema outputs for answer/fit/classify kinds | MH |

---

## 8. DB tables (`app/src/db.js`, PRAGMA user_version migrations, each with pre-backup)

| Table | Holds | Key columns / notes |
|---|---|---|
| `jobs` | every captured/discovered posting | id, external_id, source, status, title, company, location, job_url(+_norm), norm_key (dedup), description, compensation, work_mode, employment_type, attachments(JSON), answers(JSON), notes, next_action, due_at, needs_review, fit_score, fit_data(JSON), tags(JSON), created/updated/submitted_at |
| `events` | per-job timeline | job_id FK-cascade, type, source, timestamp, summary, data(JSON) |
| `settings` | overrides per section | section PK, value JSON (merged over config DEFAULTS) |
| `qa` | learned Q→A memory (per profile) | profile_id FK-cascade, UNIQUE(profile_id,question_norm), question, answer, seen_count, sources, answer_lineage(JSON), reward_score |
| `profiles` | user profiles | name, is_default, source_assignments(JSON), data(JSON) |
| `profile_fields` | structured learned fields (per profile) | profile_id FK, UNIQUE(profile_id,key_norm), label, locale(en/fr), value, field_type, source_job_id, source, confidence, locked, seen_count, reward_score, last_validated_at |
| `documents` | docs library | name, role(resume/cover_letter/…), file_path, text_content, keywords(JSON), size, mime, is_default, label(designation), importance, folder_id, source(upload/application/folder), last_modified, indexed_at |
| `document_folders` | linked local folders | path UNIQUE, label, role_hint, file_count, last_scan_at, enabled |
| `auto_apply_tasks` | the apply queue | job_id FK-cascade, state(queued/scheduled/running/done/failed/skipped/parked/awaiting_input/awaiting_review), mode, scheduled_at, attempts, last_error, transcript(JSON), park_reason, pending_questions(JSON), apply_route(easy-apply/external), recipe_id, route_state, submission_evidence(JSON), handoff_token; indexes on (state,scheduled_at), updated_at, job_id |
| `ai_log` | AI call telemetry | ts, provider, model, kind, ms, ok, error, prompt/response chars |
| `kv` | misc durable state | authToken, easyApplyLimitUntil/ObservedLimit, discoveryStatus, freshness tiers, saturation counters, email account creds, supervise-next flag |
| `emails` | synced mail | account_id+uid UNIQUE, message_id, thread_id, from/to, subject, snippet, body(capped), sent_at, category, matched_job_id FK SET-NULL, match_confidence, match_source(auto/suggested/manual/dismissed) |
| `ats_recipes` | apprenticeship transfer unit | profile_id FK, UNIQUE(profile_id,scope,ats,company_key), scope(ats/company), ats, site_domain, confidence, reward_score, success/fail/seen counts |
| `recipe_steps` | replay program | recipe_id FK-cascade, step_index, action(fill/select/combobox/upload/advance/wait/handoff), label_pattern, field_type, strategy, options, validation_pattern, advance_text, median_delay_ms(human pacing), confidence, selector, xpath, attrs, html, screenshot_id, source, default_value |
| `nav_events` | human navigation log | profile_id FK, session_id, url_norm, host, ats, company_key, referrer_norm, kind(visit/apply_click/step_advance/handoff/submit); rolling 2000/profile |
| `application_outcomes` | reward ledger | job_id/profile_id FK, recipe_id, reward, reward_kind(email_reply/rejection/star/punish/submitted), email_id, credited(JSON qa_ids+step_indices) |
| `punishments` | never-again rules | profile_id FK, kind(job/job_type/company), pattern, weight, decay_at(NULL=permanent) |
| `demonstrations` | full-fidelity taught steps | profile_id FK, session_id, job_id, ats, company_key, step_index, action, label(+norm), field_type, selector, xpath, attrs, html, value(rail-guarded), screenshot_id, delay_ms, source(manual/teach/correction); prune-keep-N |
| `teach_screenshots` | step screenshot ledger | path (userData/teach-shots), w, h, bytes; served path-confined via `/teach-shot/:id` |
| `discovery_batches` | discovery run ledger | provider, source, keyword, location, status, found/accepted/duplicate/rejected counts, error, diagnostics, fallback_of |
| `discovery_fallbacks` | browser-scrape fallback queue | batch_id FK, source, state, reason, claimed/completed |
| `job_discovery_provenance` | job↔batch provenance | PK(job_id,batch_id), provider, source, raw_url, apply_capability |

**Data-integrity migrations worth preserving as behaviors:** submit-truth quarantine (untrustworthy `done` → awaiting_review), race-lost verified-submission recovery from transcript evidence, per-profile memory adoption.

---

## 9. Cross-cutting invariants (non-negotiable in the rebuild)

| Invariant | Where enforced |
|---|---|
| App owns ALL data; extension stores only pairing token | architecture |
| Every route except /health + /pair requires X-JAT-Token | server.js |
| Never blind-submit — submit only on verified required-satisfied; success verified post-click | executor + signals/success.js |
| Autofill NEVER clicks submit (`autofill.autoSubmit:false` hard) | config + autofill.js |
| Credentials/payment/EEO NEVER persisted (value/HTML/screenshot) | SENSITIVE_RX at DB write boundary + client |
| Sensitive fields never auto-filled or AI-escalated | autofill.js |
| Status FSM forward-only from pipeline; manual edits free; capture re-opens terminal | lib/status.js + db.js |
| Exports never contain API keys / OAuth secrets / mail passwords | /export |
| Secrets sealed via Electron safeStorage (secretstore.js) | app |
| Dashboard mirror byte-identical (extension/app ↔ app/src/app) — or single-source it in v13 | tools/mirror.mjs |
| Cross-browser: no tabGroups/storage.session assumptions (Firefox) | background.js guards |
| Serial apply until parallel focus-steal is provably safe | parallelApplySafe kill-switch |

## 10. Known v11 gaps (do NOT need parity — context only)
- Vision (screenshot→AI) rescue: designed, not built. GGUF local weight assets: not published. Replay dry-run preview on Procedures page: deferred. Glassdoor/ZipRecruiter discovery: bot-walled without proxies. Workday/iCIMS/Taleo: park-only by design. Google Jobs: often empty live.
