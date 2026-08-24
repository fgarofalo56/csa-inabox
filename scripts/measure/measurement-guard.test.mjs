#!/usr/bin/env node
/**
 * measurement-guard.test.mjs
 *
 * Run: node --test scripts/measure/measurement-guard.test.mjs
 *
 * NOTE ON LOCATION: this suite tests `.claude/hooks/measurement-guard.mjs` but
 * lives here on purpose. The repo's tree-wide discovery
 * (`scripts/ci/check-node-test-suites.mjs`) has `.claude` in SKIP_DIRS and
 * requires a literal `.test.` in the filename — so a suite named `selftest.mjs`
 * under `.claude/hooks/` is invisible to CI and would rot silently, which is the
 * exact failure #3968 was filed about. Measured, not assumed.
 *
 * POSITIVE cases are the real commands that produced false measurements on
 * 2026-08-23. NEGATIVE cases are legitimate commands that must NOT be blocked —
 * a false denial is the pressure that gets a guard deleted, so they carry equal
 * weight here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../../.claude/hooks/measurement-guard.mjs';

const has = (cmd, id) => evaluate(cmd).some((f) => f.id === id);

// ------------------------------------------------------------ rc-after-pipe
test('POSITIVE: the exact seven-apps command is blocked', () => {
  // Verbatim shape from the incident: RC read tr's status, not az's.
  const cmd = `R=$(az monitor metrics list --resource "$ID" --metric Requests -o tsv 2>temp/mx.err | tr -d '\\r')\nRC=$?\necho "requests=$R rc=$RC"`;
  assert.ok(has(cmd, 'rc-after-pipe'), 'must block $? after a pipeline');
});

test('POSITIVE: same-line pipeline then $? is blocked', () => {
  assert.ok(has(`gh pr list --json number | tr -d '\\r'; RC=$?`, 'rc-after-pipe'));
});

test('NEGATIVE: $? on the line after a NON-piped command is allowed', () => {
  const cmd = `az containerapp update -n x -g y --min-replicas 0 > out.txt 2>err.txt\nRC=$?`;
  assert.equal(has(cmd, 'rc-after-pipe'), false, 'the CORRECT form must not be blocked');
});

test('NEGATIVE: a pipeline with no $? capture is allowed', () => {
  assert.equal(has(`gh pr list --json number | python -c "import sys; print(len(sys.stdin.read()))"`, 'rc-after-pipe'), false);
});

test('NEGATIVE: `||` is not a pipe', () => {
  assert.equal(has(`test -f x || echo missing\nRC=$?`, 'rc-after-pipe'), false);
});

// ------------------------------------------------------------ msys-arm-id
test('POSITIVE: an ARM id passed to az without MSYS_NO_PATHCONV is blocked', () => {
  const cmd = `az monitor metrics list --resource /subscriptions/aaaaaaaa-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.App/containerApps/app --metric Requests`;
  assert.ok(has(cmd, 'msys-arm-id'), 'must block an unguarded leading-slash ARM id');
});

test('NEGATIVE: the SAME command with MSYS_NO_PATHCONV=1 is allowed', () => {
  const cmd = `MSYS_NO_PATHCONV=1 az monitor metrics list --resource /subscriptions/aaaaaaaa-0000-0000-0000-000000000000/rg --metric Requests`;
  assert.equal(has(cmd, 'msys-arm-id'), false, 'the documented FIX must not be blocked');
});

test('NEGATIVE: an ARM id inside a variable (already resolved) is allowed', () => {
  assert.equal(has(`MSYS_NO_PATHCONV=1 az monitor metrics list --resource "$ID" --metric Requests`, 'msys-arm-id'), false);
});

test('NEGATIVE: a /subscriptions/ path with no az or gh is allowed', () => {
  assert.equal(has(`echo /subscriptions/foo > notes.txt`, 'msys-arm-id'), false);
});

// ------------------------------------------------------------ discarded-stderr
test('POSITIVE: 2>/dev/null on an az call is blocked', () => {
  assert.ok(has(`az kusto cluster show -n c -g g --query state -o tsv 2>/dev/null`, 'discarded-stderr'));
});

test('POSITIVE: 2>/dev/null on a gh call is blocked', () => {
  assert.ok(has(`gh api repos/o/r/commits/abc/check-runs 2>/dev/null`, 'discarded-stderr'));
});

test('NEGATIVE: 2>/dev/null on a non-measurement command is allowed', () => {
  assert.equal(has(`ls .claude/hooks/ 2>/dev/null`, 'discarded-stderr'), false);
});

test('NEGATIVE: redirecting stderr to a FILE is allowed', () => {
  assert.equal(has(`az account show > acct.json 2>acct.err`, 'discarded-stderr'), false);
});

// ------------------------------------------------------------ suite integrity
test('CONTROL: a plainly fine command produces NO findings at all', () => {
  assert.deepEqual(evaluate(`git status --porcelain`), []);
  assert.deepEqual(evaluate(`node --test scripts/measure/selftest.mjs`), []);
});

test('CONTROL: the evaluator returns findings at all (not vacuously empty)', () => {
  const f = evaluate(`R=$(az x | tr -d '\\r')\nRC=$?`);
  assert.ok(f.length > 0, 'if this is empty the whole suite proves nothing');
  assert.ok(/FIX:/.test(f[0].message), 'every finding must name the fix, not just the problem');
});
