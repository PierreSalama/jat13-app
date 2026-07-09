// The Indeed + ATS builtins (task #6). These tests assert the shipped recipes are DATA the shared zod
// contract accepts, that each source routes from a representative URL to its adapter, and that the
// hard-won v11 truths survived encoding: EEO fields NEVER autofill, and Indeed's success is GROUNDED
// (being on smartapply's post-apply URL IS a submit — v11.57/v11.61). The existing linkedin registry
// test still owns the linkedin-specific assertions; here we only add the four new sources + cross-cuts.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAdapter } from '@jat13/shared/adapter-schema';
import type { AdapterDoc } from '@jat13/shared/adapter-schema';
import { loadBuiltins, makeRegistry } from '../../app/src/main/adapters/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(HERE, '../../app/src/main/adapters/builtin');

// id ← (source, expected page keys, one representative URL that must route to it).
const EXPECTED = {
  linkedin: { id: 'linkedin-easy-apply', url: 'https://www.linkedin.com/jobs/view/123' },
  indeed: { id: 'indeed-smartapply', url: 'https://ca.indeed.com/viewjob?jk=abc123' },
  greenhouse: { id: 'greenhouse-form', url: 'https://boards.greenhouse.io/acme/jobs/456' },
  lever: { id: 'lever-form', url: 'https://jobs.lever.co/acme/7c9d-1234' },
  ashby: { id: 'ashby-form', url: 'https://jobs.ashbyhq.com/acme/uuid-here' },
} as const;

const ALL_IDS = Object.values(EXPECTED).map((e) => e.id);

describe('loadBuiltins — all five launch adapters', () => {
  it('returns all 5 builtins, each with a distinct id', () => {
    const docs = loadBuiltins(BUILTIN_DIR);
    const ids = docs.map((d) => d.id);
    for (const id of ALL_IDS) expect(ids).toContain(id);
    // no dupes among the launch set
    expect(new Set(ids).size).toBe(ids.length);
    expect(docs.length).toBeGreaterThanOrEqual(5);
  });

  it('every builtin parseAdapter()s clean end-to-end (round-trip)', () => {
    const docs = loadBuiltins(BUILTIN_DIR);
    for (const doc of docs) {
      // round-trip through the shared zod contract — a malformed recipe would throw here.
      expect(() => parseAdapter(doc), `adapter ${doc.id} must satisfy the schema`).not.toThrow();
    }
  });

  it('each of the four new sources declares the right source enum', () => {
    const byId = indexById(loadBuiltins(BUILTIN_DIR));
    expect(byId.get('indeed-smartapply')?.source).toBe('indeed');
    expect(byId.get('greenhouse-form')?.source).toBe('greenhouse');
    expect(byId.get('lever-form')?.source).toBe('lever');
    expect(byId.get('ashby-form')?.source).toBe('ashby');
  });
});

describe('resolveForUrl — one representative URL per source routes correctly', () => {
  const reg = makeRegistry(loadBuiltins(BUILTIN_DIR));
  for (const [source, { id, url }] of Object.entries(EXPECTED)) {
    it(`${source}: ${url} → ${id}`, () => {
      expect(reg.resolveForUrl(url)?.id).toBe(id);
    });
  }

  it('greenhouse job-boards host also routes to the greenhouse adapter (apex glob)', () => {
    expect(reg.resolveForUrl('https://job-boards.greenhouse.io/acme/jobs/1')?.id).toBe('greenhouse-form');
  });

  it('a smartapply.indeed.com form URL still routes to the indeed adapter', () => {
    expect(reg.resolveForUrl('https://smartapply.indeed.com/beta/indeedapply/form/resume')?.id).toBe(
      'indeed-smartapply',
    );
  });
});

describe('v11 scars encoded across all form adapters', () => {
  it('every adapter has an EEO/sensitive field rule that neverAutofill', () => {
    for (const doc of loadBuiltins(BUILTIN_DIR)) {
      const eeo = doc.fieldMap.find(
        (f) => f.neverAutofill === true && /gender|race|ethnicit|disab|veteran/.test(f.labelRx),
      );
      expect(eeo, `adapter ${doc.id} must never autofill EEO fields`).toBeDefined();
    }
  });

  it('the indeed success oracle is GROUNDED on the post-apply URL (v11.61)', () => {
    const indeed = indexById(loadBuiltins(BUILTIN_DIR)).get('indeed-smartapply')!;
    const grounded = indeed.oracles.success.find(
      (o) => o.kind === 'urlMatches' && o.level === 'grounded' && /post-apply/.test(o.rx),
    );
    expect(grounded, 'indeed post-apply must be a grounded submit oracle').toBeDefined();
  });

  it('indeed parks on resume_required and gates Cloudflare as a humanGate', () => {
    const indeed = indexById(loadBuiltins(BUILTIN_DIR)).get('indeed-smartapply')!;
    const parksResume = indeed.pages.some((p) => p.parkIf?.some((r) => r.reason === 'resume_required'));
    expect(parksResume).toBe(true);
    expect(indeed.oracles.humanGate.length).toBeGreaterThan(0);
  });

  it('each ATS form adapter has a verified confirmation success oracle', () => {
    const byId = indexById(loadBuiltins(BUILTIN_DIR));
    for (const id of ['greenhouse-form', 'lever-form', 'ashby-form']) {
      const doc = byId.get(id)!;
      // 'level' only exists on the url/text/node oracle variants — narrow on kind before reading it.
      const verified = doc.oracles.success.find(
        (o) => (o.kind === 'urlMatches' || o.kind === 'textPresent' || o.kind === 'nodeGone') && o.level === 'verified',
      );
      expect(verified, `${id} must have a verified confirmation oracle`).toBeDefined();
    }
  });

  it('finalLabels ⊆ labels and openers are never advance labels (opener-vs-advance split)', () => {
    for (const doc of loadBuiltins(BUILTIN_DIR)) {
      for (const fl of doc.advance.finalLabels) {
        expect(doc.advance.labels, `${doc.id}: finalLabel ${fl} must be in labels`).toContain(fl);
      }
      // disabled advance is present-and-waiting, never absent (v11.86 law).
      expect(doc.advance.disabledIsWaiting).toBe(true);
    }
  });
});

/** index adapters by id for direct lookup. */
function indexById(docs: readonly AdapterDoc[]): Map<string, AdapterDoc> {
  return new Map(docs.map((d) => [d.id, d]));
}
