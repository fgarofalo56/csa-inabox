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
 *
 * The fixtures are shaped from the REAL 2026-09-02 incident (run ids, statuses
 * and the ordering are the measured ones), not invented, so a fixture that
 * agreed with the code would still have to agree with what happened.
 *
 * Run: node --test scripts/ci/__tests__/stranded-roll-decision.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideStranded, shouldFail } from '../stranded-roll-decision.mjs';

const SKIPPED_AT = '2026-09-02T04:02:23Z';

const run = (id, status, conclusion, created_at) => ({ id, status, conclusion, created_at });

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

test('newer runs that ALSO produced nothing do not rescue it — the chain is broken, not delayed', () => {
  const d = decideStranded({
    upstreamConclusion: 'cancelled',
    upstreamCreatedAt: SKIPPED_AT,
    producerRuns: [
      ...TRAIN.slice(0, 3),
      run(33589400933, 'completed', 'cancelled', '2026-09-02T04:04:25Z'),
      run(33589500000, 'completed', 'failure', '2026-09-02T04:20:00Z'),
    ],
  });
  assert.equal(d.verdict, 'stranded');
  assert.match(d.why, /every newer producer run also ended without/);
  // The receipt NAMES them rather than asserting a bare negative (R7).
  assert.match(d.why, /33589400933:cancelled/);
  assert.match(d.why, /33589500000:failure/);
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
