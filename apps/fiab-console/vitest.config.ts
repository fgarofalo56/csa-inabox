/**
 * Vitest config for fiab-console.
 *
 * Unified config — merges the Data Engineering sweep's jsdom + plugin-react
 * needs with main's broader include globs (catalog API tests). React plugin
 * loads via require so vitest finds it via pnpm-resolved node_modules
 * without ESM-only paths.
 *
 * Per .claude/rules/no-vaporware.md: do not add tests that pretend to cover
 * backend behavior they do not exercise.
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
      '@': path.resolve(__dirname, '.'),
      '@/lib': path.resolve(__dirname, './lib'),
      '@/app': path.resolve(__dirname, './app'),
    },
  },
  test: {
    // API / logic tests run on node; component + editor render tests (*.test.tsx)
    // run on jsdom. vitest.setup.ts (jest-dom matchers + next/navigation, monaco,
    // ResizeObserver/matchMedia stubs) is now wired so render() actually mounts —
    // the harness was previously env:'node' with no setupFiles, which made every
    // render test fail to mount (see .claude memory fiab-console-vitest-harness-broken).
    environment: 'node',
    environmentMatchGlobs: [
      ['**/*.test.tsx', 'jsdom'],
    ],
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
    pool: 'forks',
    // The first `await import('../route')` in a heavy BFF spec triggers an
    // on-demand TS transform of the route AND its whole dependency graph. Under
    // full-suite parallel forks that cold transform can exceed the default 5s
    // per-test budget (the tests themselves are fast — they pass in isolation),
    // producing flaky "Test timed out in 5000ms" failures on otherwise-passing
    // specs. Give tests + hooks a generous ceiling so a slow cold transform is
    // never mistaken for a hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [
      'lib/**/__tests__/**/*.test.{ts,tsx}',
      'app/**/__tests__/**/*.test.{ts,tsx}',
      // Console-root suites (registry coverage, APIM policy/XML scope,
      // Copilot Studio ↔ Dataverse scope) — these were previously dark because
      // the globs only matched lib/** and app/**.
      '__tests__/**/*.test.{ts,tsx}',
    ],
    exclude: ['node_modules', '.next', 'dist', 'e2e', 'tests', 'test-results'],
    // ── Coverage (rel-T28) ────────────────────────────────────────────────
    // v8 provider (no Babel instrumentation). `all: true` counts EVERY source
    // file under include — not just the ones a test imported — so the
    // denominator is the whole console surface and the floor can only be
    // ratcheted UP by adding tests, never gamed by narrowing what's measured.
    //
    // RATCHET CONVENTION: the thresholds below are the FLOOR, set a couple of
    // points BELOW the last measured reality. When you add tests and coverage
    // climbs, RAISE the floor to (new measured − ~2pts) in the same PR. Never
    // lower it. `pnpm vitest run --coverage` enforces it (fails under the floor).
    coverage: {
      provider: 'v8',
      all: true,
      reporter: ['text-summary', 'json-summary', 'text'],
      reportsDirectory: './coverage',
      include: ['lib/**', 'app/**'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        // Type-only / declaration barrels and generated assets carry no
        // executable lines — counting them just dilutes the signal.
        'lib/**/*.types.ts',
        'app/**/layout.tsx',
        'app/**/loading.tsx',
        'app/**/not-found.tsx',
      ],
      // FLOOR — measured reality 2026-07-03 (whole-console, all:true):
      //   statements 32.52% · branches 56.85% · functions 30.86% · lines 32.52%
      // Floor set ~2pts below each (ratchet UP only — see convention above).
      // The gap to 100% is mostly client `app/**/page.tsx` components, which the
      // vitest slice does not render (routes/editors/lib ARE covered); those are
      // exercised by the Playwright UAT slice (rel-T30), not here.
      thresholds: {
        statements: 30,
        branches: 54,
        functions: 28,
        lines: 30,
      },
    },
  },
});
