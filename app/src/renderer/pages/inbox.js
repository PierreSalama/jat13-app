// Inbox — matched employer email (01-ARCHITECTURE §5, Track). Stage-0 stub:
// read-only imported mail at Stage 1; live Gmail sync at Stage 5.
import { el, pageHead, stubCard } from '../lib/dom.js';

export default function render(view, ctx) {
  view.appendChild(el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    ${stubCard({
      stage: 1,
      stageLabel: 'Live Gmail sync arrives at Stage 5',
      glyph: 'inbox',
      title: 'The mail that moves your pipeline',
      lead: 'Employer email, matched to its application and classified into plain words — so a rejection, an assessment or an interview never sits unread in a tab you forgot.',
      points: [
        '<b>Matched employer email</b> — each message linked to its application and thread',
        '<b>Category chips in human labels</b> — Confirmation, Interview, Assessment, Rejection, Offer, Recruiter',
        '<b>Suggestion review</b> — uncertain matches wait for your yes/no instead of guessing',
        '<b>Reprocess</b> — reclassify any message after a rule improves',
      ],
      note: 'Stage 1 shows your 497 imported emails read-only. Stage 5 connects Gmail with the BROAD query (the v11.48 sender-restriction scar stays fixed) and moves statuses forward-only.',
    })}
  </div>`));
}
