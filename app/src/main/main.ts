// Electron main = the brain's entrypoint. Boots the single writer (better-sqlite3), migrates, opens
// the loopback server (REST API, /drive ws arrives Stage 2), keeps itself tray-resident, opens the
// Atelier window. One process owns the DB, the port, and the socket; a second instance must never
// race it — hence the single-instance lock.
//
// Stage-0 scope (rebuild plan 02-STAGES §0): skeleton + harness ONLY. No engine, no gmail, no AI,
// no importer — those subsystems don't exist yet and nothing here may reference them. The lifecycle
// below is the PROVEN 13.0.1 shape (tray + quitting flag + frontOrCreate + SMOKE), which fixed the
// live-run failures: closing the window killed the brain → extension unpaired + popup "finish setup"
// + dead browser dashboard (v13-postmortem failure #2).
import { app, BrowserWindow, ipcMain, safeStorage, shell, Tray, Menu, nativeImage } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './db/index.js';
import { startServer, type RunningServer } from './server/index.js';
import { mountApi } from './server/api.js';
import { ensurePairingToken } from './server/pairing.js';
import { makeDal, defaultContext, type Dal, type Sealer } from './db/dal/index.js';
import { makeDevDrive } from './server/devdrive.js';
import { mountDataRoutes, type DataDal, type ImporterPort } from './server/routes-data.js';
import { mountApplyRoutes } from './server/routes-apply.js';
import { mountLearnApi } from './learn/index.js';
import { makeLearnDistiller } from './learn/distiller.js';
import { loadBuiltins, makeRegistry, type Registry } from './adapters/registry.js';
import { WsGateway } from './engine/ws-gateway.js';
import { makeRunService, type RunService, type FitPort } from './engine/run-service.js';
import { makeFitService } from './engine/fit.js';
import { makeDismissalsDal, type DismissReason } from './db/dal/dismissals.js';
import { makeDiscoveryDal } from './db/dal/discovery.js';
import { makeIngest } from './discovery/ingest.js';
import { makeDiscoveryService } from './discovery/service.js';
import { mountTrackRoutes } from './server/routes-track.js';
import { mountAutoRoutes } from './server/routes-auto.js';
import { snapshotV11, planImport, executeImport } from './importer/v11.js';
import { migrateGmailCredentials } from './importer/gmail-creds.js';
import type { Server as HttpServer } from 'node:http';
import { IDENTITY, PORTS } from '@jat13/shared';

/** v11 sealed values are `enc:v1:` + base64(DPAPI); same OS user → v13 safeStorage decrypts them. */
function unsealV11(stored: string): string {
  const PREFIX = 'enc:v1:';
  if (!stored.startsWith(PREFIX) || !safeStorage.isEncryptionAvailable()) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'));
  } catch {
    return '';
  }
}

const HERE = dirname(fileURLToPath(import.meta.url)); // dist/main at runtime
const DEV = !app.isPackaged || process.env.JAT_DEV === '1';
// SMOKE = headless boot proof: migrate, serve, self-check /health, exit 0/1. CI's cheapest "boot must
// be flawless" gate — keep it forever (it caught nothing in v13 only because it was never wired to CI).
const SMOKE = process.env.JAT_SMOKE === '1';
// dev-drive: the in-app remote-control test channel (navigate/click/fill/inspect/screenshot over
// loopback — the never-debug-blindly harness). On for dev builds, or opt-in via env for a packaged
// build. Loopback + token still guard it; it never touches the apply/data path.
const DEVTOOLS = DEV || process.env.JAT_DEVTOOLS === '1';

let server: RunningServer | undefined;
let db: Database | undefined;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false; // true only when the user chose Quit — lets window-all-closed keep the brain alive otherwise

if (!SMOKE && !app.requestSingleInstanceLock()) app.exit(0);

/** Packaged builds resolve shipped assets (db/migrations) beside the exe; dev resolves from dist/main. */
const resourceDir = (rel: string): string =>
  app.isPackaged ? join(process.resourcesPath, rel) : join(HERE, rel);

/** Electron safeStorage (DPAPI on Windows) sealer for the secrets DAL (pairing token at rest);
 *  degrades to plaintext with a loud warning rather than refusing to boot. */
const sealer: Sealer = {
  available: () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
  seal: (p) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(p) : Buffer.from(p, 'utf8')),
  open: (b) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(b)) : Buffer.from(b).toString('utf8')),
};

async function boot(): Promise<void> {
  // Dev identity is a SEPARATE userData dir + port so `npm run dev` never touches a prod install's
  // data. JAT_USERDATA is the explicit override for tests/verify runs (throwaway DBs).
  if (DEV) app.setPath('userData', join(app.getPath('appData'), IDENTITY.userDataDev));
  if (process.env.JAT_USERDATA) app.setPath('userData', process.env.JAT_USERDATA);

  const dbFile = join(app.getPath('userData'), 'jat13.db');
  const opened = openDatabase({ file: dbFile, migrationsDir: resourceDir('db/migrations') });
  db = opened.db;

  const dal: Dal = makeDal(defaultContext(db), { sealer });
  const token = ensurePairingToken(dal);
  const devDrive = DEVTOOLS
    ? makeDevDrive({ getWindow: () => mainWindow, log: (m) => console.log(`[devdrive] ${m}`) })
    : undefined;

  // Stage 2-3 apply engine: adapter registry, the /drive gateway (attached below), deterministic fit,
  // the supervised run-service (scheduler + single-apply), discovery supply, and the permanent-dismiss
  // DAL. The run-service depends only on the RunGateway interface, so the survival + scheduler tests
  // prove the whole drive headlessly with a FakeExtension.
  const registry: Registry = makeRegistry(loadBuiltins(resourceDir('adapters/builtin')));
  const gateway = new WsGateway({ token, log: (m) => console.log(`[gateway] ${m}`) });
  const fitService = makeFitService({ dal, settings: dal.settings });
  // adapt FitService (scoreFor→FitResult) to the scheduler's FitPort (scoreFor→number|null).
  const fit: FitPort = { scoreFor: (jobId, profileId) => fitService.scoreFor(jobId, profileId).score ?? null, floor: () => fitService.floor() };
  const runService: RunService = makeRunService({ dal, gateway, registry, fit, log: (m) => console.log(`[run] ${m}`) });
  const learnDistiller = makeLearnDistiller({ dal });

  // Stage 3 discovery + permanent dismiss (Pierre's false-tracking scar): the ingest chokepoint gates
  // every source AND /track (is-this-a-job + dismiss-check); discovery starts at boot (self-gated on
  // settings.discovery.enabled), the apply loop only on /apply/start (supervised).
  const dismissalsDal = makeDismissalsDal(dal.ctx);
  const discoveryDal = makeDiscoveryDal(dal.ctx);
  const ingest = makeIngest({ dal, discoveryDal, registry, dismissals: dismissalsDal });
  const discovery = makeDiscoveryService({
    dal, discoveryDal, registry, ingest, spacingMs: 1500,
    discoveryDir: resourceDir('discovery'),
    log: (m) => console.log(`[discovery] ${m}`),
  });

  // Boundary adapters — the scheduler/discovery services and the routes-auto DTOs were designed by
  // different builders; these map the real outputs to exactly the shapes the mission-control renderer
  // reads (lanes as an ARRAY with its lane name; discovery status as {enabled, sources}; null→undefined).
  const autoRunSvc = {
    start: () => runService.start(),
    stop: () => runService.stop(),
    queue: () => runService.queue(),
    state: () => {
      const s = runService.state();
      const lanes = (['linkedin', 'indeed', 'ats'] as const).map((lane) => {
        const l = s.lanes[lane];
        return { lane, queued: l.queued, inflight: l.inflight, submittedToday: l.submittedToday, cap: l.capRemaining, capRemaining: l.capRemaining, breaker: l.breaker.reason, pausedUntil: null };
      });
      return { running: s.running, activeRun: s.activeRun, lanes };
    },
  };
  const discoverySvc = {
    runOnce: () => discovery.runOnce(),
    status: () => {
      const st = discovery.status();
      return {
        enabled: st.running,
        sources: st.lanes.map((l) => ({
          id: l.source_id, board: l.board, kind: l.kind, enabled: l.enabled,
          lastTickAt: l.last_tick_at, yield: l.accepted_24h, found: l.found_24h,
          freshnessHours: null, saturation: null,
          breaker: l.breaker_reason, cooldownUntil: l.cooldown_until, nextEarliestAt: l.next_earliest_at,
        })),
      };
    },
  };
  const dismissForRoute = {
    dismiss: (jobId: string, opts: { reason?: string; note?: string | null }) => {
      // the route already validated `reason` against the dismissals CHECK vocab; build conditionally
      // (exactOptionalPropertyTypes forbids assigning an explicit `undefined` to an optional prop).
      const o: { reason?: DismissReason; note?: string } = {};
      if (opts.reason !== undefined) o.reason = opts.reason as DismissReason;
      if (opts.note != null) o.note = opts.note;
      return dismissalsDal.dismiss(jobId, o);
    },
  };

  // The importer seam: routes never import engine modules directly. plan/execute snapshot the source
  // themselves (copy-based — v11 can be LIVE at :7744), so `snapshots:true` skips the liveness refusal.
  const importer: ImporterPort = {
    snapshots: true,
    plan: (sourcePath) => planImport(snapshotV11(sourcePath).path),
    execute: (sourcePath, opts) => {
      const snap = snapshotV11(sourcePath).path;
      const result = executeImport(opened.db, snap) as unknown as Record<string, unknown>;
      if (opts.migrateGmail) {
        const gmail = migrateGmailCredentials(opened.db, snap, { dal, unsealV11 }, { consent: true });
        return { ...result, gmail };
      }
      return result;
    },
  };
  const dataDeps = { dal: dal as unknown as DataDal, importer };

  const startedAt = Date.now();
  server = await startServer({
    db: opened.db,
    version: app.getVersion(),
    startedAt,
    dev: DEV,
    rendererDir: join(HERE, '..', 'renderer'),
    mount: (a) =>
      mountApi(a, {
        db: opened.db, // Stage-0 ApiDeps takes the raw handle (DAL projections swap in at Stage 1)
        startedAt,
        token,
        version: app.getVersion(),
        devtools: DEVTOOLS,
        frontWindow: frontOrCreate,
        // Stages 1-2: read/import data routes + the apply spine + watch-and-learn, all under the token guard.
        extend: (api) => {
          mountDataRoutes(api, { ...dataDeps, db: opened.db, startedAt, token, version: app.getVersion(), devtools: DEVTOOLS, frontWindow: frontOrCreate });
          mountApplyRoutes(api, { dal, runService });
          mountLearnApi(api, dal, learnDistiller);
          // Stage 3: supervised auto-apply controls + discovery status, and /track + permanent dismiss.
          mountAutoRoutes(api, { dal: { settings: dal.settings, runs: dal.runs, dismissals: dismissForRoute }, runService: autoRunSvc, discovery: discoverySvc });
          mountTrackRoutes(api, { dal: { dismissals: dismissalsDal }, ingest: (input) => ingest.track(input), isJobPosting: ingest.jobGate });
          devDrive?.mount(api);
        },
      }),
  });

  // the /drive WebSocket rides the SAME loopback server (token-guarded upgrade on IDENTITY.wsPath).
  gateway.attach(server.server as unknown as HttpServer);
  discovery.start(); // supply the apply queue; self-gates on settings.discovery.enabled + per-source pacing

  // Tray = the reason the brain survives a closed window (extension stays paired, browser dashboard
  // stays reachable). Skipped in SMOKE: a headless CI boot has no shell tray to attach to.
  if (!SMOKE) createTray();

  console.log(`[jat13] db schema v${opened.migration.to} @ ${dbFile}`);
  console.log(`[jat13] brain on http://127.0.0.1:${server.port}${DEV ? ' (dev)' : ''}`);
  if (!sealer.available()) console.warn('[jat13] safeStorage unavailable — secrets are NOT encrypted at rest on this machine');

  ipcMain.handle('app:ping', () => ({ ok: true, version: app.getVersion() }));
  // the renderer fetches the loopback API with this token (loopback-only, local-trusted)
  ipcMain.handle('app:config', () => ({ port: server?.port ?? 0, token, version: app.getVersion(), dev: DEV, devtools: DEVTOOLS }));

  if (SMOKE) {
    // NOTE: /health is the ONE bare (non-enveloped) route — the liveness probe shape from the old
    // code ({ok, name, version, protocol, schema, dev, uptimeMs, pid}); everything else uses the
    // {ok, data}/{ok:false, error} envelope.
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    const body = (await res.json()) as { ok?: boolean; schema?: number };
    console.log('[jat13] smoke /health ->', JSON.stringify(body));
    await shutdown();
    app.exit(res.ok && body.ok === true && body.schema === opened.migration.to ? 0 : 1);
    return;
  }

  createWindow();
}

/** Raise the existing window (restoring/showing it), or recreate it if it was closed. Used by the
 *  popup "Open dashboard" (via mountApi's frontWindow) and the tray — works even after the window
 *  was closed because the tray keeps the process alive. */
function frontOrCreate(): void {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    createWindow();
  }
}

/** The system tray — its presence lets `window-all-closed` keep the loopback brain (server + static
 *  dashboard + future /drive gateway) running. Quit lives HERE, nowhere else. */
function createTray(): void {
  if (tray) return;
  // esbuild copies build/icon.ico → dist/main/icon.ico (root build script wiring).
  let img = nativeImage.createFromPath(join(HERE, 'icon.ico'));
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('JAT 13 — running in the background');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open dashboard', click: () => frontOrCreate() },
      { label: 'Open in browser', click: () => void shell.openExternal(`http://127.0.0.1:${server?.port ?? PORTS.app}/`) },
      { type: 'separator' },
      { label: 'Quit JAT 13', click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', () => frontOrCreate()); // left-click the tray = show the dashboard
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    backgroundColor: '#12100d', // Atelier Noir warm black — pre-paint flash matches the theme
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = undefined; });
  void win.loadFile(join(HERE, '..', 'renderer', 'index.html'));
}

async function shutdown(): Promise<void> {
  await server?.close().catch(() => {});
  server = undefined;
  db?.close();
  db = undefined;
}

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('window-all-closed', () => {
  // Do NOT quit on window close — the tray keeps the brain (loopback server + dashboard) alive so
  // the extension stays connected and the browsable dashboard stays reachable (the 13.0.0 "popup
  // says finish setup" scar). Quit only via the tray's "Quit" (which sets `quitting`). If the tray
  // failed to create, fall back to old quit-on-close so the process can't become unreachable.
  if (quitting || !tray) app.quit();
});
app.on('before-quit', () => {
  quitting = true;
  void shutdown();
});

app.whenReady().then(boot).catch((err: unknown) => {
  console.error('[jat13] boot failed', err);
  app.exit(1);
});
