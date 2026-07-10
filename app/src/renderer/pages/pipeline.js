// Pipeline — the status board (01-ARCHITECTURE §5, Track). Stage-0 stub.
import { el, pageHead, stubCard } from '../lib/dom.js';

export default function render(view, ctx) {
  view.appendChild(el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    ${stubCard({
      stage: 1,
      glyph: 'board',
      title: 'Your search as a board, saved to hired',
      lead: 'Columns in human words, counts you can trust, and cards you can move when reality moves first.',
      points: [
        '<b>Status board in human labels</b> — Saved, Applied, Acknowledged, Assessment, Interview, Offer, Hired',
        '<b>Drag between stages</b> to correct reality; every move writes the timeline',
        '<b>Counts from ONE funnel source of truth</b> — board, table and Command Center always agree',
        '<b>Offer glow</b> — the cards that matter read differently',
      ],
      note: 'Populated by the Stage 1 import: your ~4,510 jobs and ~630 applications land in these columns with their true statuses.',
    })}
  </div>`));
}
