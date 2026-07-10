// Command Center — home. Stage 1 upgrade: the four tiles carry REAL numbers
// (jobs / applied / interviews / offers) computed from the ONE funnel source of
// truth (/api/summary) — never a second aggregation. Engine Health and the
// Rebuild Progress ladder stay; Stage 1 shows as the stage being built now
// (vocab.CURRENT_STAGE is the single authority). Tiles that cannot be read yet
// say so honestly — nothing here fakes data.
import { el, $, esc, icon, pageHead, todayLabel, fmtDuration, num } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { STAGES, CURRENT_STAGE, STATUS_ORDER, statusLabel } from '../lib/vocab.js';

// funnel → the four headline numbers (the proven 13.0.x definitions)
function headline(funnel, totals) {
  const f = funnel || {};
  const applied = STATUS_ORDER.filter((s) => s !== 'tracked').reduce((n, s) => n + (f[s] || 0), 0);
  const interviews = (f.interview_1 || 0) + (f.interview_2 || 0) + (f.interview_final || 0);
  const offers = (f.offer || 0) + (f.hired || 0);
  return [
    { l: 'Jobs', n: totals?.jobs, d: totals?.applications != null ? `${num(totals.applications)} applications on file` : 'postings on file' },
    { l: 'Applied', n: applied, d: totals?.submitted7d != null ? `<b>${num(totals.submitted7d)}</b> submitted · last 7 days` : `every ${esc(statusLabel('submitted').toLowerCase())}-or-later application` },
    { l: 'Interviews', n: interviews, d: interviews ? `${num(f.interview_final || 0)} at final round` : 'none active' },
    { l: 'Offers', n: offers, d: offers ? `<b>${num(f.hired || 0)}</b> hired` : 'none yet' },
  ];
}

function paintTiles(box, model) {
  if (!model) {
    box.innerHTML = ['Jobs', 'Applied', 'Interviews', 'Offers'].map((l) =>
      `<div class="stat ghost"><div class="lbl">${l}</div><div class="num tnum">—</div><div class="delta">waiting for the engine…</div></div>`).join('');
    return;
  }
  box.innerHTML = headline(model.funnel, model.totals).map((c) =>
    `<div class="stat"><div class="lbl">${esc(c.l)}</div><div class="num tnum">${c.n == null ? '—' : num(c.n)}</div><div class="delta">${c.d}</div></div>`).join('');
}

function stageRows() {
  return STAGES.map((s) => {
    const cls = s.n < CURRENT_STAGE ? 'done' : s.n === CURRENT_STAGE ? 'current' : 'pending';
    const glyph = s.n < CURRENT_STAGE ? icon('check', 13) : String(s.n);
    const flag = s.n < CURRENT_STAGE ? '<span class="now" style="color:var(--ink-faint);border-color:var(--hair)">shipped</span>'
      : s.n === CURRENT_STAGE ? '<span class="now">building now</span>' : '';
    return `<div class="stage-row ${cls}">
      <span class="sglyph">${glyph}</span>
      <div class="sbody">
        <div class="st">Stage ${s.n} — ${esc(s.title)}${flag}</div>
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
    ['Stage', d.stage != null ? `${d.stage}` : String(CURRENT_STAGE)],
  ];
  return rows.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`).join('');
}

export default function render(view, ctx) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Command Center', { date: todayLabel(), live: `stage ${CURRENT_STAGE} · data foundation` })}
    <div class="stats" id="cc-stats"></div>
    <div class="grid">
      <div class="card col-flex span-5 hoverable">
        <div class="card-h"><span class="cap">Engine health</span><div class="spacer"></div><span class="aside">/api/status · 5s</span></div>
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

  const tiles = $('#cc-stats', pad);
  paintTiles(tiles, null);
  let statusCounts = null; // /api/status counts back-fill jobs/applications totals

  // headline numbers — the funnel, refreshed gently
  ctx.poll(12000, async () => {
    try {
      const s = await api('/summary', { signal: ctx.signal });
      const funnel = s?.funnel?.byStatus || s?.funnel || {};
      const totals = {
        jobs: s?.totals?.jobs ?? s?.counts?.jobs ?? statusCounts?.jobs ?? null,
        applications: s?.totals?.applications ?? s?.counts?.applications ?? statusCounts?.applications ?? null,
        submitted7d: s?.totals?.submitted7d ?? null,
      };
      paintTiles(tiles, { funnel, totals });
    } catch (e) {
      if (e?.aborted) return;
      tiles.innerHTML = ['Jobs', 'Applied', 'Interviews', 'Offers'].map((l) =>
        `<div class="stat ghost"><div class="lbl">${l}</div><div class="num tnum">${l === 'Jobs' && statusCounts ? num(statusCounts.jobs) : '—'}</div>
          <div class="delta">${esc(e?.code === 'not_found' ? 'awaiting the Stage 1 read API' : 'engine unreachable')}</div></div>`).join('');
    }
  });

  // engine health — the Stage-0 chain proof, kept verbatim
  ctx.poll(5000, async () => {
    const rows = $('#cc-health-rows', pad);
    const dot = $('#cc-health-dot', pad);
    const note = $('#cc-health-note', pad);
    if (!rows) return;
    try {
      const d = await api('/status', { signal: ctx.signal });
      if (d?.counts) statusCounts = d.counts;
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
