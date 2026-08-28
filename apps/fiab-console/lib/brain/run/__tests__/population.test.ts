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
 * ── AND WHY THE DECAY IS BOUNDED (review of #4014, SECOND pass) ───────────
 * The high-water mark's DECAY then re-opened the same ratchet on a longer clock.
 * Measured end to end through `snapshotPopulations` + `detectPopulationRegression`:
 * drop 19%, hold 31 days, repeat, twelve times — 1000 -> 80, ZERO regressions
 * fired over 372 days, because the re-base wrote today's value as the new
 * baseline. The mechanism was sound (the same erosion at DAILY cadence fired 11
 * of 12, before and after); only the re-basing rule was wrong. See "THE DECAY
 * RE-OPENED THE RATCHET".
 *
 * THE OLD TEST FOR THAT SEQUENCE COULD NOT HAVE CAUGHT IT: it advanced the mark
 * by hand and never called `snapshotPopulations`, so the decay was outside its
 * population entirely. Every erosion assertion added since drives the real pair
 * through {@link drive}.
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
  stepWasReported,
} from '../population';
import {
  FINDING_SCHEMA_VERSION,
  HIGH_WATER_DECAY_DAYS,
  HIGH_WATER_DECAY_FLOOR,
  POPULATION_SHRINK_TOLERANCE,
  RUN_RECORD_TTL_SECONDS,
  type DetectorPopulationSnapshot,
  type ScanRunRecord,
} from '../model';

const T0 = '2026-08-20T00:00:00.000Z';
const T1 = '2026-08-24T00:00:00.000Z';

function priorRun(pops: readonly DetectorPopulationSnapshot[] | null): ScanRunRecord {
  return priorRunAt(pops, T0);
}

function priorRunAt(
  pops: readonly DetectorPopulationSnapshot[] | null,
  when: string,
): ScanRunRecord {
  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    docType: 'scan-run',
    id: 'run:run-0',
    estateId: 'e',
    runId: 'run-0',
    startedAt: when,
    finishedAt: when,
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
  opts: {
    blind?: boolean;
    findings?: number;
    maxExamined?: number;
    maxExaminedAt?: string;
    reportedStepAt?: string | null;
    decayRebases?: number;
  } = {},
): DetectorPopulationSnapshot => ({
  detector,
  examined,
  blind: opts.blind ?? examined === 0,
  findings: opts.findings ?? 0,
  maxExamined: opts.maxExamined ?? examined,
  maxExaminedAt: opts.maxExaminedAt ?? T0,
  reportedStepAt: opts.reportedStepAt ?? null,
  decayRebases: opts.decayRebases ?? 0,
});

const DAY_MS = 86_400_000;
const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
const at = (day: number) => new Date(EPOCH + day * DAY_MS).toISOString();

/**
 * Drive the REAL pair — `snapshotPopulations` then `detectPopulationRegression` —
 * over a sequence of (day, examined) observations, exactly as `scan.ts` does.
 *
 * WHY THIS EXISTS, AND WHY THE OLD TEST MISSED THE BUG. The pre-existing
 * "measured sequence" test advanced the high-water mark BY HAND
 * (`mark = Math.max(mark, cur)`) and never called `snapshotPopulations` at all.
 * That is a fixture modelling the code: it could not observe the decay, so the
 * decay could re-open the ratchet underneath it and the test stayed green. Every
 * assertion about erosion below goes through this driver instead.
 */
function drive(
  observations: readonly (readonly [day: number, examined: number])[],
): { readonly fired: number[]; readonly trace: string[] } {
  let snapshots = snapshotPopulations(
    [{ detector: 'a', findings: [], population: { examined: observations[0][1], blind: false } }],
    { previous: null, at: at(observations[0][0]) },
  );
  let previous = priorRunAt(snapshots, at(observations[0][0]));
  const fired: number[] = [];
  const trace: string[] = [];

  for (let i = 1; i < observations.length; i += 1) {
    const [day, examined] = observations[i];
    const cur = snapshotPopulations(
      [{ detector: 'a', findings: [], population: { examined, blind: examined === 0 } }],
      { previous: snapshots, at: at(day) },
    );
    const r = detectPopulationRegression(previous, cur);
    if (r !== null) fired.push(i);
    trace.push(`d${day}=${examined} mark=${cur[0].maxExamined} ${r === null ? 'green' : 'RED'}`);
    snapshots = cur;
    previous = priorRunAt(cur, at(day));
  }
  return { fired, trace };
}

/** `observations` for a constant per-cycle contraction at a fixed cadence. */
function decaySequence(
  ratePerCycle: number,
  cadenceDays: number,
  cycles: number,
): (readonly [number, number])[] {
  const out: (readonly [number, number])[] = [[0, 1000]];
  let examined = 1000;
  for (let c = 1; c <= cycles; c += 1) {
    examined = Math.round(examined * (1 - ratePerCycle));
    out.push([c * cadenceDays, examined] as const);
  }
  return out;
}

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
    // The reviewer's sequence, with the mark advanced BY HAND. Kept because it
    // pins the comparator's arithmetic in isolation — but note what it CANNOT
    // see: it never calls `snapshotPopulations`, so it is blind to the decay,
    // and the decay re-opened this exact ratchet on a 31-day clock while this
    // test stayed green. The end-to-end version lives in "THE DECAY RE-OPENED
    // THE RATCHET" below and drives the real pair.
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

describe('THE DECAY RE-OPENED THE RATCHET (review of #4014, second pass)', () => {
  /*
   * MEASURED, end to end through the real pair, BEFORE the bound existed:
   *
   *   d31=810 d62=656 d93=531 d124=430 d155=348 d186=282
   *   d217=228 d248=185 d279=150 d310=122 d341=99 d372=80
   *   regressions fired: 0 over 372 days — 92% of the population gone
   *
   * Drop 19% (inside the 20% step tolerance, so silent), hold 31 days, repeat.
   * `snapshotPopulations` re-based the mark to TODAY'S value once the window
   * elapsed, so each hold laundered the reduction into the new baseline.
   *
   * The mechanism was never the problem: the identical erosion at DAILY cadence
   * fired 11 times out of 12, before and after. Only the re-basing rule was
   * wrong, and only that changed.
   */

  it('THE EXACT SCENARIO: drop 19%, hold 31 days, twelve times — MUST fire', () => {
    const { fired, trace } = drive(decaySequence(0.19, 31, 12));
    expect(fired.length, `zero regressions over 372 days: ${trace.join(' | ')}`).toBeGreaterThan(0);
    // Not merely "eventually". The whole failure was that a year of erosion
    // passed unremarked, so it has to bite early — measured, cycle 2.
    expect(fired[0], trace.join(' | ')).toBeLessThanOrEqual(3);
  });

  it('and the final population is nowhere near laundered away unremarked', () => {
    // The count that made this a P0: 1000 -> 80 is 92% of the examined set gone.
    // Every one of those cycles after the second is now a red run.
    const { fired } = drive(decaySequence(0.19, 31, 12));
    expect(fired.length).toBeGreaterThanOrEqual(10);
  });

  it('THE CONTROL THAT PROVES THE MECHANISM WAS ALREADY SOUND: same erosion, DAILY', () => {
    // 11 of 12 before the fix, 11 of 12 after. If this number had MOVED, the
    // "fix" would have been a blanket tightening rather than a repair of the
    // re-basing rule, and the comparison above would prove nothing.
    const { fired } = drive(decaySequence(0.19, 1, 12));
    expect(fired.length).toBe(11);
  });

  it.each([
    ['31-day holds', 31],
    ['61-day holds', 61],
    ['91-day holds', 91],
  ])('holding LONGER does not buy the erosion silence — %s', (_label, cadence) => {
    // The obvious evasion once the window is known: just wait longer. The bound
    // is per-window, not per-run, so a longer hold decays the mark by the same
    // bounded fraction and the erosion still outruns it.
    const { fired, trace } = drive(decaySequence(0.19, cadence, 12));
    expect(fired.length, trace.join(' | ')).toBeGreaterThan(0);
  });

  it('POSITIVE CONTROL: contraction AT the permitted rate is silent, for a year', () => {
    // The gate has to be satisfiable or it is the "gate that always fails" twin
    // of the bug. HIGH_WATER_DECAY_FLOOR is a CONTRACT, stated in its own
    // docstring: up to 10% per 30-day window passes without comment.
    const { fired, trace } = drive(decaySequence(0.1, 31, 12));
    expect(fired, trace.join(' | ')).toEqual([]);
  });

  it('POSITIVE CONTROL: a genuinely slow shrink (5% per month) is silent', () => {
    const { fired, trace } = drive(decaySequence(0.05, 31, 12));
    expect(fired, trace.join(' | ')).toEqual([]);
  });

  it('POSITIVE CONTROL: a FLAT population never drifts red', () => {
    // The mark must not decay downward on its own. A bound that ratcheted the
    // mark down every window regardless of the observed value would eventually
    // fire on an estate that never changed — and would be indistinguishable
    // from this test passing for the right reason without it.
    const flat: (readonly [number, number])[] = [[0, 1000]];
    for (let c = 1; c <= 12; c += 1) flat.push([c * 31, 1000] as const);
    const { fired, trace } = drive(flat);
    expect(fired, trace.join(' | ')).toEqual([]);
  });

  it('POSITIVE CONTROL: an ANNOUNCED downsize still clears within a month', () => {
    // The exemption. A drop past the tolerance is red the night it happens, so
    // the operator SAW it; bounding its re-base would pin the lane red for
    // months over a downsizing nobody was ever unaware of. 1000 -> 400 on day 1,
    // then flat. Red while the mark stands, green once it re-bases.
    const seq: (readonly [number, number])[] = [[0, 1000], [1, 400]];
    for (let d = 2; d <= 60; d += 1) seq.push([d, 400] as const);
    const { fired, trace } = drive(seq);
    expect(fired.length, trace.slice(0, 3).join(' | ')).toBeGreaterThan(0);
    // Index 30 is day 31 — the first run past the decay window.
    const lastFired = fired[fired.length - 1];
    expect(lastFired, `still red at index ${lastFired}: ${trace[lastFired]}`).toBeLessThanOrEqual(
      31,
    );
  });

  it('the DECAY FLOOR is pinned ABSOLUTELY at 0.9, and is NOT the shrink tolerance', () => {
    // Pinned by value, not derived — the MAX_SUPPRESSION_DAYS lesson.
    expect(HIGH_WATER_DECAY_FLOOR).toBe(0.9);
    // AND it must not equal `1 - POPULATION_SHRINK_TOLERANCE`. The suggested
    // repair was `max(examined, prevMark * 0.8)`, which is a NO-OP against the
    // very sequence it was meant to fix: the erosion is calibrated just inside
    // the tolerance, so 0.81 x mark is above 0.80 x mark at every cycle and
    // `max` returns `examined` twelve times out of twelve. A future edit that
    // "simplifies" these two constants into one re-opens the ratchet.
    expect(HIGH_WATER_DECAY_FLOOR).not.toBe(1 - POPULATION_SHRINK_TOLERANCE);
    expect(HIGH_WATER_DECAY_FLOOR).toBeGreaterThan(1 - POPULATION_SHRINK_TOLERANCE);
  });

  it('DEMONSTRATION: the suggested `max(examined, mark * 0.8)` would not bind', () => {
    // Kept as an executable statement of why, so the argument does not have to
    // be re-derived. At a 19% step the observed value is ALWAYS above the 0.8
    // floor, so that formula never raises the mark above `examined`.
    let mark = 1000;
    let examined = 1000;
    for (let c = 1; c <= 12; c += 1) {
      examined = Math.round(examined * 0.81);
      expect(examined).toBeGreaterThanOrEqual(mark * (1 - POPULATION_SHRINK_TOLERANCE));
      mark = Math.max(examined, mark * (1 - POPULATION_SHRINK_TOLERANCE));
      expect(mark).toBe(examined); // the "max" is never the floor. It is a no-op.
    }
  });

  it('a downward re-base is REPORTED, not merely counted', () => {
    // It used to leave no trace at all: a new baseline and a number with no
    // history behind it.
    const { fired } = drive(decaySequence(0.19, 31, 12));
    expect(fired.length).toBeGreaterThan(0);

    const seq = decaySequence(0.19, 31, 4);
    let snapshots = snapshotPopulations(
      [{ detector: 'a', findings: [], population: { examined: seq[0][1], blind: false } }],
      { previous: null, at: at(seq[0][0]) },
    );
    let previous = priorRunAt(snapshots, at(seq[0][0]));
    let message = '';
    for (let i = 1; i < seq.length; i += 1) {
      const cur = snapshotPopulations(
        [{ detector: 'a', findings: [], population: { examined: seq[i][1], blind: false } }],
        { previous: snapshots, at: at(seq[i][0]) },
      );
      const r = detectPopulationRegression(previous, cur);
      if (r !== null) message = r.message;
      snapshots = cur;
      previous = priorRunAt(cur, at(seq[i][0]));
    }
    expect(message).toContain('re-based DOWNWARD');
    expect(message).toContain('time(s) in a row');
  });
});

describe('snapshotPopulations — THE BOUND ON THE RE-BASE', () => {
  const results = (examined: number, blind = false) => [
    { detector: 'a', findings: [] as unknown[], population: { examined, blind } },
  ];
  const OLD = at(0);
  const NOW = at(31);

  it('an UNANNOUNCED drop re-bases by at most the floor, not to today', () => {
    // prior.examined 810 -> 810 is no step at all, so nothing was ever reported.
    const s = snapshotPopulations(results(810), {
      previous: [p('a', 810, { blind: false, maxExamined: 1000, maxExaminedAt: OLD })],
      at: NOW,
    });
    expect(s[0].maxExamined).toBe(900); // floor(1000 * 0.9), NOT 810
    expect(s[0].decayRebases).toBe(1);
  });

  it('an ANNOUNCED drop re-bases all the way — the operator already saw it', () => {
    const s = snapshotPopulations(results(400), {
      previous: [
        p('a', 400, {
          blind: false,
          maxExamined: 1000,
          maxExaminedAt: OLD,
          reportedStepAt: at(1),
        }),
      ],
      at: NOW,
    });
    expect(s[0].maxExamined).toBe(400);
  });

  it('an announcement OLDER than the mark does not unlock the re-base', () => {
    // Otherwise one ancient reported step would exempt every future erosion.
    const s = snapshotPopulations(results(810), {
      previous: [
        p('a', 810, {
          blind: false,
          maxExamined: 1000,
          maxExaminedAt: at(10),
          reportedStepAt: at(2),
        }),
      ],
      at: at(45),
    });
    expect(s[0].maxExamined).toBe(900);
  });

  it('the re-base NEVER goes below the observed value', () => {
    // A mark under `examined` would make a growing population look like a
    // regression against its own high-water mark.
    const s = snapshotPopulations(results(950), {
      previous: [p('a', 950, { blind: false, maxExamined: 1000, maxExaminedAt: OLD })],
      at: NOW,
    });
    expect(s[0].maxExamined).toBe(950);
  });

  it('consecutive re-bases COUNT UP, and a new maximum resets the count', () => {
    let s = snapshotPopulations(results(810), {
      previous: [p('a', 810, { blind: false, maxExamined: 1000, maxExaminedAt: OLD })],
      at: NOW,
    });
    expect(s[0].decayRebases).toBe(1);
    s = snapshotPopulations(results(700), {
      previous: [{ ...s[0], examined: 700 }],
      at: at(70),
    });
    expect(s[0].decayRebases).toBe(2);
    s = snapshotPopulations(results(5000), { previous: [s[0]], at: at(71) });
    expect(s[0].decayRebases).toBe(0);
  });

  it('reportedStepAt is stamped by the SAME predicate the comparator reports on', () => {
    // Two copies of this predicate would drift, and the drift would hand the
    // erosion a free re-base (or pin an announced downsize red for months).
    expect(stepWasReported({ examined: 100, blind: false }, { examined: 79, blind: false })).toBe(
      true,
    );
    expect(stepWasReported({ examined: 100, blind: false }, { examined: 81, blind: false })).toBe(
      false,
    );
    expect(stepWasReported({ examined: 100, blind: false }, { examined: 0, blind: true })).toBe(
      true,
    );
    expect(stepWasReported({ examined: 0, blind: true }, { examined: 0, blind: true })).toBe(false);

    const s = snapshotPopulations(results(79), {
      previous: [p('a', 100, { blind: false })],
      at: NOW,
    });
    expect(s[0].reportedStepAt).toBe(NOW);
    const t = snapshotPopulations(results(81), {
      previous: [p('a', 100, { blind: false })],
      at: NOW,
    });
    expect(t[0].reportedStepAt).toBeNull();
  });

  it('tolerates a snapshot persisted before these fields existed', () => {
    // Reading an old document must not produce NaN counters or a crash.
    const legacy = {
      detector: 'a',
      examined: 810,
      blind: false,
      findings: 0,
      maxExamined: 1000,
      maxExaminedAt: OLD,
    } as unknown as DetectorPopulationSnapshot;
    const s = snapshotPopulations(results(810), { previous: [legacy], at: NOW });
    expect(s[0].maxExamined).toBe(900);
    expect(s[0].decayRebases).toBe(1);
    expect(s[0].reportedStepAt).toBeNull();
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
