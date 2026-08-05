import { cpus } from 'node:os';
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
    poolOptions: {
      forks: {
        // ── `[vitest-worker]: Timeout calling "onTaskUpdate"` — SOLVED (#2944)
        //
        // READ THIS BEFORE FORMING A THEORY. The explanation that lived here
        // until 2026-08-04 — "main-thread contention: too many forks outrun the
        // single main thread that must answer every RPC" — is WRONG, and it sent
        // four rounds of investigation at the wrong variable. What is true:
        //
        //   THE WORKER BLOCKS ITS OWN EVENT LOOP. vitest reports results with a
        //   birpc CALL, `onTaskUpdate`, whose reply arrives as an IPC message —
        //   readable only in the event loop's POLL phase. vitest chains tests in
        //   one promise chain, so between two SYNCHRONOUS test bodies the loop
        //   drains microtasks and goes straight into the next test; it never
        //   reaches poll. The reply therefore sits unread in the pipe for as long
        //   as the file keeps doing synchronous CPU, and birpc's DEFAULT_TIMEOUT
        //   (60s, hardcoded in vitest's bundled copy — `createForksRpcOptions`
        //   passes no override, and it is reachable from neither the config types
        //   nor any VITEST_* env var) rejects the call. Every test still PASSES;
        //   only the reporting channel dies, so the run fails carrying no
        //   information about the code under test.
        //
        // MEASURED, controlled, `maxForks: 1`, main thread otherwise idle:
        //     20 x 2.5s SYNC  (  50s total)  -> clean
        //     40 x 2.5s SYNC  ( 100s total)  -> Timeout calling "onTaskUpdate"
        //     40 x 2.5s ASYNC ( 101s total)  -> clean
        //      1 x  70s SYNC  (  70s total)  -> Timeout calling "onTaskUpdate"
        // So the metric is CUMULATIVE SYNCHRONOUS CPU PER FILE crossing 60s. It
        // is NOT wall clock (the async file ran 101s clean), NOT fork count (this
        // reproduces at ONE fork), and NOT the coverage provider.
        //
        // That is why every earlier remedy failed, and each failure is now
        // explained rather than merely recorded: a leaking spec (there was none),
        // teardownTimeout (irrelevant — the deadline is on a reporting call),
        // `--silent` (irrelevant), v8 -> istanbul (a coverage provider does not
        // change a spec's own sync CPU), SHARDING (a shard still runs the
        // offending FILE whole), and lowering maxForks (same).
        //
        // THE ACTUAL CULPRIT, and the fix: `lib/azure/__tests__/
        // unity-audit-guard.test.ts` ran 31 whole-tree scans of ~5,345 files as
        // straight-line synchronous CPU — 108,699ms on CI, the ONLY file over 60s
        // out of 1,354 and 4.6x the next slowest. #2944 made the guard's two
        // whole-tree loops short-circuit before masking, taking the file to
        // ~12s. Nothing was removed from what it asserts.
        //
        // KEEP FILES OFF THE CLIFF. If you add a spec that does heavy synchronous
        // work, the budget is that file's own sync CPU, not the suite's. Check it
        // with `vitest run <file>` and keep it well under 60s.
        //
        // WHY THE CAP IS STILL HERE. It is NO LONGER justified by the RPC
        // deadline — that justification is void. It stays for MEMORY, which is
        // independently evidenced: a GitHub runner has ~16 GB, and at higher fork
        // counts a fork was OOM-killed, closing its IPC channel
        // (`ERR_IPC_CHANNEL_CLOSED`) with NO blob written for that shard. Raising
        // it is now a legitimate experiment (it may buy back wall clock), but it
        // needs its own memory evidence, so it is not being churned here.
        //
        // A CEILING, never a floor. `maxForks: 4` as a flat number was WRONG:
        // vitest's own default is roughly (cores - 1), so on a 4-core CI runner
        // a literal 4 RAISED parallelism from 3 to 4 and starved a CPU-heavy
        // guard spec into `Test timed out in 30000ms` x3 — a failure a 32-core
        // box could never reproduce, because there the same literal was a large
        // reduction. Same config, opposite effect, decided by core count.
        // min(cap, cores - 1) never RAISES parallelism on a small machine.
        maxForks: Math.max(1, Math.min(process.env.CI ? 2 : 4, (cpus().length || 2) - 1)),
      },
    },
    // The first `await import('../route')` in a heavy BFF spec triggers an
    // on-demand TS transform of the route AND its whole dependency graph. Under
    // full-suite parallel forks that cold transform can exceed the default 5s
    // per-test budget (the tests themselves are fast — they pass in isolation),
    // producing flaky "Test timed out in 5000ms" failures on otherwise-passing
    // specs. Give tests + hooks a generous ceiling so a slow cold transform is
    // never mistaken for a hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // CI-only retry: jsdom component tests (Fluent Dialog portals,
    // Tabster focus management) exhibit rotating timing flakes on slow CI
    // runners — worse under coverage instrumentation — that never reproduce
    // locally even under --sequence.shuffle. A deterministic failure still
    // fails (it fails every retry too); only genuine timing races recover.
    // Bumped 1→2 (2026-07-06): the geo-dataset / kql-dashboard portal-dialog
    // pair periodically failed BOTH the run and its single retry under
    // coverage-slowed CI, reddening main after otherwise-green merges; a
    // second retry clears the timing race without masking real regressions
    // (those fail all three attempts). Local runs keep retry 0 so flakes
    // stay visible to developers.
    retry: process.env.CI ? 2 : 0,
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
    // istanbul provider (Babel instrumentation). `all: true` counts EVERY
    // source file under include — not just the ones a test imported — so the
    // denominator is the whole console surface and the floor can only be
    // ratcheted UP by adding tests, never gamed by narrowing what's measured.
    //
    // RATCHET CONVENTION: the thresholds below are the FLOOR, set a couple of
    // points BELOW the last measured reality. When you add tests and coverage
    // climbs, RAISE the floor to (new measured − ~2pts) in the same PR. Never
    // lower it. `pnpm vitest run --coverage` enforces it (fails under the floor).
    //
    // ── WHY istanbul AND NOT v8 (#2671 / PR #2785, 2026-08-01) ────────────
    //
    // THE REASON IS MEASUREMENT QUALITY. It is NOT that istanbul fixes the
    // vitest-3 blocker — it does not, and that was checked the hard way.
    //
    // 1. WHAT DOES NOT WORK, recorded so nobody re-runs it. Switching provider
    //    does not change `[vitest-worker]: Timeout calling "onTaskUpdate"`,
    //    under EITHER provider, and #2944 explains why: that error is a spec
    //    file blocking its own worker's event loop past birpc's 60s reply
    //    deadline, so it is a function of the SPEC's synchronous CPU, which a
    //    coverage provider does not change. (The 2026-08-01 note here reasoned
    //    instead about which provider adds more main-thread work — a real
    //    difference, but not the one that decides this error. See the
    //    poolOptions block above for the measured mechanism.) What the provider
    //    DOES change is wall clock: CI per-blob went 534s/562s under v8 to
    //    729s/752s under istanbul.
    //
    // 2. THE ACTUAL REASON TO BE HERE: THE BRANCH FLOOR FELL 58 -> 21 IN THIS
    //    SWITCH, AND THAT IS THE GATE GETTING STRICTER, NOT WEAKER. Do not
    //    "fix" it back. v8 cannot see branch structure in a file it never
    //    executed: its coverage is derived from the runtime, so an untested
    //    file is reported as one opaque uncovered range. Measured over the
    //    IDENTICAL include/exclude surface with ONE test file executed
    //    (3,882 files), provider as the only variable:
    //        provider   branches seen      functions seen
    //        v8              3,899              3,885     (~1 per file)
    //        istanbul      290,495             64,485     (74.5x / 16.6x)
    //    Per file, `lib/assets/asset-signals.ts` (imported by no test) is
    //    0/1 branches under v8 and 0/36 under istanbul. So v8's 64.57% branch
    //    figure was a percentage of the executed files ONLY — the untested
    //    console contributed ~1 branch each and could never drag it down.
    //    istanbul's 23.08% is a percentage of the real branch count of the
    //    whole surface. Same code, ~74x the denominator.
    //
    //    They do NOT disagree about what ran. On lib/activation/destinations.ts
    //    both mark the same lines unexecuted; istanbul additionally counts
    //    branch arms v8 has no entry for at all — default args
    //    (`deps: DestinationDeps = {}`), the `??` fallback arrow on line 88,
    //    and the same-line `if (rows.length === 0) return …` consequent that v8
    //    folds into a covered line. v8 also emits an always-covered
    //    pseudo-branch per function, which pads its numerator with free 100%s.
    //
    //    Net effect on the ratchet: under v8, adding a whole new UNTESTED file
    //    moved the branch metric by ~1 branch. Under istanbul it adds that
    //    file's full branch count to the denominator. The lower number is the
    //    honest one and is harder to game.
    coverage: {
      provider: 'istanbul',
      all: true,
      reporter: ['text-summary', 'json-summary', 'text'],
      reportsDirectory: './coverage',
      include: ['lib/**', 'app/**'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.{ts,tsx}',
        // .d.mts / .d.cts too — `**/*.d.ts` alone missed them, so
        // lib/lsp/pylsp-bridge.d.mts sat in the coverage DENOMINATOR despite
        // having no executable lines, diluting the very signal the note above
        // says this list protects. It also breaks a Babel-instrumenting
        // provider outright: istanbul tries to transform it and dies with
        // `The constant "__test" must be initialized`.
        '**/*.d.{ts,mts,cts}',
        // Type-only / declaration barrels and generated assets carry no
        // executable lines — counting them just dilutes the signal.
        'lib/**/*.types.ts',
        'app/**/layout.tsx',
        'app/**/loading.tsx',
        'app/**/not-found.tsx',
        // apex A2: route boundary wrappers are 3-line delegations to the shared
        // (and tested) lib/components/route-error.tsx / route-loading.tsx;
        // global-error.tsx replaces <html> and is exercised only in a browser.
        'app/**/error.tsx',
        'app/global-error.tsx',
      ],
      // FLOOR — the gap to 100% is mostly client `app/**/page.tsx` components,
      // which the vitest slice does not render (routes/editors/lib ARE
      // covered); those are exercised by the Playwright UAT slice (rel-T30).
      //
      // HISTORY, and why the numbers below are NOT a lowering of the ratchet:
      //   2026-07-03  v8  measured 32.52 / 56.85 / 30.86 / 32.52 -> floor 30/54/28/30
      //   2026-07-22  v8  measured 34.16 / 61.57 / 37.57 / 34.16 -> floor 32/58/34/32
      //   2026-08-01  PROVIDER CHANGED v8 -> istanbul. The two providers do not
      //               share a denominator (see the note above: 3,899 vs 290,495
      //               branches over the same files), so the v8 floors are not
      //               comparable and could not simply be carried over. Measured
      //               reality under istanbul on the full 1302-file run:
      //                 statements 29.86 · branches 23.08 · functions 24.20 · lines 32.49
      //               Floors re-baselined ~2pts below each, per the convention
      //               above. RATCHET UP FROM HERE — the next reader should
      //               compare against these istanbul numbers, never against the
      //               v8 ones.
      thresholds: {
        statements: 27,
        branches: 21,
        functions: 22,
        lines: 30,
      },
    },
  },
});
