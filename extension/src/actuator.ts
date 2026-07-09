// The ACTUATOR (Pillar 3 §3.5). Executes ONE Cmd against the live DOM and returns a CmdResult. It
// resolves the command's target by nid (primary) with the resilient `rebindPath` as the post-mutation
// fallback, performs the interaction, and — for every MUTATING op — auto-attaches a fresh
// buildSnapshot() as `snapshotDelta` so the app always decides the next action against post-action
// reality (no blind action chains). Zero adapter knowledge: it does exactly what the Cmd says.
import type { Cmd, CmdResult, TargetRef, WaitCond } from '@jat13/shared/protocol';
import { buildSnapshot, getElementByNid, getElementsByGroup, isQuietFor } from './sensor.js';

export interface ActuatorCtx {
  doc: Document;
  /** current epoch — stamped into every snapshotDelta so the app can match it to the live tab. */
  epoch: string;
  /** injectable clock/waiter so the executor is testable without real timers. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_MS = 100;

/** Sidecar for extractText — the wire CmdResult carries no text field, so the content bridge reads
 *  this after an extractText result and relays it in an adapter-out-of-band channel if ever needed. */
export let lastExtractedText = '';

function ctxNow(ctx: ActuatorCtx): number {
  return (ctx.now ?? Date.now)();
}
function ctxSleep(ctx: ActuatorCtx, ms: number): Promise<void> {
  if (ctx.sleep) return ctx.sleep(ms);
  return new Promise((r) => setTimeout(r, ms));
}

/** Snapshot after a mutating op — the app decides the next move against this. */
function delta(ctx: ActuatorCtx): CmdResult['snapshotDelta'] {
  return buildSnapshot(ctx.doc, ctx.epoch);
}

// ---------------------------------------------------------------------------
// target resolution: nid first, then rebindPath (a resilient tag+attr chain the
// sensor emitted). Never throws — a miss returns undefined so the op can report
// 'not_found' honestly rather than crash the whole command stream.
// ---------------------------------------------------------------------------
function resolveTarget(ctx: ActuatorCtx, target: TargetRef): Element | undefined {
  const byNid = getElementByNid(target.nid);
  if (byNid && ctx.doc.contains(byNid)) return byNid;
  if (target.rebindPath) {
    try {
      const el = ctx.doc.querySelector(rebindToSelector(target.rebindPath));
      if (el) return el;
    } catch {
      /* malformed selector → fall through to not_found */
    }
  }
  // nid element may still be attached even if contains() is finicky in jsdom
  return byNid ?? undefined;
}

/** The sensor's `path` uses '>' joins already valid as a descendant-combinator CSS selector. */
function rebindToSelector(path: string): string {
  return path.split('>').join(' > ');
}

function fail(error: string): CmdResult {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// event helpers — React controlled inputs need the native value-setter + an
// input/change dispatch (the descriptor technique ported from v11 autofill.js).
// ---------------------------------------------------------------------------
function nativeSetter(el: Element): ((v: string) => void) | null {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && typeof desc.set === 'function') {
    const set = desc.set;
    return (v: string) => set.call(el, v);
  }
  return null;
}

/** True if the element is (probably) a React-controlled input (has a React fiber props key). */
function isReactControlled(el: Element): boolean {
  for (const k of Object.keys(el)) {
    if (k.startsWith('__reactProps$') || k.startsWith('__reactInternalInstance$') || k.startsWith('__reactFiber$')) {
      return true;
    }
  }
  return false;
}

function fireInput(el: Element): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function fireChange(el: Element): void {
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setValueNative(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
}
function setValueReact(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = nativeSetter(el);
  if (setter) setter(value);
  else el.value = value;
}

// ---------------------------------------------------------------------------
// the executor
// ---------------------------------------------------------------------------
export async function execute(cmd: Cmd, ctx: ActuatorCtx): Promise<CmdResult> {
  switch (cmd.op) {
    case 'navigate': {
      // The content script cannot cross-origin navigate reliably; the SW owns tab navigation. Here we
      // only honor same-doc navigations (hash/pushState-ish) — the SW intercepts the real ones.
      try {
        ctx.doc.location.assign(cmd.url);
        return { ok: true, snapshotDelta: delta(ctx) };
      } catch (e) {
        return fail(errStr(e));
      }
    }

    case 'snapshot': {
      // non-mutating, but the app asked for a fresh view explicitly.
      return { ok: true, snapshotDelta: buildSnapshot(ctx.doc, ctx.epoch) };
    }

    case 'click': {
      const el = resolveTarget(ctx, cmd.target);
      if (!el) return fail('not_found');
      if (isDisabled(el)) return fail('disabled');
      const count = cmd.clickCount ?? 1;
      scrollInto(el);
      for (let i = 0; i < count; i++) (el as HTMLElement).click();
      return { ok: true, snapshotDelta: delta(ctx) };
    }

    case 'fill': {
      const el = resolveTarget(ctx, cmd.target);
      if (!el) return fail('not_found');
      if (isDisabled(el)) return fail('disabled');
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
        return fail('not_found');
      }
      scrollInto(el);
      (el as HTMLElement).focus?.();
      const useReact = cmd.method === 'reactSetter' || (cmd.method === 'auto' && isReactControlled(el));
      if (useReact) setValueReact(el, cmd.value);
      else setValueNative(el, cmd.value);
      fireInput(el);
      fireChange(el);
      return { ok: true, snapshotDelta: delta(ctx) };
    }

    case 'selectOption': {
      const el = resolveTarget(ctx, cmd.target);
      if (!el) return fail('not_found');
      if (!(el instanceof HTMLSelectElement)) return fail('not_found');
      if (isDisabled(el)) return fail('disabled');
      const opts = Array.from(el.options);
      let match: HTMLOptionElement | undefined;
      if (cmd.option.byValue !== undefined) match = opts.find((o) => o.value === cmd.option.byValue);
      if (!match && cmd.option.byText !== undefined) {
        const want = cmd.option.byText.trim().toLowerCase();
        match = opts.find((o) => o.text.trim().toLowerCase() === want) ?? opts.find((o) => o.text.trim().toLowerCase().includes(want));
      }
      if (!match && cmd.option.byIndex !== undefined) match = opts[cmd.option.byIndex];
      if (!match) return fail('not_found');
      el.value = match.value;
      fireInput(el);
      fireChange(el);
      return { ok: true, snapshotDelta: delta(ctx) };
    }

    case 'setChecked': {
      const el = resolveTarget(ctx, cmd.target);
      if (!el) return fail('not_found');
      if (!(el instanceof HTMLInputElement)) return fail('not_found');
      if (isDisabled(el)) return fail('disabled');
      if (el.checked !== cmd.checked) {
        // click drives the affordance so associated label/React state stays consistent
        scrollInto(el);
        el.click();
        if (el.checked !== cmd.checked) {
          el.checked = cmd.checked;
          fireInput(el);
          fireChange(el);
        }
      }
      return { ok: true, snapshotDelta: delta(ctx) };
    }

    case 'chooseRadio': {
      // Scope to the TARGET group (cmd.group is the sensor-assigned group id). Two distinct groups can
      // share a "Yes"/"No" label, so a document-wide scan would mis-select; we restrict to the group's
      // members. Fall back to a document-wide radio scan ONLY when the group id is unknown (stale epoch).
      const want = cmd.option.byText.trim().toLowerCase();
      const grouped = getElementsByGroup(cmd.group)
        .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'radio');
      const radios: HTMLInputElement[] = grouped.length
        ? grouped
        : (Array.from(ctx.doc.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]);
      // find a radio whose label matches within the group, prefer exact label match
      let chosen: HTMLInputElement | undefined;
      for (const r of radios) {
        const lbl = labelTextFor(r).trim().toLowerCase();
        if (lbl === want) { chosen = r; break; }
      }
      if (!chosen && want.length > 0) {
        for (const r of radios) {
          const lbl = labelTextFor(r).trim().toLowerCase();
          if (lbl.includes(want)) { chosen = r; break; }
        }
      }
      if (!chosen) return fail('not_found');
      if (isDisabled(chosen)) return fail('disabled');
      scrollInto(chosen);
      chosen.click();
      if (!chosen.checked) {
        chosen.checked = true;
        fireInput(chosen);
        fireChange(chosen);
      }
      return { ok: true, snapshotDelta: delta(ctx) };
    }

    case 'combobox': {
      // react-select pattern: type into the input → wait for options → click the matching option.
      const el = resolveTarget(ctx, cmd.target);
      if (!el) return fail('not_found');
      const input = (el instanceof HTMLInputElement ? el : el.querySelector('input')) as HTMLInputElement | null;
      if (!input) return fail('not_found');
      scrollInto(input);
      input.focus();
      setValueReact(input, cmd.typeText);
      fireInput(input);
      // poll for an option node matching pickText
      const want = cmd.pickText.trim().toLowerCase();
      const deadline = ctxNow(ctx) + 5000;
      let opt: Element | undefined;
      while (ctxNow(ctx) < deadline) {
        opt = Array.from(ctx.doc.querySelectorAll('[role="option"], option, li'))
          .find((o) => (o.textContent || '').trim().toLowerCase().includes(want));
        if (opt) break;
        await ctxSleep(ctx, DEFAULT_POLL_MS);
      }
      if (!opt) return fail('timeout');
      (opt as HTMLElement).click();
      fireChange(input);
      return { ok: true, snapshotDelta: delta(ctx) };
    }

    case 'scrollIntoView': {
      const el = resolveTarget(ctx, cmd.target);
      if (!el) return fail('not_found');
      scrollInto(el);
      return { ok: true, snapshotDelta: delta(ctx) };
    }

    case 'scrollPage': {
      const view = ctx.doc.defaultView;
      if (view && typeof view.scrollTo === 'function') {
        if (cmd.toBottom) view.scrollTo(0, ctx.doc.body?.scrollHeight ?? 0);
        else if (typeof cmd.byPx === 'number') view.scrollBy(0, cmd.byPx);
      }
      return { ok: true, snapshotDelta: delta(ctx) };
    }

    case 'waitFor': {
      const ok = await waitFor(ctx, cmd.cond, cmd.timeoutMs);
      if (!ok) return { ok: false, error: 'timeout', snapshotDelta: delta(ctx) };
      return { ok: true, snapshotDelta: delta(ctx) };
    }

    case 'extractText': {
      const el = resolveTarget(ctx, cmd.target);
      if (!el) return fail('not_found');
      const max = cmd.maxLen ?? 2000;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max);
      // The wire CmdResult has no free text channel (ok/error/snapshotDelta only). The SW attaches the
      // extracted text out-of-band via lastExtractedText — the actuator stays within the contract.
      lastExtractedText = text;
      return { ok: true };
    }

    case 'upload': {
      // The extension builds a File+DataTransfer in the SW/content bridge; at the actuator level we
      // only receive already-relayed bytes in a fuller build. M1: report unsupported honestly.
      return fail('upload_failed');
    }

    default: {
      // exhaustive — the Cmd union is closed. A never here means an unhandled op.
      return fail('not_found');
    }
  }
}

// ---------------------------------------------------------------------------
// waitFor conditions (§3.5)
// ---------------------------------------------------------------------------
async function waitFor(ctx: ActuatorCtx, cond: WaitCond, timeoutMs: number): Promise<boolean> {
  const deadline = ctxNow(ctx) + Math.max(0, timeoutMs);
  const check = (): boolean => evalCond(ctx, cond);
  if (check()) return true;
  while (ctxNow(ctx) < deadline) {
    await ctxSleep(ctx, DEFAULT_POLL_MS);
    if (check()) return true;
  }
  return check();
}

function evalCond(ctx: ActuatorCtx, cond: WaitCond): boolean {
  switch (cond.kind) {
    case 'enabled': {
      const el = resolveTarget(ctx, cond.target);
      return !!el && !isDisabled(el);
    }
    case 'absent': {
      const el = resolveTarget(ctx, cond.target);
      return !el || !ctx.doc.contains(el);
    }
    case 'present': {
      const { text, role } = cond.textOrRole;
      const nodes = Array.from(ctx.doc.querySelectorAll('*'));
      return nodes.some((n) => {
        if (role && (n.getAttribute('role') || n.tagName.toLowerCase()) !== role) return false;
        if (text && !(n.textContent || '').toLowerCase().includes(text.toLowerCase())) return false;
        return !!(text || role);
      });
    }
    case 'urlMatches': {
      try {
        return new RegExp(cond.pattern).test(ctx.doc.URL || ctx.doc.location?.href || '');
      } catch {
        return false;
      }
    }
    case 'quiet': {
      // The content-script quiet tracker (markMutation) is authoritative: satisfied once the DOM has
      // been quiet for the requested window. With no observer installed, isQuietFor returns true so a
      // waitFor never hard-stalls (the app also has its own TTL).
      return isQuietFor(cond.quietMs);
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// small DOM utilities
// ---------------------------------------------------------------------------
function isDisabled(el: Element): boolean {
  const anyEl = el as HTMLInputElement & HTMLButtonElement;
  return anyEl.disabled === true || el.getAttribute('aria-disabled') === 'true';
}

function scrollInto(el: Element): void {
  if (typeof (el as HTMLElement).scrollIntoView === 'function') {
    try { (el as HTMLElement).scrollIntoView({ block: 'center' }); } catch { /* jsdom no-op */ }
  }
}

/** Visible label text for a radio/checkbox (for=, wrapping ancestor, aria-label). */
function labelTextFor(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria;
  const id = el.getAttribute('id');
  if (id) {
    const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    const l = el.ownerDocument.querySelector(`label[for="${esc}"]`);
    if (l && l.textContent) return l.textContent;
  }
  const wrap = el.closest('label');
  if (wrap && wrap.textContent) return wrap.textContent;
  return '';
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
