/**
 * Roll-gate decision tests (#2819).
 *
 * The gate has to keep THREE states apart — verified / contradicted / unknown —
 * and the bug in both halves of #2819 was collapsing the third into one of the
 * first two. These tests pin each state independently, so widening any branch
 * to "pass more often" turns one of them red.
 *
 * MUTATION-PROVEN: see the PR body. Making the gate wrongly permissive (treat a
 * running check as a pass; treat an unreachable registry as absent) turns
 * specific tests here RED, and the CONTROL tests below stay green either way —
 * so an over-broad "fix" that just widens the pass branch cannot hide.
 *
 * Run: node --test scripts/ci/__tests__/roll-gate-decision.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyVitestGate,
  classifyAcrProbeError,
  resolveImageTag,
  VITEST_CHECK_NAME,
} from '../roll-gate-decision.mjs';

const check = (over = {}) => ({
  name: VITEST_CHECK_NAME,
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-08-02T11:05:25Z',
  ...over,
});
const doneRun = { status: 'completed', conclusion: 'success' };

// ---------------------------------------------------------------------------
// STATE 1 — the check exists and passed → proceed
// ---------------------------------------------------------------------------
test('passes when the check concluded success', () => {
  const r = classifyVitestGate({ checkRuns: [check()], ciRuns: [doneRun] });
  assert.equal(r.decision, 'pass');
});

test('uses the LATEST attempt, not the first (re-runs)', () => {
  const r = classifyVitestGate({
    checkRuns: [
      check({ conclusion: 'failure', started_at: '2026-08-02T10:00:00Z' }),
      check({ conclusion: 'success', started_at: '2026-08-02T11:00:00Z' }),
    ],
    ciRuns: [doneRun],
  });
  assert.equal(r.decision, 'pass');
});

test('a re-run that FAILED after an earlier pass is refused', () => {
  const r = classifyVitestGate({
    checkRuns: [
      check({ conclusion: 'success', started_at: '2026-08-02T10:00:00Z' }),
      check({ conclusion: 'failure', started_at: '2026-08-02T11:00:00Z' }),
    ],
    ciRuns: [doneRun],
  });
  assert.equal(r.decision, 'refuse');
});

// ---------------------------------------------------------------------------
// STATE 2 — the check exists and failed → refuse
// ---------------------------------------------------------------------------
for (const conclusion of ['failure', 'timed_out', 'action_required', 'stale', 'neutral', null]) {
  test(`refuses a check that concluded '${conclusion}'`, () => {
    const r = classifyVitestGate({ checkRuns: [check({ conclusion })], ciRuns: [doneRun] });
    assert.equal(r.decision, 'refuse');
  });
}

test("refuses 'skipped' — a job that did not run is not a verified job", () => {
  // If this ever becomes a pass, the gate is a no-op for every path-filtered
  // commit thereafter. fiab-console-ci reports the check GREEN instead of
  // skipping it, so 'skipped' means that contract changed.
  const r = classifyVitestGate({ checkRuns: [check({ conclusion: 'skipped' })], ciRuns: [doneRun] });
  assert.equal(r.decision, 'refuse');
  assert.match(r.reason, /did not run/);
});

// ---------------------------------------------------------------------------
// STATE 3 — the verdict is not in yet → WAIT (never "not found", never a pass)
// This is the #2819 deadlock.
// ---------------------------------------------------------------------------
for (const status of ['queued', 'in_progress', 'pending', 'waiting']) {
  test(`waits when the check is ${status} (conclusion is null, not absent)`, () => {
    const r = classifyVitestGate({
      checkRuns: [check({ status, conclusion: null })],
      ciRuns: [{ status: 'in_progress', conclusion: null }],
    });
    assert.equal(r.decision, 'wait');
  });
}

test('regression #2819: build finished before vitest — waits, does not refuse', () => {
  // The measured live shape on 5d51f961: image build done 11:23:11Z, roll read
  // the gate at 11:23:30Z, vitest ran 11:05:25Z → 11:33:32Z and PASSED.
  const r = classifyVitestGate({
    checkRuns: [check({ status: 'in_progress', conclusion: null })],
    ciRuns: [{ status: 'in_progress', conclusion: null }],
  });
  assert.equal(r.decision, 'wait');
  assert.notEqual(r.decision, 'refuse');
});

test('the message NAMES the observed state — never "not found" for a running check', () => {
  // The misleading text is what caused #2819 to be misdiagnosed as a
  // path-filter problem: the gate said "No check-run found" about a check that
  // existed and was running. Whatever else changes, the reason must describe
  // what was actually seen.
  for (const status of ['queued', 'in_progress']) {
    const r = classifyVitestGate({
      checkRuns: [check({ status, conclusion: null })],
      ciRuns: [{ status: 'in_progress', conclusion: null }],
    });
    assert.match(r.reason, new RegExp(status), `reason should name '${status}'`);
    assert.doesNotMatch(r.reason, /no .*check-run found/i);
    assert.doesNotMatch(r.reason, /not found/i);
  }
});

test('LIVE RECEIPT f322c14a: in_progress at the moment the old gate refused it', () => {
  // Old gate, run 30754930572 at 15:42:08Z:
  //   conclusion=<none> → "No 'vitest (node 20)' check-run found … refusing"
  // Verified directly against the API at that time: status=in_progress,
  // conclusion=null, started 15:23:36Z. It later concluded SUCCESS, and this
  // module was run live against the same SHA:
  //   [15:51:27] wait: 'vitest (node 20)' is in_progress for this SHA
  //   [15:51:58] pass: 'vitest (node 20)' concluded success
  const atRefusalTime = classifyVitestGate({
    checkRuns: [check({ status: 'in_progress', conclusion: null, started_at: '2026-08-02T15:23:36Z' })],
    ciRuns: [{ status: 'in_progress', conclusion: null }],
  });
  assert.equal(atRefusalTime.decision, 'wait');

  const afterItConcluded = classifyVitestGate({
    checkRuns: [check({ status: 'completed', conclusion: 'success', started_at: '2026-08-02T15:23:36Z' })],
    ciRuns: [doneRun],
  });
  assert.equal(afterItConcluded.decision, 'pass');
});

test('waits when no check-run exists yet but console CI is still running', () => {
  const r = classifyVitestGate({
    checkRuns: [],
    ciRuns: [{ status: 'queued', conclusion: null }],
  });
  assert.equal(r.decision, 'wait');
});

test('waits when nothing at all has been observed yet (unknown, not absent)', () => {
  const r = classifyVitestGate({ checkRuns: [], ciRuns: [] });
  assert.equal(r.decision, 'wait');
});

test('refuses when console CI completed but produced no vitest check-run', () => {
  // The check will never arrive — this is the genuinely-unverifiable case.
  const r = classifyVitestGate({ checkRuns: [], ciRuns: [doneRun] });
  assert.equal(r.decision, 'refuse');
});

// ---------------------------------------------------------------------------
// STATE 3b — the list we read was TRUNCATED. Absence from a partial read is
// not absence. The check-runs endpoint pages at 100 and a CSA Loom main commit
// was already at 67 and climbing, so this becomes live the moment the repo
// gets busier — i.e. when a wrong refusal is most expensive.
// ---------------------------------------------------------------------------
test('a truncated check-run list is UNKNOWN, never absent — even if CI completed', () => {
  const r = classifyVitestGate({
    checkRuns: [],
    ciRuns: [doneRun], // would REFUSE if the list were known-complete
    checkRunsComplete: false,
  });
  assert.equal(r.decision, 'wait');
  assert.match(r.reason, /paging|complete/i);
});

test('truncation does not mask a check we DID read', () => {
  // If vitest is present in the partial page, its verdict still stands.
  const r = classifyVitestGate({
    checkRuns: [check({ conclusion: 'failure' })],
    ciRuns: [doneRun],
    checkRunsComplete: false,
  });
  assert.equal(r.decision, 'refuse');
});

test('CONTROL: completeness defaults to true so a complete read still refuses', () => {
  const r = classifyVitestGate({ checkRuns: [], ciRuns: [doneRun] });
  assert.equal(r.decision, 'refuse');
});

test('ignores check-runs with other names', () => {
  const r = classifyVitestGate({
    checkRuns: [{ name: 'next build (node 20)', status: 'completed', conclusion: 'success' }],
    ciRuns: [doneRun],
  });
  assert.notEqual(r.decision, 'pass');
});

// ---------------------------------------------------------------------------
// cancelled-but-superseded
// ---------------------------------------------------------------------------
test('accepts a cancelled check when the commit is an ancestor of a green main', () => {
  const r = classifyVitestGate({
    checkRuns: [check({ conclusion: 'cancelled' })],
    ciRuns: [doneRun],
    mainVerification: { compareStatus: 'ahead', behindBy: 0, mainConclusion: 'success' },
  });
  assert.equal(r.decision, 'pass');
});

test('refuses a cancelled check when main itself is not green', () => {
  const r = classifyVitestGate({
    checkRuns: [check({ conclusion: 'cancelled' })],
    ciRuns: [doneRun],
    mainVerification: { compareStatus: 'ahead', behindBy: 0, mainConclusion: 'failure' },
  });
  assert.equal(r.decision, 'refuse');
});

test('refuses a cancelled check when the commit is behind main', () => {
  const r = classifyVitestGate({
    checkRuns: [check({ conclusion: 'cancelled' })],
    ciRuns: [doneRun],
    mainVerification: { compareStatus: 'diverged', behindBy: 3, mainConclusion: 'success' },
  });
  assert.equal(r.decision, 'refuse');
});

test('refuses a cancelled check when main verification is unavailable', () => {
  const r = classifyVitestGate({ checkRuns: [check({ conclusion: 'cancelled' })], ciRuns: [doneRun] });
  assert.equal(r.decision, 'refuse');
});

// ---------------------------------------------------------------------------
// CONTROL — must hold whichever way the gate is mutated.
// A fix that widens the pass branch to clear the deadlock would break these;
// a fix that narrows everything to "always refuse" would break the first.
// ---------------------------------------------------------------------------
test('CONTROL: a plainly green commit always passes', () => {
  assert.equal(classifyVitestGate({ checkRuns: [check()], ciRuns: [doneRun] }).decision, 'pass');
});

test('CONTROL: a plainly red commit is never passed', () => {
  const r = classifyVitestGate({ checkRuns: [check({ conclusion: 'failure' })], ciRuns: [doneRun] });
  assert.equal(r.decision, 'refuse');
});

test('CONTROL: waiting is never a terminal verdict — it is neither pass nor refuse', () => {
  const r = classifyVitestGate({
    checkRuns: [check({ status: 'in_progress', conclusion: null })],
    ciRuns: [{ status: 'in_progress', conclusion: null }],
  });
  assert.equal(r.decision, 'wait');
  assert.ok(r.decision !== 'pass' && r.decision !== 'refuse');
});

// ---------------------------------------------------------------------------
// ACR probe classification — "could not ask" is not "not there"
// ---------------------------------------------------------------------------
test('classifies a real not-found as absent', () => {
  assert.equal(
    classifyAcrProbeError('ResourceNotFound: The Repository loom-console:abc could not be found'),
    'absent',
  );
  assert.equal(classifyAcrProbeError('manifest unknown'), 'absent');
});

test('VERBATIM az output: a missing tag is absent', () => {
  // Captured 2026-08-02 from `az acr repository show` against a real ACR with a
  // tag that does not exist. Pinned verbatim because the first version of the
  // pattern list said 'the tag does not exist' and az says "the SPECIFIED tag
  // does not exist" — the guess did not match, and only running the real
  // command surfaced it.
  const real =
    'ERROR: 2026-08-02 15:37:47.034938 Error: the specified tag does not exist. Correlation ID: <redacted>.';
  assert.equal(classifyAcrProbeError(real), 'absent');
});

test('VERBATIM az output: an unresolvable registry is unreachable', () => {
  const real =
    "ERROR: Could not connect to the registry login server 'acrdoesnotexist99xyz.azurecr.io'. Please verify that the registry exists.";
  assert.equal(classifyAcrProbeError(real), 'unreachable');
});

test('VERBATIM: a missing az CLI is unreachable, not absent', () => {
  assert.equal(classifyAcrProbeError('spawnSync az ENOENT'), 'unreachable');
});

test('classifies firewall / auth / network failures as unreachable', () => {
  const cases = [
    'denied: client with IP 20.1.2.3 is not allowed access to the registry',
    'unauthorized: authentication required',
    'Forbidden',
    'Failed to connect to the registry: connection timed out',
    'temporary failure in name resolution',
    'TooManyRequests',
  ];
  for (const c of cases) assert.equal(classifyAcrProbeError(c), 'unreachable', c);
});

test('an UNRECOGNISED error is unreachable, never absent (fail-closed default)', () => {
  assert.equal(classifyAcrProbeError('something nobody anticipated'), 'unreachable');
  assert.equal(classifyAcrProbeError(''), 'unreachable');
  assert.equal(classifyAcrProbeError(undefined), 'unreachable');
});

test('an auth error that also contains "not found" is still unreachable', () => {
  assert.equal(
    classifyAcrProbeError('unauthorized: the resource was not found or you lack access'),
    'unreachable',
  );
});

// ---------------------------------------------------------------------------
// Image resolution — the #2819 "registry never contacted" defect
// ---------------------------------------------------------------------------
test('resolves to the newest registry-confirmed image', () => {
  const r = resolveImageTag({
    candidates: [
      { sha: 'a'.repeat(40), acr: 'absent' },
      { sha: 'b'.repeat(40), acr: 'found' },
    ],
  });
  assert.equal(r.decision, 'resolved');
  assert.equal(r.sha, 'b'.repeat(40));
  assert.equal(r.evidence, 'acr');
});

test('regression #2819: an unfetchable candidate list is UNKNOWN, not an empty registry', () => {
  const r = resolveImageTag({ candidates: [], listComplete: false });
  assert.equal(r.decision, 'refuse');
  // The message must not blame the registry we never contacted.
  assert.doesNotMatch(r.reason, /no .*image .*in the registry/i);
  assert.match(r.reason, /could not retrieve/i);
});

test('an unreachable registry falls back to build-job evidence, labelled as such', () => {
  const r = resolveImageTag({
    candidates: [{ sha: 'c'.repeat(40), acr: 'unreachable', buildJob: 'success' }],
  });
  assert.equal(r.decision, 'resolved');
  assert.equal(r.evidence, 'build-job');
});

test('an unreachable registry with NO build evidence refuses as unknown, not absent', () => {
  const r = resolveImageTag({
    candidates: [{ sha: 'd'.repeat(40), acr: 'unreachable', buildJob: 'absent' }],
  });
  assert.equal(r.decision, 'refuse');
  assert.match(r.reason, /UNKNOWN, not absent/);
});

test('a FAILED build job is never accepted as evidence the image exists', () => {
  const r = resolveImageTag({
    candidates: [{ sha: 'e'.repeat(40), acr: 'unreachable', buildJob: 'failure' }],
  });
  assert.equal(r.decision, 'refuse');
});

test('CONTROL: a reachable registry that reports nothing may honestly say so', () => {
  const r = resolveImageTag({
    candidates: [
      { sha: 'f'.repeat(40), acr: 'absent' },
      { sha: '0'.repeat(40), acr: 'absent' },
    ],
  });
  assert.equal(r.decision, 'refuse');
  assert.match(r.reason, /reachable/);
});

test('CONTROL: registry confirmation beats build-job evidence', () => {
  const r = resolveImageTag({
    candidates: [
      { sha: '1'.repeat(40), acr: 'unreachable', buildJob: 'success' },
      { sha: '2'.repeat(40), acr: 'found' },
    ],
  });
  assert.equal(r.evidence, 'acr');
  assert.equal(r.sha, '2'.repeat(40));
});
