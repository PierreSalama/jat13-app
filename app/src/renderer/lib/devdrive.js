// Dev-drive poller (renderer half). Active ONLY when the app reports devtools on. Drains queued
// commands from /api/dev/pending, runs them against the REAL DOM (so the visible window moves), and
// posts results back. This is the test channel: it lets the app be driven over the loopback instead
// of stealing the user's mouse. No product behavior depends on it.

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), left: Math.round(r.left) };
}

function inspect(sel, props) {
  const els = Array.from(document.querySelectorAll(sel)).slice(0, 8);
  if (!els.length) return { error: 'not_found', sel };
  const want = props && props.length ? props : ['display', 'position', 'width', 'max-width', 'margin-left', 'margin-right', 'padding', 'color', 'background-color', 'font-family', 'border', 'grid-template-columns'];
  return {
    count: document.querySelectorAll(sel).length,
    nodes: els.map((el) => {
      const cs = getComputedStyle(el);
      const styles = {};
      for (const p of want) styles[p] = cs.getPropertyValue(p);
      return { tag: el.tagName.toLowerCase(), cls: el.className, rect: rectOf(el), text: (el.innerText || '').slice(0, 120), styles };
    }),
  };
}

function snapshot(sel) {
  const doc = document.documentElement;
  const scope = sel ? document.querySelector(sel) : document.querySelector('#main') || document.body;
  return {
    hash: location.hash,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    // horizontal overflow is the "bottom bar" (a stray horizontal scrollbar) smell
    overflowX: doc.scrollWidth > doc.clientWidth ? doc.scrollWidth - doc.clientWidth : 0,
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    text: scope ? (scope.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, sel ? 6000 : 3500) : null,
  };
}

async function run(cmd) {
  const { type, args = {} } = cmd;
  switch (type) {
    case 'navigate': {
      location.hash = args.to;
      await tick(args.settle ?? 350);
      return snapshot();
    }
    case 'click': {
      const el = document.querySelector(args.sel);
      if (!el) return { error: 'not_found', sel: args.sel };
      el.scrollIntoView({ block: 'center' });
      el.click();
      await tick(args.settle ?? 350);
      return snapshot(args.snapshotSel);
    }
    case 'fill': {
      const el = document.querySelector(args.sel);
      if (!el) return { error: 'not_found', sel: args.sel };
      el.focus();
      el.value = args.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value };
    }
    case 'inspect':
      return inspect(args.sel, args.props);
    case 'exists':
      return { exists: !!document.querySelector(args.sel), count: document.querySelectorAll(args.sel).length };
    case 'text': {
      const el = document.querySelector(args.sel);
      return { exists: !!el, text: el ? (el.innerText || '').slice(0, args.max ?? 6000) : null };
    }
    case 'snapshot':
      return snapshot(args.sel);
    case 'waitFor': {
      const deadline = Date.now() + (args.timeout ?? 5000);
      while (Date.now() < deadline) {
        if (document.querySelector(args.sel)) return { found: true };
        await tick(150);
      }
      return { found: false };
    }
    default:
      return { error: 'unknown_type', type };
  }
}

export function startDevDrive({ base, token }) {
  const hdr = { 'X-JAT13-Token': token || '' };
  let stopped = false;
  async function loop() {
    if (stopped) return;
    try {
      const res = await fetch(base + '/api/dev/pending', { headers: hdr });
      if (res.ok) {
        const { commands } = await res.json();
        for (const cmd of commands) {
          let result;
          try { result = await run(cmd); } catch (e) { result = { error: String((e && e.message) || e) }; }
          await fetch(base + '/api/dev/result', {
            method: 'POST',
            headers: { ...hdr, 'content-type': 'application/json' },
            body: JSON.stringify({ id: cmd.id, result }),
          }).catch(() => {});
        }
      }
    } catch { /* app momentarily unreachable — keep polling */ }
    setTimeout(loop, 300);
  }
  loop();
  // eslint-disable-next-line no-console
  console.log('[devdrive] renderer poller active');
  return () => { stopped = true; };
}
