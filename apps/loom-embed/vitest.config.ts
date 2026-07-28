import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    // jsdom so the <loom-report> custom element + the mocked fetch render path
    // can be exercised in the render test.
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Resolve the sibling SDK source directly (no install/publish needed for
      // the package's own tests) — the "extends @csa-loom/sdk" dependency.
      '@csa-loom/sdk': fileURLToPath(new URL('../loom-sdk/src/index.ts', import.meta.url)),
    },
  },
});
