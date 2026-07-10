// esbuild is the ONLY emitter (tsc type-checks, never emits — MASTER-PLAN C1). Bundles:
//   main    -> dist/main/main.js   (ESM; Electron 42 ESM main)
//   preload -> dist/main/preload.cjs (CJS; sandboxed preloads must be CommonJS)
// and copies the SQL migrations + renderer beside the bundle so main.ts's runtime path resolution
// (join(HERE,'db','migrations') / ../renderer) holds in dev and packaged builds alike.
//
// External = every runtime dependency (native better-sqlite3, electron, node built-ins) — only our
// own source (+ the @jat13/shared TS package) is bundled. Keeps native ABI out of the bundle.
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
const external = ['electron', ...Object.keys(appPkg.dependencies).filter((d) => d !== '@jat13/shared')];

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  external,
};

// Copy the runtime assets the bundles resolve at runtime (SQL migrations + builtin adapters), plus the
// renderer's STATIC files (index.html + styles.css). The renderer's TS is NOT copied — it is bundled by
// esbuild (see rendererCtx below); index.html loads ./main.js (the bundle) + ./styles.css.
function copyAssets() {
  cpSync(join(APP, 'src/main/db/migrations'), join(OUT, 'main/db/migrations'), { recursive: true });
  cpSync(join(APP, 'src/main/adapters/builtin'), join(OUT, 'main/adapters/builtin'), { recursive: true });
  mkdirSync(join(OUT, 'renderer'), { recursive: true });
  cpSync(join(APP, 'src/renderer/index.html'), join(OUT, 'renderer/index.html'));
  cpSync(join(APP, 'src/renderer/styles.css'), join(OUT, 'renderer/styles.css'));
  // the renderer is plain JS — main.js is bundled below (it imports lib/themes.js, so the registry is
  // in the bundle), but we also copy lib/ verbatim so its ESM source ships beside the bundle.
  cpSync(join(APP, 'src/renderer/lib'), join(OUT, 'renderer/lib'), { recursive: true });
  // tray icon — loaded at runtime by main.ts via join(HERE,'icon.ico'); ships inside the asar in dev + packaged.
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
  // Renderer bundle: browser target, everything bundled (no node externals — the renderer has no node
  // deps; @jat13/shared, if ever imported by a view, is source-bundled too). ESM module the <script
  // type="module"> loads. Sourcemaps for dev debuggability.
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
