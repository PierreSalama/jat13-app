// Profile — identity + learned memory (01-ARCHITECTURE §5, You). Stage-0 stub.
import { el, pageHead, stubCard } from '../lib/dom.js';

export default function render(view, ctx) {
  view.appendChild(el(`<div class="view-pad">
    ${pageHead(ctx.meta.label, { sub: ctx.meta.sub })}
    ${stubCard({
      stage: 1,
      glyph: 'user',
      title: 'You, as the engine knows you',
      lead: 'One place for who you are and everything the machine has learned about answering as you — searchable, editable, and always under your control.',
      points: [
        '<b>Identity + 29 seed fields</b> — work authorization, salary target, notice period: the answers every form wants',
        '<b>Learned memory browser</b> — search, edit, lock and delete the ~4,241 answers the engine has learned',
        '<b>Per-profile scope</b> — memory is keyed to the profile (profile_id, cascade); merges bridge, never leak',
        '<b>Provenance on every answer</b> — you, harvest, deterministic or AI; sensitive fields are never auto-written',
      ],
      note: 'In the answer ladder, locked answers outrank everything except the sensitive-block — EEO / SSN / credentials never reach auto-write or an AI.',
    })}
  </div>`));
}
