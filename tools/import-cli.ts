// One-off standalone importer: v11 jat.db → the v13 prod DB (the same file the installed app opens).
// v11 is LIVE at :7744 and auto-restarts — its file is NEVER opened directly. We SNAPSHOT the v11 db
// files (db + -wal + -shm) to a temp dir via snapshotV11 and import from the COPY.
//
// Gmail creds migration is deliberately NOT here: unsealing v11's `enc:v1:` blobs needs Electron
// safeStorage (DPAPI), which does not exist under plain node — the consent-gated migrateGmailCredentials
// runs inside the app's import wizard instead.
//
// Env (all required):
//   V11_DB         path to the live v11 jat.db (e.g. C:\Users\pierr\AppData\Roaming\jat11-app\jat.db)
//   V12_DB         path to the target v13 db (the installed app's jat13.db; created+migrated if absent)
//   MIGRATIONS_DIR path to app/src/main/db/migrations (or the packaged copy beside main.js)
//
// Run (node can't resolve the repo's NodeNext .js→.ts import suffixes natively, so bundle first —
// esbuild is already a root devDependency; the bundle lands inside node_modules so the externalized
// better-sqlite3 resolves. From the v13 repo root, PowerShell):
//   npx esbuild tools/import-cli.ts --bundle --platform=node --format=esm `
//     --external:better-sqlite3 --outfile=node_modules/.jat13-tools/import-cli.mjs
//   $env:V11_DB='C:\Users\pierr\AppData\Roaming\jat11-app\jat.db'
//   $env:V12_DB='C:\Users\pierr\AppData\Roaming\jat13-app\jat13.db'
//   $env:MIGRATIONS_DIR="$PWD\app\src\main\db\migrations"
//   node node_modules/.jat13-tools/import-cli.mjs
// NB: better-sqlite3 must be built for the NODE ABI (`npm run rebuild:node` after any `npm run dev`).

import { rmSync } from 'node:fs';
import { openDatabase } from '../app/src/main/db/index.js';
import { planImport, executeImport, snapshotV11 } from '../app/src/main/importer/v11.js';

const SRC = process.env.V11_DB;
const V12 = process.env.V12_DB;
const MIGRATIONS = process.env.MIGRATIONS_DIR;
if (!SRC || !V12 || !MIGRATIONS) throw new Error('set V11_DB, V12_DB, MIGRATIONS_DIR');

// snapshot the source (+ WAL/SHM if present) so the running v11 can't tear the read
const snap = snapshotV11(SRC);
console.log(`snapshotted v11 db → ${snap.path}`);

console.log('\n=== PLAN (dry run, read-only) ===');
const plan = planImport(snap.path);
console.log(JSON.stringify(plan, null, 2).slice(0, 6000));

console.log('\n=== EXECUTE ===');
const { db, migration } = openDatabase({ file: V12, migrationsDir: MIGRATIONS });
console.log(`v13 db opened @ schema v${migration.to} (from v${migration.from})`);
const res = executeImport(db, snap.path);
console.log('status:', res.status);
if (res.sectionErrors.length) console.log('section errors:', JSON.stringify(res.sectionErrors, null, 2));
console.log('report:', JSON.stringify(res.report, null, 2).slice(0, 8000));

// ---- post-import truth check — audit against source-DB invariants, not just row totals (scar 14.5)
const q = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
console.log('\n=== POST-IMPORT COUNTS (v13 db) ===');
console.log('profiles:            ', q('SELECT COUNT(*) c FROM profiles'));
console.log('jobs:                ', q('SELECT COUNT(*) c FROM jobs'));
console.log('applications:        ', q('SELECT COUNT(*) c FROM applications'));
console.log('  status=submitted:  ', q("SELECT COUNT(*) c FROM applications WHERE status = 'submitted'"),
  '   <-- must match v11 reality (~630), NOT 0 — the reconcileStatus check');
console.log('learned_answers:     ', q('SELECT COUNT(*) c FROM learned_answers'));
console.log('documents:           ', q('SELECT COUNT(*) c FROM documents'));
console.log('  with bytes (blobs):', q('SELECT COUNT(*) c FROM document_blobs'));
console.log('emails:              ', q('SELECT COUNT(*) c FROM emails'));
console.log('email_matches:       ', q('SELECT COUNT(*) c FROM email_matches'));
console.log('events:              ', q('SELECT COUNT(*) c FROM events'));
console.log('apply_runs:          ', q('SELECT COUNT(*) c FROM apply_runs'));
const byState = db
  .prepare('SELECT state, COUNT(*) c FROM apply_runs GROUP BY state ORDER BY c DESC')
  .all() as { state: string; c: number }[];
for (const r of byState) console.log(`  run state ${r.state}: ${r.c}`);
const bySource = db
  .prepare('SELECT source, COUNT(*) c FROM apply_runs GROUP BY source ORDER BY c DESC')
  .all() as { source: string; c: number }[];
for (const r of bySource) console.log(`  run source ${r.source}: ${r.c}   <-- must NOT be all-linkedin (lane/source-from-job check)`);
console.log('apply_ledger:        ', q('SELECT COUNT(*) c FROM apply_ledger'), '  (verified historical submits — cap authority)');
console.log('import_runs (audit): ', q('SELECT COUNT(*) c FROM import_runs'), ` last id: ${res.importRunId}`);
db.close();

// clean up the snapshot (best-effort; print the path if it survives)
try {
  rmSync(snap.dir, { recursive: true, force: true });
} catch {
  console.log(`(snapshot left at ${snap.dir})`);
}

process.exitCode = res.status === 'ok' ? 0 : 1;
console.log(`\nDONE (${res.status}).`);
