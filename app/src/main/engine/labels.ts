// Label normalization + snapshot traversal — the ONE place loading-prefix stripping happens
// (Pillar 3 §3.3 rule 3 / v11.86). A disabled button whose STRIPPED name matches an advance keyword
// is "present-and-waiting", never "absent" — that single v11 bug collapsed whole runs.
import type { PageSnapshot, SnapNode } from '@jat13/shared/protocol';

/** Leading loading tokens Chrome/React render before a control's real label settles. */
const LOADING_PREFIX_RX =
  /^(\s*(loading|chargement|please wait|un instant|working|processing)[\s.…·]*)+/i;

/** Strip a leading loading token (v11.86). Returns the settled label. */
export function stripLoadingPrefix(name: string): string {
  return name.replace(LOADING_PREFIX_RX, '').trim();
}

/** Canonical form for label comparison: loading-stripped, collapsed whitespace, lowercased. */
export function normalizeLabel(name: string): string {
  return stripLoadingPrefix(name).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Every node across every frame (main frame first), flattened. */
export function allNodes(snap: PageSnapshot): SnapNode[] {
  const out: SnapNode[] = [];
  for (const f of snap.frames) for (const n of f.nodes) out.push(n);
  return out;
}

/** True if `text` matches ANY of the regex strings (case-insensitive, normalized). */
export function matchesAny(patterns: readonly string[], text: string): boolean {
  const t = normalizeLabel(text);
  return patterns.some((p) => safeRx(p).test(t));
}

/** Compile a regex string defensively; a bad adapter pattern degrades to "never matches", not a throw. */
const RX_CACHE = new Map<string, RegExp>();
export function safeRx(pattern: string): RegExp {
  let rx = RX_CACHE.get(pattern);
  if (!rx) {
    try {
      rx = new RegExp(pattern, 'i');
    } catch {
      rx = /$a^/; // matches nothing
    }
    RX_CACHE.set(pattern, rx);
  }
  return rx;
}

const CONTROL_ROLES = new Set<SnapNode['role']>([
  'textbox', 'textarea', 'checkbox', 'combobox', 'select', 'file', 'radiogroup',
]);

/**
 * Radio-AWARE control count (v11.56): a radio group counts ONCE (via its group id / radiogroup node),
 * never per-radio. A radios-only screening page therefore grounds as a real form (fieldCount >= 1).
 */
export function radioAwareFieldCount(nodes: SnapNode[]): number {
  let count = 0;
  const seenGroups = new Set<number>();
  for (const n of nodes) {
    if (n.role === 'radio') {
      const g = n.group ?? -1;
      if (g >= 0 && !seenGroups.has(g)) {
        seenGroups.add(g);
        count++;
      } else if (g < 0) {
        count++; // ungrouped radio still counts
      }
    } else if (CONTROL_ROLES.has(n.role)) {
      count++;
    }
  }
  return count;
}

/** Buttons/links whose STRIPPED name matches one of `labels`, excluding `never` labels. */
export function findAdvanceCandidates(
  nodes: SnapNode[],
  labels: readonly string[],
  never: readonly string[],
): SnapNode[] {
  return nodes.filter((n) => {
    if (n.role !== 'button' && n.role !== 'link') return false;
    if (matchesAny(never, n.name)) return false;
    return matchesAny(labels, n.name);
  });
}
