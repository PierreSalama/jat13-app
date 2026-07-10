// Documents — the library (You). Stage 1: every imported doc listed with role
// badge / default flag / size, working download, styled file-pick upload,
// set-default, and delete behind a two-step confirm. Bytes travel outside the
// JSON envelope (download stream / multipart upload), so those two calls use
// the api layer's raw mode when it exists, else an authed fetch fallback.
// The Generated tab (AI tailoring lineage + diffs) arrives at Stage 4.
import { el, $, $$, esc, icon, fmtDate, num, pageHead, toast, errToast } from '../lib/dom.js';
import * as apiMod from '../lib/api.js';
import { docRoleLabel, docSourceLabel, UPLOAD_DOC_ROLES } from '../lib/vocab.js';

const { api, apiBase, apiToken } = apiMod;
const loadingRow = (t = 'Loading…') => `<div class="loading-row"><span class="spinner"></span>${esc(t)}</div>`;

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Non-envelope traffic (blobs, multipart). Prefers an official api.js raw mode. */
async function rawFetch(path, init = {}) {
  if (typeof apiMod.apiRaw === 'function') return apiMod.apiRaw(path, init);
  const res = await fetch(apiBase() + '/api' + path, {
    ...init,
    headers: { 'X-JAT13-Token': apiToken(), ...(init.headers || {}) },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const b = await res.json(); msg = b?.error?.message || b?.error?.code || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res;
}

export default function render(view, ctx) {
  const pad = el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    <div class="card col-flex">
      <div class="card-h"><span class="cap">Library</span><div class="spacer"></div><span class="aside" id="doc-count">—</span></div>
      <div id="doc-list">${loadingRow()}</div>
      <div class="upload-zone">
        <label class="file-pick" for="doc-file">
          <span class="file-btn">${icon('upload', 13)} Choose file</span>
          <span class="file-name" id="doc-file-name">No file selected</span>
        </label>
        <input type="file" id="doc-file" hidden />
        <select class="inp" id="doc-role" style="max-width:180px">
          ${UPLOAD_DOC_ROLES.map((r) => `<option value="${esc(r)}">${esc(docRoleLabel(r))}</option>`).join('')}
        </select>
        <input class="inp" id="doc-label" placeholder="Label (optional)" style="max-width:220px" />
        <button class="btn primary" id="doc-upload">${icon('upload', 13)} Upload</button>
      </div>
    </div>
  </div>`);
  view.appendChild(pad);

  $('#doc-file', pad).addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    const n = $('#doc-file-name', pad);
    if (n) { n.textContent = f ? f.name : 'No file selected'; n.classList.toggle('has', !!f); }
  });
  $('#doc-upload', pad).addEventListener('click', () => upload(pad, ctx));
  load(pad, ctx);
}

async function load(pad, ctx) {
  const list = $('#doc-list', pad); if (!list) return;
  let rows = [];
  try {
    const d = await api('/documents', { signal: ctx.signal });
    rows = d?.rows || [];
  } catch (e) {
    if (e?.aborted) return;
    list.innerHTML = `<div class="empty">Could not load documents — ${esc(e?.message || 'unknown error')}</div>`;
    return;
  }
  const cnt = $('#doc-count', pad);
  if (cnt) cnt.textContent = `${num(rows.length)} file${rows.length === 1 ? '' : 's'}`;
  if (!rows.length) {
    list.innerHTML = '<div class="empty">No documents yet — upload a résumé below, or run the v11 import to bring your 77 in.</div>';
    return;
  }
  list.innerHTML = rows.map(docRow).join('');
  wire(list, pad, ctx);
}

function docRow(d) {
  return `<div class="doc-row">
    <div class="doc-ic">${icon('doc', 18)}</div>
    <div class="doc-b">
      <div class="n">${esc(d.name || 'Untitled document')}</div>
      <div class="m">
        <span class="rolebadge">${esc(docRoleLabel(d.role))}</span>
        ${d.is_default ? '<span class="defbadge">Default</span>' : ''}
        ${d.label ? `<span>${esc(d.label)}</span>` : ''}
        <span>${fmtBytes(d.size_bytes)}</span>
        ${d.mime ? `<span>${esc(d.mime)}</span>` : ''}
        <span>added ${fmtDate(d.created_at)}</span>
        ${d.source && d.source !== 'upload' ? `<span>${esc(docSourceLabel(d.source))}</span>` : ''}
        ${d.missing_file ? '<span style="color:var(--ember)">missing file</span>' : ''}
      </div>
    </div>
    <div class="doc-actions">
      <button class="btn sm" data-dl="${esc(d.id)}" data-name="${esc(d.name || 'document')}" title="Download">${icon('download', 13)}</button>
      ${d.is_default ? '' : `<button class="btn sm" data-def="${esc(d.id)}">Set default</button>`}
      <button class="btn sm danger" data-del="${esc(d.id)}" title="Delete">${icon('trash', 13)}</button>
    </div>
  </div>`;
}

function wire(list, pad, ctx) {
  $$('[data-dl]', list).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const res = await rawFetch(`/documents/${encodeURIComponent(b.getAttribute('data-dl'))}/download`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = b.getAttribute('data-name') || 'document';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { errToast(e, 'Download'); }
    finally { b.disabled = false; }
  }));
  $$('[data-def]', list).forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/documents/${encodeURIComponent(b.getAttribute('data-def'))}/default`, { method: 'POST' });
      toast('Set as default', 'success', 2000);
      load(pad, ctx);
    } catch (e) { errToast(e, 'Set default'); }
  }));
  // delete = two-step confirm on the button itself (no native dialogs)
  $$('[data-del]', list).forEach((b) => b.addEventListener('click', async () => {
    if (!b.classList.contains('confirming')) {
      b.classList.add('confirming');
      b.innerHTML = 'Delete?';
      setTimeout(() => { if (b.isConnected) { b.classList.remove('confirming'); b.innerHTML = icon('trash', 13); } }, 3500);
      return;
    }
    try {
      await api(`/documents/${encodeURIComponent(b.getAttribute('data-del'))}`, { method: 'DELETE' });
      toast('Deleted', 'info', 2000);
      load(pad, ctx);
    } catch (e) { errToast(e, 'Delete'); }
  }));
}

async function upload(pad, ctx) {
  const fileInput = $('#doc-file', pad);
  const file = fileInput?.files?.[0];
  if (!file) { toast('Choose a file first', 'danger', 3000); return; }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('role', $('#doc-role', pad).value);
  const label = $('#doc-label', pad).value.trim();
  if (label) fd.append('label', label);
  const btn = $('#doc-upload', pad);
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  try {
    await rawFetch('/documents', { method: 'POST', body: fd });
    toast('Uploaded', 'success', 2500);
    fileInput.value = '';
    $('#doc-label', pad).value = '';
    const n = $('#doc-file-name', pad);
    if (n) { n.textContent = 'No file selected'; n.classList.remove('has'); }
    await load(pad, ctx);
  } catch (e) { errToast(e, 'Upload'); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = `${icon('upload', 13)} Upload`; } }
}
