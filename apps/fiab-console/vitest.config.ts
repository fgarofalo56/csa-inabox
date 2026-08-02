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
        // ROOT CAUSE of the vitest-3 upgrade blocker (#2671 / PR #2785).
        //
        // vitest 3 FAILS a run on an unhandled error that vitest 2 tolerated.
        // On this suite the unhandled error was always:
        //     Error: [vitest-worker]: Timeout calling "onTaskUpdate"
        // — the worker->main RPC missing its deadline while REPORTING results.
        // Every one of the 1302 files and 13320 tests passed; only the
        // reporting channel timed out.
        //
        // It is a main-thread contention problem, not a bad spec. Left
        // uncapped, vitest spawns one fork per core — ~31 on a 32-core box —
        // and their combined task-update traffic outruns the single main
        // thread that must answer every call. Capping the forks fixes it:
        //   uncapped  -> 1 unhandled error, every run (Windows AND Linux CI)
        //   maxForks 4 -> clean, twice in a row
        //
        // Three other explanations were tested and disproved first, recorded
        // here so nobody re-walks them: a specific spec leaking hanging
        // promises (agents-route.test.ts is clean alone, 14/14), the teardown
        // budget (raising teardownTimeout changed nothing), and worker console
        // volume saturating the same channel (--silent changed nothing).
        //
        // COST, stated plainly: ~253s -> ~716s locally on 32 cores. CI runners
        // have far fewer cores, so the cap binds much less there. That is a
        // real price for a suite that reports honestly rather than one that
        // needs dangerouslyIgnoreUnhandledErrors to look green.
        // A CEILING, never a floor. `maxForks: 4` as a flat number was WRONG:
        // vitest's own default is roughly (cores - 1), so on a 4-core CI runner
        // a literal 4 RAISED parallelism from 3 to 4 and starved a CPU-heavy
        // guard spec into `Test timed out in 30000ms` x3 — a failure my 32-core
        // box could never reproduce, because there the same literal was a large
        // reduction. Same config, opposite effect, decided by core count.
        //
        // min(cap, cores - 1) caps the big machines where the RPC saturates and
        // never RAISES parallelism on a small one.
        //
        // THE CAP IS 2 UNDER CI (2026-08-01, #2671). The main thread is single
        // and serves BOTH every worker's vite transform AND every worker's
        // `onTaskUpdate` reporting RPC — and that RPC has a 60s deadline
        // hardcoded in vitest's bundled birpc (see the coverage note below).
        // With 3 forks on a 4-core runner a task update could sit behind their
        // transform queue for over a minute, which is the unhandled error that
        // has blocked this upgrade all along.
        //
        // Two pieces of evidence that it is CONTENTION and not a deterministic
        // end-of-run flush: (a) both shards do IDENTICAL end-of-run coverage
        // work and only ONE of the two tripped; (b) sharding never fixed it,
        // which follows, because each shard still imports nearly the whole
        // console dependency graph — so sharding barely reduces main-thread
        // transform work. Only lowering the concurrent demand on it does.
        //
        // COST, stated plainly: fewer forks means a longer wall clock. That is
        // the trade. A slower run that reports honestly beats a fast one that
        // needs dangerouslyIgnoreUnhandledErrors to look green.
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
    // 1. WHAT DOES NOT WORK, recorded so nobody re-runs it. vitest 3 fails a
    //    run on unhandled errors that vitest 2 tolerated, and this suite
    //    produces `[vitest-worker]: Timeout calling "onTaskUpdate"` — the
    //    worker->main reporting RPC missing its deadline while every test
    //    passes. Switching to istanbul makes that error disappear on a 32-core
    //    box (full suite: exit 0, 1302 files, 0 unhandled errors) and it STILL
    //    HAPPENS on a 4-core CI runner. Same error, same shape as v8.
    //
    //    The provider was never the root cause. The deadline is birpc's
    //    DEFAULT_TIMEOUT — 60s, hardcoded in vitest's bundled copy, passed no
    //    override by `createForksRpcOptions`, and reachable from neither the
    //    config types nor any VITEST_* env var. So a worker waited over a
    //    MINUTE for the main thread. Both providers add main-thread work
    //    (istanbul's Babel pass runs inside the vite transform the main thread
    //    serves), which is why istanbul is if anything worse for it: CI per-blob
    //    went 534s/562s under v8 to 729s/752s under istanbul. On 32 cores with
    //    maxForks 4 the main thread has headroom and never trips the deadline;
    //    on 4 cores with 3 forks it does. THAT is the local-vs-CI divergence
    //    that has misled this investigation repeatedly — do not conclude
    //    anything about this error from a local run alone.
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
