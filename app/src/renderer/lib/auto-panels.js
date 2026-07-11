// Auto-Apply mission-control panels (Stage 3) — the caps/pacing rings, the fit-ordered queue with
// its skip-floor reasons, the honest-rate breakdown, and the per-source discovery strip. Split out of
// pages/auto-apply.js so that page stays under the 400-line renderer gate. Pure render functions:
// they take the polled payloads (/auto/state, /auto/queue, /discovery/status) and return HTML strings
// built from EXISTING themed atoms (dot colours, .bar, .pill, .src-tag, .sbadge, .aa-see-row, .dim) +
// inline layout only — no new CSS, all labels via vocab.js.
import { esc, num, fmtAgo } from './dom.js';
import {
  laneLabel, boardLabel, skipReasonLabel, breakerLabel, srcTagText, discoveryKindLabel,
} from './vocab.js';

const pct = (n, d) => (d > 0 ? Math.max(0, Math.min(100, Math.round((n / d) * 100))) : 0);
const fitDot = (f) => (f == null ? 'dim' : f >= 70 ? 'gold' : f >= 45 ? 'sage' : f >= 25 ? 'bronze' : 'ember');
const fitChip = (f) => `<span class="sbadge" title="fit score"><span class="dot ${fitDot(f)}"></span>${f == null ? '—' : num(f)}</span>`;
const srcTag = (s) => `<span class="src-tag" title="${esc(s || '')}">${esc(srcTagText(s))}</span>`;

// ---------------------------------------------------------------------------
// caps + pacing — one card per lane vs its rolling-24h cap (apply_ledger is the authority)
// ---------------------------------------------------------------------------
export function capsPanel(state) {
  const lanes = state?.lanes || [];
  if (!lanes.length) return `<div class="empty" style="padding:16px">No lanes yet — start auto-apply to see pacing.</div>`;
  return `<div style="display:flex;flex-direction:column;gap:12px">${lanes.map((l) => {
    const cap = l.cap == null ? null : Number(l.cap);
    const done = Number(l.submittedToday || 0);
    const breaker = l.breaker || (l.pausedUntil ? 'paused' : '');
    const dot = breaker ? 'danger' : (l.inflight > 0 ? 'live' : (done > 0 ? 'bronze' : 'dim'));
    const capStr = cap == null ? `<span class="dim">no cap</span>` : `<span class="dim">/ ${num(cap)}</span>`;
    return `<div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="dot ${dot}"></span><b>${esc(laneLabel(l.lane))}</b>
        <div style="flex:1"></div>
        ${breaker ? `<span class="pill off" title="lane paused">${esc(breakerLabel(breaker))}</span>` : ''}
        <span class="tnum"><b>${num(done)}</b> ${capStr}</span>
      </div>
      ${cap == null ? '' : `<div class="aa-bar" style="margin-top:6px"><i style="width:${pct(done, cap)}%"></i></div>`}
      <div class="aa-run-sub" style="margin-top:5px">
        <span>${num(l.queued || 0)} queued</span> · <span>${num(l.inflight || 0)} in flight</span>${l.capRemaining != null ? ` · <span>${num(l.capRemaining)} left of ${num(cap)}/24h</span>` : ''}${l.needsYou ? ` · <span class="ember">${num(l.needsYou)} needs you</span>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// the fit-ordered queue + the skip-floor decisions (every skip shown with its reason)
// ---------------------------------------------------------------------------
export function queuePanel(queue) {
  const upcoming = queue?.upcoming || [];
  const skipped = queue?.skipped || [];
  const up = upcoming.length
    ? upcoming.slice(0, 40).map((q) => `<div class="aa-q-row" style="display:flex;align-items:center;gap:9px;padding:7px 2px;border-bottom:1px solid var(--hair,rgba(255,255,255,.05))">
        ${fitChip(q.fit)}
        <div style="min-width:0;flex:1">
          <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(q.title || 'Untitled role')}${q.company ? ` <span class="dim">— ${esc(q.company)}</span>` : ''}</div>
          ${q.reasons && q.reasons.length ? `<div class="dim" style="font-size:.82em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(q.reasons.slice(0, 3).join(' · '))}</div>` : ''}
        </div>
        ${srcTag(q.source)} <span class="dim" style="font-size:.82em">${esc(laneLabel(q.lane))}</span>
      </div>`).join('')
    : `<div class="empty" style="padding:14px">Nothing queued right now. Discovery + the pump keep this fed while auto-apply runs.</div>`;

  const skip = skipped.length
    ? `<div class="aa-trail-h" style="margin-top:12px">Held back by the skip floor</div>${skipped.slice(0, 20).map((s) => `<div style="display:flex;align-items:center;gap:9px;padding:5px 2px;opacity:.72">
        ${fitChip(s.fit)}
        <div style="min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.title || 'Untitled role')}${s.company ? ` <span class="dim">— ${esc(s.company)}</span>` : ''}</div>
        <span class="pill off" title="${s.floor != null ? `floor ${esc(String(s.floor))}` : ''}">${esc(skipReasonLabel(s.reason))}</span>
      </div>`).join('')}`
    : '';

  return `<div class="aa-see-row" style="justify-content:space-between"><span class="cap">Up next</span><span class="dim">${num(upcoming.length)} queued${skipped.length ? ` · ${num(skipped.length)} skipped` : ''}</span></div>${up}${skip}`;
}

// ---------------------------------------------------------------------------
// the honest-rate panel — per-lane submitted / parked / failed / skipped (with WHY, at a glance)
// ---------------------------------------------------------------------------
export function honestRatePanel(state) {
  const lanes = state?.lanes || [];
  if (!lanes.length) return `<div class="empty" style="padding:14px">Outcomes appear here once runs finish.</div>`;
  const cell = (dot, n, label) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px"><span class="dot ${dot}"></span><b>${num(n || 0)}</b> <span class="dim">${label}</span></span>`;
  return lanes.map((l) => `<div class="aa-see-row">
    <span class="k">${esc(laneLabel(l.lane))}</span>
    <span class="v" style="text-align:left">
      ${cell('bronze', l.submittedToday, 'applied')}
      ${cell('ember', l.parkedToday, 'parked')}
      ${cell('danger', l.failedToday, 'failed')}
      ${cell('dim', l.skippedToday, 'skipped')}
    </span>
  </div>`).join('') + `<div class="aa-run-sub" style="margin-top:8px">Applied = trustworthy submit evidence only. Parked = waiting on you or a wall. Skipped = below fit floor / unsupported / duplicate.</div>`;
}

// ---------------------------------------------------------------------------
// the discovery strip — per source: yield, freshness tier, saturation, breaker, last tick
// ---------------------------------------------------------------------------
export function discoveryStrip(status) {
  const sources = status?.sources || [];
  if (!sources.length) return `<div class="empty" style="padding:14px">Discovery has not reported yet.</div>`;
  const head = `<div class="aa-see-row" style="justify-content:space-between"><span class="cap">Discovery</span><span class="dim">${status?.enabled === false ? 'disabled' : `${num(sources.length)} sources`}</span></div>`;
  return head + sources.map((s) => {
    const breaker = s.breaker || (s.cooldownUntil && s.cooldownUntil > Date.now() ? 'cooldown' : '');
    const dot = s.enabled === false ? 'dim' : breaker ? 'ember' : (s.yield > 0 ? 'sage' : 'dim');
    const sat = s.saturation == null ? '' : ` · ${Math.round(Number(s.saturation) * 100)}% sat`;
    const fresh = s.freshnessHours == null ? '' : ` · ${num(s.freshnessHours)}h window`;
    const bits = [
      `${num(s.yield || 0)} found`,
      s.kind ? discoveryKindLabel(s.kind) : '',
    ].filter(Boolean).join(' · ');
    return `<div class="aa-see-row">
      <span class="k"><span class="dot ${dot}"></span>${esc(boardLabel(s.board))}</span>
      <span class="v" style="text-align:left">${esc(bits)}${esc(fresh)}${esc(sat)}${breaker ? ` · <span class="ember">${esc(breakerLabel(breaker))}</span>` : ''}${s.lastTickAt ? ` · <span class="dim">${fmtAgo(s.lastTickAt)}</span>` : ''}</span>
    </div>`;
  }).join('');
}
