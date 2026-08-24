/**
 * LOOM BRAIN W10 — THE LOOP, end to end (#3936).
 *
 * #3936 acceptance, the first of the five:
 *   "The scheduled run produces a finding set and a graph version, and REPORTS
 *    COUNTS."
 *
 * These run `runBrainScan()` against the SAME estate graph the detectors are
 * proven on (`lib/brain/__tests__/detectors/fixtures.ts`) with the REAL detector
 * list, so the counts below are the shipped detectors' actual output over the
 * founding fixture — not a number a stub chose.
 *
 * ── THE THREE PATHS, AND WHAT EACH MUST NOT DO ─────────────────────────────
 *   OK           writes a version, reconciles, reports counts
 *   PAUSED       writes NOTHING and changes NO finding state
 *   UNREACHABLE  writes NOTHING, changes NO finding state, exits 2
 *
 * The PAUSED and UNREACHABLE assertions are the load-bearing ones. A scan that
 * reconciled against a run which examined nothing would mark the entire backlog
 * `fixed` and then re-report all of it as `new` after the next resume — the same
 * P-BLIND failure as a blind detector, one level up.
 */

import { describe, expect, it } from 'vitest';
import { ALL_DETECTORS } from '../../detectors';
import { exitCodeFor, exitCodeForOutcome, runBrainScan } from '../scan';
import { InMemoryFindingStore, InMemoryGraphHistoryWriter, StaticGraphSource } from '../ports';
import { renderCounts, renderRunReport } from '../report';
import type { FindingRecord } from '../model';
import {
  AUTH_FAILURE,
  CLOUD,
  ESTATE,
  StubProbe,
  blindDetector,
  buildEdgelessGraph,
  buildFixtureGraph,
  finding,
  pausedReadings,
  probeOf,
  record,
  runningReadings,
  stubDetector,
} from './fixtures';

const AT = new Date('2026-08-24T04:11:00.000Z');

function deps(overrides: Partial<Parameters<typeof runBrainScan>[0]> = {}) {
  const graph = buildFixtureGraph();
  return {
    estateId: ESTATE,
    cloud: CLOUD,
    runId: 'run-1',
    probe: new StubProbe(probeOf(runningReadings())),
    graphSource: new StaticGraphSource(graph, ['configured', 'declared', 'owns'], [
      'synthetic fixture graph',
    ]),
    history: new InMemoryGraphHistoryWriter(),
    findings: new InMemoryFindingStore(),
    source: 'test:scan.test.ts',
    now: () => AT,
    ...overrides,
  };
}

describe('runBrainScan — the OK path', () => {
  it('produces a finding set AND a graph version AND reports counts', async () => {
    const d = deps();
    const outcome = await runBrainScan(d);

    expect(outcome.verdict.kind).toBe('ok');
    expect(exitCodeFor(outcome.verdict)).toBe(0);

    // a graph version
    expect(outcome.graphVersion).not.toBeNull();
    expect(outcome.graphVersion?.status).toBe('created');
    expect(outcome.graphVersion?.nodes).toBeGreaterThan(0);
    expect((d.history as InMemoryGraphHistoryWriter).captures).toHaveLength(1);
    expect((d.history as InMemoryGraphHistoryWriter).captures[0].collectedProvenances).toContain(
      'configured',
    );

    // a finding set, from the REAL detectors over the founding fixture
    expect(outcome.detectorRun).not.toBeNull();
    expect(outcome.detectorRun?.results).toHaveLength(ALL_DETECTORS.length);
    expect(outcome.counts?.findingsProduced).toBeGreaterThan(0);

    // and counts
    const c = outcome.counts;
    expect(c).not.toBeNull();
    if (!c) throw new Error('unreachable');
    expect(c.nodes).toBe(outcome.graphVersion?.nodes);
    expect(c.detectorsRun).toBe(ALL_DETECTORS.length);
    expect(c.new).toBe(c.findingsProduced);
    expect(c.regressions).toBe(0);
    expect(c.recordsTotal).toBe(c.findingsProduced);

    // the counts are RENDERED, not merely computed
    const text = renderCounts(outcome);
    expect(text).toContain('findings produced');
    expect(text).toContain('REGRESSIONS');
    expect(renderRunReport(outcome)).toContain('VERDICT: OK');
  });

  it('the ACCEPTANCE TEST: the run finds loom-capacity-broker unreachable and always-on', async () => {
    // PRP §5: the founding measured example. If the loop runs the detectors at
    // all, this finding is in its output; if it silently ran zero detectors, it
    // is not. A count alone cannot tell those apart.
    const outcome = await runBrainScan(deps());
    const titles = (outcome.detectorRun?.findings ?? []).map((f) => f.id);
    expect(titles.some((t) => t.startsWith('unreachable-service#'))).toBe(true);
    expect(titles.some((t) => t.includes('loom-capacity-broker'))).toBe(true);
  });

  it('persists the reconciled records AND a run record', async () => {
    const d = deps();
    const outcome = await runBrainScan(d);
    const store = d.findings as InMemoryFindingStore;
    const stored = await store.list(ESTATE);
    expect(stored.length).toBe(outcome.counts?.recordsTotal);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].verdict).toBe('ok');
    expect(store.runs[0].graphVersionId).toBe(outcome.graphVersion?.versionId);
    expect(store.runs[0].counts).not.toBeNull();
    // Run records expire; FINDING records must not — a fixed finding that
    // expired would make its next occurrence read as `new`.
    expect(store.runs[0].ttl).toBeGreaterThan(0);
    expect(stored.every((r) => !('ttl' in r))).toBe(true);
  });

  it('a second run over an unchanged estate reports ZERO new findings', async () => {
    const store = new InMemoryFindingStore();
    const history = new InMemoryGraphHistoryWriter();
    const first = await runBrainScan(deps({ findings: store, history }));
    const second = await runBrainScan(
      deps({ findings: store, history, runId: 'run-2' }),
    );
    expect(first.counts?.new).toBeGreaterThan(0);
    expect(second.counts?.new).toBe(0);
    expect(second.counts?.regressions).toBe(0);
    expect(second.counts?.fixed).toBe(0);
    expect(second.counts?.stillOpen).toBe(first.counts?.new);
  });
});

describe('runBrainScan — the PAUSED path', () => {
  it('returns PAUSED with the observed states, exits 0, and writes NOTHING', async () => {
    const store = new InMemoryFindingStore();
    const history = new InMemoryGraphHistoryWriter();
    const seeded: FindingRecord[] = [
      record({ detector: 'unreachable-service', subject: '/broker', state: 'new' }),
    ];
    await store.put(seeded);

    const outcome = await runBrainScan(
      deps({ probe: new StubProbe(probeOf(pausedReadings())), findings: store, history }),
    );

    expect(outcome.verdict.kind).toBe('paused');
    expect(exitCodeFor(outcome.verdict)).toBe(0);
    expect(outcome.digest).toBeNull();
    expect(outcome.counts).toBeNull();
    expect(outcome.graphVersion).toBeNull();

    // no version written
    expect(history.captures).toHaveLength(0);
    // NO finding state changed — the seeded record is untouched
    const after = await store.list(ESTATE);
    expect(after).toHaveLength(1);
    expect(after[0].state).toBe('new');
    // but the run IS recorded, so a lane that only ever sees a paused estate is
    // visible rather than silent
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].verdict).toBe('paused');
    expect(store.runs[0].observed).toHaveLength(3);
    expect(store.runs[0].graphVersionId).toBeNull();
  });

  it('the report names each observed resource state with its ARM api-version', async () => {
    const outcome = await runBrainScan(deps({ probe: new StubProbe(probeOf(pausedReadings())) }));
    const text = renderRunReport(outcome);
    expect(text).toContain('VERDICT: PAUSED');
    expect(text).toContain('OBSERVED RESOURCE STATES');
    expect(text).toContain('Stopped');
    expect(text).toContain('Deallocated');
    expect(text).toContain('NOTHING was scanned');
  });

  it('does NOT build the graph on the paused path', async () => {
    let built = 0;
    const graphSource = {
      build: async () => {
        built += 1;
        return {
          graph: buildFixtureGraph(),
          collectedProvenances: ['configured' as const],
          notes: [],
        };
      },
    };
    await runBrainScan(deps({ probe: new StubProbe(probeOf(pausedReadings())), graphSource }));
    expect(built).toBe(0);
  });
});

describe('runBrainScan — the UNREACHABLE path', () => {
  it('exits 2, writes NOTHING, and says "could not reach"', async () => {
    const store = new InMemoryFindingStore();
    const history = new InMemoryGraphHistoryWriter();
    await store.put([
      record({ detector: 'unreachable-service', subject: '/broker', state: 'new' }),
    ]);

    const outcome = await runBrainScan(
      deps({ probe: new StubProbe(probeOf([], [AUTH_FAILURE])), findings: store, history }),
    );

    expect(outcome.verdict.kind).toBe('unreachable');
    // BOTH mappings are asserted. Asserting only the narrow `exitCodeFor` left
    // the real gate untested: the mutation `unreachable-exits-zero` (breaking
    // `exitCodeForOutcome`) SURVIVED the suite on 2026-08-24, which would have
    // shipped a lane where a red run passes the workflow. That is the worst
    // possible regression here and it is now covered.
    expect(exitCodeForOutcome(outcome)).toBe(2);
    expect(exitCodeFor(outcome.verdict)).toBe(2);
    expect(outcome.verdict.message).toContain('could not reach');
    expect(history.captures).toHaveLength(0);
    const after = await store.list(ESTATE);
    expect(after[0].state).toBe('new');
    expect(store.runs[0].verdict).toBe('unreachable');
    expect(store.runs[0].counts).toBeNull();
  });

  it('a REACHED-but-empty estate also exits 2 through exitCodeForOutcome', async () => {
    const outcome = await runBrainScan(
      deps({
        probe: new StubProbe({ readings: [], failures: [], discovered: 0, scope: 'nothing' }),
      }),
    );
    expect(outcome.verdict.kind).toBe('unreachable');
    expect(exitCodeForOutcome(outcome)).toBe(2);
  });

  it('the PAUSED path exits 0 through exitCodeForOutcome, not merely through the verdict', async () => {
    const outcome = await runBrainScan(deps({ probe: new StubProbe(probeOf(pausedReadings())) }));
    expect(exitCodeForOutcome(outcome)).toBe(0);
  });
});

describe('runBrainScan — blind detectors', () => {
  it('a blind detector is counted, reported, and cannot close its backlog', async () => {
    const store = new InMemoryFindingStore();
    await store.put([
      record({ detector: 'stub-a', subject: '/x', state: 'new' }),
    ]);
    const outcome = await runBrainScan(
      deps({
        findings: store,
        detectors: [blindDetector('stub-a'), stubDetector('stub-b', [
          finding({ detector: 'stub-b', subject: '/y' }),
        ])],
      }),
    );
    expect(outcome.counts?.detectorsRun).toBe(2);
    expect(outcome.counts?.detectorsBlind).toBe(1);
    expect(outcome.counts?.fixed).toBe(0);
    expect(outcome.counts?.notEvaluated).toBe(1);
    expect(outcome.digest?.evaluatedDetectors).toEqual(['stub-b']);
  });

  it('MUTATION SUBJECT: with the detector NON-blind, the same backlog IS closed', async () => {
    // The control for the assertion above. Without it, deleting the
    // `population.blind` check would not move a single assertion — the backlog
    // would stay open for the wrong reason and every test would still pass.
    const store = new InMemoryFindingStore();
    await store.put([record({ detector: 'stub-a', subject: '/x', state: 'new' })]);
    const outcome = await runBrainScan(
      deps({ findings: store, detectors: [stubDetector('stub-a', [])] }),
    );
    expect(outcome.counts?.detectorsBlind).toBe(0);
    expect(outcome.counts?.fixed).toBe(1);
    expect(outcome.counts?.notEvaluated).toBe(0);
  });
});

describe('runBrainScan — a throwing detector is NOT swallowed', () => {
  it('propagates rather than reporting a short, confident finding list', async () => {
    const boom = () => {
      throw new Error('detector defect');
    };
    await expect(runBrainScan(deps({ detectors: [boom] }))).rejects.toThrow('detector defect');
  });
});

describe('runBrainScan — THE MUTATION ACCEPTANCE (#3936)', () => {
  it('breaking a detector INPUT changes the run, and the run does NOT report clean', async () => {
    // Run 1: the real detectors over the real fixture estate — a working scan.
    const store = new InMemoryFindingStore();
    const history = new InMemoryGraphHistoryWriter();
    const healthy = await runBrainScan(deps({ findings: store, history }));
    expect(healthy.counts?.findingsProduced).toBeGreaterThan(0);
    expect(healthy.populationRegression).toBeNull();
    expect(exitCodeForOutcome(healthy)).toBe(0);

    // Run 2: the SAME detectors over a graph whose edges are gone. This is the
    // measured live mutation (emptying the wire-binding table) reproduced in a
    // fixture: 18 edges -> 0, 8 findings -> 0.
    const broken = await runBrainScan(
      deps({
        findings: store,
        history,
        runId: 'run-2',
        graphSource: new StaticGraphSource(buildEdgelessGraph(), ['configured', 'owns'], [
          'MUTATION: the graph carries no configured edges',
        ]),
      }),
    );

    // The counts collapse …
    expect(broken.counts?.findingsProduced).toBe(0);
    // … AND the run is red on the population axis rather than reporting clean.
    expect(broken.populationRegression).not.toBeNull();
    expect(exitCodeForOutcome(broken)).toBe(3);
    expect(broken.populationRegression?.message).toContain('POPULATION REGRESSION');

    // The report says so where the operator reads it.
    const text = renderRunReport(broken);
    expect(text).toContain('POPULATION REGRESSION — THE SCAN GOT WORSE');

    // And the collapsed run must NOT have wholesale-closed the healthy run's
    // backlog. The detectors that went BLIND cannot close anything at all
    // (P-BLIND), so those records survive under `notEvaluated`; only a detector
    // that genuinely still ran over a non-empty population may close its own.
    expect(broken.counts?.notEvaluated).toBeGreaterThan(0);
    expect(broken.counts?.fixed).toBeLessThan(healthy.counts?.findingsProduced ?? 0);
  });

  it('CONTROL: an unchanged second run over the SAME estate is not a regression', async () => {
    // Without this, a comparator that flagged every run would pass the test
    // above and the exit-3 assertion would prove nothing.
    const store = new InMemoryFindingStore();
    const history = new InMemoryGraphHistoryWriter();
    await runBrainScan(deps({ findings: store, history }));
    const second = await runBrainScan(deps({ findings: store, history, runId: 'run-2' }));
    expect(second.populationRegression).toBeNull();
    expect(exitCodeForOutcome(second)).toBe(0);
  });

  it('the FIRST run reports NO BASIS rather than "no regression"', async () => {
    const first = await runBrainScan(deps());
    expect(first.populationRegression).toBeNull();
    expect(first.notes.join('\n')).toContain('population comparison: NO BASIS');
  });

  it('exitCodeFor CANNOT see a population regression — exitCodeForOutcome must be used', async () => {
    // Recorded as an executable warning rather than a comment: the narrow helper
    // stays exported for verdict-only callers, and this asserts exactly how far
    // it can be trusted.
    const store = new InMemoryFindingStore();
    const history = new InMemoryGraphHistoryWriter();
    await runBrainScan(deps({ findings: store, history }));
    const broken = await runBrainScan(
      deps({
        findings: store,
        history,
        runId: 'run-2',
        graphSource: new StaticGraphSource(buildEdgelessGraph(), ['configured', 'owns'], []),
      }),
    );
    expect(exitCodeFor(broken.verdict)).toBe(0);
    expect(exitCodeForOutcome(broken)).toBe(3);
  });
});
