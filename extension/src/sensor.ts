// The SENSOR (Pillar 3 §3.3). Walks the live document into a size-bounded, accessibility-tree-ish
// PageSnapshot — the ONLY thing the extension reports about page content. It holds ZERO adapter
// knowledge: it emits roles/names/states/rects and lets the app classify and decide. Every rule here
// encodes a v11 scar (hidden-input grounding v11.56, group-prompt resolution v11.66, loading labels
// v11.86, value redaction, the 128KB/400-node cap). The types come from the shared contract; a
// malformed snapshot is rejected at the app gateway by the same zod schema, not patched here.
import type { PageSnapshot, SnapNode, SnapNodeStates, SnapNodeAttrs, SnapRole } from '@jat13/shared/protocol';
import { CAPS } from '@jat13/shared/constants';

// ---------------------------------------------------------------------------
// nid registry — stable per epoch. A fresh WeakMap per buildSnapshot() call so
// a given Element keeps ONE nid across the nodes of a single snapshot, and the
// reverse map lets the actuator resolve a command's `nid` back to its Element.
// ---------------------------------------------------------------------------
let currentEpoch = '';
let nidToEl = new WeakMap<object, Element>() as unknown as Map<number, Element>;
let elToNid = new WeakMap<Element, number>();
let nidSeq = 0;
// group id → the radio/checkbox Elements that belong to it. Populated per snapshot so the actuator can
// scope a `chooseRadio { group }` command to the RIGHT group (two groups can share a "Yes"/"No" label).
let groupToEls = new Map<number, Element[]>();

/** Reset the per-epoch registries. Called at the top of buildSnapshot when the epoch changes. */
function resetRegistry(epoch: string): void {
  currentEpoch = epoch;
  elToNid = new WeakMap<Element, number>();
  nidToEl = new Map<number, Element>();
  groupToEls = new Map<number, Element[]>();
  nidSeq = 0;
}

function nidFor(el: Element): number {
  const existing = elToNid.get(el);
  if (existing !== undefined) return existing;
  const nid = ++nidSeq;
  elToNid.set(el, nid);
  nidToEl.set(nid, el);
  return nid;
}

/** Actuator lookup: resolve a command's nid back to the live Element (same-epoch only). */
export function getElementByNid(nid: number): Element | undefined {
  return nidToEl.get(nid);
}

/** Actuator lookup: the radios/checkboxes belonging to a snapshot group id (same-epoch only). Empty
 *  when the group id is unknown (stale epoch) — the actuator then falls back to a document-wide scan. */
export function getElementsByGroup(group: number): Element[] {
  return groupToEls.get(group) ?? [];
}

// ---------------------------------------------------------------------------
// sensitive value redaction (§3.3 rule 5). The sensor never sends secrets up:
// type=password always redacts; any field whose resolved name matches this rx
// redacts too. Kept in sync (by intent) with the app-side answers guard.
// ---------------------------------------------------------------------------
const SENSITIVE_RX =
  /\b(ssn|social security|date of birth|dob|salary history|race|ethnic|gender|disabilit|veteran|sexual orientation|criminal|felony|convict)\b/i;

// A leading loading token (v11.86). RAW name is kept; the app strips in ONE place.
const LOADING_RX = /^\s*(loading|chargement|en cours)\s*[.…·]*\s*/i;

const MAX_NAME = 200; //   SnapNode.name is z.string().max(200)
const MAX_TEXT_NODE = 300; // §3.3 rule 6: interaction-oriented; long text truncates

// ---------------------------------------------------------------------------
// role mapping — DOM element → the curated SnapRole subset. No ARIA-role
// evaluation beyond what's needed for interaction; the app decides meaning.
// ---------------------------------------------------------------------------
function inputRole(el: HTMLInputElement): SnapRole | null {
  const t = (el.type || 'text').toLowerCase();
  switch (t) {
    case 'radio': return 'radio';
    case 'checkbox': return 'checkbox';
    case 'file': return 'file';
    case 'submit':
    case 'button':
    case 'reset': return 'button';
    case 'hidden': return null;
    default: return 'textbox'; // text/email/tel/number/password/date/search/url/...
  }
}

function roleOf(el: Element): SnapRole | null {
  const explicit = el.getAttribute('role');
  if (explicit) {
    const r = explicit.toLowerCase();
    // only accept explicit ARIA roles that are in our vocabulary
    const allowed: readonly SnapRole[] = [
      'button', 'link', 'textbox', 'radio', 'checkbox', 'combobox', 'option',
      'heading', 'group', 'radiogroup', 'progressbar', 'alert', 'dialog', 'img',
    ];
    if ((allowed as string[]).includes(r)) return r as SnapRole;
  }
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'input': return inputRole(el as HTMLInputElement);
    case 'textarea': return 'textarea';
    case 'select': return 'select';
    case 'button': return 'button';
    case 'a': return (el as HTMLAnchorElement).hasAttribute('href') ? 'link' : null;
    case 'option': return 'option';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
    case 'dialog': return 'dialog';
    case 'img': return 'img';
    case 'iframe': return 'iframe';
    case 'progress': return 'progressbar';
    case 'fieldset': return 'group';
    default: return null;
  }
}

const CONTROL_ROLES = new Set<SnapRole>(['textbox', 'textarea', 'radio', 'checkbox', 'combobox', 'select', 'file']);

// ---------------------------------------------------------------------------
// geometry / visibility. Visibility is computed on the AFFORDANCE, never the
// raw input — that's the whole point of hidden-input grounding.
// ---------------------------------------------------------------------------
type Rect = [number, number, number, number];

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
}

function styleOf(el: Element): CSSStyleDeclaration | null {
  const view = el.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return null;
  try {
    return view.getComputedStyle(el);
  } catch {
    return null;
  }
}

// Layout probe: a real browser gives elements a non-zero box; jsdom (no layout engine) reports every
// getBoundingClientRect() as 0×0. When there's no layout we CANNOT use rect for visibility, so we fall
// back to style/attribute signals only. This keeps v11.56 rect-based grounding in the real browser and
// deterministic behavior under test — the sensor never blanks out just because layout is absent.
let _layoutCache: boolean | null = null;
function hasLayout(doc: Document): boolean {
  if (_layoutCache !== null) return _layoutCache;
  const probe = doc.body ?? doc.documentElement;
  const r = probe ? probe.getBoundingClientRect() : { width: 0, height: 0 };
  _layoutCache = r.width > 0 || r.height > 0;
  return _layoutCache;
}

/** Inline/computed style says this element is hidden (display:none / visibility:hidden / opacity:0)? */
function styleHidden(el: Element): boolean {
  const st = styleOf(el);
  if (st) {
    if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return true;
    if (parseFloat(st.opacity || '1') === 0) return true;
  }
  // inline-style fallback (covers jsdom where computed opacity may not resolve reliably)
  const inline = (el as HTMLElement).style;
  if (inline) {
    if (inline.display === 'none' || inline.visibility === 'hidden') return true;
    if (inline.opacity !== '' && parseFloat(inline.opacity) === 0) return true;
    const w = inline.width, h = inline.height;
    if ((w === '0px' || w === '0') && (h === '0px' || h === '0')) return true;
  }
  return el.hasAttribute('hidden');
}

/** Is this element itself rendered with a real box (not display:none/visibility:hidden/opacity:0)? */
function isVisible(el: Element): boolean {
  if (styleHidden(el)) return false;
  if (!hasLayout(el.ownerDocument)) return true; // no layout engine → trust style only
  const [, , w, h] = rectOf(el);
  return w > 0 && h > 0;
}

/** A 0×0 / opacity:0 input — a hidden-input candidate that needs a visible label affordance (v11.56). */
function isVisuallyHidden(el: Element): boolean {
  if (styleHidden(el)) return true;
  if (!hasLayout(el.ownerDocument)) return false; // no rect signal → not a hidden-input candidate here
  const [, , w, h] = rectOf(el);
  return w === 0 && h === 0;
}

// ---------------------------------------------------------------------------
// accessible-name ladder (§3.3): aria-label / aria-labelledby → <label> →
// placeholder → nearby text. Capped at MAX_NAME. Returns '' when nothing grounds.
// ---------------------------------------------------------------------------
function textFromIds(doc: Document, ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id)?.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The visible <label> associated with a control (for=, wrapping ancestor). Returns the element. */
function labelElementFor(el: Element): HTMLLabelElement | null {
  const doc = el.ownerDocument;
  const id = el.getAttribute('id');
  if (id) {
    // CSS.escape may be missing in some jsdom builds — guard.
    const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    const forLabel = doc.querySelector(`label[for="${esc}"]`);
    if (forLabel) return forLabel as HTMLLabelElement;
  }
  const wrapping = el.closest('label');
  if (wrapping) return wrapping as HTMLLabelElement;
  return null;
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

function accessibleName(el: Element): string {
  const doc = el.ownerDocument;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return truncate(ariaLabel, MAX_NAME);

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const t = textFromIds(doc, labelledBy);
    if (t) return truncate(t, MAX_NAME);
  }

  const labelEl = labelElementFor(el);
  if (labelEl && labelEl.textContent && labelEl.textContent.trim()) {
    return truncate(labelEl.textContent, MAX_NAME);
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return truncate(placeholder, MAX_NAME);

  // buttons/links/headings/options carry their own text; controls fall back to title.
  const own = (el as HTMLElement).textContent;
  const tag = el.tagName.toLowerCase();
  if (own && own.trim() && (tag === 'button' || tag === 'a' || /^h[1-6]$/.test(tag) || tag === 'option' || el.getAttribute('role'))) {
    return truncate(own, MAX_NAME);
  }

  const title = el.getAttribute('title');
  if (title && title.trim()) return truncate(title, MAX_NAME);

  // nearby text: previous sibling / parent's leading text (bounded).
  const near = nearbyText(el);
  if (near) return truncate(near, MAX_NAME);

  return '';
}

/** Bounded nearby-text probe: preceding text within the closest labelable ancestor. */
function nearbyText(el: Element): string {
  let prev = el.previousElementSibling;
  let hops = 0;
  while (prev && hops < 3) {
    const t = prev.textContent?.replace(/\s+/g, ' ').trim();
    if (t && t.length <= MAX_NAME) return t;
    prev = prev.previousElementSibling;
    hops++;
  }
  return '';
}

// ---------------------------------------------------------------------------
// group + group-prompt resolution (§3.3 rule 2, v11.66). Radios sharing a
// name-attr (or an ancestor radiogroup/fieldset) get a shared numeric group id
// and a resolved prompt. A prompt that resolves to a machine id / option value
// is emitted as '' — never a dirty label the answer service could misread.
// ---------------------------------------------------------------------------
const MACHINE_ID_RX = /^(q_?[0-9a-f]{4,}|[0-9a-f]{8}-[0-9a-f]{4}|_\d+_\w+|option[-_]?\d+|\d+)$/i;

function looksMachine(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (MACHINE_ID_RX.test(t)) return true;
  return false;
}

/** Resolve the shared question text for a group: aria-labelledby → fieldset legend → nearest heading. */
function resolveGroupPrompt(groupContainer: Element | null, sample: Element): string {
  const doc = sample.ownerDocument;
  // 1) explicit labelling on the group container
  if (groupContainer) {
    const lb = groupContainer.getAttribute('aria-labelledby');
    if (lb) {
      const t = textFromIds(doc, lb);
      if (t && !looksMachine(t)) return truncate(t, MAX_NAME);
    }
    const al = groupContainer.getAttribute('aria-label');
    if (al && al.trim() && !looksMachine(al)) return truncate(al, MAX_NAME);
    const legend = groupContainer.querySelector('legend');
    if (legend && legend.textContent && legend.textContent.trim() && !looksMachine(legend.textContent)) {
      return truncate(legend.textContent, MAX_NAME);
    }
  }
  // 2) nearest preceding heading / group-role container text walking up from the sample
  let cur: Element | null = sample;
  let hops = 0;
  while (cur && hops < 6) {
    let sib = cur.previousElementSibling;
    let sibHops = 0;
    while (sib && sibHops < 4) {
      if (/^h[1-6]$/i.test(sib.tagName) || sib.getAttribute('role') === 'heading') {
        const t = sib.textContent?.trim();
        if (t && !looksMachine(t)) return truncate(t, MAX_NAME);
      }
      sib = sib.previousElementSibling;
      sibHops++;
    }
    cur = cur.parentElement;
    hops++;
  }
  return '';
}

/** Group container for a radio/checkbox: closest fieldset or role=radiogroup/group. */
function groupContainerOf(el: Element): Element | null {
  return el.closest('fieldset, [role="radiogroup"], [role="group"]');
}

// ---------------------------------------------------------------------------
// states + attrs + value
// ---------------------------------------------------------------------------
function statesOf(el: Element, role: SnapRole, hiddenInput: boolean, loadingLabel: boolean): SnapNodeStates | undefined {
  const s: {
    disabled?: true; checked?: true; required?: true; focused?: true;
    hiddenInput?: true; loadingLabel?: true; expanded?: boolean;
  } = {};
  const anyEl = el as Element & { disabled?: boolean; required?: boolean };
  if (anyEl.disabled === true || el.getAttribute('aria-disabled') === 'true') s.disabled = true;
  if ((role === 'radio' || role === 'checkbox')) {
    const checked = (el as HTMLInputElement).checked === true || el.getAttribute('aria-checked') === 'true';
    if (checked) s.checked = true;
  }
  if (anyEl.required === true || el.getAttribute('aria-required') === 'true') s.required = true;
  if (el.ownerDocument.activeElement === el) s.focused = true;
  if (hiddenInput) s.hiddenInput = true;
  if (loadingLabel) s.loadingLabel = true;
  const expanded = el.getAttribute('aria-expanded');
  if (expanded === 'true') s.expanded = true;
  else if (expanded === 'false') s.expanded = false;
  return Object.keys(s).length ? s : undefined;
}

function attrsOf(el: Element): SnapNodeAttrs | undefined {
  const a: {
    id?: string; nameAttr?: string; type?: string; placeholder?: string;
    autocomplete?: string; testid?: string; href?: string; accept?: string;
  } = {};
  const id = el.getAttribute('id'); if (id) a.id = id;
  const nameAttr = el.getAttribute('name'); if (nameAttr) a.nameAttr = nameAttr;
  const type = el.getAttribute('type'); if (type) a.type = type;
  const placeholder = el.getAttribute('placeholder'); if (placeholder) a.placeholder = placeholder;
  const autocomplete = el.getAttribute('autocomplete'); if (autocomplete) a.autocomplete = autocomplete;
  const testid = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id') ?? el.getAttribute('data-test');
  if (testid) a.testid = testid;
  const href = el.getAttribute('href'); if (href) a.href = href;
  const accept = el.getAttribute('accept'); if (accept) a.accept = accept;
  return Object.keys(a).length ? a : undefined;
}

/** Current value for a control — REDACTED for password / sensitive-named fields (never sent up). */
function valueOf(el: Element, role: SnapRole, name: string): string | undefined {
  if (role === 'textbox' || role === 'textarea' || role === 'combobox') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return undefined; // never send secrets up
    if (SENSITIVE_RX.test(name) || SENSITIVE_RX.test(el.getAttribute('name') || '')) return undefined;
    const v = (el as HTMLInputElement | HTMLTextAreaElement).value;
    return typeof v === 'string' ? v : undefined;
  }
  if (role === 'select') {
    // EEO fields (gender/race/veteran/disability) are frequently <select> — redact them too.
    if (SENSITIVE_RX.test(name) || SENSITIVE_RX.test(el.getAttribute('name') || '')) return undefined;
    const v = (el as HTMLSelectElement).value;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// resilient path locator — REBIND fallback only (never adapter-evaluated). A
// short tag + stable-attr chain the app can hand back as `rebindPath` after a
// mutation invalidates the nid.
// ---------------------------------------------------------------------------
function pathOf(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth < 5 && cur.nodeType === 1) {
    let seg = cur.tagName.toLowerCase();
    const id = cur.getAttribute('id');
    const testid = cur.getAttribute('data-testid') ?? cur.getAttribute('data-test-id');
    const nameAttr = cur.getAttribute('name');
    if (id) { seg += `#${id}`; parts.unshift(seg); break; } // an id is unique enough to stop
    if (testid) seg += `[data-testid="${testid}"]`;
    else if (nameAttr) seg += `[name="${nameAttr}"]`;
    parts.unshift(seg);
    cur = cur.parentElement;
    depth++;
  }
  return parts.join('>');
}

// ---------------------------------------------------------------------------
// snapshot node construction
// ---------------------------------------------------------------------------
interface Built {
  node: SnapNode;
  priority: number; // lower = kept first under the cap
}

function priorityOf(role: SnapRole, inFormRoot: boolean): number {
  if (CONTROL_ROLES.has(role)) return 0; //                     form controls first
  if ((role === 'button' || role === 'link') && inFormRoot) return 1; // affordances in the form
  if (role === 'button' || role === 'link') return 2;
  if (role === 'heading') return 3;
  if (role === 'dialog' || role === 'alert') return 4;
  return 5; //                                                  everything else
}

/** Is `el` within a form-ish root (a <form>, role=dialog, or a fieldset)? Crude but cheap. */
function inFormRoot(el: Element): boolean {
  return !!el.closest('form, [role="dialog"], dialog, fieldset');
}

// ---------------------------------------------------------------------------
// hash — a cheap deterministic digest of the normalized node list (change
// detection). NOT crypto; a stable 32-bit rolling hash rendered hex, prefixed
// so it reads as a digest. (Real sha1 isn't available sync in a content script.)
// ---------------------------------------------------------------------------
function hashNodes(nodes: SnapNode[]): string {
  // normalized projection: role|name|value|group|disabled|checked per node, order-sensitive.
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  const push = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    }
  };
  for (const n of nodes) {
    push(n.role);
    push('');
    push(n.name);
    push('');
    push(n.value ?? '');
    push('');
    push(String(n.group ?? ''));
    push('');
    push(n.states?.disabled ? 'd' : '');
    push(n.states?.checked ? 'c' : '');
    push('');
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  return `sha1_${hex}`;
}

// ---------------------------------------------------------------------------
// buildSnapshot — the entry point. Walks the document, applies every §3.3 rule,
// enforces the cap, returns a contract-valid PageSnapshot. Same-process iframes
// are flattened with a framePath; cross-origin iframes contribute host-only.
// ---------------------------------------------------------------------------
export function buildSnapshot(doc: Document, epoch: string): PageSnapshot {
  if (epoch !== currentEpoch) resetRegistry(epoch);
  _layoutCache = null; // re-probe layout per snapshot (document/environment may differ)
  groupToEls = new Map<number, Element[]>(); // rebuilt every snapshot (group ids are deterministic below)

  const groupIds = new Map<string, number>(); // group-key → numeric group id
  let groupSeq = 0;
  const groupIdFor = (key: string): number => {
    const ex = groupIds.get(key);
    if (ex !== undefined) return ex;
    const id = ++groupSeq;
    groupIds.set(key, id);
    return id;
  };

  const built: Built[] = [];
  // resolved prompt per group id (computed once from the first sample of each group)
  const groupPromptById = new Map<number, string>();

  const walk = (root: ParentNode, framePath: string): void => {
    const all = root.querySelectorAll('*');
    for (const el of Array.from(all)) {
      const role = roleOf(el);
      if (!role) continue;

      // hidden-input grounding (§3.3 rule 1, v11.56): 0×0/opacity:0 radio/checkbox/file WITH a
      // visible label affordance is INCLUDED, using the LABEL's rect. Visibility is on the affordance.
      let hiddenInput = false;
      let effectiveRect: Rect;
      const isFormInput = role === 'radio' || role === 'checkbox' || role === 'file';

      if (isFormInput && isVisuallyHidden(el)) {
        const labelEl = labelElementFor(el);
        if (labelEl && isVisible(labelEl)) {
          hiddenInput = true;
          effectiveRect = rectOf(labelEl);
        } else {
          continue; // truly hidden, no affordance → not interactable, skip
        }
      } else {
        if (!isVisible(el)) {
          // headings/text/dialogs that are invisible are noise; skip. (Controls handled above.)
          continue;
        }
        effectiveRect = rectOf(el);
      }

      const rawName = accessibleName(el);
      const loadingLabel = LOADING_RX.test(rawName);
      const states = statesOf(el, role, hiddenInput, loadingLabel);
      const attrs = attrsOf(el);
      const value = valueOf(el, role, rawName);

      // grouping for radios/checkboxes
      let group: number | undefined;
      let groupPrompt: string | undefined;
      if (role === 'radio' || role === 'checkbox') {
        const container = groupContainerOf(el);
        const nameAttr = el.getAttribute('name');
        // group-key: name-attr scoped to the form, else the container identity.
        const key = nameAttr
          ? `${framePath}:name:${nameAttr}`
          : container
            ? `${framePath}:cont:${(container.getAttribute('id') || pathOf(container))}`
            : `${framePath}:self:${nidFor(el)}`;
        group = groupIdFor(key);
        if (!groupPromptById.has(group)) {
          groupPromptById.set(group, resolveGroupPrompt(container, el));
        }
        groupPrompt = groupPromptById.get(group);
        const members = groupToEls.get(group) ?? [];
        members.push(el);
        groupToEls.set(group, members);
      }

      const nid = nidFor(el);
      const node: SnapNode = {
        nid,
        role,
        name: role === 'text' ? truncate(rawName, MAX_TEXT_NODE) : rawName,
        rect: effectiveRect,
        path: pathOf(el),
      };
      if (value !== undefined) node.value = value;
      if (states) node.states = states;
      if (group !== undefined) node.group = group;
      if (groupPrompt !== undefined) node.groupPrompt = groupPrompt;
      if (attrs) node.attrs = attrs;
      if (role === 'heading') {
        const lvl = parseInt(el.tagName.replace(/\D/g, ''), 10);
        if (!Number.isNaN(lvl)) node.headingLevel = lvl;
        else {
          const ariaLvl = parseInt(el.getAttribute('aria-level') || '', 10);
          if (!Number.isNaN(ariaLvl)) node.headingLevel = ariaLvl;
        }
      }

      built.push({ node, priority: priorityOf(role, inFormRoot(el)) });

      // recurse into same-process iframes; cross-origin gets host-only (handled in frames pass below)
    }
  };

  walk(doc, '');

  // ---- apply the cap (§3.3 rule 4): keep by priority, then document order ----
  built.forEach((b, i) => ((b as Built & { _i: number })._i = i));
  const sorted = [...built].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (a as Built & { _i: number })._i - (b as Built & { _i: number })._i;
  });

  let truncated = false;
  const kept: SnapNode[] = [];
  let bytes = 0;
  for (const b of sorted) {
    if (kept.length >= CAPS.snapshotNodes) { truncated = true; break; }
    const sz = approxBytes(b.node);
    if (bytes + sz > CAPS.snapshotBytes) { truncated = true; break; }
    kept.push(b.node);
    bytes += sz;
  }
  // restore document order for the emitted nodes (stable, easier for the app)
  const orderIndex = new Map<number, number>();
  built.forEach((b, i) => orderIndex.set(b.node.nid, i));
  kept.sort((a, b) => (orderIndex.get(a.nid) ?? 0) - (orderIndex.get(b.nid) ?? 0));

  // ---- frames: main frame + cross-origin iframe host stubs ----
  const frames: PageSnapshot['frames'] = [
    { framePath: '', frameHost: safeHost(doc), nodes: kept },
  ];
  const iframes = Array.from(doc.querySelectorAll('iframe'));
  iframes.forEach((f, i) => {
    let sameOrigin = false;
    try {
      // accessing contentDocument throws / returns null cross-origin
      sameOrigin = !!(f as HTMLIFrameElement).contentDocument;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      let host = '';
      try { host = new URL((f as HTMLIFrameElement).src, doc.baseURI).host; } catch { host = ''; }
      frames.push({ framePath: String(i), frameHost: host, nodes: [] });
    }
    // same-origin iframe content is intentionally NOT deep-walked at M1 (kept simple + within cap).
  });

  const snapshot: PageSnapshot = {
    v: 1,
    epoch,
    url: safeUrl(doc),
    title: doc.title || '',
    readyState: normalizeReadyState(doc.readyState),
    quietMs: quietSince(),
    frames,
    truncated,
    hash: hashNodes(kept),
  };
  return snapshot;
}

function approxBytes(n: SnapNode): number {
  // cheap size estimate without a full JSON.stringify per node in the hot loop
  let b = 40; // fixed overhead (nid, role, rect, path frame)
  b += n.name.length;
  b += n.value ? n.value.length : 0;
  b += n.groupPrompt ? n.groupPrompt.length : 0;
  b += n.path.length;
  if (n.attrs) b += 60;
  return b;
}

function safeHost(doc: Document): string {
  try { return new URL(doc.URL || doc.location?.href || '').host; } catch { return ''; }
}
function safeUrl(doc: Document): string {
  return doc.URL || doc.location?.href || '';
}
function normalizeReadyState(rs: DocumentReadyState): PageSnapshot['readyState'] {
  return rs === 'loading' || rs === 'interactive' || rs === 'complete' ? rs : 'complete';
}

// ---------------------------------------------------------------------------
// quiet tracker — ms since the last DOM mutation burst (hydration signal). The
// content script installs a shared MutationObserver via markMutation(); if none
// is installed (e.g. in a unit test) we report 0 (never crash).
// ---------------------------------------------------------------------------
let lastMutationAt = 0;
export function markMutation(now: number = Date.now()): void {
  lastMutationAt = now;
}
function quietSince(now: number = Date.now()): number {
  if (lastMutationAt === 0) return 0;
  const q = now - lastMutationAt;
  return q > 0 ? q : 0;
}

/** Has the DOM been quiet for at least `ms`? Used by the actuator's waitFor 'quiet' condition. When no
 *  mutation has ever been observed (no MutationObserver installed, e.g. under test) we treat the page
 *  as quiet so a waitFor never hard-stalls waiting for a signal that will never arrive. */
export function isQuietFor(ms: number, now: number = Date.now()): boolean {
  if (lastMutationAt === 0) return true;
  return now - lastMutationAt >= ms;
}
