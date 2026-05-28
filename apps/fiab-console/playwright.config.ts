import { defineConfig } from '@playwright/test';

/**
 * UAT harness against live CSA Loom (v3.18+).
 *
 * Driven by tests/uat/* specs. Each spec walks one slice of the console
 * (editor type, app install, nav page) and emits structured JSON to
 * test-results/uat/ describing what worked, what crashed, what's vaporware.
 *
 * Auth: tests mint a session cookie via SESSION_SECRET (from KV) — no
 * MSAL flow required, same trick the .mjs smokes use.
 *
 * Run:  SESSION_SECRET=<from-KV> pnpm exec playwright test --project=uat
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,           // serial — shared workspaces, ordered cleanup
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/uat/report.json' }]],
  outputDir: 'test-results/uat/artifacts',
  use: {
    baseURL: process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    extraHTTPHeaders: {},
    // Auth: prefer storageState from `pnpm uat` launcher; falls back to
    // SESSION_SECRET cookie-mint trick if running headless in CI.
    storageState: process.env.LOOM_STORAGE_STATE || undefined,
  },
  projects: [
    {
      name: 'uat',
      testDir: './e2e',
      testMatch: /.*\.uat\.ts/,
    },
    {
      // Per-family walkthroughs (tests/e2e/<slug>.spec.ts) — lighter than
      // the full UAT. Just renders each editor, checks h1 + no crash +
      // no console errors + a primary action button is clickable. Wired
      // for the Data Engineering family sweep (2026-05-27).
      name: 'family-walkthrough',
      testDir: './tests/e2e',
      testMatch: /.*\.spec\.ts/,
    },
  ],
});
