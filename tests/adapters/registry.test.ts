// Stage 2 — the adapter registry + the five launch builtins (linkedin, indeed, greenhouse, lever,
// ashby). These tests assert the shipped recipes are DATA the app-local zod contract accepts, that
// each source routes from a representative URL to its adapter, that the registry's two laws hold
// (malformed = skip-not-crash; host-glob priority routing), and that the hard-won v11 truths survived
// the port: EEO fields NEVER autofill, Indeed's success is GROUNDED on the smartapply post-apply URL
// (v11.57/v11.61), disabled advance is present-and-waiting (v11.86), openers are never advance labels,
// and every page-level park maps to a real apply_runs.park_kind value (001_init.sql is authority).
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseAdapter, PARK_KINDS } from '../../app/src/main/adapters/schema.js';
import type { AdapterDoc } from '../../app/src/main/adapters/schema.js';
import { loadBuiltins, makeRegistry, DEFAULT_BUILTIN_DIR } from '../../app/src/main/adapters/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(HERE, '../../app/src/main/adapters/builtin');

// id ← (source, expected id, one representative URL that must route to it).
const EXPECTED = {
  linkedin: { id: 'linkedin-easy-apply', url: 'https://www.linkedin.com/jobs/view/123' },
  indeed: { id: 'indeed-smartapply', url: 'https://ca.indeed.com/viewjob?jk=abc123' },
  greenhouse: { id: 'greenhouse-form', url: 'https://boards.greenhouse.io/acme/jobs/456' },
  lever: { id: 'lever-form', url: 'https://jobs.lever.co/acme/7c9d-1234' },
  ashby: { id: 'ashby-form', url: 'https://jobs.ashbyhq.com/acme/uuid-here' },
} as const;

const ALL_IDS = Object.values(EXPECTED).map((e) => e.id);

/** index adapters by id for direct lookup. */
function indexById(docs: readonly AdapterDoc[]): Map<string, AdapterDoc> {
  return new Map(docs.map((d) => [d.id, d]));
}

describe('loadBuiltins — all five launch adapters', () => {
  it('returns all 5 builtins, each with a distinct id', () => {
    const docs = loadBuiltins(BUILTIN_DIR);
    const ids = docs.map((d) => d.id);
    for (const id of ALL_IDS) expect(ids).toContain(id);
    // no dupes among the launch set
    expect(new Set(ids).size).toBe(ids.length);
    expect(docs.length).toBeGreaterThanOrEqual(5);
  });

  it('the no-arg default dir resolves the shipped builtins beside the source module', () => {
    // DEFAULT_BUILTIN_DIR is computed from the registry module's own location; un-bundled (vitest)
    // that is the source builtin/ dir. This is the dev/test path; production passes an explicit dir.
    expect(DEFAULT_BUILTIN_DIR.replace(/\\/g, '/')).toContain('adapters/builtin');
    const ids = loadBuiltins().map((d) => d.id);
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });

  it('every builtin parseAdapter()s clean end-to-end (round-trip)', () => {
    for (const doc of loadBuiltins(BUILTIN_DIR)) {
      // round-trip through the zod contract — a malformed recipe would throw here.
      expect(() => parseAdapter(doc), `adapter ${doc.id} must satisfy the schema`).not.toThrow();
    }
  });

  it('each source declares the right source enum', () => {
    const byId = indexById(loadBuiltins(BUILTIN_DIR));
    expect(byId.get('linkedin-easy-apply')?.source).toBe('linkedin');
    expect(byId.get('indeed-smartapply')?.source).toBe('indeed');
    expect(byId.get('greenhouse-form')?.source).toBe('greenhouse');
    expect(byId.get('lever-form')?.source).toBe('lever');
    expect(byId.get('ashby-form')?.source).toBe('ashby');
  });
});

describe('registry law 1 — a malformed adapter is skipped, never a crash', () => {
  it('drops the bad file, keeps the good ones, and does not throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jat13-adapters-'));
    try {
      // one VALID recipe (a real builtin, copied), one non-JSON file, one JSON that fails the schema.
      const good = readFileSync(join(BUILTIN_DIR, 'lever.json'), 'utf8');
      writeFileSync(join(dir, 'lever.json'), good);
      writeFileSync(join(dir, 'not-json.json'), '{ this is : not valid json ]');
      writeFileSync(join(dir, 'bad-schema.json'), JSON.stringify({ id: 'x', hosts: 'nope' }));
      let docs: AdapterDoc[] = [];
      expect(() => { docs = loadBuiltins(dir); }).not.toThrow();
      expect(docs.map((d) => d.id)).toEqual(['lever-form']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing builtin dir yields [] (no builtins), never a throw', () => {
    let docs: AdapterDoc[] = [];
    expect(() => { docs = loadBuiltins(join(tmpdir(), 'jat13-does-not-exist-xyz')); }).not.toThrow();
    expect(docs).toEqual([]);
  });

  it('parseAdapter throws on a structurally-invalid doc', () => {
    expect(() => parseAdapter({})).toThrow();
    expect(() => parseAdapter({ id: 'x', version: 1, hosts: [] })).toThrow();
  });
});

describe('resolveForUrl — host-glob priority routing (never CSS/class)', () => {
  const reg = makeRegistry(loadBuiltins(BUILTIN_DIR));
  for (const [source, { id, url }] of Object.entries(EXPECTED)) {
    it(`${source}: ${url} → ${id}`, () => {
      expect(reg.resolveForUrl(url)?.id).toBe(id);
    });
  }

  it('greenhouse job-boards host also routes to the greenhouse adapter (apex glob covers the label)', () => {
    expect(reg.resolveForUrl('https://job-boards.greenhouse.io/acme/jobs/1')?.id).toBe('greenhouse-form');
  });

  it('the apex domain (no subdomain) still matches a *.host glob', () => {
    expect(reg.resolveForUrl('https://linkedin.com/jobs/view/9')?.id).toBe('linkedin-easy-apply');
  });

  it('a smartapply.indeed.com form URL still routes to the indeed adapter', () => {
    expect(reg.resolveForUrl('https://smartapply.indeed.com/beta/indeedapply/form/resume')?.id).toBe(
      'indeed-smartapply',
    );
  });

  it('an unknown host resolves to null (caller takes the generic / capture-and-park path)', () => {
    expect(reg.resolveForUrl('https://workday.myworkdayjobs.com/acme/job/1')).toBeNull();
    expect(reg.resolveForUrl('https://example.com/whatever')).toBeNull();
  });

  it('an unparseable URL resolves to null, never throws', () => {
    expect(reg.resolveForUrl('not a url')).toBeNull();
    expect(reg.resolveForUrl('')).toBeNull();
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
    const parksResume = indeed.pages.some((p) => p.parkIf?.some((r) => r.parkKind === 'resume_required'));
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

  it('finalLabels ⊆ labels and disabled advance is present-and-waiting (opener-vs-advance split, v11.86)', () => {
    for (const doc of loadBuiltins(BUILTIN_DIR)) {
      for (const fl of doc.advance.finalLabels) {
        expect(doc.advance.labels, `${doc.id}: finalLabel ${fl} must be in labels`).toContain(fl);
      }
      expect(doc.advance.disabledIsWaiting).toBe(true);
    }
  });

  it('every page-level park maps to a real apply_runs.park_kind value (migration is authority)', () => {
    for (const doc of loadBuiltins(BUILTIN_DIR)) {
      for (const page of doc.pages) {
        for (const trigger of page.parkIf ?? []) {
          expect(
            PARK_KINDS as readonly string[],
            `${doc.id}/${page.key}: parkKind ${trigger.parkKind} must be a migration park_kind`,
          ).toContain(trigger.parkKind);
        }
      }
    }
  });

  it('linkedin supports BOTH the modal and full-page /apply/ layouts (v11.27)', () => {
    const li = indexById(loadBuiltins(BUILTIN_DIR)).get('linkedin-easy-apply')!;
    const keys = li.pages.map((p) => p.key);
    expect(keys).toContain('apply_modal');
    expect(keys).toContain('apply_fullpage');
    // never select by class — encoded as a documented quirk.
    expect(li.quirks?.neverSelectByClass).toBeDefined();
  });
});
