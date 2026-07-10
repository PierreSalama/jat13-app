// Vitest runs on NODE (never Electron) — better-sqlite3 must be built for the node ABI
// (`npm run rebuild:node` after any `npm run dev`, which flips it to the Electron ABI).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests live at the root (they exercise app/src + shared/src across workspace boundaries),
    // split unit/ vs integration/ by convention — one `vitest run` covers both.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // forks (child processes), not threads: native better-sqlite3 bindings are not
    // worker-thread-safe across parallel test files.
    pool: 'forks',
  },
});
