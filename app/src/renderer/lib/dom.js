// JAT 13 — DOM utilities: tiny query/build helpers, formatting, toasts, overlays,
// the inline SVG icon set + signet, the theme controller, and the shared page
// fragments (pageHead, stubCard) every page composes from. No framework — the
// renderer is plain ES modules by design (post-mortem: the architecture held).

// ---------------------------------------------------------------------------
// query / build
// ---------------------------------------------------------------------------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------
export function fmtTime(ms) { if (!ms) return '—'; const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
export function fmtDate(ms) { if (!ms) return '—'; return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
export function fmtDateTime(ms) { if (!ms) return '—'; return `${fmtDate(ms)} · ${fmtTime(ms)}`; }
export function fmtAgo(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}
export function fmtDuration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60); if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
export const num = (n) => (n == null ? '0' : Number(n).toLocaleString());
export function initials(name) { const p = String(name || '').trim().split(/\s+/); return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || 'PS'; }
export function todayLabel() { return new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }

// ---------------------------------------------------------------------------
// icons — inline SVG only (CSP forbids external hosts). The J⁄13 signet is the
// brand mark: an edition-number monogram in an engraved double ring, gold-leaf
// gradient (#au, defined once in index.html).
// ---------------------------------------------------------------------------
export function signet(size = 46) {
  return `<svg class="signet" viewBox="0 0 96 96" width="${size}" height="${size}" aria-label="JAT 13">
    <circle cx="48" cy="48" r="45" fill="none" stroke="url(#au)" stroke-width="1.7"/>
    <circle cx="48" cy="48" r="39.5" fill="none" stroke="url(#au)" stroke-width=".9" stroke-dasharray="1 3.4" opacity=".85"/>
    <path d="M48 3.6 L50 5.9 48 8.2 46 5.9 Z" fill="url(#au)"/>
    <path d="M48 87.8 L50 90.1 48 92.4 46 90.1 Z" fill="url(#au)"/>
    <line x1="37.5" y1="67" x2="59.5" y2="29" stroke="url(#au)" stroke-width="1.5" stroke-linecap="round"/>
    <text x="31" y="54" font-family="Palatino Linotype, Palatino, Georgia, serif" font-size="37" fill="url(#au)" text-anchor="middle">J</text>
    <text x="62" y="73" font-family="Palatino Linotype, Palatino, Georgia, serif" font-size="22" letter-spacing="1.5" fill="url(#au)" text-anchor="middle">13</text>
  </svg>`;
}

const PATHS = {
  command: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2.2 5-5 2.2 2.2-5z"/>',
  bolt: '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>',
  bell: '<path d="M18 8a6 6 0 10-12 0c0 7-2.5 8-2.5 8h17S18 15 18 8"/><path d="M10.3 21a2 2 0 003.4 0"/>',
  board: '<rect x="3" y="4" width="5" height="16" rx="1.2"/><rect x="10" y="4" width="5" height="11" rx="1.2"/><rect x="17" y="4" width="4" height="7" rx="1.2"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c1.4-3.4 4-5 7-5s5.6 1.6 7 5"/>',
  doc: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
  activity: '<path d="M3 12h4l2 6 4-14 2 8h6"/>',
  autopsy: '<rect x="4.5" y="4.5" width="15" height="16.5" rx="2"/><path d="M9 2.8h6v3.4H9z"/><path d="M7.5 14.5h2.2l1.3-2.8 1.9 4.8 1.3-2.8h2.3"/>',
  settings: '<path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/>',
  question: '<circle cx="12" cy="12" r="9.2"/><path d="M9 9.5a3 3 0 115.2 2c-.9.9-2.2 1.4-2.2 2.9"/><circle cx="12" cy="18.2" r=".5" fill="currentColor"/>',
  shield: '<path d="M12 3l8 3v5.5c0 4.6-3.2 7.6-8 9.5-4.8-1.9-8-4.9-8-9.5V6z"/><path d="M9.5 12l1.8 1.8 3.4-3.6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017.5-1.8"/>',
  trash: '<path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13"/>',
  download: '<path d="M12 4v11M8 11l4 4 4-4M5 20h14"/>',
  upload: '<path d="M12 20V9M8 13l4-4 4 4M5 4h14"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 6.5"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  refresh: '<path d="M20 11a8 8 0 10-1.5 5"/><path d="M20 5v6h-6"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  robot: '<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 8V4M9 13h.01M15 13h.01M9 16h6"/><circle cx="12" cy="3" r="1.2"/>',
  inbox: '<path d="M4 13l2.5-8h11L20 13v5a2 2 0 01-2 2H6a2 2 0 01-2-2z"/><path d="M4 13h5l1 2h4l1-2h5"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5"/>',
  terminal: '<path d="M4 17l6-5-6-5M12 19h8"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>',
};

/** icon(name, size=16) — SVG string (empty if unknown; unknown icons are a code bug, not data). */
export function icon(name, size = 16, extra = '') {
  const d = PATHS[name];
  if (!d) return '';
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}" ${extra}>${d}</svg>`;
}

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------
export function toast(msg, kind = 'info', ttl) {
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
export const errToast = (e, prefix = '') => { if (e?.aborted) return; toast((prefix ? prefix + ' — ' : '') + (e?.message || String(e)), 'danger'); };

// ---------------------------------------------------------------------------
// overlays (palette host, future drawers)
// ---------------------------------------------------------------------------
export function openOverlay(node, { onClose } = {}) {
  const root = $('#overlay-root');
  const ov = el('<div class="overlay"></div>');
  ov.appendChild(node);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) { ov.remove(); onClose?.(); } });
  root.appendChild(ov);
  return () => { ov.remove(); onClose?.(); };
}
export function closeTopOverlay() {
  const ovs = $$('#overlay-root .overlay');
  if (ovs.length) { ovs[ovs.length - 1].remove(); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// theme controller — Atelier Noir (dark) / Atelier Ivory (light) / System.
// styles.css keys the full variable set on html[data-theme]; this only decides
// WHICH ground to stamp. localStorage is the shell's authority (survives the
// pre-connection frame); the settings API write is the caller's concern.
// ---------------------------------------------------------------------------
export const THEMES = [
  { id: 'dark', name: 'Atelier Noir', mode: 'Dark', swatch: 'sw-dark' },
  { id: 'light', name: 'Atelier Ivory', mode: 'Light', swatch: 'sw-light' },
  { id: 'system', name: 'System', mode: 'Auto', swatch: 'sw-system' },
];
export const DEFAULT_THEME = 'dark';
const LS_THEME = 'jat13.theme';
const VALID_THEME = new Set(['dark', 'light', 'system']);
let currentMode = DEFAULT_THEME;
let mql = null;

export function normalizeMode(v) { return VALID_THEME.has(v) ? v : 'dark'; }
export function getThemeMode() { return currentMode; }

function resolveConcrete(mode) {
  if (mode !== 'system') return mode;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
export function applyTheme(mode) {
  currentMode = normalizeMode(mode);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolveConcrete(currentMode));
  root.setAttribute('data-mode', currentMode);
  if (!mql && window.matchMedia) {
    mql = window.matchMedia('(prefers-color-scheme: light)');
    mql.addEventListener('change', () => { if (currentMode === 'system') applyTheme('system'); });
  }
  return currentMode;
}
/** Apply + persist locally. Callers that also want the settings-API write layer it on top. */
export function setThemeLocal(mode) {
  const m = applyTheme(mode);
  try { localStorage.setItem(LS_THEME, m); } catch { /* private mode etc. */ }
  return m;
}
export function initTheme() {
  let m = DEFAULT_THEME;
  try { const s = localStorage.getItem(LS_THEME); if (s) m = normalizeMode(s); } catch { /* ignore */ }
  applyTheme(m);
}

// ---------------------------------------------------------------------------
// shared page fragments
// ---------------------------------------------------------------------------
export function pageHead(title, { serif, date, live, sub } = {}) {
  return `<div class="page-head">
    <h1>${serif ? `<span class="serif">${esc(title)}</span>` : esc(title)}</h1>
    ${date ? `<span class="date">${esc(date)}</span>` : ''}
    ${sub ? `<span class="sub">${esc(sub)}</span>` : ''}
    ${live ? `<span class="live"><span class="dot live"></span> ${esc(live)}</span>` : ''}
  </div>`;
}
export function centerState(title, sub, actionHtml = '') {
  return el(`<div class="center-state">${signet(72)}<h2>${esc(title)}</h2><p>${esc(sub || '')}</p>${actionHtml}</div>`);
}

/**
 * stubCard — the Stage-0 page promise. `stage` = the stage that delivers the page
 * (or {n, label} for nuance like "first card at Stage 2"). `points` may carry <b>
 * emphasis; they are author-written constants, never user data.
 */
export function stubCard({ stage, stageLabel, live, isNew, glyph = 'sparkle', title, lead, points = [], note, compact }) {
  const badge = live
    ? `<span class="stage-badge live"><span class="dot sage"></span>Live · Stage ${esc(String(stage))}</span>`
    : `<span class="stage-badge">Arrives · Stage ${esc(String(stage))}</span>`;
  return `<div class="card stub-card${compact ? ' compact' : ''}">
    <div class="stub-mark">${icon(glyph, compact ? 120 : 190)}</div>
    <div class="stub-head">
      <div class="stub-badges">
        ${badge}
        ${stageLabel ? `<span class="stub-flag">${esc(stageLabel)}</span>` : ''}
        ${isNew ? `<span class="stub-flag new">★ New in 13</span>` : ''}
      </div>
      <h2>${esc(title)}</h2>
      ${lead ? `<p class="lead">${esc(lead)}</p>` : ''}
    </div>
    ${points.length ? `<ul class="stub-points">${points.map((p) => `<li>${icon('check', 14)}<span>${p}</span></li>`).join('')}</ul>` : ''}
    ${note ? `<div class="stub-note">${note}</div>` : ''}
  </div>`;
}
