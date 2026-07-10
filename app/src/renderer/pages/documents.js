// Documents — library + generated docs (01-ARCHITECTURE §5, You). Stage-0 stub:
// the library arrives at Stage 1; the Generated tab (AI tailoring) at Stage 4.
import { el, pageHead, stubCard } from '../lib/dom.js';

export default function render(view, ctx) {
  view.appendChild(el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    ${stubCard({
      stage: 1,
      stageLabel: 'Generated tab arrives at Stage 4',
      glyph: 'doc',
      title: 'Your papers — and every tailored copy, inspectable',
      lead: 'The résumés and cover letters you keep, plus a full record of every version the AI ever generated on your behalf.',
      points: [
        '<b>Library</b> — all 77 docs with role badges and default flags, styled upload, working download',
        '<b>Generated tab</b> — every AI-tailored résumé and cover letter, stored with derived-from and application links',
        '<b>Diff vs master</b> — see exactly what was rephrased or reordered; nothing invented',
        '<b>Guardrail status</b> — a violation parks the doc for your review instead of attaching it',
      ],
      note: 'The rephrase-only guardrail is enforced twice: in the prompt AND in a post-check against a fact whitelist from your profile + master résumé (guardrail_hash on every generated doc).',
    })}
  </div>`));
}
