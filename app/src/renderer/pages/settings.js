// Settings — Appearance is LIVE (theme = localStorage authority + best-effort API write). Stage 3
// makes the ENGINE dials live: Auto-apply (keywords / locations / seniority / caps / fit floor /
// easy-apply) and Discovery (on/off + freshness) read GET /api/settings and persist each knob via
// PUT /api/settings/<section>.<key> (the DAL validates against the registry — loud on unknown). AI /
// Gmail stay designed stubs with their delivery stages. All labels via vocab.js; all fetches via api().
import { el, $, $$, esc, icon, pageHead, stubCard, toast, errToast, THEMES, setThemeLocal, getThemeMode } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { SENIORITY_ORDER, seniorityLabel, WORK_MODE_ORDER, workModeLabel } from '../lib/vocab.js';

const loadingRow = (t = 'Loading…') => `<div class="loading-row"><span class="spinner"></span>${esc(t)}</div>`;

function themeTiles() {
  const mode = getThemeMode();
  return THEMES.map((t) => `
    <div class="theme-tile ${t.id === mode ? 'active' : ''}" data-mode="${esc(t.id)}" role="button" tabindex="0">
      <div class="swatch ${esc(t.swatch)}"><div class="chipbar"></div></div>
      <div class="tn">${esc(t.name)}</div>
      <div class="td">${esc(t.mode)}</div>
    </div>`).join('');
}

// one labelled config row: left = name + hint, right = the control (built by the caller).
function row(name, hint, ctl) {
  return `<div class="row"><div class="k"><div class="kn">${esc(name)}</div><div class="kd">${esc(hint)}</div></div>
    <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">${ctl}</div></div>`;
}
const textCtl = (sk, val, ph) => `<input class="inp" style="min-width:220px" data-sk="${sk}" data-kind="text" value="${esc(val)}" placeholder="${esc(ph || '')}">`;
const listCtl = (sk, arr, ph) => `<input class="inp" style="min-width:220px" data-sk="${sk}" data-kind="list" value="${esc((arr || []).join(', '))}" placeholder="${esc(ph || 'comma-separated…')}">`;
const numCtl = (sk, val, min, max) => `<input class="inp" style="width:96px" type="number" data-sk="${sk}" data-kind="number" min="${min}" max="${max}" value="${esc(String(val))}">`;
const boolCtl = (sk, val) => `<label class="need-radio" style="margin:0"><input type="checkbox" data-sk="${sk}" data-kind="bool"${val ? ' checked' : ''}><span>${val ? 'On' : 'Off'}</span></label>`;
function selCtl(sk, val, order, labelFn) {
  return `<select class="inp" data-sk="${sk}" data-kind="text">${order.map((o) => `<option value="${esc(o)}"${o === val ? ' selected' : ''}>${esc(labelFn(o))}</option>`).join('')}</select>`;
}
function workModesCtl(active) {
  const set = new Set(active || []);
  return `<div data-sk="autoApply.workModes" data-kind="modes" style="display:flex;gap:10px">${WORK_MODE_ORDER.map((m) =>
    `<label class="need-radio" style="margin:0"><input type="checkbox" data-wm="${esc(m)}"${set.has(m) ? ' checked' : ''}><span>${esc(workModeLabel(m))}</span></label>`).join('')}</div>`;
}

function autoApplyBody(a) {
  return row('Keywords', 'Positive title keywords. Empty = broad (derived from your profile).', listCtl('autoApply.keywords', a.keywords, 'e.g. typescript, backend'))
    + row('Locations', 'Empty = country-wide + remote (permissive).', listCtl('autoApply.locations', a.locations, 'e.g. Montreal, Toronto'))
    + row('Country', 'Scopes every board URL (the wrong-country scar).', textCtl('autoApply.country', a.country, 'Canada'))
    + row('Work modes', 'Empty = all three.', workModesCtl(a.workModes))
    + row('Seniority ceiling', 'Highest level to include. “Any” disables the cap.', selCtl('autoApply.seniorityMax', a.seniorityMax, SENIORITY_ORDER, seniorityLabel))
    + row('Max / day', 'Soft daily ceiling. apply_ledger is the hard per-account cap.', numCtl('autoApply.maxPerDay', a.maxPerDay, 1, 500))
    + row('Max / hour', 'Soft burst ceiling; per-lane pacing sits below this.', numCtl('autoApply.maxPerHour', a.maxPerHour, 1, 200))
    + row('Fit floor', 'Skip jobs scoring below this (0 = off). Skips are always shown with a reason.', numCtl('autoApply.fitFloor', a.fitFloor, 0, 100))
    + row('Easy-apply only', 'LinkedIn Easy Apply + Indeed smartapply + ATS forms; excludes the external/account-wall flood.', boolCtl('autoApply.easyApplyOnly', a.easyApplyOnly));
}
function discoveryBody(d) {
  return row('Discovery on', 'Run all four sources (per-lane, source-scoped gates). Off = apply only from saved jobs.', boolCtl('discovery.enabled', d.enabled))
    + row('Freshness window', 'Starting hours for the ramp (72h → 30d). Saturated combos widen automatically.', numCtl('discovery.freshnessHours', d.freshnessHours, 1, 720));
}

export default function render(view, ctx) {
  const pad = el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    <div class="settings-grid">
      <div class="card">
        <div class="card-h"><span class="cap">Appearance</span><div class="spacer"></div>
          <span class="stage-badge live"><span class="dot sage"></span>Live · Stage 0</span></div>
        <div class="theme-grid" id="theme-grid">${themeTiles()}</div>
      </div>

      <div class="card" id="aa-cfg">
        <div class="card-h"><span class="cap">Auto-apply</span><div class="spacer"></div>
          <span class="stage-badge live"><span class="dot sage"></span>Live · Stage 3</span></div>
        <div class="card-body" id="aa-cfg-body">${loadingRow('Reading engine settings…')}</div>
      </div>

      <div class="card" id="disco-cfg">
        <div class="card-h"><span class="cap">Discovery</span><div class="spacer"></div>
          <span class="stage-badge live"><span class="dot sage"></span>Live · Stage 3</span></div>
        <div class="card-body" id="disco-cfg-body">${loadingRow('')}</div>
      </div>

      ${stubCard({
        compact: true, stage: 4, glyph: 'terminal',
        title: 'AI — your two subscriptions',
        lead: 'Claude Code and Codex, side by side. No API keys, ever.',
        points: [
          '<b>Two backend cards</b> — status dot, model, measured latency, Sign in, Detect, manual path',
          '<b>Verified means verified</b> — a real 1-token generation ping, not just credentials on disk',
          '<b>Best-for-task routing</b> — Codex for screening + fit; Claude for tailoring + cover letters',
        ],
        note: 'Prereq (you): run <b>claude auth login</b> once — your token expired 2026-06-15. Codex is already signed in.',
      })}

      ${stubCard({
        compact: true, stage: 5, glyph: 'mail',
        title: 'Gmail',
        lead: 'One consent, then the pipeline advances itself.',
        points: [
          '<b>One-consent OAuth connect</b> — your desktop client; v11 credentials migrate',
          '<b>Broad query</b> — not sender-restricted (the v11.48 scar stays fixed)',
          '<b>Ordered classifier</b> → forward-only status moves',
        ],
        note: 'Connected must mean a LIVE token — enabled-but-unauthorized never reads as connected.',
      })}

      <div class="card">
        <div class="card-h"><span class="cap">Also arriving</span><div class="spacer"></div><span class="aside">the rest of this page</span></div>
        <div class="card-body">
          <div class="row"><div class="k"><div class="kn">Import / Export</div><div class="kd">copy-based v11 import · backups</div></div><span class="stage-badge">Stage 1</span></div>
          <div class="row"><div class="k"><div class="kn">Notifications</div><div class="kd">OS notifications on every outcome · morning summary</div></div><span class="stage-badge">Stage 6</span></div>
          <div class="row"><div class="k"><div class="kn">Maintenance</div><div class="kd">backup ring, retention, payload audits</div></div><span class="stage-badge">Stage 6</span></div>
        </div>
      </div>
    </div>
  </div>`);
  view.appendChild(pad);

  // theme tiles (unchanged from Stage 0 — localStorage is the authority)
  const grid = $('#theme-grid', pad);
  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.theme-tile');
    if (!tile) return;
    const mode = setThemeLocal(tile.getAttribute('data-mode'));
    $$('.theme-tile', grid).forEach((t) => t.classList.toggle('active', t.getAttribute('data-mode') === mode));
    api('/settings/appearance.themeId', { method: 'PUT', body: { value: mode }, signal: ctx.signal }).catch(() => {});
    toast(`Theme: ${THEMES.find((t) => t.id === mode)?.name || mode}`, 'success', 2200);
  });
  grid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.closest('.theme-tile')?.click(); }
  });

  // hydrate the engine config cards from the live settings, then wire each knob to PUT.
  (async () => {
    let cfg;
    try { cfg = await api('/settings', { signal: ctx.signal }); }
    catch (e) {
      if (e?.aborted) return;
      const msg = `<div class="empty">Could not read settings — ${esc(e?.message || 'unknown error')}</div>`;
      const b1 = $('#aa-cfg-body', pad); if (b1) b1.innerHTML = msg;
      const b2 = $('#disco-cfg-body', pad); if (b2) b2.innerHTML = msg;
      return;
    }
    const aBody = $('#aa-cfg-body', pad); if (aBody) aBody.innerHTML = autoApplyBody(cfg.autoApply || {});
    const dBody = $('#disco-cfg-body', pad); if (dBody) dBody.innerHTML = discoveryBody(cfg.discovery || {});
    wire($('#aa-cfg', pad), ctx);
    wire($('#disco-cfg', pad), ctx);
  })();
}

// attach a change listener per control that PUTs its (section,key) value; toast on failure.
function wire(card, ctx) {
  if (!card) return;
  const put = async (sk, value) => {
    try { await api(`/settings/${sk}`, { method: 'PUT', body: { value }, signal: ctx.signal }); }
    catch (e) { errToast(e, 'Save setting'); }
  };
  $$('[data-sk]', card).forEach((node) => {
    const sk = node.getAttribute('data-sk');
    const kind = node.getAttribute('data-kind');
    if (kind === 'modes') {
      node.addEventListener('change', () => {
        const modes = $$('input[data-wm]', node).filter((i) => i.checked).map((i) => i.getAttribute('data-wm'));
        put(sk, modes);
      });
      return;
    }
    const evt = kind === 'bool' ? 'change' : 'change';
    node.addEventListener(evt, () => {
      let value;
      if (kind === 'bool') { value = node.checked; const lab = node.parentElement?.querySelector('span'); if (lab) lab.textContent = value ? 'On' : 'Off'; }
      else if (kind === 'number') value = Number(node.value);
      else if (kind === 'list') value = String(node.value || '').split(',').map((s) => s.trim()).filter(Boolean);
      else value = String(node.value || '');
      put(sk, value);
    });
  });
}
