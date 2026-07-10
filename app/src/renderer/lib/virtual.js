// JAT 13 — lib/virtual.js: THE virtualized-list helper. Renderer rule
// (01-ARCHITECTURE §5): any list that can exceed 200 rows renders through this,
// so 4,500 applications scroll like 40. Ported from the proven 13.0.x
// applications virtualization (window + sizer + page cache), generalized so
// every Stage-1 page shares one implementation instead of five copies.
//
// Two data modes:
//   paged — pass fetchPage(offset, limit) → {rows, total}. Pages load on demand
//           as the user scrolls; in-flight requests dedupe; total drives the
//           scrollbar. This is the applications-table mode.
//   fixed — call setRows(array) with an already-loaded list (search results,
//           a filtered ledger). Only the visible window ever hits the DOM.
//
// The helper owns: the sizer, absolute row positioning (.vitem), rAF-coalesced
// window renders, the page cache, and status/error callbacks. Pages own row
// markup (renderRow) and all data semantics — no vocab, no fetch shapes here.
import { el } from './dom.js';

export function createVirtualList({
  viewport, // the scrolling element — give it the .vlist class + a height
  rowHeight, // fixed px per row (virtualization requires uniform heights)
  renderRow, // (item, index) => Element — WITHOUT positioning; helper places it
  renderPlaceholder, // optional (index) => Element for rows not yet loaded
  fetchPage, // optional async (offset, limit) => {rows, total} — paged mode
  pageSize = 120,
  overscan = 6, // extra rows rendered above/below the window
  onStatus, // optional ({total, loaded, mode}) — fires on every data change
  onError, // optional (err) — load failures surface to the page, never swallowed
} = {}) {
  const sizer = el('<div class="vlist-sizer"></div>');
  viewport.appendChild(sizer);

  const pages = new Map(); // pageIndex -> rows[]
  const pending = new Set(); // pageIndex in flight
  let total = 0;
  let fixedRows = null; // non-null = fixed mode
  let rafPending = false;
  let destroyed = false;

  const mode = () => (fixedRows ? 'fixed' : 'paged');
  const count = () => (fixedRows ? fixedRows.length : total);
  const loadedCount = () =>
    fixedRows ? fixedRows.length : [...pages.values()].reduce((n, a) => n + a.length, 0);

  function emitStatus() { onStatus?.({ total: count(), loaded: loadedCount(), mode: mode() }); }
  function setSizer() { sizer.style.height = `${count() * rowHeight}px`; }

  function rowAt(i) {
    if (fixedRows) return fixedRows[i];
    const p = pages.get(Math.floor(i / pageSize));
    return p ? p[i % pageSize] : undefined;
  }

  async function loadPage(pi) {
    if (!fetchPage || destroyed || pages.has(pi) || pending.has(pi)) return;
    pending.add(pi);
    try {
      const d = await fetchPage(pi * pageSize, pageSize);
      if (destroyed) return;
      pages.set(pi, Array.isArray(d?.rows) ? d.rows : []);
      if (typeof d?.total === 'number') total = d.total;
      setSizer();
      schedule();
      emitStatus();
    } catch (e) {
      if (!e?.aborted && !destroyed) onError?.(e);
    } finally {
      pending.delete(pi);
    }
  }

  const defaultPlaceholder = () =>
    el('<div class="vph"><span class="skelbar" style="width:42%"></span></div>');

  function schedule() {
    if (rafPending || destroyed) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; if (!destroyed) renderWindow(); });
  }

  function renderWindow() {
    const n = count();
    const first = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - overscan);
    const last = Math.min(n, Math.ceil((viewport.scrollTop + viewport.clientHeight) / rowHeight) + overscan);
    if (!fixedRows && fetchPage && n > 0) {
      const pFirst = Math.floor(first / pageSize);
      const pLast = Math.floor(Math.max(first, last - 1) / pageSize);
      for (let pi = pFirst; pi <= pLast; pi++) loadPage(pi);
    }
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const item = rowAt(i);
      const node = item !== undefined ? renderRow(item, i) : (renderPlaceholder || defaultPlaceholder)(i);
      node.classList.add('vitem');
      node.style.top = `${i * rowHeight}px`;
      node.style.height = `${rowHeight}px`;
      frag.appendChild(node);
    }
    sizer.querySelectorAll('.vitem').forEach((x) => x.remove());
    sizer.appendChild(frag);
  }

  /** Fixed mode: show exactly these rows (search results, filtered ledger). */
  function setRows(rows) {
    fixedRows = Array.isArray(rows) ? rows : [];
    viewport.scrollTop = Math.min(viewport.scrollTop, Math.max(0, fixedRows.length * rowHeight - viewport.clientHeight));
    setSizer(); schedule(); emitStatus();
  }
  /** Leave fixed mode, back to the paged cache (loaded pages survive). */
  function clearRows() { fixedRows = null; setSizer(); schedule(); emitStatus(); }
  /** Drop everything and refetch page 0 (filter changed server-side). */
  function reset() {
    pages.clear(); pending.clear(); total = 0; fixedRows = null;
    viewport.scrollTop = 0; setSizer(); schedule();
    if (fetchPage) loadPage(0);
  }
  /** Every row currently in memory, in order — the honest client-side search space. */
  function loadedRows() {
    if (fixedRows) return [...fixedRows];
    const out = [];
    [...pages.keys()].sort((a, b) => a - b).forEach((k) => out.push(...pages.get(k)));
    return out;
  }

  viewport.addEventListener('scroll', schedule, { passive: true });
  if (fetchPage) loadPage(0); else { setSizer(); schedule(); }

  return {
    schedule, // re-render the window (e.g. after a lazy cache fill patched data)
    reset, setRows, clearRows, rowAt, loadedRows,
    total: count, loaded: loadedCount, mode,
    destroy() { destroyed = true; sizer.remove(); },
  };
}
