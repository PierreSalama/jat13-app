// JAT 13 renderer — plain ES module, no framework. Wears v11's Atelier look (styles.css copied
// verbatim) but is a FRESH renderer wired to v13's REAL loopback REST API (snake_case DTOs, the
// X-JAT13-Token pairing header). Every control here maps to a real v13 route — features v11 had that
// v13 does not (AI composer, taught procedures, job discovery, document upload) are absent, not faked.
import { THEMES, applyTheme, DEFAULT_THEME } from './lib/themes.js';

// ---------------------------------------------------------------------------
// tiny DOM helpers (same idiom as v11 app.js)
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const LS_THEME = 'jat13.theme';

// ---------------------------------------------------------------------------
// bootstrap config + pairing token
// ---------------------------------------------------------------------------
const state = {
  base: 'http://127.0.0.1:7860',
  token: null,
  version: '',
  online: false,
  applying: false,
  needsYou: 0,
  settings: null,
  pollTimer: null,
};

/** Resolve {base, token}. Preferred: the preload bridge (window.jat13.config). Fallback (dev in a
 *  browser): probe the two candidate loopback ports for the loopback-trusted pairing token. */
async function bootstrap() {
  if (window.jat13?.config) {
    try {
      const cfg = await window.jat13.config();
      if (cfg?.port) state.base = `http://127.0.0.1:${cfg.port}`;
      if (cfg?.token) state.token = cfg.token;
      if (cfg?.version) state.version = cfg.version;
      if (state.token) return;
    } catch { /* fall through to probe */ }
  }
  for (const port of [7860, 7861]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/pair/token`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) continue;
      const body = await res.json();
      if (body?.token) { state.base = `http://127.0.0.1:${port}`; state.token = body.token; state.version = body.version || ''; return; }
    } catch { /* try next port */ }
  }
}

// ---------------------------------------------------------------------------
// API helper — every /api call carries the token; 401 → not-connected screen.
// ---------------------------------------------------------------------------
async function api(path, opts = {}) {
  const { method = 'GET', body, raw = false, timeoutMs = 20000 } = opts;
  let res;
  try {
    res = await fetch(state.base + '/api' + path, {
      method,
      headers: {
        'X-JAT13-Token': state.token || '',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    const err = new Error('app unreachable'); err.status = 0; throw err;
  }
  if (res.status === 401) { renderNotConnected(); const err = new Error('unauthorized'); err.status = 401; throw err; }
  if (raw) { if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; } return res; }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) { const err = new Error(data?.message || data?.error || 'HTTP ' + res.status); err.status = res.status; err.code = data?.error; throw err; }
  return data;
}
/** GET /health — ROOT route (not under /api), no token. Drives the runtime dot + version. */
async function health() {
  const res = await fetch(state.base + '/health', { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error('health ' + res.status);
  return res.json();
}

// ---------------------------------------------------------------------------
// theme
// ---------------------------------------------------------------------------
function setTheme(id, persist = true) {
  applyTheme(id);
  try { localStorage.setItem(LS_THEME, id); } catch {}
  if (persist && state.token) {
    api('/settings/appearance/themeId', { method: 'PUT', body: { value: id } }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------
function toast(msg, kind = 'info', opts = {}) {
  const box = $('#toasts');
  if (!box) return () => {};
  const t = document.createElement('div');
  t.className = 'toast' + (kind && kind !== 'info' ? ' ' + kind : '');
  const span = document.createElement('span');
  span.className = 'toast-msg';
  span.textContent = msg;
  t.appendChild(span);
  let closed = false;
  const close = () => { if (closed) return; closed = true; t.remove(); };
  const x = document.createElement('button');
  x.className = 'toast-x'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
  x.addEventListener('click', close);
  t.appendChild(x);
  box.appendChild(t);
  const ttl = opts.ttl !== undefined ? opts.ttl : (kind === 'danger' ? 8000 : 5000);
  if (ttl > 0) setTimeout(close, ttl);
  return close;
}
const errToast = (e, prefix = '') => toast((prefix ? prefix + ': ' : '') + (e?.message || String(e)), 'danger');

// ---------------------------------------------------------------------------
// overlays (modal + palette)
// ---------------------------------------------------------------------------
function openOverlay(node) {
  const root = $('#overlay-root');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.appendChild(node);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
  root.appendChild(ov);
  return () => ov.remove();
}
function closeTopOverlay() {
  const ovs = document.querySelectorAll('#overlay-root .overlay');
  if (ovs.length) { ovs[ovs.length - 1].remove(); return true; }
  return false;
}
function closeAllOverlays() { document.querySelectorAll('#overlay-root .overlay').forEach((o) => o.remove()); }

// ---------------------------------------------------------------------------
// labels + formatting
// ---------------------------------------------------------------------------
const STATUS_ORDER = ['tracked', 'submitted', 'acknowledged', 'assessment', 'interview_1', 'interview_2', 'interview_final', 'offer', 'hired', 'rejected', 'withdrawn', 'ghosted'];
const STATUS_LABEL = {
  tracked: 'Tracked', submitted: 'Submitted', acknowledged: 'Acknowledged', assessment: 'Assessment',
  interview_1: 'Interview 1', interview_2: 'Interview 2', interview_final: 'Final interview',
  offer: 'Offer', hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn', ghosted: 'Ghosted',
};
const RUN_STATE_LABEL = {
  queued: 'Queued', dispatched: 'Dispatched', waiting_page: 'Waiting on page', running: 'Running',
  needs_human: 'Needs you', ready_for_review: 'Ready for review', submitted: 'Submitted',
  skipped: 'Skipped', failed: 'Failed', parked: 'Parked', done: 'Done',
};
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString() : '—');
const relTime = (ms) => {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};

// muted line reused wherever a v11 capability is not yet in v13
const DISCOVERY_NOTE = 'Job discovery arrives in a later v13 update — use the Import wizard or the Track button in the extension to feed the queue.';

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
const routes = [];
function route(pattern, render) { routes.push({ pattern, render }); }
function resolve(path) {
  for (const r of routes) {
    if (typeof r.pattern === 'string') { if (r.pattern === path) return { render: r.render, params: {} }; }
    else { const m = path.match(r.pattern); if (m) return { render: r.render, params: m.groups || {} }; }
  }
  return null;
}
let navSeq = 0;
async function navigate() {
  const path = (location.hash.replace(/^#/, '') || '/').replace(/\/+$/, '') || '/';
  document.querySelectorAll('.nav-item').forEach((n) => {
    const r = n.dataset.route;
    n.classList.toggle('active', r === path || (r !== '/' && path.startsWith(r + '/')));
  });
  closeAllOverlays();
  if (!state.token) { renderNotConnected(); return; }
  const seq = ++navSeq;
  const match = resolve(path) || resolve('/');
  const main = $('#main');
  const loadT = setTimeout(() => { if (seq === navSeq) main.replaceChildren(skeleton()); }, 130);
  try {
    const node = await match.render(match.params);
    clearTimeout(loadT);
    if (seq !== navSeq) return;
    main.replaceChildren(node);
  } catch (e) {
    clearTimeout(loadT);
    if (seq !== navSeq) return;
    if (e && e.status === 401) return;
    main.replaceChildren(errorView(e));
  }
}

function skeleton() {
  return el('<div class="sk-grid"><div class="sk-card"><div class="sk-line"></div><div class="sk-line"></div></div><div class="sk-card"><div class="sk-line"></div><div class="sk-line"></div></div></div>');
}
function errorView(e) {
  const v = el(`<div><div class="empty">
    <div class="empty-mark"></div>
    <div class="empty-eyebrow">App offline</div>
    <div class="empty-title">The app brain isn't answering</div>
    <div class="empty-sub"></div>
    <div class="mt"><button class="btn primary" data-retry>Retry</button></div>
  </div></div>`);
  $('.empty-sub', v).textContent = (e?.message ? e.message + ' — ' : '') + 'Start JAT 13, then retry.';
  $('[data-retry]', v).addEventListener('click', navigate);
  return v;
}
function renderNotConnected() {
  const main = $('#main');
  if (!main) return;
  const v = el(`<div><div class="empty">
    <div class="empty-mark"></div>
    <div class="empty-eyebrow">Not connected</div>
    <div class="empty-title">This dashboard couldn't reach the app brain</div>
    <div class="empty-sub">The desktop app could not hand over its access token. Restart JAT 13; if this persists, check the logs.</div>
    <div class="mt"><button class="btn primary" data-retry>Retry</button></div>
  </div></div>`);
  $('[data-retry]', v).addEventListener('click', () => bootstrap().then(navigate));
  main.replaceChildren(v);
}

function pageHeader(eyebrow, title, sub, actionsHtml = '') {
  return `<header class="page-header">
    <div>
      <div class="page-eyebrow">${esc(eyebrow)}</div>
      <h1 class="page-title">${esc(title)}</h1>
      ${sub ? `<div class="page-sub">${esc(sub)}</div>` : ''}
    </div>
    ${actionsHtml ? `<div class="page-actions">${actionsHtml}</div>` : ''}
  </header>`;
}
function emptyHtml(eyebrow, title, sub) {
  return `<div class="empty"><div class="empty-mark"></div><div class="empty-eyebrow">${esc(eyebrow)}</div><div class="empty-title">${esc(title)}</div><div class="empty-sub">${esc(sub)}</div></div>`;
}
function statusChip(s) { return `<span class="status-chip" data-status="${esc(s)}"><span class="dot"></span>${esc(STATUS_LABEL[s] || s)}</span>`; }
function stateChip(s) { return `<span class="state-chip" data-state="${esc(s)}">${esc(RUN_STATE_LABEL[s] || s)}</span>`; }

// ===========================================================================
// PAGES
// ===========================================================================

// ---- Dashboard ------------------------------------------------------------
route('/', async () => {
  const [stats, summary, events] = await Promise.all([
    api('/stats'),
    api('/summary'),
    api('/events/recent?limit=8').catch(() => ({ rows: [] })),
  ]);
  const funnel = stats.funnel || {};
  const totals = stats.totals || {};
  const runs = stats.runs || { byState: {}, total: 0 };
  const byState = runs.byState || {};

  const v = el(`<div>
    ${pageHeader('Overview', 'Dashboard', 'A considered record of your job search.',
      '<button class="btn" data-refresh>Refresh</button>')}
    <section class="stats stats-5">
      <div class="stat"><div class="stat-label">Jobs tracked</div><div class="stat-value">${totals.jobs ?? 0}</div><div class="stat-delta">across all sources</div></div>
      <div class="stat"><div class="stat-label">Applications</div><div class="stat-value">${totals.applications ?? 0}</div><div class="stat-delta">total on record</div></div>
      <div class="stat"><div class="stat-label">Submitted 7d</div><div class="stat-value gold">${totals.submitted7d ?? 0}</div><div class="stat-delta">last 7 days</div></div>
      <div class="stat"><div class="stat-label">Runs 24h</div><div class="stat-value">${runs.total ?? 0}</div><div class="stat-delta">${byState.submitted || 0} submitted · ${byState.failed || 0} failed</div></div>
      <div class="stat clickable" data-go-queue><div class="stat-label">Needs you</div><div class="stat-value ${summary.needsYou ? 'warn' : ''}">${summary.needsYou ?? 0}</div><div class="stat-delta">${summary.applying ? 'auto-apply running' : 'auto-apply idle'}</div></div>
    </section>

    <div class="dash-cols">
      <section class="section">
        <div class="section-header"><div><div class="section-eyebrow">Pipeline</div><div class="section-title">Applications by stage (90d)</div></div><a href="#/pipeline" class="section-link">Open board →</a></div>
        <div class="section-body" data-funnel></div>
      </section>
      <section class="section">
        <div class="section-header"><div><div class="section-eyebrow">Activity</div><div class="section-title">Recent events</div></div><a href="#/activity" class="section-link">All activity →</a></div>
        <div class="section-body"><div class="feed" data-feed></div></div>
      </section>
    </div>
  </div>`);

  $('[data-funnel]', v).innerHTML = funnelHtml(funnel);
  const feed = $('[data-feed]', v);
  const rows = events.rows || [];
  feed.innerHTML = rows.length
    ? rows.map((e) => `<div class="feed-item"><span class="feed-icon">≋</span><div class="feed-text">${esc(e.kind || 'event')}${e.summary ? ' — ' + esc(e.summary) : ''}<div class="feed-meta">${esc(relTime(e.at))}</div></div></div>`).join('')
    : emptyHtml('Quiet', 'No activity yet', DISCOVERY_NOTE);

  $('[data-refresh]', v).addEventListener('click', navigate);
  $('[data-go-queue]', v).addEventListener('click', () => { location.hash = '#/queue'; });
  return v;
});

function funnelHtml(funnel) {
  const entries = STATUS_ORDER.map((s) => [s, funnel[s] || 0]).filter(([, n]) => n > 0);
  if (!entries.length) return emptyHtml('Empty funnel', 'No applications in the last 90 days', DISCOVERY_NOTE);
  const max = Math.max(...entries.map(([, n]) => n), 1);
  return entries.map(([s, n]) => {
    const pct = Math.max(4, Math.round((n / max) * 100));
    return `<div class="fn-row"><div class="fn-top"><span class="fn-label">${esc(STATUS_LABEL[s] || s)}</span><span class="fn-n">${n}</span></div><div class="fn-bar"><div class="fn-fill" style="width:${pct}%"></div></div></div>`;
  }).join('');
}

// ---- Applications ---------------------------------------------------------
route('/applications', async () => {
  const status = sessionStorage.getItem('jat13.appStatus') || 'all';
  const q = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`;
  const data = await api('/applications' + q + (q ? '&' : '?') + 'limit=200');
  const rows = data.rows || [];

  const opts = ['all', ...STATUS_ORDER].map((s) => `<option value="${esc(s)}" ${s === status ? 'selected' : ''}>${s === 'all' ? 'All statuses' : esc(STATUS_LABEL[s] || s)}</option>`).join('');
  const v = el(`<div>
    ${pageHeader('Track', 'Applications', `${data.total ?? rows.length} on record`,
      '<button class="btn" data-refresh>Refresh</button>')}
    <div class="toolbar"><select class="select" data-filter>${opts}</select><input class="input tb-search" id="f-q" placeholder="Filter this page…" /></div>
    <div class="table-wrap"><table class="table"><thead><tr>
      <th>Status</th><th>Job</th><th>Via</th><th>Next action</th><th>Updated</th><th></th>
    </tr></thead><tbody data-body></tbody></table></div>
  </div>`);

  const body = $('[data-body]', v);
  function paint(list) {
    body.innerHTML = list.length
      ? list.map((a) => `<tr data-id="${esc(a.id)}">
          <td>${statusChip(a.status)}</td>
          <td class="mono">${esc(a.job_id || '')}</td>
          <td>${a.via ? `<span class="via-badge">${esc(a.via)}</span>` : '<span class="muted">—</span>'}</td>
          <td>${a.needs_review ? '<span class="pill warn">Review</span>' : (a.next_action ? esc(a.next_action) : '<span class="muted">—</span>')}</td>
          <td class="muted nowrap">${esc(relTime(a.updated_at))}</td>
          <td><button class="btn-link" data-timeline="${esc(a.id)}">Timeline</button></td>
        </tr>`).join('')
      : `<tr><td colspan="6">${emptyHtml('Quiet ledger', 'No applications match', DISCOVERY_NOTE)}</td></tr>`;
    body.querySelectorAll('[data-timeline]').forEach((b) => b.addEventListener('click', () => openTimeline(b.dataset.timeline)));
  }
  paint(rows);

  $('[data-filter]', v).addEventListener('change', (e) => { sessionStorage.setItem('jat13.appStatus', e.target.value); navigate(); });
  $('#f-q', v).addEventListener('input', (e) => {
    const term = e.target.value.trim().toLowerCase();
    paint(!term ? rows : rows.filter((a) => (a.job_id + ' ' + (a.via || '') + ' ' + a.status).toLowerCase().includes(term)));
  });
  $('[data-refresh]', v).addEventListener('click', navigate);
  return v;
});

async function openTimeline(id) {
  let data;
  try { data = await api(`/applications/${encodeURIComponent(id)}/timeline`); }
  catch (e) { errToast(e, 'Timeline'); return; }
  const events = data.events?.rows || data.events || [];
  const emails = data.emails || [];
  const m = el(`<div class="modal">
    <div class="modal-head"><h3 class="modal-title">Application timeline</h3><button class="toast-x" data-close>×</button></div>
    <div class="modal-body">
      <div class="timeline" data-tl></div>
      <div class="mail-sub" style="margin-top:12px" data-emails></div>
    </div>
  </div>`);
  $('[data-tl]', m).innerHTML = events.length
    ? events.map((e) => `<div class="timeline-item"><div class="timeline-dot"></div><div><div class="timeline-title">${esc(e.kind || 'event')}${e.summary ? ' — ' + esc(e.summary) : ''}</div><div class="timeline-sub">${esc(fmtDate(e.at))}</div></div></div>`).join('')
    : '<div class="muted">No events recorded yet.</div>';
  $('[data-emails]', m).innerHTML = emails.length
    ? `<div class="section-eyebrow">Matched emails</div>` + emails.map((e) => `<div class="mail-row"><div class="mail-subj">${esc(e.subject || '(no subject)')}</div><div class="mail-snip">${esc(e.snippet || '')}</div><div class="mail-meta muted">${esc(e.from_name || e.from_addr || '')} · ${esc(fmtDay(e.sent_at))}</div></div>`).join('')
    : '';
  const close = openOverlay(m);
  $('[data-close]', m).addEventListener('click', close);
}

// ---- Pipeline (funnel board) ---------------------------------------------
route('/pipeline', async () => {
  const stats = await api('/stats');
  const funnel = stats.funnel || {};
  const v = el(`<div>
    ${pageHeader('Track', 'Pipeline', 'Every application by stage (last 90 days).')}
    <div class="kanban" data-board></div>
  </div>`);
  const board = $('[data-board]', v);
  const cols = STATUS_ORDER.map((s) => {
    const n = funnel[s] || 0;
    return `<div class="kb-col"><div class="kb-head"><span class="kb-label">${esc(STATUS_LABEL[s] || s)}</span><span class="kb-n">${n}</span></div>
      <div class="kb-body">${n ? `<div class="kb-card"><div class="kb-card-top"><span class="kb-title">${n} application${n === 1 ? '' : 's'}</span></div><div class="kb-meta"><span class="kb-sub">in ${esc(STATUS_LABEL[s] || s)}</span></div></div>` : '<div class="muted" style="padding:8px;font-size:12px">—</div>'}</div></div>`;
  }).join('');
  board.innerHTML = cols;
  if (!STATUS_ORDER.some((s) => funnel[s])) board.innerHTML = emptyHtml('Empty board', 'No applications yet', DISCOVERY_NOTE);
  return v;
});

// ---- Auto-apply (mission control) -----------------------------------------
route('/queue', async () => {
  const [status, needs, runsData] = await Promise.all([
    api('/apply/status'),
    api('/needs-you'),
    api('/runs?limit=40'),
  ]);
  state.applying = !!status.running;
  const live = (runsData.rows || []).filter((r) => ['queued', 'dispatched', 'waiting_page', 'running', 'needs_human', 'ready_for_review'].includes(r.state));
  const history = (runsData.rows || []).filter((r) => ['submitted', 'skipped', 'failed', 'done', 'parked'].includes(r.state));

  const v = el(`<div>
    ${pageHeader('Automate', 'Auto-apply', 'Mission control for the apply engine.',
      `<button class="btn ${state.applying ? 'danger' : 'primary'}" data-toggle>${state.applying ? 'Stop' : 'Start'} auto-apply</button>`)}

    <section class="aa-master">
      <div class="aa-power"><span class="aa-pulse ${state.applying ? 'on' : ''}"></span><span>${state.applying ? 'Engine running' : 'Engine idle'}</span></div>
      <div class="aa-dash-grid">
        <div class="mini"><div class="mini-label">In flight</div><div class="mini-value">${live.length}</div></div>
        <div class="mini"><div class="mini-label">Needs you</div><div class="mini-value ${needs.needsHuman?.length ? 'warn' : ''}">${needs.needsHuman?.length || 0}</div></div>
        <div class="mini"><div class="mini-label">Ready for review</div><div class="mini-value">${needs.readyForReview?.length || 0}</div></div>
      </div>
    </section>

    <div class="aa-disco-note muted" style="margin:12px 0">${esc(DISCOVERY_NOTE)}</div>

    ${needs.needsHuman?.length ? `<section class="section"><div class="section-header"><div><div class="section-eyebrow">Attention</div><div class="section-title">Needs you</div></div></div><div class="section-body needs-you" data-needs></div></section>` : ''}

    <section class="section"><div class="section-header"><div><div class="section-eyebrow">Live</div><div class="section-title">Running now</div></div></div>
      <div class="section-body aa-workers" data-live></div></section>

    <section class="section"><div class="section-header"><div><div class="section-eyebrow">History</div><div class="section-title">Recent runs</div></div></div>
      <div class="section-body hist-list" data-history></div></section>
  </div>`);

  const needsBox = $('[data-needs]', v);
  if (needsBox) {
    needsBox.innerHTML = needs.needsHuman.map((r) => `<div class="ny-card" data-run="${esc(r.id)}">
      <div class="ny-title">${esc(r.source || 'run')} · ${stateChip(r.state)}</div>
      <div class="ny-reason muted">${esc(r.park_kind || 'awaiting input')}</div>
      <div class="ny-actions"><button class="btn small primary" data-answer="${esc(r.id)}" data-profile="${esc(r.profile_id || '')}">Answer</button></div>
    </div>`).join('');
    needsBox.querySelectorAll('[data-answer]').forEach((b) => b.addEventListener('click', () => openAnswer(b.dataset.answer, b.dataset.profile)));
  }

  const liveBox = $('[data-live]', v);
  liveBox.innerHTML = live.length
    ? live.map((r) => `<div class="aa-worker"><div class="aa-worker-head"><span class="aa-worker-title">${esc(r.source || 'run')}</span>${stateChip(r.state)}</div>
        <div class="aa-worker-meta"><span class="aa-worker-co">${esc(r.route || r.lane || '')}</span><span class="aa-worker-elapsed">${esc(relTime(r.queued_at))}</span></div></div>`).join('')
    : `<div class="aa-empty-live muted">Nothing in flight. ${state.applying ? 'Waiting for queued work.' : 'Start the engine to begin.'}</div>`;

  const histBox = $('[data-history]', v);
  histBox.innerHTML = history.length
    ? history.map((r) => `<div class="hist-row"><div class="hist-main"><div class="hist-title">${esc(r.source || 'run')} · ${esc(r.route || r.lane || '')}</div><div class="hist-reason muted">${esc(r.park_kind || RUN_STATE_LABEL[r.state] || r.state)}</div></div><div class="hist-meta">${stateChip(r.state)}<div class="muted">${esc(relTime(r.updated_at))}</div></div></div>`).join('')
    : `<div class="muted">No completed runs yet.</div>`;

  $('[data-toggle]', v).addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try {
      await api(state.applying ? '/apply/stop' : '/apply/start', { method: 'POST' });
      toast(state.applying ? 'Auto-apply stopped' : 'Auto-apply started');
      navigate();
    } catch (err) { errToast(err); btn.disabled = false; }
  });
  return v;
});

async function openAnswer(runId, profileId) {
  let needs;
  try { needs = await api('/needs-you'); } catch (e) { errToast(e); return; }
  const run = (needs.needsHuman || []).find((r) => r.id === runId);
  let questions = [];
  try { questions = JSON.parse(run?.pending_questions_json || '[]'); } catch { questions = []; }
  if (!Array.isArray(questions) || !questions.length) questions = [{ label: 'Answer for this run', kind: 'qa' }];

  const m = el(`<div class="modal">
    <div class="modal-head"><h3 class="modal-title">Answer screening questions</h3><button class="toast-x" data-close>×</button></div>
    <div class="modal-body"><div class="form-grid" data-qs></div></div>
    <div class="modal-foot"><button class="btn small" data-cancel>Cancel</button><button class="btn small primary" data-save>Submit & resume</button></div>
  </div>`);
  $('[data-qs]', m).innerHTML = questions.map((q, i) => `<div class="form-row"><label class="form-label">${esc(q.label || q.question || ('Question ' + (i + 1)))}</label><input class="input" data-q="${i}" value="${esc(q.value || '')}" /></div>`).join('');
  const close = openOverlay(m);
  $('[data-close]', m).addEventListener('click', close);
  $('[data-cancel]', m).addEventListener('click', close);
  $('[data-save]', m).addEventListener('click', async () => {
    const answers = questions.map((q, i) => ({
      profileId: profileId || run?.profile_id || '',
      label: q.label || q.question || ('Question ' + (i + 1)),
      value: $(`[data-q="${i}"]`, m).value,
      kind: q.kind === 'field' ? 'field' : 'qa',
    })).filter((a) => a.value.trim());
    try {
      await api(`/runs/${encodeURIComponent(runId)}/answer`, { method: 'POST', body: { answers } });
      toast('Answers saved — run re-queued'); close(); navigate();
    } catch (e) { errToast(e); }
  });
}

// ---- Profile (editor + learned answers) -----------------------------------
route('/profile', async () => {
  const { rows: profiles } = await api('/profiles');
  const active = profiles.find((p) => p.is_default) || profiles[0];
  if (!active) {
    const v = el(`<div>${pageHeader('Material', 'Profile')}${emptyHtml('No profile', 'No profile found', 'Import from v11 in Settings to create one.')}</div>`);
    return v;
  }
  const [detail, answers] = await Promise.all([
    api(`/profiles/${encodeURIComponent(active.id)}`),
    api(`/answers?profileId=${encodeURIComponent(active.id)}&limit=300`),
  ]);
  const data = detail.data || {};
  const v = el(`<div>
    ${pageHeader('Material', 'Profile', esc(active.name), '<button class="btn primary" data-save>Save profile</button>')}
    <div class="pf-grid">
      <section class="section pf-main">
        <div class="section-header"><div><div class="section-eyebrow">Identity</div><div class="section-title">Profile fields</div></div></div>
        <div class="section-body">
          <div class="pf-idrow"><label class="pf-flabel">Name</label><input class="input" data-name value="${esc(active.name)}" /></div>
          <div class="pf-field"><label class="pf-flabel">Profile data (JSON)</label><textarea class="input" data-json rows="16" style="font-family:var(--mono,monospace)">${esc(JSON.stringify(data, null, 2))}</textarea></div>
          <div class="form-hint muted">Stored as data_json (max 256KB). Must be valid JSON.</div>
        </div>
      </section>
      <section class="section">
        <div class="section-header"><div><div class="section-eyebrow">Memory</div><div class="section-title">Learned answers <span class="pf-mem-count">${answers.total ?? (answers.rows || []).length}</span></div></div></div>
        <div class="section-body">
          <input class="input doc-search" data-answersearch placeholder="Search learned answers…" />
          <div class="rec-rows" data-answers></div>
        </div>
      </section>
    </div>
  </div>`);

  const answersBox = $('[data-answers]', v);
  function paintAnswers(list) {
    answersBox.innerHTML = list.length
      ? list.map((a) => `<div class="rec-row" data-aid="${esc(a.id)}">
          <div class="rec-f"><div class="proc-label">${esc(a.label)}</div><div class="proc-val muted">${esc(a.key_norm)} · ${esc(a.provenance)}${a.locked ? ' · 🔒' : ''}</div></div>
          <div class="rec-rm"><button class="btn-link" data-lock="${esc(a.id)}">${a.locked ? 'Unlock' : 'Lock'}</button><button class="btn-link danger" data-del="${esc(a.id)}">Delete</button></div>
        </div>`).join('')
      : '<div class="muted">No learned answers for this profile yet.</div>';
    answersBox.querySelectorAll('[data-lock]').forEach((b) => b.addEventListener('click', async () => {
      const a = list.find((x) => x.id === b.dataset.lock);
      try { await api(`/answers/${encodeURIComponent(b.dataset.lock)}`, { method: 'PUT', body: { locked: !a.locked } }); navigate(); }
      catch (e) { errToast(e); }
    }));
    answersBox.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/answers/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); toast('Answer deleted'); navigate(); }
      catch (e) { errToast(e); }
    }));
  }
  const allAnswers = answers.rows || [];
  paintAnswers(allAnswers);
  $('[data-answersearch]', v).addEventListener('input', debounce((e) => {
    const t = e.target.value.trim().toLowerCase();
    paintAnswers(!t ? allAnswers : allAnswers.filter((a) => (a.label + ' ' + a.key_norm).toLowerCase().includes(t)));
  }, 150));

  $('[data-save]', v).addEventListener('click', async () => {
    let parsed;
    try { parsed = JSON.parse($('[data-json]', v).value); }
    catch { toast('Profile data is not valid JSON', 'danger'); return; }
    try {
      await api(`/profiles/${encodeURIComponent(active.id)}`, { method: 'PUT', body: { name: $('[data-name]', v).value, data: parsed } });
      toast('Profile saved'); navigate();
    } catch (e) { errToast(e); }
  });
  return v;
});

// ---- Documents (read-only; upload not server-wired) -----------------------
route('/documents', async () => {
  const { rows } = await api('/documents');
  const v = el(`<div>
    ${pageHeader('Material', 'Documents', 'Resumes and attachments on record.')}
    <div class="form-hint muted" style="margin-bottom:12px">Uploading documents from the dashboard isn't wired in v13 yet — documents arrive via the v11 import. This is a read-only view.</div>
    <div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Role</th><th>Type</th><th>Size</th><th>Default</th><th>Added</th></tr></thead>
      <tbody>${(rows || []).length
        ? rows.map((d) => `<tr><td>${esc(d.name)}</td><td><span class="role-badge">${esc(d.role || '—')}</span></td><td class="muted">${esc(d.mime || '')}</td><td class="muted">${d.size_bytes ? Math.round(d.size_bytes / 1024) + ' KB' : '—'}</td><td>${d.is_default ? '<span class="pill">default</span>' : ''}</td><td class="muted">${esc(fmtDay(d.created_at))}</td></tr>`).join('')
        : `<tr><td colspan="6">${emptyHtml('No documents', 'Nothing on record', 'Documents are imported from v11 for now.')}</td></tr>`}</tbody>
    </table></div>
  </div>`);
  return v;
});

// ---- Activity -------------------------------------------------------------
route('/activity', async () => {
  const { rows } = await api('/events/recent?limit=100');
  const v = el(`<div>
    ${pageHeader('System', 'Activity', 'The event stream — most recent first.')}
    <div class="feed">${(rows || []).length
      ? rows.map((e) => `<div class="feed-item"><span class="feed-icon">≋</span><div class="feed-text">${esc(e.kind || 'event')}${e.summary ? ' — ' + esc(e.summary) : ''}<div class="feed-meta">${esc(fmtDate(e.at))}</div></div></div>`).join('')
      : emptyHtml('Quiet', 'No activity yet', DISCOVERY_NOTE)}</div>
  </div>`);
  return v;
});

// ---- Settings -------------------------------------------------------------
route('/settings', async () => {
  const [settings, adapters, secrets, gmail] = await Promise.all([
    api('/settings'),
    api('/adapters').catch(() => ({ rows: [] })),
    api('/secrets/health').catch(() => ({ rows: [] })),
    api('/gmail/status').catch(() => null),
  ]);
  state.settings = settings;
  const themeGrid = THEMES.map((t) => `<button class="swatch ${(document.body.dataset.theme === t.id) ? 'active' : ''}" data-theme-id="${esc(t.id)}" type="button" title="${esc(t.name)}">
    <span class="swatch-chips"><span class="swatch-chip" style="background:${esc(t.vars.primary)}"></span><span class="swatch-chip" style="background:${esc(t.vars.primary2)}"></span><span class="swatch-chip" style="background:${esc(t.vars.bg2)}"></span></span>
    <span class="swatch-name">${esc(t.name)}</span></button>`).join('');

  const v = el(`<div>
    ${pageHeader('System', 'Settings', 'Appearance, connections, and data.')}

    <section class="section"><div class="section-header"><div><div class="section-eyebrow">Appearance</div><div class="section-title">Theme</div></div></div>
      <div class="section-body"><div class="theme-grid">${themeGrid}</div></div></section>

    <section class="section"><div class="section-header"><div><div class="section-eyebrow">Migration</div><div class="section-title">Import from JAT v11</div></div></div>
      <div class="section-body">
        <div class="form-hint muted">Point to a v11 jat.db snapshot. Quit v11 first — the import reads a consistent snapshot.</div>
        <div class="url-row"><input class="input pf-grow" data-importpath placeholder="F:/…/jat.db" /><button class="btn" data-plan>Plan</button><button class="btn primary" data-exec disabled>Import</button></div>
        <div class="status-line muted" data-importstatus></div>
      </div></section>

    <section class="section"><div class="section-header"><div><div class="section-eyebrow">Inbox</div><div class="section-title">Gmail</div></div></div>
      <div class="section-body">
        <div class="sync-row"><span class="muted">${gmail ? esc(gmailSummary(gmail)) : 'No Gmail account connected. Connect one in the app to pull application emails.'}</span>${gmail ? '<button class="btn small" data-gsync>Sync now</button>' : ''}</div>
      </div></section>

    <section class="section"><div class="section-header"><div><div class="section-eyebrow">Security</div><div class="section-title">Token health</div></div></div>
      <div class="section-body">${(secrets.rows || []).length
        ? `<div class="table-wrap"><table class="table"><thead><tr><th>Key</th><th>Status</th><th>Last OK</th></tr></thead><tbody>${secrets.rows.map((s) => `<tr><td class="mono">${esc(s.key)}</td><td>${esc(s.status)}</td><td class="muted">${esc(s.last_ok_at ? relTime(s.last_ok_at) : '—')}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="muted">No secrets configured.</div>'}</div></section>

    <section class="section"><div class="section-header"><div><div class="section-eyebrow">Engine</div><div class="section-title">Adapters</div></div></div>
      <div class="section-body">${(adapters.rows || []).length
        ? `<div class="table-wrap"><table class="table"><thead><tr><th>Adapter</th><th>Source</th><th>Version</th><th>Hosts</th><th>Pages</th></tr></thead><tbody>${adapters.rows.map((a) => `<tr><td class="mono">${esc(a.id)}</td><td>${esc(a.source)}</td><td class="muted">v${esc(a.version)}</td><td class="muted">${esc((a.hosts || []).join(', '))}</td><td>${a.pages}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="muted">No adapters loaded.</div>'}</div></section>

    <section class="section"><div class="section-header"><div><div class="section-eyebrow">Data</div><div class="section-title">Export</div></div></div>
      <div class="section-body"><div class="sync-row"><span class="muted">Download jobs + applications as JSON.</span><button class="btn small" data-export>Export data</button></div></div></section>
  </div>`);

  v.querySelectorAll('[data-theme-id]').forEach((sw) => sw.addEventListener('click', () => {
    setTheme(sw.dataset.themeId);
    v.querySelectorAll('[data-theme-id]').forEach((x) => x.classList.toggle('active', x === sw));
  }));

  const planBtn = $('[data-plan]', v), execBtn = $('[data-exec]', v), st = $('[data-importstatus]', v);
  planBtn.addEventListener('click', async () => {
    const sourcePath = $('[data-importpath]', v).value.trim();
    if (!sourcePath) { st.textContent = 'Enter a path first.'; return; }
    planBtn.disabled = true; st.textContent = 'Planning…';
    try {
      const report = await api('/import/plan', { method: 'POST', body: { sourcePath } });
      st.textContent = 'Plan ready: ' + JSON.stringify(report.counts || report);
      execBtn.disabled = false;
    } catch (e) {
      st.textContent = e.code === 'V11_RUNNING' ? 'Quit JAT v11 first, then retry.' : ('Plan failed: ' + e.message);
      execBtn.disabled = true;
    } finally { planBtn.disabled = false; }
  });
  execBtn.addEventListener('click', async () => {
    const sourcePath = $('[data-importpath]', v).value.trim();
    execBtn.disabled = true; st.textContent = 'Importing…';
    try { const res = await api('/import/execute', { method: 'POST', body: { sourcePath } }); st.textContent = 'Imported ✓ ' + JSON.stringify(res.counts || res); toast('Import complete'); }
    catch (e) { st.textContent = e.code === 'V11_RUNNING' ? 'Quit JAT v11 first, then retry.' : ('Import failed: ' + e.message); }
  });

  const gsync = $('[data-gsync]', v);
  if (gsync) gsync.addEventListener('click', async () => { gsync.disabled = true; try { await api('/gmail/sync', { method: 'POST', body: {} }); toast('Gmail sync started'); } catch (e) { errToast(e); } finally { gsync.disabled = false; } });

  $('[data-export]', v).addEventListener('click', async () => {
    try {
      const res = await api('/export', { raw: true });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'jat13-export.json'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { errToast(e); }
  });
  return v;
});
function gmailSummary(g) {
  const rows = g.rows || g.accounts || [];
  if (Array.isArray(rows) && rows.length) return `${rows.length} account${rows.length === 1 ? '' : 's'} connected`;
  return 'Gmail connected';
}

// ===========================================================================
// command palette (Ctrl/Cmd+K)
// ===========================================================================
const PAGES = [
  { label: 'Dashboard', go: '#/' }, { label: 'Applications', go: '#/applications' },
  { label: 'Pipeline', go: '#/pipeline' }, { label: 'Auto-apply', go: '#/queue' },
  { label: 'Profile', go: '#/profile' }, { label: 'Documents', go: '#/documents' },
  { label: 'Activity', go: '#/activity' }, { label: 'Settings', go: '#/settings' },
];
function openPalette() {
  if (document.querySelector('#overlay-root .palette')) return;
  const p = el(`<div class="palette"><input type="text" placeholder="Jump to a page or search jobs…" /><div class="palette-list"></div></div>`);
  const close = openOverlay(p);
  const input = $('input', p), list = $('.palette-list', p);
  let jobs = [], items = [], sel = 0;
  function rebuild() {
    const q = input.value.trim().toLowerCase();
    const pages = PAGES.filter((c) => !q || c.label.toLowerCase().includes(q));
    items = [
      ...pages.map((c) => ({ label: c.label, hint: 'page', run: () => { location.hash = c.go; } })),
      ...jobs.map((j) => ({ label: `${j.title || 'Untitled'} — ${j.company || ''}`, hint: j.source || 'job', run: () => { location.hash = '#/applications'; } })),
    ];
    sel = Math.min(sel, Math.max(0, items.length - 1));
    paint();
  }
  function paint() {
    list.replaceChildren();
    if (!items.length) { list.innerHTML = '<div class="palette-empty">Nothing matches.</div>'; return; }
    items.forEach((it, i) => {
      const d = el('<div class="palette-item"><span class="pi-label"></span><span class="pi-hint"></span></div>');
      $('.pi-label', d).textContent = it.label; $('.pi-hint', d).textContent = it.hint;
      if (i === sel) d.classList.add('sel');
      d.addEventListener('click', () => { close(); it.run(); });
      list.appendChild(d);
    });
  }
  const searchJobs = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { jobs = []; rebuild(); return; }
    try { const r = await api('/jobs?limit=8&q=' + encodeURIComponent(q)); jobs = r.rows || []; } catch { jobs = []; }
    rebuild();
  }, 220);
  input.addEventListener('input', () => { sel = 0; rebuild(); searchJobs(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[sel]; if (it) { close(); it.run(); } }
  });
  rebuild(); input.focus();
}

// ===========================================================================
// runtime status dot + needs-you badge (polled)
// ===========================================================================
async function paintRuntime() {
  const dot = $('#runtime-dot'), txt = $('#runtime-text');
  try {
    const h = await health();
    state.online = true;
    if (h.version) { state.version = h.version; const bv = $('#brand-version'); if (bv) bv.textContent = 'v' + h.version; }
    if (dot) dot.className = 'status-dot online';
    if (txt) txt.textContent = 'Connected';
  } catch {
    state.online = false;
    if (dot) dot.className = 'status-dot';
    if (txt) txt.textContent = 'Offline';
  }
  if (state.token) {
    try {
      const s = await api('/summary');
      state.needsYou = s.needsYou || 0;
      state.applying = !!s.applying;
      paintNeedsBadge();
    } catch { /* ignore */ }
  }
}
function paintNeedsBadge() {
  const nav = document.querySelector('.nav-item[data-route="/queue"]');
  if (!nav) return;
  let badge = nav.querySelector('.nav-badge');
  if (state.needsYou > 0) {
    if (!badge) { badge = el('<span class="nav-badge pill warn"></span>'); nav.appendChild(badge); }
    badge.textContent = state.needsYou;
  } else if (badge) badge.remove();
}

// ===========================================================================
// boot
// ===========================================================================
async function boot() {
  try { applyTheme(localStorage.getItem(LS_THEME) || DEFAULT_THEME); } catch {}
  await bootstrap();
  const bv = $('#brand-version'); if (bv && state.version) bv.textContent = 'v' + state.version;

  if (state.token) {
    try {
      const s = await api('/settings');
      state.settings = s;
      const t = s.appearance?.themeId;
      if (t) { applyTheme(t); try { localStorage.setItem(LS_THEME, t); } catch {} }
    } catch { /* ignore */ }
  }

  paintRuntime();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(paintRuntime, 15000);
  navigate();
}

window.addEventListener('hashchange', navigate);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (e.key === 'Escape') { if (closeTopOverlay()) e.preventDefault(); }
});
if (!location.hash) location.hash = '#/';
boot();
