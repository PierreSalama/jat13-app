// The adapter registry — the app's map from a URL to the recipe that drives it (01-ARCHITECTURE §2).
// For Stage 2 this loads validated builtins straight off disk; DB-backed versioning / hot-reload /
// rollback layer on later. Two laws hold from day one:
//   1. A malformed adapter is SKIPPED with a logged warning, never a crash — one bad recipe must not
//      wedge boot (mirrors the migrations loader's "loud but survivable" stance).
//   2. Routing is by host GLOB + priority only (never CSS/class — the LinkedIn obfuscated-class scar,
//      §4.1) — the highest-priority adapter whose hosts[] matches the URL's host wins; ties break by
//      declaration order.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAdapter } from './schema.js';
import type { AdapterDoc } from './schema.js';

// builtins live beside THIS module (src/main/adapters/builtin). tests + `npm run dev` (un-bundled)
// resolve relative to the SOURCE via import.meta.url; the packaged/bundled app passes an EXPLICIT dir
// (build.mjs copies builtin/ → dist/main/adapters/builtin; electron-builder ships it beside the exe),
// exactly like the migrations loader — production never trusts import.meta.url pointing at a bundle.
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BUILTIN_DIR = join(HERE, 'builtin');

/**
 * Load every `*.json` in `dir`, validating each through parseAdapter(). A file that fails to read,
 * parse as JSON, or validate against the schema is dropped with a `console.warn` and the load continues.
 * Result is sorted by priority DESC so callers see highest-priority adapters first.
 */
export function loadBuiltins(dir: string = DEFAULT_BUILTIN_DIR): AdapterDoc[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    console.warn(`[jat13] adapter registry: cannot read builtin dir ${dir} — no builtins loaded`, err);
    return [];
  }

  const docs: AdapterDoc[] = [];
  for (const file of files.sort()) {
    const path = join(dir, file);
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      docs.push(parseAdapter(raw));
    } catch (err) {
      // never crash boot on one bad recipe — skip it, keep the rest (law 1).
      console.warn(`[jat13] adapter registry: skipping malformed adapter ${file}`, err);
    }
  }

  // stable: priority DESC, then original (alphabetical file) order — deterministic tie-breaking.
  return docs
    .map((doc, i) => ({ doc, i }))
    .sort((a, b) => b.doc.priority - a.doc.priority || a.i - b.i)
    .map(({ doc }) => doc);
}

/**
 * Translate a hosts[] glob (only `*` wildcards, e.g. `*.linkedin.com`) into an anchored regex. `*`
 * matches any run of chars within ONE host label (no dot-crossing), so `*.linkedin.com` matches
 * `www.linkedin.com` AND the apex `linkedin.com`. Every other char is escaped — a glob is data,
 * never a source of regex injection.
 */
function hostGlobToRegex(glob: string): RegExp {
  const escaped = glob
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex metachars (NOT '*', handled next)
    .replace(/\*/g, '[^.]*'); // '*' is one host label segment (no dot-crossing)
  // a leading `*.` should also match the apex domain, so make the `[^.]*\.` prefix optional.
  const pattern = escaped.startsWith('[^.]*\\.') ? `(?:[^.]*\\.)?${escaped.slice('[^.]*\\.'.length)}` : escaped;
  return new RegExp(`^${pattern}$`);
}

function hostMatches(host: string, globs: readonly string[]): boolean {
  const h = host.toLowerCase();
  return globs.some((g) => hostGlobToRegex(g).test(h));
}

export interface Registry {
  /** Highest-priority adapter whose hosts[] glob matches `url`'s host; null if none (or url unparseable). */
  resolveForUrl(url: string): AdapterDoc | null;
  /** All docs, priority DESC (the same list resolveForUrl scans). */
  all(): readonly AdapterDoc[];
}

/**
 * Build a registry over `docs`. `resolveForUrl` extracts the URL's host and returns the first (thus
 * highest-priority, since loadBuiltins pre-sorts) adapter whose hosts[] matches. An unparseable URL
 * or a URL with no host resolves to null — the caller then takes the generic-fallback / capture-and-park path.
 */
export function makeRegistry(docs: readonly AdapterDoc[]): Registry {
  // defensive: if a caller hands us an unsorted list, sort a copy so resolveForUrl's "first match wins"
  // is always highest-priority-wins.
  const ordered = [...docs]
    .map((doc, i) => ({ doc, i }))
    .sort((a, b) => b.doc.priority - a.doc.priority || a.i - b.i)
    .map(({ doc }) => doc);

  return {
    resolveForUrl(url: string): AdapterDoc | null {
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        return null;
      }
      if (!host) return null;
      return ordered.find((doc) => hostMatches(host, doc.hosts)) ?? null;
    },
    all(): readonly AdapterDoc[] {
      return ordered;
    },
  };
}
