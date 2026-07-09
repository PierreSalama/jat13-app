# JAT v12 — Pillar 5: Gmail Status Pipeline

**Status:** Design — implementation-ready
**Owner module:** `app/src/main/inbox/` (app brain, Electron main process)
**Depends on:** Pillar "core data" (better-sqlite3 single-writer, jobs/events tables, SSE patch bus), Pillar "UI" (Mission Control health chips, Inbox page), Pillar "adapters-as-data" (rules-pack distribution channel)
**Evidence base:** v11 `app/src/gmail.js`, `app/src/email.js`, `app/src/db.js` (emails table, `elevateJobFromEmail`, `confirmEmailLink`, `gmailStatusFromCategory`, `sweepGhosted`, `migrateGmailQuery`), memory `reference_jat_email_pipeline.md` (the v11.48→v11.65 saga), `reference_jat_v1181_v1182.md` (payload/SSE lessons), token-rot history (Gmail OAuth + CWS refresh tokens both died repeatedly on ~7-day unverified-app expiry).

---

## 0. Mission statement and the v11 post-mortem this design encodes

The pipeline's job: **the inbox drives the funnel**. Every application a user submits eventually gets an answer by email (confirmation, rejection, assessment, interview, offer — or silence → ghosted). v12 must move job statuses automatically, honestly, and auditable-y, without the user ever re-reading their inbox.

v11 lessons that are now structural requirements (each one broke production):

| # | v11 failure | v12 structural answer |
|---|---|---|
| E1 | **LinkedIn-only Gmail query** (v11.48): 359/359 synced emails were LinkedIn confirmations; employer/ATS rejections/interviews were never *fetched*, so the classifier never even saw them. Pipeline sat at `submitted` forever. | Query is **data in the rules-pack**, broad by default (ATS sender domains + stage phrases), versioned, hot-updatable. Diagnostic panel shows sender-domain distribution so "query too narrow" is visible in-UI, not a DB forensics job. |
| E2 | **Backfill cap starvation** (v11.49): broad query's LinkedIn volume crowded a 300-message cap; a watermark-reset backfill only reached ~2 weeks, then the watermark advanced past the missed employer mail forever. | Mode-aware caps (backfill 1200 / incremental 300) kept; plus **History-API incremental sync** makes the incremental path immune to volume; plus the watermark only advances past a message once that message is *stored* (per-message commit, not end-of-run). |
| E3 | **Classifier ordering false-positives** (v11.64): receipt emails with interview boilerplate in the footer mis-staged as interview; neutral-subject interview invites collapsed to `submitted`. | The exact v11.64 rule ladder (offer → rejection → STRONG-receipt → assessment → interview → confirmation → recruiter) ships as the initial rules-pack, with the ordering rationale encoded as comments in the pack itself. Regression corpus of real fixture emails gates every pack update. |
| E4 | **Elevate-only-on-change bug** (v11.65): `reprocessEmails` only elevated when category *changed*, so correctly-classified old rejections never moved their job. | Elevation is **idempotent and unconditional on every match** (forward-only guard makes repeats harmless). Reprocess = re-run the whole pipeline; there is no "skip unchanged" fast path in the elevation step. |
| E5 | **Token rot** (~7-day refresh-token expiry on unverified Google apps): email sync silently died; user discovered it days later as "statuses stopped moving". | First-class **token lifecycle**: health state machine, age tracking, proactive re-auth prompt *before* expiry, OS notification on death, health chip in Mission Control, and a rot-proof **IMAP app-password fallback** (v11's proven `email.js` path) as a supported degradation mode. |
| E6 | **Payload bombs / SSE storms**: SELECT * refetch patterns elsewhere in v11 lagged the whole app. | Inbox lists are lean projections (`snippet` only, never `body`); SSE sends targeted row patches (`email.upserted {id, category, matchedJobId…}`), never "refetch everything". Bodies are detail-on-demand. |
| E7 | **Junk-row telemetry** (ATS feed's 12.8k empty-scan rows/day). | Sync runs write a telemetry row **only on yield** (≥1 message stored or an error). Zero-yield ticks update a kv `lastSyncAt` only. Retention pruning designed in (see §11). |

---

## 1. Architecture position

All inbox intelligence lives in the **Electron main process** ("app brain"). Nothing email-related touches the extension. The renderer talks to it through the local HTTP API (port 7845) + SSE patches; the DB is written **only** by main-process code through the single better-sqlite3 writer.

```
app/src/main/inbox/
├── index.ts            // InboxService facade: start(), stop(), syncNow(), status()
├── accounts.ts         // account CRUD, secret storage (safeStorage), health computation
├── gmail/
│   ├── auth.ts         // OAuth desktop loopback flow + token refresh + lifecycle events
│   ├── client.ts       // thin fetch wrapper: gmailGet/gmailList, 401/403/429 taxonomy, backoff
│   └── sync.ts         // history-API incremental + query-poll fallback + backfill
├── imap/
│   └── sync.ts         // port of v11 email.js IMAP path (imapflow) — the rot-proof fallback
├── classify.ts         // rules-pack interpreter (ordered regex ladder) + AI fallback stage
├── match.ts            // thread-first → ATS-id → company/title/time scoring ladder
├── elevate.ts          // forward-only status advancement + event audit + ghosted sweep
├── reprocess.ts        // idempotent full-inbox re-run (after rules-pack update / import)
├── rules/
│   └── inbox-rules.default.json   // baked-in pack (v11.64-equivalent rules, see §6)
└── notify.ts           // notification policy (what is OS-level vs in-app)
```

Scheduling is owned by the **one app scheduler** (Pillar 3's rule: pacing/caps in one place). InboxService registers two jobs:
- `inbox.sync` — every `settings.inbox.intervalMinutes` (default **15**, the v11.65 end-state), gated by `shouldRunBackground()` (battery/memory guards inherited from core).
- `inbox.ghostSweep` — every 6 h + at launch, only when ≥1 account is healthy or was healthy in the last 45 days.

---

## 2. Data model (SQL, better-sqlite3, WAL)

### 2.1 `email_accounts`

Multi-account from day one (Gmail OAuth *and* IMAP app-password accounts share the table; `kind` discriminates).

```sql
CREATE TABLE email_accounts (
  id              TEXT PRIMARY KEY,            -- 'acct_' || uuid
  kind            TEXT NOT NULL,               -- 'gmail_oauth' | 'imap'
  email           TEXT NOT NULL,               -- display address (from Gmail profile / user input)
  label           TEXT,                        -- user nickname ("Personal", "Dad's")
  enabled         INTEGER NOT NULL DEFAULT 1,
  -- gmail_oauth only --
  history_id      TEXT,                        -- Gmail History API cursor (NULL until first full sync)
  watermark_ms    INTEGER NOT NULL DEFAULT 0,  -- internalDate ms fallback cursor (query-poll mode)
  -- imap only --
  imap_host       TEXT, imap_port INTEGER, imap_secure INTEGER DEFAULT 1,
  imap_uid        INTEGER DEFAULT 0,           -- UID cursor
  imap_uidvalidity TEXT,                       -- RFC 3501 reset detection (v11 lesson: re-seed on change)
  -- token lifecycle (gmail_oauth) --
  token_issued_at   TEXT,                      -- ISO; when the current refresh_token was minted
  token_last_ok_at  TEXT,                      -- last successful refresh/API call
  token_state       TEXT NOT NULL DEFAULT 'unauthorized',
                    -- 'unauthorized' | 'healthy' | 'expiring_soon' | 'expired' | 'revoked'
  auth_fail_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

**Secrets are NOT in this table.** Refresh/access tokens and IMAP app passwords are encrypted with Electron `safeStorage.encryptString()` and stored in `email_account_secrets` (id → blob), decrypted only in main-process memory. v11 stored tokens plaintext in kv — v12 does not. Secrets are excluded from export/backup files by construction (separate table, never SELECTed by export code; export code carries a denylist test).

```sql
CREATE TABLE email_account_secrets (
  account_id  TEXT PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
  blob        BLOB NOT NULL          -- safeStorage-encrypted JSON: {refresh_token, access_token, expires_at} | {password}
);
```

### 2.2 `emails`

v11's table proved right; v12 keeps its shape and adds the fields v11 had to bolt on or lacked.

```sql
CREATE TABLE emails (
  id               TEXT PRIMARY KEY,           -- 'eml_' || uuid
  account_id       TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  provider_msg_id  TEXT NOT NULL,              -- Gmail message id / IMAP uid-as-string — per-account dedup
  rfc_message_id   TEXT,                       -- RFC 5322 Message-ID — cross-account dedup + deep links
  thread_id        TEXT,                       -- Gmail threadId (NULL for IMAP)
  in_reply_to      TEXT,                       -- RFC reply chain (IMAP + Gmail both populate when present)
  ref_ids          TEXT,                       -- References header, space-joined
  from_addr        TEXT NOT NULL DEFAULT '',
  from_name        TEXT NOT NULL DEFAULT '',
  to_addr          TEXT NOT NULL DEFAULT '',
  subject          TEXT NOT NULL DEFAULT '',
  snippet          TEXT NOT NULL DEFAULT '',   -- ≤220 chars; the ONLY body-ish field list views ship
  body             TEXT NOT NULL DEFAULT '',   -- plain text, capped 8000 chars; detail-on-demand only
  sent_at          TEXT NOT NULL,              -- ISO
  -- classification --
  category         TEXT,                       -- offer|rejection|assessment|interview|application_confirmation|recruiter|other
  classified_by    TEXT,                       -- 'rules' | 'ai' | 'manual'
  rules_pack_ver   INTEGER,                    -- which pack version classified it (reprocess targeting)
  ai_confidence    REAL,                       -- NULL unless classified_by='ai'
  -- matching --
  matched_job_id   TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  match_confidence REAL NOT NULL DEFAULT 0,
  match_source     TEXT,                       -- 'auto' | 'suggested' | 'manual' | 'dismissed'
  match_via        TEXT,                       -- 'thread' | 'ats_id' | 'score' | 'ai' | 'auto-created' | 'user'
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_emails_acct_msg ON emails(account_id, provider_msg_id);
CREATE INDEX idx_emails_rfcid   ON emails(rfc_message_id);
CREATE INDEX idx_emails_thread  ON emails(thread_id);
CREATE INDEX idx_emails_job     ON emails(matched_job_id);
CREATE INDEX idx_emails_sent    ON emails(sent_at DESC);
CREATE INDEX idx_emails_source  ON emails(match_source);
```

### 2.3 `inbox_sync_runs` (telemetry — yield-only, E7)

```sql
CREATE TABLE inbox_sync_runs (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  mode        TEXT NOT NULL,       -- 'incremental' | 'backfill' | 'poll_fallback' | 'imap'
  started_at  TEXT NOT NULL,
  ms          INTEGER NOT NULL,
  scanned     INTEGER NOT NULL,    -- messages fetched
  stored      INTEGER NOT NULL,    -- new emails rows
  matched     INTEGER NOT NULL,
  suggested   INTEGER NOT NULL,
  elevated    INTEGER NOT NULL,    -- job status changes caused
  ai_calls    INTEGER NOT NULL DEFAULT 0,
  error       TEXT                 -- NULL on success
);
```

**Write rule (hard):** a row is inserted only when `stored > 0 OR elevated > 0 OR error IS NOT NULL`. A clean zero-yield tick updates `kv('inbox.lastTick.<accountId>')` and nothing else. Retention: prune rows older than 30 days in the nightly maintenance pass.

### 2.4 Job-side audit

Status changes reuse the core `events` table (Pillar 1): every elevation writes `{jobId, type:'status_changed', source:'inbox', summary:'submitted → interview_1 (email: "…subj…")', data:{from,to,emailId,accountId}}`, and every matched-but-not-elevating email writes a `type:'email'` event. **No status may change from email evidence without an events row — enforced by doing both inside one transaction in `elevate.ts`.**

---

## 3. OAuth + token lifecycle (the v11 killer, designed head-on)

### 3.1 The flow (unchanged where v11 was right)

v11's desktop loopback flow was solid — keep it verbatim in behavior:

1. `POST /api/inbox/accounts/gmail/auth` → main process spins an ephemeral `http.createServer` on `127.0.0.1:0`, builds the consent URL (`access_type=offline&prompt=consent`, scope `gmail.readonly`, random `state`), opens it with `shell.openExternal`.
2. Callback exchanges the code at `oauth2.googleapis.com/token`, stores `{refresh_token, access_token, expires_at}` encrypted via `safeStorage`, fetches `users/me/profile` for the address, upserts `email_accounts` with `token_issued_at = now`, `token_state = 'healthy'`, `auth_fail_count = 0`.
3. 5-minute timeout → `{ok:false, error:'auth timed out'}`; UI shows retry.

Client credentials: user-supplied `clientId/clientSecret` (Google Cloud Console desktop app), stored in settings as in v11. Multi-account = repeat the flow; each account holds its own token set.

### 3.2 Token health state machine

Reality: an OAuth app in Google's **"Testing"** publishing status expires refresh tokens after **7 days**. Verifying a `gmail.readonly` app requires a CASA security assessment (restricted scope) — not worth it for a personal/family app. **Decision: design for the 7-day rot instead of pretending it away**, with two mitigations: (a) proactive re-auth UX that makes the weekly click a 10-second ritual, (b) the IMAP fallback which never rots.

States and transitions (per account, computed + persisted in `token_state`):

```
unauthorized ──auth ok──▶ healthy
healthy      ──age(token_issued_at) ≥ AGE_WARN (5d default)──▶ expiring_soon
expiring_soon ──re-auth ok──▶ healthy (token_issued_at reset)
healthy|expiring_soon ──refresh returns invalid_grant──▶ expired
any ──user revokes in Google / 403 with 'insufficient*'──▶ revoked
expired|revoked ──re-auth ok──▶ healthy
```

Implementation, `accounts.ts`:

```ts
const AGE_WARN_MS  = settings.inbox.tokenWarnDays  * 864e5;  // default 5
const AGE_DEAD_MS  = settings.inbox.tokenDeadDays  * 864e5;  // default 7 (informational only —
                                                             // the API's invalid_grant is the truth)
function computeTokenState(acct): TokenState { … }           // pure; run on every sync tick + every /status call
```

- `refreshAccessToken()` failure taxonomy: `invalid_grant` → `expired` (the actual rot signal); network errors → keep state, increment nothing (transient); 3 consecutive non-network failures → `expired` regardless of body (belt-and-braces; v11 just logged and returned null forever).
- Every successful API call updates `token_last_ok_at` (cheap kv-style UPDATE, batched to once/minute).

### 3.3 Proactive re-auth UX (before death, not after)

- **`expiring_soon`** (day 5 of 7): Mission Control health chip turns amber ("Gmail token expires in ~2 days"); an in-app banner on the Inbox page with a **one-click "Renew now"** button (fires the same loopback flow — takes ~10 s since Google session is usually live). One OS notification, max one per account per expiry window (`kv inbox.warnNotified.<acct>.<issuedAt>` dedup).
- **`expired` / `revoked`**: chip red; OS notification "JAT lost Gmail access — click to reconnect" (clicking focuses the app on the Inbox settings pane); background sync for that account stops (no retry storm — one probe per 6 h to detect out-of-band re-auth).
- **Graceful degradation while dead:** the pipeline keeps working on whatever is already stored (reprocess, manual confirm, ghost sweep still run). The ghost sweep **pauses its clock** for windows when no account was healthy (a job isn't "ghosted" if we weren't listening) — implemented by only counting days where `token_last_ok_at` coverage exists; simplification: sweep is skipped entirely if the newest healthy tick is >72 h old, and `sweepGhosted` uses `max(submittedAt, lastHealthyAt - 28d)` as the silence-window start.
- **Weekly ritual reduction:** re-auth prompt is *also* surfaced opportunistically — whenever the user opens the app while `expiring_soon`, a toast offers renewal. Goal: the user never actually experiences `expired`.

### 3.4 The rot-proof fallback: IMAP app-password mode

v11's `email.js` IMAP path (imapflow + mailparser, App Password, UID cursor + UIDVALIDITY reset detection, provider presets with hand-holding setup steps) is proven and **never expires**. v12 ports it as `inbox/imap/sync.ts` behind the same `InboxService` interface:

- Same parse → classify → match → elevate pipeline (only the fetch layer differs).
- Setup UI keeps v11's step-by-step preset cards (Gmail/Outlook/Yahoo/other) verbatim — they worked for non-technical users (Dad).
- The Gmail-OAuth account card shows: "Tired of weekly renewals? Switch this account to App-Password mode (never expires)." Switching creates a new `imap` account for the same address and disables the OAuth one; dedup by `rfc_message_id` prevents double rows.
- Limitation to document in-UI: IMAP has no server-side query, so it scans INBOX sequentially (firstRun 150 / perRun 400 caps from v11) and no Gmail `thread_id` (reply-chain headers still carry threading).

---

## 4. Sync scheduling and the fetch engine

### 4.1 Incremental: Gmail History API first

v11 polled `messages.list` with the query + an `internalDate` watermark every tick — correct but wasteful and cap-sensitive (E2). v12 uses **`users.history.list`** as the primary incremental mechanism:

```
tick(account):
  if !account.history_id:            → FULL BACKFILL (4.3), then store profile.historyId
  else:
    GET /history?startHistoryId=X&historyTypes=messageAdded&maxResults=500 (paged)
    → collect added message ids
    → 404/'historyId too old' (Google keeps ~1 week): fall back to QUERY POLL (4.2) for this tick,
      then re-seed history_id from the newest message
```

- History returns *all* new messages; the **query filter is applied app-side** for history results: fetch `format=metadata` (headers only) first, run a cheap pre-filter (sender domain in pack's `senderDomains` OR subject matches pack's `prefilterRx`), and only fetch `format=full` for survivors. This keeps per-tick full-body fetches to the handful of job-related messages while never missing an employer domain the Gmail query didn't know (a **strict improvement over v11**: the server query can no longer silently exclude a new ATS sender — the app-side prefilter is hot-updatable data, and metadata fetches are cheap).
- Messages that fail the prefilter are not stored at all (no junk rows).

### 4.2 Query-poll fallback (v11's proven path, kept verbatim)

When history is unavailable (first sync, stale historyId, or `settings.inbox.forcePollMode`):
`messages.list q=<pack.gmailQuery> after:<watermarkSec>` paged 50/page, per-message `format=full`, watermark = max `internalDate` **committed after each message's row is stored** (E2 fix: a crash mid-run resumes exactly where it stopped; v11 advanced the watermark only at run end, which was safe but lost progress).

### 4.3 Backfill mode

Triggered by: account creation, rules-pack query upgrade (see §6.4), or user "Re-scan last 30 days".
`watermark=0` → `after:` = now−30d, `SCAN_CAP=1200` (the v11.49 number — covers a 30-day window even at LinkedIn volume), incremental cap stays 300. Backfill runs are labeled `mode:'backfill'` in telemetry and show a progress line in the Inbox UI (`x/1200 scanned`).

### 4.4 Cadence, caps, quota manners

- Interval: **15 min** default (`settings.inbox.intervalMinutes`), min 5, max 240. One in-flight sync per account (module-level mutex, as v11); "Sync now" button = schedule-immediately, returns `409 {syncing:true}` if running.
- 429/`rateLimitExceeded`: exponential backoff 30 s → 8 min, per account, surfaced in telemetry `error`; never busy-loops.
- All fetches `AbortSignal.timeout(20000)` (v11 value).
- AI-fallback classification capped **25 calls per run** (v11's `AI_CLASSIFY_CAP` — a backfill without a cap fired hundreds of serial provider calls).
- Battery/memory gates: inherited `shouldRunBackground()` (pauseOnBattery, memoryGuardMB) from core settings.

### 4.5 On-demand

`POST /api/inbox/sync` `{accountId?, backfill?:boolean}` → runs the tick immediately; response is the sync-run summary. The UI "Sync now" uses it; it is also fired automatically once at app launch (after a 30 s settle delay).

---

## 5. Classification pipeline

### 5.1 Stage 1 — rules ladder (deterministic, order-is-the-algorithm)

The interpreter walks an **ordered** array of `{category, rx, note}` from the rules-pack over `subject + "\n" + body.slice(0,2000)` (lowercased). **Order is semantics** — the v11.64 hard-won ladder ships as the default pack:

1. `offer`
2. `rejection` (broadened v11.65 set: "pursue other candidates", "won't be moving forward", "moved forward with another", "not selected/chosen", "not a fit at this time", "position no longer available"…)
3. `application_confirmation` **STRONG-receipt** ("application was submitted/received successfully", "copy of your application") — pre-empts interview/assessment false-positives from boilerplate footers (the CMiC bug)
4. `assessment` (before interview — coding challenge / take-home / HackerRank / Codility / CodeSignal is its own stage)
5. `interview` (strict *invite/scheduling* language only — never the bare word "interview"; checked before generic confirmation because real invites often carry neutral "Your application to X" subjects)
6. `application_confirmation` (generic "thanks for applying" incl. v11.49's ceipal/workable "thank you for your application FOR X" shapes)
7. `recruiter`
8. → `other`

Never switch to subject-only matching (rejections routinely hide behind neutral subjects — documented in the pack itself as a `"__doNot"` note field so future maintainers see it).

`classified_by='rules'`, `rules_pack_ver` stamped on the row.

### 5.2 Stage 2 — AI fallback (bounded, confidence-gated)

For messages that land in `other` **and** look job-adjacent (prefilter passed, or sender is an ATS domain), when `settings.inbox.aiClassify=true`:

- Prompt: subject + from + body(≤4000) → JSON `{category, company, jobTitle, confidence}` (schema-validated; the v12 AI-provider pillar's `run()` chain).
- Accept iff `confidence ≥ settings.inbox.aiConfidenceMin` (default **0.65**, matching the app-wide `aiAnswerConfidenceMin` convention). Below threshold → stays `other`.
- `classified_by='ai'`, `ai_confidence` stored. Capped 25/run (§4.4).
- AI **never** overrides a rules-ladder category — it only fills `other`. (Rules are auditable; the model is not.)

### 5.3 Manual override

The Inbox UI lets the user re-categorize any email (`classified_by='manual'`). Manual categories are immune to reprocess (reprocess skips `classified_by='manual'` rows for classification, though re-matching still applies unless `match_source='manual'`). Every manual re-categorization is appended to `inbox_training_examples` (same shape as v11's match-training rows) — future pack tuning evidence.

---

## 6. Rules-pack: classification/query config as data (Pillar-2 alignment)

The failure class "hand-patch a regex, ship an app release, wait for auto-update" is what v12's adapters-as-data pillar kills for the DOM; the inbox has the identical failure class for mail patterns. Same cure:

### 6.1 Pack format — `inbox-rules.v<N>.json`

```json
{
  "packVersion": 3,
  "minAppVersion": "12.0.0",
  "gmailQuery": "from:jobs-noreply@linkedin.com OR from:(greenhouse.io OR lever.co OR ashbyhq.com OR myworkdayjobs.com OR workday.com OR icims.com OR smartrecruiters.com OR workable.com OR bamboohr.com OR taleo.net OR jobvite.com OR recruitee.com OR breezy.hr OR successfactors.com) OR \"thank you for applying\" OR \"your application\" OR \"we regret to inform\" OR \"not moving forward\" OR \"move forward with other\" OR \"no longer under consideration\" OR \"other candidates\" OR \"coding challenge\" OR \"take-home\" OR \"online assessment\" OR \"technical assessment\" OR \"schedule an interview\" OR \"interview invitation\" OR \"invite you to interview\" OR \"next steps\" OR \"pleased to offer\" OR \"offer of employment\"",
  "prefilter": {
    "senderDomains": ["linkedin.com","greenhouse.io","grnh.se","lever.co","hire.lever.co","ashbyhq.com","myworkdayjobs.com","workday.com","icims.com","smartrecruiters.com","smartrecruiters.io","workable.com","bamboohr.com","taleo.net","jobvite.com","recruitee.com","breezy.hr","successfactors.com","successfactors.eu"],
    "subjectRx": "application|interview|assessment|offer|candidate|position|role|applying"
  },
  "categories": [
    { "category": "offer",     "rx": "job offer|offer letter|pleased to offer|…", "note": "terminal-positive first" },
    { "category": "rejection", "rx": "unfortunately|we regret|…",                 "note": "v11.65 broadened set" },
    { "category": "application_confirmation", "rx": "application (?:was |has been )(?:submitted|received)…", "note": "STRONG receipt — pre-empts interview footer boilerplate (CMiC bug, v11.64)" },
    { "category": "assessment", "rx": "online assessment|coding (?:challenge|assessment|test|exercise)|…" },
    { "category": "interview",  "rx": "interview invitation|invitation to interview|…", "note": "strict invite language only; before generic confirmation (neutral-subject invites)" },
    { "category": "application_confirmation", "rx": "thank(?:s| you)? (?:so much )?for (?:applying|your application)|…" },
    { "category": "recruiter",  "rx": "recruiter|talent (?:team|acquisition|partner)|…" }
  ],
  "nonCompanyDomains": "greenhouse|lever|workday|…|noreply|no-reply",
  "atsSenderDomains": "greenhouse\\.io|grnh\\.se|lever\\.co|…",
  "freeMailDomains": "(?:^|\\.)(gmail|googlemail|outlook|…)\\.",
  "linkedinSubjects": { "applied": "your application (?:to|for) (.+?) at (.+?)\\s*$", "update": "your update from (.+?)\\s*$" },
  "atsIdExtractors": [
    { "ats": "greenhouse", "rx": "boards\\.greenhouse\\.io/([\\w-]+)/jobs/(\\d+)" },
    { "ats": "lever",      "rx": "jobs\\.lever\\.co/([\\w-]+)/([0-9a-f-]{36})" },
    { "ats": "ashby",      "rx": "jobs\\.ashbyhq\\.com/([\\w-]+)/([0-9a-f-]{36})" }
  ],
  "__doNot": [
    "Do NOT reorder categories without running the fixture corpus — order IS the algorithm.",
    "Do NOT make classification subject-only — rejections hide behind neutral subjects.",
    "Do NOT narrow gmailQuery to one sender — that was v11's E1 (pipeline froze at 'submitted')."
  ]
}
```

All regexes compile with `i`; the interpreter validates every `rx` at load (bad pattern → pack rejected, previous pack retained, error surfaced).

### 6.2 Distribution & precedence

Same channel as site adapters (Pillar 2): baked default in the app bundle → overridden by a fetched pack from the adapters repo/endpoint (checked daily, signed/etag'd per Pillar 2's mechanism) → overridden by a local dev pack at `settings.inbox.rulesPackPath` for iteration. Active `packVersion` is visible in the Inbox settings pane.

### 6.3 Regression corpus gate

`app/test/fixtures/inbox/*.json` — real (sanitized) emails, one per known shape, each labeled with expected `category`; **the corpus is the pack's CI gate** — a pack update that changes any expected label fails. Seed corpus: LinkedIn confirmation, LinkedIn "your update from", CMiC strong-receipt, ceipal/workable "thank you for your application FOR X", a neutral-subject rejection, a neutral-subject interview invite, a HackerRank assessment, a Greenhouse rejection, a recruiter cold-reach, an offer letter. (Extractable from Pierre's live v11 emails table during import, hand-sanitized.)

### 6.4 Pack upgrade behavior (the v11.48 migration lesson, generalized)

When the active pack's `gmailQuery`/`prefilter` **broadens** (new version differs from the one that ran the last backfill, tracked in `kv inbox.lastBackfillPackVer.<acct>`): schedule an automatic **backfill** (watermark 0 re-scan of 30 days) so mail that the old query never fetched gets pulled — the v11.48 `migrateGmailQuery + watermark reset` behavior, but automatic on every future broadening, not a one-off kv-flagged migration. When only `categories` change: schedule a **reprocess** (§9) instead — no refetch needed.

---

## 7. Matching: email → application

Ladder (first hit wins), ported from v11 with one new rung (ATS ids). Implemented in `match.ts` as pure functions over `(email, jobsForMatching[])`.

### 7.1 Rung 1 — Thread continuity (confidence 0.95, `via:'thread'`)

If the message shares a `thread_id` with an already-matched (`auto|manual`, never `suggested`) email, or its `in_reply_to`/`ref_ids` name a matched email's `rfc_message_id` → inherit that job. This is what catches "Re: your application" from a recruiter's personal address. (v11 `findJobByThread` — keep the never-inherit-from-suggested rule.)

### 7.2 Rung 2 — ATS external id (confidence 0.93, `via:'ats_id'`) — NEW in v12

Run `pack.atsIdExtractors` over the raw body's URLs. A Greenhouse/Lever/Ashby job/application id that equals a tracked job's `external_id`/`source_url` id (the apply pillar stamps these at submit time for direct-ATS applies) is a near-certain link — stronger than any fuzzy company match, and exactly the population (direct-ATS boards) where company names in mail headers are least reliable. This rung is why the schema keeps full `body` (URLs live there).

### 7.3 Rung 3 — Company + title + time scoring (v11's scorer, kept)

`companyHints()` (sender-domain root when not a job-board/free-mail domain; sender name; subject extraction) → candidate jobs by normalized-company containment → score:

```
s = 1 − min(days(|sentAt − appliedAt|), 120)/120        // time proximity
    + 0.35 if job title appears in subject/body(≤1500)
    + 0.30 if sender's own domain root ↔ company name    // strongest single signal
    else + 0.18 if sender is a known ATS mail system
    ; s = −1 if email predates the apply by >2 days      // not ours
best ≥ 0.6 AND clear winner (gap > 0.25) → auto   (confidence 0.7 + s·0.25, cap 0.96)
else                                     → suggested (confidence 0.4 + s·0.3, cap 0.69)
```

Thresholds live in settings (`inbox.autoLinkThreshold` 0.7 / `inbox.suggestThreshold` 0.4) as in v11.

### 7.4 Rung 4 — AI disambiguation (bounded post-pass)

After each sync: up to **6** `suggested` emails in high-value categories (`interview|offer|assessment`) with ≥2 same-company candidates go to `aiPickJob` (candidates list → `{index, confidence, reason}`); accept iff confidence ≥ 0.7 → upgrade to `auto` (`via:'ai'`, confidence capped 0.95). Otherwise the email stays in the needs-confirm queue. (v11 `aiDisambiguateSuggested`, unchanged — it only breaks genuine ties.)

### 7.5 Auto-create for orphan confirmations

An unmatched `application_confirmation` with a derivable `{title?, company}` (LinkedIn subject shapes + generic "application was sent to X") creates a tracked job (`status:'submitted'`, `source:'email'`, `external_id:'email:'+normCo+':'+normTitle` dedup, tag `from-email`) and links at 0.9 / `via:'auto-created'` — applications made outside JAT still enter the funnel. The created job is pushed into the in-run `jobs` array so later emails in the same sync match it instead of duplicating (v11 lesson).

### 7.6 Needs-confirm queue

`suggested` matches never auto-elevate. They surface as a queue (Inbox page badge + per-job "suggested emails" section). `POST /api/inbox/emails/:id/confirm {jobId?, confirm:boolean}`:
- confirm → `match_source='manual'`, confidence `max(existing, 0.85)`, forward-only elevation runs, positive training example stored.
- dismiss → `match_source='dismissed'`, negative training example, never re-suggested for that job (reprocess respects dismissals).

---

## 8. Status advancement (`elevate.ts`)

### 8.1 The ladder (v11's FSM, unchanged — it never mis-fired)

```
STATUS_ORDER: started 10 · submitted 20 · contacted 30 · assessment 35 ·
              interview_1 40 · interview_2 50 · interview_final 60 ·
              offer 70 · hired 80 · rejected 90 · withdrawn 91 · ghosted 92
TERMINAL: {hired, rejected, withdrawn, ghosted}

categoryToStatus: offer→offer · interview→interview_1 · assessment→assessment ·
                  rejection→rejected · recruiter→contacted · application_confirmation→submitted
```

### 8.2 Rules (all hard)

1. **Evidence required:** only an email with `match_source IN ('auto','manual')` can move a status. `suggested` never moves anything.
2. **Forward-only:** `STATUS_ORDER[incoming] > STATUS_ORDER[current]`, except `rejected` which may land from any non-terminal state. Emails can never demote.
3. **Terminal is terminal:** no email touches a job in a TERMINAL state. (Un-ghosting exception: a matched email arriving for a `ghosted` job *is* new evidence the silence assumption was wrong — v12 adds: if `current='ghosted'` and a matched email's category maps to any active status, revive to that status with an events row `source:'inbox-unghost'`. v11 lacked this; ghosted jobs that later got interviews stayed ghosted.)
4. **Idempotent + unconditional (E4):** elevation is attempted on *every* auto/manual match event — sync, confirm, reprocess — with the forward-only guard making repeats no-ops. There is no "only if category changed" path anywhere.
5. **Audit (single transaction):** `UPDATE jobs` + `INSERT events` commit together; the events row carries `{from, to, emailId, subject≤200, from_addr≤120}`.
6. **Manual override wins:** the user can set any status from the UI (including demotion); a manual status change writes `source:'user'` to events, and subsequent email evidence still obeys rule 2 against the new value. No special lockout (v11 behavior; simplicity won).

### 8.3 Ghosted sweep

`sweepGhosted({days:28})`: `submitted` jobs with no matched email and no event newer than the window → `ghosted` (+ events row `source:'ghost-sweep'`). Runs at launch + every 6 h, **gated on inbox coverage** (§3.3): never marks ghosted across a period the pipeline was deaf.

---

## 9. Reprocess (`reprocess.ts`)

`POST /api/inbox/emails/reprocess {scope?: 'all'|'unmatched'|'sincePackVer'}` — re-runs classify (skipping `classified_by='manual'`) + match (skipping `match_source IN ('manual','dismissed')`) + elevate over stored emails. Chunked 200 rows/transaction to keep the writer responsive; progress via SSE. Auto-scheduled on: pack `categories` change (§6.4), v11 import completion (§12), and available as a button in Inbox settings ("Re-run pipeline"). Because elevation is idempotent-unconditional, reprocess is always safe to run twice.

---

## 10. API surface + SSE (lean, patch-based — E6)

```
GET    /api/inbox/status                 → per-account {id,email,kind,enabled,tokenState,tokenAgeDays,
                                           lastSync:{at,mode,stored,elevated,error}, watermark, historyIdSet,
                                           queueCounts:{suggested, other}}   (NO bodies, NO lists)
POST   /api/inbox/accounts/gmail/auth    → runs loopback flow → {ok, account?}
POST   /api/inbox/accounts/imap          → {provider,email,password,host?,port?} → test+create
POST   /api/inbox/accounts/:id/test      → IMAP connection test / Gmail profile probe
PATCH  /api/inbox/accounts/:id           → {enabled?, label?}
DELETE /api/inbox/accounts/:id           → cascade-deletes secrets; emails rows kept (account_id orphan-tolerant read)
POST   /api/inbox/sync                   → {accountId?, backfill?} → sync-run summary
GET    /api/inbox/emails?filter=&limit=&cursor=   → LEAN projection: {id, from_addr, from_name, subject,
                                           snippet, sent_at, category, matched_job_id, match_source,
                                           match_confidence}  — never `body`
GET    /api/inbox/emails/:id             → full row incl. body (detail-on-demand)
POST   /api/inbox/emails/:id/confirm     → {jobId?, confirm:boolean}
POST   /api/inbox/emails/:id/category    → {category} manual re-classify
POST   /api/inbox/emails/reprocess       → {scope?}
GET    /api/inbox/diagnostics            → sender-domain histogram (last 30d), category histogram,
                                           match-source histogram, pack version — the E1 "is the query
                                           too narrow" panel, one GROUP BY each
```

SSE patches (the app's single event bus): `inbox.account {id, tokenState, lastSync}` · `inbox.email.upserted {leanRow}` · `inbox.queue {suggestedCount}` · `job.patched {id, status, …}` (core event, fired by elevation) · `inbox.sync.progress {accountId, scanned, cap}` (backfill only). **Never** an event that means "refetch the list".

---

## 11. Retention & DB hygiene (designed in, not bolted on)

Nightly maintenance pass (core scheduler):
- `emails`: delete `match_source IS NULL OR match_source='dismissed'` rows older than `settings.retention.emailDays` (default 365). Matched (`auto|suggested|manual`) rows are kept forever — they are the funnel's evidence.
- `emails.body`: for matched rows older than 90 days, body is trimmed to 1000 chars (snippet + ATS ids already extracted; full text no longer needed). Saves the dominant blob weight.
- `inbox_sync_runs`: 30-day retention.
- `inbox_training_examples`: cap 2000 rows, FIFO.
All prunes feed the core VACUUM cadence (every 3 days, from v11's tuned settings).

---

## 12. v11 import (one-time, per machine — Pierre's and Dad's)

Handled by the core v12 importer pillar; inbox-specific mapping specified here:

- Source: `%APPDATA%\jat11-app\jat.db`, **read-only, v11 stopped** (wasm VFS lock).
- `emails` (497 rows): map 1:1 — `uid`→`provider_msg_id` (stringified), `message_id`→`rfc_message_id`, `category/matched_job_id/match_confidence/match_source` carried over (job ids remapped via the importer's job-id map), `classified_by='rules'`, `rules_pack_ver=0` (marks them pre-v12 → included in `sincePackVer` reprocess).
- `kv.emailAccounts` (IMAP accounts incl. app passwords) → `email_accounts` + `safeStorage`-encrypted secrets. `kv.gmailTokens` → **not imported** (7-day rot means they're dead anyway); the account row is created as `token_state='unauthorized'` and the UI prompts one fresh OAuth click.
- Cursors: `kv.gmailWatermark` → `watermark_ms`; IMAP cursors (`emailCursor`) → `imap_uid`/`imap_uidvalidity`. `history_id` starts NULL → first v12 sync is a query-poll that seeds it.
- Post-import: auto-schedule reprocess (`scope:'all'`) so v12's ladder + ATS-id rung re-evaluate the historical inbox; forward-only guard means imported job statuses can only be corrected upward.

---

## 13. Notification policy (`notify.ts`)

One table, one place (the Pillar-3 "one enforcement point" rule applied to noise):

| Event | OS notification | In-app |
|---|---|---|
| `offer` matched | **Yes** (always, even if quiet hours) | banner + chip |
| `interview` / `assessment` matched (auto or confirmed) | **Yes** | badge |
| `rejection` matched | No (batch: daily digest line "3 rejections today") | list + funnel |
| `application_confirmation` matched / auto-created job | No | list |
| new `suggested` needing confirm | No (badge only); **Yes** if it's `interview|offer` category | queue badge |
| token `expiring_soon` | Yes, once per window | amber chip + banner |
| token `expired`/`revoked` | Yes (click → reconnect pane) | red chip |
| ghost-sweep result | No | weekly digest line |
| sync error (3 consecutive) | No | chip tooltip |

Rules: max 1 OS notification per (account, reason-class, 6 h) except offer/interview which are per-email; all OS notifications deep-link (focus app → relevant pane); no sounds ever (the v11 AudioContext-beep complaint). Related-email rows in the UI deep-link to the real Gmail message via `rfc822msgid:` search URL (thread-id fallback) — v11.65 feature, kept.

---

## 14. Settings (namespace `inbox.*`)

```jsonc
{
  "inbox": {
    "enabled": true,
    "intervalMinutes": 15,
    "aiClassify": true,
    "aiConfidenceMin": 0.65,
    "aiPickMinConfidence": 0.7,
    "autoLinkThreshold": 0.7,
    "suggestThreshold": 0.4,
    "tokenWarnDays": 5,
    "tokenDeadDays": 7,
    "ghostDays": 28,
    "forcePollMode": false,          // debug: skip history API
    "rulesPackPath": "",             // local dev override
    "gmail": { "clientId": "", "clientSecret": "" }
  },
  "retention": { "emailDays": 365, "syncRunDays": 30 }
}
```

---

## 15. Test plan

1. **Classifier regression corpus** (§6.3) — CI gate; every historical false-positive is a named fixture (`cmic-strong-receipt.json`, `neutral-subject-rejection.json`, …).
2. **Matcher unit tests** — thread inheritance (incl. never-from-suggested), ATS-id rung beats fuzzy rung, time-window negative (email predating apply), clear-winner gap, auto-create dedup within one run.
3. **Elevation FSM property test** — for every (current, category) pair assert forward-only + terminal + rejection-exception + unghost; fuzz repeat-application for idempotency.
4. **Token lifecycle simulation** — fake clock + stubbed token endpoint: healthy→expiring_soon at day 5, invalid_grant→expired, re-auth resets, notification dedup fires once.
5. **Sync engine** — stubbed Gmail API: history-page walk, 404-historyId→poll fallback→re-seed, per-message watermark commit under injected crash, backfill cap, 429 backoff.
6. **E2E (harness)** — seed 30 fixture messages into a fake mailbox, run a full tick, assert funnel counts + events rows + SSE patch stream shape (no list-refetch events).

---

## 16. Build order (inside this pillar)

1. Schema + accounts + safeStorage secrets + status endpoint (chip renders "unauthorized").
2. Gmail OAuth flow + token state machine + re-auth UX (testable before any sync exists).
3. Query-poll sync + rules classifier + default pack + fixtures (v11 parity milestone — funnel moves).
4. Matcher ladder + elevation + needs-confirm queue + notifications.
5. History-API incremental + metadata prefilter.
6. IMAP fallback port.
7. Reprocess + pack-upgrade hooks + diagnostics panel.
8. v11 import mapping + retention pass.

---

## 17. Open questions

1. **Google app verification**: staying in "Testing" forever means the weekly renew ritual (mitigated but real). Is Pierre ever willing to do CASA for `gmail.readonly`, or should IMAP mode become the *recommended* default for family installs (Dad), with OAuth as the power-user path? Current design supports both; the default recommendation needs a product call.
2. **`gmail.metadata` scope split**: the prefilter stage could run on the non-restricted `gmail.metadata` scope and only body-fetch survivors with `readonly` — but Google doesn't allow per-call scope mixing on one token, so it buys nothing unless we run two grants. Parked; revisit only if verification is attempted.
3. **Multi-profile interaction**: emails are currently global while learned memory is per-profile. If two profiles apply to the same company, rung-3 matching could cross-link. Rung 2 (ATS ids) and rung 1 (threads) are profile-safe; is rung 3 ambiguity across profiles worth a `profile_id` column on emails, or does the same-company-candidate scorer suffice? Needs the architect's call jointly with the profiles pillar.
4. **Outlook OAuth (Graph API)**: IMAP covers Outlook today; native Graph sync (with its own token lifecycle) is a v12.x follow-up, not launch scope — confirm.
5. **Digest cadence**: daily rejection digest + weekly ghost digest are proposed in §13 — Pierre hasn't validated wanting digests at all; ship behind a toggle default-on or default-off?
