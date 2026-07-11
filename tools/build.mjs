// esbuild is the ONLY emitter (tsc type-checks, never emits). Bundles:
//   main     -> app/dist/main/main.js       (ESM; Electron 42 ESM main)
//   preload  -> app/dist/main/preload.cjs   (CJS; sandboxed preloads must be CommonJS)
//   renderer -> app/dist/renderer/main.js   (ESM browser bundle the <script type="module"> loads)
// and copies the runtime assets beside the bundles so main.ts's path resolution
// (join(HERE,'db','migrations') / ../renderer / join(HERE,'icon.ico')) holds in dev AND packaged.
//
// External = electron + every real npm/native dep of the app (better-sqlite3 above all — native
// ABI must NEVER end up inside a bundle). Only our own source + the @jat13/shared TS package is
// bundled. The list is derived from app/package.json so a new dep can't silently get inlined.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'app');
const OUT = join(APP, 'dist');

const appPkg = require(join(APP, 'package.json'));
// bundle @jat13/shared (TS source) but externalize every real npm/native dep.
const external = [
  'electron',
  ...Object.keys(appPkg.dependencies ?? {}).filter((d) => d !== '@jat13/shared'),
];
// Loud-on-unknown: the one external that is non-negotiable. If better-sqlite3 ever leaves
// app/package.json dependencies, the bundle would inline the native binding and break at runtime
// in a way that only surfaces on launch — fail the build instead.
if (!external.includes('better-sqlite3')) {
  throw new Error('[build] app/package.json must declare better-sqlite3 as a dependency (native, must stay external)');
}

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node24', // Electron 42 embeds Node 24
  sourcemap: true,
  logLevel: 'info',
  external,
};

// Copy the runtime assets the bundles resolve at runtime. The renderer's index.html/styles.css/lib
// are copied VERBATIM (lib/ is plain ESM source shipped beside the bundle); the renderer entry
// main.js is bundled below, not copied. Copies are loud: a missing source dir throws — a skeleton
// that "builds" without its migrations or shell is exactly the half-pipeline class we're killing.
function copyAssets() {
  cpSync(join(APP, 'src/main/db/migrations'), join(OUT, 'main/db/migrations'), { recursive: true });
  // Adapter builtins (Stage 2): the generic driver loads these JSON recipes at runtime via
  // resourceDir('adapters/builtin') (main.ts), mirroring the migrations resolution. Ship them beside
  // the bundle so `npm run dev` resolves them; electron-builder's extraResources ships them packaged.
  cpSync(join(APP, 'src/main/adapters/builtin'), join(OUT, 'main/adapters/builtin'), { recursive: true });
  mkdirSync(join(OUT, 'renderer'), { recursive: true });
  cpSync(join(APP, 'src/renderer/index.html'), join(OUT, 'renderer/index.html'));
  cpSync(join(APP, 'src/renderer/styles.css'), join(OUT, 'renderer/styles.css'));
  cpSync(join(APP, 'src/renderer/lib'), join(OUT, 'renderer/lib'), { recursive: true });
  // tray icon — loaded at runtime by main.ts via join(HERE,'icon.ico'); ships in dev + packaged.
  cpSync(join(APP, 'build/icon.ico'), join(OUT, 'main/icon.ico'));
}

export async function buildOnce({ watch = false } = {}) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'main'), { recursive: true });

  const mainCtx = await esbuild.context({
    ...shared,
    format: 'esm',
    entryPoints: [join(APP, 'src/main/main.ts')],
    outfile: join(OUT, 'main/main.js'),
  });
  const preloadCtx = await esbuild.context({
    ...shared,
    format: 'cjs',
    entryPoints: [join(APP, 'src/preload/preload.ts')],
    outfile: join(OUT, 'main/preload.cjs'),
  });
  // Renderer bundle: browser target, everything bundled (the renderer has no node deps;
  // @jat13/shared, if imported by a view, is source-bundled too).
  const rendererCtx = await esbuild.context({
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    sourcemap: true,
    logLevel: 'info',
    entryPoints: [join(APP, 'src/renderer/main.js')],
    outfile: join(OUT, 'renderer/main.js'),
  });

  await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild(), rendererCtx.rebuild()]);
  copyAssets();

  if (watch) {
    await Promise.all([mainCtx.watch(), preloadCtx.watch(), rendererCtx.watch()]);
    console.log('[build] watching for changes…');
    return { dispose: async () => Promise.all([mainCtx.dispose(), preloadCtx.dispose(), rendererCtx.dispose()]) };
  }
  await Promise.all([mainCtx.dispose(), preloadCtx.dispose(), rendererCtx.dispose()]);
  console.log(`[build] emitted -> ${join(OUT, 'main/main.js')} + ${join(OUT, 'renderer/main.js')}`);
  return { dispose: async () => {} };
}

// CLI entry (node tools/build.mjs [--watch])
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildOnce({ watch: process.argv.includes('--watch') }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
