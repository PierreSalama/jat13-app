// Autopsies — ★ new in 13 (01-ARCHITECTURE §5, System). Stage-0 stub: the first
// autopsy card is written at Stage 2; pattern mining + self-healing at Stage 5.
import { el, pageHead, stubCard } from '../lib/dom.js';

export default function render(view, ctx) {
  view.appendChild(el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    ${stubCard({
      stage: 5,
      stageLabel: 'First autopsy card lands at Stage 2',
      isNew: true,
      glyph: 'autopsy',
      title: 'Every failure explains itself — then proposes its own fix',
      lead: 'No more silent losses: every terminal run writes a readable post-mortem, recurring failures cluster into patterns, and each pattern arrives with a remedy you can apply in one click.',
      points: [
        '<b>A post-mortem for every terminal run</b> — what happened, where it stopped, the blocking control, a page-snapshot reference',
        '<b>Pattern groups</b> — “same failure ×N” clustered by signature, ranked by what they cost you',
        '<b>Proposed fixes in plain language</b> — an adapter patch, a new learned answer, or a setting change',
        '<b>One-click apply</b> — accepting a proposal edits adapter data or memory: self-healing, with you at the gate',
      ],
      note: 'New in 13. Fully automatic apply stays on the backlog until the loop earns trust: proposal → your approval → measured recurrence drop.',
    })}
  </div>`));
}
