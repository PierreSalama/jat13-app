// esbuild is the ONLY emitter for the thin extension (tsc type-checks, never emits). It bundles:
//   content -> dist/content.js  (IIFE — content scripts are NOT module contexts; self-contained)
//   sw      -> dist/sw.js       (ESM — manifest declares background.type: "module")
// and copies manifest.json + popup assets + icons beside the bundles. @jat13/shared is TS source
// resolved via the workspace exports map, so it's bundled IN — the extension ships ZERO runtime deps.
//
// ── STAGE 0 MANIFEST NOTES (manifest.json cannot carry comments — they live here) ────────────────
// • NO content_scripts registration yet. content.ts IS built to dist/content.js (so the bundle
//   pipeline is proven from day one) but Chrome never injects it until Stage 2 wires the drive
//   protocol. A built-but-unregistered script is inert by construction — the dormant-by-default
//   contract starts at the manifest, not just in code.
// • permissions are the Stage-0 minimum: tabs (popup "track this page" + open dashboard),
//   storage (jat13Token/jat13Port pairing), alarms (the ONE reconnect watchdog), downloads
//   (direct installer download). "scripting" and "webNavigation" return in Stage 2 with the
//   content script + epoch-minting-on-committed-nav.
// • host_permissions is loopback-only (http://127.0.0.1/*). The site host patterns
//   (linkedin/indeed/greenhouse/lever/ashby) return in Stage 2 alongside content_scripts.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
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
  // @jat13/shared (incl. any of its deps) is bundled in — the extension ships zero runtime deps.
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
