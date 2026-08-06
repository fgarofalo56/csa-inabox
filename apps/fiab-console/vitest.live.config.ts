/**
 * vitest.live.config.ts — the LIVE-AZURE receipt harness.
 *
 * CI never runs this. The default `vitest.config.ts` include globs are
 * `lib/**​/__tests__`, `app/**​/__tests__` and `__tests__/**`; nothing under
 * `scripts/live/` matches any of them, so a probe here cannot be mistaken for
 * a gate and cannot make CI green by skipping (`csa_loom_gates_that_cannot_fail`).
 *
 * It exists so a change to an Azure-facing module can produce the real-data
 * receipt `.claude/rules/no-vaporware.md` requires, by running the SHIPPED code
 * against a REAL Azure endpoint rather than a fake transport:
 *
 *   export LOOM_LIVE_ARM_TOKEN="$(az account get-access-token \
 *       --resource https://management.azure.com --query accessToken -o tsv)"
 *   node_modules/.bin/vitest run --config vitest.live.config.ts
 *
 * A probe MUST fail loudly when the token is absent rather than skipping, so a
 * receipt can never be produced by a run that did nothing.
 *
 * Commercial only. Azure Government is never reached from a workstation — Gov
 * receipts come from GitHub Actions.
 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@/lib': path.resolve(__dirname, './lib'),
      '@/app': path.resolve(__dirname, './app'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['scripts/live/**/*.live.ts'],
    // A live estate walk legitimately takes longer than a unit test.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
