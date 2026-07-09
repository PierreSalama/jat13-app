// Version-drift gate: every workspace package.json must carry the SAME version as the root.
// A JAT v11 scar — the extension/app/dashboard drifting out of lockstep shipped mismatched builds.
// Usage: node tools/validate-versions.mjs [--check]   (exit 1 on drift)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const root = read('package.json');
const want = root.version;
const members = ['shared/package.json', 'app/package.json', 'extension/package.json'];

const drift = [];
for (const m of members) {
  const v = read(m).version;
  if (v !== want) drift.push(`${m}: ${v} (expected ${want})`);
}

if (drift.length) {
  console.error(`✗ version drift (root is ${want}):\n  ` + drift.join('\n  '));
  process.exit(1);
}
console.log(`✓ all workspaces at ${want}`);
