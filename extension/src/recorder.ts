// The RECORDER — used ONLY in OBSERVE (watch-and-learn) mode. It passively watches the human fill an
// application in their OWN tab and emits redacted interaction batches up to the SW. It NEVER drives,
// NEVER snapshots, NEVER navigates, NEVER runs a command — purely passive listeners. The mechanics are
// ported from v11's content/recorder.js + supervise.js (label, value, choice, transition capture),
// rebuilt for the thin extension's port transport and the sensor's shared label/redaction ladder.
//
// REDACTION IS ABSOLUTE: any control the sensor deems sensitive (password type / SSN / DOB /
// salary-history / gender / race / disability / veteran / criminal …) records the LABEL only — value is
// null and `redacted:true`. The value never leaves the page.
import { resolveControlLabel, accessibleName, isSensitiveControl } from './sensor.js';

/** One passively-observed interaction. Redacted interactions carry `value:null, redacted:true`. */
export interface ObservedInteraction {
  kind: 'fill' | 'choose' | 'advance';
  label: string;
  fieldType: string;
  value: string | null;
  choice: string | null;
  redacted?: boolean;
  at: number;
}

export interface RecorderHandle {
  /** Flush the pending buffer immediately (called on submit/advance + on teardown). */
  flush(): void;
  /** Detach every listener + timer and drop the buffer. Idempotent. */
  stop(): void;
}

export interface RecorderOptions {
  /** Emit a batch of interactions upward (the content bridge posts it to the SW). */
  onBatch(events: ObservedInteraction[]): void;
  now?: () => number;
  /** Debounce window before an idle flush (default ~1.5s). */
  debounceMs?: number;
  /** Force a flush once this many events buffer (default ~10). */
  maxBatch?: number;
}

/** A button/click whose text says "this advances/submits the form" (flush + mark the transition). */
const ADVANCE_RX = /\b(submit|apply|continue|next|review|send|finish|save|proceed|done)\b/i;

/** Which controls we watch for value/choice changes. */
function isWatchedControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/** Coarse field-type tag for a control (the distiller maps this onto the learned-answer field_type). */
function fieldTypeOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'button') return 'button';
  if (el instanceof HTMLInputElement) {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'radio' || t === 'checkbox' || t === 'file' || t === 'number' || t === 'date') return t;
    return 'text';
  }
  return 'text';
}

/** The human-visible chosen text for a select/radio/checkbox. */
function chosenText(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  if (el instanceof HTMLSelectElement) {
    const opt = el.selectedOptions && el.selectedOptions[0];
    return (opt?.text ?? el.value ?? '').trim();
  }
  return accessibleName(el).trim();
}

export function startRecorder(doc: Document, opts: RecorderOptions): RecorderHandle {
  const now = opts.now ?? (() => Date.now());
  const debounceMs = opts.debounceMs ?? 1500;
  const maxBatch = opts.maxBatch ?? 10;

  // dedup by "kind|label" so a field edited repeatedly emits ONCE with its final value; re-touching a
  // key moves it to the end (last-write-wins, insertion order preserved for the rest).
  const buffer = new Map<string, ObservedInteraction>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let advanceSeq = 0;

  function scheduleFlush(): void {
    if (idleTimer) return;
    idleTimer = setTimeout(() => { idleTimer = null; flush(); }, debounceMs);
  }

  function flush(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (buffer.size === 0) return;
    const events = [...buffer.values()];
    buffer.clear();
    try { opts.onBatch(events); } catch { /* best-effort — a failed uplink must never break the page */ }
  }

  function push(it: ObservedInteraction, dedupKey: string): void {
    buffer.delete(dedupKey); // move-to-end on re-touch
    buffer.set(dedupKey, it);
    if (buffer.size >= maxBatch) flush();
    else scheduleFlush();
  }

  function readValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
    if (el instanceof HTMLSelectElement) return chosenText(el);
    if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
      return el.checked ? chosenText(el) : '';
    }
    return el.value ?? '';
  }

  function recordControl(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, kind: 'fill' | 'choose'): void {
    const label = resolveControlLabel(el).trim();
    if (!label) return; // an unlabeled control isn't a learnable answer
    const fieldType = fieldTypeOf(el);
    const sensitive = isSensitiveControl(el, label);

    const it: ObservedInteraction = {
      kind,
      label,
      fieldType,
      value: null,
      choice: null,
      at: now(),
    };
    if (sensitive) {
      it.redacted = true; // LABEL kept, value never captured
    } else {
      const v = readValue(el);
      it.value = v || null;
      if (kind === 'choose') it.choice = chosenText(el) || null;
    }
    push(it, `${kind}|${label}`);
  }

  // --- passive listeners (capture phase so we see the event even if the page stops propagation) ---

  const onChange = (ev: Event): void => {
    if (stopped) return;
    const el = ev.target as Element | null;
    if (!el || !isWatchedControl(el)) return;
    const kind: 'fill' | 'choose' =
      el instanceof HTMLSelectElement ||
      (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox'))
        ? 'choose'
        : 'fill';
    recordControl(el, kind);
  };

  const onBlur = (ev: Event): void => {
    if (stopped) return;
    const el = ev.target as Element | null;
    if (!el || !isWatchedControl(el)) return;
    // blur catches text/number values that were typed but never fired a change (some SPA inputs).
    if (el instanceof HTMLSelectElement) return; // selects fire change reliably
    if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) return;
    recordControl(el, 'fill');
  };

  const onClick = (ev: Event): void => {
    if (stopped) return;
    const target = ev.target as Element | null;
    if (!target) return;
    const btn = target.closest('button, [role="button"], input[type="submit"], input[type="button"], a[role="button"]');
    if (!btn) return;
    const text = (accessibleName(btn) || btn.textContent || '').trim();
    if (!ADVANCE_RX.test(text)) return;
    // a submit/advance affordance: record the transition + flush immediately (mark the boundary).
    push(
      { kind: 'advance', label: text.slice(0, 200), fieldType: 'button', value: null, choice: null, at: now() },
      `advance|${advanceSeq++}`,
    );
    flush();
  };

  doc.addEventListener('change', onChange, { capture: true });
  doc.addEventListener('blur', onBlur, { capture: true });
  doc.addEventListener('click', onClick, { capture: true });

  return {
    flush,
    stop(): void {
      if (stopped) return;
      stopped = true;
      try { flush(); } catch { /* noop */ }
      doc.removeEventListener('change', onChange, { capture: true } as EventListenerOptions);
      doc.removeEventListener('blur', onBlur, { capture: true } as EventListenerOptions);
      doc.removeEventListener('click', onClick, { capture: true } as EventListenerOptions);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      buffer.clear();
    },
  };
}
