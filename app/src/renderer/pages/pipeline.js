// Pipeline — the status board (Track). Columns are the human statuses in FSM
// order; counts come from ONE funnel source of truth (/api/summary), never a
// second aggregation. Each non-empty column previews its freshest cards with a
// "+N more" that deep-links into the Applications table pre-filtered.
import { el, $, $$, esc, fmtDate, fmtAgo, num, pageHead } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { STATUS_ORDER, statusLabel, statusDot, srcTagText } from '../lib/vocab.js';
import { jobKnown, ensureJob, primeJob } from './applications.js';

const loadingRow = (t = 'Loading…') => `<div class="loading-row"><span class="spinner"></span>${esc(t)}</div>`;
const TERMINAL_COLS = ['rejected', 'withdrawn', 'ghosted'];
const MAIN_COLS = STATUS_ORDER.filter((s) => !TERMINAL_COLS.includes(s));
const CARDS_PER_COL = 4;

const srcTag = (source) => `<span class="src-tag" title="${esc(source || '')}">${esc(srcTagText(source))}</span>`;

export default function render(view, ctx) {
  const pad = el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: 'Counts from the one funnel source of truth · click a column to open it in Applications' })}
    <div class="card" style="padding:20px 22px 8px"><div class="board" id="board">${loadingRow('Building the board…')}</div></div>
  </div>`);
  view.appendChild(pad);

  let lastCounts = ''; // diff-not-rebuild: skip repainting identical funnels

  ctx.poll(20000, async () => {
    let funnel;
    try {
      const s = await api('/summary', { signal: ctx.signal });
      funnel = s?.funnel?.byStatus || s?.funnel || {};
    } catch (e) {
      if (e?.aborted) return;
      const board = $('#board', pad);
      if (board && !board.querySelector('.col')) {
        board.innerHTML = `<div class="empty" style="width:100%">Could not read the funnel — ${esc(e?.message || 'engine unreachable')}. Retrying…</div>`;
      }
      return;
    }
    const cols = [
      ...MAIN_COLS.map((s) => ({ s, count: funnel[s] || 0 })),
      ...TERMINAL_COLS.map((s) => ({ s, count: funnel[s] || 0, terminal: true })),
    ];
    const sig = cols.map((c) => c.count).join(',');
    if (sig === lastCounts) return;
    lastCounts = sig;

    const board = $('#board', pad); if (!board) return;
    board.innerHTML = cols.map((c) => `
      <div class="col ${c.terminal ? 'terminal' : ''}" data-col="${esc(c.s)}">
        <div class="col-h" data-status="${esc(c.s)}">
          <span class="dot ${statusDot(c.s)}"></span>
          <span class="nm">${esc(statusLabel(c.s))}</span>
          <span class="ct tnum">${num(c.count)}</span>
        </div>
        <div class="col-cards" data-cards="${esc(c.s)}">${c.count ? loadingRow('') : '<div class="col-empty">empty</div>'}</div>
      </div>`).join('');
    $$('.col-h', board).forEach((h) => h.addEventListener('click', () => ctx.go(`/applications?status=${h.getAttribute('data-status')}`)));
    cols.filter((c) => c.count > 0).forEach((c) => loadColumnCards(pad, ctx, c.s, c.count));
  });
}

async function loadColumnCards(pad, ctx, status, count) {
  let rows = [];
  try {
    const d = await api(`/applications?status=${encodeURIComponent(status)}&limit=${CARDS_PER_COL}`, { signal: ctx.signal });
    rows = d?.rows || [];
  } catch (e) {
    if (e?.aborted) return;
    const box = $(`[data-cards="${CSS.escape(status)}"]`, pad);
    if (box) box.innerHTML = '<div class="col-empty">could not load</div>';
    return;
  }
  const box = $(`[data-cards="${CSS.escape(status)}"]`, pad); if (!box) return;
  rows.forEach((r) => { if (r.job_id && (r.title || r.job_title)) primeJob(r.job_id, { title: r.title || r.job_title, company: r.company || '', source: r.source || '' }); });
  box.innerHTML = rows.map((r) => pipeCard(r, status)).join('')
    + (count > rows.length ? `<div class="more" data-status="${esc(status)}">+ ${num(count - rows.length)} more</div>` : '');
  $$('.more', box).forEach((m) => m.addEventListener('click', () => ctx.go(`/applications?status=${m.getAttribute('data-status')}`)));
  $$('.job', box).forEach((c) => c.addEventListener('click', () => ctx.go(`/applications?status=${encodeURIComponent(status)}`)));
  rows.forEach((r) => ensureJob(r.job_id, (j) => patchCard(box, r, j)));
}

function pipeCard(r, status) {
  const j = jobKnown(r.job_id);
  const note = r.needs_review ? 'Needs review' : (r.next_action || (r.due_at ? `Due ${fmtDate(r.due_at)}` : ''));
  return `<div class="job ${status === 'offer' ? 'offer' : ''}" data-appid="${esc(r.id)}">
    <div class="jt" data-jt="${esc(r.job_id || '')}">${j ? esc(j.title) : 'Loading…'}</div>
    <div class="jc">${srcTag(j?.source || '')} <span data-jco="${esc(r.job_id || '')}">${j ? esc(j.company || '') : ''}</span></div>
    <div class="jf"><span class="ago">${fmtAgo(r.updated_at)}</span>${note ? `<span class="note">${esc(note)}</span>` : ''}</div>
  </div>`;
}
function patchCard(box, r, j) {
  if (!j || !r.job_id) return;
  const t = $(`[data-jt="${CSS.escape(r.job_id)}"]`, box); if (t) t.textContent = j.title;
  const co = $(`[data-jco="${CSS.escape(r.job_id)}"]`, box); if (co) co.textContent = j.company || '';
}
