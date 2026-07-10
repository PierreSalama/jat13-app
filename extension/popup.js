// JAT v13 popup — finds the desktop app on the loopback, pairs (stores the token the SW uses),
// and gives the two everyday actions: Track this page, Open dashboard. If the app isn't installed,
// the setup card offers a DIRECT installer download (resolved from the permanent latest-release
// asset url — never just a repo page).
//
// Plain script (no bundling) — so the identity constants below are the ONE sanctioned duplication
// of @jat13/shared/constants outside shared/. They MUST match: ports 7860/7861, header
// X-JAT13-Token, storage keys jat13Token/jat13Port. Everything TS-side imports them instead.
//
// Envelope: every /api response is {ok:true,data:…} | {ok:false,error:{code,message}} — the v13
// rebuild's canonical shape (the {rows:{rows}} class is extinct). unwrap() below is the only
// reader; a bare/legacy body is treated as an error, never guessed at.
(function () {
  var PORTS = [7860, 7861]; // prod, then dev — MUST match @jat13/shared PORTS
  var TOKEN_KEY = 'jat13Token'; // MUST match sw.ts TOKEN_KEY
  var PORT_KEY = 'jat13Port';   // MUST match sw.ts PORT_KEY — the SW connects to the port we discover
  var AUTH_HEADER = 'X-JAT13-Token'; // MUST match IDENTITY.authHeader
  var RELEASES_PAGE = 'https://github.com/PierreSalama/jat13-app/releases/latest';
  // PERMANENT direct-download url for the newest installer — no GitHub API call (that was failing behind
  // rate limits / WARP), no repo page. GitHub redirects /releases/latest/download/<name> to the newest
  // release's asset; the installer is named JAT-13-Setup.exe (version-less) so this url never changes.
  var DIRECT_INSTALLER = 'https://github.com/PierreSalama/jat13-app/releases/latest/download/JAT-13-Setup.exe';

  var $ = function (id) { return document.getElementById(id); };
  var conn = { dot: $('conn-dot'), text: $('conn-text') };
  var setupRow = $('setup-row');
  var pageCard = $('page-card');
  var actionsRow = $('actions-row');
  var pageStatus = $('page-status');
  var captureHint = $('capture-hint');

  var state = { port: 0, token: '', tab: null, connected: false };
  var retryTimer = null;

  function setConn(ok, text) {
    conn.dot.className = 'conn-dot ' + (ok ? 'ok' : 'bad');
    conn.text.textContent = text;
  }

  /** Unwrap the canonical envelope; throws on {ok:false} or a non-envelope body. */
  function unwrap(body) {
    if (body && body.ok === true) return body.data;
    var msg = body && body.error && body.error.message ? body.error.message : 'bad envelope';
    throw new Error(msg);
  }

  // Download the installer DIRECTLY from the permanent url via chrome.downloads — no navigation, no repo
  // page, no GitHub API. Falls back to opening the same .exe url in a tab (still downloads) if the
  // downloads API is unavailable.
  function startDownload() {
    var hint = $('download-hint');
    if (hint) hint.textContent = 'Downloading the installer…';
    try {
      chrome.downloads.download({ url: DIRECT_INSTALLER, saveAs: false }, function () {
        if (chrome.runtime.lastError) {
          try { chrome.tabs.create({ url: DIRECT_INSTALLER }); } catch (e) { /* noop */ }
          if (hint) hint.textContent = 'Starting download…';
        } else if (hint) {
          hint.textContent = 'Downloading — check your downloads bar, then run the installer.';
        }
      });
    } catch (e) {
      try { chrome.tabs.create({ url: DIRECT_INSTALLER }); } catch (e2) { /* noop */ }
    }
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'content-type': 'application/json' };
    headers[AUTH_HEADER] = state.token;
    opts.headers = Object.assign(headers, opts.headers || {});
    var res = await fetch('http://127.0.0.1:' + state.port + '/api' + path, opts);
    if (!res.ok) throw new Error('api ' + path + ' -> ' + res.status);
    return unwrap(await res.json());
  }

  async function probe() {
    if (!state.connected) setConn(false, 'checking…');
    for (var i = 0; i < PORTS.length; i++) {
      try {
        var ctrl = new AbortController();
        var t = setTimeout(function () { ctrl.abort(); }, 900);
        var res = await fetch('http://127.0.0.1:' + PORTS[i] + '/api/pair/token', { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) continue;
        var pair = unwrap(await res.json()); // {token} under the canonical envelope
        if (pair && pair.token) {
          state.port = PORTS[i];
          state.token = pair.token;
          state.connected = true;
          if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
          // store BOTH token + port so the SW connects to the same app we paired with (prod/dev)
          var stored = {};
          stored[TOKEN_KEY] = pair.token;
          stored[PORT_KEY] = PORTS[i];
          await chrome.storage.local.set(stored); // SW auto-connects on this change
          setConn(true, 'app connected' + (PORTS[i] === 7861 ? ' (dev)' : ''));
          setupRow.hidden = true;
          pageCard.hidden = false;
          actionsRow.hidden = false;
          void describeTab();
          return;
        }
      } catch (e) { /* next port */ }
    }
    // app not reachable → setup card with the direct download. Keep RETRYING while the popup is open,
    // so if the app is still booting (or the user just launched it) we connect on our own — no more
    // "finish setup" showing next to a running app, and no manual retry click needed.
    state.connected = false;
    setConn(false, 'app not running');
    setupRow.hidden = false;
    pageCard.hidden = true;
    actionsRow.hidden = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(probe, 1500);
  }

  async function describeTab() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      state.tab = tabs && tabs[0] ? tabs[0] : null;
      if (!state.tab || !/^https?:/i.test(state.tab.url || '')) {
        pageStatus.textContent = 'Open a job posting, then track it from here.';
        pageStatus.className = 'page-line muted';
        $('btn-capture').disabled = true;
        return;
      }
      pageStatus.textContent = state.tab.title || state.tab.url;
      pageStatus.className = 'page-line';
      $('btn-capture').disabled = false;
    } catch (e) {
      pageStatus.textContent = '—';
    }
  }

  $('btn-capture').addEventListener('click', async function () {
    if (!state.tab) return;
    captureHint.textContent = 'Tracking…';
    try {
      var out = await api('/track', { method: 'POST', body: JSON.stringify({ url: state.tab.url, title: state.tab.title }) });
      captureHint.textContent = out && out.action === 'existing' ? 'Already tracked — opened in your list.' : 'Tracked ✓';
    } catch (e) {
      captureHint.textContent = 'Could not track this page.';
    }
  });

  // Open dashboard: front the native window AND open the browsable dashboard in a tab. The tab is the
  // reliable path (the native window may be on another monitor / already focused, which read as "nothing
  // happened"), and it's exactly the "website version of the dashboard" that was previously unreachable.
  $('btn-open').addEventListener('click', function () {
    if (!state.connected || !state.port) return;
    api('/app/front', { method: 'POST' }).catch(function () {});
    try { chrome.tabs.create({ url: 'http://127.0.0.1:' + state.port + '/' }); } catch (e) { /* ignore */ }
    window.close();
  });

  $('lnk-retry').addEventListener('click', function (e) { e.preventDefault(); probe(); });
  $('btn-download').addEventListener('click', function (e) { e.preventDefault(); startDownload(); });

  probe();
})();
