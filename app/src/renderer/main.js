// JAT 13 — renderer bootstrap. Deliberately THIN (the 13.0.x renderer grew a
// 1,476-line main.js; the rebuild's CI gate forbids it): theme, shell chrome,
// router init, one global /api/status poller for the topbar/engine health, and
// the dev-drive harness when devtools is on. Everything page-shaped lives in
// pages/*; every label lives in lib/vocab.js; every fetch goes through lib/api.js.
import { $, esc, signet, icon, initials, toast, closeTopOverlay, initTheme } from './lib/dom.js';
import { configure, api, apiBase, apiToken, onUnauthorized, ApiError } from './lib/api.js';
import { PAGES, NAV_GROUPS, CHORD_ROUTE, startRouter, openPalette, go } from './lib/router.js';
import { startDevDrive } from './lib/devdrive.js';

// shared app state — rides into every page as ctx.shared
const state = {
  online: false,
  version: '',
  port: 7860,
  devtools: false,
  profileName: 'Pierre Salama',
};

// ---------------------------------------------------------------------------
// bootstrap: preload bridge (Electron window) → port-probe (browser dashboard).
// Both paths end in configure() so lib/api.js owns base+token from then on.
// ---------------------------------------------------------------------------
async function bootstrap() {
  if (window.jat13?.config) {
    try {
      const cfg = await window.jat13.config();
      if (cfg?.port) state.port = cfg.port;
      if (cfg?.devtools) state.devtools = true;
      if (cfg?.version) state.version = cfg.version;
      configure({ base: `http://127.0.0.1:${state.port}`, token: cfg?.token || '' });
      if (cfg?.token) return true;
    } catch { /* fall through to the loopback probe */ }
  }
  // browser dashboard: same static app served by the brain — fetch the pairing
  // token from whichever port answers (prod 7860, dev 7861).
  for (const port of [7860, 7861]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/pair/token`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) continue;
      const body = await res.json();
      const d = body?.ok === true ? body.data : body; // enveloped (canonical) or bare (transitional)
      if (d?.token) {
        state.port = port;
        state.version = d.version || '';
        state.devtools = d.devtools === true;
        configure({ base: `http://127.0.0.1:${port}`, token: d.token });
        return true;
      }
    } catch { /* try next port */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// shell chrome — brand, nav (4 groups from the IA table), footer, topbar
// ---------------------------------------------------------------------------
function renderShell() {
  $('#brand').innerHTML = `${signet(44)}<div class="wordmark"><div class="wm-1">JAT<sup>&nbsp;13</sup></div><div class="wm-2">Atelier</div></div>`;
  $('#nav').innerHTML = NAV_GROUPS.map((group) => `
    <div class="nav-h">${esc(group)}</div>
    ${PAGES.filter((p) => p.group === group).map((p) => `
      <a class="nav-item" data-route="${esc(p.route)}" href="#${esc(p.route)}">
        ${icon(p.icon, 16)}<span class="grow">${esc(p.label)}</span>
        ${p.star ? '<span class="nav-star">★</span>' : ''}
        ${p.badge ? `<span class="nav-badge" id="nav-badge-${esc(p.badge)}"></span>` : `<span class="key">G&thinsp;${esc(p.chord)}</span>`}
      </a>`).join('')}
  `).join('');
  $('#user-avatar').textContent = initials(state.profileName);
  $('#user-name').textContent = state.profileName;
  $('#cmd-open').addEventListener('click', openPalette);
  $('#apply-toggle').addEventListener('click', () => toast('Auto-apply arrives with Stage 3 — the shell ships first.', 'info', 3000));
}

// keyboard: Ctrl+K palette · Esc closes overlays · G-then-letter jumps pages
function bindKeys() {
  let chordArmed = 0;
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (e.key === 'Escape') { closeTopOverlay(); return; }
    const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '');
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toUpperCase();
    if (k === 'G') { chordArmed = Date.now(); return; }
    if (chordArmed && Date.now() - chordArmed < 1200 && CHORD_ROUTE[k]) { go(CHORD_ROUTE[k]); }
    chordArmed = 0;
  });
}

// ---------------------------------------------------------------------------
// global health poller — /api/status feeds the engine chip + topbar conn chip.
// Never cleared: the tray-resident brain should read as alive from any page.
// ---------------------------------------------------------------------------
function paintConnected(d) {
  state.online = true;
  state.version = d?.version || state.version;
  const chip = $('#engine-chip');
  chip?.classList.remove('off');
  const dot = $('#engine-dot'); if (dot) dot.className = 'dot sage';
  const t1 = $('#engine-t1'); if (t1) t1.textContent = 'Engine online';
  const t2 = $('#engine-t2'); if (t2) t2.textContent = `v${state.version || '?'} · :${state.port}`;
  const cc = $('#conn-chip');
  if (cc) { cc.classList.remove('hidden'); cc.innerHTML = `<span class="dot sage" style="width:6px;height:6px"></span> Connected <span class="mono">:${state.port}</span>`; }
}
function paintOffline(why) {
  state.online = false;
  const chip = $('#engine-chip');
  chip?.classList.add('off');
  const dot = $('#engine-dot'); if (dot) dot.className = 'dot danger';
  const t1 = $('#engine-t1'); if (t1) t1.textContent = 'Not connected';
  const t2 = $('#engine-t2'); if (t2) t2.textContent = why || 'loopback unreachable';
  const cc = $('#conn-chip');
  if (cc) { cc.classList.remove('hidden'); cc.innerHTML = `<span class="dot danger" style="width:6px;height:6px"></span> Offline`; }
}
function startStatusPoller() {
  const tick = async () => {
    try { paintConnected(await api('/status')); }
    catch (e) {
      if (e?.aborted) return;
      paintOffline(e instanceof ApiError && e.code === 'unauthorized' ? 'pairing rejected' : 'loopback unreachable');
    }
  };
  tick();
  setInterval(tick, 5000);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(async function boot() {
  initTheme();
  renderShell();
  bindKeys();
  const paired = await bootstrap();
  state.port = Number(new URL(apiBase()).port) || state.port;
  onUnauthorized(() => paintOffline('pairing rejected')); // 401 anywhere → offline state
  startRouter(state); // stubs render fine with no connection; live cards show their own offline rows
  startStatusPoller();
  if (paired && state.devtools) startDevDrive({ base: apiBase(), token: apiToken() });
  if (!paired) toast('JAT 13 engine unreachable — is the desktop app running?', 'danger', 6000);
})();
