// Activity — the append-only ledger (System). Stage 1: /api/events/recent
// rendered newest-first through the shared virtual list (the ledger can carry
// hundreds of imported v11 events), with kind-filter segs whose labels come
// from the ONE vocab map. Client-side filtering over the fetched window keeps
// it instant; the poll refreshes the window in place.
import { el, $, $$, esc, fmtTime, fmtDate, num, pageHead } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { createVirtualList } from '../lib/virtual.js';
import { eventKindLabel, eventKindDot } from '../lib/vocab.js';

const loadingRow = (t = 'Loading…') => `<div class="loading-row"><span class="spinner"></span>${esc(t)}</div>`;
const ROW_H = 40;
const FETCH_LIMIT = 400;

// seg groups: key = representative event kind (labels via vocab), kinds = match set
const GROUPS = [
  { key: '', kinds: null },
  { key: 'submitted', kinds: ['submitted'] },
  { key: 'status_change', kinds: ['status_change'] },
  { key: 'email_matched', kinds: ['email', 'email_matched'] },
  { key: 'park', kinds: ['park', 'needs_human'] },
  { key: 'created', kinds: ['created'] },
  { key: 'imported', kinds: ['imported'] },
];

export default function render(view, ctx) {
  const pad = el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    <div class="list-frame" style="height:calc(100vh - 200px); min-height:360px;">
      <div class="act-toolbar"><span class="cap">Ledger</span><div class="spacer"></div><div class="seg scroll" id="act-filter"></div></div>
      <div class="vlist" id="act-vlist" style="flex:1"><div class="list-empty" id="act-empty">${loadingRow('Reading the ledger…')}</div></div>
      <div class="list-status" id="act-status"></div>
    </div>
  </div>`);
  view.appendChild(pad);

  const seg = $('#act-filter', pad);
  seg.innerHTML = GROUPS.map((g, i) =>
    `<span data-g="${i}" class="${i === 0 ? 'on' : ''}">${g.key ? esc(eventKindLabel(g.key)) : 'All'}</span>`).join('');

  let cache = [];
  let group = GROUPS[0];
  let loadedOnce = false;

  const list = createVirtualList({
    viewport: $('#act-vlist', pad),
    rowHeight: ROW_H,
    renderRow: (e) => actRow(e),
  });

  function apply() {
    const rows = group.kinds ? cache.filter((e) => group.kinds.includes(e.kind)) : cache;
    list.setRows(rows);
    const statusBar = $('#act-status', pad);
    if (statusBar) {
      statusBar.innerHTML = `<span>${num(rows.length)}${group.kinds ? ` of ${num(cache.length)}` : ''} recent event${rows.length === 1 ? '' : 's'}</span>`
        + (group.kinds ? `<span>${esc(eventKindLabel(group.key))}</span>` : '')
        + (cache.length >= FETCH_LIMIT ? `<span>showing the freshest ${num(FETCH_LIMIT)}</span>` : '');
    }
    const emptyBox = $('#act-empty', pad);
    if (emptyBox) {
      emptyBox.classList.toggle('hidden', rows.length > 0);
      if (!rows.length && loadedOnce) {
        emptyBox.innerHTML = `<div class="empty">${group.kinds
          ? `No ${esc(eventKindLabel(group.key).toLowerCase())} events in the recent window.`
          : 'Nothing recorded yet — the ledger fills from the Stage 1 import onward.'}</div>`;
      }
    }
  }

  seg.addEventListener('click', (e) => {
    const s = e.target.closest('span[data-g]'); if (!s) return;
    $$('span', seg).forEach((x) => x.classList.remove('on'));
    s.classList.add('on');
    group = GROUPS[Number(s.getAttribute('data-g'))] || GROUPS[0];
    apply();
  });

  ctx.poll(15000, async () => {
    try {
      const d = await api(`/events/recent?limit=${FETCH_LIMIT}`, { signal: ctx.signal });
      cache = d?.rows || [];
      loadedOnce = true;
      apply();
    } catch (e) {
      if (e?.aborted) return;
      const emptyBox = $('#act-empty', pad);
      if (emptyBox && !cache.length) {
        emptyBox.classList.remove('hidden');
        emptyBox.innerHTML = `<div class="empty">Could not read the ledger — ${esc(e?.message || 'unknown error')}. Retrying…</div>`;
      }
    }
  });
}

function actRow(e) {
  const day = fmtDate(e.at);
  return el(`<div class="act">
    <span class="time" title="${esc(day)}">${fmtTime(e.at)}</span>
    <span class="atag ${esc(e.kind || '')}"><span class="dot ${eventKindDot(e.kind)}"></span>${esc(eventKindLabel(e.kind))}</span>
    <span class="txt">${esc(e.summary || '(no detail)')}</span>
    <span class="via">${esc(e.source || '')}</span>
  </div>`);
}
