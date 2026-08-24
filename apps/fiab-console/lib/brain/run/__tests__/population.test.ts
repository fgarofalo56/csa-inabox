/**
 * LOOM BRAIN W10 — the POPULATION comparator (#3936, PRP §5).
 *
 * #3936's mutation acceptance: *"break a detector's input and prove the run
 * CHANGES VERDICT rather than reporting clean."*
 *
 * ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
 * Measured live, 2026-08-24, against the Commercial estate: emptying the wire
 * binding table this lane feeds the graph extractor took the run from 18 edges /
 * 8 findings / 1 blind detector to 0 edges / 0 findings / 2 blind detectors —
 * and the run still reported `ok` with "0 findings". Every count moved and the
 * verdict did not. This comparator is the fix, and these tests are the proof it
 * bites.
 *
 * ── THE CONTROLS ───────────────────────────────────────────────────────────
 * A comparator that flagged EVERY run would satisfy "the mutated run is red". So
 * each red assertion is paired with a green one over the same shapes: an
 * unchanged population, a GROWING population, and a shrink inside the tolerance
 * must all pass. And "fewer findings" must never be a regression — that is the
 * outcome the whole system exists to produce.
 */

import { describe, expect, it } from 'vitest';
import { detectPopulationRegression, snapshotPopulations } from '../population';
import {
  FINDING_SCHEMA_VERSION,
  POPULATION_SHRINK_TOLERANCE,
  RUN_RECORD_TTL_SECONDS,
  type DetectorPopulationSnapshot,
  type ScanRunRecord,
} from '../model';

function priorRun(pops: readonly DetectorPopulationSnapshot[] | null): ScanRunRecord {
  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    docType: 'scan-run',
    id: 'run:run-0',
    estateId: 'e',
    runId: 'run-0',
    startedAt: '2026-08-23T04:11:00.000Z',
    finishedAt: '2026-08-23T04:12:00.000Z',
    cloud: 'AzureCloud',
    verdict: 'ok',
    verdictMessage: 'ok',
    graphVersionId: 'v1',
    counts: null,
    detectorPopulations: pops,
    observed: [],
    notes: [],
    ttl: RUN_RECORD_TTL_SECONDS,
  };
}

const p = (
  detector: string,
  examined: number,
  blind = examined === 0,
  findings = 0,
): DetectorPopulationSnapshot => ({ detector, examined, blind, findings });

describe('detectPopulationRegression — it bites', () => {
  it('a detector that WENT BLIND is a regression, whatever the tolerance says', () => {
    const r = detectPopulationRegression(priorRun([p('a', 33, false)]), [p('a', 0, true)]);
    expect(r).not.toBeNull();
    expect(r?.detectors[0].kind).toBe('went-blind');
    expect(r?.message).toContain('POPULATION REGRESSION');
    expect(r?.message).toContain('green and it is looking at nothing');
  });

  it('a detector that DISAPPEARED is a regression', () => {
    const r = detectPopulationRegression(priorRun([p('a', 33, false), p('b', 5, false)]), [
      p('a', 33, false),
    ]);
    expect(r?.detectors).toHaveLength(1);
    expect(r?.detectors[0].detector).toBe('b');
    expect(r?.detectors[0].kind).toBe('disappeared');
  });

  it('a SHRINK past the tolerance is a regression', () => {
    // 100 -> 79 is a 21% drop, just past the 20% tolerance.
    const r = detectPopulationRegression(priorRun([p('a', 100, false)]), [p('a', 79, false)]);
    expect(r?.detectors[0].kind).toBe('shrank');
    expect(r?.message).toContain('100 -> 79');
  });
});

describe('detectPopulationRegression — THE CONTROLS', () => {
  it('an UNCHANGED population is not a regression', () => {
    expect(detectPopulationRegression(priorRun([p('a', 33, false)]), [p('a', 33, false)])).toBeNull();
  });

  it('a GROWING population is not a regression', () => {
    expect(detectPopulationRegression(priorRun([p('a', 33, false)]), [p('a', 63, false)])).toBeNull();
  });

  it('a shrink INSIDE the tolerance is not a regression', () => {
    // 100 -> 81 is a 19% drop, inside the 20% tolerance.
    expect(detectPopulationRegression(priorRun([p('a', 100, false)]), [p('a', 81, false)])).toBeNull();
    expect(POPULATION_SHRINK_TOLERANCE).toBe(0.2);
  });

  it('FEWER FINDINGS is never a regression — that is the outcome, not an incident', () => {
    const before = priorRun([p('a', 33, false, 8)]);
    expect(detectPopulationRegression(before, [p('a', 33, false, 0)])).toBeNull();
  });

  it('a detector that was ALREADY blind and stays blind is not a new regression', () => {
    expect(detectPopulationRegression(priorRun([p('a', 0, true)]), [p('a', 0, true)])).toBeNull();
  });

  it('a NEW detector appearing is not a regression', () => {
    expect(
      detectPopulationRegression(priorRun([p('a', 33, false)]), [p('a', 33, false), p('b', 9, false)]),
    ).toBeNull();
  });
});

describe('detectPopulationRegression — NO BASIS', () => {
  it('returns null when there is no previous run', () => {
    expect(detectPopulationRegression(null, [p('a', 0, true)])).toBeNull();
  });

  it('returns null when the previous run carried no populations', () => {
    expect(detectPopulationRegression(priorRun(null), [p('a', 0, true)])).toBeNull();
  });
});

describe('snapshotPopulations', () => {
  it('projects a detector pass to what the next run compares against', () => {
    const snap = snapshotPopulations([
      { detector: 'a', findings: [1, 2], population: { examined: 33, blind: false } },
      { detector: 'b', findings: [], population: { examined: 0, blind: true } },
    ]);
    expect(snap).toEqual([
      { detector: 'a', examined: 33, blind: false, findings: 2 },
      { detector: 'b', examined: 0, blind: true, findings: 0 },
    ]);
  });
});
