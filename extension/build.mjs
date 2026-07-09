// esbuild is the ONLY emitter for the thin extension (tsc type-checks, never emits). It bundles:
//   content (sensor + actuator + content-entry) -> dist/content.js  (IIFE, no ESM — content scripts
//                                                    cannot be modules; everything self-contained)
//   sw                                           -> dist/sw.js       (ESM — manifest declares type:module)
// and copies manifest.json + popup assets beside the bundle. @jat13/shared is TS source, so it's
// bundled IN (external: none — the extension has zero runtime deps).
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'src');
const OUT = join(HERE, 'dist');

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  target: ['chrome116'],
  logLevel: 'info',
  // @jat13/shared (incl. its zod dep) is bundled in — the extension ships zero runtime deps.
  external: [],
};

function copyAssets() {
  for (const f of ['manifest.json', 'popup.html', 'popup.css', 'popup.js']) {
    cpSync(join(HERE, f), join(OUT, f));
  }
  cpSync(join(HERE, 'icons'), join(OUT, 'icons'), { recursive: true });
}

async function run() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // content script: IIFE (a content script is NOT a module context).
  const contentCtx = await esbuild.context({
    ...common,
    format: 'iife',
    platform: 'browser',
    entryPoints: [join(SRC, 'content.ts')],
    outfile: join(OUT, 'content.js'),
  });

  // service worker: ESM (manifest background.type = 'module').
  const swCtx = await esbuild.context({
    ...common,
    format: 'esm',
    platform: 'browser',
    entryPoints: [join(SRC, 'sw.ts')],
    outfile: join(OUT, 'sw.js'),
  });

  await Promise.all([contentCtx.rebuild(), swCtx.rebuild()]);
  copyAssets();
  console.log('[build:ext] wrote extension/dist (content.js, sw.js, manifest.json, popup.*)');

  if (watch) {
    await Promise.all([contentCtx.watch(), swCtx.watch()]);
    console.log('[build:ext] watching for changes…');
  } else {
    await Promise.all([contentCtx.dispose(), swCtx.dispose()]);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
