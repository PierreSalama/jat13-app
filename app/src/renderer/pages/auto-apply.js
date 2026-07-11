// Auto-Apply — mission control (01-ARCHITECTURE §5, Operate). Stage 3 goes LIVE: start/stop full
// SUPERVISED auto-apply (the lane scheduler + pump), then watch it work —
//   · the live run theater (per-run transcript + "what the robot sees"), kept from Stage 2
//   · caps + pacing rings per lane vs the rolling-24h ledger cap
//   · the fit-ordered QUEUE with the skip-floor decisions shown (each skip carries its reason)
//   · the HONEST-RATE panel — per-lane submitted / parked / failed / skipped, with WHY
//   · the DISCOVERY STRIP — per-source yield / freshness / saturation / breaker
// Everything polls together every ~1.5s and dies on route change (ctx.poll / ctx.signal).
//
// Contract (integrator wires these — see server/routes-auto.ts):
//   POST /api/auto/start | /api/auto/stop     → ok(AutoState)  — supervised scheduler on/off
//   GET  /api/auto/state                       → ok({ running, lanes:[…], activeRun? })
//   GET  /api/auto/queue                       → ok({ upcoming:[…], skipped:[…] })
//   GET  /api/discovery/status                 → ok({ enabled, sources:[…] })
//   POST /api/discovery/run                    → ok({ started:true }) — kick one sweep
//   POST /api/apply/one { applicationId }       → ok({ runId }) — drive ONE chosen job (Stage-2 spine)
//   GET  /api/runs?limit=N · /api/runs/:id/steps→ the theater + history
import { el, $, esc, icon, num, fmtAgo, fmtTime, pageHead, toast, errToast, openOverlay } from '../lib/dom.js';
import { api } from '../lib/api.js';
import {
  humanize, runStateLabel, runStatePct, runStateDot, LIVE_RUN_STATES, TERMINAL_RUN_STATES,
  parkLabel, laneLabel, srcTagText, statusLabel, stepPhaseLabel, stepPhaseDot,
} from '../lib/vocab.js';
import { capsPanel, queuePanel, honestRatePanel, discoveryStrip } from '../lib/auto-panels.js';
import { ensureJob, jobKnown, primeJob } from './applications.js';

const loadingRow = (t = 'Loading…') => `<div class="loading-row"><span class="spinner"></span>${esc(t)}</div>`;
const srcTag = (s) => `<span class="src-tag" title="${esc(s || '')}">${esc(srcTagText(s))}</span>`;
const TRAIL_CAP = 60; // steps are ring-capped at 500 in the schema; the theater shows the freshest 60

function jobLabel(jobId, fallback) {
  const j = jobKnown(jobId);
  if (!j) return esc(fallback || 'Loading role…');
  return `${esc(j.title)}${j.company ? ` <span class="dim">— ${esc(j.company)}</span>` : ''}`;
}

export default function render(view, ctx) {
  let focusRunId = ctx.query.run || null; // arrived from an Applications "Apply now"
  const focusApplId = ctx.query.apply || null;
  let starting = !!(focusRunId || focusApplId); // optimistic "launching…" until the row appears
  let busy = false; // guards the start/stop/apply buttons
  let running = false;

  const pad = el(`<div class="view-pad">
    ${pageHead('Auto-Apply', { sub: ctx.meta.sub })}
    <div class="card aa-control">
      <button class="btn primary" id="aa-start">${icon('play', 13)} Start auto-apply</button>
      <button class="btn danger hidden" id="aa-stop-auto">${icon('pause', 13)} Stop auto-apply</button>
      <span class="pill off" id="aa-pill">Idle</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm" id="aa-apply-one">${icon('bolt', 13)} Apply to one</button>
      <button class="btn sm" id="aa-disco-run">${icon('refresh', 13)} Discover now</button>
      <button class="btn sm" id="aa-config">${icon('settings', 13)} Configure</button>
    </div>
    <div class="grid">
      <div class="card col-flex span-8 hoverable">
        <div class="card-h"><span class="cap">Live run</span><div class="spacer"></div><span class="aside" id="aa-live-aside">watching · 1.5s</span></div>
        <div id="aa-theater">${loadingRow('Reading the engine…')}</div>
      </div>
      <div class="card col-flex span-4 hoverable">
        <div class="card-h"><span class="cap">Caps &amp; pacing</span><div class="spacer"></div><span class="aside">vs 45/24h ledger</span></div>
        <div id="aa-caps">${loadingRow('')}</div>
      </div>
    </div>
    <div class="grid">
      <div class="card col-flex span-5 hoverable">
        <div class="card-h"><span class="cap">Queue</span><div class="spacer"></div><span class="aside">fit-ordered · skip floor shown</span></div>
        <div id="aa-queue">${loadingRow('')}</div>
      </div>
      <div class="card col-flex span-7 hoverable">
        <div class="card-h"><span class="cap">Honest rate &amp; discovery</span><div class="spacer"></div><span class="aside" id="aa-disco-aside">per lane · per source</span></div>
        <div id="aa-rate">${loadingRow('')}</div>
        <div id="aa-disco" style="margin-top:10px"></div>
      </div>
    </div>
    <div class="card col-flex hoverable">
      <div class="card-h"><span class="cap">History</span><div class="spacer"></div><span class="aside">recent finished runs</span></div>
      <div id="aa-history">${loadingRow('')}</div>
    </div>
  </div>`);
  view.appendChild(pad);

  const theater = $('#aa-theater', pad);
  const history = $('#aa-history', pad);
  const caps = $('#aa-caps', pad);
  const queueBox = $('#aa-queue', pad);
  const rateBox = $('#aa-rate', pad);
  const discoBox = $('#aa-disco', pad);
  const pill = $('#aa-pill', pad);
  const startBtn = $('#aa-start', pad);
  const stopBtn = $('#aa-stop-auto', pad);

  $('#aa-config', pad).addEventListener('click', () => ctx.go('/settings'));
  $('#aa-apply-one', pad).addEventListener('click', () => openPicker(ctx, (runId) => { focusRunId = runId; starting = true; refresh(); }));
  startBtn.addEventListener('click', () => toggleAuto(true));
  stopBtn.addEventListener('click', () => toggleAuto(false));
  $('#aa-disco-run', pad).addEventListener('click', async () => {
    try { await api('/discovery/run', { method: 'POST' }); toast('Discovery sweep started — new supply lands in the queue', 'success', 3000); }
    catch (e) { errToast(e, 'Discover'); }
  });

  async function toggleAuto(on) {
    if (busy) return;
    busy = true;
    try {
      await api(on ? '/auto/start' : '/auto/stop', { method: 'POST' });
      toast(on ? 'Auto-apply started — supervised, capped, and paced' : 'Auto-apply stopping — in-flight runs finish first', on ? 'success' : 'info', 3200);
    } catch (e) { errToast(e, on ? 'Start' : 'Stop'); }
    finally { busy = false; refresh(); }
  }

  function setControl(state) {
    running = !!state?.running;
    pill.className = 'pill ' + (running ? 'on' : 'off');
    pill.innerHTML = running ? '<span class="dot live"></span>Running' : (starting ? '<span class="dot live"></span>Launching…' : 'Idle');
    startBtn.classList.toggle('hidden', running);
    stopBtn.classList.toggle('hidden', !running);
  }

  async function refresh() {
    // one poll cycle: state + queue + discovery (the mission-control triad) + runs (theater/history).
    const [stateR, queueR, discoR, runsR] = await Promise.allSettled([
      api('/auto/state', { signal: ctx.signal }),
      api('/auto/queue', { signal: ctx.signal }),
      api('/discovery/status', { signal: ctx.signal }),
      api('/runs?limit=40', { signal: ctx.signal }),
    ]);
    if (ctx.signal.aborted) return;

    if (stateR.status === 'fulfilled') { setControl(stateR.value); caps.innerHTML = capsPanel(stateR.value); rateBox.innerHTML = honestRatePanel(stateR.value); }
    else if (!caps.querySelector(':not(.loading-row)')) caps.innerHTML = `<div class="empty">Engine unreachable — retrying…</div>`;
    if (queueR.status === 'fulfilled') queueBox.innerHTML = queuePanel(queueR.value);
    if (discoR.status === 'fulfilled') discoBox.innerHTML = discoveryStrip(discoR.value);

    if (runsR.status !== 'fulfilled') {
      if (runsR.reason?.aborted) return;
      theater.innerHTML = `<div class="empty">Could not reach the engine — ${esc(runsR.reason?.message || 'unknown error')}. Retrying…</div>`;
      return;
    }
    const rows = runsR.value?.rows || [];
    rows.forEach((r) => { if (r.job_id && r.job_title) primeJob(r.job_id, { title: r.job_title, company: r.company || '' }); });

    // a genuinely-live run wins the theater; else the run we just launched (even after it finishes).
    let active = rows.find((r) => LIVE_RUN_STATES.has(r.state)) || null;
    if (!active && focusRunId) active = rows.find((r) => r.id === focusRunId) || null;
    if (!active && focusApplId) active = rows.find((r) => r.application_id === focusApplId) || null;
    if (active) { if (LIVE_RUN_STATES.has(active.state)) focusRunId = active.id; starting = false; }

    paintHistory(history, rows.filter((r) => TERMINAL_RUN_STATES.has(r.state)).slice(0, 50));

    if (!active) {
      theater.innerHTML = starting
        ? theaterFrame(null, [], 'launching')
        : `<div class="empty">No run in flight. Press <b>Start auto-apply</b> for a supervised run, or <b>Apply to one</b> to drive a single job — every step shows here.</div>`;
      return;
    }
    let steps = [];
    try {
      const s = await api(`/runs/${encodeURIComponent(active.id)}/steps`, { signal: ctx.signal });
      steps = s?.steps || [];
    } catch (e) { if (e?.aborted) return; /* keep the header; trail stays empty */ }
    theater.innerHTML = theaterFrame(active, steps);
    if (active.job_id && !jobKnown(active.job_id)) {
      ensureJob(active.job_id, () => { const t = $('#aa-run-title', theater); if (t) t.innerHTML = jobLabel(active.job_id); });
    }
  }

  ctx.poll(1500, refresh);
}

// ---------------------------------------------------------------------------
// the theater frame — header + progress + "what the robot sees" + transcript
// ---------------------------------------------------------------------------
function theaterFrame(run, steps, mode) {
  if (mode === 'launching' || !run) {
    return `<div class="aa-run">
      <div class="aa-run-h"><div class="aa-run-title" id="aa-run-title">Launching a run…</div></div>
      <div class="aa-bar"><i style="width:6%"></i></div>
      <div class="aa-see"><span class="spinner" style="width:16px;height:16px"></span> Asking the engine to lease a tab and open the posting…</div>
    </div>`;
  }
  const pct = runStatePct(run.state);
  const see = robotSees(run, steps);
  const metaBits = [
    run.route ? humanize(run.route) : null,
    run.steps_count ? `${num(run.steps_count)} step${run.steps_count === 1 ? '' : 's'}` : null,
    run.resume_count ? `resumed ×${run.resume_count}` : null,
  ].filter(Boolean).join(' · ');
  return `<div class="aa-run">
    <div class="aa-run-h">
      <div class="aa-run-title" id="aa-run-title">${jobLabel(run.job_id, 'Run ' + String(run.id).slice(-6))}</div>
      <span class="aa-state"><span class="dot ${runStateDot(run.state)}"></span>${esc(runStateLabel(run.state))}</span>
    </div>
    <div class="aa-run-sub">${srcTag(run.source)} <span>${esc(laneLabel(run.lane))}</span>${metaBits ? ` · ${esc(metaBits)}` : ''}</div>
    <div class="aa-bar"><i style="width:${pct}%"></i></div>
    <div class="aa-see">
      <div class="aa-see-row"><span class="k">Page</span><span class="v">${esc(see.page)}</span></div>
      <div class="aa-see-row"><span class="k">Doing</span><span class="v">${see.doing}</span></div>
      ${run.park_kind ? `<div class="aa-see-row"><span class="k">Blocked</span><span class="v ember">${esc(parkLabel(run.park_kind))}${run.park_detail ? ` · ${esc(String(run.park_detail).slice(0, 80))}` : ''}</span></div>` : ''}
    </div>
    ${run.state === 'needs_human'
      ? `<div class="aa-needs-cta">${icon('bell', 13)} This run is parked for you — <a href="#/needs-you">answer it in Needs You</a> and it re-queues.</div>`
      : ''}
    <div class="aa-trail-h">Transcript</div>
    ${trailHtml(steps)}
  </div>`;
}

function robotSees(run, steps) {
  const last = steps.length ? steps[steps.length - 1] : null;
  const page = run.page_key ? humanize(run.page_key) : (last ? stepPhaseLabel(last.phase) : 'reading…');
  let doing = 'reading the page…';
  if (last) {
    const verb = stepPhaseLabel(last.phase);
    const what = last.target || last.detail || '';
    doing = `${esc(verb)}${what ? ` <span class="dim">— ${esc(String(what).slice(0, 90))}</span>` : ''}`;
  }
  return { page, doing };
}

function trailHtml(steps) {
  if (!steps.length) return `<div class="aa-trail"><div class="empty" style="padding:22px">No steps yet — the first appears the moment the robot acts.</div></div>`;
  const shown = steps.slice(-TRAIL_CAP);
  const hidden = steps.length - shown.length;
  return `<div class="aa-trail">
    ${hidden > 0 ? `<div class="aa-trail-more">${num(hidden)} earlier step${hidden === 1 ? '' : 's'} above</div>` : ''}
    ${shown.map((s) => `<div class="aa-step${s.ok === false ? ' bad' : ''}">
      <span class="t">${fmtTime(s.at)}</span>
      <span class="ph"><span class="dot ${stepPhaseDot(s.phase)}"></span>${esc(stepPhaseLabel(s.phase))}</span>
      <span class="d">${esc([s.target, s.detail].filter(Boolean).join(' · ').slice(0, 120)) || '—'}</span>
      ${s.duration_ms != null ? `<span class="ms">${num(s.duration_ms)}ms</span>` : ''}
    </div>`).join('')}
  </div>`;
}

// ---------------------------------------------------------------------------
// history — recent finished runs (reuses the .act ledger row style)
// ---------------------------------------------------------------------------
function paintHistory(box, rows) {
  if (!box) return;
  if (!rows.length) { box.innerHTML = `<div class="empty">No finished runs yet. Your first apply will land here.</div>`; return; }
  box.innerHTML = rows.map((r) => `<div class="act">
    <span class="time" title="${esc(fmtAgo(r.finished_at || r.updated_at))}">${fmtTime(r.finished_at || r.updated_at)}</span>
    <span class="atag" style="width:118px"><span class="dot ${runStateDot(r.state)}"></span>${esc(runStateLabel(r.state))}</span>
    <span class="txt"><b data-jh="${esc(r.job_id || '')}">${jobLabel(r.job_id, 'Run ' + String(r.id).slice(-6))}</b>${r.park_kind ? ` · ${esc(parkLabel(r.park_kind))}` : ''}${r.error ? ` · ${esc(String(r.error).slice(0, 60))}` : ''}</span>
    <span class="via">${srcTag(r.source)}</span>
  </div>`).join('');
  rows.forEach((r) => { if (r.job_id && !jobKnown(r.job_id)) ensureJob(r.job_id, () => { const n = box.querySelector(`[data-jh="${CSS.escape(r.job_id)}"]`); if (n) n.innerHTML = jobLabel(r.job_id); }); });
}

// ---------------------------------------------------------------------------
// job picker — choose a Saved application to drive ONE apply (POST /api/apply/one)
// ---------------------------------------------------------------------------
function openPicker(ctx, onStarted) {
  const node = el(`<div class="picker aa-picker">
    <div class="palette-input">${icon('search', 15)}<input placeholder="Pick a saved job to apply to…" autocomplete="off"><kbd>Esc</kbd></div>
    <div class="aa-pick-list" id="aa-pick-list">${loadingRow('Reading saved jobs…')}</div>
  </div>`);
  const close = openOverlay(node);
  const input = node.querySelector('input');
  const listBox = $('#aa-pick-list', node);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  let rows = [];
  let firing = false;
  async function load() {
    try {
      const d = await api('/applications?status=tracked&limit=100', { signal: ctx.signal });
      rows = d?.rows || [];
      rows.forEach((r) => { if (r.job_id && (r.title || r.job_title)) primeJob(r.job_id, { title: r.title || r.job_title, company: r.company || '' }); });
      paint('');
    } catch (e) {
      listBox.innerHTML = `<div class="empty">Could not load saved jobs — ${esc(e?.message || 'unknown error')}</div>`;
    }
  }
  function paint(q) {
    const ql = q.trim().toLowerCase();
    const hits = rows.filter((r) => { const j = jobKnown(r.job_id); return !ql || `${j ? `${j.title} ${j.company}` : ''}`.toLowerCase().includes(ql); }).slice(0, 80);
    if (!rows.length) { listBox.innerHTML = `<div class="empty">No saved jobs to apply to. Save a job first — every ${esc(statusLabel('tracked').toLowerCase())} job is eligible.</div>`; return; }
    listBox.innerHTML = hits.length ? hits.map((r) => `<div class="aa-pick" data-appl="${esc(r.id)}" data-job="${esc(r.job_id || '')}">
      <div class="who"><div class="t">${jobLabel(r.job_id, 'Untitled role')}</div></div>
      <span class="go">${icon('bolt', 13)} Apply</span>
    </div>`).join('') : `<div class="empty">No saved job matches “${esc(q)}”.</div>`;
    hits.forEach((r) => { if (r.job_id && !jobKnown(r.job_id)) ensureJob(r.job_id, () => { const n = listBox.querySelector(`.aa-pick[data-appl="${CSS.escape(r.id)}"] .t`); if (n) n.innerHTML = jobLabel(r.job_id); }); });
    listBox.querySelectorAll('.aa-pick').forEach((n) => n.addEventListener('click', () => fire(n.getAttribute('data-appl'))));
  }
  async function fire(applicationId) {
    if (firing || !applicationId) return;
    firing = true;
    try {
      const res = await api('/apply/one', { method: 'POST', body: { applicationId } });
      const runId = res?.run?.id || res?.runId || res?.id || null;
      close();
      toast('Applying — watch it run below', 'success', 3500);
      onStarted?.(runId);
    } catch (e) { firing = false; errToast(e, 'Apply'); }
  }
  input.addEventListener('input', () => paint(input.value));
  load();
  input.focus();
}
