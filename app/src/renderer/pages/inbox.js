// Inbox — matched employer email (Track). Stage 1 = the imported v11 mail,
// read-only: suggested matches waiting for review on top, the classified
// stream below with human category chips (vocab mailCatLabel — raw enums like
// APPLICATION_CONFIRMATION never reach the page). Live Gmail sync is Stage 5.
import { el, $, $$, esc, fmtAgo, num, pageHead } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { mailCatLabel, matchSourceLabel } from '../lib/vocab.js';

const loadingRow = (t = 'Loading…') => `<div class="loading-row"><span class="spinner"></span>${esc(t)}</div>`;
// schema categories (emails.category CHECK) — the seg renders them via vocab
const CATS = ['', 'application_confirmation', 'recruiter', 'assessment', 'interview', 'offer', 'rejection'];

export default function render(view, ctx) {
  const pad = el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    <div class="card col-flex">
      <div class="card-h"><span class="cap">Suggested matches</span><div class="spacer"></div><span class="aside" id="sugg-n">to review</span></div>
      <div id="sugg-list">${loadingRow()}</div>
    </div>
    <div class="card col-flex">
      <div class="card-h"><span class="cap">Recent emails</span><div class="spacer"></div><div class="seg scroll" id="inbox-cat"></div></div>
      <div id="mail-list">${loadingRow()}</div>
      <div class="card-foot" id="mail-foot"><span>Read-only in Stage 1 — live Gmail sync and reprocess arrive with Stage 5.</span></div>
    </div>
  </div>`);
  view.appendChild(pad);

  const seg = $('#inbox-cat', pad);
  seg.innerHTML = CATS.map((c, i) => `<span data-cat="${esc(c)}" class="${i === 0 ? 'on' : ''}">${c ? esc(mailCatLabel(c)) : 'All'}</span>`).join('');
  let category = '';
  seg.addEventListener('click', (e) => {
    const s = e.target.closest('span[data-cat]'); if (!s) return;
    $$('span', seg).forEach((x) => x.classList.remove('on'));
    s.classList.add('on');
    category = s.getAttribute('data-cat') || '';
    loadEmails(pad, ctx, category);
  });

  // suggestions refresh slowly; the mail stream re-reads on chip clicks + poll
  ctx.poll(30000, () => loadSuggestions(pad, ctx));
  ctx.poll(45000, () => loadEmails(pad, ctx, category), true);
}

async function loadSuggestions(pad, ctx) {
  const box = $('#sugg-list', pad); if (!box) return;
  try {
    const d = await api('/emails/suggestions', { signal: ctx.signal });
    const rows = d?.rows || [];
    const n = $('#sugg-n', pad); if (n) n.textContent = rows.length ? `${num(rows.length)} to review` : 'to review';
    box.innerHTML = rows.length
      ? rows.slice(0, 30).map((m) => mailRow(m, true)).join('')
      : '<div class="empty">No suggestions awaiting review.</div>';
  } catch (e) {
    if (e?.aborted) return;
    if (!box.querySelector('.mail')) box.innerHTML = `<div class="empty">Could not load suggestions — ${esc(e?.message || 'unknown error')}</div>`;
  }
}

async function loadEmails(pad, ctx, category) {
  const box = $('#mail-list', pad); if (!box) return;
  if (!box.querySelector('.mail')) box.innerHTML = loadingRow();
  try {
    const params = new URLSearchParams({ limit: '60' });
    if (category) params.set('category', category);
    const d = await api(`/emails?${params}`, { signal: ctx.signal });
    const rows = d?.rows || [];
    box.innerHTML = rows.length
      ? rows.map((m) => mailRow(m)).join('')
      : `<div class="empty">${category ? `No ${esc(mailCatLabel(category).toLowerCase())} emails on file.` : 'No emails on file yet — the Stage 1 import brings your v11 mail in.'}</div>`;
    const foot = $('#mail-foot', pad);
    if (foot) foot.innerHTML = `<span>${num(d?.total ?? rows.length)} email${(d?.total ?? rows.length) === 1 ? '' : 's'}${category ? ` · ${esc(mailCatLabel(category))}` : ''} · read-only until Stage 5</span>`;
  } catch (e) {
    if (e?.aborted) return;
    box.innerHTML = `<div class="empty">Could not load emails — ${esc(e?.message || 'unknown error')}</div>`;
  }
}

function mailRow(m, suggestion = false) {
  const conf = suggestion && typeof m.confidence === 'number' ? Math.round(m.confidence * 100) : null;
  return `<div class="mail">
    <span class="dot ${suggestion ? 'ember' : 'sage'} mdot"></span>
    <div class="mb">
      <div class="subj">${esc(m.subject || '(no subject)')}</div>
      <div class="from">${esc(m.from_name || m.from_addr || '')}</div>
      ${m.snippet ? `<div class="snip">${esc(m.snippet)}</div>` : ''}
    </div>
    ${suggestion ? `<span class="mcat">${esc(matchSourceLabel('suggested'))}${conf != null ? ` · ${conf}%` : ''}</span>` : ''}
    ${m.category ? `<span class="mcat">${esc(mailCatLabel(m.category))}</span>` : ''}
    <span class="mtime">${fmtAgo(m.sent_at || m.created_at)}</span>
  </div>`;
}
