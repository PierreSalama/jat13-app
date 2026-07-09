# Pillar 6 — Full Aurora UI (launch scope)

**Doc:** `v12/docs/plan/06-aurora-ui.md`
**Status:** design — implementation-ready
**Owner:** UI pillar
**Depends on:** Pillar 2 (app core / renderer runtime), Pillar 3 (apply engine state machine), Pillar 4 (discovery lanes), Pillar 5 (data layer / API server)
**Evidence base:** v11 dashboard (`extension/app/app.js`, 4,172-line monolith), the lost-but-documented v12 Aurora build (vault: `Chats/2026-07-03 — jat-v12-aurora-sibling.md`), memory `reference_jat_v1181_v1182.md` (payload bombs, SSE storms, DB churn), `feedback_jat_dashboard_mirror.md` (byte-identical mirror pain).

---

## 0. Mission

Resurrect and surpass the lost Aurora design: a deep-space WebGL galaxy that *is* the app's heartbeat, glass panels floating over it, 6 themes, animated canvas analytics, a command palette, and a Mission Control page that makes the auto-apply engine's internal state machine *watchable live*. The UI must be engine-aware from day one — it renders the app brain's lanes, workers, breakers, and caps as first-class objects, not as a refetched table.

Everything in this doc encodes the eight v11 failure modes where they touch the renderer. The two that live *primarily* in this pillar:

- **FM6 (payload bombs):** every list is a lean projection; every SSE event is a targeted row patch; heavy fields (descriptions, transcripts, snapshots) load on demand when a drawer opens. The renderer NEVER responds to an SSE event by refetching a collection.
- **FM8 (token rot):** token health is a permanent topbar affordance and a Settings section with one-click re-auth, not a buried log line.

---

## 1. Renderer stack decision

### 1.1 No framework. Vanilla ES modules + a ~200-line signal store.

**Decision: the renderer is framework-free** — native ES modules, a tiny reactive store, a hyperscript DOM builder, and keyed list patching. No React/Svelte/Vue.

Rationale (all evidence-backed):

1. The lost Aurora build was vanilla (~42k LOC, 116 files, 69/69 tests, rendered live across 3 themes) — the pattern is proven for exactly this app.
2. v11's dashboard is vanilla; Pierre's whole ecosystem is vanilla. Zero re-learning cost, zero dependency rot.
3. The perf budget (§10) wants first paint < 500 ms and a JS budget of 400 KB gz; a framework spends a third of that before the first component renders.
4. The one hard rendering problem — "don't blow away DOM the user is typing in" (v10 lesson, baked into v11 line 10) — is solved by keyed patching + focus guards, not by a VDOM.

What replaces the framework (all in `renderer/lib/`, each < 300 lines, each unit-tested):

| Module | Exports | Contract |
|---|---|---|
| `signal.js` | `signal(v)`, `computed(fn)`, `effect(fn)`, `batch(fn)` | Push-based reactivity. `signal()` returns `{get value, set value, subscribe(fn)}`. `effect` re-runs on any read signal's change; `batch` coalesces N writes → 1 flush (used by SSE patch bursts). |
| `dom.js` | `h(tag, props, ...children)`, `frag(...)`, `text(sig)` | Hyperscript. `props` accepts signals for attrs/classes → auto-updating without re-render. Event props (`onClick`) attach listeners. |
| `list.js` | `keyedList(container, itemsSignal, keyFn, renderFn, opts)` | Keyed reconciliation: move/insert/remove by key, patch in place via `renderFn(el, item)` update path. Skips patching any element containing `document.activeElement` (the v10 lesson, structural). |
| `vlist.js` | `VirtualList({rowHeight, overscan, fetchPage, renderRow, keyFn})` | Windowed rendering — see §8.2. Mandatory past 200 rows. |
| `router.js` | `route(path, mount)`, `nav(path)`, `currentRoute` (signal) | Hash router (`#/mission`, `#/jobs/:id`). Each page exports `{mount(el, params), unmount()}`. `unmount` MUST dispose effects + SSE subscriptions (leak gate, §10.4). |
| `store.js` | see §6 | The patch-applied entity cache — the FM6 enforcement point. |
| `palette.js` | `registerCommand(cmd)`, `openPalette()` | §9.1. |
| `toast.js`, `modal.js`, `drawer.js` | imperative singletons | §7. |
| `fmt.js` | dates, durations, counts, salary, statusLabel | ONE formatting module (v12 lesson from the cross-agent status-vocabulary race in the lost build: fmt.js/tokens.css/engine.js drifted — this file is generated from the shared status contract, §5.1). |

### 1.2 Build: esbuild, one pass, no dev server magic

- `renderer/` is bundled by **esbuild** (`tools/build-renderer.mjs`): entry `renderer/main.js` → `dist/renderer.js` + `dist/renderer.css`, sourcemaps in dev, minified in release. Sub-second builds; watch mode for dev.
- Shaders live as `.glsl` files imported via an esbuild text loader (they stay readable/diffable).
- **No mirror.** v11's `extension/app ↔ app/src/app` byte-identical mirror (`feedback_jat_dashboard_mirror`) exists because v11 served the same dashboard from the extension AND the app. **v12's dashboard lives ONLY in the desktop app** (`v12/app/renderer/`). The extension has its own 3-file popup (Pillar 7's concern) and never serves the dashboard. This deletes an entire failure class (edit-the-wrong-copy, forgot-to-mirror).

### 1.3 WebGL: raw WebGL2, NOT three.js — **coordinate with Pillar 2**

**Decision: the galaxy is raw WebGL2** (one program, one instanced draw call, point sprites). No three.js.

- The scene is a single full-viewport particle field with additive blending — no scene graph, no cameras-and-lights model, no loader pipeline. three.js would add ~150 KB gz (min build) to render one draw call.
- The lost Aurora build's "WebGL aurora background" was raw; it worked.
- Everything else visual (charts) is Canvas 2D (§7.4), which needs no GL at all.

**Alignment note for Pillar 2:** if any other pillar introduces three.js for a real 3D need (none is known), the galaxy can be re-hosted as a `THREE.Points` in one file (`galaxy/scene.js` is the only GL-touching module). Until such a need exists, raw WebGL2 stands. Recorded as open question OQ-1.

---

## 2. App shell & layout system

### 2.1 Shell anatomy

```
┌──────────────────────────────────────────────────────────────┐
│ topbar   [⌘K search] [run pill ▸ 12/hr] [token health ●] [⚙] │
├───┬──────────────────────────────────────────────┬───────────┤
│ r │                                              │  detail   │
│ a │              page content                    │  drawer   │
│ i │        (glass panels over galaxy)            │ (on-      │
│ l │                                              │  demand)  │
├───┴──────────────────────────────────────────────┴───────────┤
│ statusbar  [mode: live] [SSE ●] [DB 48MB] [v12.0.0 ↑]        │
└──────────────────────────────────────────────────────────────┘
   ↑ galaxy canvas: position:fixed, z-index:0, behind everything
```

- **Galaxy canvas** — `<canvas id="galaxy">`, fixed, full viewport, `z-index:0`, `pointer-events:none`.
- **Rail** (left, 64 px, expands to 220 px on hover/pin) — 12 page icons + labels, keyboard `Alt+1..9,0,-,=`. Active page gets an aurora-gradient indicator bar.
- **Topbar** (48 px) — palette trigger (`Ctrl+K` and click), the **run pill** (live engine summary: state dot, applies/hr, cap ring — click → Mission Control), the **token-health dot** (green/amber/red aggregate of Gmail/CWS/AI-key health — click → Settings § Tokens), profile switcher.
- **Statusbar** (28 px) — bridge/API mode, SSE connection state (§6.4), DB size, app version + update-available chip (electron-updater state).
- **Content** — the routed page. CSS grid: `grid-template-columns: var(--rail-w) 1fr auto`.
- **Detail drawer** (right, 420–560 px, resizable) — the ONLY place heavy data renders. Opens on row click on any list page; fetches detail on open (FM6).

Class contract (a lost-build bug was a `.shell` ↔ `.app-shell` mismatch that broke the grid — lock it): the root layout class is **`.shell`**, children are `.shell-rail`, `.shell-topbar`, `.shell-content`, `.shell-drawer`, `.shell-statusbar`. A layout test asserts these exact classes exist in both `index.html` and `shell.css`.

### 2.2 Glass panel system

`.glass` is the core surface:

```css
.glass {
  background: color-mix(in oklab, var(--surface) 72%, transparent);
  border: 1px solid var(--glass-edge);
  border-radius: var(--r-lg);            /* 14px */
  box-shadow: var(--glass-shadow);
}
.glass--blur { backdrop-filter: blur(18px) saturate(1.3); }
```

**Backdrop-filter budget (hard rule): at most 3 `.glass--blur` surfaces live at once.** `backdrop-filter` over an animated WebGL canvas forces a per-frame readback-composite; stacking it across 30 panels is how you lose 60 fps. Allocation: topbar, the drawer, and one modal/palette layer get real blur. All in-content panels use plain `.glass` (72% alpha surface over the galaxy reads as glass without the compositor tax). A stylelint rule (`tools/lint-css.mjs`) fails the build if `backdrop-filter` appears outside `shell.css`/`overlay.css`.

### 2.3 Spacing/typography tokens

- Space scale: `--s-1:4px --s-2:8px --s-3:12px --s-4:16px --s-5:24px --s-6:32px --s-7:48px`.
- Radii: `--r-sm:8px --r-lg:14px --r-xl:20px --r-pill:999px`.
- Type: `--font-ui: "Inter var", system-ui` (bundled woff2, no CDN), `--font-mono: "JetBrains Mono", ui-monospace` (transcripts, snapshots, tokens). Scale: 12/13/15/18/24/34 px; KPI numerals 34 px `font-variant-numeric: tabular-nums`.
- All animations honor `prefers-reduced-motion` (§10.3).

---

## 3. Theme system

### 3.1 Mechanics

- Six themes, each a block of CSS custom properties under `:root[data-theme="<id>"]` in `renderer/styles/themes.css`. Switching = set `document.documentElement.dataset.theme` + persist via `PUT /api/settings/ui {theme}`.
- **One token vocabulary** (every theme defines every token — a missing token is a build error via `tools/lint-themes.mjs` which parses themes.css and diffs token sets):

```
--bg           deep page color behind the galaxy
--surface      glass base color
--glass-edge   1px border tint
--text / --text-dim / --text-faint
--accent / --accent-2 / --accent-3     (gradient endpoints)
--ok / --warn / --danger / --info
--chart-1..--chart-6                    (categorical series)
--galaxy-core / --galaxy-arm / --galaxy-dust / --galaxy-pulse   (fed to shaders, §4.4)
--lane-linkedin / --lane-indeed / --lane-ats                    (per-lane identity colors)
```

### 3.2 The six themes

| id | mode | character | accent family |
|---|---|---|---|
| `aurora` (default) | dark | deep indigo space, teal→violet aurora | teal / violet / magenta |
| `nebula` | dark | warmer purple-pink nebula, denser dust | magenta / orange |
| `ember` | dark | near-black, amber/red embers, low dust | amber / red |
| `arctic-light` | light | pale ice blue, galaxy as faint silver mist | steel blue / cyan |
| `atelier-tribute` | light | v11 "Atelier" homage: paper white, ink text, restrained galaxy | ink / burgundy |
| `matrix` | dark | phosphor green on black, mono-hue particles | green (3 tones) |

Light-theme galaxy treatment: same particle sim, but the fragment shader multiplies against a light-mode uniform (`uLightMode`) → particles render as *dark-on-light silver mist* at ~35% the dark-mode intensity, and the pulse becomes a soft accent-colored bloom. This is a shader uniform switch, not a second shader (OQ-5 covers final art direction sign-off).

### 3.3 Theme → shader bridge

On theme apply, `theme.js` reads the four `--galaxy-*` tokens via `getComputedStyle`, converts to linear RGB, and writes them to the galaxy's uniform block (`galaxy.setPalette({core, arm, dust, pulse})`). Charts likewise re-read `--chart-*` and redraw. **No JS color tables** — CSS is the single source of color truth (the lost build's tokens.css/fmt.js drift lesson).

---

## 4. The WebGL galaxy

### 4.1 Files

```
renderer/galaxy/
  galaxy.js        public API (init, setPalette, pulse, setQuality, pause, resume, dispose)
  sim.js           CPU-side spiral distribution + drift parameters
  scene.glsl.vert  point-sprite vertex shader
  scene.glsl.frag  additive soft-particle fragment shader
  quality.js       tier detection + FPS governor
```

### 4.2 Rendering approach

- **One WebGL2 context**, `{alpha:true, antialias:false, powerPreference:'low-power'}` (low-power: the galaxy must not spin up the dGPU fan for a background; on the RTX 3080 it hits 60 fps in low-power mode trivially).
- Particles are a static VBO of N points generated once by `sim.js`: 4-arm logarithmic spiral (`r = a·e^(bθ)` + gaussian arm scatter + a central bulge population + a sparse halo). Per-vertex attributes: `position(vec2 in galaxy-space)`, `size`, `hueMix` (core↔arm lerp factor), `phase` (twinkle offset), `depth` (parallax layer 0..2).
- **All motion is in the vertex shader** — uniform `uTime` drives slow differential rotation (`θ += ω(r)·t`, inner faster than outer) and per-particle twinkle. CPU per frame does exactly one `uniform1f` + one `drawArrays`. No per-frame buffer writes.
- Fragment: radial-falloff soft disc, additive blending (`ONE, ONE`), premultiplied against theme palette. A faint procedural dust layer is a second fullscreen triangle with 3-octave value noise at 0.25× resolution, upscaled (cheap nebula).
- Parallax: `depth` attribute scales a `uParallax` vec2 fed from a lerped mouse position (max 8 px drift — ambient, not a gimmick). Disabled under reduced motion.

### 4.3 The pulse (the signature moment)

`galaxy.pulse({kind, laneColor})` — called by the store when SSE delivers `apply.result {outcome:'submitted'}` (and a softer variant on `discovery.yield`):

- A ring impulse: uniform `uPulse[4]` (up to 4 concurrent: `{t0, strength, colorIdx}`); vertex shader adds a radial displacement + brightness term `strength·e^(-(d-v·(t-t0))²/w)` — a luminous wave propagating outward from the core over ~2.4 s.
- Submitted = full-strength pulse in `--galaxy-pulse`; offer/interview status changes = double pulse; discovery yield = 25% strength in the lane color.
- Reduced motion / quality tier 0: pulse becomes a 300 ms CSS glow on the run pill instead.

### 4.4 Quality tiers & the FPS governor (Dad's machine is real)

`quality.js` picks an initial tier, then governs:

| Tier | Particles | Dust layer | DPR cap | Target |
|---|---|---|---|---|
| 3 (RTX-class) | 45,000 | on, 0.25× | 2.0 | 60 fps |
| 2 (mainstream) | 22,000 | on, 0.2× | 1.5 | 60 fps |
| 1 (weak iGPU) | 8,000 | off | 1.0 | 30 fps |
| 0 (fallback) | — | — | — | static CSS gradient + pre-rendered starfield PNG layer |

- Initial tier: `WEBGL_debug_renderer_info` string heuristics + `deviceMemory`; then the governor samples a 5 s rolling FPS and steps the tier down if p50 < target−10 (never steps up mid-session; persists the settled tier to settings).
- Tier 0 also engages when WebGL context creation fails or `webglcontextlost` fires twice (context-loss handler rebuilds once, then falls back).
- **Pause discipline:** `renderer.hidden` (document.hidden) OR Electron window occlusion (Pillar 2 forwards `browser-window`'s `hide`/`show`/occlusion events over IPC as `win.visibility`) → `galaxy.pause()` stops the rAF loop entirely. The galaxy must cost 0 CPU/GPU when the app is minimized — this app runs 24/7 next to the apply engine.
- Settings → Appearance exposes the tier override (`Auto / High / Medium / Low / Off`).

---

## 5. Page inventory (12 pages)

Route table, in rail order. "Data" columns name the exact contracts from §6.5.

| # | Route | Page | One-line job |
|---|---|---|---|
| 1 | `#/mission` | **Mission Control** | Live run theater: lanes, workers, gauges, breakers |
| 2 | `#/applications` | Applications | Every job, lean virtualized table + detail drawer |
| 3 | `#/pipeline` | Pipeline | Kanban across the 12-status FSM |
| 4 | `#/needs-you` | Needs-You Inbox | Answer screening questions inline; answers → memory |
| 5 | `#/discovery` | Discovery Supply | Per-source lanes: yield, freshness, gates, saturation |
| 6 | `#/emails` | Email & Status Feed | Matched emails → status moves; Gmail health |
| 7 | `#/analytics` | Analytics | Funnel, sankey, heatmap, trends, source ROI |
| 8 | `#/goals` | Goals & Streaks | Daily/weekly targets, streak calendar, pace |
| 9 | `#/profile` | Profile & Memory | Profile fields + learned Q&A browser/editor |
| 10 | `#/documents` | Documents | Resumes/cover letters, folder scan, usage stats |
| 11 | `#/adapters` | Site Adapters | Recipe versions, health, per-host success rates |
| 12 | `#/settings` | Settings | Tokens, caps, pacing, themes, import, danger zone |

Overlays available everywhere: command palette, toasts, detail drawer, confirm modals.

### 5.1 Shared status contract

The 12-value job-status FSM survives from v11 verbatim (`started, submitted, contacted, assessment, interview_1, interview_2, interview_final, offer, hired, rejected, withdrawn, ghosted`) — the v11 importer (Pillar 5) maps 1:1. The task/queue state vocabulary comes from Pillar 3's state machine. **Both vocabularies are consumed from ONE generated module**: Pillar 5 owns `shared/contracts/status.json`; `tools/gen-contracts.mjs` emits `renderer/lib/fmt.status.js` (+ the engine's copy). The lost build's 12-vs-7 status race is thereby impossible — there is no hand-written second copy. (OQ-2: Pillar 3 must ratify the task-state list.)

### 5.2 Page-by-page design

#### 1. Mission Control (`#/mission`) — the run theater

Layout: a 3-row grid over the galaxy.

**Row 1 — command strip (KPI cards, count-up):**
- `Applies today` (with the LinkedIn 50/24h **cap ring** — an arc gauge that turns amber at 40, red at 48; per-lane rings for Indeed/ATS with their own caps),
- `Verified submits /hr` (rolling 60 min),
- `Queue depth` (per-lane mini-bars),
- `Needs you` (count, red if > 0, click → page 4),
- `Session` (started-at, uptime, submitted/parked/failed tally).
- The master **Run/Pause** control lives here (and in the palette): a single switch per lane + a global one. State comes from `run.overview`; optimistic UI is forbidden — the switch reflects engine-confirmed state only (v11 lesson: UI said running while the engine was starved).

**Row 2 — lanes.** One `LaneCard` per source lane (LinkedIn / Indeed / ATS-boards — Pillar 3/4's lane model):
- Lane header: identity color, state (running / paused / breaker-open / cap-reached), throughput sparkline (attempts vs verified submits, 2 h window), supply health chip from discovery (`fresh / aging / starved` — starvation is a first-class visible state, FM4).
- Inside: **WorkerCards**, one per in-flight apply. Each shows: job title+company, the engine's current step (`navigate → snapshot → plan → fill → advance → review → submit → verify`, rendered as a step tracker driven by `run.worker` events), elapsed (amber > 90 s, red > 3 min), and a **live snapshot ticker** — the last DOM-snapshot text summary the extension sensor sent (e.g. `form: "Contact info" · 4 fields · 1 unanswered · advance:"Next" enabled`), monospace, updating per step. This is the "watch it think" feature: the app brain's actual perception, not a guess.
- Worker card actions: `Watch` (opens the drawer with the full rolling step transcript, fetched on open), `Skip`, `Park`.

**Row 3 — system strip:**
- **Breaker board**: one chip per host breaker (`cloudflare:indeed.com — open, cools 12:40`, `linkedin rate — half-open`) from `breaker` events (FM7 made visible: a parked Cloudflare wall shows here honestly instead of a 6-min silent hang).
- **Event ticker**: last 50 engine events (virtualized), each row one line: time, lane dot, event, job. Click → drawer.
- Galaxy pulses on every verified submit (§4.3).

Data: `GET /api/run/overview` on mount; then SSE `run.lane`, `run.worker`, `apply.result`, `breaker`, `queue.depth` patches only. No polling while SSE is up (statusbar shows SSE state; 30 s poll fallback only while SSE is down — v11's proven pattern).

#### 2. Applications (`#/applications`)

- **Lean virtualized table** (VirtualList): columns `status chip · title · company · location · source dot · fit · applied-at · route`. Row payload is the `JobListItem` projection ONLY (§6.5) — descriptions never ride the list (FM6; v11's 16 MB `/jobs` is the anti-pattern).
- Toolbar: text search (server-side `q=`, debounced 250 ms), status multi-select, source filter, date range, saved views (persisted to settings). Count comes from `X-Total-Count`; infinite scroll via cursor.
- Bulk bar (appears on selection ≥ 1 — with the v11 `[hidden]`-vs-`display:flex` bug encoded as a test): bulk status change, bulk archive, CSV export (server-generated, formula-injection-guarded — v11.14 lesson carried over).
- Row click → **detail drawer**: fetches `GET /api/jobs/:id` (full: description, timeline of application_events, answers given, documents used, task history). Tabs: `Overview · Timeline · Q&A · Emails · Raw`. The drawer never auto-refreshes while open; a "Data changed — refresh" pill appears on a matching `job.patch` (v10/v11 lesson, verbatim).

#### 3. Pipeline (`#/pipeline`)

- Kanban, one column per active status (`submitted → contacted → assessment → interview_1 → interview_2 → interview_final → offer`) + collapsible `started` intake and terminal rail (`hired / rejected / withdrawn / ghosted` as compact counters).
- Column payload: `GET /api/pipeline` returns per-status `{count, cards: JobCard[≤50]}` (JobCard = title/company/days-in-stage/next-action) + `hasMore`; "show more" pages within a column. A 4,153-job DB must not render 4,153 cards (FM6).
- Drag between columns → `PATCH /api/jobs/:id {status}` with optimistic move + rollback on failure toast. Status-change reasons prompt (modal) only for terminal moves.
- Stage-age heat: card left border shifts `--text-faint → --warn → --danger` at 7/21 days-in-stage.

#### 4. Needs-You Inbox (`#/needs-you`) — decision 4's home

- List of parked/awaiting-input tasks grouped by blocking reason: `screening question · captcha/verification · login wall · resume choice · review-before-submit`.
- **Screening question card (the important one):** question text, the field type (radio options / text / numeric), the engine's best suggestion with its confidence (`profile 0.92` / `memory 0.81` / `AI 0.67` — source-labeled), and an inline answer control. Submit does `POST /api/needs-you/:taskId/answer {answer, save:true}` → answer is written to per-profile memory (`qa` store, profile-scoped per `reference_jat_profile_memory`) **so the question is never asked again**, and the task re-queues. Keyboard flow: `j/k` next/prev, `Enter` accept suggestion, `e` edit — the whole queue should be clearable hands-on-keyboard in seconds (this is the standing "clear the needs-you queue" habit, productized).
- Captcha/login cards are **honest parks** (FM7): they show the wall type, a `Open in browser` button (deep-links the real tab/URL), and NO auto-solve affordance. Done/`awaiting_review` cards offer one-click `Confirm submitted`.
- Badge count in the rail + topbar run pill; `needsyou.added` SSE prepends live.

#### 5. Discovery Supply (`#/discovery`)

- One panel per source lane (LinkedIn jobspy / Indeed jobspy / Greenhouse / Lever / Ashby / extension-scrape), each showing: last-run time, **yield history** (found → keyword-gate → location-gate → enqueued, as a mini funnel per sweep — the 14,550→1,976→155→47 shape from v11.81 made visible), freshness-window state, saturation flag, next scheduled run, and the per-source gate state (FM4: per-source lanes are visibly independent; a starved LinkedIn lane says **STARVED** in red with "last fresh batch 3 h ago").
- Telemetry lists show **yield events only** — the API contract (Pillar 4/5) already records batches only on yield; the UI additionally never renders empty-scan rows (belt and suspenders on the 12.8k-junk-rows lesson).
- Seed manager (ATS boards): virtualized token list (113 seeds) with per-token liveness (`ok / dead / rate-limited`), add/verify token inline (`POST /api/discovery/seeds/verify`).

#### 6. Email & Status Feed (`#/emails`)

- Two panes: matched-email feed (email → matched job → status move it caused, as connected cards) and an unmatched-but-classified pane (rejections/interviews the matcher couldn't pin — with a "link to job" picker; v11.48 lesson: surface what the query fetched so sender-domain gaps are visible).
- **Gmail health header**: last sync, query window, token state; `needsAuth` renders a red banner with a one-click `Reconnect Gmail` (opens the OAuth flow via Pillar 2 IPC) — FM8's most-burned token gets the loudest UI.

#### 7. Analytics (`#/analytics`)

- All charts are the canvas chart kit (§7.4), all data pre-aggregated server-side (`/api/analytics/*`) — the renderer never aggregates raw rows.
- Boards: **Funnel** (submitted→responded→interview→offer w/ conversion %), **Sankey** (source → route → outcome), **Heatmap** (applies by weekday×hour, 90 d), **Line** (applies + verified submits, 14/30/90 d), **Bars** (per-source attempts vs submits — the honest ceilings chart), **Donut** (park reasons). Range picker re-queries; charts animate in with 400 ms ease-out draws (skipped under reduced motion).

#### 8. Goals & Streaks (`#/goals`)

- Daily/weekly apply targets (default: 40/day supervised — inside the honest 80–140 ceiling), streak calendar (GitHub-style year grid, canvas), current streak + best streak count-ups, and **pace projection** ("at 12/hr you'll hit today's 40 by 3:10 pm"). Goal edits `PUT /api/goals`. `goal.progress` SSE ticks the ring live; hitting a goal fires a full-strength galaxy pulse + toast.
- Data lives in v12's own store (Pillar 5's `jat12`-successor tables), not the shared job data.

#### 9. Profile & Memory (`#/profile`)

- Profile editor (contact/work-auth/salary/notice fields) + **the memory browser**: virtualized, searchable table of the imported 1,614 profile_fields + 2,314 qa rows, profile-scoped, columns `question · answer · source (harvested/taught/AI) · confidence · uses · last-used`. Inline edit/delete (delete = the "unlearn a bad answer" affordance v11 never had). EEO/demographic rows are never present (server never stores them — the UI shows a static note explaining why).
- Profile switcher (multi-profile: Pierre + Dad's machine each have their own; switcher only lists local profiles).

#### 10. Documents (`#/documents`)

- Grid of resumes/cover letters with per-doc usage counts ("attached to 61 applications"), folder-scan status, default-resume star, drag-drop upload. Preview in drawer (PDF → Pillar 2's renderer; no external fetch).

#### 11. Site Adapters (`#/adapters`)

- The FM2 surface. Table of installed adapter recipes: `host · version · channel (bundled/hot-updated) · last-updated · 7-day success rate · step-graph size`. Row → drawer: recipe metadata, per-step success/failure counts, last 5 failure fingerprints (e.g. the "form disappeared after advancing" class), and a `Roll back to bundled` action.
- **Launch scope = read-only + rollback.** In-app recipe *editing* is post-launch (OQ-3); the hot-update path itself is Pillar 3/4's contract — this page is its cockpit.
- An adapter whose success rate drops > 30% in 24 h raises a topbar warning chip (early-warning for the next LinkedIn DOM shift, instead of discovering it via 155 identical failures).

#### 12. Settings (`#/settings`)

Sections (left sub-nav): **Tokens & Connections** (Gmail OAuth, AI provider key, CWS token, v11-import pairing — each with state dot, expiry countdown where known e.g. "unverified Google app ≈ 7 d", last-success time, and a one-click re-auth button; FM8's home), **Auto-apply** (per-lane caps, pacing — display-only mirrors of the scheduler's single source of truth with an edit form that PATCHes the app config; the UI never computes pacing, FM3), **Appearance** (theme grid with live mini-previews, galaxy quality, reduced-motion override), **Discovery** (keywords, locations, boards, freshness), **AI** (provider, `aiAnswerConfidenceMin` slider, default 0.65 carried from v11), **Import** (the v11 importer wizard: locate `%APPDATA%\jat11-app\jat.db`, "v11 must be stopped" pre-check with live process detection, dry-run diff → import report: 4,153 jobs / 82 docs / 3,928 memory rows / 497 emails), **Data** (retention windows, DB size, backup-now, export), **Danger zone** (wipe with typed confirmation; backup-first, enforced server-side).

---

## 6. Data layer: store, SSE, and contracts

### 6.1 The store (`renderer/lib/store.js`) — FM6's enforcement point

A normalized entity cache with patch-application as the ONLY mutation path from the network:

```js
store.collection('jobs', {key:'id'})       // → {items: signal<Map>, patch(row), remove(id), upsertPage(rows)}
store.singleton('runOverview')             // → {value: signal, patch(partial)}
```

Rules (encoded as code review checklist + an eslint custom rule banning `fetch` outside `api.js`):

1. All HTTP goes through `renderer/lib/api.js` (`api.get/post/patch` — adds `X-JAT12-Token`, times out at 10 s, surfaces errors as toasts).
2. **SSE handlers may only call `store.*.patch/remove/upsertPage` — never `api.get` on a collection.** The one sanctioned exception: a `detail-stale` pill lets the *user* refetch an open drawer.
3. Pages read signals; they never keep private copies of entity data.
4. `batch()` wraps every SSE message so a multi-row patch renders in one frame.

### 6.2 SSE channel

One `EventSource('/api/events?token=…')` owned by `renderer/lib/sse.js`. Reconnect: exponential backoff 1→30 s, `Last-Event-ID` supported (Pillar 5 keeps a 500-event replay ring so a 30 s blip loses nothing; longer gaps trigger the *targeted* stale-marking below, not a global refetch).

On reconnect after a gap beyond the replay ring: `sse.js` marks collections stale → each *mounted* page refreshes only its own first page (one lean request per visible page, not the v11 storm).

### 6.3 SSE event vocabulary (proposed — Pillar 3/5 must ratify, OQ-2)

Every event is a **patch, ≤ 4 KB**, `{type, data}`:

| Event | Payload | Consumer |
|---|---|---|
| `job.patch` | `{id, changed:{status?, appliedAt?, …lean fields only}}` | jobs collection, pipeline, drawer-stale pill |
| `job.new` | `JobListItem` | jobs, pipeline intake |
| `apply.result` | `{taskId, jobId, outcome, lane, verified}` | Mission Control tally, galaxy pulse |
| `run.lane` | `{laneId, state, throughputHr, capUsed, capMax, supplyHealth}` | LaneCards, run pill |
| `run.worker` | `{laneId, workerId, jobId, step, stepIdx, snapshotSummary, elapsedMs}` | WorkerCards |
| `run.overview` | partial of the overview singleton | command strip |
| `queue.depth` | `{laneId, depth}` | lane mini-bars |
| `breaker` | `{host, state:'open'|'half'|'closed', untilTs, reason}` | breaker board |
| `needsyou.added` / `needsyou.resolved` | `{taskId, kind, question?}` | inbox, badges |
| `discovery.yield` | `{source, found, gated, enqueued, ts}` — **emitted on yield only** | discovery page |
| `email.matched` | `{emailId, jobId, statusMove?}` | email feed |
| `goal.progress` | `{goalId, current, target}` | goals ring |
| `token.health` | `{service, state:'ok'|'expiring'|'dead', detail}` | topbar dot, settings |
| `adapter.health` | `{host, version, successRate24h}` | adapters page chip |

### 6.4 Connection-state UX

Statusbar SSE dot: green (open), amber (reconnecting, shows attempt), red (down > 60 s → the 30 s poll fallback engages, per-page, lean endpoints only). Never a blocking modal — the app degrades, it doesn't nag.

### 6.5 Lean projections (request shapes the UI depends on)

Owned by Pillar 5; the UI contract is:

```
JobListItem  = {id, title, company, location, status, source, applyCapability,
                route, fitScore, createdAt, appliedAt}            // ≈ 300 B/row
JobDetail    = JobListItem + {description, salary, url, answers[], events[],
                documents[], emailIds[]}                          // drawer only
JobCard      = {id, title, company, daysInStage, nextAction}      // pipeline
TaskListItem = {id, jobId, state, lane, reason, updatedAt, lastLog, hasTranscript}
TaskDetail   = TaskListItem + {transcript, snapshotHistory[]}     // GET /api/tasks/:id, drawer only
```

Hard caps the UI asserts in an integration test (`tests/ui-payloads.test.mjs`, hits a seeded 5,000-job DB): `GET /api/jobs?limit=100` < 64 KB; `GET /api/pipeline` < 128 KB; `GET /api/run/overview` < 16 KB; any SSE frame < 4 KB. **A payload regression is a failing build**, not a slow afternoon (the v11.82 playbook, turned into a gate).

---

## 7. Component library (`renderer/components/`)

Each component: one file, `create<Name>(props) → {el, update(props), dispose()}`, no globals, themed via tokens only.

### 7.1 Primitives
`GlassPanel` (+`--blur` variant, budget-linted), `Btn` (primary/ghost/danger, loading state), `Chip`/`StatusChip` (status-token colored), `Field` (label+input+error), `Select`, `Toggle`, `SegmentedControl`, `Tabs`, `Tooltip` (delay 400 ms, no blur), `EmptyState` (illustrated, per-page copy), `Kbd`.

### 7.2 Data display
`KpiCard` (count-up via rAF ease-out over 800 ms, tabular-nums, delta arrow; reduced-motion → instant), `CapRing` (SVG arc gauge, amber/red thresholds), `Sparkline` (canvas, 120×28), `VirtualTable` (VirtualList + column defs + sticky header + row selection), `Timeline` (application events), `SnapshotTicker` (monospace one-liner, fade-swap on update), `StepTracker` (the worker step graph), `LaneCard`, `WorkerCard`, `BreakerChip`, `StreakGrid` (canvas year grid).

### 7.3 Overlays
`drawer.js` (right panel, resizable, `Esc` closes, focus-trapped, fetch-on-open callback), `modal.js` (confirm/prompt/custom; typed-confirmation variant for danger zone), `toast.js` (top-right stack, 4 s, action button variant, error toasts persist until dismissed), `palette.js` (§9.1).

### 7.4 Chart kit (`renderer/charts/`)

Canvas 2D, one module per chart: `funnel.js, sankey.js, heatmap.js, line.js, bars.js, donut.js` + shared `chart-core.js` (DPR-aware sizing via ResizeObserver, theme token resolution, tooltip layer, 400 ms entry animation, hit-testing). API:

```js
const c = createChart('sankey', canvasEl, {data, options});
c.setData(data); c.setTheme(); c.dispose();
```

No chart library dependency — the six charts existed in the lost build and are well-bounded. Charts redraw only on `setData`/`setTheme`/resize — never on a timer.

---

## 8. Virtualization & list discipline

### 8.1 The rule
**Any list that can exceed 200 rows renders through `VirtualList`. No exceptions.** (Applications, memory browser, event ticker, seed list, email feed, queue history.) A dev-mode guard in `keyedList` throws past 250 children with "use VirtualList".

### 8.2 `VirtualList` contract

Fixed row height per instance (fast path; measured variable-height is out of launch scope — drawer content isn't virtualized, lists are uniform). Windowing math: `start = floor(scrollTop/rowH) − overscan(8)`; renders ≤ `ceil(viewport/rowH)+16` rows into an absolutely-positioned window inside a full-height spacer. Data source is `fetchPage(cursor)` against lean endpoints; pages cached in the store; scroll position preserved across route changes (per-page `sessionStorage`). Keyboard: up/down/PageUp/Home; `aria-rowcount`/`aria-rowindex` set.

---

## 9. Command palette & keyboard layer

### 9.1 Palette (`Ctrl+K`)

- Fuzzy matcher (subsequence + word-boundary bonus, ~40 lines, no dep) over a command registry.
- Command groups: **Navigate** (12 pages), **Run** (`Start/Pause lane…`, `Skip current worker`, `Answer next question` → jumps into Needs-You flow), **Find job** (typing ≥ 3 chars queries `GET /api/jobs?q=&limit=8` inline, Enter opens drawer), **Theme** (6 entries, live-preview on highlight), **Ops** (`Backup now`, `Reconnect Gmail`, `Copy diagnostics`).
- `registerCommand({id, title, group, keywords, hotkey?, run, when?})` — pages register on mount, dispose on unmount. `when()` hides contextless commands.
- Renders in the blur-budgeted overlay layer; opens < 50 ms (registry is in-memory; the only network is the job search).

### 9.2 Global keys
`Ctrl+K` palette · `Alt+1..=` pages · `j/k/Enter/e` in Needs-You · `Esc` closes topmost overlay · `Ctrl+Shift+K` (Electron `globalShortcut`, reserved v12 identity) show/hide window — registered by Pillar 2, documented here.

---

## 10. Performance budget (enforced, not aspirational)

### 10.1 Budgets

| Metric | Budget | Gate |
|---|---|---|
| Cold start → first paint | < 500 ms | `tests/perf-boot.test.mjs` (Playwright-electron, CI) |
| Cold start → interactive (route mounted, first data) | < 2 s | same |
| Renderer JS (gz) | < 400 KB | esbuild metafile assert in build script |
| CSS (gz) | < 80 KB | same |
| Galaxy frame time | p95 < 8 ms @ tier 3 (60 fps headroom) | dev overlay + manual gate per release |
| SSE patch → paint | < 16 ms (1 frame) | store batch test |
| Any list page with 5,000 seeded jobs: scroll jank | 0 long tasks > 50 ms | Playwright trace assert |
| Renderer heap after 1 h simulated events | < 300 MB, no monotonic growth | leak harness (§10.4) |
| Any REST payload the UI requests | caps in §6.5 | `ui-payloads.test.mjs` |

### 10.2 Startup sequence (how < 2 s happens)
1. `index.html` ships the shell skeleton + critical CSS inline → first paint is the shell + static gradient (galaxy tier detection hasn't run yet).
2. `main.js` boots store + SSE + router, mounts the route (Mission Control default), fires its ONE overview request.
3. Galaxy initializes *after* first data paint (`requestIdleCallback`) — the wow layer never blocks the work layer.
4. Fonts are preloaded woff2 with `font-display: optional` fallback to system-ui (no FOIT).

### 10.3 Reduced motion & quiet mode
`prefers-reduced-motion` OR the Settings toggle: galaxy static (tier 0 visual), no count-ups, no chart entry animation, pulses → run-pill glow. Everything remains fully functional — motion is decoration here, never information's only carrier.

### 10.4 Leak discipline
Every page's `unmount()` must dispose effects, SSE subscriptions, ResizeObservers, and rAF loops. `tests/leak.test.mjs` route-cycles all 12 pages ×50 under simulated SSE load and asserts heap plateau + zero orphaned listeners (via `getEventListeners` in CDP). This is the structural answer to "the app got unbearably slow over a long run" — the renderer half of it.

---

## 11. File tree (renderer slice of the repo)

```
v12/app/renderer/
  index.html                shell skeleton + critical CSS
  main.js                   boot: store, sse, router, theme, galaxy
  styles/ reset.css tokens.css themes.css shell.css components.css
  lib/    signal.js dom.js list.js vlist.js router.js store.js api.js
          sse.js palette.js toast.js modal.js drawer.js fmt.js
          fmt.status.js (GENERATED — do not edit)
  galaxy/ galaxy.js sim.js quality.js scene.glsl.vert scene.glsl.frag
  charts/ chart-core.js funnel.js sankey.js heatmap.js line.js bars.js donut.js
  components/ (…§7 inventory, one file each)
  pages/  mission.js applications.js pipeline.js needs-you.js discovery.js
          emails.js analytics.js goals.js profile.js documents.js
          adapters.js settings.js
tools/    build-renderer.mjs lint-css.mjs lint-themes.mjs gen-contracts.mjs
tests/    ui-payloads.test.mjs perf-boot.test.mjs leak.test.mjs
          store.test.mjs vlist.test.mjs palette.test.mjs charts.test.mjs
          layout-classes.test.mjs
```

No `mirror.mjs`. No copy of the dashboard anywhere else. The extension popup (Pillar 7) imports nothing from `renderer/`.

---

## 12. Build order (UI pillar milestones)

1. **M1 — skeleton:** lib/ primitives (signal/dom/list/router/store/api/sse) + shell + tokens + 2 themes (aurora, arctic-light) + Settings page against Pillar 5's first endpoints. *Exit: shell renders live data, SSE patches a KPI.*
2. **M2 — work surfaces:** VirtualList, Applications + drawer, Pipeline, Needs-You (the answer-to-memory loop end-to-end). *Exit: Pierre can triage on v12 UI alone.*
3. **M3 — the theater:** Mission Control bound to the engine's run events; breaker board; run pill. *Exit: a live run is watchable.*
4. **M4 — aurora:** galaxy (tiers, pulse, palette bridge), remaining 4 themes, chart kit + Analytics, Goals. *Exit: the wow is real at 60 fps.*
5. **M5 — completeness + gates:** Discovery, Emails, Profile/Memory, Documents, Adapters; palette command registry full; all perf/leak/payload gates green in CI.

---

## 13. Open questions

- **OQ-1 (Pillar 2):** ratify raw-WebGL2-no-three.js, and confirm Electron window-occlusion events are forwarded over IPC (`win.visibility`) so the galaxy can hard-pause.
- **OQ-2 (Pillars 3/5):** ratify the SSE event vocabulary (§6.3) and the task-state list feeding `shared/contracts/status.json`; the UI generates `fmt.status.js` from it.
- **OQ-3 (Pierre):** Adapters page — is read-only + rollback acceptable at launch, with in-app recipe editing post-launch?
- **OQ-4 (Pillar 5):** confirm the 500-event SSE replay ring (`Last-Event-ID`) is in the API server's launch scope; the reconnect design leans on it.
- **OQ-5 (Pierre):** light-theme galaxy art direction — "silver mist at 35% intensity" needs a look-see once M4 renders; alternative is galaxy-off-by-default on light themes.
