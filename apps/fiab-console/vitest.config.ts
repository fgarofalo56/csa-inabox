import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest config for fiab-console.
 *
 * Real-only — there is no mocked-data fixture suite. Tests verify that
 * editor modules parse, export the expected component names, and that
 * provisioners + feature-gate logic behave as documented. Anything that
 * actually hits Azure REST is covered by the Playwright UAT suite in
 * `e2e/` (which mints a session and walks the live deployment).
 *
 * Per .claude/rules/no-vaporware.md: do not add tests that pretend to cover
 * backend behavior they do not exercise.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    passWithNoTests: false,
    testTimeout: 10_000,
    include: [
      'lib/**/__tests__/**/*.test.{ts,tsx}',
      'lib/**/*.test.{ts,tsx}',
      '__tests__/**/*.test.{ts,tsx}',
    ],
    exclude: ['node_modules', '.next', 'e2e', 'test-results'],
  },
  resolve: {
    alias: {
      '@/lib': path.resolve(__dirname, './lib'),
      '@/app': path.resolve(__dirname, './app'),
      '@': path.resolve(__dirname, '.'),
    },
  },
});
