// Dev-drive — an in-app remote control so the app can be tested WITHOUT stealing the user's mouse.
// I POST a command over the loopback (navigate / click / fill / inspect / snapshot); the renderer's
// dev-drive poller executes it against the real DOM and posts the result back; the window visibly
// moves so the user watches the test drive itself. /dev/screenshot is answered straight from the
// main process via webContents.capturePage() — no renderer round-trip, real pixels.
//
// Guarded: mounted ONLY when devtools is on (dev build, or JAT_DEVTOOLS=1). Loopback + token still
// apply. It is a TEST surface, never part of the product's apply/data path.
import type { Hono } from 'hono';
import type { BrowserWindow } from 'electron';

interface Cmd {
  id: string;
  type: string;
  args?: Record<string, unknown>;
}

export interface DevDriveDeps {
  /** the live app window, for main-process screenshots. */
  getWindow: () => BrowserWindow | undefined;
  log?: (msg: string) => void;
}

/** A tiny command bus: I enqueue via /dev/exec, the renderer drains /dev/pending and answers /dev/result. */
export function makeDevDrive(deps: DevDriveDeps) {
  const pending: Cmd[] = [];
  const waiters = new Map<string, (v: unknown) => void>();
  const last = new Map<string, unknown>();
  let seq = 0;

  function mount(api: Hono): void {
    // renderer drains queued DOM commands (fast poll)
    api.get('/dev/pending', (c) => {
      const commands = pending.splice(0, pending.length);
      return c.json({ commands });
    });

    // renderer reports a command's result → wake the /dev/exec waiter
    api.post('/dev/result', async (c) => {
      const body = (await c.req.json()) as { id: string; result: unknown };
      last.set(body.id, body.result);
      const w = waiters.get(body.id);
      if (w) {
        waiters.delete(body.id);
        w(body.result);
      }
      return c.json({ ok: true });
    });

    // I enqueue a DOM command and long-poll until the renderer answers (or it times out).
    api.post('/dev/exec', async (c) => {
      const body = (await c.req.json()) as { type: string; args?: Record<string, unknown> };
      const id = `c${++seq}`;
      const cmd: Cmd = { id, type: body.type };
      if (body.args) cmd.args = body.args;
      pending.push(cmd);
      const result = await new Promise<unknown>((resolve) => {
        const to = setTimeout(() => {
          waiters.delete(id);
          resolve({ error: 'timeout', hint: 'renderer dev-drive poller did not answer — is the window loaded?' });
        }, 12_000);
        waiters.set(id, (v) => {
          clearTimeout(to);
          resolve(v);
        });
      });
      deps.log?.(`dev/exec ${body.type} → ${JSON.stringify(result).slice(0, 200)}`);
      return c.json({ id, result });
    });

    // real screenshot of the live window, straight from main (no renderer needed).
    api.post('/dev/screenshot', async (c) => {
      const win = deps.getWindow();
      if (!win || win.isDestroyed()) return c.json({ error: 'no_window' }, 503);
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      return new Response(new Uint8Array(png), {
        status: 200,
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
      });
    });

    // liveness ping for the dev harness
    api.get('/dev/ping', (c) => c.json({ ok: true, pendingDepth: pending.length }));
  }

  return { mount };
}
