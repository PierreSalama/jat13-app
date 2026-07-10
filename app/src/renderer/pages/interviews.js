// Interviews — ★ new in 13 (01-ARCHITECTURE §5, Track). Stage-0 stub.
import { el, pageHead, stubCard } from '../lib/dom.js';

export default function render(view, ctx) {
  view.appendChild(el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    ${stubCard({
      stage: 5,
      isNew: true,
      glyph: 'calendar',
      title: 'Walk into every call already prepared',
      lead: 'The moment an interview email lands, it becomes an entry here — with a brief worth reading five minutes before you join.',
      points: [
        '<b>Every detected interview</b> — stage, company, and date when known',
        '<b>AI brief per interview</b> — company research, role recap, and your matching stories pulled from learned memory',
        '<b>Prep checklist</b> — what to reread, what to ask, what they asked last time',
        '<b>Fed by the Inbox classifier</b> — detection is automatic; nothing to file by hand',
      ],
      note: 'New in 13 — designed in from day one, not bolted on. Calendar integration stays on the backlog (00-MASTER-PLAN §12).',
    })}
  </div>`));
}
