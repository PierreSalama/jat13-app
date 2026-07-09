// The classifier — resolve WHERE we are from a snapshot + the adapter's PageDefs (Pillar 3 §4.3).
// This is the ONLY source of run position; the interpreter never assumes it advanced, it re-classifies
// the live page every step. That is what makes resume-by-reclassification work: after any extension
// death, a fresh snapshot lands us on the page we're actually on (LinkedIn keeps the Easy Apply draft).
import type { PageSnapshot, SnapNode } from '@jat13/shared/protocol';
import type { PageDef, Signal, SelectorLike } from '@jat13/shared/adapter-schema';
import { allNodes, matchesAny, radioAwareFieldCount, safeRx } from './labels.js';

function matchSelectorLike(nodes: SnapNode[], sel: SelectorLike): boolean {
  return nodes.some((n) => {
    if (sel.role && n.role !== sel.role) return false;
    if (sel.nameRx && !safeRx(sel.nameRx).test(n.name)) return false;
    if (sel.attr) {
      const v = n.attrs?.[sel.attr.key];
      if (typeof v !== 'string' || !safeRx(sel.attr.rx).test(v)) return false;
    }
    return true;
  });
}

/** Evaluate one classification signal against a snapshot. */
export function matchSignal(snap: PageSnapshot, sig: Signal): boolean {
  const nodes = allNodes(snap);
  if ('url' in sig) return safeRx(sig.url).test(snap.url);
  if ('selectorLike' in sig) return matchSelectorLike(nodes, sig.selectorLike);
  if ('buttonLabel' in sig) {
    return nodes.some((n) => (n.role === 'button' || n.role === 'link') && matchesAny([sig.buttonLabel], n.name));
  }
  if ('textPresent' in sig) {
    return nodes.some(
      (n) => (n.role === 'heading' || n.role === 'text' || n.role === 'alert' || n.role === 'dialog') && safeRx(sig.textPresent).test(n.name),
    );
  }
  if ('fieldCount' in sig) {
    return radioAwareFieldCount(nodes) >= (sig.fieldCount.min ?? 1);
  }
  if ('frameHost' in sig) return snap.frames.some((f) => safeRx(sig.frameHost).test(f.frameHost));
  return false;
}

/** all → AND, any → OR, none → NOT. Missing groups are vacuously satisfied. */
export function pageMatches(snap: PageSnapshot, page: PageDef): boolean {
  const { all, any, none } = page.classify;
  if (all && all.length && !all.every((s) => matchSignal(snap, s))) return false;
  if (any && any.length && !any.some((s) => matchSignal(snap, s))) return false;
  if (none && none.length && none.some((s) => matchSignal(snap, s))) return false;
  // a page with an entirely empty classify block never matches (avoids a catch-all)
  return Boolean((all && all.length) || (any && any.length) || (none && none.length));
}

/** Specificity = total signals a page declares; the most specific match wins ties. */
function specificity(page: PageDef): number {
  const c = page.classify;
  return (c.all?.length ?? 0) + (c.any?.length ?? 0) + (c.none?.length ?? 0);
}

export interface Classification {
  page: PageDef;
  key: string;
}

/**
 * The best matching page, or null (→ generic fallback / capture-and-park). When `prev` is given, a
 * match that is a legal successor of (or the same as) the previous page is preferred over any other —
 * this resolves the common ambiguity where an open apply-modal ALSO matches the underlying job_view.
 * Within each tier, the most specific (most classification signals) wins.
 */
export function classifyPage(
  snap: PageSnapshot,
  pages: readonly PageDef[],
  prev?: PageDef | null,
): Classification | null {
  const matches = pages.filter((p) => pageMatches(snap, p));
  if (matches.length === 0) return null;

  // Tier the matches so forward progress beats staying put beats an out-of-graph page. Within the
  // chosen tier, the most specific classifier wins. Without a prev (first step), every match is tier 3.
  let pool = matches;
  if (prev) {
    const successors = matches.filter((p) => p.key !== prev.key && prev.next.includes(p.key));
    const samePage = matches.filter((p) => p.key === prev.key);
    pool = successors.length ? successors : samePage.length ? samePage : matches;
  }

  let best = pool[0]!;
  for (const p of pool) if (specificity(p) > specificity(best)) best = p;
  return { page: best, key: best.key };
}

/**
 * Step-graph guard (Pillar 3 §4.3): the newly-classified page must be a legal successor of the
 * previous page (or the same page — a re-render). A violation means the site did something the adapter
 * didn't anticipate → capture-and-park 'unexpected_page', never blind-drive.
 */
export function stepGraphAllows(prev: PageDef | null, nextKey: string): boolean {
  if (!prev) return true; // first classification of the run
  if (nextKey === prev.key) return true; // same page re-rendered
  return prev.next.includes(nextKey);
}
