/**
 * Vitest config for the fiab-console — Data Engineering sweep.
 *
 * Mounts editor components in jsdom and exercises their primary user
 * actions with mocked fetch. Specs live next to the editor sources
 * under __tests__/.
 *
 * The @vitejs/plugin-react import is `require`-loaded so vitest can
 * find the plugin via the project's pnpm-resolved node_modules
 * without forcing an ESM-only resolution path.
 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';

let react: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  react = require('@vitejs/plugin-react');
  react = react?.default || react;
} catch {
  react = null;
}

export default defineConfig({
  plugins: react ? [react()] : [],
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      '@/lib': path.resolve(__dirname, 'lib'),
      '@/app': path.resolve(__dirname, 'app'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    include: ['lib/**/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'dist', 'e2e', 'tests'],
    testTimeout: 10_000,
  },
});
