// JAT 13 — Atelier theme controller (ES module). The Atelier Noir look is a bespoke palette baked
// into styles.css as a full variable set keyed on html[data-theme="dark|light"]. This controller only
// decides WHICH ground to stamp: dark (noir), light (ivory), or system (follow the OS). Bronze accent
// is constant across both grounds — the jewelry never changes, only the paper does.
//
// Persistence (PUT /settings/appearance/theme + a localStorage cache) is the caller's job; this module
// is pure DOM + matchMedia. setTheme('system') keeps following the OS live via a single media listener.

/** The three grounds the settings theme-grid offers. */
export const THEMES = [
  { id: 'dark', name: 'Atelier Noir', mode: 'Dark', swatch: 'sw-dark' },
  { id: 'light', name: 'Atelier Ivory', mode: 'Light', swatch: 'sw-light' },
  { id: 'system', name: 'System', mode: 'Auto', swatch: 'sw-system' },
];

export const DEFAULT_THEME = 'dark';
const VALID = new Set(['dark', 'light', 'system']);

let currentMode = DEFAULT_THEME;
let mql = null;

/** Normalize any stored/legacy value (aurora/atelier/etc.) to one of dark|light|system. */
export function normalizeMode(v) {
  if (VALID.has(v)) return v;
  if (v === 'light') return 'light';
  if (v === 'system') return 'system';
  return 'dark'; // aurora/atelier/anything → the dark Atelier ground
}

/** Resolve 'system' to a concrete ground using the OS preference. */
function resolveConcrete(mode) {
  if (mode !== 'system') return mode;
  const prefersLight = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: light)').matches
    : false;
  return prefersLight ? 'light' : 'dark';
}

/**
 * Apply a theme MODE (dark|light|system). Stamps the concrete ground onto <html data-theme>. In
 * 'system' mode a live media listener re-stamps when the OS flips. Returns the concrete ground applied.
 */
export function applyTheme(mode) {
  currentMode = normalizeMode(mode);
  const concrete = resolveConcrete(currentMode);
  const root = document.documentElement;
  root.setAttribute('data-theme', concrete);
  root.setAttribute('data-mode', currentMode);
  ensureSystemWatch();
  return concrete;
}

/** The mode currently chosen (dark|light|system). */
export function getMode() { return currentMode; }

/** Attach the single OS-preference listener (idempotent). Only re-applies while in 'system' mode. */
function ensureSystemWatch() {
  if (mql || typeof window === 'undefined' || !window.matchMedia) return;
  mql = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = () => { if (currentMode === 'system') applyTheme('system'); };
  if (mql.addEventListener) mql.addEventListener('change', onChange);
  else if (mql.addListener) mql.addListener(onChange); // older engines
}
