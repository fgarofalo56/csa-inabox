/**
 * Self-tests for stranded-roll-decision.mjs (#4298).
 *
 * WHAT IS BEING PINNED. The claim this module makes is a NEGATIVE one — "no
 * build is coming" — and a wrong negative here either cries wolf on every merge
 * train (and gets switched off within a week) or stays silent while the estate
 * is frozen. Both failure directions get a control.
 *
 * Every control is chosen to DIE under an obvious mutation:
 *
 *   - treat a null run list as an empty one (the "I could not look" collapse)
 *     -> the unreadable control goes red, and a real outage would report benign.
 *   - drop the pending-status branch -> the merge-train control goes red, and
 *     the guard fails every normal merge train.
 *   - drop the already-succeeded branch -> the caught-up control goes red.
 *   - stop filtering on created_at (count ANY run, not just newer ones) -> the
 *     no-newer-run control goes red, because the older cancelled runs would
 *     rescue it.
 *   - make shouldFail() return false for 'unknown' -> the fail-closed control
 *     goes red.
 *   - judge a 'failure' successor from the run list alone (the #4300 review's
 *     R7 finding) -> the sibling-image control goes red: a producer run that
 *     failed on a sibling image but built loom-console DID roll (#3260), and
 *     calling that "the chain is broken" sends the operator to dispatch a build
 *     that already happened.
 *
 * The fixtures are shaped from the REAL 2026-09-02 incident (run ids, statuses
 * and the ordering are the measured ones), not invented, so a fixture that
 * agreed with the code would still have to agree with what happened.
 *
 * Run: node --test scripts/ci/__tests__/stranded-roll-decision.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideStranded, runsNeedingConsoleLookup, shouldFail } from '../stranded-roll-decision.mjs';

const SKIPPED_AT = '2026-09-02T04:02:23Z';

const run = (id, status, conclusion, created_at) => ({ id, status, conclusion, created_at });

// A producer run that concluded 'failure' with its loom-console job conclusions
// already read (the runner does that lookup; see runsNeedingConsoleLookup).
const failed = (id, created_at, console_conclusions) => ({
  ...run(id, 'completed', 'failure', created_at),
  ...(console_conclusions === undefined ? {} : { console_conclusions }),
});

// The measured estate at 04:04 on 2026-09-02, newest last.
const TRAIN = [
  run(33587826527, 'queued', null, '2026-09-02T03:38:54Z'),
  run(33587861926, 'completed', 'cancelled', '2026-09-02T03:39:29Z'),
  run(33589273868, 'completed', 'cancelled', SKIPPED_AT),
  run(33589400933, 'pending', null, '2026-09-02T04:04:25Z'),
];

// ---------------------------------------------------------------------------
// BENIGN — the merge train self-heals, and saying otherwise cries wolf
// ---------------------------------------------------------------------------

test('CONTROL: a cancelled build with a newer run still going is BENIGN', () => {
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: SKIPPED_AT,
    producerRuns: TRAIN,
  });
  assert.equal(d.verdict, 'benign');
  assert.equal(d.carrier.id, 33589400933);
  assert.match(d.why, /self-heals/);
  assert.equal(shouldFail(d.verdict), false);
});

test('CONTROL: a cancelled build whose successor already SUCCEEDED is BENIGN — the roll already fired', () => {
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: SKIPPED_AT,
    producerRuns: [
      ...TRAIN.slice(0, 3),
      run(33589400933, 'completed', 'success', '2026-09-02T04:04:25Z'),
    ],
  });
  assert.equal(d.verdict, 'benign');
  assert.equal(d.carrier.id, 33589400933);
  assert.match(d.why, /already SUCCEEDED/);
});

// ---------------------------------------------------------------------------
// A 'failure' SUCCESSOR IS NOT "NOTHING WAS PRODUCED" (#4300 review, R7)
//
// loom-roll-and-validate.yml's gate rolls the console when the producer run
// failed on a SIBLING image but the loom-console job succeeded (#3260,
// console_build=success, proceed=true). So a newer run that concluded
// 'failure' may well have rolled this work, and the run list alone cannot
// tell. The module must either see the loom-console conclusions and decide,
// or say it did not establish the answer — never assert "the chain is broken".
// ---------------------------------------------------------------------------

test('CONTROL (#4300): a newer FAILURE whose loom-console job SUCCEEDED is a carrier — its own roll fired (#3260)', () => {
  // The reviewer's concrete state: build A cancelled, build B concludes
  // 'failure' with loom-console green. B's own roll shipped the console.
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: SKIPPED_AT,
    producerRuns: [
      ...TRAIN.slice(0, 3),
      failed(33589500000, '2026-09-02T04:20:00Z', ['success']),
    ],
  });
  assert.equal(d.verdict, 'benign');
  assert.equal(d.carrier.id, 33589500000);
  assert.match(d.why, /loom-console/);
  assert.match(d.why, /#3260/);
  // It must NOT tell the operator to dispatch a build that already happened.
  assert.doesNotMatch(d.why, /chain is broken/);
  assert.equal(d.remediation, undefined);
  assert.equal(shouldFail(d.verdict), false);
});

test('#4300: a newer FAILURE whose loom-console outcome was NOT established is UNKNOWN — never stranded', () => {
  const shapes = [
    ['not looked up', undefined],
    ['lookup FAILED', null],
    ['no loom-console job reported', []],
  ];
  for (const [label, cc] of shapes) {
    const d = decideStranded({
      upstreamConclusion: 'cancelled',
      upstreamCreatedAt: SKIPPED_AT,
      producerRuns: [
        ...TRAIN.slice(0, 3),
        run(33589400933, 'completed', 'cancelled', '2026-09-02T04:04:25Z'),
        failed(33589500000, '2026-09-02T04:20:00Z', cc),
      ],
    });
    assert.equal(d.verdict, 'unknown', label);
    // It names the run whose roll gate holds the answer (R7: say what was not established).
    assert.match(d.why, /33589500000/, label);
    assert.match(d.why, /not established/i, label);
    assert.doesNotMatch(d.why, /chain is broken/, label);
    assert.doesNotMatch(d.why, /every newer producer run also ended/, label);
    assert.match(d.remediation, /33589500000/, label);
    assert.equal(shouldFail(d.verdict), true, label);
  }
});

test('#4300: a FAILURE whose loom-console job did NOT succeed fired no roll — that one IS established', () => {
  // The gate sets proceed=false on this (loom-roll-and-validate.yml:320-323),
  // so counting it toward "stranded" states only what was read.
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: SKIPPED_AT,
    producerRuns: [
      ...TRAIN.slice(0, 3),
      failed(33589500000, '2026-09-02T04:20:00Z', ['failure']),
    ],
  });
  assert.equal(d.verdict, 'stranded');
  assert.match(d.why, /33589500000:failure\(loom-console: failure\)/);
});

test('#4300: with SEVERAL loom-console jobs, every one must be success to carry', () => {
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: SKIPPED_AT,
    producerRuns: [
      ...TRAIN.slice(0, 3),
      failed(33589500000, '2026-09-02T04:20:00Z', ['success', 'cancelled']),
    ],
  });
  assert.equal(d.verdict, 'stranded');
  assert.match(d.why, /33589500000:failure\(loom-console: success,cancelled\)/);
});

test('#4300: loom-console conclusions on a CANCELLED run do not carry — the gate declines cancelled outright', () => {
  // A cancelled producer run skips every roll job whatever its matrix did, so
  // a green loom-console job inside it is an image with no roll — the estate
  // is exactly as stranded. Only a 'failure' run is judged by its jobs.
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: SKIPPED_AT,
    producerRuns: [
      ...TRAIN.slice(0, 3),
      { ...run(33589400933, 'completed', 'cancelled', '2026-09-02T04:04:25Z'), console_conclusions: ['success'] },
    ],
  });
  assert.equal(d.verdict, 'stranded');
  assert.equal(d.carrier, null);
});

test('#4300: a PENDING newer run still wins over an unresolved failure — the train is coming', () => {
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: SKIPPED_AT,
    producerRuns: [
      ...TRAIN.slice(0, 3),
      failed(33589500000, '2026-09-02T04:20:00Z', undefined),
      run(33589600000, 'in_progress', null, '2026-09-02T04:30:00Z'),
    ],
  });
  assert.equal(d.verdict, 'benign');
  assert.equal(d.carrier.id, 33589600000);
});

test('#4300: runsNeedingConsoleLookup names exactly the NEWER failure runs — the set the runner must read', () => {
  const runs = [
    run(1, 'completed', 'failure', '2026-09-02T03:00:00Z'), // older: cannot carry, not looked up
    run(2, 'completed', 'cancelled', '2026-09-02T04:10:00Z'), // newer but not a failure
    run(3, 'completed', 'failure', '2026-09-02T04:20:00Z'),
    run(4, 'completed', 'failure', '2026-09-02T04:30:00Z'),
  ];
  assert.deepEqual(
    runsNeedingConsoleLookup({ upstreamCreatedAt: SKIPPED_AT, producerRuns: runs }).map((r) => r.id),
    [3, 4],
  );
  // The same predicate decideStranded uses: an unreadable list or timestamp
  // means nothing to look up, and decideStranded says 'unknown' on its own.
  assert.deepEqual(runsNeedingConsoleLookup({ upstreamCreatedAt: SKIPPED_AT, producerRuns: null }), []);
  assert.deepEqual(runsNeedingConsoleLookup({ upstreamCreatedAt: 'not-a-date', producerRuns: runs }), []);
});

// ---------------------------------------------------------------------------
// STRANDED — the tail case, which is the one that actually bit
// ---------------------------------------------------------------------------

test('THE #4298 TAIL: cancelled with NO newer run at all is STRANDED', () => {
  // The docs-only-merge shape: the commit that cancelled this build does not
  // match the producer's `paths:` filter, so nothing was ever queued. Measured
  // on 2026-09-02 — #4296 was that merge.
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: SKIPPED_AT,
    producerRuns: TRAIN.filter((r) => Date.parse(r.created_at) <= Date.parse(SKIPPED_AT)),
  });
  assert.equal(d.verdict, 'stranded');
  assert.equal(d.carrier, null);
  assert.match(d.why, /NO newer producer run exists/);
  assert.match(d.remediation, /gh workflow run build-fiab-images-acr-tasks\.yml/);
  assert.equal(shouldFail(d.verdict), true);
});

test('newer runs that ALSO fired no roll do not rescue it — the chain is broken, not delayed', () => {
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: SKIPPED_AT,
    producerRuns: [
      ...TRAIN.slice(0, 3),
      run(33589400933, 'completed', 'cancelled', '2026-09-02T04:04:25Z'),
      // Its loom-console conclusions were READ and were not success, so the
      // gate declined it (#4300 review: a bare 'failure' would be UNKNOWN).
      failed(33589500000, '2026-09-02T04:20:00Z', ['failure']),
    ],
  });
  assert.equal(d.verdict, 'stranded');
  assert.match(d.why, /every newer producer run also ended/);
  // The receipt NAMES them rather than asserting a bare negative (R7).
  assert.match(d.why, /33589400933:cancelled/);
  assert.match(d.why, /33589500000:failure\(loom-console: failure\)/);
});

test('an OLDER run in any state cannot rescue it — only newer runs carry this work', () => {
  // Without the created_at filter the queued 03:38 run would read as "a build
  // is coming", and it is not: it predates the commit that was skipped.
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: SKIPPED_AT,
    producerRuns: [run(33587826527, 'queued', null, '2026-09-02T03:38:54Z')],
  });
  assert.equal(d.verdict, 'stranded');
});

// ---------------------------------------------------------------------------
// FAIL CLOSED — "I could not look" is never "there is nothing there"
// ---------------------------------------------------------------------------

test('CONTROL: an UNREADABLE producer list is UNKNOWN and still fails — not benign, not stranded', () => {
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: SKIPPED_AT,
    producerRuns: null,
  });
  assert.equal(d.verdict, 'unknown');
  assert.match(d.why, /could not be READ/);
  assert.match(d.why, /not established/i);
  // It must NOT claim the negative it did not observe.
  assert.doesNotMatch(d.why, /no newer producer run exists/);
  assert.equal(shouldFail(d.verdict), true);
});

test('an EMPTY list is a real observation and is NOT the same as an unreadable one', () => {
  // The pair that makes the control above mean something: [] genuinely says
  // "there are none", null says "I could not ask". Same verdict class here
  // (both fail), but they must not produce the same MESSAGE, or the operator
  // is sent to the wrong place.
  const empty = decideStranded({ upstreamConclusion: 'cancelled', upstreamCreatedAt: SKIPPED_AT, producerRuns: [] });
  const unread = decideStranded({ upstreamConclusion: 'cancelled', upstreamCreatedAt: SKIPPED_AT, producerRuns: null });
  assert.equal(empty.verdict, 'stranded');
  assert.equal(unread.verdict, 'unknown');
  assert.notEqual(empty.why, unread.why);
});

test('an unparseable timestamp is UNKNOWN, never silently "nothing is newer"', () => {
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: 'not-a-date',
    producerRuns: TRAIN,
  });
  assert.equal(d.verdict, 'unknown');
  assert.match(d.why, /could not be parsed/);
});

// ---------------------------------------------------------------------------
// SCOPE — this module is not the roll gate
// ---------------------------------------------------------------------------

test('success and failure are handed back as benign — the gate owns those, not this', () => {
  for (const c of ['success', 'failure']) {
    const d = decideStranded({ upstreamConclusion: c, upstreamCreatedAt: SKIPPED_AT, producerRuns: [] });
    assert.equal(d.verdict, 'benign', `${c} must not be judged here`);
    assert.match(d.why, /roll gate handles/);
  }
});

test('a skipped upstream is treated exactly like a cancelled one', () => {
  // GitHub reports `skipped` when the producer itself was gated out. The estate
  // is just as un-rolled either way, so the verdict must not depend on which
  // non-success word arrived.
  const cancelled = decideStranded({ upstreamConclusion: 'cancelled', upstreamCreatedAt: SKIPPED_AT, producerRuns: [] });
  const skipped = decideStranded({ upstreamConclusion: 'skipped', upstreamCreatedAt: SKIPPED_AT, producerRuns: [] });
  assert.equal(cancelled.verdict, skipped.verdict);
  assert.equal(skipped.verdict, 'stranded');
});
