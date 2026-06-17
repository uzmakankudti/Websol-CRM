import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Loads local.settings.json into process.env before any test module is
    // imported, so shared/config.ts has what it needs (mirrors `func start`).
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    // The DB pool test opens real connections; give it a little headroom.
    testTimeout: 15000,
  },
});
