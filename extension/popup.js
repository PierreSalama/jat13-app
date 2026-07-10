// JAT v13 popup — finds the desktop app on the loopback, pairs (stores the token the SW uses),
// and gives the two everyday actions: Track this page, Open dashboard. If the app isn't installed,
// the setup card offers a DIRECT installer download (resolved from the latest GitHub release asset —
// never just a repo page).
(function () {
  var PORTS = [7860, 7861]; // prod, then dev
  var TOKEN_KEY = 'jat13Token'; // MUST match sw.ts TOKEN_KEY
  var PORT_KEY = 'jat13Port';   // MUST match sw.ts PORT_KEY — the SW connects to the port we discover
  var RELEASES_PAGE = 'https://github.com/PierreSalama/jat13-app/releases/latest';
  var RELEASES_API = 'https://api.github.com/repos/PierreSalama/jat13-app/releases/latest';

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

  // resolve the DIRECT .exe asset of the newest release for the download button
  function resolveInstallerUrl() {
    fetch(RELEASES_API).then(function (r) { return r.ok ? r.json() : null; }).then(function (rel) {
      if (!rel || !rel.assets) return;
      var exe = rel.assets.find(function (a) { return /\.exe$/i.test(a.name); });
      if (exe) {
        var btn = $('btn-download');
        btn.setAttribute('href', exe.browser_download_url);
        btn.textContent = 'Download ' + rel.tag_name + ' (.exe)';
      }
    }).catch(function () { /* fallback href (releases page) stays */ });
  }

  async function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-JAT13-Token': state.token, 'content-type': 'application/json' }, opts.headers || {});
    var res = await fetch('http://127.0.0.1:' + state.port + '/api' + path, opts);
    if (!res.ok) throw new Error('api ' + path + ' -> ' + res.status);
    return res.json();
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
        var body = await res.json();
        if (body && body.token) {
          state.port = PORTS[i];
          state.token = body.token;
          state.connected = true;
          if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
          // store BOTH token + port so the SW connects to the same app we paired with (prod/dev)
          await chrome.storage.local.set({ [TOKEN_KEY]: body.token, [PORT_KEY]: PORTS[i] }); // SW auto-connects on this change
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
    resolveInstallerUrl();
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
      captureHint.textContent = out.action === 'existing' ? 'Already tracked — opened in your list.' : 'Tracked ✓';
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

  probe();
})();
