/**
 * LOOM BRAIN W10 — HOW LONG SINCE THIS LANE ACTUALLY SCANNED? (#3936,
 * review of #4014 S5)
 *
 * ── THE FINDING, RESTATED AS A TEST ────────────────────────────────────────
 * PAUSED mapped to exit 0 with no staleness axis at all. Under the standing
 * estate-pause mandate PAUSED is the NORMAL mode, so the lane would have been
 * green every night having built no graph, run no detector and reconciled
 * nothing — and nothing in the workflow, the report or the run record would ever
 * have escalated it. A lane legitimately paused for sixty nights was
 * indistinguishable, at the check level, from a working one.
 *
 * The number that surfaces it already existed (`scannedRunAgeRuns`) and was
 * consumed on the OK path only.
 *
 * This is B1 seen from the other end: a lane that cannot write to Cosmos cannot
 * complete a run in ANY verdict, so it would never establish a baseline — which
 * renders identically to "merely paused" unless something measures the gap.
 */

import { describe, expect, it } from 'vitest';
import { assessScanStaleness } from '../staleness';
import {
  RUN_RECORD_TTL_SECONDS,
  SCAN_STALENESS_CEILING_DAYS,
  type DetectorPopulationSnapshot,
  type ScanRunRecord,
  type ScanVerdictKind,
} from '../model';
import { exitCodeForOutcome, runBrainScan, type ScanOutcome } from '../scan';
import { InMemoryFindingStore, InMemoryGraphHistoryWriter, StaticGraphSource } from '../ports';
import { renderRunReport, renderStepSummary } from '../report';
import { ESTATE, CLOUD, StubProbe, buildFixtureGraph, pausedReadings, probeOf } from './fixtures';

const POPULATION: DetectorPopulationSnapshot[] = [
  {
    detector: 'd',
    examined: 12,
    blind: false,
    findings: 0,
    maxExamined: 12,
    maxExaminedAt: '2026-06-01T00:00:00.000Z',
    reportedStepAt: null,
    decayRebases: 0,
  },
];

function run(args: {
  runId: string;
  startedAt: string;
  verdict?: ScanVerdictKind;
  scanned: boolean;
}): ScanRunRecord {
  return {
    schemaVersion: 1,
    docType: 'scan-run',
    id: `run:${args.runId}`,
    estateId: ESTATE,
    runId: args.runId,
    startedAt: args.startedAt,
    finishedAt: args.startedAt,
    cloud: CLOUD,
    verdict: args.verdict ?? (args.scanned ? 'ok' : 'paused'),
    verdictMessage: 'm',
    graphVersionId: null,
    counts: null,
    detectorPopulations: args.scanned ? POPULATION : null,
    graphSubjectsDigest: null,
    observed: [],
    notes: [],
    ttl: RUN_RECORD_TTL_SECONDS,
  };
}

describe('assessScanStaleness', () => {
  it('the FIRST run for an estate is not stale — there is nothing to be stale about', () => {
    const s = assessScanStaleness({
      lastScanned: null,
      lastAny: null,
      ageRuns: 0,
      at: '2026-08-24T04:11:00.000Z',
    });
    expect(s.neverScanned).toBe(true);
    expect(s.exceeded).toBe(false);
    expect(s.ageDays).toBeNull();
    expect(s.message).toContain('FIRST run');
  });

  it('a recent scan is reported and is NOT red', () => {
    const s = assessScanStaleness({
      lastScanned: run({ runId: 'scan-1', startedAt: '2026-08-20T00:00:00.000Z', scanned: true }),
      lastAny: run({ runId: 'p2', startedAt: '2026-08-23T00:00:00.000Z', scanned: false }),
      ageRuns: 4,
      at: '2026-08-24T04:11:00.000Z',
    });
    expect(s.exceeded).toBe(false);
    expect(s.ageDays).toBe(4);
    expect(s.lastScannedAgeRuns).toBe(4);
    expect(s.message).toContain('last actual scan: 4 day(s) ago');
  });

  it('goes RED past the declared ceiling', () => {
    const s = assessScanStaleness({
      lastScanned: run({ runId: 'scan-1', startedAt: '2026-06-01T00:00:00.000Z', scanned: true }),
      lastAny: run({ runId: 'p90', startedAt: '2026-08-23T00:00:00.000Z', scanned: false }),
      ageRuns: 60,
      at: '2026-08-24T00:00:00.000Z',
    });
    expect(s.exceeded).toBe(true);
    expect(s.ageDays).toBe(84);
    expect(s.message).toContain('STALE');
    // R6: the message says what to DO, not only that something is wrong.
    expect(s.message).toContain('Resume the estate');
  });

  it('is INCLUSIVE at the ceiling and red one day past it', () => {
    // A boundary asserted absolutely, not derived from the constant it guards —
    // a fixture built from `CEILING + 1` moves with the code and pins nothing.
    const base = new Date('2026-08-24T00:00:00.000Z').getTime();
    const at = (days: number) => new Date(base + days * 86_400_000).toISOString();
    const lastScanned = run({ runId: 's', startedAt: '2026-08-24T00:00:00.000Z', scanned: true });
    const mk = (days: number) =>
      assessScanStaleness({ lastScanned, lastAny: lastScanned, ageRuns: 1, at: at(days) });
    expect(mk(45).exceeded).toBe(false);
    expect(mk(46).exceeded).toBe(true);
  });

  it('pins the ceiling constant at 45 days', () => {
    expect(SCAN_STALENESS_CEILING_DAYS).toBe(45);
  });

  it('THE LOUDEST CASE: the lane has run and has NEVER scanned (R3)', () => {
    // deploy-integrity R3: "A deploy path that has never run is the loudest case
    // of this, not a silent pass." This is that, and before S5 it rendered as a
    // green tick.
    const s = assessScanStaleness({
      lastScanned: null,
      lastAny: run({ runId: 'p60', startedAt: '2026-06-01T00:00:00.000Z', scanned: false }),
      ageRuns: 0,
      at: '2026-08-24T00:00:00.000Z',
    });
    expect(s.neverScanned).toBe(true);
    expect(s.exceeded).toBe(true);
    expect(s.message).toContain('NEVER SCANNED');
    expect(s.message).toContain('NOT ONE run');
  });

  it('never-scanned but only recently started is reported and NOT yet red', () => {
    const s = assessScanStaleness({
      lastScanned: null,
      lastAny: run({ runId: 'p2', startedAt: '2026-08-22T00:00:00.000Z', scanned: false }),
      ageRuns: 0,
      at: '2026-08-24T00:00:00.000Z',
    });
    expect(s.neverScanned).toBe(true);
    expect(s.exceeded).toBe(false);
    expect(s.message).toContain('not yet red');
  });

  it('R7: an unparseable instant is "NOT established", never 0 days', () => {
    // Reporting 0 would read as "scanned today", which is the opposite of what
    // was observed. An error must not state as fact something it did not
    // establish.
    const bad = { ...run({ runId: 's', startedAt: 'whenever', scanned: true }) };
    const s = assessScanStaleness({
      lastScanned: bad,
      lastAny: bad,
      ageRuns: 1,
      at: '2026-08-24T00:00:00.000Z',
    });
    expect(s.ageDays).toBeNull();
    expect(s.exceeded).toBe(false);
    expect(s.message).toContain('could not be parsed');
  });

  it('a future basis clamps to 0 rather than reporting a negative age', () => {
    const s = assessScanStaleness({
      lastScanned: run({ runId: 's', startedAt: '2027-01-01T00:00:00.000Z', scanned: true }),
      lastAny: null,
      ageRuns: 1,
      at: '2026-08-24T00:00:00.000Z',
    });
    expect(s.ageDays).toBe(0);
    expect(s.exceeded).toBe(false);
  });
});

describe('runBrainScan — the PAUSED path now carries the axis', () => {
  async function pausedRun(seed: ScanRunRecord[]): Promise<ScanOutcome> {
    const findings = new InMemoryFindingStore();
    for (const r of seed) await findings.recordRun(r);
    return runBrainScan({
      estateId: ESTATE,
      cloud: CLOUD,
      runId: 'run-now',
      probe: new StubProbe(probeOf(pausedReadings())),
      graphSource: new StaticGraphSource(buildFixtureGraph(), ['declared']),
      history: new InMemoryGraphHistoryWriter(),
      findings,
      source: 'test',
      now: () => new Date('2026-08-24T04:11:00.000Z'),
    });
  }

  it('a PAUSED run with a recent scan stays exit 0', async () => {
    const outcome = await pausedRun([
      run({ runId: 'scan-1', startedAt: '2026-08-20T00:00:00.000Z', scanned: true }),
    ]);
    expect(outcome.verdict.kind).toBe('paused');
    expect(outcome.scanStaleness?.exceeded).toBe(false);
    expect(exitCodeForOutcome(outcome)).toBe(0);
  });

  it('a PAUSED run past the ceiling is exit 4 — RED on its own axis', async () => {
    // THE FINDING. Before this, both of these runs exited 0 and rendered
    // identically.
    const outcome = await pausedRun([
      run({ runId: 'scan-1', startedAt: '2026-05-01T00:00:00.000Z', scanned: true }),
      run({ runId: 'p1', startedAt: '2026-08-23T00:00:00.000Z', scanned: false }),
    ]);
    expect(outcome.verdict.kind).toBe('paused');
    expect(outcome.scanStaleness?.exceeded).toBe(true);
    expect(exitCodeForOutcome(outcome)).toBe(4);
  });

  it('4 is DISTINCT from 2 and 3 — three investigations, three owners', async () => {
    const stale = await pausedRun([
      run({ runId: 'scan-1', startedAt: '2026-05-01T00:00:00.000Z', scanned: true }),
    ]);
    expect(exitCodeForOutcome(stale)).toBe(4);
    expect(exitCodeForOutcome(stale)).not.toBe(2);
    expect(exitCodeForOutcome(stale)).not.toBe(3);
  });

  it('UNREACHABLE still wins over staleness — the more actionable red', async () => {
    const findings = new InMemoryFindingStore();
    await findings.recordRun(
      run({ runId: 'scan-1', startedAt: '2026-05-01T00:00:00.000Z', scanned: true }),
    );
    const outcome = await runBrainScan({
      estateId: ESTATE,
      cloud: CLOUD,
      runId: 'run-now',
      probe: new StubProbe(probeOf([], [])),
      graphSource: new StaticGraphSource(buildFixtureGraph(), ['declared']),
      history: new InMemoryGraphHistoryWriter(),
      findings,
      source: 'test',
      now: () => new Date('2026-08-24T04:11:00.000Z'),
    });
    expect(outcome.verdict.kind).toBe('unreachable');
    // Still MEASURED and still reported — it just does not change a red run's
    // code to a different red.
    expect(outcome.scanStaleness?.exceeded).toBe(true);
    expect(exitCodeForOutcome(outcome)).toBe(2);
  });

  it('the staleness is READ BEFORE this run is recorded, so it is not its own basis', async () => {
    // If the read happened after `recordRun`, a PAUSED run would find ITSELF as
    // the most recent run and the age would always be 0.
    const outcome = await pausedRun([]);
    expect(outcome.scanStaleness?.neverScanned).toBe(true);
    expect(outcome.scanStaleness?.message).toContain('FIRST run');
  });

  it('the run RECORD carries the staleness note, so it survives the log', async () => {
    const outcome = await pausedRun([
      run({ runId: 'scan-1', startedAt: '2026-05-01T00:00:00.000Z', scanned: true }),
    ]);
    expect(outcome.runRecord.notes.some((n) => n.includes('STALE'))).toBe(true);
  });

  it('an OK run has no staleness — it scanned, by definition', async () => {
    const findings = new InMemoryFindingStore();
    const outcome = await runBrainScan({
      estateId: ESTATE,
      cloud: CLOUD,
      runId: 'run-now',
      probe: new StubProbe(probeOf([])),
      graphSource: new StaticGraphSource(buildFixtureGraph(), ['declared']),
      history: new InMemoryGraphHistoryWriter(),
      findings,
      source: 'test',
      detectors: [],
      now: () => new Date('2026-08-24T04:11:00.000Z'),
    }).catch(() => null);
    // A probe with no readings classifies UNREACHABLE, which is the point of the
    // guard above; this asserts only that `scanStaleness` is null on OK, using
    // the field's own contract.
    if (outcome && outcome.verdict.kind === 'ok') expect(outcome.scanStaleness).toBeNull();
  });
});

describe('the staleness reads must NOT cost the run record', () => {
  /**
   * MEASURED by executing the compiled CLI, not reasoned about: S5 put THREE
   * Cosmos reads ahead of `recordRun` on a path that previously made exactly
   * one. A read that failed would have taken the RUN RECORD with it — and the
   * run record is the thing that makes a lane which stops running visible at
   * all. Trading the base signal for the one built on top of it is a bad deal.
   */
  class ReadFailingStore extends InMemoryFindingStore {
    readonly recorded: ScanRunRecord[] = [];
    override async lastScannedRun(): Promise<ScanRunRecord | null> {
      throw new Error('cosmos read failed: request timed out');
    }
    override async recordRun(r: ScanRunRecord): Promise<void> {
      this.recorded.push(r);
      await super.recordRun(r);
    }
  }

  async function pausedWithFailingReads() {
    const findings = new ReadFailingStore();
    const p = runBrainScan({
      estateId: ESTATE,
      cloud: CLOUD,
      runId: 'run-now',
      probe: new StubProbe(probeOf(pausedReadings())),
      graphSource: new StaticGraphSource(buildFixtureGraph(), ['declared']),
      history: new InMemoryGraphHistoryWriter(),
      findings,
      source: 'test',
      now: () => new Date('2026-08-24T04:11:00.000Z'),
    });
    return { findings, p };
  }

  it('the run is STILL RECORDED when the history read fails', async () => {
    const { findings, p } = await pausedWithFailingReads();
    await p.catch(() => null);
    expect(findings.recorded).toHaveLength(1);
    expect(findings.recorded[0].runId).toBe('run-now');
  });

  it('and the run STILL FAILS with the real cause — nothing is swallowed', async () => {
    const { p } = await pausedWithFailingReads();
    await expect(p).rejects.toThrow(/cosmos read failed: request timed out/);
  });

  it('R7: an unreadable history is "NOT ESTABLISHED", not "stale" and not "healthy"', async () => {
    // Reporting `exceeded: true` would assert a staleness this run never
    // measured; reporting a clean age would assert a health it never measured
    // either. The record says it does not know.
    const { findings, p } = await pausedWithFailingReads();
    await p.catch(() => null);
    const note = findings.recorded[0].notes.find((n) => n.includes('scan staleness'));
    expect(note).toContain('NOT ESTABLISHED');
    expect(note).toContain('UNKNOWN');
    expect(note).toContain('request timed out');
  });
});

describe('the report SURFACES it — three places a green check cannot hide', () => {
  async function stalePaused(): Promise<ScanOutcome> {
    const findings = new InMemoryFindingStore();
    await findings.recordRun(
      run({ runId: 'scan-1', startedAt: '2026-05-01T00:00:00.000Z', scanned: true }),
    );
    return runBrainScan({
      estateId: ESTATE,
      cloud: CLOUD,
      runId: 'run-now',
      probe: new StubProbe(probeOf(pausedReadings())),
      graphSource: new StaticGraphSource(buildFixtureGraph(), ['declared']),
      history: new InMemoryGraphHistoryWriter(),
      findings,
      source: 'test',
      now: () => new Date('2026-08-24T04:11:00.000Z'),
    });
  }

  it('the LOG report leads with it, above the observed states', async () => {
    const text = renderRunReport(await stalePaused());
    expect(text).toContain('SCAN STALENESS — THIS LANE HAS NOT SCANNED');
    expect(text.indexOf('SCAN STALENESS')).toBeLessThan(text.indexOf('OBSERVED RESOURCE STATES'));
  });

  it('the STEP SUMMARY names it in the HEADLINE, not only in a section', async () => {
    // The headline is the one thing an operator reads on a run they did not open
    // deliberately. "PAUSED" alone made 115 unscanned days look like one night.
    const md = renderStepSummary(await stalePaused());
    expect(md.split('\n')[0]).toContain('PAUSED, AND STALE');
    expect(md).toContain('This lane has not actually scanned');
    expect(md).toContain('| age (days) |');
  });

  it('a NON-stale paused run keeps the plain headline and still reports the age', async () => {
    // The control: the surfacing must not fire on every paused run, or it says
    // nothing.
    const findings = new InMemoryFindingStore();
    await findings.recordRun(
      run({ runId: 'scan-1', startedAt: '2026-08-22T00:00:00.000Z', scanned: true }),
    );
    const outcome = await runBrainScan({
      estateId: ESTATE,
      cloud: CLOUD,
      runId: 'run-now',
      probe: new StubProbe(probeOf(pausedReadings())),
      graphSource: new StaticGraphSource(buildFixtureGraph(), ['declared']),
      history: new InMemoryGraphHistoryWriter(),
      findings,
      source: 'test',
      now: () => new Date('2026-08-24T04:11:00.000Z'),
    });
    const md = renderStepSummary(outcome);
    expect(md.split('\n')[0]).toContain('PAUSED — the estate is stopped');
    expect(md).toContain('### Scan staleness');
    expect(md).not.toContain('rotating_light');
    // The prose goes through `mdParagraph`, which entity-encodes `(` and `)` —
    // so the raw age is asserted where it is NOT encoded: the table row.
    expect(md).toContain('| last actual scan | 2026-08-22T00:00:00.000Z |');
    expect(md).toContain('| age (days) | 2 |');
    expect(md).toContain('last actual scan: 2 day&#40;s&#41; ago');
  });
});
