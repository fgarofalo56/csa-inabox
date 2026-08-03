// Behaviour tests for scripts/ci/check-node-test-suites.mjs.
//
// The guard's whole purpose is to stop a suite from sitting in the tree
// unexecuted (#2835), so its own failure modes matter more than usual: a
// discovery bug or a swallowed exit code would recreate exactly the defect it
// exists to catch. These tests drive the pure decision core through every
// branch and exercise discovery against a fixture tree on disk.
//
// Run: node --test scripts/ci/__tests__/node-test-suites.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkMergeBlockingLane,
  decide,
  discoverSuites,
  extractJobBlock,
  findInvocation,
  isOwnedByOtherRunner,
  jobContextName,
  parseTapSummary,
  pullRequestTriggerIsUnfiltered,
  MERGE_BLOCKING_LANES,
  OTHER_RUNNER_TREES,
  REPO_ROOT,
  RUNNER_PATH,
} from '../check-node-test-suites.mjs';

/** Build a throwaway tree and return its root. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-suites-'));
  for (const rel of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// fixture\n');
  }
  return root;
}

// ── decide(): the pure core ─────────────────────────────────────────────────

test('decide: a failing child propagates its EXACT status (never downgraded)', () => {
  // The recurring defect in this repo is a control whose real result is
  // discarded. A non-zero child must survive every later heuristic.
  const r = decide({ status: 3, summary: { pass: 100, fail: 1 }, ci: true });
  assert.equal(r.code, 3);
  assert.match(r.reason, /suite failed/);
});

test('decide: a child killed by a signal (status null) still fails', () => {
  const r = decide({ status: null, summary: null, ci: true });
  assert.equal(r.code, 1);
});

test('decide: exit 0 with NO TAP summary fails — the run never concluded', () => {
  const r = decide({ status: 0, summary: null, ci: true });
  assert.equal(r.code, 1);
  assert.match(r.reason, /no TAP summary/);
});

test('decide: exit 0 with ZERO passing tests FAILS in CI (measured nothing)', () => {
  // Every suite skipped. node --test exits 0, so without this branch the lane
  // would be green while asserting nothing at all.
  const r = decide({ status: 0, summary: { pass: 0, fail: 0, skipped: 26 }, ci: true });
  assert.equal(r.code, 1);
  assert.match(r.reason, /measured nothing/);
});

test('decide: the same all-skipped run WARNS but passes locally', () => {
  // A developer without a POSIX sh has a degraded environment, not a broken
  // repo. CI is where the hard error belongs.
  const r = decide({ status: 0, summary: { pass: 0, fail: 0, skipped: 26 }, ci: false });
  assert.equal(r.code, 0);
  assert.match(r.reason, /WARNING/);
});

// CONTROL — passes both before and after any tightening of decide(). A change
// that made the guard unable to pass a genuinely good run would break this.
test('CONTROL: a normal green run passes in BOTH ci and local modes', () => {
  for (const ci of [true, false]) {
    const r = decide({ status: 0, summary: { pass: 158, fail: 0, skipped: 0 }, ci });
    assert.equal(r.code, 0, `expected pass with ci=${ci}: ${r.reason}`);
  }
});

// ── parseTapSummary ─────────────────────────────────────────────────────────

test('parseTapSummary: reads the node:test TAP counters', () => {
  const s = parseTapSummary('# tests 158\n# pass 157\n# fail 1\n# skipped 0\n');
  assert.deepEqual(s, { pass: 157, fail: 1, skipped: 0 });
});

test('CONTROL: CRLF output parses identically to LF', () => {
  // Documents a property rather than guarding a fix. JS `$` under /m already
  // treats \r as a line terminator, so `^# pass (\d+)$` matches CRLF output
  // unchanged — verified by mutation: adding an explicit `\r?` to the pattern
  // changed nothing, so it was removed rather than shipped as an inert fix.
  // This test therefore passes both ways ON PURPOSE; it exists so a future
  // rewrite of parseTapSummary that breaks CRLF handling is caught.
  const s = parseTapSummary('# tests 158\r\n# pass 157\r\n# fail 1\r\n# skipped 0\r\n');
  assert.deepEqual(s, { pass: 157, fail: 1, skipped: 0 });
});

test('parseTapSummary: returns null when counters are absent', () => {
  // Truncated / crashed output must NOT be read as a clean zero.
  assert.equal(parseTapSummary('some crash output\n'), null);
  assert.equal(parseTapSummary('# pass 5\n'), null); // fail counter missing
});

// ── discovery ───────────────────────────────────────────────────────────────

test('discover: finds .test.mjs, .test.cjs and .test.js at any depth', () => {
  const root = fixture([
    'apps/a/tests/one.test.mjs',
    'apps/b/deep/nested/two.test.cjs',
    'tools/c/test/three.test.js',
    'apps/a/src/index.mjs', // not a test
    'apps/a/tests/README.md',
  ]);
  assert.deepEqual(discoverSuites(root), [
    'apps/a/tests/one.test.mjs',
    'apps/b/deep/nested/two.test.cjs',
    'tools/c/test/three.test.js',
  ]);
});

test('discover: never descends into node_modules or build output', () => {
  const root = fixture([
    'apps/a/tests/real.test.mjs',
    'node_modules/pkg/thing.test.mjs',
    'apps/a/node_modules/dep/dep.test.mjs',
    'apps/a/dist/bundled.test.mjs',
    'apps/a/.next/chunk.test.mjs',
    'coverage/report.test.mjs',
  ]);
  assert.deepEqual(discoverSuites(root), ['apps/a/tests/real.test.mjs']);
});

test('discover: skips trees owned by another runner', () => {
  const root = fixture([
    'apps/a/tests/real.test.mjs',
    'portal/react-webapp/src/Thing.test.js', // jest owns this
  ]);
  assert.deepEqual(discoverSuites(root), ['apps/a/tests/real.test.mjs']);
});

test('discover: a directory merely PREFIXED by an excluded one is still walked', () => {
  // `portal/react-webapp-legacy` must not be swallowed by a substring match —
  // that is the over-broad-exclusion shape that silently drops coverage.
  const root = fixture([
    'portal/react-webapp-legacy/tests/a.test.mjs',
    'portal/react-webapp/src/b.test.js',
  ]);
  assert.deepEqual(discoverSuites(root), ['portal/react-webapp-legacy/tests/a.test.mjs']);
});

test('discover: an empty tree yields [] so main() can fail closed on it', () => {
  assert.deepEqual(discoverSuites(fixture([])), []);
});

test('isOwnedByOtherRunner: matches the dir itself and its children only', () => {
  assert.equal(isOwnedByOtherRunner('portal/react-webapp'), true);
  assert.equal(isOwnedByOtherRunner('portal/react-webapp/src/x.test.js'), true);
  assert.equal(isOwnedByOtherRunner('portal/react-webapp-legacy/x.test.mjs'), false);
  assert.equal(isOwnedByOtherRunner('apps/loom-unity/tests/entrypoint.test.mjs'), false);
});

// ── the real repo ───────────────────────────────────────────────────────────

test('the four suites orphaned in #2835 are discovered in the real tree', () => {
  // Named explicitly: these are the suites that had NO lane. If a future
  // refactor moves or renames one, this fails loudly instead of silently
  // dropping it back out of CI.
  const found = discoverSuites(REPO_ROOT);
  for (const orphan of [
    'apps/loom-unity/tests/entrypoint.test.mjs',
    'apps/loom-onelake/tests/resolver.test.mjs',
    'scripts/csa-loom/tests/preflight-image-tags.test.mjs',
    'tools/ado-loom-task/test/inputs.test.js',
  ]) {
    assert.ok(found.includes(orphan), `discovery lost ${orphan}`);
  }
});

test('the ALREADY-covered suites stay discovered (no coverage was traded away)', () => {
  const found = discoverSuites(REPO_ROOT);
  assert.ok(found.includes('apps/loom-sharing/tests/entrypoint.test.mjs'));
  assert.ok(found.some((f) => f.startsWith('scripts/ci/__tests__/')));
});

test('every exclusion names a runner and the workflow that executes it', () => {
  // An undocumented exclusion is a hole. Force each one to carry its evidence.
  assert.ok(OTHER_RUNNER_TREES.length > 0);
  for (const t of OTHER_RUNNER_TREES) {
    assert.ok(t.dir && t.runner && t.workflow, `incomplete exclusion: ${JSON.stringify(t)}`);
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, t.workflow)),
      `${t.dir} claims ${t.workflow} runs it, but that workflow does not exist`,
    );
  }
});

// ── the lane must be able to BLOCK A MERGE (#2856) ──────────────────────────
//
// Running the suites is only half of it. #2838 wired this runner into a job
// whose status context is not in the required set, so a red result could not
// stop a merge. These drive the parser branches that decide that.

const WF = [
  'name: Demo',
  'on:',
  '  pull_request:',
  '  push:',
  '    branches: [main]',
  'jobs:',
  '  guardrails:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: something else',
  '        run: node scripts/ci/check-other.mjs',
  '      - name: the runner',
  `        run: node ${RUNNER_PATH}`,
  '  other-job:',
  '    runs-on: ubuntu-latest',
].join('\n');

test('extractJobBlock: returns only the named job, stopping at the next job id', () => {
  const block = extractJobBlock(WF, 'guardrails');
  assert.ok(block.includes(RUNNER_PATH));
  assert.ok(!block.includes('other-job'));
  assert.equal(extractJobBlock(WF, 'no-such-job'), null);
});

test('extractJobBlock: a two-space COMMENT does not end the block', () => {
  // Comments between steps are indented arbitrarily. Treating one as the next
  // job id would truncate the block and lose the invocation below it — the
  // parser bug that would make this guard pass while measuring nothing.
  const wf = [
    'jobs:',
    '  guardrails:',
    '    steps:',
    '  # a stray two-space comment',
    '      - name: the runner',
    `        run: node ${RUNNER_PATH}`,
  ].join('\n');
  assert.ok(extractJobBlock(wf, 'guardrails').includes(RUNNER_PATH));
});

test('jobContextName: a job with no name: reports under its job id', () => {
  assert.equal(jobContextName(extractJobBlock(WF, 'guardrails'), 'guardrails'), 'guardrails');
});

test('jobContextName: adding a name: RENAMES the status context', () => {
  // This is the silent-drop trap: branch protection requires the context
  // "guardrails"; giving the job a display name changes what it reports as,
  // and the required check would simply never arrive.
  const block = '    name: Loom Guardrails\n    steps: []';
  assert.equal(jobContextName(block, 'guardrails'), 'Loom Guardrails');
  assert.equal(jobContextName("    name: 'Quoted Name'", 'g'), 'Quoted Name');
});

test('findInvocation: finds the run line and reports it un-neutered', () => {
  const r = findInvocation(extractJobBlock(WF, 'guardrails'), RUNNER_PATH);
  assert.equal(r.found, true);
  assert.deepEqual(r.neutered, []);
});

test('findInvocation: `|| true` on the run line is neutered', () => {
  const block = `      - name: x\n        run: node ${RUNNER_PATH} || true`;
  const r = findInvocation(block, RUNNER_PATH);
  assert.equal(r.found, true);
  assert.match(r.neutered.join(' '), /\|\| true/);
});

test('findInvocation: continue-on-error on the SAME step is neutered', () => {
  const block = [
    '      - name: x',
    '        continue-on-error: true',
    `        run: node ${RUNNER_PATH}`,
  ].join('\n');
  assert.match(findInvocation(block, RUNNER_PATH).neutered.join(' '), /continue-on-error/);
});

test('findInvocation: a NEIGHBOUR step\'s continue-on-error does not neuter ours', () => {
  // Attribution matters. Scanning the whole job for continue-on-error would
  // condemn a healthy invocation because some unrelated step tolerates failure
  // — an over-broad guard that gets switched off rather than fixed.
  const block = [
    '      - name: flaky third-party thing',
    '        continue-on-error: true',
    '        run: node scripts/ci/other.mjs',
    '      - name: the runner',
    `        run: node ${RUNNER_PATH}`,
  ].join('\n');
  const r = findInvocation(block, RUNNER_PATH);
  assert.equal(r.found, true);
  assert.deepEqual(r.neutered, []);
});

test('findInvocation: a COMMENTED-OUT invocation does not count as wired', () => {
  // A guard a comment can satisfy is not a guard.
  const block = `      - name: x\n        # run: node ${RUNNER_PATH}\n        run: echo hi`;
  assert.equal(findInvocation(block, RUNNER_PATH).found, false);
});

test('pullRequestTriggerIsUnfiltered: plain `pull_request:` passes', () => {
  assert.equal(pullRequestTriggerIsUnfiltered(WF).ok, true);
});

test('pullRequestTriggerIsUnfiltered: a paths filter fails', () => {
  // A path-filtered REQUIRED check never reports on unrelated PRs (deadlock)
  // and cannot fire on the edit it exists to catch.
  const wf = 'on:\n  pull_request:\n    paths:\n      - "apps/**"\njobs:\n';
  const r = pullRequestTriggerIsUnfiltered(wf);
  assert.equal(r.ok, false);
  assert.match(r.reason, /path-filtered/);
});

test('pullRequestTriggerIsUnfiltered: push-only workflow fails', () => {
  const r = pullRequestTriggerIsUnfiltered('on:\n  push:\n    branches: [main]\njobs:\n');
  assert.equal(r.ok, false);
  assert.match(r.reason, /pull_request/);
});

// ── the real repo ───────────────────────────────────────────────────────────

test('a merge-blocking lane really invokes this runner', () => {
  // THE assertion for #2856. Before the loom-guardrails.yml step was added this
  // failed: the only invocation was `node:test suites (node 20)` in
  // fiab-console-ci.yml, which is not a required status check.
  const r = checkMergeBlockingLane();
  assert.equal(r.ok, true, `no merge-blocking lane runs the suites: ${r.problems.join(' | ')}`);
});

test('every declared merge-blocking lane carries verifiable evidence', () => {
  assert.ok(MERGE_BLOCKING_LANES.length > 0, 'declaring no lane would pass vacuously');
  for (const lane of MERGE_BLOCKING_LANES) {
    assert.ok(lane.workflow && lane.job && lane.check, `incomplete lane: ${JSON.stringify(lane)}`);
    const abs = path.join(REPO_ROOT, lane.workflow);
    assert.ok(fs.existsSync(abs), `${lane.workflow} does not exist`);
    const block = extractJobBlock(fs.readFileSync(abs, 'utf8'), lane.job);
    assert.ok(block !== null, `${lane.workflow} declares no job "${lane.job}"`);
    assert.equal(
      jobContextName(block, lane.job),
      lane.check,
      `${lane.job} does not report as the required check "${lane.check}"`,
    );
  }
});

test('checkMergeBlockingLane fails when the lane workflow is missing entirely', () => {
  // Point it at an empty root: the declared workflow cannot be found, so it
  // must report a problem rather than pass by default.
  const r = checkMergeBlockingLane(fs.mkdtempSync(path.join(os.tmpdir(), 'no-lanes-')));
  assert.equal(r.ok, false);
  assert.ok(r.problems.length > 0);
});

// CONTROL — passes BOTH before and after this change, in both directions of the
// mutation. It exists to catch an over-broad "fix" that gave the suites a
// blocking lane by REMOVING the two independent controls #2838 deliberately
// kept. Coverage must be added here, never traded.
test('CONTROL: the pre-existing independent lanes are untouched', () => {
  const consoleCi = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/fiab-console-ci.yml'),
    'utf8',
  );
  const nodeTestJob = extractJobBlock(consoleCi, 'node-test-suites');
  assert.ok(nodeTestJob, 'fiab-console-ci.yml lost its node-test-suites job');
  assert.equal(findInvocation(nodeTestJob, RUNNER_PATH).found, true);
  assert.ok(extractJobBlock(consoleCi, 'loom-sharing'), 'the loom-sharing control job was removed');

  const guardrails = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/loom-guardrails.yml'),
    'utf8',
  );
  assert.ok(
    findInvocation(extractJobBlock(guardrails, 'guardrails'), 'scripts/ci/__tests__').found,
    'the hand-listed scripts/ci self-test step was removed',
  );
});
