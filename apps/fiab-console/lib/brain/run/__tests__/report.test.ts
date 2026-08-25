/**
 * LOOM BRAIN W10 — the report renderer (#3936).
 *
 * The digest is a report of what CHANGED. These assert the two properties that
 * make it usable rather than noisy:
 *
 *   1. REGRESSIONS ARE FIRST, always, even at zero. Burying a recurrence under a
 *      longer list of new findings is the same defect as reporting it as `new`,
 *      moved to the presentation layer.
 *   2. THE BACKLOG IS NOT RE-LISTED. `stillOpen` and `suppressed` appear as
 *      counts; their individual titles must not.
 */

import { describe, expect, it } from 'vitest';
import { renderCounts, renderRunReport, renderStepSummary } from '../report';
import { runBrainScan } from '../scan';
import { InMemoryFindingStore, InMemoryGraphHistoryWriter, StaticGraphSource } from '../ports';
import {
  AUTH_FAILURE,
  CLOUD,
  ESTATE,
  StubProbe,
  blindDetector,
  buildFixtureGraph,
  finding,
  pausedReadings,
  probeOf,
  record,
  runningReadings,
  stubDetector,
} from './fixtures';

const AT = new Date('2026-08-24T04:11:00.000Z');

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    estateId: ESTATE,
    cloud: CLOUD,
    runId: 'run-1',
    probe: new StubProbe(probeOf(runningReadings())),
    graphSource: new StaticGraphSource(buildFixtureGraph(), ['configured', 'owns'], []),
    history: new InMemoryGraphHistoryWriter(),
    findings: new InMemoryFindingStore(),
    source: 'test:report.test.ts',
    now: () => AT,
    ...overrides,
  } as Parameters<typeof runBrainScan>[0];
}

/** A run in which one finding regresses and one has been open for a while. */
async function runWithARegression() {
  const store = new InMemoryFindingStore();
  await store.put([
    record({
      detector: 'stub',
      subject: '/regressor',
      state: 'fixed',
      fixedAt: '2026-08-01T00:00:00.000Z',
      fixedByRunId: 'run-0',
    }),
    record({
      detector: 'stub',
      subject: '/long-standing',
      state: 'acknowledged',
      runId: 'run-0',
    }),
  ]);
  return runBrainScan(
    baseDeps({
      findings: store,
      detectors: [
        stubDetector('stub', [
          finding({ detector: 'stub', subject: '/regressor', title: 'THE REGRESSOR' }),
          finding({ detector: 'stub', subject: '/long-standing', title: 'THE OLD ONE' }),
          finding({ detector: 'stub', subject: '/fresh', title: 'THE NEW ONE' }),
        ]),
      ],
    }),
  );
}

describe('renderRunReport — the OK path', () => {
  it('leads with REGRESSIONS, before NEW', async () => {
    const outcome = await runWithARegression();
    const text = renderRunReport(outcome);
    const regressionsAt = text.indexOf('REGRESSIONS');
    const newAt = text.indexOf('\nNEW:');
    expect(regressionsAt).toBeGreaterThan(-1);
    expect(newAt).toBeGreaterThan(-1);
    expect(regressionsAt).toBeLessThan(newAt);
    expect(text).toContain('THE REGRESSOR');
    expect(text).toContain('Recurrence #1');
    expect(text).toContain('THE NEW ONE');
  });

  it('does NOT re-list the open backlog — it counts it', async () => {
    const outcome = await runWithARegression();
    const text = renderRunReport(outcome);
    expect(text).toContain('still open (unchanged, not listed): 1');
    // the long-standing finding's title must NOT appear anywhere
    expect(text).not.toContain('THE OLD ONE');
  });

  it('prints the regression header even when there are none', async () => {
    const outcome = await runBrainScan(baseDeps());
    expect(renderRunReport(outcome)).toContain('REGRESSIONS (recurred after being fixed): 0');
  });

  it('renderCounts names every metric the acceptance asks for', async () => {
    const outcome = await runBrainScan(baseDeps());
    const text = renderCounts(outcome);
    for (const label of [
      'graph nodes',
      'graph edges',
      'detectors run',
      'detectors BLIND',
      'findings produced',
      'REGRESSIONS',
      'new',
      'fixed',
      'still open',
      'suppressed',
      'suppressions expired',
      'not evaluated',
    ]) {
      expect(text).toContain(label);
    }
  });
});

describe('renderStepSummary', () => {
  it('makes the verdict the headline so a green check never implies a scan', async () => {
    const paused = await runBrainScan(
      baseDeps({ probe: new StubProbe(probeOf(pausedReadings())) }),
    );
    const md = renderStepSummary(paused);
    expect(md.startsWith('## Loom Brain scan — PAUSED')).toBe(true);
    expect(md).toContain('NOTHING was scanned');
    // Not backticked: entities do not decode inside a code span, so nothing
    // entity-encoded may be wrapped in one (see markdown-encoding.test.ts).
    expect(md).toContain('| Stopped |');
  });

  it('an UNREACHABLE summary carries the probe failures verbatim', async () => {
    const red = await runBrainScan(
      baseDeps({ probe: new StubProbe(probeOf([], [AUTH_FAILURE])) }),
    );
    const md = renderStepSummary(red);
    expect(md).toContain('UNREACHABLE — auth-failed');
    expect(md).toContain('AuthorizationFailed');
    expect(md).toContain('no finding state was changed');
  });

  it('a REACHED-but-red summary says Azure WAS reached', async () => {
    const red = await runBrainScan(
      baseDeps({
        probe: new StubProbe({ readings: [], failures: [], discovered: 0, scope: 'nothing' }),
      }),
    );
    const md = renderStepSummary(red);
    expect(md).toContain('no-resources-observed');
    expect(md).toContain('(Azure WAS reached)');
    expect(md).not.toContain('could not reach');
  });

  it('an OK summary bolds the regression count', async () => {
    const outcome = await runWithARegression();
    const md = renderStepSummary(outcome);
    expect(md).toContain('| **regressions** | **1** |');
  });

  it('renders the RUN notes, not just the digest notes', async () => {
    // The step summary is the surface the operator reads. "population
    // comparison: NO BASIS", the basis age, the graph-composition change and the
    // graph-version receipt all live on `outcome.notes`, and rendering only
    // `digest.notes` left every one of them visible in the log and invisible
    // here (review of #4014).
    const outcome = await runBrainScan(baseDeps());
    const md = renderStepSummary(outcome);
    expect(md).toContain('### Run notes');
    expect(md).toContain('population comparison: NO BASIS');
    expect(md).toContain('graph version');
  });
});

/**
 * G7 — a whole report category could be deleted silently.
 *
 * `if (d.notEvaluated.length > 0)` -> `if (false)` removed the NOT EVALUATED
 * section from BOTH renderers with zero test failures. That section is the only
 * place a blind detector's frozen backlog surfaces to the operator: the findings
 * are not fixed, they are not listed as open, and without this section they are
 * a bare count.
 */
describe('the NOT EVALUATED section', () => {
  async function runWithABlindDetector() {
    const store = new InMemoryFindingStore();
    await store.put([record({ detector: 'blind-one', subject: '/frozen', state: 'new' })]);
    return runBrainScan(
      baseDeps({
        findings: store,
        detectors: [
          blindDetector('blind-one'),
          stubDetector('stub', [finding({ detector: 'stub', subject: '/live' })]),
        ],
      }),
    );
  }

  it('appears in the LOG report, naming the record and the reason', async () => {
    const outcome = await runWithABlindDetector();
    const text = renderRunReport(outcome);
    expect(text).toContain('NOT EVALUATED');
    expect(text).toContain('blind-one');
    expect(text).toContain('not evidence of repair');
  });

  it('appears in the STEP SUMMARY too', async () => {
    const outcome = await runWithABlindDetector();
    expect(renderStepSummary(outcome)).toContain('NOT EVALUATED');
  });

  it('CONTROL: it is ABSENT when nothing went unevaluated', async () => {
    // Without this, a renderer that printed the header unconditionally would
    // pass the two assertions above and prove nothing.
    const outcome = await runBrainScan(baseDeps());
    expect(outcome.counts?.notEvaluated).toBe(0);
    expect(renderRunReport(outcome)).not.toContain('NOT EVALUATED');
  });

  it('the count is reported even when the section is absent', async () => {
    const outcome = await runBrainScan(baseDeps());
    expect(renderCounts(outcome)).toContain('not evaluated');
  });
});
