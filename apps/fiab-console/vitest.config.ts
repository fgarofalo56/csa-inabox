import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest config — runs lib/** unit suites in node env. Component tests
 * use lightweight prop-shape assertions instead of a full DOM, so we
 * avoid pulling in jsdom + @testing-library (not yet in package.json).
 *
 * Playwright UAT runs separately via `pnpm test:e2e`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'lib/**/*.test.ts',
      'lib/**/*.test.tsx',
      'lib/**/__tests__/**/*.test.ts',
      'lib/**/__tests__/**/*.test.tsx',
    ],
  },
});
