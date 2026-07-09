# JAT 13 — run it

Ground-up rebuild of the auto-apply system: a **thin Chrome extension** (hands & eyes) + an **Electron desktop app** (the brain). Site knowledge is hot-updatable JSON adapters. The app owns a 13-state apply-run machine persisted per step, so **an extension death mid-apply is survivable** — the app re-reads the live page and continues.

## The two things you load

| What | Path | How |
|---|---|---|
| **Extension** (load unpacked) | `extension/dist` | `chrome://extensions` → Developer mode ON → **Load unpacked** → pick this folder |
| **App installer** | `app/release/JAT-13-Setup-13.0.0.exe` | double-click to install (per-user, no admin) |

You don't strictly need the installer: **the extension finds the app itself.** Its popup probes the app on `127.0.0.1:7860`; if the app is running it pairs automatically, and if it isn't it shows a **"Download the JAT 13 app"** button that goes to the latest GitHub release. After the first release, the app also **self-updates** (electron-updater, public repo → no token needed).

## First-run / cutover sequence

1. **Install + launch the app** (`JAT-13-Setup-13.0.0.exe`). It opens the Aurora window and starts the brain on `127.0.0.1:7860`.
2. **Load the extension** from `extension/dist`. Click its toolbar icon → the popup pairs to the app (green "Paired"). It writes the pairing token itself; nothing to copy.
3. **Import your v11 data.** In the app: **Settings → Import from JAT v11**. It defaults to `%APPDATA%\jat11-app\jat.db`. **Quit JAT v11 first** — the importer refuses to read a running v11 (it needs a consistent snapshot). Click **Plan** (dry-run report), then **Import now**. Your jobs, applications, learned answers, documents, and emails come over; sensitive answers (EEO/SSN/DOB/salary-history) are dropped by design, and a v11 "done" apply with no real evidence is imported as *parked*, never a false submit.
   - Same flow works on **Dad's machine** (the importer has zero hardcoded paths).
4. **Turn on auto-apply** from the Overview page (Apply on/off). It drives **serially** (one at a time) by design — v11's parallel windows froze the machine — and honors the LinkedIn **45 applies / 24h** account cap (it will never lock you out).
5. **Watch it run** on the Mission Control / Runs page. Anything it can't answer lands in **Needs You** (answer once, it resumes). Captchas/logins park for you — it never solves them.
6. **Gmail status updates** (optional): **Settings → connect Gmail**. Once connected, incoming mail is classified (offer/rejection/interview/…) and moves the matching application's status automatically. (Connecting needs a Google OAuth consent — that's a one-time you-step.)
7. Once v13 is doing the work, **leave v11 shut down.**

## Dev mode (no installer)

```bash
npm install
npm run dev        # launches the app with the dev identity (port 7861, userData jat13-app-dev)
npm run build:ext  # rebuild the extension into extension/dist
```

`npm test` (324 tests) runs better-sqlite3 under the **node** ABI; `npm run dev`/`dist` need the **Electron** ABI. If you switch between them, run `npm run rebuild:node` before `npm test` or `npm run rebuild:electron` before `npm run dev`.

## Releasing a new version

Bump the version in the `package.json`s (keep them in lockstep — `npm run gates` checks), then tag `v13.x.y` and push. `.github/workflows/release.yml` builds the installer on Windows CI and publishes it + `latest.yml` to the GitHub release; installed apps auto-update from there.

## What's live vs. what needs you

- **Proven headlessly:** the whole apply engine incl. *resume-after-extension-kill* (the architecture risk), the DAL, the wire protocol, the importer, the API, the ledger cap. 324 automated tests.
- **Needs your machine/click (can't be done from CI):** the first live LinkedIn apply in a real Chrome, the Gmail OAuth consent, and the actual v11→v13 import (because v11 must be quit first).
