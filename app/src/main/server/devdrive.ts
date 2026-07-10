// Dev-drive — an in-app remote control so the app can be tested WITHOUT stealing the user's mouse
// (scar: the v11 parallel-window focus-steal froze Pierre's machine; this harness drives the real
// DOM over loopback instead). I POST a command (navigate / click / fill / inspect / snapshot); the
// renderer's dev-drive poller executes it against the real DOM and posts the result back; the
// window visibly moves so the user watches the test drive itself. /dev/screenshot is answered
// straight from the main process via webContents.capturePage() — no renderer round-trip, real
// pixels. Proven verbatim from v13.0.1; Stage 0 builds it FIRST because every stage's exit
// criteria include driving the real UI through it.
//
// Guarded: mounted ONLY when devtools is on (dev build, or JAT_DEVTOOLS=1), on the AUTHED /api
// sub-app — loopback + token still apply. It is a TEST surface, never part of the product's
// apply/data path. JSON responses use the shared envelope (screenshot stays raw PNG).
import type { Hono } from 'hono';
import type { BrowserWindow } from 'electron';
import { ok, err } from '@jat13/shared';

interface Cmd {
  id: string;
  type: string;
  args?: Record<string, unknown>;
}

export interface DevDriveDeps {
  /** the live app window, for main-process screenshots. */
  getWindow: () => BrowserWindow | undefined;
  log?: (msg: string) => void;
  /** how long /dev/exec long-polls for the renderer's answer before resolving with a timeout
   *  result. Injectable so the envelope walk test doesn't stall 12s per POST; production default
   *  matches the proven v13.0.1 value. */
  execTimeoutMs?: number;
}

/** A tiny command bus: I enqueue via /dev/exec, the renderer drains /dev/pending and answers /dev/result. */
export function makeDevDrive(deps: DevDriveDeps) {
  const pending: Cmd[] = [];
  const waiters = new Map<string, (v: unknown) => void>();
  const last = new Map<string, unknown>();
  const execTimeoutMs = deps.execTimeoutMs ?? 12_000;
  let seq = 0;

  function mount(api: Hono): void {
    // renderer drains queued DOM commands (fast poll)
    api.get('/dev/pending', (c) => {
      const commands = pending.splice(0, pending.length);
      return c.json(ok({ commands }));
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
      return c.json(ok({ received: true }));
    });

    // I enqueue a DOM command and long-poll until the renderer answers (or it times out).
    api.post('/dev/exec', async (c) => {
      const body = (await c.req.json()) as { type: string; args?: Record<string, unknown> };
      const id = `c${++seq}`;
      const cmd: Cmd = { id, type: body.type };
      if (body.args) cmd.args = body.args; // conditional assign — exactOptionalPropertyTypes
      pending.push(cmd);
      const result = await new Promise<unknown>((resolve) => {
        const to = setTimeout(() => {
          waiters.delete(id);
          // a timeout is a RESULT of the exec round-trip, not a transport failure — the envelope
          // stays ok; the caller inspects result.error. (err() is reserved for "the route itself
          // could not serve you", e.g. no window for a screenshot.)
          resolve({ error: 'timeout', hint: 'renderer dev-drive poller did not answer — is the window loaded?' });
        }, execTimeoutMs);
        waiters.set(id, (v) => {
          clearTimeout(to);
          resolve(v);
        });
      });
      deps.log?.(`dev/exec ${body.type} → ${JSON.stringify(result).slice(0, 200)}`);
      return c.json(ok({ id, result }));
    });

    // real screenshot of the live window, straight from main (no renderer needed). Raw PNG — the
    // one non-JSON dev surface; harness callers save the bytes as proof-of-render.
    api.post('/dev/screenshot', async (c) => {
      const win = deps.getWindow();
      if (!win || win.isDestroyed()) return c.json(err('no_window', 'app window is not open — cannot capture'), 503);
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      return new Response(new Uint8Array(png), {
        status: 200,
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
      });
    });

    // liveness ping for the dev harness
    api.get('/dev/ping', (c) => c.json(ok({ pendingDepth: pending.length })));
  }

  return { mount };
}
