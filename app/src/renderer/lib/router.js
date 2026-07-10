// JAT 13 — hash router + the information-architecture table (01-ARCHITECTURE §5).
// PAGES is the single source of truth for the nav (4 groups, 12 pages), the
// breadcrumb, the palette, and every page's title/sub — main.js renders the nav
// from it, pages read their identity from ctx.meta. One file per page (CI-gated
// <400 lines each): the 1,476-line main.js monolith stays dead.

import { $, $$, el, esc, icon, openOverlay, centerState } from './dom.js';
import renderCommandCenter from '../pages/command-center.js';
import renderAutoApply from '../pages/auto-apply.js';
import renderNeedsYou from '../pages/needs-you.js';
import renderPipeline from '../pages/pipeline.js';
import renderApplications from '../pages/applications.js';
import renderInbox from '../pages/inbox.js';
import renderInterviews from '../pages/interviews.js';
import renderProfile from '../pages/profile.js';
import renderDocuments from '../pages/documents.js';
import renderActivity from '../pages/activity.js';
import renderAutopsies from '../pages/autopsies.js';
import renderSettings from '../pages/settings.js';

export const PAGES = [
  { route: '/', group: 'Operate', label: 'Command Center', icon: 'command', chord: 'C', sub: "Today's numbers, live runs, and what needs you — at a glance", render: renderCommandCenter },
  { route: '/auto-apply', group: 'Operate', label: 'Auto-Apply', icon: 'bolt', chord: 'A', sub: 'Mission control — queue, run theater, honest rate, discovery', render: renderAutoApply },
  { route: '/needs-you', group: 'Operate', label: 'Needs You', icon: 'bell', chord: 'N', badge: 'needs', sub: 'The human queue — answer, unblock, review', render: renderNeedsYou },
  { route: '/pipeline', group: 'Track', label: 'Pipeline', icon: 'board', chord: 'P', sub: 'Every application, staged from saved to hired', render: renderPipeline },
  { route: '/applications', group: 'Track', label: 'Applications', icon: 'layers', chord: 'L', sub: 'The full table — filter, inspect, drill into any run', render: renderApplications },
  { route: '/inbox', group: 'Track', label: 'Inbox', icon: 'mail', chord: 'I', sub: 'Matched employer email, classified and actioned', render: renderInbox },
  { route: '/interviews', group: 'Track', label: 'Interviews', icon: 'calendar', chord: 'V', star: true, sub: 'Every detected interview, briefed and prepped', render: renderInterviews },
  { route: '/profile', group: 'You', label: 'Profile', icon: 'user', chord: 'U', sub: 'Identity, seed fields, and everything the engine has learned', render: renderProfile },
  { route: '/documents', group: 'You', label: 'Documents', icon: 'doc', chord: 'D', sub: 'The library and every AI-generated tailoring', render: renderDocuments },
  { route: '/activity', group: 'System', label: 'Activity', icon: 'activity', chord: 'Y', sub: 'The append-only ledger of everything the app did', render: renderActivity },
  { route: '/autopsies', group: 'System', label: 'Autopsies', icon: 'autopsy', chord: 'T', star: true, sub: 'Post-mortems for every terminal run — patterns and fixes', render: renderAutopsies },
  { route: '/settings', group: 'System', label: 'Settings', icon: 'settings', chord: 'S', sub: 'AI backends, engine controls, appearance, maintenance', render: renderSettings },
];
export const NAV_GROUPS = ['Operate', 'Track', 'You', 'System'];
const BY_ROUTE = new Map(PAGES.map((p) => [p.route, p]));
export const CHORD_ROUTE = Object.fromEntries(PAGES.map((p) => [p.chord, p.route]));

// ---------------------------------------------------------------------------
// per-route lifecycle: timers + abort die on nav; routeGen guards stale writes
// ---------------------------------------------------------------------------
let routeGen = 0;
let pageTimers = [];
let pageAbort = new AbortController();
let shared = null;

function resetPage() {
  pageTimers.forEach(clearInterval);
  pageTimers = [];
  try { pageAbort.abort(); } catch { /* already dead */ }
  pageAbort = new AbortController();
  routeGen++;
}
/** Guarded interval: skips overlapping ticks, dies silently when the route changes. */
function makePoll(gen) {
  return (ms, fn, immediate = true) => {
    let inFlight = false;
    const tick = async () => {
      if (inFlight || gen !== routeGen) return;
      inFlight = true;
      try { await fn(); } catch (e) { if (!e?.aborted) console.warn('[poll]', e); }
      finally { inFlight = false; }
    };
    if (immediate) tick();
    pageTimers.push(setInterval(tick, ms));
  };
}

export function go(path) { location.hash = path; }

function parseHash() {
  const raw = (location.hash || '#/').slice(1);
  const [path, qs] = raw.split('?');
  const query = {};
  if (qs) new URLSearchParams(qs).forEach((v, k) => { query[k] = v; });
  return { path: path || '/', query };
}

function setActiveNav(page) {
  $$('#nav .nav-item').forEach((a) => a.classList.toggle('active', a.getAttribute('data-route') === page.route));
  const crumb = $('#crumb');
  if (crumb) crumb.innerHTML = `${esc(page.group)} &nbsp;/&nbsp; <b>${esc(page.label)}</b>`;
}

function route() {
  resetPage();
  const { path, query } = parseHash();
  const page = BY_ROUTE.get(path) || BY_ROUTE.get('/');
  setActiveNav(page);
  const view = $('#main');
  view.scrollTop = 0;
  view.innerHTML = '';
  const ctx = { query, meta: page, signal: pageAbort.signal, poll: makePoll(routeGen), go, shared };
  try {
    page.render(view, ctx);
  } catch (e) {
    console.error('[router]', e);
    view.innerHTML = '';
    view.appendChild(centerState('Something went wrong', e?.message || 'render error'));
  }
}

/** Bind the router. `sharedCtx` (app state from main.js) rides into every page as ctx.shared. */
export function startRouter(sharedCtx) {
  shared = sharedCtx;
  window.addEventListener('hashchange', route);
  route();
}

// ---------------------------------------------------------------------------
// command palette — jump anywhere in the IA (Ctrl+K). Stage 0's whole point is
// clicking through the layout; the palette makes that instant.
// ---------------------------------------------------------------------------
export function openPalette() {
  const node = el(`<div class="palette">
    <div class="palette-input">${icon('search', 16)}<input placeholder="Jump to a page…" autocomplete="off"><kbd>Esc</kbd></div>
    <div class="palette-list"></div>
  </div>`);
  const close = openOverlay(node);
  const input = node.querySelector('input');
  const list = node.querySelector('.palette-list');
  let sel = 0;

  const matches = (q) => PAGES.filter((p) => !q || `${p.group} ${p.label}`.toLowerCase().includes(q));
  function paint() {
    const q = input.value.trim().toLowerCase();
    const hits = matches(q);
    sel = Math.min(sel, Math.max(0, hits.length - 1));
    let html = '';
    let lastGroup = '';
    hits.forEach((p, i) => {
      if (!q && p.group !== lastGroup) { html += `<div class="palette-sec">${esc(p.group)}</div>`; lastGroup = p.group; }
      html += `<div class="palette-item ${i === sel ? 'sel' : ''}" data-route="${esc(p.route)}">
        ${icon(p.icon, 15)}<span class="pgrow"><b>${esc(p.label)}</b> — ${esc(p.sub)}</span><span class="phint">G ${esc(p.chord)}</span>
      </div>`;
    });
    list.innerHTML = html || `<div class="empty">No page matches.</div>`;
    $$('.palette-item', list).forEach((n) => n.addEventListener('click', () => { close(); go(n.getAttribute('data-route')); }));
  }
  input.addEventListener('input', () => { sel = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    const hits = matches(input.value.trim().toLowerCase());
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, hits.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === 'Enter' && hits[sel]) { close(); go(hits[sel].route); }
    else if (e.key === 'Escape') close();
  });
  paint();
  input.focus();
}
