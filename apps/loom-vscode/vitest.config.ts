import { defineConfig } from 'vitest/config';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Same interim SDK resolution the bundler uses (build.mjs) — the SDK has
      // no npm tag yet, so tests resolve it to the sibling app's source.
      '@csa-loom/sdk': path.resolve(dir, '../loom-sdk/src/index.ts'),
    },
  },
});
