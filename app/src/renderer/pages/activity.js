// Activity — the append-only ledger (01-ARCHITECTURE §5, System). Stage-0 stub.
import { el, pageHead, stubCard } from '../lib/dom.js';

export default function render(view, ctx) {
  view.appendChild(el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    ${stubCard({
      stage: 1,
      glyph: 'activity',
      title: 'If it happened, it is written here',
      lead: 'An append-only record of everything the app did — found, applied, parked, matched, moved — in one scrolling ledger you can filter.',
      points: [
        '<b>Append-only ledger</b> — every event, newest first, nothing editable after the fact',
        '<b>Kind filters</b> — applied, status change, parked, email matched, document, imported, tailored…',
        '<b>Human vocabulary</b> — one label map (lib/vocab.js); raw enum ids never reach this page',
        '<b>Your v11 history included</b> — the import carries event kinds and timestamps faithfully',
      ],
      note: 'The ledger is the timeline source of truth: application drawers and the Command Center stream read from here, not from private state.',
    })}
  </div>`));
}
