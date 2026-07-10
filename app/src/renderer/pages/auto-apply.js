// Auto-Apply — mission control (01-ARCHITECTURE §5, Operate). Stage-0 stub:
// the full page arrives with Stage 3; the first single-run "Apply now" at Stage 2.
import { el, pageHead, stubCard } from '../lib/dom.js';

export default function render(view, ctx) {
  view.appendChild(el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    ${stubCard({
      stage: 3,
      stageLabel: 'First single-run “Apply now” lands at Stage 2',
      glyph: 'bolt',
      title: 'Mission control for the apply engine',
      lead: 'One page to run the whole machine: start it, watch it think, and always know — honestly — why anything did not submit.',
      points: [
        '<b>Start / stop supervised</b> runs, plus the unattended toggle with optional idle auto-start (Stage 6)',
        '<b>Live run theater</b> — a per-run transcript and “what the robot sees” while it fills',
        '<b>Fit-ordered queue</b> with the skip floor visible — every skipped job shows its reason',
        '<b>Honest-rate panel</b> — per-lane submitted / parked / failed / skipped, each with the WHY',
        '<b>Discovery strip</b> — per-source yield, freshness and saturation at a glance',
        '<b>Caps &amp; pacing controls</b> — serial drive, one foreground token: the freeze class stays dead',
      ],
      note: 'All three lanes in the first build: LinkedIn Easy Apply · Indeed · Greenhouse / Lever / Ashby. LinkedIn cap 45/24h · ~30/hr supervised serial.',
    })}
  </div>`));
}
