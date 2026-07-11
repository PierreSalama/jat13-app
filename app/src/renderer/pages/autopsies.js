// Autopsies — ★ new in 13 (01-ARCHITECTURE §5, System). Stage 2: every terminal
// run writes a readable post-mortem. This page lists them as single cards — final
// state, WHERE it stopped (page class + blocking control + park kind), a condensed
// step trail, and the summary. Pattern grouping ("same failure ×N") and one-click
// self-healing proposals arrive in Stage 5; here each card stands alone.
//
// Contract (integrator wires this):
//   GET /api/autopsies?limit=N → ok({ rows:[autopsy…], total })
//     autopsy row: { id, run_id, application_id, job_id, lane, final_state, park_kind,
//                    page_key, blocking_control, step_trail (array | *_json string),
//                    summary, signature, created_at }
import { el, $, esc, icon, fmtAgo, fmtDateTime, pageHead } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { humanize, runStateLabel, runStateDot, parkLabel, laneLabel, stepPhaseLabel, stepPhaseDot } from '../lib/vocab.js';
import { ensureJob, jobKnown, primeJob } from './applications.js';

const loadingRow = (t = 'Loading…') => `<div class="loading-row"><span class="spinner"></span>${esc(t)}</div>`;
const FETCH_LIMIT = 100;

/** step_trail may arrive parsed (array) or as *_json (string) — parse defensively. */
function parseTrail(a) {
  const raw = a.step_trail ?? a.step_trail_json ?? a.trail ?? [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; } }
  return [];
}

export default function render(view, ctx) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Autopsies', { sub: ctx.meta.sub })}
    <div class="card col-flex hoverable">
      <div class="card-h"><span class="cap">Post-mortems</span><span class="nav-badge" id="au-n"></span><div class="spacer"></div>
        <span class="aside">newest first · patterns &amp; fixes arrive Stage 5</span></div>
      <div id="au-list">${loadingRow('Reading post-mortems…')}</div>
    </div>
  </div>`);
  view.appendChild(pad);

  const listBox = $('#au-list', pad);
  const countBadge = $('#au-n', pad);

  ctx.poll(15000, async () => {
    let rows;
    try {
      const d = await api(`/autopsies?limit=${FETCH_LIMIT}`, { signal: ctx.signal });
      rows = d?.rows || (Array.isArray(d) ? d : []);
    } catch (e) {
      if (e?.aborted) return;
      if (!listBox.querySelector('.autopsy')) listBox.innerHTML = `<div class="empty">Could not read autopsies — ${esc(e?.message || 'unknown error')}. Retrying…</div>`;
      return;
    }
    rows.forEach((a) => { if (a.job_id && (a.job_title || a.title)) primeJob(a.job_id, { title: a.job_title || a.title, company: a.company || '' }); });
    countBadge.textContent = rows.length ? String(rows.length) : '';

    if (!rows.length) {
      listBox.innerHTML = `<div class="empty">No autopsies yet — the first is written the moment a run reaches a terminal state. Drive one from Auto-Apply to see it here.</div>`;
      return;
    }
    listBox.innerHTML = '';
    rows.forEach((a) => listBox.appendChild(card(a)));
  });
}

function card(a) {
  const trail = parseTrail(a);
  const stopped = [
    a.page_key ? `on <b>${esc(humanize(a.page_key))}</b>` : '',
    a.blocking_control ? `at <b>${esc(String(a.blocking_control).slice(0, 120))}</b>` : '',
    a.park_kind ? `— ${esc(parkLabel(a.park_kind))}` : '',
  ].filter(Boolean).join(' ');
  const node = el(`<div class="autopsy">
    <div class="au-h">
      <span class="au-state"><span class="dot ${runStateDot(a.final_state)}"></span>${esc(runStateLabel(a.final_state))}</span>
      <div class="au-who"><div class="au-title" data-jt="${esc(a.job_id || '')}">${a.job_id && jobKnown(a.job_id) ? jobTitle(a.job_id) : esc(a.job_title || 'Run ' + String(a.run_id || a.id || '').slice(-6))}</div>
        <div class="au-meta">${esc(laneLabel(a.lane))}${a.created_at ? ` · ${esc(fmtDateTime(a.created_at))}` : ''}</div></div>
      <span class="au-age">${fmtAgo(a.created_at)}</span>
    </div>
    ${stopped ? `<div class="au-stopped">${icon('autopsy', 13)} Stopped ${stopped}</div>` : ''}
    ${a.summary ? `<div class="au-summary">${esc(a.summary)}</div>` : ''}
    ${trail.length ? `<div class="au-trail">${trail.slice(-24).map((s) => stepChip(s)).join('')}</div>` : ''}
  </div>`);
  if (a.job_id && !jobKnown(a.job_id)) {
    ensureJob(a.job_id, () => { const n = $(`.au-title[data-jt="${CSS.escape(a.job_id)}"]`, node); if (n) n.innerHTML = jobTitle(a.job_id); });
  }
  return node;
}

function jobTitle(jobId) {
  const j = jobKnown(jobId);
  if (!j) return 'Role';
  return `${esc(j.title)}${j.company ? ` <span>— ${esc(j.company)}</span>` : ''}`;
}

function stepChip(s) {
  const phase = typeof s === 'string' ? s : s?.phase;
  const detail = typeof s === 'string' ? '' : (s?.target || s?.detail || '');
  return `<span class="au-step${s && s.ok === false ? ' bad' : ''}" title="${esc(detail)}"><span class="dot ${stepPhaseDot(phase)}"></span>${esc(stepPhaseLabel(phase))}</span>`;
}
