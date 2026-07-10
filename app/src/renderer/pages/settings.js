// Settings — Appearance is LIVE at Stage 0 (theme = localStorage authority +
// best-effort settings-API write); AI / Auto-apply / Gmail are designed stubs
// with their delivery stages. The two AI backend cards get real at Stage 4.
import { el, $, $$, esc, pageHead, stubCard, toast, THEMES, setThemeLocal, getThemeMode } from '../lib/dom.js';
import { api } from '../lib/api.js';

function themeTiles() {
  const mode = getThemeMode();
  return THEMES.map((t) => `
    <div class="theme-tile ${t.id === mode ? 'active' : ''}" data-mode="${esc(t.id)}" role="button" tabindex="0">
      <div class="swatch ${esc(t.swatch)}"><div class="chipbar"></div></div>
      <div class="tn">${esc(t.name)}</div>
      <div class="td">${esc(t.mode)}</div>
    </div>`).join('');
}

export default function render(view, ctx) {
  const pad = el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    <div class="settings-grid">
      <div class="card">
        <div class="card-h">
          <span class="cap">Appearance</span><div class="spacer"></div>
          <span class="stage-badge live"><span class="dot sage"></span>Live · Stage 0</span>
        </div>
        <div class="theme-grid" id="theme-grid">${themeTiles()}</div>
      </div>

      ${stubCard({
        compact: true, stage: 4, glyph: 'terminal',
        title: 'AI — your two subscriptions',
        lead: 'Claude Code and Codex, side by side. No API keys, ever.',
        points: [
          '<b>Two backend cards</b> — status dot, model, measured latency, Sign in, Detect, manual path',
          '<b>Verified means verified</b> — a real 1-token generation ping, not just credentials on disk',
          '<b>Best-for-task routing</b> — Codex for screening + fit (fastest measured); Claude for tailoring + cover letters',
          '<b>Every call ledgered</b> — backend, task, latency, outcome feed these cards and the autopsies',
        ],
        note: 'Prereq (you): run <b>claude auth login</b> once — your token expired 2026-06-15. Codex is already signed in.',
      })}

      ${stubCard({
        compact: true, stage: 3, glyph: 'bolt',
        title: 'Auto-apply',
        lead: 'The engine’s dials — scoped tight, defaults sane.',
        points: [
          '<b>Keywords, locations, seniority</b> window',
          '<b>Caps &amp; pacing</b> — apply_ledger is the only cap authority',
          '<b>Fit skip-floor</b> — default 30/100, tunable or off, skips always explained',
          '<b>Lane toggles</b> — LinkedIn / Indeed / ATS, plus per-source discovery on/off',
        ],
        note: 'Defaults on the table: LinkedIn 45/24h · ~30/hr supervised serial · unattended arrives Stage 6.',
      })}

      ${stubCard({
        compact: true, stage: 5, glyph: 'mail',
        title: 'Gmail',
        lead: 'One consent, then the pipeline advances itself.',
        points: [
          '<b>One-consent OAuth connect</b> — your desktop client; v11 credentials migrate',
          '<b>Broad query</b> — not sender-restricted (the v11.48 scar stays fixed)',
          '<b>Ordered classifier</b> → forward-only status moves',
          '<b>Suggestion review</b> before uncertain matches touch your pipeline',
        ],
        note: 'Connected state must mean a LIVE token — enabled-but-unauthorized never reads as connected.',
      })}

      <div class="card">
        <div class="card-h"><span class="cap">Also arriving</span><div class="spacer"></div><span class="aside">the rest of this page</span></div>
        <div class="card-body">
          <div class="row"><div class="k"><div class="kn">Import / Export</div><div class="kd">copy-based v11 import (never touches the live DB) · backups</div></div><span class="stage-badge">Stage 1</span></div>
          <div class="row"><div class="k"><div class="kn">Discovery</div><div class="kd">sources on/off, freshness ramp, saturation behavior</div></div><span class="stage-badge">Stage 3</span></div>
          <div class="row"><div class="k"><div class="kn">Notifications</div><div class="kd">OS notifications on every outcome · morning summary</div></div><span class="stage-badge">Stage 6</span></div>
          <div class="row"><div class="k"><div class="kn">Maintenance</div><div class="kd">backup ring, retention, payload audits</div></div><span class="stage-badge">Stage 6</span></div>
        </div>
      </div>
    </div>
  </div>`);
  view.appendChild(pad);

  const grid = $('#theme-grid', pad);
  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.theme-tile');
    if (!tile) return;
    const mode = setThemeLocal(tile.getAttribute('data-mode'));
    $$('.theme-tile', grid).forEach((t) => t.classList.toggle('active', t.getAttribute('data-mode') === mode));
    // best-effort server persistence — localStorage is the Stage 0 authority, so a
    // missing/failing settings route must not break the toggle.
    api('/settings/appearance.theme', { method: 'PUT', body: { value: mode }, signal: ctx.signal }).catch(() => {});
    toast(`Theme: ${THEMES.find((t) => t.id === mode)?.name || mode}`, 'success', 2200);
  });
  grid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.closest('.theme-tile')?.click(); }
  });
}
