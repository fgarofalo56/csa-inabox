import { defineConfig } from 'vitest/config';
import path from 'node:path';

<<<<<<< HEAD
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
=======
<<<<<<< HEAD
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['lib/**/__tests__/**/*.test.ts', 'lib/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'e2e', 'test-results'],
  },
  resolve: {
    alias: {
      '@/lib': path.resolve(__dirname, './lib'),
      '@/app': path.resolve(__dirname, './app'),
      '@': path.resolve(__dirname, './'),
=======
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
>>>>>>> origin/main
    },
  },
>>>>>>> origin/main
});
