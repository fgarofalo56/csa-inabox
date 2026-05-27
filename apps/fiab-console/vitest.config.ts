import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest config for the Power Platform / ML / Geo / Graph editor family.
 *
 * Scope:
 *   - Pure-logic unit tests for lib/editors/_family-utils.ts
 *   - Future expansion: each editor family extracts its math into a
 *     `_*-utils.ts` neighbor module and adds tests under
 *     `lib/editors/__tests__/*.test.ts`.
 *
 * Environment is `node` (not jsdom) — we intentionally do NOT test the
 * React render path here. That coverage lives in the Playwright UAT
 * harness under e2e/*.uat.ts where real Loom is driven end-to-end.
 *
 * Run:  pnpm --filter @csa-loom/fiab-console test
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**', 'dist/**', 'out/**', 'tests/**', 'e2e/**'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['lib/editors/_family-utils.ts'],
      reporter: ['text', 'html'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@/lib': path.resolve(__dirname, 'lib'),
      '@/app': path.resolve(__dirname, 'app'),
    },
  },
});
