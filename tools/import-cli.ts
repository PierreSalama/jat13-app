// One-off standalone importer: v11 jat.db → the v12 prod DB (the same file the installed app opens).
// Bundled by esbuild + run under node. To be safe even if v11 is running (it auto-restarts), we
// SNAPSHOT the v11 db files to a temp dir (plan §5.1) and import from the COPY — the live v11 file is
// never opened. Paths + migrations dir via env.
import { openDatabase } from '../app/src/main/db/index.js';
import { planImport, executeImport } from '../app/src/main/importer/v11.js';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = process.env.V11_DB;
const V12 = process.env.V12_DB;
const MIGRATIONS = process.env.MIGRATIONS_DIR;
if (!SRC || !V12 || !MIGRATIONS) throw new Error('set V11_DB, V12_DB, MIGRATIONS_DIR');

// snapshot the source (+ WAL/SHM if present) so a running v11 can't tear the read
const snapDir = mkdtempSync(join(tmpdir(), 'jat11-snap-'));
const V11 = join(snapDir, 'jat.db');
copyFileSync(SRC, V11);
for (const suffix of ['-wal', '-shm']) {
  if (existsSync(SRC + suffix)) copyFileSync(SRC + suffix, V11 + suffix);
}
console.log(`snapshotted v11 db → ${V11}`);

console.log('=== PLAN (dry run, read-only) ===');
const plan = planImport(V11);
console.log(JSON.stringify(plan, null, 2).slice(0, 4000));

console.log('\n=== EXECUTE ===');
const { db, migration } = openDatabase({ file: V12, migrationsDir: MIGRATIONS });
console.log(`v12 db opened @ schema v${migration.to}`);
const res = executeImport(db, V11);
console.log('status:', res.status);
console.log('report:', JSON.stringify(res.report, null, 2).slice(0, 6000));

// quick post-import truth check
const q = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
console.log('\n=== POST-IMPORT COUNTS (v12 db) ===');
console.log('jobs:', q('SELECT COUNT(*) c FROM jobs'));
console.log('applications:', q('SELECT COUNT(*) c FROM applications'));
console.log('learned_answers:', q('SELECT COUNT(*) c FROM learned_answers'));
console.log('documents:', q('SELECT COUNT(*) c FROM documents'));
console.log('emails:', q('SELECT COUNT(*) c FROM emails'));
console.log('apply_runs:', q('SELECT COUNT(*) c FROM apply_runs'));
console.log('profiles:', q('SELECT COUNT(*) c FROM profiles'));
db.close();
console.log('\nDONE.');
