import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest config for fiab-console.
 *
 * Real-only — there is no mocked-data fixture suite. Tests verify that the
 * editor modules parse, export the expected component names, and that the
 * shared registry maps every Synapse / Databricks / ADF slug to a valid
 * factory. Anything that actually hits Azure REST is covered by the
 * Playwright UAT suite in `e2e/` (which mints a session and walks the live
 * deployment) — Vitest is intentionally narrow to keep CI deterministic.
 *
 * Per .claude/rules/no-vaporware.md: do not add tests that pretend to cover
 * backend behavior they do not exercise.
 */
export default defineConfig({
  test: {
    include: ['lib/**/*.test.{ts,tsx}', '__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
    globals: false,
    passWithNoTests: false,
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
