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
 * verdict did not.
 *
 * ── AND WHY THE HIGH-WATER MARK EXISTS (review of #4014, G4) ──────────────
 * The first version compared only against the previous run, which makes the
 * comparator a RATCHET. Measured by the reviewer at 19% per run:
 * 1000 -> 77 over twelve runs, 92.3% of the population gone, ZERO regressions
 * reported — and a single large drop was red for exactly one run, clearable by
 * pressing "Re-run jobs". Both are tested below.
 *
 * ── THE CONTROLS ───────────────────────────────────────────────────────────
 * A comparator that flagged EVERY run would satisfy "the mutated run is red". So
 * each red assertion is paired with a green one over the same shapes: an
 * unchanged population, a GROWING population, and a shrink inside the tolerance
 * must all pass. And "fewer findings" must never be a regression — that is the
 * outcome the whole system exists to produce.
 */

import { describe, expect, it } from 'vitest';
import {
  detectPopulationRegression,
  digestOfIds,
  fnv1a64,
  snapshotPopulations,
} from '../population';
import {
  FINDING_SCHEMA_VERSION,
  HIGH_WATER_DECAY_DAYS,
  POPULATION_SHRINK_TOLERANCE,
  RUN_RECORD_TTL_SECONDS,
  type DetectorPopulationSnapshot,
  type ScanRunRecord,
} from '../model';

const T0 = '2026-08-20T00:00:00.000Z';
const T1 = '2026-08-24T00:00:00.000Z';

function priorRun(pops: readonly DetectorPopulationSnapshot[] | null): ScanRunRecord {
  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    docType: 'scan-run',
    id: 'run:run-0',
    estateId: 'e',
    runId: 'run-0',
    startedAt: T0,
    finishedAt: T0,
    cloud: 'AzureCloud',
    verdict: 'ok',
    verdictMessage: 'ok',
    graphVersionId: 'v1',
    counts: null,
    detectorPopulations: pops,
    graphSubjectsDigest: null,
    observed: [],
    notes: [],
    ttl: RUN_RECORD_TTL_SECONDS,
  };
}

/** A snapshot. `maxExamined` defaults to `examined` — no history. */
const p = (
  detector: string,
  examined: number,
  opts: { blind?: boolean; findings?: number; maxExamined?: number; maxExaminedAt?: string } = {},
): DetectorPopulationSnapshot => ({
  detector,
  examined,
  blind: opts.blind ?? examined === 0,
  findings: opts.findings ?? 0,
  maxExamined: opts.maxExamined ?? examined,
  maxExaminedAt: opts.maxExaminedAt ?? T0,
});

describe('detectPopulationRegression — it bites', () => {
  it('a detector that WENT BLIND is a regression, whatever the tolerance says', () => {
    const r = detectPopulationRegression(priorRun([p('a', 33, { blind: false })]), [
      p('a', 0, { blind: true, maxExamined: 33 }),
    ]);
    expect(r).not.toBeNull();
    expect(r?.detectors[0].kind).toBe('went-blind');
    expect(r?.message).toContain('POPULATION REGRESSION');
    expect(r?.message).toContain('green and it is looking at nothing');
  });

  it('a detector that DISAPPEARED is a regression', () => {
    const r = detectPopulationRegression(
      priorRun([p('a', 33, { blind: false }), p('b', 5, { blind: false })]),
      [p('a', 33, { blind: false })],
    );
    expect(r?.detectors).toHaveLength(1);
    expect(r?.detectors[0].detector).toBe('b');
    expect(r?.detectors[0].kind).toBe('disappeared');
  });

  it('a SHRINK past the tolerance is a regression', () => {
    // 100 -> 79 is a 21% drop. ABSOLUTE numbers, never arithmetic on the
    // constant they guard — see the MAX_SUPPRESSION_DAYS lesson in the header of
    // lifecycle.test.ts.
    const r = detectPopulationRegression(priorRun([p('a', 100, { blind: false })]), [
      p('a', 79, { blind: false, maxExamined: 100 }),
    ]);
    expect(r?.detectors[0].kind).toBe('shrank');
    expect(r?.message).toContain('100 -> 79');
  });
});

describe('detectPopulationRegression — THE ANTI-RATCHET (G4)', () => {
  it('a slow erosion inside the tolerance is caught by the HIGH-WATER MARK', () => {
    // 100 -> 85 is a 15% step: inside the tolerance, so `shrank` does not fire.
    // But 85 is 15% below a high-water mark of 100 … still inside. Take it one
    // more step: 85 -> 75 with a mark of 100 is 25% below the mark.
    const r = detectPopulationRegression(priorRun([p('a', 85, { blind: false, maxExamined: 100 })]), [
      p('a', 75, { blind: false, maxExamined: 100 }),
    ]);
    expect(r).not.toBeNull();
    expect(r?.detectors[0].kind).toBe('below-high-water');
    expect(r?.detectors[0].highWater).toBe(100);
    expect(r?.message).toContain('high-water');
    expect(r?.message).toContain('slow erosion');
  });

  it("THE MEASURED SEQUENCE: 19% per run is caught, and not on the twelfth run", () => {
    // The reviewer's sequence. Under the previous design ALL of these were
    // green. Under the high-water mark the erosion is caught on the SECOND step,
    // because by then the cumulative drop from the mark exceeds the tolerance.
    let mark = 1000;
    let prev = 1000;
    const caughtAt: number[] = [];
    for (let step = 1; step <= 12; step += 1) {
      const cur = Math.round(prev * 0.81);
      const r = detectPopulationRegression(
        priorRun([p('a', prev, { blind: false, maxExamined: mark, maxExaminedAt: T0 })]),
        [p('a', cur, { blind: false, maxExamined: mark, maxExaminedAt: T0 })],
      );
      if (r !== null) caughtAt.push(step);
      prev = cur;
      mark = Math.max(mark, cur);
    }
    expect(caughtAt.length).toBeGreaterThan(0);
    expect(caughtAt[0]).toBeLessThanOrEqual(2);
  });

  it('a single large drop stays red on an immediate RE-RUN — not clearable by "Re-run jobs"', () => {
    // Measured by the reviewer: exit 3, then exit 0 on a re-run with nothing
    // changed. The step-over-step comparison had already re-based; the mark had
    // not, and now it does not.
    const afterDrop = p('a', 40, { blind: false, maxExamined: 100, maxExaminedAt: T0 });
    const rerun = detectPopulationRegression(priorRun([afterDrop]), [afterDrop]);
    expect(rerun).not.toBeNull();
    expect(rerun?.detectors[0].kind).toBe('below-high-water');
  });
});

describe('detectPopulationRegression — THE CONTROLS', () => {
  it('an UNCHANGED population is not a regression', () => {
    expect(
      detectPopulationRegression(priorRun([p('a', 33, { blind: false })]), [
        p('a', 33, { blind: false }),
      ]),
    ).toBeNull();
  });

  it('a GROWING population is not a regression', () => {
    expect(
      detectPopulationRegression(priorRun([p('a', 33, { blind: false })]), [
        p('a', 63, { blind: false, maxExamined: 63 }),
      ]),
    ).toBeNull();
  });

  it('a shrink INSIDE the tolerance, at the mark, is not a regression', () => {
    // 100 -> 81 is a 19% drop AND 19% below the mark. Both checks must pass.
    expect(
      detectPopulationRegression(priorRun([p('a', 100, { blind: false })]), [
        p('a', 81, { blind: false, maxExamined: 100 }),
      ]),
    ).toBeNull();
  });

  it('the tolerance is pinned ABSOLUTELY at 0.2', () => {
    // Pinned by value, not derived. A fixture built from the constant moves with
    // the code it guards — the MAX_SUPPRESSION_DAYS lesson.
    expect(POPULATION_SHRINK_TOLERANCE).toBe(0.2);
  });

  it('the high-water decay window is pinned ABSOLUTELY at 30 days', () => {
    expect(HIGH_WATER_DECAY_DAYS).toBe(30);
  });

  it('FEWER FINDINGS is never a regression — that is the outcome, not an incident', () => {
    const before = priorRun([p('a', 33, { blind: false, findings: 8 })]);
    expect(detectPopulationRegression(before, [p('a', 33, { blind: false, findings: 0 })])).toBeNull();
  });

  it('a detector that was ALREADY blind and stays blind is not a NEW regression', () => {
    // Honest limit, stated: a PERMANENTLY blind detector is visible only as a
    // count in the report, not as a regression. It never got worse.
    expect(
      detectPopulationRegression(priorRun([p('a', 0, { blind: true })]), [p('a', 0, { blind: true })]),
    ).toBeNull();
  });

  it('a NEW detector appearing is not a regression', () => {
    expect(
      detectPopulationRegression(priorRun([p('a', 33, { blind: false })]), [
        p('a', 33, { blind: false }),
        p('b', 9, { blind: false }),
      ]),
    ).toBeNull();
  });
});

describe('detectPopulationRegression — NO BASIS and basis age', () => {
  it('returns null when there is no previous run', () => {
    expect(detectPopulationRegression(null, [p('a', 0, { blind: true })])).toBeNull();
  });

  it('returns null when the previous run carried no populations', () => {
    expect(detectPopulationRegression(priorRun(null), [p('a', 0, { blind: true })])).toBeNull();
  });

  it('names how many runs back the basis is when it is not last night', () => {
    const r = detectPopulationRegression(
      priorRun([p('a', 33, { blind: false })]),
      [p('a', 0, { blind: true, maxExamined: 33 })],
      { basisAgeRuns: 11 },
    );
    expect(r?.basisAgeRuns).toBe(11);
    expect(r?.message).toContain('11 runs back');
    expect(r?.message).toContain('did not scan');
  });

  it('does NOT mention basis age when the basis is the previous run', () => {
    const r = detectPopulationRegression(
      priorRun([p('a', 33, { blind: false })]),
      [p('a', 0, { blind: true, maxExamined: 33 })],
      { basisAgeRuns: 1 },
    );
    expect(r?.message).not.toContain('runs back');
  });
});

describe('snapshotPopulations — the high-water mark carries forward', () => {
  const results = (examined: number, blind = false) => [
    { detector: 'a', findings: [] as unknown[], population: { examined, blind } },
  ];

  it('with no history, this run IS the mark', () => {
    const s = snapshotPopulations(results(33), { previous: null, at: T1 });
    expect(s[0].maxExamined).toBe(33);
    expect(s[0].maxExaminedAt).toBe(T1);
  });

  it('a NEW maximum wins and re-stamps the clock', () => {
    const s = snapshotPopulations(results(63), {
      previous: [p('a', 33, { maxExamined: 33, maxExaminedAt: T0 })],
      at: T1,
    });
    expect(s[0].maxExamined).toBe(63);
    expect(s[0].maxExaminedAt).toBe(T1);
  });

  it('below the mark, the mark is KEPT — this is the whole anti-ratchet', () => {
    const s = snapshotPopulations(results(10), {
      previous: [p('a', 33, { maxExamined: 100, maxExaminedAt: T0 })],
      at: T1,
    });
    expect(s[0].maxExamined).toBe(100);
    expect(s[0].maxExaminedAt).toBe(T0);
  });

  it('the mark DECAYS after the window, so a permanent downsize is not red forever', () => {
    // A gate that can never go green is its own failure mode.
    const old = '2026-01-01T00:00:00.000Z';
    const s = snapshotPopulations(results(10), {
      previous: [p('a', 33, { maxExamined: 100, maxExaminedAt: old })],
      at: T1,
    });
    expect(s[0].maxExamined).toBe(10);
    expect(s[0].maxExaminedAt).toBe(T1);
  });

  it('CONTROL: just INSIDE the decay window the mark is still kept', () => {
    const justInside = new Date(
      Date.parse(T1) - (HIGH_WATER_DECAY_DAYS - 1) * 86_400_000,
    ).toISOString();
    const s = snapshotPopulations(results(10), {
      previous: [p('a', 33, { maxExamined: 100, maxExaminedAt: justInside })],
      at: T1,
    });
    expect(s[0].maxExamined).toBe(100);
  });

  it('projects the detector pass faithfully', () => {
    const s = snapshotPopulations(
      [
        { detector: 'a', findings: [1, 2], population: { examined: 33, blind: false } },
        { detector: 'b', findings: [], population: { examined: 0, blind: true } },
      ],
      { previous: null, at: T1 },
    );
    expect(s.map((x) => [x.detector, x.examined, x.blind, x.findings])).toEqual([
      ['a', 33, false, 2],
      ['b', 0, true, 0],
    ]);
  });
});

describe('digestOfIds — composition at constant size (G5)', () => {
  it('a SWAPPED subject set at the SAME size gives a DIFFERENT digest', () => {
    // The measured gap: swap every subject, keep `examined: 63`, and a
    // count-only comparator returns null. This is what closes it at the graph
    // level.
    const a = digestOfIds(['/a', '/b', '/c']);
    const b = digestOfIds(['/x', '/y', '/z']);
    expect(a).not.toBe(b);
  });

  it('ORDER does not move the digest — ARG does not promise a stable row order', () => {
    // Hashing as-emitted would report composition change on every single run,
    // which trains the operator to ignore the signal.
    expect(digestOfIds(['/a', '/b', '/c'])).toBe(digestOfIds(['/c', '/a', '/b']));
  });

  it('a SINGLE added subject moves the digest', () => {
    expect(digestOfIds(['/a', '/b'])).not.toBe(digestOfIds(['/a', '/b', '/c']));
  });

  it('an empty set has a stable digest', () => {
    expect(digestOfIds([])).toBe(digestOfIds([]));
  });

  it('fnv1a64 is 16 lowercase hex characters', () => {
    expect(fnv1a64('anything')).toMatch(/^[0-9a-f]{16}$/);
  });
});
