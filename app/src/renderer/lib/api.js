// JAT 13 — loopback API client. ONE envelope convention, enforced at the seam:
//   success  = { ok: true,  data: <payload> }
//   error    = { ok: false, error: { code, message } }
// api() returns the UNWRAPPED data or throws a coded ApiError — pages never see
// the envelope, so the v13.0.x `{rows:{rows}}` double-wrap class is impossible:
// a malformed envelope throws `bad_envelope` loudly instead of silently nesting.
// /health is the ONE bare exception (unauthenticated liveness probe, old shape).

const cfg = {
  base: 'http://127.0.0.1:7860', // prod port; dev (7861) arrives via configure()
  token: '',
};
let unauthorizedCb = null;

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Point the client at the brain. Called once from main.js bootstrap. */
export function configure({ base, token } = {}) {
  if (base) cfg.base = base;
  if (token !== undefined) cfg.token = token || '';
}
export function apiBase() { return cfg.base; }
export function hasToken() { return !!cfg.token; }
/** Raw pairing token — needed only by the dev-drive harness (it speaks raw fetch). */
export function apiToken() { return cfg.token; }
/** Register the single 401 handler (main.js flips the shell to the offline state). */
export function onUnauthorized(fn) { unauthorizedCb = fn; }

function combineSignals(sigs) {
  const s = sigs.filter(Boolean);
  if (s.length === 1) return s[0];
  if (AbortSignal.any) return AbortSignal.any(s);
  return s[0];
}

/**
 * api('/status', { method, body, signal, timeoutMs }) → payload (envelope unwrapped).
 * Throws ApiError with codes: aborted (route died — callers ignore), timeout,
 * unreachable, unauthorized, bad_envelope, or the server's own snake_case code.
 */
export async function api(path, opts = {}) {
  const { method = 'GET', body, signal, timeoutMs = 15000 } = opts;
  const headers = { 'X-JAT13-Token': cfg.token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(cfg.base + '/api' + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: combineSignals([signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch (e) {
    if (e?.name === 'AbortError') { const err = new ApiError('aborted', 'request aborted'); err.aborted = true; throw err; }
    if (e?.name === 'TimeoutError') throw new ApiError('timeout', `no answer from ${path} in ${timeoutMs}ms`);
    throw new ApiError('unreachable', `app unreachable at ${cfg.base}`);
  }
  if (res.status === 401) {
    unauthorizedCb?.();
    throw new ApiError('unauthorized', 'pairing token rejected', 401);
  }
  let envelope;
  try { envelope = await res.json(); }
  catch { throw new ApiError('bad_envelope', `non-JSON body from ${path} (HTTP ${res.status})`, res.status); }
  if (envelope && envelope.ok === true && 'data' in envelope) return envelope.data;
  if (envelope && envelope.ok === false && envelope.error) {
    throw new ApiError(envelope.error.code || 'error', envelope.error.message || envelope.error.code || `HTTP ${res.status}`, res.status);
  }
  throw new ApiError('bad_envelope', `malformed envelope from ${path} — expected {ok,data}/{ok,error}`, res.status);
}

/** The bare exception: GET /health (liveness). Returns the old-shape body verbatim. */
export async function health(base = cfg.base) {
  const res = await fetch(base + '/health', { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new ApiError('unhealthy', `health HTTP ${res.status}`, res.status);
  return res.json();
}
