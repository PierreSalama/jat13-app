// Electron main = the brain's entrypoint. Boots the single writer (better-sqlite3), migrates, opens
// the loopback server (REST API + /drive ws gateway), starts the run-service, opens the Aurora window.
// Structural law 3/5: one process owns the DB, the port, and the socket; a second instance must never
// race it — hence the single-instance lock.
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './db/index.js';
import { startServer, type RunningServer } from './server/index.js';
import { mountApi } from './server/api.js';
import { ensurePairingToken } from './server/pairing.js';
import { makeDal, defaultContext, type Dal, type Sealer } from './db/dal/index.js';
import { loadBuiltins, makeRegistry } from './adapters/registry.js';
import { WsGateway } from './engine/ws-gateway.js';
import { makeRunService } from './engine/run-service.js';
import { makeGmailService, makeGmailClientFactory, mountGmailApi } from './gmail/index.js';
import { mountGmailConnectApi } from './gmail/connect.js';
import { makeAiService } from './ai/index.js';
import { makeDiscoveryService } from './discovery/service.js';
import { makeLearnDistiller } from './learn/distiller.js';
import { mountLearnApi } from './learn/index.js';
import { IDENTITY } from '@jat13/shared';

/** v11 sealed values are `enc:v1:` + base64(DPAPI); same OS user → v13 safeStorage decrypts them. */
function unsealV11(stored: string): string {
  const PREFIX = 'enc:v1:';
  if (!stored.startsWith(PREFIX)) return stored;
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'));
  } catch {
    return '';
  }
}

const HERE = dirname(fileURLToPath(import.meta.url)); // dist/main at runtime
const DEV = !app.isPackaged || process.env.JAT_DEV === '1';
const SMOKE = process.env.JAT_SMOKE === '1'; // headless boot proof: migrate, serve, self-check, exit

let server: RunningServer | undefined;
let db: Database | undefined;

if (!SMOKE && !app.requestSingleInstanceLock()) app.exit(0);

const resourceDir = (rel: string): string =>
  app.isPackaged ? join(process.resourcesPath, rel) : join(HERE, rel);

/** Electron safeStorage (DPAPI on Windows) sealer for the secrets DAL; degrades with a warning. */
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
  if (DEV) app.setPath('userData', join(app.getPath('appData'), IDENTITY.userDataDev));
  if (process.env.JAT_USERDATA) app.setPath('userData', process.env.JAT_USERDATA); // explicit override (testing/verify)

  const dbFile = join(app.getPath('userData'), 'jat13.db');
  const opened = openDatabase({ file: dbFile, migrationsDir: resourceDir('db/migrations') });
  db = opened.db;

  const dal: Dal = makeDal(defaultContext(db), { sealer });
  const token = ensurePairingToken(dal);
  const registry = makeRegistry(loadBuiltins(resourceDir('adapters/builtin')));
  const gateway = new WsGateway({ token, log: (m) => console.log(`[gateway] ${m}`) });
  const aiService = makeAiService({ dal, settings: dal.settings.get('ai') as import('./ai/index.js').AiSettings });
  const runService = makeRunService({ dal, gateway, registry, ai: aiService, log: (m) => console.log(`[run] ${m}`) });
  const gmail = makeGmailService({ dal, gmailClientFactory: makeGmailClientFactory(dal), log: (m) => console.log(`[gmail] ${m}`) });
  const discovery = makeDiscoveryService({ dal, discoveryDal: dal.discovery, spacingMs: 1500, log: (m) => console.log(`[discovery] ${m}`) });
  const learnDistiller = makeLearnDistiller({ dal });
  const openExternal = (url: string): Promise<void> => shell.openExternal(url);

  server = await startServer({
    db,
    version: app.getVersion(),
    startedAt: Date.now(),
    dev: DEV,
    rendererDir: join(HERE, '..', 'renderer'),
    mount: (a) =>
      mountApi(a, {
        dal,
        runService,
        registry,
        aiService,
        discovery,
        token,
        version: app.getVersion(),
        unsealV11,
        extend: (api) => {
          mountGmailApi(api, gmail, dal);
          mountGmailConnectApi(api, dal, { openExternal, log: (m) => console.log(`[gmail] ${m}`) });
          mountLearnApi(api, dal, learnDistiller);
        },
        frontWindow: () => {
          const [win] = BrowserWindow.getAllWindows();
          if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
          } else {
            createWindow();
          }
        },
      }),
  });
  gmail.start(); // scheduled status sync — dormant until a Gmail account is connected (OAuth is a user step)
  discovery.start(); // per-lane ATS sourcing (gated on settings.discovery.enabled)
  gateway.attach(server.server as unknown as import('node:http').Server); // ws /drive on the same loopback server

  console.log(`[jat13] db schema v${opened.migration.to} @ ${dbFile}`);
  console.log(`[jat13] brain on http://127.0.0.1:${server.port}${DEV ? ' (dev)' : ''} · ${registry.all().length} adapter(s)`);
  if (!sealer.available()) console.warn('[jat13] safeStorage unavailable — secrets are NOT encrypted at rest on this machine');

  ipcMain.handle('app:ping', () => ({ ok: true, version: app.getVersion() }));
  // the renderer fetches the loopback API with this token (loopback-only, local-trusted)
  ipcMain.handle('app:config', () => ({ port: server?.port ?? 0, token, version: app.getVersion(), dev: DEV }));

  if (SMOKE) {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    const body = (await res.json()) as { ok?: boolean; schema?: number };
    console.log('[jat13] smoke /health ->', JSON.stringify(body));
    await shutdown();
    app.exit(res.ok && body.ok === true && body.schema === opened.migration.to ? 0 : 1);
    return;
  }

  createWindow();
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    backgroundColor: '#0a0e1a',
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
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
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  void shutdown();
});

app.whenReady().then(boot).catch((err: unknown) => {
  console.error('[jat13] boot failed', err);
  app.exit(1);
});
