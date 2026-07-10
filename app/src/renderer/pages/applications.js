// Applications — the full virtualized table over the imported v11 life (Track).
// Ported from the proven 13.0.x renderer: windowed rows over /api/applications
// pages, status chips, honest client-side search over LOADED rows, and a detail
// drawer (timeline + matched emails + meta) per row. All labels via vocab.js;
// all fetches via lib/api.js; virtualization via lib/virtual.js.
import { el, $, esc, icon, debounce, fmtDate, fmtDateTime, fmtAgo, num, pageHead, openOverlay } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { createVirtualList } from '../lib/virtual.js';
import { statusLabel, statusDot, viaLabel, srcTagText, mailCatLabel, eventKindLabel, eventKindDot } from '../lib/vocab.js';

const ROW_H = 58;
const loadingRow = (t = 'Loading…') => `<div class="loading-row"><span class="spinner"></span>${esc(t)}</div>`;

// ---------------------------------------------------------------------------
// shared lazy job cache — lean application rows may not carry title/company;
// only VISIBLE rows request their job, so virtualization bounds the fan-out.
// Module-level so it stays warm across route changes; pipeline.js reuses it.
// ---------------------------------------------------------------------------
const jobCache = new Map();
const jobPending = new Set();
const jobWaiters = new Map();
export const jobKnown = (id) => jobCache.get(id) || null;
/** Seed the cache from a row that already carries job fields (no fetch needed). */
export function primeJob(id, j) { if (id && j && !jobCache.has(id)) jobCache.set(id, j); }
export function ensureJob(id, cb) {
  if (!id) return;
  const hit = jobCache.get(id);
  if (hit) { cb?.(hit); return; }
  if (cb) { if (!jobWaiters.has(id)) jobWaiters.set(id, new Set()); jobWaiters.get(id).add(cb); }
  if (jobPending.has(id)) return;
  jobPending.add(id);
  const settle = () => {
    const j = jobCache.get(id);
    const w = jobWaiters.get(id);
    if (w) { w.forEach((f) => { try { f(j); } catch { /* waiter died with its page */ } }); jobWaiters.delete(id); }
  };
  api(`/jobs/${encodeURIComponent(id)}`)
    .then((j) => jobCache.set(id, {
      title: j?.title || 'Untitled role', company: j?.company || '', location: j?.location || '',
      source: j?.source || '', job_url: j?.job_url || '', apply_capability: j?.apply_capability, fit_score: j?.fit_score,
    }))
    .catch(() => jobCache.set(id, { title: 'Role', company: '', source: '', job_url: '' }))
    .finally(() => { jobPending.delete(id); settle(); });
}
function seedRowJob(row) {
  if (row?.job_id && (row.title || row.job_title)) {
    primeJob(row.job_id, {
      title: row.title || row.job_title || 'Untitled role', company: row.company || '',
      location: row.location || '', source: row.source || '', job_url: row.job_url || '',
    });
  }
}

const statusBadge = (s) => `<span class="sbadge"><span class="dot ${statusDot(s)}"></span>${esc(statusLabel(s))}</span>`;
const srcTag = (source) => `<span class="src-tag" title="${esc(source || '')}">${esc(srcTagText(source))}</span>`;

// chip set kept compact on purpose (the proven set) — deep cuts live in Pipeline
const CHIP_STATUSES = ['', 'tracked', 'submitted', 'acknowledged', 'assessment', 'interview_1', 'offer', 'rejected'];

// ---------------------------------------------------------------------------
export default function render(view, ctx) {
  const activeStatus = ctx.query.status || '';
  const pad = el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    <div class="toolbar">
      <div class="search-box">${icon('search', 14)}<input id="app-search" placeholder="Filter loaded rows by title, company, status…" autocomplete="off"></div>
      <div class="seg scroll" id="app-status-seg"></div>
    </div>
    <div class="list-frame" style="height:calc(100vh - 252px); min-height:360px;">
      <div class="list-head"><span>Status</span><span>Role</span><span>Next / detail</span><span>Via</span><span>Updated</span></div>
      <div class="vlist" id="app-vlist" style="flex:1">
        <div class="list-empty hidden" id="app-empty"></div>
      </div>
      <div class="list-status" id="app-status">${loadingRow('')}</div>
    </div>
  </div>`);
  view.appendChild(pad);

  const seg = $('#app-status-seg', pad);
  seg.innerHTML = CHIP_STATUSES
    .map((s) => `<span data-status="${s}" class="${s === activeStatus ? 'on' : ''}">${s ? esc(statusLabel(s)) : 'All'}</span>`).join('');
  seg.addEventListener('click', (e) => {
    const t = e.target.closest('span[data-status]'); if (!t) return;
    const v = t.getAttribute('data-status');
    ctx.go(v ? `/applications?status=${v}` : '/applications');
  });

  const viewport = $('#app-vlist', pad);
  const emptyBox = $('#app-empty', pad);
  const statusBar = $('#app-status', pad);
  let search = '';

  function buildRow(row) {
    const j = jobKnown(row.job_id);
    const titleHtml = j
      ? `<div class="t">${esc(j.title)}</div><div class="c">${esc(j.company || j.location || '')}</div>`
      : `<div class="t"><span class="skelbar" style="width:60%"></span></div><div class="c"><span class="skelbar" style="width:40%"></span></div>`;
    const n = el(`<div class="vrow">
      <div class="r-status">${statusBadge(row.status)}</div>
      <div class="r-title" data-jrow="${esc(row.job_id || '')}">${titleHtml}</div>
      <div class="r-meta">${row.needs_review ? '<span class="needs-flag">Needs review</span>' : esc(row.next_action || (row.due_at ? `Due ${fmtDate(row.due_at)}` : '—'))}</div>
      <div class="r-via">${esc(viaLabel(row.via))}</div>
      <div class="r-date tnum">${fmtAgo(row.updated_at)}</div>
    </div>`);
    n.addEventListener('click', () => openDrawer(row));
    if (!j) ensureJob(row.job_id, (job) => {
      const cell = $(`.r-title[data-jrow="${CSS.escape(row.job_id)}"]`, viewport);
      if (cell && job) cell.innerHTML = `<div class="t">${esc(job.title)}</div><div class="c">${esc(job.company || job.location || '')}</div>`;
    });
    return n;
  }
  const placeholderRow = () => el(`<div class="vrow">
    <div class="r-status"><span class="dot dim"></span><span class="skelbar" style="width:60px"></span></div>
    <div class="r-title"><span class="skelbar" style="width:70%"></span></div>
    <div class="r-meta"></div><div class="r-via"></div><div class="r-date"></div>
  </div>`);

  const list = createVirtualList({
    viewport, rowHeight: ROW_H, pageSize: 120,
    renderRow: buildRow, renderPlaceholder: placeholderRow,
    fetchPage: async (offset, limit) => {
      const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (activeStatus) q.set('status', activeStatus);
      const d = await api(`/applications?${q}`, { signal: ctx.signal });
      (d?.rows || []).forEach(seedRowJob);
      return { rows: d?.rows || [], total: d?.total ?? (d?.rows || []).length };
    },
    onStatus: ({ total, loaded, mode }) => {
      statusBar.innerHTML = `<span>${num(mode === 'fixed' ? loaded : total)} application${total === 1 ? '' : 's'}${activeStatus ? ` · ${esc(statusLabel(activeStatus))}` : ''}</span>`
        + (mode === 'fixed' ? `<span>filtering “${esc(search)}” over loaded rows</span>` : `<span>${num(loaded)} loaded</span>`);
      const isEmpty = (mode === 'fixed' ? loaded : total) === 0;
      emptyBox.classList.toggle('hidden', !isEmpty);
      if (isEmpty) {
        emptyBox.innerHTML = `<div class="empty">${search
          ? 'No loaded rows match that filter — scroll to load more, or clear it.'
          : activeStatus
            ? `Nothing is ${esc(statusLabel(activeStatus).toLowerCase())} yet.`
            : 'No applications on file yet — run the v11 import from Settings.'}</div>`;
      }
    },
    onError: (e) => {
      statusBar.innerHTML = `<span style="color:var(--danger)">Could not load applications — ${esc(e?.message || 'unknown error')}</span>`;
    },
  });

  $('#app-search', pad).addEventListener('input', debounce((e) => {
    search = e.target.value.trim();
    if (!search) { list.clearRows(); return; }
    const q = search.toLowerCase();
    const matched = list.loadedRows().filter((r) => {
      const j = jobKnown(r.job_id);
      return `${statusLabel(r.status)} ${viaLabel(r.via)} ${j ? `${j.title} ${j.company}` : ''}`.toLowerCase().includes(q);
    }).slice(0, 300);
    list.setRows(matched);
  }, 200));
}

// ---------------------------------------------------------------------------
// detail drawer — meta + timeline + matched emails for one application
// ---------------------------------------------------------------------------
async function openDrawer(row) {
  const j = jobKnown(row.job_id);
  const node = el(`<div class="drawer">
    <div class="drawer-h">
      <div class="dt">
        <h3 id="dr-title">${j ? esc(j.title) : 'Application'}</h3>
        <div class="dc" id="dr-sub">${j?.company ? `${esc(j.company)} · ` : ''}${statusBadge(row.status)}</div>
      </div>
      <button class="drawer-x" aria-label="Close">${icon('close', 16)}</button>
    </div>
    <div class="drawer-body" id="dr-body">${loadingRow('Loading timeline…')}</div>
  </div>`);
  const close = openOverlay(node);
  node.querySelector('.drawer-x').addEventListener('click', close);
  if (!j) ensureJob(row.job_id, (job) => {
    const t = $('#dr-title', node); if (t && job) t.textContent = job.title;
    const s = $('#dr-sub', node); if (s && job) s.innerHTML = `${job.company ? `${esc(job.company)} · ` : ''}${statusBadge(row.status)}`;
  });

  const metaHtml = () => {
    const job = jobKnown(row.job_id);
    const kv = (k, v) => (v ? `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>` : '');
    return `<div class="drawer-sec">Details</div><div class="kv-rows dr-meta">
      ${kv('Status', statusBadge(row.status))}
      ${kv('Via', esc(viaLabel(row.via)))}
      ${kv('Source', job?.source ? `${srcTag(job.source)} <span style="margin-left:6px">${esc(job.source)}</span>` : '')}
      ${kv('Location', job?.location ? esc(job.location) : '')}
      ${kv('Applied', row.submitted_at ? esc(fmtDateTime(row.submitted_at)) : '')}
      ${kv('Last update', esc(fmtDateTime(row.updated_at)))}
      ${kv('Next action', row.next_action ? esc(row.next_action) : '')}
      ${kv('Due', row.due_at ? esc(fmtDate(row.due_at)) : '')}
      ${row.needs_review ? kv('Review', '<span class="needs-flag">Needs review</span>') : ''}
    </div>
    ${job?.job_url ? `<div style="margin-top:10px"><a class="btn sm" href="${esc(job.job_url)}" target="_blank" rel="noreferrer">${icon('external', 13)} Open posting</a></div>` : ''}`;
  };

  try {
    const data = await api(`/applications/${encodeURIComponent(row.id)}/timeline`);
    const events = data?.events?.rows || data?.events || [];
    const emails = data?.emails?.rows || data?.emails || [];
    const body = $('#dr-body', node); if (!body) return;
    let html = metaHtml();
    html += '<div class="drawer-sec">Timeline</div>';
    html += events.length
      ? `<div class="tl-wrap">${events.map((e) => `<div class="tl"><span class="tdot"></span>
          <div class="th">${esc(e.summary || eventKindLabel(e.kind))}</div>
          <div class="tm"><span class="dot ${eventKindDot(e.kind)}" style="width:5px;height:5px;margin-right:5px"></span>${esc(eventKindLabel(e.kind))} · ${esc(fmtDateTime(e.at))}${e.source ? ` · ${esc(e.source)}` : ''}</div>
        </div>`).join('')}</div>`
      : '<div class="empty">No events recorded yet.</div>';
    if (emails.length) {
      html += '<div class="drawer-sec">Matched emails</div>';
      html += emails.map((m) => `<div class="mail"><span class="dot sage mdot"></span>
        <div class="mb"><div class="subj">${esc(m.subject || '(no subject)')}</div><div class="from">${esc(m.from_name || m.from_addr || '')}</div>${m.snippet ? `<div class="snip">${esc(m.snippet)}</div>` : ''}</div>
        ${m.category ? `<span class="mcat">${esc(mailCatLabel(m.category))}</span>` : ''}
        <span class="mtime">${fmtAgo(m.sent_at || m.created_at)}</span>
      </div>`).join('');
    }
    body.innerHTML = html;
  } catch (e) {
    if (e?.aborted) return;
    const body = $('#dr-body', node);
    if (body) body.innerHTML = metaHtml() + `<div class="empty">Could not load the timeline — ${esc(e?.message || 'unknown error')}</div>`;
  }
}
