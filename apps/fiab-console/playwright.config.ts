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
 *
 * Unattended verify project (no MFA, no user creds):
 *   SESSION_SECRET=<from-KV> LOOM_URL=<url> pnpm exec playwright test --project=verify
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
    baseURL: process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // 30s, not 15s: actionTimeout also caps page.request.* API calls, and the
    // live console under a serial 29-app install sweep routinely takes >15s to
    // answer POST /api/workspaces or accept an Install click while a previous
    // app's provisioning is still running. 15s produced a 16-test false-fail
    // band on run loom-uat-a0cz4b8 (2026-07-09) with realFails=0.
    actionTimeout: 30_000,
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

    // ------------------------------------------------------------------
    // Unattended verify harness — mints a session from SESSION_SECRET;
    // no MSAL flow, no MFA, no user credentials required.
    //
    // Run:  SESSION_SECRET=<kv> LOOM_URL=<url> pnpm exec playwright test --project=verify
    // CI:   .github/workflows/loom-ui-verify.yml (fetches secret via OIDC + az kv)
    // ------------------------------------------------------------------
    {
      // Setup project: mints the storageState and writes e2e/.auth/loom-state.json.
      // Playwright auth-setup pattern (1.48+): a regular test file depended on by
      // the verify project — no browser required, just Node crypto + fs.
      name: 'mint',
      testDir: './e2e/auth',
      testMatch: /global-setup\.ts/,
    },
    {
      // Verify project: smoke-tests admin health page + API endpoints
      name: 'verify',
      testDir: './e2e',
      testMatch: /admin-verify\.spec\.ts/,
      dependencies: ['mint'],
      use: {
        storageState: 'e2e/.auth/loom-state.json',
        baseURL: process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
      },
    },
    {
      // Publish-version project (task #7): live front-end version-history +
      // restore across publishing object types, driven with the SAME minted
      // session as `verify`. Kept as its own project so its heavier per-type
      // create/save flow does not widen the core `verify` smoke gate.
      // Run: pnpm exec playwright test --project=publish-version
      name: 'publish-version',
      testDir: './e2e',
      testMatch: /publish-version\.spec\.ts/,
      dependencies: ['mint'],
      use: {
        storageState: 'e2e/.auth/loom-state.json',
        baseURL: process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
      },
    },

    // ------------------------------------------------------------------
    // loom-next-level test-projects batch (Phase 1, round-3 F2): ALL
    // planned Playwright projects are stubbed here in ONE PR so the items
    // that fill them in (V1/V2/V4/A5/A13/L5/U0/U6) only add spec files and
    // never touch this config — killing the playwright.config.ts
    // serialization chain. A project whose testMatch has no files yet is
    // inert unless explicitly selected with --project.
    // All reuse the minted-session auth (mint dependency + storageState).
    // ------------------------------------------------------------------
    {
      // V1 — six synthetic user journeys (incl. the TRUE MSAL login probe).
      // Scheduled in-VNet via the loom-synthetic-monitor Container Apps job.
      name: 'journey',
      testDir: './e2e',
      testMatch: /synthetic-journeys\.uat\.ts/,
      dependencies: ['mint'],
      use: {
        storageState: 'e2e/.auth/loom-state.json',
        baseURL: process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
      },
    },
    {
      // V2 — visual regression, wide viewport (light+dark handled in-spec).
      name: 'visual-wide',
      testDir: './e2e',
      testMatch: /visual-regression\.spec\.ts/,
      dependencies: ['mint'],
      use: {
        storageState: 'e2e/.auth/loom-state.json',
        viewport: { width: 1600, height: 1200 },
        baseURL: process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
      },
    },
    {
      // V2 — visual regression, narrow viewport (badge-wrap / overflow gate).
      name: 'visual-narrow',
      testDir: './e2e',
      testMatch: /visual-regression\.spec\.ts/,
      dependencies: ['mint'],
      use: {
        storageState: 'e2e/.auth/loom-state.json',
        viewport: { width: 900, height: 1200 },
        baseURL: process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
      },
    },
    {
      // V4 — page.tsx route-smoke coverage ratchet.
      name: 'route-smoke',
      testDir: './e2e',
      testMatch: /route-smoke\.spec\.ts/,
      dependencies: ['mint'],
      use: {
        storageState: 'e2e/.auth/loom-state.json',
        baseURL: process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
      },
    },
    {
      // U0 — automated grip drag+reload receipts. NOTE for the spec author:
      // pace mouse moves across frames (slow mouse.move steps) — CDP-fast
      // drags outrun both drag state machines (SplitPane React-state
      // `dragging`; resizable-canvas rAF-batched commit) and false-fail
      // (proven live 2026-07-22, see DONE ledger U0 row).
      name: 'u0-grip',
      testDir: './e2e',
      testMatch: /u0-grip-verify\.spec\.ts/,
      dependencies: ['mint'],
      use: {
        storageState: 'e2e/.auth/loom-state.json',
        baseURL: process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
      },
    },
    {
      // U6 — Monaco query↔results divider receipts across the 11 editors.
      name: 'monaco-divider',
      testDir: './e2e',
      testMatch: /u6-monaco-divider\.spec\.ts/,
      dependencies: ['mint'],
      use: {
        storageState: 'e2e/.auth/loom-state.json',
        baseURL: process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
      },
    },
    {
      // A5 — DAX golden numeric harness vs the seeded reference models.
      name: 'dax-golden',
      testDir: './e2e',
      testMatch: /dax-golden\.spec\.ts/,
      dependencies: ['mint'],
      use: {
        storageState: 'e2e/.auth/loom-state.json',
        baseURL: process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
      },
    },
    {
      // A13 — Spark reliability chaos drill (kill sessions / FAULTED pool).
      name: 'spark-chaos',
      testDir: './e2e',
      testMatch: /a13-spark-chaos\.spec\.ts/,
      dependencies: ['mint'],
      use: {
        storageState: 'e2e/.auth/loom-state.json',
        baseURL: process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
      },
    },
    {
      // L5 — column fan-out canvas + impact analysis receipts.
      name: 'lineage-columns',
      testDir: './e2e',
      testMatch: /l5-column-canvas\.spec\.ts/,
      dependencies: ['mint'],
      use: {
        storageState: 'e2e/.auth/loom-state.json',
        baseURL: process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net',
      },
    },
  ],
});
