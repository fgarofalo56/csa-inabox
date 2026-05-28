import { defineConfig } from 'vitest/config';
import path from 'node:path';

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
    },
  },
});
