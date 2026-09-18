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

test('NEGATIVE: a `|` inside a --jq STRING is not a shell pipe (real false positive)', () => {
  // This exact command was denied by the first version of the guard. The pipe
  // belongs to the jq expression, not the shell. A guard that blocks correct
  // commands is the pressure that gets it deleted.
  const cmd = `gh api "repos/o/r/commits/$SHA/check-runs" --jq '[.check_runs[] | {n:.name,c:.conclusion}]' > out.json 2>err.txt\nRC=$?`;
  assert.equal(has(cmd, 'rc-after-pipe'), false, 'a jq pipe must not be read as a shell pipeline');
});

test('NEGATIVE: a `|` inside a double-quoted awk/sed program is not a shell pipe', () => {
  const cmd = `awk "/a|b/ {print}" file.txt > out.txt 2>err.txt\nRC=$?`;
  assert.equal(has(cmd, 'rc-after-pipe'), false);
});

test('POSITIVE CONTROL for quote-masking: a REAL pipe outside quotes is still caught', () => {
  // Guards the fix above: masking must not blind the rule to genuine pipelines.
  const cmd = `gh api "repos/o/r/x" --jq '.a[] | .b' | tr -d '\\r' > out.txt\nRC=$?`;
  assert.ok(has(cmd, 'rc-after-pipe'), 'a real shell pipe after a quoted jq must still be caught');
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

test('NEGATIVE: 2>/dev/null on a NON-measurement, in a script that also runs gh (real false positive)', () => {
  // The redirect belongs to `ps`; `gh` appears on a later line. The first
  // version tested the whole command string for a measurement binary and denied
  // this. Scope must follow the redirect, not the buffer.
  const cmd = `echo "alive: $(ps -ef 2>/dev/null | grep -c '[o]vernight')"\ngh pr list --state open --json number`;
  assert.equal(has(cmd, 'discarded-stderr'), false, 'a redirect on ps must not be attributed to gh');
});

test('POSITIVE CONTROL for segment-scoping: the redirect ON the gh call is still caught', () => {
  // Guards the fix above — narrowing must not blind the rule to the real case.
  const cmd = `echo hi\ngh api repos/o/r/commits/x/check-runs 2>/dev/null`;
  assert.ok(has(cmd, 'discarded-stderr'), 'a redirect on gh itself must still be caught');
});

test('POSITIVE: a piped gh call with the redirect on gh is caught', () => {
  assert.ok(has(`gh pr list --json number 2>/dev/null | head -3`, 'discarded-stderr'));
});

// ------------------------------------------- stderr discarding, by SHAPE
// The rule used to test the literal `2>/dev/null` and nothing else, so every
// other way of throwing stderr away -- including strictly worse ones -- passed.
// These pin the shape rather than the spelling.
test('POSITIVE: &>/dev/null is blocked (it discards BOTH streams — strictly worse)', () => {
  assert.ok(has(`az account show &>/dev/null`, 'discarded-stderr'));
});

test('POSITIVE: the canonical >/dev/null 2>&1 is blocked', () => {
  assert.ok(has(`az account show >/dev/null 2>&1`, 'discarded-stderr'));
});

test('POSITIVE: appending stderr to /dev/null is blocked', () => {
  assert.ok(has(`gh pr list 2>>/dev/null`, 'discarded-stderr'));
});

test('POSITIVE: closing stderr outright (2>&-) is blocked', () => {
  assert.ok(has(`az group list 2>&-`, 'discarded-stderr'));
});

test('NEGATIVE: discarding only STDOUT is allowed — stderr still readable', () => {
  // This is the control that keeps the shape match from widening into "any
  // /dev/null is a finding". Silencing stdout while keeping stderr is a normal,
  // correct thing to do and must not be denied.
  assert.equal(has(`az account show >/dev/null`, 'discarded-stderr'), false);
});

test('NEGATIVE: a non-measurement discarding stderr is still allowed', () => {
  assert.equal(has(`ps -ef 2>/dev/null | grep node`, 'discarded-stderr'), false);
});

// ------------------------------------------------ `python -` interactive REPL
// `python - <<'EOF'` that misses stdin becomes an interactive REPL and loops on
// a traceback forever. Six occurrences in one session, three of them by agents
// quoting the prohibition at the time — which is why this is a hook and not a
// note. The POSITIVE cases below are the literal shapes that were run.
test('POSITIVE: the canonical heredoc is blocked', () => {
  assert.ok(has(`python - <<'EOF'\nprint(1)\nEOF`, 'python-dash-repl'));
});

test('POSITIVE: an EMPTY body is blocked — "harmless" is not a defence', () => {
  // Two of the six were deliberate no-ops. They still hung for the full 120s
  // and still left a REPL to be killed. The construct is the hazard, not what
  // it would have run.
  assert.ok(has(`python - <<'NEVER'\nNEVER`, 'python-dash-repl'));
});

test('POSITIVE: redirecting STDOUT does not make it safe — the loop is on stderr', () => {
  assert.ok(has(`python - > /dev/null 2>&1 <<'X'\nX`, 'python-dash-repl'));
});

test('POSITIVE: the QUIET shape (2>/dev/null) is blocked — no file ever grows', () => {
  // Measured: 8.3 GB of write IO and ~1h CPU with zero file-size movement. This
  // variant is invisible to every size check, so it survives longest.
  assert.ok(has(`python - 2>/dev/null <<'X'\nX`, 'python-dash-repl'));
});

test('POSITIVE: args before the heredoc are blocked', () => {
  assert.ok(has(`python - "$@" <<'PYEOF'\nPYEOF`, 'python-dash-repl'));
});

test('POSITIVE: python3 and a bare trailing dash are blocked', () => {
  assert.ok(has(`python3 - <<EOF\nEOF`, 'python-dash-repl'));
  assert.ok(has(`python -`, 'python-dash-repl'), 'end-of-string must match too');
});

test('POSITIVE: buried on a later line of a multi-line script', () => {
  assert.ok(has(`set -e\ncd /tmp\npython - <<'Z'\nZ`, 'python-dash-repl'));
});

test('NEGATIVE: `python -c` is the sanctioned escape and must not be blocked', () => {
  // If this rule denied -c it would be routed around within a day, and a guard
  // people delete protects nothing.
  assert.equal(has(`python -c "import sys; print(sys.version)"`, 'python-dash-repl'), false);
});

test('NEGATIVE: -m, -u, --version and a plain script path are allowed', () => {
  assert.equal(has(`python -m pytest tests/ -q`, 'python-dash-repl'), false);
  assert.equal(has(`python -u temp/s.py`, 'python-dash-repl'), false);
  assert.equal(has(`python --version`, 'python-dash-repl'), false);
  assert.equal(has(`python temp/script.py`, 'python-dash-repl'), false);
});

test('NEGATIVE: the trap INSIDE quotes is not a command (quote-masking)', () => {
  // Talking about the pattern must stay possible — in a -c program, in an echo,
  // and in a comment. A guard that cannot be discussed cannot be documented.
  assert.equal(has(`python -c "print('python - <<EOF')"`, 'python-dash-repl'), false);
  assert.equal(has(`echo "never run python - <<EOF"`, 'python-dash-repl'), false);
  assert.equal(has(`# python - <<'EOF' is forbidden`, 'python-dash-repl'), false);
});

// ------------------------------------------------------- rule-level failure
test('a rule that THROWS becomes a finding — it is not silently a pass', () => {
  // A crashing rule produced no verdict. Swallowing the throw made a broken rule
  // indistinguishable from a satisfied one, which is the gate-that-cannot-fail
  // shape. Verified through the real evaluate(), by handing it input that is not
  // a string so `raw.split` throws inside every rule.
  const findings = evaluate({ not: 'a string' });
  assert.ok(findings.length > 0, 'a throwing rule must not read as a pass');
  assert.ok(
    findings.every((f) => /-ERRORED$/.test(f.id)),
    `expected only ERRORED findings, got ${findings.map((f) => f.id).join(', ')}`,
  );
  assert.ok(/NOT a pass/.test(findings[0].message));
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
