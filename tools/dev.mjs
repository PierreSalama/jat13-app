// `npm run dev` — build once, then launch Electron with the dev identity (JAT_DEV=1 → port 7861,
// userData jat13-app-dev; both flow from @jat13/shared identity inside main.ts — never here).
//
// NOTE the native-ABI dance: vitest runs better-sqlite3 under NODE's ABI, Electron needs
// ELECTRON's ABI. This launcher rebuilds for Electron first; after a dev session, run
// `npm run rebuild:node` before `npm test`.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildOnce } from './build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    c.on('error', reject);
  });
}

console.log('[dev] rebuilding better-sqlite3 for the Electron ABI…');
await run('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3'], { cwd: join(ROOT, 'app') }).catch((e) => {
  console.warn('[dev] electron-rebuild failed — launching anyway (may fail to load better-sqlite3):', e.message);
});

console.log('[dev] building bundle…');
await buildOnce();

console.log('[dev] launching Electron (dev identity)…');
const child = spawn('npx', ['electron', join(ROOT, 'app/dist/main/main.js')], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, JAT_DEV: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
