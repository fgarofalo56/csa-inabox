/**
 * Vitest config for the FiaB Console BFF + editor logic unit tests.
 *
 * Scope: pure-TypeScript helpers and route-shape contracts. Editor JSX
 * rendering is covered by the Playwright E2E suite — this Vitest run is
 * the fast inner loop for the deterministic logic that backs them.
 *
 * Discovery: any `*.test.ts` or `*.test.tsx` file outside the e2e/ and
 * tests/ directories (those hold the Playwright + walkthrough scripts).
 */

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      '@/lib': path.resolve(__dirname, 'lib'),
      '@/app': path.resolve(__dirname, 'app'),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
      '**/.next/**',
      'e2e/**',
      'tests/**',
    ],
    globals: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
