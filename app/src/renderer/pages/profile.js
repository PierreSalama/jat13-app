// Profile — identity + the learned-memory browser (You). Stage 1 is read-only:
// the identity card and seed fields come from /api/profiles, the memory browser
// searches /api/answers (server-side q + kind), virtualizes the result window
// (4,241 answers), and opens a drawer with the FULL stored value + provenance.
// Editing / locking / deleting arrive with the engine stages.
import { el, $, $$, esc, icon, debounce, fmtAgo, fmtDateTime, num, initials, pageHead, openOverlay } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { createVirtualList } from '../lib/virtual.js';
import { humanize, answerKindLabel, provenanceLabel, provenanceDot } from '../lib/vocab.js';

const loadingRow = (t = 'Loading…') => `<div class="loading-row"><span class="spinner"></span>${esc(t)}</div>`;
const MEM_ROW_H = 58;
const provBadge = (p) => `<span class="prov"><span class="dot ${provenanceDot(p)}" style="width:5px;height:5px"></span>${esc(provenanceLabel(p))}</span>`;
const firstOf = (data, keys) => { for (const k of keys) { const v = data?.[k]; if (v != null && v !== '') return v; } return ''; };

export default function render(view, ctx) {
  const pad = el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    <div class="prof-grid">
      <div class="card" id="prof-id">${loadingRow('Loading profile…')}</div>
      <div class="card col-flex">
        <div class="card-h"><span class="cap">Learned memory</span><div class="spacer"></div><span class="aside" id="mem-count">—</span></div>
        <div class="la-sub">Everything the engine has learned about answering as you. Click a row to see the full stored value and where it came from.</div>
        <div class="la-tools">
          <div class="search-box">${icon('search', 13)}<input id="mem-search" placeholder="Search questions and fields…" autocomplete="off"></div>
          <div class="seg" id="mem-kind">
            <span data-kind="" class="on">All</span>
            <span data-kind="field">${esc(answerKindLabel('field'))}s</span>
            <span data-kind="qa">${esc(answerKindLabel('qa'))}</span>
          </div>
        </div>
        <div class="vlist mem-vlist" id="mem-vlist"><div class="list-empty hidden" id="mem-empty"></div></div>
        <div class="list-status" id="mem-status">${loadingRow('')}</div>
      </div>
    </div>
  </div>`);
  view.appendChild(pad);

  const state = { profileId: null, q: '', kind: '' };

  const list = createVirtualList({
    viewport: $('#mem-vlist', pad),
    rowHeight: MEM_ROW_H,
    renderRow: (a) => memRow(a),
  });

  loadIdentity(pad, ctx, state, () => loadAnswers(pad, ctx, state, list));

  $('#mem-search', pad).addEventListener('input', debounce((e) => {
    state.q = e.target.value.trim();
    loadAnswers(pad, ctx, state, list);
  }, 250));
  const seg = $('#mem-kind', pad);
  seg.addEventListener('click', (e) => {
    const s = e.target.closest('span[data-kind]'); if (!s) return;
    $$('span', seg).forEach((x) => x.classList.remove('on'));
    s.classList.add('on');
    state.kind = s.getAttribute('data-kind') || '';
    loadAnswers(pad, ctx, state, list);
  });
}

// ---------------------------------------------------------------------------
// identity card — default profile + every scalar seed field, read-only
// ---------------------------------------------------------------------------
async function loadIdentity(pad, ctx, state, then) {
  const card = $('#prof-id', pad); if (!card) return;
  let profile;
  try {
    const listRes = await api('/profiles', { signal: ctx.signal });
    const rows = listRes?.rows || [];
    const def = rows.find((r) => r.is_default) || rows[0];
    if (!def) {
      card.innerHTML = '<div class="empty">No profile on file yet — the Stage 1 import creates yours from v11.</div>';
      $('#mem-status', pad).innerHTML = '<span>waiting for a profile</span>';
      return;
    }
    state.profileId = def.id;
    profile = await api(`/profiles/${encodeURIComponent(def.id)}`, { signal: ctx.signal });
  } catch (e) {
    if (e?.aborted) return;
    card.innerHTML = `<div class="empty">Could not load the profile — ${esc(e?.message || 'unknown error')}</div>`;
    return;
  }
  const data = profile?.data && typeof profile.data === 'object' ? profile.data : {};
  const role = firstOf(data, ['title', 'role', 'headline']) || 'Applicant';
  const loc = firstOf(data, ['location', 'city']);
  const scalars = Object.entries(data).filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v));
  const complex = Object.entries(data).filter(([, v]) => v != null && typeof v === 'object');
  card.innerHTML = `
    <div class="id-head">
      <div class="id-avatar">${esc(initials(profile?.name))}</div>
      <div>
        <div class="nm">${esc(profile?.name || 'Profile')}</div>
        <div class="rl">${esc(String(role))}${loc ? ` · ${esc(String(loc))}` : ''}</div>
      </div>
    </div>
    <div class="kv-rows id-fields">
      ${scalars.length || complex.length ? '' : '<div class="empty">No seed fields yet — the Stage 1 import fills these from v11.</div>'}
      ${scalars.map(([k, v]) => `<div class="kv"><span class="k">${esc(humanize(k))}</span><span class="v" title="${esc(String(v ?? ''))}">${esc(String(v ?? '') || '—')}</span></div>`).join('')}
      ${complex.map(([k, v]) => `<div class="kv"><span class="k">${esc(humanize(k))}</span><span class="v dim">${Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : 'structured'}</span></div>`).join('')}
    </div>
    <div class="card-foot"><span>Read-only in Stage 1 — profile editing returns with the engine stages.</span></div>`;
  then?.();
}

// ---------------------------------------------------------------------------
// learned memory — server-side search, virtualized window, value drawer
// ---------------------------------------------------------------------------
async function loadAnswers(pad, ctx, state, list) {
  if (!state.profileId) return;
  const statusBar = $('#mem-status', pad);
  const emptyBox = $('#mem-empty', pad);
  try {
    const params = new URLSearchParams({ profileId: state.profileId, limit: '500' });
    if (state.q) params.set('q', state.q);
    if (state.kind) params.set('kind', state.kind);
    const d = await api(`/answers?${params}`, { signal: ctx.signal });
    const rows = d?.rows || [];
    list.setRows(rows);
    const total = d?.total ?? rows.length;
    const cnt = $('#mem-count', pad); if (cnt) cnt.textContent = `${num(total)} learned`;
    if (statusBar) {
      statusBar.innerHTML = `<span>${num(rows.length)} shown${total > rows.length ? ` of ${num(total)} — search to narrow` : ''}</span>`
        + (state.q ? `<span>matching “${esc(state.q)}”</span>` : '')
        + (state.kind ? `<span>${esc(answerKindLabel(state.kind))}</span>` : '');
    }
    if (emptyBox) {
      emptyBox.classList.toggle('hidden', rows.length > 0);
      if (!rows.length) emptyBox.innerHTML = `<div class="empty">${state.q || state.kind ? 'No answers match that filter.' : 'No learned answers yet — they accrue as the engine applies (and the v11 import brings yours in).'}</div>`;
    }
  } catch (e) {
    if (e?.aborted) return;
    if (statusBar) statusBar.innerHTML = `<span style="color:var(--danger)">Could not load memory — ${esc(e?.message || 'unknown error')}</span>`;
  }
}

function memRow(a) {
  const conf = Math.round((a.confidence || 0) * 100);
  const n = el(`<div class="la-row mem">
    <div class="la-q">
      <div class="lbl">${esc(a.label || humanize(a.key_norm || ''))}</div>
      <div class="meta">${provBadge(a.provenance)}<span>${esc(answerKindLabel(a.kind))}</span>${a.field_type ? `<span>${esc(humanize(a.field_type))}</span>` : ''}<span>seen ${num(a.seen_count || 0)}×</span><span>used ${num(a.used_count || 0)}×</span>${a.source_host ? `<span>${esc(a.source_host)}</span>` : ''}</div>
    </div>
    <div class="conf"><span class="bar ${conf < 80 ? 'low' : ''}"><i style="width:${conf}%"></i></span><span class="v tnum">${conf}</span></div>
    <div class="lock ${a.locked ? '' : 'open'}" title="${a.locked ? 'Locked — used verbatim, never overwritten' : 'Unlocked'}">${icon(a.locked ? 'lock' : 'unlock', 14)}</div>
  </div>`);
  n.addEventListener('click', () => openAnswerDrawer(a));
  return n;
}

async function openAnswerDrawer(a) {
  const node = el(`<div class="drawer">
    <div class="drawer-h">
      <div class="dt"><h3>${esc(a.label || humanize(a.key_norm || 'Answer'))}</h3><div class="dc">${provBadge(a.provenance)} <span style="margin-left:8px">${esc(answerKindLabel(a.kind))}</span></div></div>
      <button class="drawer-x" aria-label="Close">${icon('close', 16)}</button>
    </div>
    <div class="drawer-body">
      <div class="drawer-sec">Stored value</div>
      <div class="ans-value" id="ans-value">${loadingRow('Loading the full value…')}</div>
      <div class="drawer-sec">Provenance</div>
      <div class="kv-rows" id="ans-meta"></div>
    </div>
  </div>`);
  const close = openOverlay(node);
  node.querySelector('.drawer-x').addEventListener('click', close);

  const paintMeta = (full) => {
    const kv = (k, v) => (v ? `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>` : '');
    $('#ans-meta', node).innerHTML =
      kv('Learned from', full.provenance ? esc(provenanceLabel(full.provenance)) : '') +
      kv('Kind', esc(answerKindLabel(full.kind))) +
      kv('Field type', full.field_type ? esc(humanize(full.field_type)) : '') +
      kv('Confidence', `${Math.round((full.confidence || 0) * 100)}%`) +
      kv('Seen / used', `${num(full.seen_count || 0)}× / ${num(full.used_count || 0)}×`) +
      kv('Last used', full.last_used_at ? esc(fmtAgo(full.last_used_at)) + ' ago' : '') +
      kv('Source site', full.source_host ? esc(full.source_host) : '') +
      kv('Locked', full.locked ? 'Yes — used verbatim' : 'No') +
      kv('Learned', full.created_at ? esc(fmtDateTime(full.created_at)) : '') +
      kv('Updated', full.updated_at ? esc(fmtDateTime(full.updated_at)) : '');
  };
  paintMeta(a);

  try {
    const full = await api(`/answers/${encodeURIComponent(a.id)}`);
    const box = $('#ans-value', node); if (!box) return;
    let options = [];
    try { options = full?.options_json ? JSON.parse(full.options_json) : (full?.options || []); } catch { options = []; }
    box.textContent = full?.value ?? '';
    if (!full?.value) box.innerHTML = '<span class="dim-note">No stored value — this entry records the field shape only.</span>';
    if (Array.isArray(options) && options.length) {
      box.insertAdjacentHTML('afterend', `<div class="ans-opts"><div class="drawer-sec">Known options</div>${options.slice(0, 24).map((o) => `<span class="prov">${esc(typeof o === 'string' ? o : (o?.label ?? o?.value ?? ''))}</span>`).join(' ')}</div>`);
    }
    paintMeta(full || a);
  } catch (e) {
    const box = $('#ans-value', node);
    if (box) box.innerHTML = `<span class="dim-note">Could not load the value — ${esc(e?.message || 'unknown error')}</span>`;
  }
}
