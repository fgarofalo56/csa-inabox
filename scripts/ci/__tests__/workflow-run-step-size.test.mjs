/**
 * Self-tests for check-workflow-run-step-size.mjs (#4586).
 *
 * WHAT IS BEING PINNED, and what value makes each assertion fail.
 *
 * The defect is invisible to every other tool: the file is valid YAML, has a
 * sound `needs` graph, and passes actionlint. GitHub simply refuses to LOAD it
 * and emits one 0-job `failure` run. So the ONLY thing standing between this
 * repo and a twelve-push silent freeze of its deploy path is that this guard
 * flips at the right byte, on the right steps, counting the right unit.
 *
 * Each test below is built so that a specific, named mutation of the guard
 * turns it red — stated per test. Two of them exist because the naive version
 * of this guard would have been WRONG in a way the repo tree already disproves:
 *
 *   - counting CHARACTERS instead of BYTES would pass a file GitHub refuses
 *     (probe `x3`: same characters as a loading probe, em dashes, 21,344 bytes,
 *     did not load);
 *   - failing EVERY oversize step would red release-please.yml, whose
 *     39,839-byte expression-free step loads and runs today.
 *
 * Run: node --test scripts/ci/__tests__/workflow-run-step-size.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BYTE_LIMIT,
  MEASURED_FAIL_AT,
  MEASURED_LOAD_AT,
  hasExpression,
  runStepBytes,
  scanWorkflowText,
} from '../check-workflow-run-step-size.mjs';
import { parseWorkflow } from '../_workflow-yaml.mjs';

/**
 * Build a workflow whose single `run:` step's script is EXACTLY `bytes` UTF-8
 * bytes as the guard measures it (i.e. including the clip-chomped newline).
 * `seed` is placed first, so an expression can be planted or omitted.
 */
function workflowWithRunStep(bytes, seed) {
  const prefix = `${seed}\n`;
  const need = bytes - Buffer.byteLength(prefix, 'utf8');
  assert.ok(need >= 2, `seed too long for ${bytes} bytes`);
  // pad lines of '#' + 'p'*(n-2) + '\n'
  const LINE = 80;
  const full = Math.floor(need / LINE);
  const rem = need % LINE;
  assert.ok(rem === 0 || rem >= 2, `remainder ${rem} cannot form a line`);
  let script = prefix + `#${'p'.repeat(LINE - 2)}\n`.repeat(full);
  if (rem) script += `#${'p'.repeat(rem - 2)}\n`;

  const body = script
    .split('\n')
    .slice(0, -1) // drop the '' after the final newline
    .map((l) => ' '.repeat(10) + l)
    .join('\n');

  return [
    'name: fixture',
    'on:',
    '  workflow_dispatch:',
    'jobs:',
    '  probe:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: the step',
    '        run: |',
    body,
    '',
  ].join('\n');
}

test('the fixture builder produces the byte count it claims', () => {
  // Without this, every threshold test below could be measuring the wrong
  // number and agreeing with itself. Breaks if the builder is off by one.
  for (const n of [1000, BYTE_LIMIT, BYTE_LIMIT + 1, MEASURED_LOAD_AT, MEASURED_FAIL_AT]) {
    const text = workflowWithRunStep(n, 'set -euo pipefail');
    const { findings, notes } = scanWorkflowText('f.yml', text);
    const seen = [...findings, ...notes];
    if (n > BYTE_LIMIT) {
      assert.equal(seen.length, 1, `expected one row at ${n} bytes`);
      assert.equal(seen[0].bytes, n, `fixture claimed ${n} bytes`);
    }
  }
});

test('a step AT the limit carrying an expression does NOT fail', () => {
  // Fails if the comparison is `>=` instead of `>`.
  const text = workflowWithRunStep(BYTE_LIMIT, 'echo "${{ github.run_id }}"');
  const { findings } = scanWorkflowText('f.yml', text);
  assert.deepEqual(findings, []);
});

test('ONE byte over the limit with an expression FAILS — this is the kill', () => {
  // The value that makes this fail: BYTE_LIMIT + 1 bytes. Fails if the
  // threshold is raised, if the comparison is inverted, or if the expression
  // predicate is dropped.
  const text = workflowWithRunStep(BYTE_LIMIT + 1, 'echo "${{ github.run_id }}"');
  const { findings } = scanWorkflowText('f.yml', text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'oversize-with-expression');
  assert.equal(findings[0].bytes, BYTE_LIMIT + 1);
  assert.equal(findings[0].jobId, 'probe');
  assert.equal(findings[0].stepName, 'the step');
});

test('the same oversize step WITHOUT an expression is a note, not a failure', () => {
  // Fails if the guard is widened to fail every oversize step — which would
  // red release-please.yml, a file proven to load at 39,839 bytes.
  const text = workflowWithRunStep(BYTE_LIMIT + 1, 'echo "${GITHUB_RUN_ID}"');
  const { findings, notes } = scanWorkflowText('f.yml', text);
  assert.deepEqual(findings, []);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'oversize-without-expression');
});

test('BYTES, not characters: an em-dash payload under the CHARACTER limit fails', () => {
  // Probe `x3` (#4586): identical character count to a loading probe, but em
  // dashes made it 21,344 bytes and it did not load. This fails if
  // runStepBytes ever uses `.length` instead of Buffer.byteLength.
  const emDashes = '—'.repeat(400); // 400 chars, 1200 bytes
  const seed = `echo "${'${{ github.run_id }}'}" # ${emDashes}`;
  const text = workflowWithRunStep(BYTE_LIMIT + 1, seed);
  const { findings } = scanWorkflowText('f.yml', text);
  assert.equal(findings.length, 1, 'em-dash payload must be measured in bytes');

  // And the fixture really is multi-byte: lift the scalar the guard measured
  // rather than transcribing its size, then compare characters to bytes. The
  // character count must be UNDER the limit while the byte count is over —
  // which is precisely the state a `.length`-based guard would wave through.
  const run = parseWorkflow(text).jobs.probe.steps[0].run.v;
  assert.equal(runStepBytes(run), BYTE_LIMIT + 1);
  assert.ok(
    run.length < BYTE_LIMIT,
    `fixture must be under the limit by CHARACTER count (was ${run.length})`
  );
});

test('the real #4586 offender shape is caught', () => {
  // Regression pin at the measured size of the step that froze
  // full-app-deploy-commercial.yml. Fails if the limit is ever raised above it.
  const text = workflowWithRunStep(38355, "RG='${{ needs.resolve.outputs.rg }}'");
  const { findings } = scanWorkflowText('full-app-deploy-commercial.yml', text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].bytes, 38355);
  assert.ok(
    findings[0].bytes > MEASURED_FAIL_AT,
    'the offender must exceed the measured load boundary'
  );
});

test('the enforced limit sits below the measured boundary', () => {
  // Fails if someone raises BYTE_LIMIT to or past the byte GitHub refuses.
  assert.ok(BYTE_LIMIT < MEASURED_FAIL_AT, 'limit must be under the refusal point');
  assert.ok(BYTE_LIMIT <= MEASURED_LOAD_AT, 'limit must not exceed the largest loading size');
  assert.equal(MEASURED_FAIL_AT - MEASURED_LOAD_AT, 1, 'the boundary is one byte wide');
});

test('an unparseable workflow FAILS CLOSED rather than being skipped', () => {
  // The repo's dominant defect class is a control that silently measures
  // nothing. Fails if the try/catch is changed to `continue`.
  // A deeper-indented CHILD does not throw — the parser discovers a child's
  // indent — so this fixture uses the one shape it refuses: a sibling key
  // indented deeper than the mapping it belongs to. Verified against the
  // parser directly; guessing the shape would have produced a test that
  // could not fail.
  const broken = ['jobs:', '  a:', '    x: 1', '      y: 2'].join('\n');
  const { findings } = scanWorkflowText('broken.yml', broken);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'unparseable');
  assert.match(findings[0].message, /NOT measured/);
});

test('runStepBytes restores the clip-chomped trailing newline', () => {
  // The shared parser strips it; PyYAML (which the boundary was measured with)
  // keeps one. Fails if that +1 is dropped, which would under-count every step.
  assert.equal(runStepBytes('abc'), 4);
  assert.equal(runStepBytes('abc\n'), 4);
  assert.equal(runStepBytes('—'), 4); // 3-byte char + newline
});

test('hasExpression sees an Actions expression and not a shell one', () => {
  // Fails if the predicate is loosened to `${` — `${GITHUB_RUN_ID}` is an
  // ordinary shell expansion and must NOT bring a step under the limit.
  assert.equal(hasExpression('echo "${{ github.run_id }}"'), true);
  assert.equal(hasExpression('echo "${GITHUB_RUN_ID}"'), false);
  assert.equal(hasExpression('echo "$GITHUB_RUN_ID"'), false);
});
