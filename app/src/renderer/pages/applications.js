// Applications — the full virtualized table (01-ARCHITECTURE §5, Track). Stage-0 stub.
import { el, pageHead, stubCard } from '../lib/dom.js';

export default function render(view, ctx) {
  view.appendChild(el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    ${stubCard({
      stage: 1,
      glyph: 'layers',
      title: 'Every application on file, one click deep',
      lead: 'The working table of your entire search — fast at thousands of rows, honest about what happened to each one.',
      points: [
        '<b>Virtualized table</b> — 4,500+ rows scroll without a stutter (any list that can exceed 200 rows virtualizes)',
        '<b>Filters</b> — status, source, fit score, date',
        '<b>Detail drawer</b> per row — full timeline, run history, matched emails',
        '<b>Generated docs &amp; autopsy links</b> — what was sent and why it ended, right in the drawer (Stages 4–5)',
      ],
      note: 'Import fidelity is a Stage 1 gate: status, source, events and timestamps must match your v11 reality — verified against the real jat.db, never synthetic fixtures.',
    })}
  </div>`));
}
