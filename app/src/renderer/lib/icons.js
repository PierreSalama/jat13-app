// JAT 13 — inline SVG icon library (Atelier). No external icon fonts/CDNs (CSP forbids external
// hosts): every glyph is a small hand-tuned stroke SVG rendered as trusted, static markup. The J⁄13
// signet is the brand mark — an edition-number monogram in an engraved double ring, gold-leaf gradient.

/** Signet brand mark. `size` px; needs the #au gradient defined once in index.html. */
export function signet(size = 46) {
  return `<svg class="signet" viewBox="0 0 96 96" width="${size}" height="${size}" aria-label="JAT 13">
    <circle cx="48" cy="48" r="45" fill="none" stroke="url(#au)" stroke-width="1.7"/>
    <circle cx="48" cy="48" r="39.5" fill="none" stroke="url(#au)" stroke-width=".9" stroke-dasharray="1 3.4" opacity=".85"/>
    <path d="M48 3.6 L50 5.9 48 8.2 46 5.9 Z" fill="url(#au)"/>
    <path d="M48 87.8 L50 90.1 48 92.4 46 90.1 Z" fill="url(#au)"/>
    <line x1="37.5" y1="67" x2="59.5" y2="29" stroke="url(#au)" stroke-width="1.5" stroke-linecap="round"/>
    <text x="31" y="54" font-family="Palatino Linotype, Palatino, Georgia, serif" font-size="37" fill="url(#au)" text-anchor="middle">J</text>
    <text x="62" y="73" font-family="Palatino Linotype, Palatino, Georgia, serif" font-size="22" letter-spacing="1.5" fill="url(#au)" text-anchor="middle">13</text>
  </svg>`;
}

const P = (d, extra = '') =>
  `<svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

// Raw path sets keyed by name; icon(name, size) renders one at an arbitrary size.
const PATHS = {
  command: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2.2 5-5 2.2 2.2-5z"/>',
  bolt: '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>',
  bell: '<path d="M18 8a6 6 0 10-12 0c0 7-2.5 8-2.5 8h17S18 15 18 8"/><path d="M10.3 21a2 2 0 003.4 0"/>',
  board: '<rect x="3" y="4" width="5" height="16" rx="1.2"/><rect x="10" y="4" width="5" height="11" rx="1.2"/><rect x="17" y="4" width="4" height="7" rx="1.2"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c1.4-3.4 4-5 7-5s5.6 1.6 7 5"/>',
  doc: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
  activity: '<path d="M3 12h4l2 6 4-14 2 8h6"/>',
  settings: '<path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/>',
  question: '<circle cx="12" cy="12" r="9.2"/><path d="M9 9.5a3 3 0 115.2 2c-.9.9-2.2 1.4-2.2 2.9"/><circle cx="12" cy="18.2" r=".5" fill="currentColor"/>',
  shield: '<path d="M12 3l8 3v5.5c0 4.6-3.2 7.6-8 9.5-4.8-1.9-8-4.9-8-9.5V6z"/><path d="M9.5 12l1.8 1.8 3.4-3.6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017.5-1.8"/>',
  trash: '<path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13"/>',
  download: '<path d="M12 4v11M8 11l4 4 4-4M5 20h14"/>',
  upload: '<path d="M12 20V9M8 13l4-4 4 4M5 4h14"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 6.5"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  refresh: '<path d="M20 11a8 8 0 10-1.5 5"/><path d="M20 5v6h-6"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  robot: '<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 8V4M9 13h.01M15 13h.01M9 16h6"/><circle cx="12" cy="3" r="1.2"/>',
  inbox: '<path d="M4 13l2.5-8h11L20 13v5a2 2 0 01-2 2H6a2 2 0 01-2-2z"/><path d="M4 13h5l1 2h4l1-2h5"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5"/>',
};

/** icon(name, size=16) — returns an SVG string (or empty span if unknown). */
export function icon(name, size = 16, extra = '') {
  const d = PATHS[name];
  if (!d) return '';
  const s = `width="${size}" height="${size}" ${extra}`;
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${s}>${d}</svg>`;
}

export { P as _P };
