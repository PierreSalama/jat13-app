// Preload — the ONLY bridge between the sandboxed Atelier renderer and the main process. Sandboxed
// preloads run as CommonJS; esbuild bundles this (including @jat13/shared) to dist/main/preload.cjs.
// Exposes just enough for the renderer to reach the loopback REST API — the port + pairing token
// come from main over IPC, never hardcoded (the 13.0.1 wrong-port scar: identity FLOWS, always).
import { contextBridge, ipcRenderer } from 'electron';
import { IDENTITY, PROTOCOL_VERSION } from '@jat13/shared';

interface AppConfig {
  port: number;
  token: string;
  version: string;
  dev: boolean;
  devtools: boolean;
}

contextBridge.exposeInMainWorld('jat13', {
  protocol: PROTOCOL_VERSION,
  productName: IDENTITY.productName,
  authHeader: IDENTITY.authHeader,
  config: (): Promise<AppConfig> => ipcRenderer.invoke('app:config'),
  ping: (): Promise<{ ok: boolean; version: string }> => ipcRenderer.invoke('app:ping'),
});
