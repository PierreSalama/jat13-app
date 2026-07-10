// Command Center — the one page that is LIVE at Stage 0. It proves the whole
// chain (renderer → envelope client → /api/status → brain) and shows Pierre the
// delivery ladder. The Stage-1+ tiles are honest ghosts: labeled, never faked.
import { el, $, esc, icon, pageHead, todayLabel, fmtDuration } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { STAGES, CURRENT_STAGE } from '../lib/vocab.js';

const GHOST_TILES = [
  { l: 'Jobs', d: 'your ~4,510 arrive with the Stage 1 import' },
  { l: 'Applied', d: 'your ~630 arrive with the Stage 1 import' },
  { l: 'Interviews', d: 'tracked from Stage 1 · detected from Stage 5' },
  { l: 'Offers', d: 'counted from the funnel · Stage 1' },
];

function stageRows() {
  return STAGES.map((s) => {
    const cls = s.n < CURRENT_STAGE ? 'done' : s.n === CURRENT_STAGE ? 'current' : 'pending';
    const glyph = s.n < CURRENT_STAGE ? icon('check', 13) : String(s.n);
    return `<div class="stage-row ${cls}">
      <span class="sglyph">${glyph}</span>
      <div class="sbody">
        <div class="st">Stage ${s.n} — ${esc(s.title)}${s.n === CURRENT_STAGE ? '<span class="now">building now</span>' : ''}</div>
        <div class="sg">${esc(s.goal)}</div>
      </div>
    </div>`;
  }).join('');
}

function healthRows(d, shared) {
  if (!d) {
    return `<div class="kv"><span class="k">Engine</span><span class="v dim">unreachable — is the app running?</span></div>
      <div class="kv"><span class="k">Probing</span><span class="v dim">127.0.0.1:${esc(String(shared?.port ?? 7860))} · every 5s</span></div>`;
  }
  const schema = d.schema ?? d.schemaVersion;
  const uptimeMs = d.uptimeMs ?? (d.startedAt ? Date.now() - d.startedAt : null);
  const rows = [
    ['Product', d.name || 'JAT 13'],
    ['Version', d.version ? `v${d.version}` : '—'],
    ['Schema', schema != null ? `v${schema}` : '—'],
    ['Uptime', uptimeMs != null ? fmtDuration(uptimeMs) : '—'],
    ['Port', `127.0.0.1:${d.port ?? shared?.port ?? '—'}`],
    ['Channel', d.dev ? 'dev' : 'production'],
  ];
  return rows.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`).join('');
}

export default function render(view, ctx) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Command Center', { date: todayLabel(), live: 'stage 0 · skeleton' })}
    <div class="stats" id="cc-stats">
      ${GHOST_TILES.map((t) => `<div class="stat ghost"><div class="lbl">${esc(t.l)}</div><div class="num tnum">—</div><div class="delta">${esc(t.d)}</div></div>`).join('')}
    </div>
    <div class="grid">
      <div class="card col-flex span-5 hoverable">
        <div class="card-h"><span class="cap">Engine health</span><div class="spacer"></div><span class="aside" id="cc-health-aside">/api/status · 5s</span></div>
        <div class="kv-rows" id="cc-health-rows">
          <div class="kv"><span class="k">Engine</span><span class="v dim">reading…</span></div>
        </div>
        <div class="card-foot"><span class="dot dim" id="cc-health-dot"></span><span id="cc-health-note">first probe pending</span></div>
      </div>
      <div class="card col-flex span-7 hoverable">
        <div class="card-h"><span class="cap">Rebuild progress</span><div class="spacer"></div><span class="aside">7 stages · every gate is yours</span></div>
        <div>${stageRows()}</div>
      </div>
    </div>
  </div>`);
  view.appendChild(pad);

  ctx.poll(5000, async () => {
    const rows = $('#cc-health-rows', pad);
    const dot = $('#cc-health-dot', pad);
    const note = $('#cc-health-note', pad);
    if (!rows) return;
    try {
      const d = await api('/status', { signal: ctx.signal });
      rows.innerHTML = healthRows(d, ctx.shared);
      if (dot) dot.className = 'dot sage';
      if (note) note.textContent = `alive · last probe ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      if (e?.aborted) return;
      rows.innerHTML = healthRows(null, ctx.shared);
      if (dot) dot.className = 'dot danger';
      if (note) note.textContent = e?.code === 'unauthorized' ? 'pairing token rejected' : 'engine offline';
    }
  });
}
