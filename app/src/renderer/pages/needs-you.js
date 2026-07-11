// Needs You — the human queue (01-ARCHITECTURE §5, Operate). Stage 2: the parked
// runs the engine could NOT resolve on its own. Each parked run renders its REAL
// pending question(s) as an answer form (text / select / radio per question kind);
// submitting saves to learned memory and re-queues the run (answer → learn →
// requeue, asked once ever). Walls (captcha / sign-in / résumé) can't be answered
// from here — they render an "open the tab" hint. Reviews (quarantined submits)
// usually mean already-submitted, so they show the posting, not a form.
//
// Contract (integrator wires these):
//   GET  /api/needs-you  → ok({ needsHuman:[run…], readyForReview:[run…] })
//        each run ENRICHED with: park_kind, park_detail, questions[], job_title, company
//        questions[] items: string OR { question|label, keyNorm, kind, options[] }
//   POST /api/answers { runId, question, keyNorm, value }  → ok({…}) — saves + requeues
import { el, $, esc, icon, num, fmtAgo, pageHead, toast, errToast } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { parkLabel, WALL_PARK, srcTagText, humanize, runStateLabel } from '../lib/vocab.js';
import { ensureJob, jobKnown, primeJob } from './applications.js';

const loadingRow = (t = 'Loading…') => `<div class="loading-row"><span class="spinner"></span>${esc(t)}</div>`;
const RENDER_CAP = 30; // the queue is small by design; cap the DOM and show "N more"

/** Normalize a pending question (string OR object) to one shape the form understands. */
function normQ(q) {
  if (q == null) return null;
  if (typeof q === 'string') return { question: q || '(unlabeled question)', keyNorm: '', kind: 'text', options: [] };
  const question = q.question || q.label || q.prompt || q.text || '(unlabeled question)';
  const keyNorm = q.keyNorm || q.key_norm || q.key || '';
  const raw = String(q.kind || q.fieldType || q.field_type || q.type || 'text').toLowerCase();
  const kind = raw === 'select' ? 'select'
    : (raw === 'radio' || raw === 'checkbox') ? 'radio'
      : raw === 'textarea' ? 'textarea'
        : raw === 'number' ? 'number'
          : raw === 'date' ? 'date' : 'text';
  const options = Array.isArray(q.options)
    ? q.options.map((o) => (typeof o === 'string' ? o : (o?.label || o?.value || String(o)))).filter(Boolean)
    : [];
  return { question, keyNorm, kind, options };
}

export default function render(view, ctx) {
  const pad = el(`<div class="view-pad">
    ${pageHead('Needs You', { sub: ctx.meta.sub })}
    <div class="card col-flex hoverable">
      <div class="card-h"><span class="cap">Queue</span><span class="nav-badge" id="needs-n"></span><div class="spacer"></div>
        <button class="btn sm" id="needs-refresh">${icon('refresh', 13)} Refresh</button></div>
      <div id="needs-list">${loadingRow('Reading the queue…')}</div>
    </div>
  </div>`);
  view.appendChild(pad);

  const listBox = $('#needs-list', pad);
  const countBadge = $('#needs-n', pad);
  $('#needs-refresh', pad).addEventListener('click', () => refresh());

  async function refresh() {
    let human = []; let review = [];
    try {
      const d = await api('/needs-you', { signal: ctx.signal });
      human = d?.needsHuman || d?.needs_human || [];
      review = d?.readyForReview || d?.ready_for_review || [];
    } catch (e) {
      if (e?.aborted) return;
      if (!listBox.querySelector('.need-item')) listBox.innerHTML = `<div class="empty">Could not read the queue — ${esc(e?.message || 'unknown error')}. Retrying…</div>`;
      return;
    }
    const all = [...human, ...review];
    all.forEach((r) => { if (r.job_id && (r.job_title || r.title)) primeJob(r.job_id, { title: r.job_title || r.title, company: r.company || '' }); });
    countBadge.textContent = all.length ? String(all.length) : '';

    // Never wipe an answer the user is mid-way through typing: if focus is inside a form field
    // in this list, skip the DOM rebuild this tick (the count still updated above).
    const ae = document.activeElement;
    if (ae && listBox.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;

    if (!all.length) {
      listBox.innerHTML = `<div class="empty">The queue is clear — nothing needs you. Every answer you give here means one less question next time.</div>`;
      return;
    }
    const shown = all.slice(0, RENDER_CAP);
    listBox.innerHTML = '';
    shown.forEach((r) => listBox.appendChild(buildItem(r, refresh, ctx)));
    if (all.length > shown.length) {
      listBox.appendChild(el(`<div class="card-foot"><span>${num(all.length - shown.length)} more waiting — clear these first (the standing hygiene rule)</span></div>`));
    }
  }

  ctx.poll(5000, refresh);
}

// ---------------------------------------------------------------------------
// one queue item — an answer form, a wall hint, or a review card
// ---------------------------------------------------------------------------
function buildItem(run, refresh, ctx) {
  const isReview = run.state === 'ready_for_review';
  const questions = (run.questions || run.pending_questions || []).map(normQ).filter(Boolean);
  const answerable = !isReview && (questions.length > 0 || run.park_kind === 'needs_answer');
  const wall = !isReview && !answerable && WALL_PARK.has(run.park_kind);
  const kindLabel = isReview ? runStateLabel('ready_for_review') : parkLabel(run.park_kind);
  const glyph = answerable ? 'question' : isReview ? 'check' : 'shield';
  const glyphCls = answerable ? '' : 'c';

  const item = el(`<div class="need-item" data-run="${esc(run.id)}">
    <div class="need-head">
      <div class="glyph ${glyphCls}">${icon(glyph, 17)}</div>
      <div class="need-b">
        <div class="need-t" data-jt="${esc(run.job_id || '')}">${run.job_id && jobKnown(run.job_id) ? jobTitle(run.job_id) : esc(run.job_title || 'Loading role…')}</div>
        <div class="need-s">${esc(kindLabel)} · ${esc(srcTagText(run.source))}${run.park_detail ? ` · ${esc(String(run.park_detail).slice(0, 70))}` : ''}</div>
      </div>
      <span class="age">${fmtAgo(run.updated_at)}</span>
    </div>
  </div>`);

  if (answerable) item.appendChild(buildAnswerForm(run, questions, refresh));
  else if (isReview) item.appendChild(reviewHint(run));
  else if (wall) item.appendChild(wallHint(run));
  else item.appendChild(genericHint(run));

  // resolve the job once (title + the "open the tab" link both need it); patch in place on arrival.
  if (run.job_id && !jobKnown(run.job_id)) {
    ensureJob(run.job_id, () => {
      const t = $(`.need-t[data-jt="${CSS.escape(run.job_id)}"]`, item); if (t) t.innerHTML = jobTitle(run.job_id);
      const slot = $('.need-open-slot', item); if (slot) slot.outerHTML = openPostingBtn(run);
    });
  }
  return item;
}

function jobTitle(jobId) {
  const j = jobKnown(jobId);
  if (!j) return 'Role';
  return `${esc(j.title)}${j.company ? ` <span>— ${esc(j.company)}</span>` : ''}`;
}

// ---------------------------------------------------------------------------
// the answer form — one field per pending question, kind-aware
// ---------------------------------------------------------------------------
function fieldHtml(q, id) {
  if (q.kind === 'select') {
    return `<select class="inp" id="${id}"><option value="">Choose…</option>${q.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`;
  }
  if (q.kind === 'radio' && q.options.length) {
    return `<div class="need-radios" data-radio="${id}">${q.options.map((o) => `<label class="need-radio"><input type="radio" name="${id}" value="${esc(o)}"><span>${esc(o)}</span></label>`).join('')}</div>`;
  }
  if (q.kind === 'textarea') return `<textarea class="inp" id="${id}" placeholder="Your answer"></textarea>`;
  const type = q.kind === 'number' ? 'number' : q.kind === 'date' ? 'date' : 'text';
  return `<input class="inp" id="${id}" type="${type}" placeholder="Your answer — saved to memory, asked once ever">`;
}

function readValue(form, q, id) {
  if (q.kind === 'radio' && q.options.length) {
    const picked = form.querySelector(`[data-radio="${id}"] input:checked`);
    return picked ? picked.value : '';
  }
  const field = form.querySelector(`#${CSS.escape(id)}`);
  return field ? String(field.value || '').trim() : '';
}

function buildAnswerForm(run, questions, refresh) {
  const qs = questions.length ? questions : [{ question: '', keyNorm: '', kind: 'text', options: [] }];
  const form = el(`<div class="answer-form">
    <div class="ctx">${qs.length === 1 && !qs[0].question
      ? 'The engine parked this run for a human answer, but did not capture the question text — describe it below.'
      : `Answer ${qs.length === 1 ? 'this question' : `these ${qs.length} questions`} and the run re-queues automatically.`}</div>
    ${qs.map((q, i) => {
      const id = `ans-${run.id}-${i}`;
      const label = q.question || 'Question / field label';
      return `<div class="need-q">
        <label class="field-label" for="${id}">${esc(label)}</label>
        ${!q.question ? `<input class="inp need-qlabel" id="${id}-label" placeholder="What did the form ask? (e.g. Years of React experience)">` : ''}
        ${fieldHtml(q, id)}
      </div>`;
    }).join('')}
    <div class="need-actions">
      <button class="btn sm need-cancel">Not now</button>
      <button class="btn sm primary need-save">${icon('check', 13)} Answer &amp; resume</button>
    </div>
  </div>`);

  form.querySelector('.need-cancel').addEventListener('click', () => form.remove());
  const saveBtn = form.querySelector('.need-save');
  saveBtn.addEventListener('click', async () => {
    const payloads = [];
    qs.forEach((q, i) => {
      const id = `ans-${run.id}-${i}`;
      const value = readValue(form, q, id);
      if (!value) return;
      let question = q.question;
      if (!question) { const lf = form.querySelector(`#${id}-label`); question = lf ? String(lf.value || '').trim() : ''; }
      if (!question) return; // a value with no question we can save is not a learnable answer
      payloads.push({ runId: run.id, question, keyNorm: q.keyNorm || '', value });
    });
    if (!payloads.length) { toast('Fill in at least one answer (with its question)', 'danger', 3500); return; }
    saveBtn.disabled = true;
    try {
      let saved = 0;
      for (const body of payloads) {
        const res = await api('/answers', { method: 'POST', body });
        if (res?.saved) saved += 1;
      }
      if (saved === 0) {
        // every answer was DROPPED as a protected/EEO field — never stored, by design.
        saveBtn.disabled = false;
        toast('Those look like protected fields — the engine never stores them. Clear this in the browser.', 'danger', 6000);
        return;
      }
      toast(`${saved === 1 ? 'Answered' : `Answered ${saved} questions`} — run re-queued`, 'success', 3000);
      const item = form.closest('.need-item'); if (item) item.remove();
      refresh();
    } catch (e) { saveBtn.disabled = false; errToast(e, 'Answer'); }
  });
  return form;
}

// ---------------------------------------------------------------------------
// non-answerable outcomes — walls, reviews, generic
// ---------------------------------------------------------------------------
function openPostingBtn(run) {
  const j = run.job_id ? jobKnown(run.job_id) : null;
  const url = j?.job_url || '';
  // a stable slot so buildItem can swap in the real button when the job resolves.
  if (!url) return `<span class="need-open-slot need-hint-note">Opening the posting… (finish this in the browser)</span>`;
  return `<a class="btn sm need-open-slot" href="${esc(url)}" target="_blank" rel="noreferrer">${icon('external', 13)} Open the tab</a>`;
}

function wallHint(run) {
  const kind = parkLabel(run.park_kind);
  const why = run.park_kind === 'resume_required'
    ? 'This form needs a résumé attached that the engine could not supply.'
    : `This is a ${esc(kind.toLowerCase())} — it can only be cleared by you, in the browser. The engine will never auto-solve it.`;
  return el(`<div class="need-hint wall">
    <div class="need-hint-b">${why}</div>
    <div class="need-hint-a">${run.park_kind === 'resume_required' ? `<a class="btn sm" href="#/documents">${icon('doc', 13)} Documents</a>` : ''}${openPostingBtn(run)}</div>
  </div>`);
}

function reviewHint(run) {
  return el(`<div class="need-hint">
    <div class="need-hint-b">Quarantined for review — this usually means it was already submitted but the engine could not prove it with trustworthy evidence. Check the posting; if it's done, no action is needed.</div>
    <div class="need-hint-a">${openPostingBtn(run)}</div>
  </div>`);
}

function genericHint(run) {
  return el(`<div class="need-hint">
    <div class="need-hint-b">${esc(run.park_detail || humanize(run.park_kind || 'needs attention'))} — resolve it in the browser, then it can resume.</div>
    <div class="need-hint-a">${openPostingBtn(run)}</div>
  </div>`);
}
