/**
 * LOOM BRAIN W10 — the FINDING LIFECYCLE (#3936).
 *
 * #3936 acceptance, two of the five:
 *   • "A fixed-then-recurring finding is reported as a REGRESSION, proven by a
 *      fixture."
 *   • "An expired suppression re-surfaces its finding, proven by a fixture."
 *
 * ── THE CONTROLS ───────────────────────────────────────────────────────────
 * Asserting "the regression appears in digest.regressions" is satisfied by a
 * reconciler that puts EVERY recurrence there. So each regression assertion is
 * paired with a control that must NOT be a regression:
 *
 *   a finding seen for the first time      -> `new`, never `regressed`
 *   a finding open since the last run      -> neither `new` nor `regressed`
 *   a finding whose suppression lapsed     -> re-surfaced, but NOT a regression
 *                                             (it was never fixed)
 *
 * Without those, deleting the `prior.state === 'fixed'` guard would not move a
 * single assertion.
 */

import { describe, expect, it } from 'vitest';
import {
  acceptFinding,
  acknowledgeFinding,
  assertNoRegressionReportedAsNew,
  assertRecurrenceAfterFixIsReported,
  reconcile,
  suppressionExpired,
  toOccurrences,
} from '../lifecycle';
import {
  MAX_SUPPRESSION_DAYS,
  type FindingFingerprint,
  type FindingRecord,
  type RunDigest,
} from '../model';
import { ESTATE, finding, record } from './fixtures';

const T0 = '2026-08-01T00:00:00.000Z';
const T1 = '2026-08-24T04:11:00.000Z';

/** An empty digest, for testing the guard in isolation from `reconcile`. */
function emptyDigest(): RunDigest {
  return {
    runId: 'run-1',
    estateId: ESTATE,
    at: T1,
    newFindings: [],
    regressions: [],
    fixed: [],
    suppressionsExpired: [],
    stillOpen: 0,
    suppressed: 0,
    notEvaluated: [],
    evaluatedDetectors: [],
    notes: [],
  };
}

const ALL = new Set(['unreachable-service', 'dangling-wire']);

function run(args: {
  previous?: readonly FindingRecord[];
  findings?: readonly ReturnType<typeof finding>[];
  evaluated?: ReadonlySet<string>;
  blind?: ReadonlyMap<string, string>;
  at?: string;
  runId?: string;
}) {
  return reconcile({
    estateId: ESTATE,
    runId: args.runId ?? 'run-1',
    at: args.at ?? T1,
    previous: args.previous ?? [],
    occurrences: toOccurrences(args.findings ?? []),
    evaluatedDetectors: args.evaluated ?? ALL,
    ...(args.blind ? { blindDetectors: args.blind } : {}),
  });
}

describe('lifecycle — first sighting', () => {
  it('a finding with no prior record is `new` and carries regressionCount 0', () => {
    const { records, digest } = run({
      findings: [finding({ detector: 'unreachable-service', subject: '/broker' })],
    });
    expect(records).toHaveLength(1);
    expect(records[0].state).toBe('new');
    expect(records[0].regressionCount).toBe(0);
    expect(digest.newFindings).toHaveLength(1);
    expect(digest.regressions).toHaveLength(0);
  });

  it('CONTROL: a finding open since the last run is neither new nor a regression', () => {
    const prior = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'new',
      runId: 'run-0',
    });
    const { records, digest } = run({
      previous: [prior],
      findings: [finding({ detector: 'unreachable-service', subject: '/broker' })],
    });
    expect(records[0].state).toBe('new');
    expect(digest.newFindings).toHaveLength(0);
    expect(digest.regressions).toHaveLength(0);
    expect(digest.stillOpen).toBe(1);
    // firstSeen is preserved — the age of a finding is not reset by seeing it.
    expect(records[0].firstSeenRunId).toBe('run-0');
    expect(records[0].lastSeenRunId).toBe('run-1');
  });
});

describe('lifecycle — THE REGRESSION', () => {
  it('a fixed finding that recurs is REGRESSED, not new', () => {
    const prior = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'fixed',
      fixedAt: T0,
      fixedByRunId: 'run-0',
    });
    const { records, digest } = run({
      previous: [prior],
      findings: [finding({ detector: 'unreachable-service', subject: '/broker' })],
    });

    expect(records[0].state).toBe('regressed');
    expect(digest.regressions).toHaveLength(1);
    // The control: it is NOT in the new list. Both halves matter — a reconciler
    // that put it in BOTH would still be lying about what happened.
    expect(digest.newFindings).toHaveLength(0);

    const r = digest.regressions[0];
    expect(r.priorState).toBe('fixed');
    expect(r.fixedAt).toBe(T0);
    expect(r.fixedByRunId).toBe('run-0');
    expect(r.regressedAt).toBe(T1);
    expect(r.regressedByRunId).toBe('run-1');
    expect(r.regressionCount).toBe(1);
  });

  it('a second regression increments the count rather than resetting it', () => {
    const prior = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'fixed',
      fixedAt: T0,
      fixedByRunId: 'run-5',
      regressionCount: 2,
    });
    const { digest } = run({
      previous: [prior],
      findings: [finding({ detector: 'unreachable-service', subject: '/broker' })],
    });
    expect(digest.regressions[0].regressionCount).toBe(3);
  });

  it('a regression already open is NOT re-announced (the digest reports transitions)', () => {
    const prior = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'regressed',
      regressionCount: 1,
      runId: 'run-0',
    });
    const { records, digest } = run({
      previous: [prior],
      findings: [finding({ detector: 'unreachable-service', subject: '/broker' })],
    });
    expect(records[0].state).toBe('regressed');
    expect(digest.regressions).toHaveLength(0);
    expect(digest.stillOpen).toBe(1);
  });

  it('the runtime guard rejects a `new` record that has a prior — even a hand-built one', () => {
    const fp = 'unreachable-service#/broker' as FindingFingerprint;
    const prior = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'fixed',
    });
    const forged = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'new',
    });
    expect(() =>
      assertNoRegressionReportedAsNew([forged], new Map([[fp, prior]])),
    ).toThrow(/REGRESSION being reported as a new finding/);
  });

  it('the runtime guard also rejects resetting an ACKNOWLEDGED record to new', () => {
    const fp = 'unreachable-service#/broker' as FindingFingerprint;
    const prior = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'acknowledged',
    });
    const forged = record({ detector: 'unreachable-service', subject: '/broker', state: 'new' });
    expect(() => assertNoRegressionReportedAsNew([forged], new Map([[fp, prior]]))).toThrow(
      /A finding with a history is never/,
    );
  });

  it('CONTROL: the guard permits new -> new, the one legal carry-forward', () => {
    const fp = 'unreachable-service#/broker' as FindingFingerprint;
    const prior = record({ detector: 'unreachable-service', subject: '/broker', state: 'new' });
    const carried = record({ detector: 'unreachable-service', subject: '/broker', state: 'new' });
    expect(() => assertNoRegressionReportedAsNew([carried], new Map([[fp, prior]]))).not.toThrow();
  });
});

/**
 * G3 — the guard asserts the TRANSITION, not the destination state.
 *
 * The state-only guard defended exactly one laundering route. The reviewer found
 * another in one try: route a recurrence to `acknowledged`, scope it to a
 * detector no test exercises, and the whole suite stayed green — the guard never
 * fired (it only inspected `new` records), the digest counted it under
 * `stillOpen` ("unchanged, not listed"), and nothing printed. The BROAD form of
 * the same edit WAS caught, which is the narrow-bypass shape this repo measures
 * as the one that actually works.
 *
 * That escape also broke the argument used to justify the declared blind spot in
 * `mutation/mutations.mjs`: "the runtime guard exists in addition to the tests"
 * only holds if the runtime guard covers more than one route.
 */
describe('lifecycle — a recurrence after a fix is reported, WHATEVER state it is written as', () => {
  const prior = () =>
    record({
      detector: 'config-drift',
      subject: '/x',
      state: 'fixed',
      fixedAt: T0,
      fixedByRunId: 'run-0',
    });

  it('the normal path satisfies the guard', () => {
    const { digest } = run({
      previous: [prior()],
      findings: [finding({ detector: 'config-drift', subject: '/x' })],
      evaluated: new Set(['config-drift']),
    });
    expect(digest.regressions).toHaveLength(1);
  });

  it('THROWS when a recurrence is laundered to `acknowledged`', () => {
    // Constructed directly, because `reconcile` no longer has a route that
    // produces it — which is exactly the point. The guard must reject the shape
    // whatever produced it, so a future edit that reintroduces the route fails
    // at runtime and not merely in review.
    const fp = 'config-drift#/x' as FindingFingerprint;
    const laundered = record({ detector: 'config-drift', subject: '/x', state: 'acknowledged' });
    expect(() =>
      assertRecurrenceAfterFixIsReported({
        occurrences: toOccurrences([finding({ detector: 'config-drift', subject: '/x' })]),
        priorByFingerprint: new Map([[fp, prior()]]),
        records: [laundered],
        digest: emptyDigest(),
      }),
    ).toThrow(/was FIXED at .* and the detectors reported it again/);
  });

  it('THROWS when a recurrence is laundered to `accepted`', () => {
    const fp = 'config-drift#/x' as FindingFingerprint;
    const buried = record({ detector: 'config-drift', subject: '/x', state: 'accepted' });
    expect(() =>
      assertRecurrenceAfterFixIsReported({
        occurrences: toOccurrences([finding({ detector: 'config-drift', subject: '/x' })]),
        priorByFingerprint: new Map([[fp, prior()]]),
        records: [buried],
        digest: emptyDigest(),
      }),
    ).toThrow(/buries it in the still-open count/);
  });

  it('THROWS when the record says `regressed` but the DIGEST omits it', () => {
    // Both halves matter. A record nobody prints is a signal nobody sees.
    const fp = 'config-drift#/x' as FindingFingerprint;
    const regressed = record({
      detector: 'config-drift',
      subject: '/x',
      state: 'regressed',
      regressionCount: 1,
    });
    expect(() =>
      assertRecurrenceAfterFixIsReported({
        occurrences: toOccurrences([finding({ detector: 'config-drift', subject: '/x' })]),
        priorByFingerprint: new Map([[fp, prior()]]),
        records: [regressed],
        digest: emptyDigest(),
      }),
    ).toThrow(/is NOT in the run digest/);
  });

  it('CONTROL: a finding with NO prior fixed record is not subject to the guard', () => {
    expect(() =>
      assertRecurrenceAfterFixIsReported({
        occurrences: toOccurrences([finding({ detector: 'config-drift', subject: '/x' })]),
        priorByFingerprint: new Map(),
        records: [record({ detector: 'config-drift', subject: '/x', state: 'new' })],
        digest: emptyDigest(),
      }),
    ).not.toThrow();
  });

  it('CONTROL: a fixed record that did NOT recur is not subject to the guard', () => {
    const fp = 'config-drift#/x' as FindingFingerprint;
    expect(() =>
      assertRecurrenceAfterFixIsReported({
        occurrences: [],
        priorByFingerprint: new Map([[fp, prior()]]),
        records: [prior()],
        digest: emptyDigest(),
      }),
    ).not.toThrow();
  });

  it('a schema-mismatched prior is exempt — reconcile reports it as notEvaluated', () => {
    const fp = 'config-drift#/x' as FindingFingerprint;
    const old = { ...prior(), schemaVersion: 0 } as FindingRecord;
    expect(() =>
      assertRecurrenceAfterFixIsReported({
        occurrences: toOccurrences([finding({ detector: 'config-drift', subject: '/x' })]),
        priorByFingerprint: new Map([[fp, old]]),
        records: [old],
        digest: emptyDigest(),
      }),
    ).not.toThrow();
  });

  it('the guard is wired INTO reconcile, not merely exported', () => {
    // A guard nothing calls is a comment. `reconcile` runs it on every pass.
    const { digest, records } = run({
      previous: [prior()],
      findings: [finding({ detector: 'config-drift', subject: '/x' })],
      evaluated: new Set(['config-drift']),
    });
    expect(records[0].state).toBe('regressed');
    expect(digest.regressions.map((r) => r.fingerprint)).toContain('config-drift#/x');
  });
});

describe('lifecycle — fixed, and ABSENCE IS NOT A FIX', () => {
  it('a finding the detector no longer reports is FIXED', () => {
    const prior = record({ detector: 'unreachable-service', subject: '/broker', state: 'new' });
    const { records, digest } = run({ previous: [prior], findings: [] });
    expect(records[0].state).toBe('fixed');
    if (records[0].state !== 'fixed') throw new Error('unreachable');
    expect(records[0].fixedAt).toBe(T1);
    expect(records[0].fixedByRunId).toBe('run-1');
    expect(digest.fixed).toHaveLength(1);
  });

  it('P-BLIND: a BLIND detector cannot mark its backlog fixed', () => {
    const prior = record({ detector: 'unreachable-service', subject: '/broker', state: 'new' });
    const { records, digest } = run({
      previous: [prior],
      findings: [],
      evaluated: new Set(['dangling-wire']),
      blind: new Map([['unreachable-service', 'over an EMPTY population']]),
    });
    expect(records[0].state).toBe('new');
    expect(digest.fixed).toHaveLength(0);
    expect(digest.notEvaluated).toHaveLength(1);
    expect(digest.notEvaluated[0].reason).toContain('BLIND');
    expect(digest.notEvaluated[0].reason).toContain('not evidence of repair');
  });

  it('P-BLIND: a detector that stopped running entirely cannot mark its backlog fixed', () => {
    const prior = record({ detector: 'unreachable-service', subject: '/broker', state: 'new' });
    const { records, digest } = run({
      previous: [prior],
      findings: [],
      evaluated: new Set(['dangling-wire']),
    });
    expect(records[0].state).toBe('new');
    expect(digest.fixed).toHaveLength(0);
    expect(digest.notEvaluated[0].reason).toContain('did not run');
  });

  it('a record on an older schema is left untouched, never marked fixed', () => {
    const prior = {
      ...record({ detector: 'unreachable-service', subject: '/broker', state: 'new' }),
      schemaVersion: 0,
    } as FindingRecord;
    const { records, digest } = run({ previous: [prior], findings: [] });
    expect(records[0].state).toBe('new');
    expect(digest.fixed).toHaveLength(0);
    expect(digest.notEvaluated[0].reason).toContain('schemaVersion 0');
  });

  it('a record on an older schema that RECURS is left untouched rather than re-minted as new', () => {
    const prior = {
      ...record({ detector: 'unreachable-service', subject: '/broker', state: 'fixed' }),
      schemaVersion: 0,
    } as FindingRecord;
    const { records, digest } = run({
      previous: [prior],
      findings: [finding({ detector: 'unreachable-service', subject: '/broker' })],
    });
    expect(records[0].state).toBe('fixed');
    expect(digest.newFindings).toHaveLength(0);
    expect(digest.regressions).toHaveLength(0);
    expect(digest.notEvaluated).toHaveLength(1);
  });
});

describe('lifecycle — acceptance requires a reason AND an owner', () => {
  const base = record({ detector: 'unreachable-service', subject: '/broker', state: 'new' });

  it('accepts with a reason, an owner and an expiry', () => {
    const a = acceptFinding(base, {
      reason: 'the broker is being retired in Q4',
      owner: 'platform-team',
      at: T0,
      expiresAt: '2026-10-01T00:00:00.000Z',
    });
    expect(a.state).toBe('accepted');
    expect(a.suppression.reason).toBe('the broker is being retired in Q4');
    expect(a.suppression.owner).toBe('platform-team');
    expect(a.suppression.expiresAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('REJECTS an empty reason', () => {
    expect(() =>
      acceptFinding(base, { reason: '   ', owner: 'x', at: T0, expiresAt: '2026-10-01T00:00:00.000Z' }),
    ).toThrow(/EMPTY reason/);
  });

  it('REJECTS a missing owner', () => {
    expect(() =>
      acceptFinding(base, { reason: 'r', owner: '', at: T0, expiresAt: '2026-10-01T00:00:00.000Z' }),
    ).toThrow(/no OWNER/);
  });

  it('REJECTS an expiry that is not in the future', () => {
    expect(() =>
      acceptFinding(base, { reason: 'r', owner: 'o', at: T0, expiresAt: T0 }),
    ).toThrow(/already expired at creation/);
  });

  it('REJECTS a suppression longer than the ceiling', () => {
    // ABSOLUTE DATES, not `MAX_SUPPRESSION_DAYS + 1` (review of #4014, G6).
    //
    // The original fixture was built FROM the constant, so the guard moved with
    // the code it guarded: widening `MAX_SUPPRESSION_DAYS` from 180 to 3,650,000
    // in ONE TOKEN changed nothing and the whole 116-test suite stayed green.
    // That is the direct answer to "can you make a suppression that never
    // expires?" — and it was yes.
    //
    // T0 is 2026-08-01; this is 2027-08-01, i.e. 365 days.
    expect(() =>
      acceptFinding(base, {
        reason: 'r',
        owner: 'o',
        at: T0,
        expiresAt: '2027-08-01T00:00:00.000Z',
      }),
    ).toThrow(/deleted detector wearing a reason/);
  });

  it('the ceiling is pinned ABSOLUTELY at 180 days', () => {
    // Widening the constant must fail HERE, loudly, rather than silently
    // relaxing every fixture derived from it.
    expect(MAX_SUPPRESSION_DAYS).toBe(180);
  });

  it('CONTROL: an absolute expiry just INSIDE the ceiling is accepted', () => {
    // Without this, a ceiling of zero would pass the rejection test above and
    // the pair would prove nothing about where the boundary actually is.
    // T0 + 179 days = 2027-01-27.
    expect(() =>
      acceptFinding(base, {
        reason: 'r',
        owner: 'o',
        at: T0,
        expiresAt: '2027-01-27T00:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('CONTROL: an absolute expiry just OUTSIDE the ceiling is rejected', () => {
    // T0 + 181 days = 2027-01-29.
    expect(() =>
      acceptFinding(base, {
        reason: 'r',
        owner: 'o',
        at: T0,
        expiresAt: '2027-01-29T00:00:00.000Z',
      }),
    ).toThrow(/deleted detector wearing a reason/);
  });

  it('carries regressionCount through acceptance — accepting does not erase history', () => {
    const regressed = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'regressed',
      regressionCount: 2,
    });
    const a = acceptFinding(regressed, {
      reason: 'r',
      owner: 'o',
      at: T0,
      expiresAt: '2026-10-01T00:00:00.000Z',
    });
    expect(a.regressionCount).toBe(2);
    // and the regression fields are dropped, so the record is a clean `accepted`
    expect((a as unknown as Record<string, unknown>).priorState).toBeUndefined();
    expect((a as unknown as Record<string, unknown>).regressedAt).toBeUndefined();
  });

  it('acknowledge requires a principal', () => {
    expect(() => acknowledgeFinding(base, { by: ' ', at: T0 })).toThrow(/no principal/);
    expect(acknowledgeFinding(base, { by: 'me', at: T0 }).acknowledgedBy).toBe('me');
  });
});

describe('lifecycle — SUPPRESSIONS EXPIRE', () => {
  const suppression = {
    reason: 'deferred to the Q4 retirement',
    owner: 'platform-team',
    acceptedAt: T0,
    expiresAt: '2026-08-10T00:00:00.000Z',
  };

  it('a live suppression keeps the finding suppressed and out of the listed sections', () => {
    const prior = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'accepted',
      suppression: { ...suppression, expiresAt: '2026-12-31T00:00:00.000Z' },
    });
    const { records, digest } = run({
      previous: [prior],
      findings: [finding({ detector: 'unreachable-service', subject: '/broker' })],
    });
    expect(records[0].state).toBe('accepted');
    expect(digest.suppressed).toBe(1);
    expect(digest.suppressionsExpired).toHaveLength(0);
    expect(digest.newFindings).toHaveLength(0);
  });

  it('AN EXPIRED SUPPRESSION RE-SURFACES ITS FINDING', () => {
    const prior = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'accepted',
      suppression,
    });
    const { records, digest } = run({
      previous: [prior],
      findings: [finding({ detector: 'unreachable-service', subject: '/broker' })],
    });

    expect(records[0].state).toBe('acknowledged');
    expect(digest.suppressionsExpired).toHaveLength(1);
    expect(digest.suppressed).toBe(0);

    const r = records[0];
    if (r.state !== 'acknowledged') throw new Error('unreachable');
    expect(r.resurfacedFromSuppressionAt).toBe(T1);
    // The owner of the lapsed decision is carried forward — there is someone to ask.
    expect(r.acknowledgedBy).toBe('platform-team');
    expect(digest.notes.join('\n')).toContain('expired at 2026-08-10');
    expect(digest.notes.join('\n')).toContain('platform-team');
  });

  it('CONTROL: a re-surfaced suppression is NOT reported as a regression', () => {
    // It was never fixed, so it is not a recurrence-after-repair. Collapsing the
    // two would make "regression" mean "anything that came back", which is
    // exactly the dilution that makes the signal worthless.
    const prior = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'accepted',
      suppression,
    });
    const { digest } = run({
      previous: [prior],
      findings: [finding({ detector: 'unreachable-service', subject: '/broker' })],
    });
    expect(digest.regressions).toHaveLength(0);
    expect(digest.newFindings).toHaveLength(0);
  });

  it('an accepted finding that is GONE is fixed — a suppression governs reporting, not existence', () => {
    const prior = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'accepted',
      suppression: { ...suppression, expiresAt: '2026-12-31T00:00:00.000Z' },
    });
    const { records, digest } = run({ previous: [prior], findings: [] });
    expect(records[0].state).toBe('fixed');
    expect(digest.fixed).toHaveLength(1);
  });

  it('suppressionExpired is inclusive at the boundary', () => {
    expect(suppressionExpired(suppression, '2026-08-09T23:59:59.999Z')).toBe(false);
    expect(suppressionExpired(suppression, '2026-08-10T00:00:00.000Z')).toBe(true);
  });
});

describe('lifecycle — identity', () => {
  it('rejects two findings in one run that share a fingerprint', () => {
    expect(() =>
      toOccurrences([
        finding({ detector: 'unreachable-service', subject: '/broker' }),
        finding({ detector: 'unreachable-service', subject: '/broker', title: 'different text' }),
      ]),
    ).toThrow(/share the fingerprint/);
  });

  it('rejects two stored records that share a fingerprint', () => {
    const a = record({ detector: 'unreachable-service', subject: '/broker', state: 'new' });
    expect(() => run({ previous: [a, a], findings: [] })).toThrow(/two records with fingerprint/);
  });

  it('a re-worded finding keeps its identity, so its repair history survives', () => {
    // The fingerprint is the detector's deterministic id, NOT a hash of the
    // rendered text. Hashing the text would mint a new identity on every copy
    // edit and turn the next occurrence of a fixed finding into a `new` one.
    const prior = record({
      detector: 'unreachable-service',
      subject: '/broker',
      state: 'fixed',
      fixedAt: T0,
    });
    const { digest } = run({
      previous: [prior],
      findings: [
        finding({
          detector: 'unreachable-service',
          subject: '/broker',
          title: 'COMPLETELY DIFFERENT TITLE',
        }),
      ],
    });
    expect(digest.regressions).toHaveLength(1);
    expect(digest.newFindings).toHaveLength(0);
  });
});
