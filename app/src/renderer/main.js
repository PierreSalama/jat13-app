// ============================================================================
// JAT 13 — Atelier Noir renderer. Plain ES modules, no framework. Every control
// binds to the REAL v13 loopback REST API (X-JAT13-Token pairing header). Built
// for scale: large lists virtualize, polls diff-not-rebuild, timers die on route
// change, fetches abort when superseded. Nothing here fakes data — a route that
// is not live yet renders a graceful "coming online" state, never a crash.
// ============================================================================
import { THEMES, applyTheme, DEFAULT_THEME, normalizeMode, getMode } from './lib/themes.js';
import { signet, icon } from './lib/icons.js';

// ---------------------------------------------------------------------------
// tiny DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const LS_THEME = 'jat13.theme';

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------
function fmtTime(ms) { if (!ms) return '—'; const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function fmtDate(ms) { if (!ms) return '—'; const d = new Date(ms); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
function fmtDateTime(ms) { if (!ms) return '—'; const d = new Date(ms); return `${fmtDate(ms)} · ${fmtTime(ms)}`; }
function fmtAgo(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}
function fmtBytes(n) { if (n == null) return '—'; if (n < 1024) return `${n} B`; if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`; return `${(n / 1048576).toFixed(1)} MB`; }
const num = (n) => (n == null ? '0' : Number(n).toLocaleString());
function initials(name) { const p = String(name || '').trim().split(/\s+/); return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || 'PS'; }

// ---------------------------------------------------------------------------
// human vocabulary — never show raw enum ids
// ---------------------------------------------------------------------------
const STATUS_ORDER = ['tracked', 'submitted', 'acknowledged', 'assessment', 'interview_1', 'interview_2', 'interview_final', 'offer', 'hired', 'rejected', 'withdrawn', 'ghosted'];
const STATUS_LABEL = {
  tracked: 'Saved', submitted: 'Applied', acknowledged: 'Acknowledged', assessment: 'Assessment',
  interview_1: 'Interview 1', interview_2: 'Interview 2', interview_final: 'Final interview',
  offer: 'Offer', hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn', ghosted: 'Ghosted',
};
const STATUS_DOT = {
  tracked: 'dim', submitted: 'bronze', acknowledged: 'sage', assessment: 'ember',
  interview_1: 'gold', interview_2: 'gold', interview_final: 'gold',
  offer: 'bronze', hired: 'sage', rejected: 'danger', withdrawn: 'dim', ghosted: 'dim',
};
const TERMINAL_STATUS = new Set(['rejected', 'withdrawn', 'ghosted', 'hired']);
// email category → short human badge (never show the raw enum like APPLICATION_CONFIRMATION)
const MAIL_CAT_LABEL = {
  application_confirmation: 'Confirmation', application_ack: 'Acknowledged', interview: 'Interview',
  assessment: 'Assessment', rejection: 'Rejection', offer: 'Offer', recruiter: 'Recruiter', other: 'Other',
};
const mailCat = (c) => (c ? (MAIL_CAT_LABEL[c] || String(c).replace(/_/g, ' ')) : '');
const RUN_STATE = {
  queued: { label: 'Queued', pct: 8 }, leased: { label: 'Starting', pct: 16 },
  navigating: { label: 'Reading page', pct: 32 }, classifying: { label: 'Reading page', pct: 46 },
  driving: { label: 'Filling form', pct: 66 }, verifying: { label: 'Verifying submit', pct: 88 },
  waiting_page: { label: 'Waiting on page', pct: 52 }, needs_human: { label: 'Needs you', pct: 100 },
  submitted: { label: 'Submitted', pct: 100 }, ready_for_review: { label: 'Ready for review', pct: 96 },
  parked: { label: 'Parked', pct: 100 }, skipped: { label: 'Skipped', pct: 100 }, failed: { label: 'Failed', pct: 100 },
};
const ACTIVE_STATES = ['leased', 'navigating', 'classifying', 'driving', 'verifying', 'waiting_page'];
const TERMINAL_RUN = new Set(['submitted', 'ready_for_review', 'parked', 'skipped', 'failed']);
const PARK_LABEL = {
  captcha: 'CAPTCHA', cloudflare: 'Cloudflare check', login: 'Sign-in required', account_wall: 'Account wall',
  resume_required: 'Résumé required', needs_answer: 'Screening question', awaiting_review: 'Awaiting your review',
  external_redirect: 'External site', rate_limited: 'Rate limited', other: 'Needs attention',
};
const ANSWERABLE_PARK = new Set(['needs_answer', 'other', 'awaiting_review']);
const SRC_TAG = { linkedin: 'in', indeed: 'id', lever: 'lv', greenhouse: 'gh', ashby: 'as', workday: 'wd', bamboohr: 'bh', icims: 'ic', web: 'w', };
function srcTag(source) { const s = String(source || '').toLowerCase(); const t = SRC_TAG[s] || s.slice(0, 2) || '·'; return `<span class="src-tag" title="${esc(source || '')}">${esc(t)}</span>`; }
function statusBadge(status) { return `<span class="sbadge"><span class="dot ${STATUS_DOT[status] || 'dim'}"></span>${esc(STATUS_LABEL[status] || status)}</span>`; }

// ---------------------------------------------------------------------------
// bootstrap config + pairing token
// ---------------------------------------------------------------------------
const state = {
  base: 'http://127.0.0.1:7860', token: null, version: '', online: false, devtools: false,
  applying: false, needsYou: 0, settings: null, profileId: null, profileName: 'Pierre Salama',
  gmail: null, routeGen: 0,
};

async function bootstrap() {
  if (window.jat13?.config) {
    try {
      const cfg = await window.jat13.config();
      if (cfg?.port) state.base = `http://127.0.0.1:${cfg.port}`;
      if (cfg?.token) state.token = cfg.token;
      if (cfg?.version) state.version = cfg.version;
      if (cfg?.devtools) state.devtools = true;
      if (state.token) return true;
    } catch { /* fall through to probe */ }
  }
  for (const port of [7860, 7861]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/pair/token`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) continue;
      const body = await res.json();
      if (body?.token) { state.base = `http://127.0.0.1:${port}`; state.token = body.token; state.version = body.version || ''; state.devtools = !!body.devtools; return true; }
    } catch { /* try next port */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// API helper — token on every /api call; 401 → not-connected. Combined abort:
// page-scoped signal (dies on nav) + a hard timeout.
// ---------------------------------------------------------------------------
function combineSignals(sigs) { const s = sigs.filter(Boolean); if (s.length === 1) return s[0]; if (AbortSignal.any) return AbortSignal.any(s); return s[0]; }
async function api(path, opts = {}) {
  const { method = 'GET', body, raw = false, timeoutMs = 20000, signal, formData } = opts;
  const signals = combineSignals([signal, AbortSignal.timeout(timeoutMs)]);
  let res;
  try {
    const headers = { 'X-JAT13-Token': state.token || '' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    res = await fetch(state.base + '/api' + path, {
      method, headers,
      body: formData !== undefined ? formData : (body !== undefined ? JSON.stringify(body) : undefined),
      signal: signals,
    });
  } catch (e) {
    if (e?.name === 'AbortError') { const err = new Error('aborted'); err.aborted = true; throw err; }
    const err = new Error('app unreachable'); err.status = 0; throw err;
  }
  if (res.status === 401) { state.online = false; const err = new Error('unauthorized'); err.status = 401; throw err; }
  if (raw) { if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; } return res; }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const err = new Error(data?.message || data?.error || 'HTTP ' + res.status); err.status = res.status; err.code = data?.error; throw err; }
  return data;
}
async function health() { const res = await fetch(state.base + '/health', { signal: AbortSignal.timeout(4000) }); if (!res.ok) throw new Error('health ' + res.status); return res.json(); }

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------
function toast(msg, kind = 'info', ttl) {
  const box = $('#toasts'); if (!box) return () => {};
  const t = el(`<div class="toast ${kind !== 'info' ? kind : ''}"><span class="toast-msg"></span><button class="toast-x" aria-label="Dismiss">×</button></div>`);
  t.querySelector('.toast-msg').textContent = msg;
  let done = false; const close = () => { if (done) return; done = true; t.remove(); };
  t.querySelector('.toast-x').addEventListener('click', close);
  box.appendChild(t);
  const life = ttl !== undefined ? ttl : (kind === 'danger' ? 8000 : 4500);
  if (life > 0) setTimeout(close, life);
  return close;
}
const errToast = (e, prefix = '') => { if (e?.aborted) return; toast((prefix ? prefix + ' — ' : '') + (e?.message || String(e)), 'danger'); };

// ---------------------------------------------------------------------------
// overlays (palette + drawer)
// ---------------------------------------------------------------------------
function openOverlay(node, { onClose } = {}) {
  const root = $('#overlay-root');
  const ov = el('<div class="overlay"></div>');
  ov.appendChild(node);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) { ov.remove(); onClose?.(); } });
  root.appendChild(ov);
  return () => { ov.remove(); onClose?.(); };
}
function closeTopOverlay() { const ovs = $$('#overlay-root .overlay'); if (ovs.length) { ovs[ovs.length - 1].remove(); return true; } return false; }

// ---------------------------------------------------------------------------
// theme
// ---------------------------------------------------------------------------
function setTheme(mode, persist = true) {
  const m = normalizeMode(mode);
  applyTheme(m);
  try { localStorage.setItem(LS_THEME, m); } catch { /* ignore */ }
  if (persist && state.token) {
    const v = m === 'system' ? 'system' : m; // enum accepts system/light/dark
    api('/settings/appearance/theme', { method: 'PUT', body: { value: v } }).catch(() => {});
  }
}
function initTheme() {
  let m = DEFAULT_THEME;
  try { const s = localStorage.getItem(LS_THEME); if (s) m = normalizeMode(s); } catch { /* ignore */ }
  applyTheme(m);
}

// ---------------------------------------------------------------------------
// job cache — lazy title/company fill (only ever fetched for VISIBLE rows, so
// virtualization naturally bounds the fan-out). Waiters re-render on resolve.
// ---------------------------------------------------------------------------
const jobCache = new Map();      // id -> {title, company, ...}
const jobPending = new Set();    // id currently fetching
const jobWaiters = new Map();    // id -> Set(callback)
function jobKnown(id) { return jobCache.get(id) || null; }
function ensureJob(id, cb) {
  if (!id) return;
  const hit = jobCache.get(id);
  if (hit) { cb?.(hit); return; }
  if (cb) { if (!jobWaiters.has(id)) jobWaiters.set(id, new Set()); jobWaiters.get(id).add(cb); }
  if (jobPending.has(id)) return;
  jobPending.add(id);
  api(`/jobs/${encodeURIComponent(id)}`).then((j) => {
    jobCache.set(id, { title: j.title || 'Untitled role', company: j.company || '', source: j.source, job_url: j.job_url, apply_capability: j.apply_capability, fit_score: j.fit_score, location: j.location });
    const w = jobWaiters.get(id); if (w) { w.forEach((f) => { try { f(jobCache.get(id)); } catch { /* ignore */ } }); jobWaiters.delete(id); }
  }).catch(() => { jobCache.set(id, { title: 'Role', company: '' }); const w = jobWaiters.get(id); if (w) { w.forEach((f) => f(jobCache.get(id))); jobWaiters.delete(id); } })
    .finally(() => jobPending.delete(id));
}

// ---------------------------------------------------------------------------
// per-route lifecycle: timers + abort. routeGen guards stale async DOM writes.
// ---------------------------------------------------------------------------
let pageTimers = [];
let pageAbort = new AbortController();
function resetPage() {
  pageTimers.forEach(clearInterval); pageTimers = [];
  try { pageAbort.abort(); } catch { /* ignore */ }
  pageAbort = new AbortController();
  state.routeGen++;
}
/** guarded interval: skips overlapping ticks, bails if the route changed under it. */
function poll(ms, fn, immediate = true) {
  const gen = state.routeGen; let inFlight = false;
  const tick = async () => {
    if (inFlight || gen !== state.routeGen) return;
    inFlight = true;
    try { await fn(); } catch (e) { if (!e?.aborted && e?.status === 401) showNotConnected(); }
    finally { inFlight = false; }
  };
  if (immediate) tick();
  pageTimers.push(setInterval(tick, ms));
}
const psig = () => pageAbort.signal;

// ============================================================================
// SHELL — brand, nav, topbar, global poller
// ============================================================================
const NAV = [
  { group: 'Operate', items: [
    { route: '/', label: 'Command Center', icon: 'command', chord: 'C' },
    { route: '/auto', label: 'Auto-Apply', icon: 'bolt', chord: 'A' },
    { route: '/needs', label: 'Needs You', icon: 'bell', chord: 'N', badge: true },
  ] },
  { group: 'Track', items: [
    { route: '/pipeline', label: 'Pipeline', icon: 'board', chord: 'P' },
    { route: '/applications', label: 'Applications', icon: 'layers', chord: 'L' },
    { route: '/inbox', label: 'Inbox', icon: 'mail', chord: 'I' },
  ] },
  { group: 'You', items: [
    { route: '/profile', label: 'Profile', icon: 'user', chord: 'U' },
    { route: '/documents', label: 'Documents', icon: 'doc', chord: 'D' },
  ] },
  { group: 'System', items: [
    { route: '/activity', label: 'Activity', icon: 'activity', chord: 'Y' },
    { route: '/settings', label: 'Settings', icon: 'settings', chord: 'S' },
  ] },
];
const CHORD_ROUTE = {}; NAV.forEach((g) => g.items.forEach((i) => { CHORD_ROUTE[i.chord] = i.route; }));
const ROUTE_CRUMB = {};
NAV.forEach((g) => g.items.forEach((i) => { ROUTE_CRUMB[i.route] = `${g.group} &nbsp;/&nbsp; <b>${i.label}</b>`; }));

function renderShell() {
  $('#brand').innerHTML = `${signet(44)}<div class="wordmark"><div class="wm-1">JAT<sup>&nbsp;13</sup></div><div class="wm-2">Atelier</div></div>`;
  const nav = $('#nav');
  nav.innerHTML = NAV.map((g) => `
    <div class="nav-h">${g.group}</div>
    ${g.items.map((i) => `
      <a class="nav-item" data-route="${i.route}" href="#${i.route}">
        ${icon(i.icon, 16)}<span class="grow">${i.label}</span>
        ${i.badge ? `<span class="nav-badge" id="nav-badge-needs"></span>` : `<span class="key">G&thinsp;${i.chord}</span>`}
      </a>`).join('')}
  `).join('');
  $('#user-avatar').textContent = initials(state.profileName);
  $('#user-name').textContent = state.profileName;
  $('#cmd-open').addEventListener('click', openPalette);
  $('#apply-toggle').addEventListener('click', () => toggleApplying());
  $('#gmail-chip').addEventListener('click', () => go('/settings'));
}

function setActiveNav(route) {
  $$('#nav .nav-item').forEach((a) => a.classList.toggle('active', a.getAttribute('data-route') === route));
  $('#crumb').innerHTML = ROUTE_CRUMB[route] || ROUTE_CRUMB['/'];
}

// --- global status poller (never cleared; keeps the resident engine block live) ---
function startGlobalPoller() {
  const tickSummary = async () => {
    try {
      const s = await api('/summary');
      state.applying = !!s.applying;
      state.needsYou = s.needsYou || 0;
      const inflight = ACTIVE_STATES.reduce((n, st) => n + (s.runs?.byState?.[st] || 0), 0);
      const queued = s.runs?.byState?.queued || 0;
      updateEngineChip(inflight, queued);
      updateNeedsBadge(state.needsYou);
      updateApplyToggle();
    } catch (e) { if (e?.status === 401) { state.online = false; updateEngineChip(0, 0, true); } }
  };
  const tickHealth = async () => {
    try { const h = await health(); state.online = true; state.version = h.version || state.version; setEngineDot(true); }
    catch { state.online = false; setEngineDot(false); }
  };
  const tickGmail = async () => {
    try { const g = await api('/gmail/status'); state.gmail = g; updateGmailChip(g); }
    catch { /* gmail optional */ }
  };
  tickHealth(); tickSummary(); tickGmail();
  setInterval(tickHealth, 10000);
  setInterval(tickSummary, 4000);
  setInterval(tickGmail, 30000);
}
function setEngineDot(ok) { const d = $('#engine-dot'); if (!d) return; d.className = 'dot ' + (ok ? (state.applying ? 'live' : 'sage') : 'danger'); }
function updateEngineChip(inflight, queued, offline) {
  const chip = $('#engine-chip'), t1 = $('#engine-t1'), t2 = $('#engine-t2');
  if (!chip) return;
  if (offline || !state.online) { chip.classList.add('off'); t1.textContent = 'Not connected'; t2.textContent = 'loopback unreachable'; setEngineDot(false); return; }
  const running = state.applying;
  chip.classList.toggle('off', !running);
  t1.textContent = running ? 'Engine running' : 'Engine idle';
  t2.textContent = `${inflight} in flight · ${queued} queued`;
  setEngineDot(true);
}
function updateNeedsBadge(n) { const b = $('#nav-badge-needs'); if (b) b.textContent = n > 0 ? String(n) : ''; }
function updateApplyToggle() {
  const t = $('#apply-toggle'); if (!t) return;
  t.disabled = !state.online;
  t.classList.toggle('on', state.applying);
  t.innerHTML = `Auto-Apply ${state.applying ? 'On' : 'Off'} <span class="knob"></span>`;
}
function updateGmailChip(g) {
  const chip = $('#gmail-chip'); if (!chip) return;
  const acct = g?.accounts?.[0];
  if (!acct) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  // "connected" must mean a LIVE token — an imported-but-unauthorized account is `enabled` yet cannot
  // sync, so `enabled` alone must NOT read as connected (that was the misleading chip).
  const ok = acct.tokenState === 'ok' || acct.tokenState === 'valid';
  chip.innerHTML = `${icon('mail', 13)}<span class="dot ${ok ? 'sage' : 'ember'}" style="width:6px;height:6px"></span> Gmail ${ok ? 'connected' : 'not connected'}${ok && acct.lastOkAt ? ` <span class="mono">${fmtAgo(acct.lastOkAt)} ago</span>` : ''}`;
}

async function toggleApplying(force) {
  const want = force !== undefined ? force : !state.applying;
  try {
    await api(want ? '/apply/start' : '/apply/stop', { method: 'POST' });
    state.applying = want; updateApplyToggle(); setEngineDot(true);
    toast(want ? 'Auto-apply started' : 'Auto-apply paused', want ? 'success' : 'info', 2500);
  } catch (e) { errToast(e, 'Auto-apply'); }
}

// ============================================================================
// ROUTER
// ============================================================================
function parseHash() {
  const raw = (location.hash || '#/').slice(1);
  const [path, qs] = raw.split('?');
  const query = {};
  if (qs) new URLSearchParams(qs).forEach((v, k) => { query[k] = v; });
  return { path: path || '/', query };
}
function go(path) { location.hash = path; }

const ROUTES = {
  '/': renderHome, '/auto': renderAuto, '/needs': renderNeeds, '/pipeline': renderPipeline,
  '/applications': renderApplications, '/inbox': renderInbox, '/profile': renderProfile,
  '/documents': renderDocuments, '/activity': renderActivity, '/settings': renderSettings,
};

function router() {
  resetPage();
  const { path, query } = parseHash();
  const view = $('#view');
  view.scrollTop = 0;
  const fn = ROUTES[path] || renderHome;
  setActiveNav(ROUTES[path] ? path : '/');
  view.innerHTML = '';
  try { fn(view, query); } catch (e) { console.error(e); view.innerHTML = ''; view.appendChild(centerState('Something went wrong', e?.message || 'render error')); }
}

// ---------------------------------------------------------------------------
// shared UI fragments
// ---------------------------------------------------------------------------
function centerState(title, sub, actionHtml) {
  return el(`<div class="center-state">${signet(72)}<h2>${esc(title)}</h2><p>${esc(sub || '')}</p>${actionHtml || ''}</div>`);
}
function loadingRow(label = 'Loading…') { return `<div class="loading-row"><span class="spinner"></span>${esc(label)}</div>`; }
function showNotConnected() {
  const view = $('#view'); if (!view) return;
  view.innerHTML = '';
  const node = centerState('Not connected', 'The JAT 13 engine is not answering on the loopback port. Make sure the desktop app is running, then retry.', '<button class="btn primary" id="retry-conn">Retry connection</button>');
  view.appendChild(node);
  $('#retry-conn')?.addEventListener('click', async () => { const ok = await bootstrap(); if (ok) { state.online = true; router(); } else toast('Still unreachable', 'danger'); });
}
function pageHead(title, { serif, date, live, sub } = {}) {
  return `<div class="page-head">
    <h1>${serif ? `<span class="serif">${esc(title)}</span>` : esc(title)}</h1>
    ${date ? `<span class="date">${esc(date)}</span>` : ''}
    ${sub ? `<span class="sub">${sub}</span>` : ''}
    ${live ? `<span class="live"><span class="dot live"></span> ${esc(live)}</span>` : ''}
  </div>`;
}
function todayLabel() { return new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }

// ============================================================================
// COMMAND CENTER (home)
// ============================================================================
function renderHome(view) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Command Center', { date: todayLabel(), live: 'live' })}
    <div class="stats" id="home-stats">${homeStatsSkeleton()}</div>
    <div class="grid">
      <div class="card col-flex span-8 hoverable" id="theatre-card">
        <div class="card-h"><span class="cap">Auto-Apply</span><span class="pill off" id="theatre-pill">Idle</span><div class="spacer"></div>
          <button class="btn sm" id="theatre-toggle">Start</button>
          <button class="btn sm" id="theatre-config">Configure</button></div>
        <div id="theatre-body">${loadingRow('Reading the engine…')}</div>
        <div class="runs-foot" id="theatre-foot"></div>
      </div>
      <div class="card col-flex span-4 hoverable" id="gauge-card">
        <div class="card-h"><span class="cap">Today's pacing</span><div class="spacer"></div><span class="aside" id="gauge-pct">—</span></div>
        <div id="gauge-body">${loadingRow('Pacing…')}</div>
      </div>
      <div class="card col-flex span-7 hoverable" id="activity-card">
        <div class="card-h"><span class="cap">Activity</span><div class="spacer"></div><span class="aside">recent</span></div>
        <div id="home-activity">${loadingRow()}</div>
      </div>
      <div class="card col-flex span-5 hoverable" id="needs-card">
        <div class="card-h"><span class="cap">Needs you</span><span class="nav-badge" id="needs-mini"></span><div class="spacer"></div>
          <button class="btn sm" id="needs-open">Open queue</button></div>
        <div id="home-needs">${loadingRow()}</div>
      </div>
    </div>
  </div>`);
  view.appendChild(pad);

  $('#theatre-toggle').addEventListener('click', () => toggleApplying());
  $('#theatre-config').addEventListener('click', () => go('/settings'));
  $('#needs-open').addEventListener('click', () => go('/needs'));

  // stats + activity + needs + gauge: slower cadence (12s); theatre: 2s.
  poll(12000, async () => {
    const [stats, ev, needs] = await Promise.all([
      api('/stats', { signal: psig() }).catch(() => null),
      api('/events/recent?limit=14', { signal: psig() }).catch(() => ({ rows: [] })),
      api('/needs-you', { signal: psig() }).catch(() => ({ needsHuman: [], readyForReview: [] })),
    ]);
    if (stats) renderHomeStats(stats);
    renderHomeActivity(ev.rows || []);
    renderHomeNeeds([...(needs.needsHuman || []), ...(needs.readyForReview || [])]);
  });
  poll(15000, async () => { await renderGauge(); });
  poll(2000, async () => { await tickTheatre(); });
}
function homeStatsSkeleton() {
  return ['Jobs', 'Applied', 'Interviews', 'Offers'].map((l) => `<div class="stat"><div class="lbl">${l}</div><div class="num">—</div><div class="delta">&nbsp;</div></div>`).join('');
}
function renderHomeStats(s) {
  const f = s.funnel || {}; const totals = s.totals || {};
  const applied = STATUS_ORDER.filter((x) => x !== 'tracked').reduce((n, x) => n + (f[x] || 0), 0);
  const interviews = (f.interview_1 || 0) + (f.interview_2 || 0) + (f.interview_final || 0);
  const offers = (f.offer || 0) + (f.hired || 0);
  const cards = [
    { l: 'Jobs', n: num(totals.jobs), d: `${num(totals.applications)} applications on file` },
    { l: 'Applied', n: num(applied), d: `<b>${num(totals.submitted7d || 0)}</b> submitted · last 7 days` },
    { l: 'Interviews', n: num(interviews), d: interviews ? `${num(f.interview_final || 0)} at final round` : 'none active' },
    { l: 'Offers', n: num(offers), d: offers ? `<b>${num(f.hired || 0)}</b> hired` : 'none yet' },
  ];
  $('#home-stats').innerHTML = cards.map((c) => `<div class="stat"><div class="lbl">${c.l}</div><div class="num tnum">${c.n}</div><div class="delta">${c.d}</div></div>`).join('');
}
function renderHomeActivity(rows) {
  const box = $('#home-activity'); if (!box) return;
  if (!rows.length) { box.innerHTML = `<div class="empty">No activity recorded yet.</div>`; return; }
  box.innerHTML = rows.slice(0, 12).map((e) => activityRow(e)).join('');
}
function activityRow(e) {
  const label = { status_change: 'Status', submitted: 'Applied', park: 'Parked', email_matched: 'Email', created: 'Found', imported: 'Imported', note: 'Note', document_attached: 'Document' }[e.kind] || e.kind;
  const dotByKind = { submitted: 'bronze', status_change: 'gold', park: 'ember', email_matched: 'sage', created: 'dim', imported: 'dim', note: 'dim', document_attached: 'bronze' };
  return `<div class="act">
    <span class="time">${fmtTime(e.at)}</span>
    <span class="atag ${esc(e.kind)}"><span class="dot ${dotByKind[e.kind] || 'dim'}"></span>${esc(label)}</span>
    <span class="txt">${esc(e.summary || '(no detail)')}</span>
    <span class="via">${esc(e.source || e.kind || '')}</span>
  </div>`;
}
function renderHomeNeeds(runs) {
  const box = $('#home-needs'); const mini = $('#needs-mini');
  if (mini) mini.textContent = runs.length ? String(runs.length) : '';
  if (!box) return;
  if (!runs.length) { box.innerHTML = `<div class="empty">Nothing needs you right now.</div>`; return; }
  box.innerHTML = runs.slice(0, 5).map((r) => {
    const answerable = ANSWERABLE_PARK.has(r.park_kind) || r.state === 'ready_for_review';
    const cls = answerable ? 'q' : 'c';
    const kind = r.state === 'ready_for_review' ? 'Ready for review' : (PARK_LABEL[r.park_kind] || 'Needs attention');
    const j = jobKnown(r.job_id);
    const title = j ? `${esc(j.title)}${j.company ? ` <span>— ${esc(j.company)}</span>` : ''}` : `<span data-jf="${r.job_id}">Loading role…</span>`;
    if (!j) ensureJob(r.job_id, (job) => { const n = $(`#home-needs [data-jf="${r.job_id}"]`); if (n) n.outerHTML = `${esc(job.title)}${job.company ? ` <span style="color:var(--ink-dim);font-weight:400">— ${esc(job.company)}</span>` : ''}`; });
    return `<div class="need" data-runid="${r.id}">
      <div class="glyph ${cls}">${icon(answerable ? 'question' : 'shield', 17)}</div>
      <div class="body"><div class="t">${kind}</div><div class="s">${title}</div></div>
      <span class="age">${fmtAgo(r.updated_at)}</span>
    </div>`;
  }).join('');
  $$('#home-needs .need').forEach((n) => n.addEventListener('click', () => go('/needs')));
}

// --- theatre + gauge (poll active runs) ---
let theatreCache = [];
async function tickTheatre() {
  let data;
  try { data = await api('/runs?limit=60', { signal: psig() }); } catch (e) { if (e?.aborted) return; throw e; }
  const rows = data.rows || [];
  const active = rows.filter((r) => ACTIVE_STATES.includes(r.state)).slice(0, 6);
  theatreCache = active;
  const pill = $('#theatre-pill'); const toggle = $('#theatre-toggle');
  if (pill) { pill.className = 'pill ' + (state.applying ? 'on' : 'off'); pill.innerHTML = state.applying ? `<span class="dot live"></span>On · ${active.length} in flight` : 'Idle'; }
  if (toggle) toggle.textContent = state.applying ? 'Pause' : 'Start';
  const body = $('#theatre-body');
  if (!body) return;
  if (!active.length) {
    body.innerHTML = `<div class="empty">${state.applying ? 'No runs in flight this moment — the scheduler is between leases.' : 'Auto-apply is idle. Start it to watch runs stream here.'}</div>`;
  } else {
    body.innerHTML = active.map((r, i) => runTheatreRow(r, i)).join('');
    active.forEach((r) => { if (!jobKnown(r.job_id)) ensureJob(r.job_id, () => patchTheatreTitle(r)); else patchTheatreTitle(r); });
  }
  // foot stats from a light stats read (throttled: only every ~6s via modulo)
  renderTheatreFoot(rows);
}
function runTheatreRow(r, i) {
  const rs = RUN_STATE[r.state] || { label: r.state, pct: 40 };
  const j = jobKnown(r.job_id);
  const title = j ? `${esc(j.title)}${j.company ? ` <span>— ${esc(j.company)}</span>` : ''}` : `Run ${r.id.slice(-6)}`;
  return `<div class="run" data-runid="${r.id}">
    <span class="idx">${String(i + 1).padStart(2, '0')}</span>
    <div class="who">
      <div class="title" data-jt="${r.job_id}">${title}</div>
      <div class="rstage">${srcTag(r.source)} ${esc(rs.label)}${r.route ? ` · ${esc(String(r.route).replace(/_/g, ' '))}` : ''}${r.steps_count ? ` · ${r.steps_count} steps` : ''}</div>
    </div>
    <div class="prog"><span class="pct tnum">${rs.pct}%</span><div class="bar"><i style="width:${rs.pct}%"></i></div></div>
  </div>`;
}
function patchTheatreTitle(r) {
  const j = jobKnown(r.job_id); if (!j) return;
  const n = $(`#theatre-body [data-jt="${r.job_id}"]`);
  if (n) n.innerHTML = `${esc(j.title)}${j.company ? ` <span>— ${esc(j.company)}</span>` : ''}`;
}
function renderTheatreFoot(rows) {
  const foot = $('#theatre-foot'); if (!foot) return;
  const now = Date.now(); const hourAgo = now - 3600000;
  const submittedHr = rows.filter((r) => r.state === 'submitted' && (r.finished_at || 0) >= hourAgo).length;
  const failedHr = rows.filter((r) => r.state === 'failed' && (r.finished_at || 0) >= hourAgo).length;
  const queued = rows.filter((r) => r.state === 'queued').length;
  foot.innerHTML = `<span>queue <b>${queued}</b> waiting</span><span><b>${submittedHr}</b> submitted this hour</span><span class="end"><b>${failedHr}</b> failed this hour</span>`;
}
async function renderGauge() {
  let rows = [];
  try { rows = (await api('/runs?state=submitted&limit=300', { signal: psig() })).rows || []; } catch (e) { if (e?.aborted) return; }
  const start = new Date(); start.setHours(0, 0, 0, 0); const t0 = start.getTime();
  const today = rows.filter((r) => (r.finished_at || r.updated_at || 0) >= t0);
  const byLane = { linkedin: 0, indeed: 0, ats: 0 };
  today.forEach((r) => { const lane = r.lane === 'linkedin' ? 'linkedin' : r.lane === 'indeed' ? 'indeed' : 'ats'; byLane[lane]++; });
  const caps = { linkedin: 45, indeed: 20, ats: 40 };
  const frac = clamp(byLane.linkedin / caps.linkedin, 0, 1);
  const full = Math.PI * 90; // semicircle arc length
  const dash = (frac * full).toFixed(1);
  const body = $('#gauge-body'); const pctEl = $('#gauge-pct');
  if (pctEl) pctEl.textContent = `${Math.round(frac * 100)}%`;
  if (!body) return;
  const resetIn = (() => { const midnight = new Date(); midnight.setHours(24, 0, 0, 0); const ms = midnight - Date.now(); const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000); return `${h}h ${m}m`; })();
  body.innerHTML = `
    <div class="gauge-wrap">
      <svg width="220" height="118" viewBox="0 0 220 118">
        <path d="M20 108 A 90 90 0 0 1 200 108" fill="none" stroke="rgba(236,228,212,.08)" stroke-width="9" stroke-linecap="round"/>
        <path d="M20 108 A 90 90 0 0 1 200 108" fill="none" stroke="url(#gaugeGrad)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${dash} 999" style="filter:drop-shadow(0 0 6px rgba(201,163,115,.4))"/>
      </svg>
      <div class="gauge-center"><div class="big tnum">${byLane.linkedin}<span> / ${caps.linkedin}</span></div><div class="sub">LinkedIn daily cap</div></div>
    </div>
    <div class="gauge-foot">
      ${miniMeter('Indeed', byLane.indeed, caps.indeed)}
      ${miniMeter('Direct ATS', byLane.ats, caps.ats)}
    </div>
    <div class="gauge-reset">caps reset in ${resetIn} · 00:00 local</div>`;
}
function miniMeter(label, v, cap) {
  const w = clamp((v / cap) * 100, 0, 100);
  return `<div class="mini-meter"><span class="src">${esc(label)}</span><span class="bar"><i style="width:${w}%"></i></span><span class="v tnum">${v} / ${cap}</span></div>`;
}

// ============================================================================
// APPLICATIONS — virtualized (handles 4,500+ rows without freezing)
// ============================================================================
const ROW_H = 58;
function renderApplications(view, query) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Applications', { live: '' })}
    <div class="toolbar">
      <div class="search-box">${icon('search', 14)}<input id="app-search" placeholder="Filter loaded rows by title, company, status…" autocomplete="off"></div>
      <div class="seg" id="app-status-seg"></div>
    </div>
    <div class="list-frame" style="height:calc(100vh - 240px); min-height:360px;">
      <div class="list-head"><span>Status</span><span>Role</span><span>Next / detail</span><span>Via</span><span>Updated</span></div>
      <div class="vlist" id="vlist" style="flex:1;"><div class="vlist-sizer" id="vsizer"></div></div>
      <div class="list-status" id="list-status"></div>
    </div>
  </div>`);
  view.appendChild(pad);

  const STATUSES = [['', 'All'], ...STATUS_ORDER.map((s) => [s, STATUS_LABEL[s]])];
  const seg = $('#app-status-seg');
  const activeStatus = query.status || '';
  // compact the segmented control to the meaningful ones + All to avoid overflow
  const shown = [['', 'All'], ['tracked', 'Saved'], ['submitted', 'Applied'], ['acknowledged', 'Acknowledged'], ['assessment', 'Assessment'], ['interview_1', 'Interview'], ['offer', 'Offer'], ['rejected', 'Rejected']];
  seg.innerHTML = shown.map(([v, l]) => `<span data-status="${v}" class="${v === activeStatus ? 'on' : ''}">${l}</span>`).join('');
  seg.addEventListener('click', (e) => { const s = e.target.closest('span[data-status]'); if (!s) return; const v = s.getAttribute('data-status'); go(v ? `/applications?status=${v}` : '/applications'); });

  const vlist = $('#vlist'); const sizer = $('#vsizer'); const statusBar = $('#list-status');

  // virtualization model
  const model = { total: 0, status: activeStatus, pageSize: 120, pages: new Map(), pending: new Set(), search: '' };
  let rafPending = false;

  function pageFor(i) { return Math.floor(i / model.pageSize); }
  function rowAt(i) { const p = model.pages.get(pageFor(i)); if (!p) return undefined; return p[i % model.pageSize]; }
  async function loadPage(pi) {
    if (model.pages.has(pi) || model.pending.has(pi)) return;
    model.pending.add(pi);
    try {
      const q = new URLSearchParams({ limit: String(model.pageSize), offset: String(pi * model.pageSize) });
      if (model.status) q.set('status', model.status);
      const data = await api(`/applications?${q}`, { signal: psig() });
      model.total = data.total || 0; model.pages.set(pi, data.rows || []);
      sizer.style.height = `${model.total * ROW_H}px`;
      scheduleRender();
      updateStatusBar();
    } catch (e) { if (!e?.aborted) { /* leave placeholders */ } }
    finally { model.pending.delete(pi); }
  }
  function updateStatusBar() {
    const loaded = [...model.pages.values()].reduce((n, a) => n + a.length, 0);
    statusBar.innerHTML = `<span>${num(model.total)} applications${model.status ? ` · ${STATUS_LABEL[model.status]}` : ''}</span><span>${num(loaded)} loaded</span>${model.search ? `<span>filtering “${esc(model.search)}”</span>` : ''}`;
  }

  function scheduleRender() { if (rafPending) return; rafPending = true; requestAnimationFrame(renderWindow); }
  function renderWindow() {
    rafPending = false;
    if (state.routeGen !== gen) return;
    if (model.search) return renderSearch();
    const scrollTop = vlist.scrollTop; const vh = vlist.clientHeight;
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
    const last = Math.min(model.total, Math.ceil((scrollTop + vh) / ROW_H) + 6);
    // ensure covering pages are loaded
    for (let pi = pageFor(first); pi <= pageFor(Math.max(first, last - 1)); pi++) loadPage(pi);
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const row = rowAt(i);
      frag.appendChild(buildRow(i, row));
    }
    // replace rows (keep sizer)
    $$('.vrow', sizer).forEach((n) => n.remove());
    sizer.appendChild(frag);
  }
  function buildRow(i, row) {
    const n = el(`<div class="vrow" style="top:${i * ROW_H}px; height:${ROW_H}px"></div>`);
    if (!row) {
      n.innerHTML = `<div class="r-status"><span class="dot dim"></span><span class="skelbar" style="width:60px"></span></div><div class="r-title"><span class="skelbar" style="width:70%"></span></div><div class="r-meta"></div><div class="r-via"></div><div class="r-date"></div>`;
      return n;
    }
    const j = jobKnown(row.job_id);
    const titleHtml = j ? `<div class="t">${esc(j.title)}</div><div class="c">${esc(j.company || j.location || '')}</div>` : `<div class="t skel"><span class="skelbar" style="width:60%"></span></div><div class="c skel"><span class="skelbar" style="width:40%"></span></div>`;
    n.innerHTML = `
      <div class="r-status">${statusBadge(row.status)}</div>
      <div class="r-title" data-jrow="${row.job_id}">${titleHtml}</div>
      <div class="r-meta">${row.needs_review ? `<span class="needs-flag">Needs review</span>` : esc(row.next_action || (row.due_at ? `Due ${fmtDate(row.due_at)}` : '—'))}</div>
      <div class="r-via">${esc(row.via || '')}</div>
      <div class="r-date tnum">${fmtAgo(row.updated_at)}</div>`;
    n.addEventListener('click', () => openTimelineDrawer(row));
    if (!j) ensureJob(row.job_id, (job) => { const cell = $(`.r-title[data-jrow="${row.job_id}"]`, sizer); if (cell) cell.innerHTML = `<div class="t">${esc(job.title)}</div><div class="c">${esc(job.company || job.location || '')}</div>`; });
    return n;
  }
  function renderSearch() {
    // filter LOADED rows only (applications have no server text search); capped, honest.
    const q = model.search.toLowerCase();
    const all = [];
    for (const [, arr] of model.pages) for (const r of arr) all.push(r);
    const matched = all.filter((r) => {
      const j = jobKnown(r.job_id);
      const hay = `${STATUS_LABEL[r.status]} ${r.via || ''} ${j ? j.title + ' ' + j.company : ''}`.toLowerCase();
      return hay.includes(q);
    }).slice(0, 300);
    sizer.style.height = `${matched.length * ROW_H}px`;
    $$('.vrow', sizer).forEach((n) => n.remove());
    const frag = document.createDocumentFragment();
    matched.forEach((r, idx) => frag.appendChild(buildRow(idx, r)));
    sizer.appendChild(frag);
    if (!matched.length) { const e = el(`<div class="vrow" style="top:0;height:${ROW_H}px"><div class="r-meta" style="grid-column:1/-1;color:var(--ink-faint)">No matches in loaded rows — scroll the full list to load more, or clear the filter.</div></div>`); sizer.appendChild(e); }
  }

  const gen = state.routeGen;
  vlist.addEventListener('scroll', scheduleRender, { passive: true });
  $('#app-search').addEventListener('input', debounce((e) => { model.search = e.target.value.trim(); if (!model.search) { sizer.style.height = `${model.total * ROW_H}px`; } renderWindow(); updateStatusBar(); }, 200));
  loadPage(0);
}

// --- timeline drawer ---
async function openTimelineDrawer(row) {
  const j = jobKnown(row.job_id);
  const node = el(`<div class="drawer">
    <div class="drawer-h"><div class="dt"><h3 id="dr-title">${j ? esc(j.title) : 'Application'}</h3><div class="dc" id="dr-sub">${j && j.company ? esc(j.company) + ' · ' : ''}${statusBadgeText(row.status)}</div></div><button class="drawer-x">${icon('close', 16)}</button></div>
    <div class="drawer-body" id="dr-body">${loadingRow('Loading timeline…')}</div>
  </div>`);
  const close = openOverlay(node);
  node.querySelector('.drawer-x').addEventListener('click', close);
  if (!j) ensureJob(row.job_id, (job) => { const t = $('#dr-title'); if (t) t.textContent = job.title; const s = $('#dr-sub'); if (s) s.innerHTML = `${job.company ? esc(job.company) + ' · ' : ''}${statusBadgeText(row.status)}`; });
  try {
    const data = await api(`/applications/${encodeURIComponent(row.id)}/timeline`);
    const events = data.events?.rows || data.events || [];
    const emails = data.emails?.rows || data.emails || [];
    const body = $('#dr-body'); if (!body) return;
    let html = '';
    html += `<div class="drawer-sec">Timeline</div>`;
    if (!events.length) html += `<div class="empty">No events recorded yet.</div>`;
    else html += `<div class="tl-wrap">${events.map((e) => `<div class="tl"><span class="tdot"></span><div class="th">${esc(e.summary || e.kind)}</div><div class="tm">${esc(e.kind)} · ${fmtDateTime(e.at)}${e.source ? ' · ' + esc(e.source) : ''}</div></div>`).join('')}</div>`;
    if (emails.length) {
      html += `<div class="drawer-sec">Matched emails</div>`;
      html += emails.map((m) => `<div class="mail"><span class="dot sage mdot"></span><div class="mb"><div class="subj">${esc(m.subject || '(no subject)')}</div><div class="from">${esc(m.from_name || m.from_addr || '')}</div>${m.snippet ? `<div class="snip">${esc(m.snippet)}</div>` : ''}</div>${m.category ? `<span class="mcat">${esc(mailCat(m.category))}</span>` : ''}</div>`).join('');
    }
    body.innerHTML = html;
  } catch (e) { const body = $('#dr-body'); if (body) body.innerHTML = `<div class="empty">Could not load timeline — ${esc(e.message)}</div>`; }
}
function statusBadgeText(status) { return `<span class="sbadge"><span class="dot ${STATUS_DOT[status] || 'dim'}"></span>${esc(STATUS_LABEL[status] || status)}</span>`; }

// ============================================================================
// PIPELINE — kanban of human statuses (counts + first cards + "+N more")
// ============================================================================
const PIPE_COLUMNS = ['tracked', 'submitted', 'acknowledged', 'assessment', 'interview_1', 'interview_2', 'interview_final', 'offer', 'hired'];
const PIPE_TERMINAL = ['rejected', 'withdrawn', 'ghosted'];
function renderPipeline(view) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Pipeline', { sub: 'Human statuses · counts from the 90-day funnel' })}
    <div class="card" style="padding:20px 22px 8px"><div class="board" id="board">${loadingRow('Building the board…')}</div></div>
  </div>`);
  view.appendChild(pad);
  poll(20000, async () => {
    const stats = await api('/stats', { signal: psig() });
    const f = stats.funnel || {};
    const board = $('#board'); if (!board) return;
    const cols = [...PIPE_COLUMNS.map((s) => ({ s, count: f[s] || 0 })), ...PIPE_TERMINAL.map((s) => ({ s, count: f[s] || 0, terminal: true }))];
    board.innerHTML = cols.map((c) => `
      <div class="col ${c.terminal ? 'terminal' : ''}" data-col="${c.s}">
        <div class="col-h" data-status="${c.s}"><span class="dot ${STATUS_DOT[c.s]}"></span><span class="nm">${STATUS_LABEL[c.s]}</span><span class="ct tnum">${num(c.count)}</span></div>
        <div class="col-cards" id="col-${c.s}">${c.count ? loadingRow('') : `<div class="col-empty">empty</div>`}</div>
      </div>`).join('');
    $$('#board .col-h').forEach((h) => h.addEventListener('click', () => go(`/applications?status=${h.getAttribute('data-status')}`)));
    // load a few cards per non-empty column (bounded fetches)
    cols.filter((c) => c.count > 0).forEach((c) => loadColumnCards(c.s, c.count));
  });
}
async function loadColumnCards(status, count) {
  try {
    const data = await api(`/applications?status=${status}&limit=4`, { signal: psig() });
    const box = $(`#col-${status}`); if (!box) return;
    const rows = data.rows || [];
    const shown = rows.length;
    box.innerHTML = rows.map((r) => pipeCard(r, status)).join('') + (count > shown ? `<div class="more" data-status="${status}">+ ${num(count - shown)} more</div>` : '');
    box.querySelectorAll('.more').forEach((m) => m.addEventListener('click', () => go(`/applications?status=${status}`)));
    rows.forEach((r) => { if (!jobKnown(r.job_id)) ensureJob(r.job_id, (j) => patchPipeCard(r, j)); else patchPipeCard(r, jobKnown(r.job_id)); });
  } catch (e) { if (!e?.aborted) { const box = $(`#col-${status}`); if (box) box.innerHTML = `<div class="col-empty">—</div>`; } }
}
function pipeCard(r, status) {
  const j = jobKnown(r.job_id);
  const note = r.needs_review ? 'Needs review' : (r.next_action || (r.due_at ? `Due ${fmtDate(r.due_at)}` : ''));
  return `<div class="job ${status === 'offer' ? 'offer' : ''}" data-appid="${r.id}" data-jc="${r.job_id}">
    <div class="jt" data-jt2="${r.job_id}">${j ? esc(j.title) : 'Loading…'}</div>
    <div class="jc">${srcTag(r.via === 'import' ? 'web' : (j?.source || ''))} <span data-jco="${r.job_id}">${j ? esc(j.company || '') : ''}</span></div>
    <div class="jf"><span class="ago">${fmtAgo(r.updated_at)}</span>${note ? `<span class="note">${esc(note)}</span>` : ''}</div>
  </div>`;
}
function patchPipeCard(r, j) {
  if (!j) return;
  const t = $(`[data-jt2="${r.job_id}"]`); if (t) t.textContent = j.title;
  const co = $(`[data-jco="${r.job_id}"]`); if (co) co.textContent = j.company || '';
}

// ============================================================================
// AUTO-APPLY (mission control) + NEEDS YOU (shared queue)
// ============================================================================
function renderAuto(view) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Auto-Apply', { sub: 'Mission control — the engine, its live runs, and everything it needs from you' })}
    <div class="card" style="padding:18px 22px">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <button class="btn ${state.applying ? '' : 'primary'}" id="auto-onoff">${state.applying ? 'Pause auto-apply' : 'Start auto-apply'}</button>
        <span class="pill ${state.applying ? 'on' : 'off'}" id="auto-pill">${state.applying ? '<span class="dot live"></span>Running' : 'Idle'}</span>
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm" id="auto-config">Configure caps & keywords</button>
      </div>
    </div>
    <div class="grid">
      <div class="card col-flex span-7 hoverable"><div class="card-h"><span class="cap">Live runs</span><div class="spacer"></div><span class="aside" id="auto-live-n">—</span></div><div id="auto-live">${loadingRow()}</div></div>
      <div class="card col-flex span-5 hoverable"><div class="card-h"><span class="cap">Needs you</span><span class="nav-badge" id="auto-needs-n"></span><div class="spacer"></div></div><div id="auto-queue">${loadingRow()}</div></div>
    </div>
    <div class="card col-flex hoverable"><div class="card-h"><span class="cap">History</span><div class="spacer"></div><span class="aside">last 100 finished runs</span></div><div id="auto-history">${loadingRow()}</div></div>
  </div>`);
  view.appendChild(pad);
  $('#auto-onoff').addEventListener('click', async () => { await toggleApplying(); const b = $('#auto-onoff'); if (b) b.textContent = state.applying ? 'Pause auto-apply' : 'Start auto-apply'; const p = $('#auto-pill'); if (p) { p.className = 'pill ' + (state.applying ? 'on' : 'off'); p.innerHTML = state.applying ? '<span class="dot live"></span>Running' : 'Idle'; } });
  $('#auto-config').addEventListener('click', () => go('/settings'));

  poll(2000, async () => {
    const data = await api('/runs?limit=60', { signal: psig() });
    const rows = data.rows || [];
    const active = rows.filter((r) => ACTIVE_STATES.includes(r.state));
    $('#auto-live-n').textContent = `${active.length} in flight`;
    const box = $('#auto-live');
    if (!active.length) box.innerHTML = `<div class="empty">${state.applying ? 'Between leases — nothing in flight this instant.' : 'Idle. Start the engine to see live runs.'}</div>`;
    else { box.innerHTML = active.slice(0, 8).map((r, i) => runTheatreRow(r, i)).join(''); active.forEach((r) => { if (!jobKnown(r.job_id)) ensureJob(r.job_id, () => { const n = $(`#auto-live [data-jt="${r.job_id}"]`); const j = jobKnown(r.job_id); if (n && j) n.innerHTML = `${esc(j.title)}${j.company ? ` <span>— ${esc(j.company)}</span>` : ''}`; }); }); }
  });
  poll(4000, async () => { await loadQueue('#auto-queue', '#auto-needs-n', 12); });
  poll(15000, async () => {
    const data = await api('/runs?limit=100', { signal: psig() });
    const rows = (data.rows || []).filter((r) => TERMINAL_RUN.has(r.state)).slice(0, 60);
    const box = $('#auto-history'); if (!box) return;
    if (!rows.length) { box.innerHTML = `<div class="empty">No finished runs yet.</div>`; return; }
    box.innerHTML = rows.map((r) => historyRow(r)).join('');
    rows.forEach((r) => { if (!jobKnown(r.job_id)) ensureJob(r.job_id, () => { const j = jobKnown(r.job_id); const n = $(`#auto-history [data-jh="${r.job_id}"]`); if (n && j) n.textContent = `${j.title}${j.company ? ' — ' + j.company : ''}`; }); });
  });
}
function historyRow(r) {
  const rs = RUN_STATE[r.state] || { label: r.state };
  const dot = r.state === 'submitted' ? 'bronze' : r.state === 'parked' ? 'ember' : r.state === 'failed' ? 'danger' : r.state === 'ready_for_review' ? 'gold' : 'dim';
  const j = jobKnown(r.job_id);
  return `<div class="act"><span class="time">${fmtTime(r.finished_at || r.updated_at)}</span><span class="atag" style="width:120px"><span class="dot ${dot}"></span>${esc(rs.label)}</span><span class="txt"><b data-jh="${r.job_id}">${j ? esc(j.title + (j.company ? ' — ' + j.company : '')) : 'Run ' + r.id.slice(-6)}</b>${r.park_kind ? ' · ' + esc(PARK_LABEL[r.park_kind] || r.park_kind) : ''}${r.error ? ' · ' + esc(String(r.error).slice(0, 60)) : ''}</span><span class="via">${srcTag(r.source)}</span></div>`;
}

function renderNeeds(view) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Needs You', { sub: 'Runs parked waiting on a human — answer screening questions, clear reviews' })}
    <div class="card col-flex"><div class="card-h"><span class="cap">Queue</span><span class="nav-badge" id="needs-n"></span><div class="spacer"></div><button class="btn sm" id="needs-refresh">${icon('refresh', 13)} Refresh</button></div><div id="needs-queue">${loadingRow()}</div></div>
  </div>`);
  view.appendChild(pad);
  $('#needs-refresh').addEventListener('click', () => loadQueue('#needs-queue', '#needs-n', 40));
  poll(5000, async () => { await loadQueue('#needs-queue', '#needs-n', 40); });
}

// shared queue loader (capped render + "N more"; expandable answer form)
async function loadQueue(boxSel, countSel, cap) {
  const data = await api('/needs-you', { signal: psig() });
  const human = data.needsHuman || []; const review = data.readyForReview || [];
  const all = [...human, ...review];
  const cEl = countSel ? $(countSel) : null; if (cEl) cEl.textContent = all.length ? String(all.length) : '';
  const box = $(boxSel); if (!box) return;
  if (!all.length) { box.innerHTML = `<div class="empty">The queue is clear. Nothing needs you.</div>`; return; }
  const shown = all.slice(0, cap);
  box.innerHTML = shown.map((r) => queueItem(r)).join('') + (all.length > shown.length ? `<div class="card-foot"><span>${num(all.length - shown.length)} more waiting — resolve these first</span></div>` : '');
  shown.forEach((r) => {
    if (!jobKnown(r.job_id)) ensureJob(r.job_id, () => { const j = jobKnown(r.job_id); const n = $(`${boxSel} [data-qt="${r.id}"]`); if (n && j) n.innerHTML = `${esc(j.title)}${j.company ? ` <span>— ${esc(j.company)}</span>` : ''}`; });
  });
  $$(`${boxSel} .queue-row`).forEach((rowEl) => rowEl.addEventListener('click', () => toggleAnswerForm(rowEl, boxSel)));
}
function queueItem(r) {
  const review = r.state === 'ready_for_review';
  const answerable = review || ANSWERABLE_PARK.has(r.park_kind);
  const kind = review ? 'Ready for review' : (PARK_LABEL[r.park_kind] || 'Needs attention');
  const j = jobKnown(r.job_id);
  return `<div class="queue-item" data-runid="${r.id}" data-answerable="${answerable ? 1 : 0}" data-park="${esc(r.park_kind || '')}">
    <div class="queue-row">
      <div class="glyph ${answerable ? '' : 'c'}">${icon(answerable ? 'question' : 'shield', 17)}</div>
      <div class="qb"><div class="qt" data-qt="${r.id}">${j ? `${esc(j.title)}${j.company ? ` <span>— ${esc(j.company)}</span>` : ''}` : 'Loading role…'}</div><div class="qs">${esc(kind)} · ${srcTagText(r.source)} · ${esc(String(r.state).replace(/_/g, ' '))}</div></div>
      <span class="age">${fmtAgo(r.updated_at)}</span>
    </div>
  </div>`;
}
function srcTagText(s) { const k = String(s || '').toLowerCase(); return SRC_TAG[k] ? k : (s || 'source'); }

function toggleAnswerForm(rowEl, boxSel) {
  const item = rowEl.closest('.queue-item');
  const existing = item.querySelector('.answer-form');
  if (existing) { existing.remove(); return; }
  // collapse others
  $$(`${boxSel} .answer-form`).forEach((f) => f.remove());
  const runId = item.getAttribute('data-runid');
  const answerable = item.getAttribute('data-answerable') === '1';
  const park = item.getAttribute('data-park');
  const form = el(`<div class="answer-form"><div class="ctx" id="ctx-${runId}">Loading context…</div></div>`);
  item.appendChild(form);
  // fetch steps for context (lazy, only on expand)
  api(`/runs/${encodeURIComponent(runId)}/steps`).then((d) => {
    const steps = d.steps || []; const last = steps[steps.length - 1];
    const ctx = $(`#ctx-${runId}`);
    if (ctx) ctx.textContent = last ? `last step — ${last.phase}${last.action ? ' · ' + last.action : ''}${last.detail ? ' · ' + String(last.detail).slice(0, 80) : ''}` : 'No steps recorded for this run.';
  }).catch(() => { const ctx = $(`#ctx-${runId}`); if (ctx) ctx.textContent = ''; });

  if (!answerable) {
    form.insertAdjacentHTML('beforeend', `<div style="font-size:12px;color:var(--ink-dim)">${PARK_LABEL[park] || 'This'} can't be answered from here — it needs you to act in the browser (sign-in / human verification). Per the standing workflow, skip it and let the engine move on.</div>`);
    return;
  }
  form.insertAdjacentHTML('beforeend', `
    <div class="row2">
      <div><label class="field-label">Question / field label</label><input class="inp" id="ans-q-${runId}" placeholder="e.g. Years of experience with React"></div>
    </div>
    <div class="row2">
      <div><label class="field-label">Answer</label><input class="inp" id="ans-v-${runId}" placeholder="Your answer — saved to profile memory (locked)"></div>
      <div style="flex:0 0 120px;min-width:110px"><label class="field-label">Kind</label><select class="inp" id="ans-k-${runId}"><option value="qa">Q&A</option><option value="field">Field</option></select></div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn sm" id="ans-skip-${runId}">Cancel</button><button class="btn sm primary" id="ans-save-${runId}">${icon('check', 13)} Answer & resume</button></div>`);
  form.querySelector(`#ans-skip-${runId}`).addEventListener('click', () => form.remove());
  form.querySelector(`#ans-save-${runId}`).addEventListener('click', async () => {
    const label = form.querySelector(`#ans-q-${runId}`).value.trim();
    const value = form.querySelector(`#ans-v-${runId}`).value.trim();
    const kind = form.querySelector(`#ans-k-${runId}`).value;
    if (!label || !value) { toast('Enter both a question and an answer', 'danger', 3000); return; }
    if (!state.profileId) { toast('No default profile loaded', 'danger'); return; }
    try {
      await api(`/runs/${encodeURIComponent(runId)}/answer`, { method: 'POST', body: { answers: [{ profileId: state.profileId, label, value, kind }] } });
      toast('Answered — run re-queued', 'success', 3000);
      item.remove();
    } catch (e) { errToast(e, 'Answer'); }
  });
}

// ============================================================================
// PROFILE — full-width two columns (identity editor + learned answers)
// ============================================================================
const PROFILE_FIELDS = [
  { key: 'email', label: 'Email', alts: ['email', 'emailAddress'] },
  { key: 'phone', label: 'Phone', alts: ['phone', 'phoneNumber', 'mobile'], half: true },
  { key: 'location', label: 'Location', alts: ['location', 'city', 'cityState'], half: true },
  { key: 'linkedin', label: 'LinkedIn', alts: ['linkedin', 'linkedIn', 'linkedinUrl'] },
  { key: 'portfolio', label: 'Portfolio / Website', alts: ['portfolio', 'website', 'personalSite'], half: true },
  { key: 'github', label: 'GitHub', alts: ['github', 'githubUrl'], half: true },
  { key: 'workAuthorization', label: 'Work authorization', alts: ['workAuthorization', 'work_authorization', 'authorization'] },
  { key: 'salaryTarget', label: 'Salary target', alts: ['salaryTarget', 'salary', 'salaryExpectation'] },
];
function readField(data, alts) { for (const a of alts) { if (data && data[a] != null && data[a] !== '') return data[a]; } return ''; }

async function renderProfile(view) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Profile', { sub: 'Used by auto-apply on every source' })}
    <div class="prof-grid">
      <div class="card" id="id-card">${loadingRow('Loading profile…')}</div>
      <div class="card col-flex" id="la-card">
        <div class="card-h"><span class="cap">Learned answers</span><div class="spacer"></div><span class="aside" id="la-count">—</span></div>
        <div class="la-sub">Memory the engine learned from your applications. Locked answers are used verbatim and never overwritten.</div>
        <div class="la-tools"><div class="search-box">${icon('search', 13)}<input id="la-search" placeholder="Filter questions…" autocomplete="off"></div></div>
        <div id="la-rows">${loadingRow()}</div>
      </div>
    </div>
  </div>`);
  view.appendChild(pad);

  // load profiles → default
  let profile;
  try {
    const list = await api('/profiles', { signal: psig() });
    const rows = list.rows || [];
    const def = rows.find((r) => r.is_default) || rows[0];
    if (!def) { $('#id-card').innerHTML = `<div class="empty">No profile found.</div>`; return; }
    state.profileId = def.id; state.profileName = def.name || state.profileName;
    profile = await api(`/profiles/${encodeURIComponent(def.id)}`, { signal: psig() });
  } catch (e) { if (!e?.aborted) $('#id-card').innerHTML = `<div class="empty">Could not load profile — ${esc(e.message)}</div>`; return; }

  renderIdentityCard(profile);
  loadLearnedAnswers('');
  $('#la-search').addEventListener('input', debounce((e) => loadLearnedAnswers(e.target.value.trim()), 250));
}
function renderIdentityCard(profile) {
  const data = (profile.data && typeof profile.data === 'object') ? profile.data : {};
  const card = $('#id-card'); if (!card) return;
  const role = readField(data, ['title', 'role', 'headline']) || 'Applicant';
  const loc = readField(data, ['location', 'city']) || '';
  card.innerHTML = `
    <div class="id-head"><div class="id-avatar">${initials(profile.name)}</div><div><div class="nm">${esc(profile.name || 'Profile')}</div><div class="rl">${esc(role)}${loc ? ' · ' + esc(loc) : ''}</div></div></div>
    <div class="fields" id="id-fields">
      <div class="field"><label class="field-label">Full name</label><input class="inp" data-pf="__name" value="${esc(profile.name || '')}"></div>
      ${renderFieldRows(data)}
    </div>
    <div class="id-actions"><button class="btn primary" id="prof-save">${icon('check', 13)} Save changes</button><button class="btn" id="prof-export">${icon('download', 13)} Export</button><button class="btn" id="prof-docs">Manage documents</button></div>`;
  $('#prof-save').addEventListener('click', () => saveProfile(profile));
  $('#prof-export').addEventListener('click', () => downloadUrl('/export', 'jat13-export.json'));
  $('#prof-docs').addEventListener('click', () => go('/documents'));
}
function renderFieldRows(data) {
  const rows = [];
  let i = 0;
  while (i < PROFILE_FIELDS.length) {
    const f = PROFILE_FIELDS[i];
    if (f.half && PROFILE_FIELDS[i + 1]?.half) {
      const g = PROFILE_FIELDS[i + 1];
      rows.push(`<div class="field-2col"><div class="field"><label class="field-label">${f.label}</label><input class="inp" data-pf="${f.key}" data-alts="${f.alts.join(',')}" value="${esc(readField(data, f.alts))}"></div><div class="field"><label class="field-label">${g.label}</label><input class="inp" data-pf="${g.key}" data-alts="${g.alts.join(',')}" value="${esc(readField(data, g.alts))}"></div></div>`);
      i += 2;
    } else {
      rows.push(`<div class="field"><label class="field-label">${f.label}</label><input class="inp" data-pf="${f.key}" data-alts="${f.alts.join(',')}" value="${esc(readField(data, f.alts))}"></div>`);
      i += 1;
    }
  }
  return rows.join('');
}
async function saveProfile(profile) {
  const data = (profile.data && typeof profile.data === 'object') ? { ...profile.data } : {};
  let name = profile.name;
  $$('#id-fields [data-pf]').forEach((inp) => {
    const key = inp.getAttribute('data-pf'); const val = inp.value;
    if (key === '__name') { name = val; return; }
    const alts = (inp.getAttribute('data-alts') || key).split(',');
    // write to the first existing alt key, else the canonical key
    const existing = alts.find((a) => a in data);
    data[existing || key] = val;
  });
  try {
    await api(`/profiles/${encodeURIComponent(profile.id)}`, { method: 'PUT', body: { name, data } });
    profile.name = name; profile.data = data; state.profileName = name;
    $('#user-name').textContent = name; $('#user-avatar').textContent = initials(name);
    toast('Profile saved', 'success', 2500);
  } catch (e) { errToast(e, 'Save'); }
}
async function loadLearnedAnswers(q) {
  if (!state.profileId) return;
  const box = $('#la-rows'); if (box && !box.querySelector('.la-row')) box.innerHTML = loadingRow();
  try {
    const params = new URLSearchParams({ profileId: state.profileId, limit: '200' });
    if (q) params.set('q', q);
    const data = await api(`/answers?${params}`, { signal: psig() });
    const rows = data.rows || [];
    const cnt = $('#la-count'); if (cnt) cnt.textContent = `${num(data.total || rows.length)} learned`;
    const b = $('#la-rows'); if (!b) return;
    if (!rows.length) { b.innerHTML = `<div class="empty">${q ? 'No answers match that filter.' : 'No learned answers yet — they accrue as the engine applies.'}</div>`; return; }
    b.innerHTML = rows.map((a) => learnedRow(a)).join('');
    b.querySelectorAll('.la-row').forEach((rowEl) => wireLearnedRow(rowEl));
  } catch (e) { if (!e?.aborted) { const b = $('#la-rows'); if (b) b.innerHTML = `<div class="empty">Could not load answers — ${esc(e.message)}</div>`; } }
}
function learnedRow(a) {
  const conf = Math.round((a.confidence || 0) * 100);
  const low = conf < 80;
  return `<div class="la-row" data-id="${a.id}" data-locked="${a.locked ? 1 : 0}">
    <div class="la-q"><div class="lbl">${esc(a.label)}</div><div class="meta"><span>${esc(a.provenance)}</span><span>seen ${a.seen_count || 0}×</span><span>used ${a.used_count || 0}×</span>${a.field_type ? `<span>${esc(a.field_type)}</span>` : ''}</div></div>
    <div class="conf"><span class="bar ${low ? 'low' : ''}"><i style="width:${conf}%"></i></span><span class="v tnum">${conf}</span></div>
    <div class="lock ${a.locked ? '' : 'open'}" title="${a.locked ? 'Locked — used verbatim' : 'Unlocked'}">${icon(a.locked ? 'lock' : 'unlock', 14)}</div>
    <div class="iconbtn del" title="Delete">${icon('trash', 14)}</div>
  </div>`;
}
function wireLearnedRow(rowEl) {
  const id = rowEl.getAttribute('data-id');
  rowEl.querySelector('.la-q').addEventListener('click', () => {
    if (rowEl.querySelector('.editrow')) { rowEl.querySelector('.editrow').remove(); return; }
    const q = rowEl.querySelector('.la-q');
    const edit = el(`<div class="editrow"><input class="inp" placeholder="Set a new answer (value not shown for privacy)"><button class="btn sm primary">Save</button></div>`);
    q.appendChild(edit);
    edit.querySelector('input').focus();
    edit.querySelector('button').addEventListener('click', async () => {
      const v = edit.querySelector('input').value.trim(); if (!v) { edit.remove(); return; }
      try { await api(`/answers/${encodeURIComponent(id)}`, { method: 'PUT', body: { value: v } }); toast('Answer updated', 'success', 2000); edit.remove(); } catch (e) { errToast(e); }
    });
  });
  rowEl.querySelector('.lock').addEventListener('click', async (e) => {
    e.stopPropagation();
    const locked = rowEl.getAttribute('data-locked') === '1';
    try { await api(`/answers/${encodeURIComponent(id)}`, { method: 'PUT', body: { locked: !locked } }); rowEl.setAttribute('data-locked', locked ? '0' : '1'); const l = rowEl.querySelector('.lock'); l.className = 'lock ' + (locked ? 'open' : ''); l.innerHTML = icon(locked ? 'unlock' : 'lock', 14); } catch (err) { errToast(err); }
  });
  rowEl.querySelector('.del').addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await api(`/answers/${encodeURIComponent(id)}`, { method: 'DELETE' }); rowEl.remove(); toast('Answer removed', 'info', 2000); } catch (err) { errToast(err); }
  });
}

// ============================================================================
// DOCUMENTS — real management (upload / download / set-default / delete)
// ============================================================================
async function renderDocuments(view) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Documents', { sub: 'Résumés, cover letters and portfolios the engine attaches' })}
    <div class="card col-flex">
      <div class="card-h"><span class="cap">Library</span><div class="spacer"></div><span class="aside" id="doc-count">—</span></div>
      <div id="doc-list">${loadingRow()}</div>
      <div class="upload-zone">
        <label class="file-pick" for="doc-file">
          <span class="file-btn">${icon('upload', 13)} Choose file</span>
          <span class="file-name" id="doc-file-name">No file selected</span>
        </label>
        <input type="file" id="doc-file" hidden />
        <select class="inp" id="doc-role" style="max-width:180px"><option value="resume">Résumé</option><option value="cover_letter">Cover letter</option><option value="portfolio">Portfolio</option><option value="transcript">Transcript</option><option value="other">Other</option></select>
        <input class="inp" id="doc-label" placeholder="Label (optional)" style="max-width:220px" />
        <button class="btn primary" id="doc-upload">${icon('upload', 13)} Upload</button>
      </div>
    </div>
  </div>`);
  view.appendChild(pad);
  $('#doc-upload').addEventListener('click', uploadDocument);
  $('#doc-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    const n = $('#doc-file-name'); if (n) { n.textContent = f ? f.name : 'No file selected'; n.classList.toggle('has', !!f); }
  });
  await loadDocuments();
}
async function loadDocuments() {
  try {
    const data = await api('/documents', { signal: psig() });
    const rows = data.rows || [];
    const cnt = $('#doc-count'); if (cnt) cnt.textContent = `${rows.length} file${rows.length === 1 ? '' : 's'}`;
    const list = $('#doc-list'); if (!list) return;
    if (!rows.length) { list.innerHTML = `<div class="empty">No documents yet — upload a résumé to get started.</div>`; return; }
    list.innerHTML = rows.map((d) => docRow(d)).join('');
    list.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => downloadUrl(`/documents/${b.getAttribute('data-dl')}/download`, b.getAttribute('data-name'))));
    list.querySelectorAll('[data-def]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/documents/${b.getAttribute('data-def')}/default`, { method: 'POST' }); toast('Set as default', 'success', 2000); loadDocuments(); } catch (e) { errToast(e); } }));
    list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/documents/${b.getAttribute('data-del')}`, { method: 'DELETE' }); toast('Deleted', 'info', 2000); loadDocuments(); } catch (e) { errToast(e); } }));
  } catch (e) { if (!e?.aborted) { const list = $('#doc-list'); if (list) list.innerHTML = `<div class="empty">Could not load documents — ${esc(e.message)}</div>`; } }
}
function docRow(d) {
  const roleLabel = { resume: 'Résumé', cover_letter: 'Cover letter', portfolio: 'Portfolio', transcript: 'Transcript', other: 'Other' }[d.role] || d.role;
  return `<div class="doc-row">
    <div class="doc-ic">${icon('doc', 18)}</div>
    <div class="doc-b"><div class="n">${esc(d.name)}</div><div class="m"><span class="rolebadge">${esc(roleLabel)}</span>${d.is_default ? '<span class="defbadge">Default</span>' : ''}<span>${fmtBytes(d.size_bytes)}</span><span>${esc(d.mime || '')}</span><span>added ${fmtDate(d.created_at)}</span>${d.missing_file ? '<span style="color:var(--ember)">missing file</span>' : ''}</div></div>
    <div class="doc-actions">
      <button class="btn sm" data-dl="${d.id}" data-name="${esc(d.name)}">${icon('download', 13)}</button>
      ${d.is_default ? '' : `<button class="btn sm" data-def="${d.id}">Set default</button>`}
      <button class="btn sm danger" data-del="${d.id}">${icon('trash', 13)}</button>
    </div>
  </div>`;
}
async function uploadDocument() {
  const fileInput = $('#doc-file'); const file = fileInput?.files?.[0];
  if (!file) { toast('Choose a file first', 'danger', 3000); return; }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('role', $('#doc-role').value);
  const label = $('#doc-label').value.trim(); if (label) fd.append('label', label);
  const btn = $('#doc-upload'); if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  try { await api('/documents', { method: 'POST', formData: fd, timeoutMs: 60000 }); toast('Uploaded', 'success', 2500); fileInput.value = ''; $('#doc-label').value = ''; const n = $('#doc-file-name'); if (n) { n.textContent = 'No file selected'; n.classList.remove('has'); } await loadDocuments(); }
  catch (e) { errToast(e, 'Upload'); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = `${icon('upload', 13)} Upload`; } }
}

// ============================================================================
// INBOX
// ============================================================================
function renderInbox(view) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Inbox', { sub: 'Employer emails matched to your applications' })}
    <div class="card col-flex" id="sugg-card"><div class="card-h"><span class="cap">Suggested matches</span><div class="spacer"></div><span class="aside">to review</span></div><div id="sugg-list">${loadingRow()}</div></div>
    <div class="card col-flex"><div class="card-h"><span class="cap">Recent emails</span><div class="spacer"></div><div class="seg" id="inbox-cat"></div></div><div id="mail-list">${loadingRow()}</div></div>
  </div>`);
  view.appendChild(pad);
  const cats = [['', 'All'], ['application_ack', 'Acknowledged'], ['interview', 'Interview'], ['assessment', 'Assessment'], ['rejection', 'Rejection'], ['offer', 'Offer']];
  const seg = $('#inbox-cat');
  seg.innerHTML = cats.map(([v, l], i) => `<span data-cat="${v}" class="${i === 0 ? 'on' : ''}">${l}</span>`).join('');
  seg.addEventListener('click', (e) => { const s = e.target.closest('span[data-cat]'); if (!s) return; seg.querySelectorAll('span').forEach((x) => x.classList.remove('on')); s.classList.add('on'); loadEmails(s.getAttribute('data-cat')); });

  poll(30000, async () => {
    const sug = await api('/emails/suggestions', { signal: psig() }).catch(() => ({ rows: [] }));
    const box = $('#sugg-list'); if (box) {
      const rows = sug.rows || [];
      box.innerHTML = rows.length ? rows.map((m) => mailRow(m, true)).join('') : `<div class="empty">No suggestions awaiting review.</div>`;
    }
  });
  loadEmails('');
}
async function loadEmails(category) {
  try {
    const params = new URLSearchParams({ limit: '60' }); if (category) params.set('category', category);
    const data = await api(`/emails?${params}`, { signal: psig() });
    const rows = data.rows || [];
    const box = $('#mail-list'); if (!box) return;
    box.innerHTML = rows.length ? rows.map((m) => mailRow(m)).join('') : `<div class="empty">No emails in this category.</div>`;
  } catch (e) { if (!e?.aborted) { const box = $('#mail-list'); if (box) box.innerHTML = `<div class="empty">Could not load emails — ${esc(e.message)}</div>`; } }
}
function mailRow(m, suggestion) {
  return `<div class="mail"><span class="dot ${suggestion ? 'ember' : 'sage'} mdot"></span><div class="mb"><div class="subj">${esc(m.subject || '(no subject)')}</div><div class="from">${esc(m.from_name || m.from_addr || '')}</div>${m.snippet ? `<div class="snip">${esc(m.snippet)}</div>` : ''}</div>${m.category ? `<span class="mcat">${esc(mailCat(m.category))}</span>` : ''}<span class="mtime">${fmtAgo(m.sent_at || m.created_at)}</span></div>`;
}

// ============================================================================
// ACTIVITY
// ============================================================================
function renderActivity(view) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Activity', { sub: 'Everything the engine has recorded' })}
    <div class="card col-flex"><div class="card-h"><span class="cap">Ledger</span><div class="spacer"></div><div class="seg" id="act-filter"></div></div><div id="act-list">${loadingRow()}</div></div>
  </div>`);
  view.appendChild(pad);
  const kinds = [['', 'All'], ['submitted', 'Applied'], ['status_change', 'Status'], ['email_matched', 'Emails'], ['park', 'Parked'], ['created', 'Found']];
  const seg = $('#act-filter');
  seg.innerHTML = kinds.map(([v, l], i) => `<span data-kind="${v}" class="${i === 0 ? 'on' : ''}">${l}</span>`).join('');
  let filter = '';
  seg.addEventListener('click', (e) => { const s = e.target.closest('span[data-kind]'); if (!s) return; seg.querySelectorAll('span').forEach((x) => x.classList.remove('on')); s.classList.add('on'); filter = s.getAttribute('data-kind'); paint(); });
  let cache = [];
  function paint() { const box = $('#act-list'); if (!box) return; const rows = filter ? cache.filter((e) => e.kind === filter) : cache; box.innerHTML = rows.length ? rows.map((e) => activityRowFull(e)).join('') : `<div class="empty">No matching activity.</div>`; }
  poll(10000, async () => { const data = await api('/events/recent?limit=80', { signal: psig() }); cache = data.rows || []; paint(); });
}
function activityRowFull(e) {
  const label = { status_change: 'Status', submitted: 'Applied', park: 'Parked', email_matched: 'Email', created: 'Found', imported: 'Imported', note: 'Note', document_attached: 'Document' }[e.kind] || e.kind;
  const dotByKind = { submitted: 'bronze', status_change: 'gold', park: 'ember', email_matched: 'sage', created: 'dim', imported: 'dim', note: 'dim', document_attached: 'bronze' };
  return `<div class="act"><span class="time">${fmtTime(e.at)}</span><span class="atag ${esc(e.kind)}"><span class="dot ${dotByKind[e.kind] || 'dim'}"></span>${esc(label)}</span><span class="txt">${esc(e.summary || '(no detail)')}</span><span class="via">${esc(e.source || '')}</span></div>`;
}

// ============================================================================
// SETTINGS
// ============================================================================
async function renderSettings(view) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Settings')}
    <div class="card"><div class="card-h"><span class="cap">Appearance</span><div class="spacer"></div><span class="aside">bronze accent · both grounds</span></div>
      <div class="theme-grid" id="theme-grid"></div></div>
    <div class="settings-grid">
      <div class="card col-flex"><div class="card-h"><span class="cap">AI answering</span><div class="spacer"></div><button class="btn sm" id="ai-detect">Detect</button></div><div class="card-body" id="ai-body">${loadingRow()}</div></div>
      <div class="card col-flex"><div class="card-h"><span class="cap">Gmail</span><div class="spacer"></div><button class="btn sm" id="gmail-connect">Connect</button></div><div class="card-body" id="gmail-body">${loadingRow()}</div></div>
    </div>
    <div class="card col-flex"><div class="card-h"><span class="cap">Auto-apply</span><div class="spacer"></div><span class="aside">keywords · locations · caps</span></div><div class="card-body" id="autoapply-body">${loadingRow()}</div></div>
    <div class="settings-grid">
      <div class="card col-flex"><div class="card-h"><span class="cap">Import from v11</span></div><div class="card-body" id="import-body"></div></div>
      <div class="card col-flex"><div class="card-h"><span class="cap">Token health</span><div class="spacer"></div><button class="btn sm" id="tok-refresh">${icon('refresh', 13)}</button></div><div class="card-body" id="tok-body">${loadingRow()}</div></div>
    </div>
    <div class="settings-grid">
      <div class="card col-flex"><div class="card-h"><span class="cap">Adapters</span></div><div class="card-body" id="adapters-body">${loadingRow()}</div></div>
      <div class="card col-flex"><div class="card-h"><span class="cap">Data</span></div><div class="card-body"><div class="row"><div class="k"><div class="kn">Export everything</div><div class="kd">Download jobs + applications as JSON.</div></div><button class="btn" id="export-btn">${icon('download', 13)} Export</button></div><div class="row"><div class="k"><div class="kn">Version</div><div class="kd" id="ver-line">—</div></div></div></div></div>
    </div>
  </div>`);
  view.appendChild(pad);

  renderThemeGrid();
  loadSettingsData();
  renderImportWizard();
  $('#export-btn').addEventListener('click', () => downloadUrl('/export', 'jat13-export.json'));
  $('#ai-detect').addEventListener('click', detectAi);
  $('#gmail-connect').addEventListener('click', connectGmail);
  $('#tok-refresh').addEventListener('click', loadTokenHealth);
  api('/version').then((v) => { const l = $('#ver-line'); if (l) l.textContent = `JAT 13 · v${v.version} · protocol ${v.protocol}`; }).catch(() => {});
}
function renderThemeGrid() {
  const grid = $('#theme-grid'); if (!grid) return;
  const cur = getMode();
  grid.innerHTML = THEMES.map((t) => `<div class="theme-tile ${t.id === cur ? 'active' : ''}" data-theme="${t.id}"><div class="swatch ${t.swatch}"><span class="chipbar"></span></div><div class="tn">${t.name}</div><div class="td">${t.mode}</div></div>`).join('');
  grid.querySelectorAll('.theme-tile').forEach((tile) => tile.addEventListener('click', () => { setTheme(tile.getAttribute('data-theme')); renderThemeGrid(); }));
}
async function loadSettingsData() {
  let settings;
  try { settings = await api('/settings', { signal: psig() }); state.settings = settings; } catch (e) { if (e?.aborted) return; }
  renderAutoApplySettings(settings || {});
  loadAiCard();
  loadGmailCard();
  loadTokenHealth();
  loadAdapters();
}
function renderAutoApplySettings(settings) {
  const aa = settings.autoApply || {};
  const body = $('#autoapply-body'); if (!body) return;
  body.innerHTML = `
    <div class="field" style="padding:8px 0"><label class="field-label">Keywords</label><div class="tag-input" id="kw-input"></div></div>
    <div class="field" style="padding:8px 0"><label class="field-label">Locations</label><div class="tag-input" id="loc-input"></div></div>
    <div class="row"><div class="k"><div class="kn">Max applications / day</div><div class="kd">Hard daily cap across all sources.</div></div><input class="inp tnum" id="cap-day" type="number" min="0" max="1000" value="${aa.maxPerDay ?? 120}" style="max-width:110px;text-align:right"></div>
    <div class="row"><div class="k"><div class="kn">Max applications / hour</div><div class="kd">Rolling hourly ceiling.</div></div><input class="inp tnum" id="cap-hour" type="number" min="0" max="500" value="${aa.maxPerHour ?? 20}" style="max-width:110px;text-align:right"></div>
    <div class="row"><div class="k"><div class="kn">Easy-apply only</div><div class="kd">Restrict to one-click postings.</div></div><button class="toggle ${aa.easyApplyOnly ? 'on' : ''}" id="easy-toggle">${aa.easyApplyOnly ? 'On' : 'Off'} <span class="knob"></span></button></div>`;
  makeTagInput('#kw-input', aa.keywords || [], (arr) => putSetting('autoApply', 'keywords', arr));
  makeTagInput('#loc-input', aa.locations || [], (arr) => putSetting('autoApply', 'locations', arr));
  $('#cap-day').addEventListener('change', (e) => putSetting('autoApply', 'maxPerDay', Number(e.target.value)));
  $('#cap-hour').addEventListener('change', (e) => putSetting('autoApply', 'maxPerHour', Number(e.target.value)));
  $('#easy-toggle').addEventListener('click', (e) => { const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); e.currentTarget.innerHTML = `${on ? 'On' : 'Off'} <span class="knob"></span>`; putSetting('autoApply', 'easyApplyOnly', on); });
}
function makeTagInput(sel, initial, onChange) {
  const box = $(sel); if (!box) return; let tags = [...initial];
  function paint() {
    box.innerHTML = tags.map((t, i) => `<span class="tg">${esc(t)} <b data-i="${i}">×</b></span>`).join('') + `<input placeholder="Add…">`;
    box.querySelectorAll('b[data-i]').forEach((b) => b.addEventListener('click', () => { tags.splice(Number(b.getAttribute('data-i')), 1); paint(); onChange(tags); }));
    const inp = box.querySelector('input');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) { tags.push(inp.value.trim()); inp.value = ''; paint(); onChange(tags); inp.focus(); } else if (e.key === 'Backspace' && !inp.value && tags.length) { tags.pop(); paint(); onChange(tags); inp.focus(); } });
  }
  paint();
}
async function putSetting(section, key, value) {
  try { await api(`/settings/${section}/${key}`, { method: 'PUT', body: { value } }); toast('Saved', 'success', 1500); } catch (e) { errToast(e, 'Setting'); }
}
async function loadAiCard() {
  const body = $('#ai-body'); if (!body) return;
  try {
    const ai = await api('/ai/status', { signal: psig() });
    body.innerHTML = `
      <div class="row"><div class="k"><div class="kn">Status</div><div class="kd">${ai.available ? 'Ready to synthesize screening answers.' : 'Not detected — answers fall back to your learned memory only.'}</div></div><span class="tstate ${ai.available ? 'ok' : 'unknown'}">${ai.available ? 'Available' : 'Offline'}</span></div>
      <div class="row"><div class="k"><div class="kn">Model</div><div class="kd">${esc(ai.source || 'codex')}</div></div><span class="mono" style="color:var(--ink-dim);font-size:12px">${esc(ai.model || '—')}</span></div>
      <div class="row"><div class="k"><div class="kn">Manual path</div><div class="kd">Point at a Codex CLI binary if auto-detect misses.</div></div></div>
      <div style="display:flex;gap:8px;margin-top:4px"><input class="inp" id="ai-path" placeholder="/path/to/codex" value="${esc(ai.detail || '')}"><button class="btn sm" id="ai-path-save">Save</button></div>`;
    $('#ai-path-save').addEventListener('click', async () => { const v = $('#ai-path').value.trim(); if (!v) return; try { await api('/settings/ai/codexPath', { method: 'PUT', body: { value: v } }); toast('Saved', 'success', 2000); } catch (e) { toast('This build does not accept a manual AI path yet', 'info', 3500); } });
  } catch (e) {
    body.innerHTML = comingOnline('AI answering', 'The AI status endpoint is not live in this build yet. Screening answers use your learned memory until it lands.');
  }
}
async function detectAi() {
  try { const r = await api('/ai/detect', { method: 'POST' }); toast(r?.available ? `Detected ${r.model || 'AI'}` : 'No AI runtime found', r?.available ? 'success' : 'info', 3000); loadAiCard(); }
  catch { toast('Detection is not available in this build yet', 'info', 3000); }
}
async function loadGmailCard() {
  const body = $('#gmail-body'); if (!body) return;
  try {
    const g = await api('/gmail/status', { signal: psig() });
    const accts = g.accounts || [];
    if (!accts.length) { body.innerHTML = `<div class="row"><div class="k"><div class="kn">No account connected</div><div class="kd">Connect Gmail so the inbox pipeline can advance statuses.</div></div><span class="tstate unknown">Idle</span></div><div class="row"><div class="k"><div class="kn">Sync cadence</div><div class="kd">${esc(g.cron || '—')}</div></div><span class="mono" style="font-size:11px;color:var(--ink-faint)">${g.running ? 'running' : 'stopped'}</span></div>`; return; }
    body.innerHTML = accts.map((a) => `<div class="row"><div class="k"><div class="kn">${esc(a.email || a.id)}</div><div class="kd">${a.lastOkAt ? 'last synced ' + fmtAgo(a.lastOkAt) + ' ago' : 'never synced'}</div></div><span class="tstate ${tokClass(a.tokenState)}">${esc(a.tokenState || 'unknown')}</span></div>`).join('') + `<div class="row"><div class="k"><div class="kn">Sync now</div><div class="kd">${esc(g.cron || '')}</div></div><button class="btn sm" id="gmail-sync">${icon('refresh', 13)} Sync</button></div>`;
    $('#gmail-sync')?.addEventListener('click', async () => { try { toast('Syncing…', 'info', 1500); const s = await api('/gmail/sync', { method: 'POST', body: {} }); toast(`Synced — ${s.stored || 0} new, ${s.elevated || 0} advanced`, 'success', 3500); loadGmailCard(); } catch (e) { errToast(e, 'Gmail sync'); } });
  } catch (e) { body.innerHTML = comingOnline('Gmail', 'The Gmail status endpoint is not live in this build yet.'); }
}
function tokClass(s) { return s === 'ok' || s === 'valid' ? 'ok' : s === 'expired' ? 'expired' : s === 'revoked' ? 'revoked' : 'unknown'; }
async function connectGmail() {
  try { await api('/gmail/connect/start', { method: 'POST' }); toast('Opening Gmail consent…', 'info', 3000); }
  catch { toast('Gmail connect is not wired in this build yet', 'info', 3500); }
}
async function loadTokenHealth() {
  const body = $('#tok-body'); if (!body) return;
  try {
    const data = await api('/secrets/health', { signal: psig() });
    const rows = data.rows || [];
    if (!rows.length) { body.innerHTML = `<div class="empty">No credentials stored.</div>`; return; }
    body.innerHTML = rows.map((r) => `<div class="tokrow"><span class="kk">${esc(r.key)}</span><span class="tstate ${tokClass(r.status)}">${esc(r.status)}</span></div>`).join('');
  } catch (e) { if (!e?.aborted) body.innerHTML = `<div class="empty">Could not load token health.</div>`; }
}
async function loadAdapters() {
  const body = $('#adapters-body'); if (!body) return;
  try {
    const data = await api('/adapters', { signal: psig() });
    const rows = data.rows || [];
    body.innerHTML = rows.length ? rows.map((a) => `<div class="row"><div class="k"><div class="kn">${esc(a.id)}</div><div class="kd">${esc((a.hosts || []).join(', ') || a.source || '')}</div></div><span class="mono" style="font-size:11px;color:var(--ink-faint)">v${a.version} · ${a.pages} pages</span></div>`).join('') : `<div class="empty">No adapters registered.</div>`;
  } catch (e) { if (!e?.aborted) body.innerHTML = `<div class="empty">Could not load adapters.</div>`; }
}
function comingOnline(title, sub) { return `<div style="text-align:center;padding:20px 10px"><div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--bronze);margin-bottom:8px">Coming online</div><div style="font-size:12.5px;color:var(--ink-faint);line-height:1.6">${esc(sub)}</div></div>`; }

// --- v11 import wizard ---
function renderImportWizard() {
  const body = $('#import-body'); if (!body) return;
  body.innerHTML = `
    <div class="row" style="border:none"><div class="k"><div class="kn">v11 database path</div><div class="kd">Point at your v11 install folder or SQLite file. Quit v11 first.</div></div></div>
    <div style="display:flex;gap:8px;margin:4px 0 12px"><input class="inp" id="imp-path" placeholder="C:\\Users\\…\\jat-v11"><button class="btn" id="imp-plan">Plan</button></div>
    <div id="imp-report"></div>`;
  $('#imp-plan').addEventListener('click', importPlan);
}
async function importPlan() {
  const path = $('#imp-path').value.trim(); if (!path) { toast('Enter a path', 'danger', 3000); return; }
  const report = $('#imp-report'); report.innerHTML = loadingRow('Planning import…');
  try {
    const plan = await api('/import/plan', { method: 'POST', body: { sourcePath: path } });
    const counts = plan.counts || plan.summary || plan;
    const rows = Object.entries(counts).filter(([, v]) => typeof v === 'number').map(([k, v]) => `<div class="wr-row"><span>${esc(k)}</span><b>${num(v)}</b></div>`).join('');
    report.innerHTML = `<div class="wizard-report"><div class="wr-h">Import plan</div>${rows || '<div class="wr-row"><span>Ready to import</span><b>ok</b></div>'}</div><button class="btn primary block" id="imp-exec">Execute import</button>`;
    $('#imp-exec').addEventListener('click', () => importExecute(path));
  } catch (e) {
    if (e.code === 'V11_RUNNING') report.innerHTML = `<div class="banner danger" style="border-radius:9px">v11 is still running — quit it first so the import reads a consistent snapshot.</div>`;
    else report.innerHTML = `<div class="banner danger" style="border-radius:9px">${esc(e.message || 'Import plan failed')}</div>`;
  }
}
async function importExecute(path) {
  const btn = $('#imp-exec'); if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
  try { const r = await api('/import/execute', { method: 'POST', body: { sourcePath: path }, timeoutMs: 120000 }); toast('Import complete', 'success', 4000); const report = $('#imp-report'); if (report) report.innerHTML = `<div class="wizard-report"><div class="wr-h">Imported</div>${Object.entries(r.counts || r).filter(([, v]) => typeof v === 'number').map(([k, v]) => `<div class="wr-row"><span>${esc(k)}</span><b>${num(v)}</b></div>`).join('') || '<div class="wr-row"><span>done</span><b>ok</b></div>'}</div>`; }
  catch (e) { if (e.code === 'V11_RUNNING') toast('Quit v11 first', 'danger', 5000); else errToast(e, 'Import'); if (btn) { btn.disabled = false; btn.textContent = 'Execute import'; } }
}

// ============================================================================
// COMMAND PALETTE (Ctrl+K)
// ============================================================================
let paletteOpen = false;
function openPalette() {
  if (paletteOpen) return; paletteOpen = true;
  const node = el(`<div class="palette">
    <div class="palette-input">${icon('search', 18)}<input id="pal-input" placeholder="Jump to a page, search jobs, or run an action…" autocomplete="off"><kbd>Esc</kbd></div>
    <div class="palette-list" id="pal-list"></div>
  </div>`);
  const close = openOverlay(node, { onClose: () => { paletteOpen = false; } });
  const input = node.querySelector('#pal-input');
  const list = node.querySelector('#pal-list');
  let items = []; let sel = 0;

  const baseActions = [
    ...NAV.flatMap((g) => g.items.map((i) => ({ type: 'nav', icon: i.icon, label: i.label, hint: g.group, run: () => go(i.route) }))),
    { type: 'action', icon: 'bolt', label: state.applying ? 'Pause auto-apply' : 'Start auto-apply', hint: 'action', run: () => toggleApplying() },
    { type: 'action', icon: 'bell', label: 'Open Needs-You queue', hint: 'action', run: () => go('/needs') },
    { type: 'action', icon: 'download', label: 'Export data', hint: 'action', run: () => downloadUrl('/export', 'jat13-export.json') },
  ];

  function paint() {
    list.innerHTML = '';
    let idx = 0; let lastSec = '';
    items.forEach((it) => {
      const sec = it.type === 'job' ? 'Jobs' : it.type === 'nav' ? 'Navigate' : 'Actions';
      if (sec !== lastSec) { list.insertAdjacentHTML('beforeend', `<div class="palette-sec">${sec}</div>`); lastSec = sec; }
      const row = el(`<div class="palette-item ${idx === sel ? 'sel' : ''}" data-i="${idx}">${icon(it.icon, 16)}<span class="pgrow"><b>${esc(it.label)}</b>${it.desc ? ' · ' + esc(it.desc) : ''}</span><span class="phint">${esc(it.hint || '')}</span></div>`);
      row.addEventListener('click', () => { it.run(); close(); });
      list.appendChild(row); idx++;
    });
  }
  function filter(q) {
    const ql = q.toLowerCase().trim();
    let base = baseActions;
    if (!ql) { items = base; sel = 0; paint(); return; }
    items = base.filter((a) => a.label.toLowerCase().includes(ql)); sel = 0; paint();
    // search jobs
    api(`/jobs?q=${encodeURIComponent(ql)}&limit=6`).then((d) => {
      const jobs = (d.rows || []).map((j) => ({ type: 'job', icon: 'layers', label: j.title || 'Role', desc: j.company || j.location || '', hint: j.source || '', run: () => { jobCache.set(j.id, { title: j.title, company: j.company, source: j.source }); go('/applications'); } }));
      items = [...base.filter((a) => a.label.toLowerCase().includes(ql)), ...jobs]; paint();
    }).catch(() => {});
  }
  input.addEventListener('input', debounce(() => filter(input.value), 160));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); scrollSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); scrollSel(); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[sel]; if (it) { it.run(); close(); } }
    else if (e.key === 'Escape') { close(); }
  });
  function scrollSel() { const s = list.querySelector('.palette-item.sel'); if (s) s.scrollIntoView({ block: 'nearest' }); }
  filter('');
  setTimeout(() => input.focus(), 20);
}

// ---------------------------------------------------------------------------
// download helper (auth'd fetch → blob → anchor)
// ---------------------------------------------------------------------------
async function downloadUrl(path, filename) {
  try {
    const res = await api(path, { raw: true, timeoutMs: 60000 });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename || 'download'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) { errToast(e, 'Download'); }
}

// ============================================================================
// keyboard shortcuts (Ctrl+K, g-chords, Esc)
// ============================================================================
let chordArmed = false; let chordTimer = null;
function isTyping(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }
function initKeys() {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (e.key === 'Escape') { if (closeTopOverlay()) return; }
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (chordArmed) {
      const route = CHORD_ROUTE[e.key.toUpperCase()];
      chordArmed = false; clearTimeout(chordTimer);
      if (route) { e.preventDefault(); go(route); }
      return;
    }
    if (e.key.toLowerCase() === 'g') { chordArmed = true; clearTimeout(chordTimer); chordTimer = setTimeout(() => { chordArmed = false; }, 900); }
  });
}

// ============================================================================
// boot
// ============================================================================
async function loadInitialProfile() {
  try {
    const list = await api('/profiles');
    const rows = list.rows || [];
    const def = rows.find((r) => r.is_default) || rows[0];
    if (def) { state.profileId = def.id; state.profileName = def.name || state.profileName; $('#user-name').textContent = state.profileName; $('#user-avatar').textContent = initials(state.profileName); }
  } catch { /* non-fatal */ }
}
async function loadInitialSettings() {
  try {
    const s = await api('/settings');
    state.settings = s;
    const mode = normalizeMode(s.appearance?.theme || s.appearance?.themeId || getMode());
    setTheme(mode, false);
    renderThemeGrid();
  } catch { /* keep localStorage theme */ }
}

async function main() {
  initTheme();
  renderShell();
  initKeys();
  window.addEventListener('hashchange', router);

  const ok = await bootstrap();
  if (!ok || !state.token) { showNotConnected(); return; }
  state.online = true;
  await Promise.all([loadInitialProfile(), loadInitialSettings()]);
  startGlobalPoller();
  if (state.devtools) {
    import('./lib/devdrive.js').then((m) => m.startDevDrive({ base: state.base, token: state.token })).catch(() => {});
  }
  if (!location.hash) location.hash = '#/';
  router();
}
main().catch((e) => { console.error(e); showNotConnected(); });
