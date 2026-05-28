/**
 * Vitest config — Loom Console.
 *
 * Tests are scoped to `lib/**` (server-side / client-utility modules). The
 * TSX page/component tree is exercised by the Playwright UAT specs in
 * `e2e/`, not by Vitest, because we intentionally avoid pulling jsdom +
 * happy-dom into the unit-test scope (they conflict with Fluent UI's
 * tokenized makeStyles + Next.js navigation hooks).
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
    include: ['lib/**/__tests__/**/*.test.ts', 'app/**/__tests__/**/*.test.ts'],
    globals: false,
    pool: 'forks',
  },
});
