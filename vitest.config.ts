import { defineConfig } from 'vitest/config';

// Tests are server-side (Node + node:sqlite). Web/UI code isn't covered here —
// it's `@ts-nocheck` and exercised manually. Adding jsdom would be premature.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/server/**/*.test.ts'],
    // Each test file runs in its own worker process (default). Within a file,
    // db.ts's singleton is reset in `beforeEach` via `closeDb()`, so tests
    // within a file are also isolated.
    pool: 'threads',
    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      include: ['src/server/**/*.ts'],
      exclude: ['src/server/**/*.test.ts', 'src/server/__tests__/**'],
    },
  },
});
