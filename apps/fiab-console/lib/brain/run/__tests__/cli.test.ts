/**
 * LOOM BRAIN W10 — THE COMPOSITION ROOT (#3936, G1/G2/S4 from the review).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * `cli.ts` was outside every test's population. Two mutation arms proved it:
 *
 *   cli-exit-from-verdict-only   replace the exit mapping in `main()` with the
 *                                narrow verdict-only one and a POPULATION
 *                                REGRESSION exits 0 while the workflow prints
 *                                "Scan completed." SURVIVED, RC 0.
 *   cli-entrypoint-never-fires   neuter the direct-invocation predicate and
 *                                `node cli.js` exits 0 having produced NOTHING —
 *                                no verdict, no output, no summary — while the
 *                                workflow reports success. SURVIVED, RC 0.
 *
 * The first is the SAME regression already fixed inside `scan.ts`, one layer up
 * and undefended. The second is green over literally nothing, which is the
 * precise failure #3936 exists to prevent.
 *
 * `main()` builds real Azure clients, so it was untestable by construction. The
 * fix was structural: `runAndReport(deps, io)` holds the reporting and the exit
 * mapping, `main()` holds only the wiring, and this file exercises the former
 * with in-memory ports.
 */

import { describe, expect, it } from 'vitest';
import { isDirectInvocation, resolveScanEstateId, runAndReport, type CliIo } from '../cli';
import { InMemoryFindingStore, InMemoryGraphHistoryWriter, StaticGraphSource } from '../ports';
import {
  AUTH_FAILURE,
  CLOUD,
  ESTATE,
  StubProbe,
  buildEdgelessGraph,
  buildFixtureGraph,
  pausedReadings,
  probeOf,
  runningReadings,
} from './fixtures';

const AT = new Date('2026-08-24T04:11:00.000Z');

interface Captured {
  readonly io: CliIo;
  readonly stdout: string[];
  readonly files: Map<string, string>;
}

function captureIo(env: NodeJS.ProcessEnv = {}): Captured {
  const stdout: string[] = [];
  const files = new Map<string, string>();
  return {
    stdout,
    files,
    io: {
      stdout: (t) => stdout.push(t),
      appendFile: (p, t) => files.set(p, (files.get(p) ?? '') + t),
      env,
    },
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    estateId: ESTATE,
    cloud: CLOUD,
    runId: 'run-1',
    probe: new StubProbe(probeOf(runningReadings())),
    graphSource: new StaticGraphSource(buildFixtureGraph(), ['configured', 'owns'], []),
    history: new InMemoryGraphHistoryWriter(),
    findings: new InMemoryFindingStore(),
    source: 'test:cli.test.ts',
    now: () => AT,
    ...overrides,
  } as Parameters<typeof runAndReport>[0];
}

describe('runAndReport — the exit mapping the PROCESS uses', () => {
  it('OK exits 0', async () => {
    const cap = captureIo();
    expect(await runAndReport(deps(), cap.io)).toBe(0);
  });

  it('PAUSED exits 0 — neutral, not green', async () => {
    const cap = captureIo();
    const code = await runAndReport(
      deps({ probe: new StubProbe(probeOf(pausedReadings())) }),
      cap.io,
    );
    expect(code).toBe(0);
    // …and the log makes it impossible to read that 0 as "scanned".
    expect(cap.stdout.join('')).toContain('VERDICT: PAUSED');
    expect(cap.stdout.join('')).toContain('NOTHING was scanned');
  });

  it('UNREACHABLE exits 2', async () => {
    const cap = captureIo();
    const code = await runAndReport(
      deps({ probe: new StubProbe(probeOf([], [AUTH_FAILURE])) }),
      cap.io,
    );
    expect(code).toBe(2);
  });

  it('POPULATION REGRESSION exits 3 — THE ARM THAT ESCAPED', async () => {
    // `cli-exit-from-verdict-only` replaced this mapping with the verdict-only
    // one, which returns 0 here. Nothing failed. This is the assertion that
    // makes that edit red.
    const store = new InMemoryFindingStore();
    const history = new InMemoryGraphHistoryWriter();
    const cap = captureIo();
    await runAndReport(deps({ findings: store, history }), cap.io);
    const code = await runAndReport(
      deps({
        findings: store,
        history,
        runId: 'run-2',
        graphSource: new StaticGraphSource(buildEdgelessGraph(), ['configured', 'owns'], []),
      }),
      cap.io,
    );
    expect(code).toBe(3);
  });
});

describe('runAndReport — the job outputs a green check cannot hide', () => {
  it('writes verdict and population_regression to GITHUB_OUTPUT', async () => {
    const cap = captureIo({ GITHUB_OUTPUT: '/out' });
    await runAndReport(deps(), cap.io);
    const out = cap.files.get('/out') ?? '';
    expect(out).toContain('verdict=ok');
    expect(out).toContain('population_regression=false');
    expect(out).toContain('findings_produced=');
    expect(out).toContain('detectors_blind=');
  });

  it('writes a step summary when GITHUB_STEP_SUMMARY is set', async () => {
    const cap = captureIo({ GITHUB_STEP_SUMMARY: '/sum' });
    await runAndReport(deps(), cap.io);
    expect(cap.files.get('/sum') ?? '').toContain('## Loom Brain scan —');
  });

  it('a PAUSED run still emits a NON-EMPTY verdict output', async () => {
    // The workflow fails when this is empty. If a paused run wrote nothing, that
    // assertion would fire on the estate's normal state and the lane would be
    // red every night — the failure this whole design avoids.
    const cap = captureIo({ GITHUB_OUTPUT: '/out' });
    await runAndReport(deps({ probe: new StubProbe(probeOf(pausedReadings())) }), cap.io);
    expect(cap.files.get('/out') ?? '').toContain('verdict=paused');
  });

  it('an UNREACHABLE run still emits a NON-EMPTY verdict output', async () => {
    const cap = captureIo({ GITHUB_OUTPUT: '/out' });
    await runAndReport(deps({ probe: new StubProbe(probeOf([], [AUTH_FAILURE])) }), cap.io);
    expect(cap.files.get('/out') ?? '').toContain('verdict=unreachable');
  });

  it('writes NOTHING to a file when the env vars are absent', async () => {
    const cap = captureIo();
    await runAndReport(deps(), cap.io);
    expect(cap.files.size).toBe(0);
  });

  it('the verdict headline is printed BEFORE the full report', async () => {
    // Measured on the first compiled smoke run: a Cosmos failure inside
    // `recordRun` produced a stack trace and NO verdict, because the report only
    // printed after persistence.
    const cap = captureIo();
    await runAndReport(deps(), cap.io);
    const joined = cap.stdout.join('');
    expect(joined.indexOf('VERDICT: OK')).toBeLessThan(joined.indexOf('CHANGED SINCE THE LAST RUN'));
  });
});

describe('isDirectInvocation — the entrypoint predicate', () => {
  it('fires for the compiled CLI path the workflow runs', () => {
    expect(isDirectInvocation('/x/temp/brain-scan-build/lib/brain/run/cli.js')).toBe(true);
    expect(isDirectInvocation('C:\\x\\temp\\brain-scan-build\\lib\\brain\\run\\cli.js')).toBe(true);
  });

  it('fires for the TypeScript source path', () => {
    expect(isDirectInvocation('/x/apps/fiab-console/lib/brain/run/cli.ts')).toBe(true);
  });

  it('does NOT fire when the module is merely imported', () => {
    expect(isDirectInvocation('/x/node_modules/vitest/vitest.mjs')).toBe(false);
    expect(isDirectInvocation(undefined)).toBe(false);
    expect(isDirectInvocation('')).toBe(false);
  });

  it('does NOT fire on a lookalike path', () => {
    expect(isDirectInvocation('/x/lib/brain/run/cli.js.map')).toBe(false);
    expect(isDirectInvocation('/x/lib/brain/runner/cli.js')).toBe(false);
  });
});

describe('resolveScanEstateId — S4', () => {
  it('prefers an explicit LOOM_ESTATE_ID', () => {
    expect(resolveScanEstateId({ LOOM_ESTATE_ID: 'explicit' })).toBe('explicit');
  });

  it('derives loom:<sub8>:<rg> from the deploy facts', () => {
    expect(
      resolveScanEstateId({ LOOM_SUBSCRIPTION_ID: 'abcdef0123456789', LOOM_ADMIN_RG: 'rg-x' }),
    ).toBe('loom:abcdef01:rg-x');
  });

  it('falls back through the RG variables in order', () => {
    expect(resolveScanEstateId({ LOOM_SUBSCRIPTION_ID: 'abcdef01', LOOM_ACA_RG: 'a' })).toBe(
      'loom:abcdef01:a',
    );
    expect(resolveScanEstateId({ LOOM_SUBSCRIPTION_ID: 'abcdef01', LOOM_DLZ_RG: 'd' })).toBe(
      'loom:abcdef01:d',
    );
  });

  it('returns loom:unbound when it cannot establish one — and main() REFUSES that', () => {
    expect(resolveScanEstateId({})).toBe('loom:unbound');
    expect(resolveScanEstateId({ LOOM_SUBSCRIPTION_ID: 'abcdef01' })).toBe('loom:unbound');
  });
});
