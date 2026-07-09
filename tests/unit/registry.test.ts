// The registry is the URL→recipe map. These tests assert the two laws that keep it safe (Pillar 3 §4):
//   - a malformed adapter is SKIPPED, never fatal (boot survives one bad recipe);
//   - routing is host-glob + priority only, and the shipped linkedin doc validates clean end-to-end.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAdapter } from '@jat13/shared/adapter-schema';
import type { AdapterDoc } from '@jat13/shared/adapter-schema';
import { loadBuiltins, makeRegistry } from '../../app/src/main/adapters/registry.js';

// the real builtins ship beside registry.ts (app/src/main/adapters/builtin). Resolve that dir from
// THIS test file's location (mirrors how the migrations tests reach app/src/main/db/migrations).
const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(HERE, '../../app/src/main/adapters/builtin');

describe('loadBuiltins', () => {
  it('finds and validates the linkedin-easy-apply builtin', () => {
    const docs = loadBuiltins(BUILTIN_DIR);
    const li = docs.find((d) => d.id === 'linkedin-easy-apply');
    expect(li).toBeDefined();
    expect(li?.source).toBe('linkedin');
    expect(li?.hosts).toContain('*.linkedin.com');
  });

  it('exposes the full linkedin page graph', () => {
    const docs = loadBuiltins(BUILTIN_DIR);
    const li = docs.find((d) => d.id === 'linkedin-easy-apply')!;
    const keys = li.pages.map((p) => p.key).sort();
    expect(keys).toEqual(
      ['already_applied', 'apply_fullpage', 'apply_modal', 'confirmation', 'external_posting', 'job_view', 'review'],
    );
    // the submit label is the ONLY final label (arms the success oracles), and the opener is never an advance.
    expect(li.advance.finalLabels).toEqual(['^submit application$']);
    expect(li.advance.neverLabels).toContain('^easy apply');
    // v11.86 law: a disabled advance is present-and-waiting, never absent.
    expect(li.advance.disabledIsWaiting).toBe(true);
  });

  it('sorts loaded docs by priority DESC', () => {
    const docs = loadBuiltins(BUILTIN_DIR);
    for (let i = 1; i < docs.length; i++) {
      expect(docs[i - 1]!.priority).toBeGreaterThanOrEqual(docs[i]!.priority);
    }
  });

  it('skips a malformed adapter with a warning instead of crashing (law 1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jat13-adapters-'));
    try {
      writeFileSync(join(dir, 'broken-json.json'), '{ not valid json', 'utf8');
      writeFileSync(join(dir, 'invalid-schema.json'), JSON.stringify({ id: 'x', version: 'nope' }), 'utf8');
      writeFileSync(
        join(dir, 'good.json'),
        JSON.stringify(minimalAdapter('good-adapter', ['*.example.com'], 50)),
        'utf8',
      );
      const docs = loadBuiltins(dir);
      // the two bad files are dropped; only the valid one survives.
      expect(docs.map((d) => d.id)).toEqual(['good-adapter']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for a missing dir without throwing', () => {
    expect(loadBuiltins(join(tmpdir(), 'jat13-does-not-exist-xyz'))).toEqual([]);
  });
});

describe('makeRegistry.resolveForUrl', () => {
  it('resolves a linkedin jobs URL to the linkedin adapter', () => {
    const reg = makeRegistry(loadBuiltins(BUILTIN_DIR));
    const doc = reg.resolveForUrl('https://www.linkedin.com/jobs/view/1');
    expect(doc?.id).toBe('linkedin-easy-apply');
  });

  it('matches the apex domain via the leading *. glob', () => {
    const reg = makeRegistry(loadBuiltins(BUILTIN_DIR));
    expect(reg.resolveForUrl('https://linkedin.com/jobs/view/1')?.id).toBe('linkedin-easy-apply');
  });

  it('returns null for a host no adapter claims', () => {
    const reg = makeRegistry(loadBuiltins(BUILTIN_DIR));
    expect(reg.resolveForUrl('https://example.com')).toBeNull();
    expect(reg.resolveForUrl('https://notlinkedin.com/jobs/view/1')).toBeNull();
  });

  it('returns null for an unparseable URL', () => {
    const reg = makeRegistry(loadBuiltins(BUILTIN_DIR));
    expect(reg.resolveForUrl('not a url')).toBeNull();
  });

  it('picks the highest-priority adapter when several match the host', () => {
    const low = minimalAdapter('low', ['*.linkedin.com'], 10);
    const high = minimalAdapter('high', ['*.linkedin.com'], 200);
    // hand them in low-first to prove makeRegistry re-sorts by priority, not insertion order.
    const reg = makeRegistry([low, high]);
    expect(reg.resolveForUrl('https://www.linkedin.com/jobs/view/1')?.id).toBe('high');
  });

  it('does not cross a dot boundary with a single * segment', () => {
    // '*.example.com' must NOT match a deeper subdomain that the single-segment glob can't reach past a dot.
    const reg = makeRegistry([minimalAdapter('ex', ['*.example.com'], 10)]);
    expect(reg.resolveForUrl('https://a.b.example.com')).toBeNull();
    expect(reg.resolveForUrl('https://sub.example.com')?.id).toBe('ex');
  });
});

describe('the shipped linkedin adapter parses clean', () => {
  it('parseAdapter() accepts it end-to-end', () => {
    const docs = loadBuiltins(BUILTIN_DIR);
    const li = docs.find((d) => d.id === 'linkedin-easy-apply')!;
    // round-trip through parseAdapter to prove it satisfies the shared zod contract exactly.
    expect(() => parseAdapter(li)).not.toThrow();
    const reparsed = parseAdapter(li);
    expect(reparsed.oracles.success.length).toBeGreaterThan(0);
    expect(reparsed.oracles.humanGate.length).toBeGreaterThan(0);
    expect(reparsed.fieldMap.some((f) => f.neverAutofill === true)).toBe(true);
  });
});

/** A minimal but schema-valid adapter, for the malformed-skip and priority-ordering tests. */
function minimalAdapter(id: string, hosts: string[], priority: number): AdapterDoc {
  return {
    id,
    version: 1,
    engineMin: '1.0.0',
    source: 'generic',
    hosts,
    priority,
    pages: [
      {
        key: 'form',
        kind: 'form',
        classify: { any: [{ fieldCount: { min: 1, radioAware: true } }] },
        next: ['confirmation'],
      },
      {
        key: 'confirmation',
        kind: 'confirmation',
        classify: { any: [{ textPresent: 'submitted' }] },
        next: [],
      },
    ],
    fieldMap: [],
    advance: {
      labels: ['^submit$'],
      finalLabels: ['^submit$'],
      neverLabels: [],
      disabledIsWaiting: true,
      waitEnabledMs: 10000,
      maxLabelLen: 40,
    },
    oracles: { success: [], failure: [], humanGate: [] },
    limits: { maxSteps: 4, maxSameActionRepeat: 2 },
  };
}
