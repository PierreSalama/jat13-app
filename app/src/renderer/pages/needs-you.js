// Needs You — the human queue (01-ARCHITECTURE §5, Operate). Stage-0 stub.
import { el, pageHead, stubCard } from '../lib/dom.js';

export default function render(view, ctx) {
  view.appendChild(el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    ${stubCard({
      stage: 3,
      glyph: 'bell',
      title: 'Everything that genuinely needs a human',
      lead: 'The engine parks instead of guessing. This queue is where those parks meet you — and where each answer makes the next one unnecessary.',
      points: [
        '<b>Real screening questions</b> — answer once; it saves to learned memory and the run auto-requeues',
        '<b>Walls</b> — CAPTCHA and sign-in parks open the exact tab so you can unblock in seconds',
        '<b>Review queue</b> — quarantined submits and guardrail-parked documents wait here, never auto-sent',
        '<b>Hygiene built in</b> — stale captcha/login parks auto-skip; awaiting-review usually means already submitted',
      ],
      note: 'Answer → learn → requeue is the loop: the same question is asked once, ever. Sensitive (EEO / credential) fields never appear here for auto-write — they stay yours.',
    })}
  </div>`));
}
