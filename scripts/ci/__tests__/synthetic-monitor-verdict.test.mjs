/**
 * synthetic-monitor verdict self-test (#4065).
 *
 * WHAT WENT WRONG, AND WHAT THESE TESTS HOLD DOWN
 * -----------------------------------------------
 * `loom-synthetic-monitor.yml` printed `realFails>0` on 25 consecutive runs in
 * which BOTH of its result queries returned zero rows. The count was never
 * measured; only the Container App execution status was. So the assertions here
 * are all about the DISTANCE between "the execution failed" and "the journeys
 * failed" — the moment those two collapse back into one, a test goes red.
 *
 * ROUND 2 added two more distances, each after a reviewer defeated the first cut:
 *
 *   1. Between "a row exists" and "a row about THIS execution exists". The ACA
 *      job carries its own 15-minute schedule trigger, so a query bounded only
 *      by time or job name spans a dozen prior executions — and one of their
 *      UAT_REAL_FAILS lines, promoted, names the wrong execution as failing.
 *      Covered on both sides: the module refuses uncorrelated rows, AND the
 *      WORKFLOW section below reads the real YAML and fails if a branch claims
 *      correlation while its query has lost the scoping filter.
 *   2. Between "the module is correct" and "the module is WIRED". The 19
 *      round-1 tests imported the module directly and never read the workflow,
 *      so deleting the invocation left every one of them green — and
 *      check-ci-guard-reachability.mjs does not cover a `-verdict.mjs`
 *      (measured: its classifier accepts `-verdict.sh` only), so nothing else
 *      watched it either.
 *
 * MUTATION CONTROLS (a verdict that cannot change is not a verdict)
 *   - `MUTATION: …` tests rewrite the module source (or the workflow text) to
 *     reintroduce the exact defect, then assert the guarding assertion FLIPS.
 *     A control that passes against both the fixed and the broken subject has
 *     measured nothing, so each one asserts the mutant misbehaves AND that the
 *     real subject does not.
 *   - Each state test also carries its own inverse: flip one input (add a
 *     `realFails=2`, add a `UAT_REAL_FAILS` line, set status Succeeded) and the
 *     verdict must move.
 *
 * Run: node --test scripts/ci/__tests__/synthetic-monitor-verdict.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syntheticMonitorVerdict, parseRealFails } from '../synthetic-monitor-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'synthetic-monitor-verdict.mjs');
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WORKFLOW = resolve(REPO_ROOT, '.github', 'workflows', 'loom-synthetic-monitor.yml');

/** The execution every fixture below is a verdict ABOUT. */
const EXEC = 'loom-synthetic-monitor-06cuztq';

/**
 * The run measured on 2026-08-25T14:04:39Z, reproduced exactly: the execution
 * went Running -> Failed in ~65s and BOTH queries succeeded with zero rows.
 */
const ZERO_ROWS_FAILED = () => ({
  status: 'Failed',
  execution: EXEC,
  jobName: 'loom-synthetic-monitor',
  resourceGroup: 'rg-csa-loom-admin-centralus',
  uat: { state: 'zero-rows', line: null, rc: 0 },
  journeys: { state: 'zero-rows', lines: [], rc: 0 },
});

// ---------------------------------------------------------------- (a) UNKNOWN

test('(a) zero rows + status=Failed -> UNKNOWN, non-zero exit, and NO realFails claim', () => {
  const r = syntheticMonitorVerdict(ZERO_ROWS_FAILED());
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'no-journey-data');
  assert.notEqual(r.exitCode, 0, 'UNKNOWN must still fail the run — failing closed is correct');
  assert.equal(r.realFails, null, 'an absent count is null, never 0 and never >0');

  assert.match(r.message, /UNKNOWN/);
  assert.match(r.message, /only thing\s+established/i);
  // The specific over-claim that started this. It must not reappear in ANY form.
  assert.doesNotMatch(r.message, /realFails\s*>\s*0/);
  assert.doesNotMatch(r.message, /JOURNEYS FAILED/);
});

test('(a) the no-data remediation points at EXECUTION diagnostics, not at the empty tables', () => {
  const r = syntheticMonitorVerdict(ZERO_ROWS_FAILED());
  const rem = r.remediation.join('\n');

  // Where the evidence actually is for a job that dies in ~65s with no output.
  assert.match(rem, /az containerapp job execution show/);
  assert.match(rem, /az containerapp job replica list/);
  assert.match(rem, /ContainerAppSystemLogs_CL/);
  assert.match(rem, /ErrImagePull/);

  // Where it is NOT: the console-log table was measured empty for these
  // executions across all 25 runs.
  assert.doesNotMatch(rem, /ContainerAppConsoleLogs_CL/);
  // NOTE — the /admin/health Journeys tab is deliberately NOT asserted absent.
  // Round 1 asserted it was, on the reasoning that it too was "empty by
  // construction". Measured since: that tab is served by
  // lib/admin/synthetic-runs-reader.ts from BLOB artifacts
  // (uat-runs/synthetic/<runId>/verdicts.ndjson in LOOM_UAT_RESULTS_ACCOUNT),
  // a different store from ContainerAppConsoleLogs_CL, and it lists the last N
  // runs rather than this execution. Zero console rows establishes nothing
  // about it, so a test enforcing its absence would be pinning an inference —
  // which is the R7 error this whole change removes.
});

test('(a) a query that FAILED is also UNKNOWN — a read that did not happen is not a measurement', () => {
  const i = ZERO_ROWS_FAILED();
  i.uat = { state: 'query-failed', rc: 2 };
  i.journeys = { state: 'query-failed', rc: 2 };
  const r = syntheticMonitorVerdict(i);
  assert.equal(r.verdict, 'unknown');
  assert.notEqual(r.exitCode, 0);
  assert.match(r.evidence.join('\n'), /UNKNOWN, not zero failures/);
  assert.match(r.evidence.join('\n'), /UNKNOWN, not "no journey failed"/);
});

test('(a) no workspace at all -> still UNKNOWN, and says the queries were NOT ATTEMPTED', () => {
  const i = ZERO_ROWS_FAILED();
  i.uat = { state: 'not-attempted' };
  i.journeys = { state: 'not-attempted' };
  const r = syntheticMonitorVerdict(i);
  assert.equal(r.verdict, 'unknown');
  assert.match(r.evidence.join('\n'), /NOT ATTEMPTED/);
});

// ------------------------------------------------- (b) real failing journeys

test('(b) a UAT_RESULT row with realFails=2 -> journeys-failed, and cites the count it read', () => {
  const i = ZERO_ROWS_FAILED();
  i.uat = { state: 'row', line: 'UAT_RESULT pass=4 fail=2 skip=0 realFails=2 infraGated=0', rc: 0, correlatedTo: EXEC };
  const r = syntheticMonitorVerdict(i);
  assert.equal(r.verdict, 'journeys-failed');
  assert.equal(r.reason, 'uat-result-real-fails');
  assert.equal(r.exitCode, 1);
  assert.equal(r.realFails, 2);
  assert.match(r.message, /JOURNEYS FAILED/);
  assert.match(r.message, /realFails=2/);
  // With real evidence in hand the console-log pointer is correct again.
  assert.match(r.remediation.join('\n'), /ContainerAppConsoleLogs_CL/);
});

test('(b) a UAT_REAL_FAILS console line -> journeys-failed even without a UAT_RESULT row', () => {
  const i = ZERO_ROWS_FAILED();
  i.journeys = {
    state: 'rows',
    lines: [
      'synthetic J1 TRUE MSAL login probe',
      'UAT_REAL_FAILS app=console crashes=[j3-editor] empties=[] infraGatedSteps=0',
    ],
    rc: 0,
    correlatedTo: EXEC,
  };
  const r = syntheticMonitorVerdict(i);
  assert.equal(r.verdict, 'journeys-failed');
  assert.equal(r.reason, 'uat-real-fails-line');
  assert.equal(r.exitCode, 1);
});

test('(b) INVERSE — realFails=0 is NOT a failing-journey claim, it is UNKNOWN', () => {
  // The runner counted zero real failures, yet the execution is non-Succeeded.
  // That contradiction is real information, and it is still not `realFails>0`.
  const i = ZERO_ROWS_FAILED();
  i.uat = { state: 'row', line: 'UAT_RESULT pass=6 fail=0 skip=0 realFails=0 infraGated=1', rc: 0, correlatedTo: EXEC };
  const r = syntheticMonitorVerdict(i);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.realFails, 0);
  assert.doesNotMatch(r.message, /realFails\s*>\s*0/);
});

test('(b) UAT_FAIL alone is NOT promoted to a real failure — it covers honest infra gates too', () => {
  // run-uat-unattended.mjs enumerates EVERY failing spec, gated or not, and
  // exits 0 when all of them are gated. Treating UAT_FAIL as proof would
  // rebuild the over-claim in a new costume.
  const i = ZERO_ROWS_FAILED();
  i.journeys = {
    state: 'rows',
    lines: [
      'synthetic J4 warehouse query',
      'UAT_FAIL synthetic-journeys.uat.ts:210 › J4 warehouse query :: LOOM_WAREHOUSE_BACKEND not set',
    ],
    rc: 0,
    correlatedTo: EXEC,
  };
  const r = syntheticMonitorVerdict(i);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'gated-fails-only');
  assert.match(r.message, /UAT_FAIL covers honest infra gates/);
});

// ------------------------------------------------------------- (c) success

test('(c) status=Succeeded -> succeeded, exit 0', () => {
  const i = ZERO_ROWS_FAILED();
  i.status = 'Succeeded';
  const r = syntheticMonitorVerdict(i);
  assert.equal(r.verdict, 'succeeded');
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.remediation, []);
});

test('a job that is not deployed is a SKIP, not a journey verdict', () => {
  const i = ZERO_ROWS_FAILED();
  i.status = 'NotDeployed';
  const r = syntheticMonitorVerdict(i);
  assert.equal(r.verdict, 'not-deployed');
  assert.equal(r.exitCode, 0);
  assert.match(r.message, /nothing is claimed about them/);
});

test('every non-Succeeded status fails closed (TimedOut / Degraded / Cancelled / Unknown)', () => {
  for (const status of ['TimedOut', 'Degraded', 'Cancelled', 'Unknown', 'StartFailed']) {
    const i = ZERO_ROWS_FAILED();
    i.status = status;
    const r = syntheticMonitorVerdict(i);
    assert.equal(r.verdict, 'unknown', `${status} should be UNKNOWN with no journey data`);
    assert.equal(r.exitCode, 1, `${status} must fail the run`);
  }
});

// ------------------------------------------------------------ parseRealFails

test('parseRealFails: absent token -> null (UNKNOWN), never 0', () => {
  assert.equal(parseRealFails(null), null);
  assert.equal(parseRealFails(''), null);
  assert.equal(parseRealFails('UAT_RESULT pass=6 fail=0 skip=0'), null);
  assert.equal(parseRealFails('realFailsX=3'), null);
  assert.equal(parseRealFails('UAT_RESULT pass=6 fail=0 skip=0 realFails=0 infraGated=1'), 0);
  assert.equal(parseRealFails('UAT_RESULT exit_code=1 realFails=3 infraGated=0'), 3);
  assert.equal(parseRealFails('UAT_RESULT pass=1 realFails=12'), 12);
});

test('parseRealFails: a PREFIXED token is a different field, not this one', () => {
  // The leading boundary was previously asserted only via `realFailsX=3`, which
  // a boundary-free /realFails=(\d+)/ ALSO rejects — so that case could not
  // discriminate the two regexes and the leading `(?:^|\s)` was untested.
  // These can only pass with the leading boundary present.
  assert.equal(parseRealFails('xrealFails=3'), null);
  assert.equal(parseRealFails('UAT_RESULT pass=1 gatedRealFails=7'), null);
  assert.equal(parseRealFails('UAT_RESULT pass=1 my_realFails=7'), null);
  // Positive control on the same shape: with the separator it IS this field.
  assert.equal(parseRealFails('UAT_RESULT pass=1 realFails=7'), 7);
});

// ------------------------------------------------------------------- the CLI

test('CLI: zero-rows Failed exits non-zero and its ::error:: annotation makes NO realFails claim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synthmon-'));
  const outFile = join(dir, 'gh_output');
  writeFileSync(outFile, '');
  const r = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--status', 'Failed',
      '--execution', 'loom-synthetic-monitor-06cuztq',
      '--job', 'loom-synthetic-monitor',
      '--resource-group', 'rg-csa-loom-admin-centralus',
      '--uat-state', 'zero-rows',
      '--journeys-state', 'zero-rows',
    ],
    { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outFile } },
  );
  assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /::error::/);
  assert.match(r.stdout, /UNKNOWN/);
  assert.doesNotMatch(r.stdout, /realFails\s*>\s*0/);
  assert.match(r.stdout, /az containerapp job replica list/);

  const written = readFileSync(outFile, 'utf8');
  assert.match(written, /^verdict=unknown$/m);
  assert.match(written, /^verdict_reason=no-journey-data$/m);
  // The published payload must not be TRUNCATED. At the first cap (900) the
  // 933-char remediation lost its tail — so assert the LAST command survives
  // intact, not merely that some substring of it is present. (A `.includes()`
  // on an early token passes at 900 and proves nothing; measured.)
  const remLine = written.split('\n').find((l) => l.startsWith('verdict_remediation='));
  assert.ok(remLine, 'verdict_remediation was not written');
  for (const needle of [
    'az containerapp job execution show',
    'az containerapp job replica list',
    'az containerapp job logs show',
    'ContainerAppSystemLogs_CL',
    'properties.template.containers',
  ]) {
    assert.ok(remLine.includes(needle), `remediation lost: ${needle}`);
  }
  assert.ok(
    remLine.trimEnd().endsWith('tag actually referenced + env/secretref names'),
    `remediation TRUNCATED — tail is: …${remLine.slice(-60)}`,
  );
  const msgLine = written.split('\n').find((l) => l.startsWith('verdict_message='));
  assert.ok(msgLine.trimEnd().endsWith('detector.)'), `verdict_message truncated: …${msgLine.slice(-60)}`);
  // GITHUB_OUTPUT is a single-line channel without a heredoc: a stray newline
  // here would corrupt every following key.
  for (const line of written.split('\n')) {
    if (line === '') continue;
    assert.match(line, /^[a-z_]+=.*$/, `malformed GITHUB_OUTPUT line: ${line}`);
  }
});

test('CLI: a real UAT_RESULT row read from a FILE exits 1 with the failure verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synthmon-'));
  const uatFile = join(dir, 'uat.txt');
  // Deliberately carries a backtick and a `${` — log text must never be
  // re-evaluated as code on the way in (the github-script SyntaxError class).
  writeFileSync(uatFile, 'UAT_RESULT pass=4 fail=2 skip=0 realFails=2 infraGated=0 `${x}`\r\n');
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--status', 'Failed', '--execution', 'e1', '--uat-state', 'row', '--uat-file', uatFile,
      '--uat-correlation', 'e1', '--journeys-state', 'zero-rows'],
    { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' } },
  );
  assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /JOURNEYS FAILED/);
  assert.match(r.stdout, /realFails=2/);
});

test('CLI: the SAME row without --uat-correlation is UNKNOWN, not a journey failure', () => {
  // The correlation flag is the whole difference between "this execution's
  // journeys failed" and "a row exists somewhere in this job's history".
  // Dropping it must change the verdict — if it does not, the flag is decoration.
  const dir = mkdtempSync(join(tmpdir(), 'synthmon-uncorr-'));
  const uatFile = join(dir, 'uat.txt');
  writeFileSync(uatFile, 'UAT_RESULT pass=4 fail=2 skip=0 realFails=2 infraGated=0\n');
  const args = ['--status', 'Failed', '--execution', 'e1', '--uat-state', 'row', '--uat-file', uatFile,
    '--journeys-state', 'zero-rows'];
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' },
  });
  assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /UNKNOWN/);
  assert.doesNotMatch(r.stdout, /JOURNEYS FAILED/);
  assert.match(r.stdout, /DISCARDED/);

  // The empty-string form the workflow emits when its branch never set the
  // token (UAT_CORR= stays empty) must behave identically to absent.
  const rEmpty = spawnSync(process.execPath, [SCRIPT, ...args, '--uat-correlation', ''], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' },
  });
  assert.equal(rEmpty.status, 1);
  assert.doesNotMatch(rEmpty.stdout, /JOURNEYS FAILED/);

  // A DIFFERENT execution's token must not correlate either — this is the
  // stale-row shape: the query ran, it returned a row, the row is someone
  // else's.
  const rOther = spawnSync(process.execPath, [SCRIPT, ...args, '--uat-correlation', 'e0-previous'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' },
  });
  assert.equal(rOther.status, 1);
  assert.doesNotMatch(rOther.stdout, /JOURNEYS FAILED/);

  // ...and the POSITIVE control on the same command line, so a green here can
  // never mean "the CLI refuses everything".
  const rOk = spawnSync(process.execPath, [SCRIPT, ...args, '--uat-correlation', 'e1'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' },
  });
  assert.equal(rOk.status, 1);
  assert.match(rOk.stdout, /JOURNEYS FAILED/);
});

test('CLI: Succeeded exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--status', 'Succeeded', '--execution', 'e1'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
});

test('CLI: no --status is a usage error (exit 2), never a silent pass', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

// -------------------------------------------------- (d) EXECUTION CORRELATION
//
// A row is evidence about the execution it came FROM. The ACA job carries its
// own */15 schedule trigger, so a query bounded by time or job name spans many
// executions; promoting one of THEIR rows names the wrong execution as having
// failing journeys — the #4065 over-claim on a new evidence path.

test('(d) a UAT_REAL_FAILS line from ANOTHER execution does not become this one\'s failure', () => {
  const i = ZERO_ROWS_FAILED();
  i.journeys = {
    state: 'rows',
    lines: ['UAT_REAL_FAILS app=console crashes=[j3-editor] empties=[] infraGatedSteps=0'],
    rc: 0,
    correlatedTo: 'loom-synthetic-monitor-PREVIOUS',
  };
  const r = syntheticMonitorVerdict(i);
  assert.equal(r.verdict, 'unknown', 'a prior execution\'s line is not this execution\'s verdict');
  assert.equal(r.reason, 'uncorrelated-evidence');
  assert.equal(r.exitCode, 1, 'still fails closed');
  assert.doesNotMatch(r.message, /JOURNEYS FAILED/);
  assert.match(r.evidence.join('\n'), /DISCARDED/);
  // ...and the remediation sends the reader to the SCOPED read, not to a window.
  assert.match(r.remediation.join('\n'), new RegExp(`ContainerGroupName_s startswith '${EXEC}'`));

  // POSITIVE CONTROL, same line, correct token: it MUST be promoted, or this
  // test is only proving the module rejects everything.
  i.journeys.correlatedTo = EXEC;
  const ok = syntheticMonitorVerdict(i);
  assert.equal(ok.verdict, 'journeys-failed');
  assert.equal(ok.reason, 'uat-real-fails-line');
});

test('(d) a stale UAT_RESULT row is not this execution\'s realFails count', () => {
  const i = ZERO_ROWS_FAILED();
  i.uat = { state: 'row', line: 'UAT_RESULT pass=4 fail=2 skip=0 realFails=2 infraGated=0', rc: 0 };
  // correlatedTo omitted entirely — the shape produced by a query with no
  // execution filter.
  const r = syntheticMonitorVerdict(i);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'uncorrelated-evidence');
  assert.equal(r.realFails, null, 'an uncorrelated count must not be reported as this run\'s');
  assert.doesNotMatch(r.message, /realFails\s*>\s*0/);

  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    i.uat.correlatedTo = bad;
    assert.equal(
      syntheticMonitorVerdict(i).verdict,
      'unknown',
      `correlatedTo=${JSON.stringify(bad)} must not correlate`,
    );
  }
  i.uat.correlatedTo = EXEC;
  assert.equal(syntheticMonitorVerdict(i).verdict, 'journeys-failed', 'positive control');
});

test('(d) with no --execution at all NOTHING can be correlated', () => {
  // Without knowing which execution is under test there is no execution to
  // attribute a row TO. The placeholder must never satisfy the check.
  const i = ZERO_ROWS_FAILED();
  delete i.execution;
  i.uat = { state: 'row', line: 'UAT_RESULT realFails=5', rc: 0, correlatedTo: '<unknown execution>' };
  const r = syntheticMonitorVerdict(i);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'uncorrelated-evidence');
});

test('(d) correlation is only asked of DATA states — zero-rows/query-failed keep their own reasons', () => {
  // "The query returned nothing" says nothing about any execution, so there is
  // nothing to mis-attribute and no correlation to demand. If this regressed,
  // every zero-rows run would be relabelled `uncorrelated-evidence` and the
  // startup-diagnostics remediation would be lost.
  const zero = syntheticMonitorVerdict(ZERO_ROWS_FAILED());
  assert.equal(zero.reason, 'no-journey-data');
  const i = ZERO_ROWS_FAILED();
  i.uat = { state: 'query-failed', rc: 2 };
  i.journeys = { state: 'query-failed', rc: 2 };
  assert.equal(syntheticMonitorVerdict(i).reason, 'no-journey-data');
});

// ------------------------------------------------- (e) STATE CONTRACT
//
// The published QueryState type used to omit `rows` while the code required it,
// so a caller who obeyed the contract got the FALSE line "Per-journey query was
// NOT ATTEMPTED (no Log Analytics workspace resolved)" about a query that had
// run and returned rows — R7, inside the R7 module.

test('(e) both `row` and `rows` are data states on BOTH sides', () => {
  for (const spelling of ['row', 'rows']) {
    const i = ZERO_ROWS_FAILED();
    i.journeys = {
      state: spelling,
      lines: ['UAT_REAL_FAILS app=console crashes=[j1] empties=[] infraGatedSteps=0'],
      rc: 0,
      correlatedTo: EXEC,
    };
    const r = syntheticMonitorVerdict(i);
    assert.equal(r.verdict, 'journeys-failed', `journeys state '${spelling}' must be data-bearing`);
    assert.doesNotMatch(r.evidence.join('\n'), /Per-journey query was NOT ATTEMPTED/);

    const u = ZERO_ROWS_FAILED();
    u.uat = { state: spelling, line: 'UAT_RESULT realFails=2', rc: 0, correlatedTo: EXEC };
    assert.equal(syntheticMonitorVerdict(u).verdict, 'journeys-failed', `uat state '${spelling}'`);
  }
});

test('(e) an UNRECOGNISED state THROWS — it never renders as "NOT ATTEMPTED"', () => {
  for (const bad of ['Rows', 'zero_rows', 'ok', 'true', 'queryfailed']) {
    const i = ZERO_ROWS_FAILED();
    i.journeys = { state: bad, lines: [], rc: 0 };
    assert.throws(
      () => syntheticMonitorVerdict(i),
      (e) => e instanceof TypeError && /per-journey query state/.test(e.message),
      `state '${bad}' must be refused, not defaulted`,
    );
    const u = ZERO_ROWS_FAILED();
    u.uat = { state: bad, rc: 0 };
    assert.throws(() => syntheticMonitorVerdict(u), /UAT_RESULT query state/);
  }
  // Absent / null / '' remain the honest default.
  for (const empty of [undefined, null, '']) {
    const i = ZERO_ROWS_FAILED();
    i.journeys = { state: empty, lines: [], rc: 0 };
    assert.match(syntheticMonitorVerdict(i).evidence.join('\n'), /Per-journey query was NOT ATTEMPTED/);
  }
});

test('(e) CLI: a bad --journeys-state exits 2 with the reason, never a verdict', () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--status', 'Failed', '--execution', 'e1', '--journeys-state', 'Rows'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 2, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /per-journey query state/);
  assert.doesNotMatch(r.stdout, /NOT ATTEMPTED/);
});

test('(e) a data state with an EMPTY payload says so — not "NOT ATTEMPTED", not "DISCARDED"', () => {
  // The CLI reads --uat-file unconditionally, so a state/file mismatch is
  // reachable. Both wrong answers here are R7: "not attempted" denies a query
  // that ran, "discarded" claims data that never existed.
  const i = ZERO_ROWS_FAILED();
  i.uat = { state: 'row', line: '   ', rc: 0 };
  i.journeys = { state: 'rows', lines: [], rc: 0 };
  const r = syntheticMonitorVerdict(i);
  const ev = r.evidence.join('\n');
  assert.match(ev, /UAT_RESULT state says a row was returned but its payload is EMPTY/);
  assert.match(ev, /Per-journey state says rows were returned but the payload is EMPTY/);
  assert.doesNotMatch(ev, /NOT ATTEMPTED/);
  assert.doesNotMatch(ev, /DISCARDED/);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'no-journey-data', 'an empty payload is no data, not uncorrelated data');
});

// ------------------------------------- (f) a NON-DATA state carries NO line
//
// The CLI reads --uat-file unconditionally, so a zero-rows run whose temp file
// somehow has content must still count as zero rows. Without the guard the
// file's content becomes the verdict.

test('(f) a supplied line is IGNORED when the state says the query returned no data', () => {
  for (const state of ['zero-rows', 'query-failed', 'not-attempted']) {
    const i = ZERO_ROWS_FAILED();
    i.uat = { state, line: 'UAT_RESULT pass=0 fail=9 realFails=9 infraGated=0', rc: 1, correlatedTo: EXEC };
    const r = syntheticMonitorVerdict(i);
    assert.equal(r.verdict, 'unknown', `state '${state}' must not read the line`);
    assert.equal(r.realFails, null, `state '${state}' leaked realFails from a non-data state`);
    assert.doesNotMatch(r.evidence.join('\n'), /realFails=9/, `state '${state}' leaked the line into evidence`);
  }
  // POSITIVE CONTROL — the identical line under a data state DOES count.
  const ok = ZERO_ROWS_FAILED();
  ok.uat = { state: 'row', line: 'UAT_RESULT pass=0 fail=9 realFails=9 infraGated=0', rc: 0, correlatedTo: EXEC };
  assert.equal(syntheticMonitorVerdict(ok).realFails, 9);
});

test('(f) the same, through the CLI with a real non-empty --uat-file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synthmon-nondata-'));
  const uatFile = join(dir, 'uat.txt');
  writeFileSync(uatFile, 'UAT_RESULT pass=0 fail=9 skip=0 realFails=9 infraGated=0\n');
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--status', 'Failed', '--execution', 'e1', '--uat-state', 'zero-rows', '--uat-file', uatFile,
      '--uat-correlation', 'e1', '--journeys-state', 'zero-rows'],
    { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' } },
  );
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNKNOWN/);
  assert.doesNotMatch(r.stdout, /JOURNEYS FAILED/);
  assert.doesNotMatch(r.stdout, /realFails=9/);
});

// ------------------------------------------------- embedding safety

test('no verdict string carries a backtick — these get embedded in a JS template literal', () => {
  // The dedup-issue step builds its body with template literals from
  // `steps.run.outputs.verdict_message` / `verdict_remediation`. Values arrive
  // through process.env so a backtick can never become a SyntaxError (the 83-run
  // silent-alert class), but it WOULD still break the markdown code span it
  // lands in. Keep the emitted strings backtick-free at the source.
  const inputs = [
    ZERO_ROWS_FAILED(),
    { ...ZERO_ROWS_FAILED(), status: 'Succeeded' },
    { ...ZERO_ROWS_FAILED(), status: 'NotDeployed' },
    { ...ZERO_ROWS_FAILED(), uat: { state: 'row', line: 'UAT_RESULT realFails=2', rc: 0, correlatedTo: EXEC } },
    // ...and the same row UNCORRELATED, whose evidence line quotes the token.
    { ...ZERO_ROWS_FAILED(), uat: { state: 'row', line: 'UAT_RESULT realFails=2', rc: 0, correlatedTo: 'other-exec' } },
    {
      ...ZERO_ROWS_FAILED(),
      journeys: { state: 'rows', lines: ['UAT_FAIL a.ts:1 › J1 :: gate'], rc: 0, correlatedTo: EXEC },
    },
  ];
  for (const i of inputs) {
    const r = syntheticMonitorVerdict(i);
    const all = [r.message, ...r.evidence, ...r.remediation].join('\n');
    assert.ok(!all.includes('`'), `backtick in verdict output for status=${i.status}: ${all}`);
  }
});

// ------------------------------------------- (g) THE WIRING, IN THE WORKFLOW
//
// Round 1's 19 tests imported the module and never read a workflow, so DELETING
// the invocation left all 19 green. Nothing else covered it either: measured,
// check-ci-guard-reachability.mjs classifies a control as `check-*`/`test-*.sh`
// / `*-verdict.SH` / a `.mjs` carrying a quoted `--check`, and a `-verdict.mjs`
// matches none of the three — so the new file was never in its population and
// its green said nothing about this file. These assertions are that coverage.
//
// Whole-line comments are stripped FIRST. This file's own header names the
// module path several times, and a check a COMMENT can satisfy is decoration.

/** The workflow this module is the verdict for. */
function workflowText() {
  return readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
}

/** Lines with whole-line comments blanked, so only executable text can match. */
function activeLines(text) {
  return text.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l));
}

/** Index of the `run:` line that actually invokes the verdict module. */
function invocationIndex(lines) {
  return lines.findIndex((l) => /^\s*node scripts\/ci\/synthetic-monitor-verdict\.mjs(\s|\\|$)/.test(l));
}

/** The whole invocation, continuation lines folded into one string. */
function invocationCommand(lines) {
  const i = invocationIndex(lines);
  if (i < 0) return null;
  const parts = [];
  for (let j = i; j < lines.length; j += 1) {
    parts.push(lines[j]);
    if (!/\\\s*$/.test(lines[j])) break;
  }
  return parts.join(' ');
}

/** Does `VRC=$?` sit on the line IMMEDIATELY after the invocation? */
function capturesExitCode(lines) {
  const i = invocationIndex(lines);
  if (i < 0) return false;
  let j = i;
  while (j < lines.length && /\\\s*$/.test(lines[j])) j += 1;
  return /^\s*VRC=\$\?\s*$/.test(lines[j + 1] ?? '');
}

/** Is that captured code the step's own exit status? */
function propagatesExitCode(lines) {
  return lines.some((l) => /^\s*exit "\$VRC"\s*$/.test(l));
}

/** Every `<X>_CORR="$EXEC"` assignment, with its line index. */
function correlationAssignments(lines) {
  const out = [];
  lines.forEach((l, idx) => {
    const m = /^\s*([A-Z_]+_CORR)="\$EXEC"\s*$/.exec(l);
    if (m) out.push({ name: m[1], idx });
  });
  return out;
}

/**
 * The Log Analytics query whose result branch an assignment sits in: the
 * nearest `--analytics-query` above it, plus the line carrying the query text.
 * Returns null when there is none — which the caller treats as a FAILURE of
 * this harness, never as a pass.
 */
function queryFeeding(lines, idx) {
  for (let k = idx; k >= 0; k -= 1) {
    if (/--analytics-query/.test(lines[k])) return `${lines[k]}\n${lines[k + 1] ?? ''}`;
  }
  return null;
}

const SCOPE_FILTER = "ContainerGroupName_s startswith '$EXEC'";

test('(g) the workflow actually INVOKES the verdict module, in a run: body, not a comment', () => {
  const lines = activeLines(workflowText());
  assert.ok(invocationIndex(lines) >= 0, 'no executable `node scripts/ci/synthetic-monitor-verdict.mjs` line');
  // Harness health: the raw text mentions the path more than once (comments),
  // so a green above must come from the stripped view, not from a mention.
  const mentions = (workflowText().match(/scripts\/ci\/synthetic-monitor-verdict\.mjs/g) || []).length;
  assert.ok(mentions > 1, `expected the path in prose too; found ${mentions}`);
});

test('(g) the module decides the step: VRC=$? on the next line, and exit "$VRC"', () => {
  const lines = activeLines(workflowText());
  assert.ok(capturesExitCode(lines), 'VRC=$? is not on the line immediately after the invocation');
  assert.ok(propagatesExitCode(lines), 'the captured exit code is never used as the step status');
});

test('(g) every branch that CLAIMS correlation is fed by an execution-scoped query', () => {
  const lines = activeLines(workflowText());
  const assigns = correlationAssignments(lines);
  // Population control first: a zero-population loop passes vacuously.
  assert.equal(assigns.length, 2, `expected UAT_CORR + J_CORR; found ${JSON.stringify(assigns)}`);
  assert.deepEqual(assigns.map((a) => a.name).sort(), ['J_CORR', 'UAT_CORR']);
  for (const a of assigns) {
    const q = queryFeeding(lines, a.idx);
    assert.ok(q, `${a.name} has no --analytics-query above it — the harness cannot see its query`);
    assert.ok(
      q.includes(SCOPE_FILTER),
      `${a.name} claims this execution's rows, but its query is not scoped to $EXEC:\n${q}`,
    );
  }
});

test('(g) both correlation tokens are handed to the module', () => {
  const cmd = invocationCommand(activeLines(workflowText()));
  assert.ok(cmd, 'no invocation found');
  assert.match(cmd, /--uat-correlation "\$UAT_CORR"/);
  assert.match(cmd, /--journeys-correlation "\$J_CORR"/);
  // ...and the states/files it reasons over.
  for (const flag of ['--status "$STATUS"', '--execution "$EXEC"', '--uat-state "$UAT_STATE"',
    '--journeys-state "$J_STATE"']) {
    assert.ok(cmd.includes(flag), `invocation lost ${flag}`);
  }
});

test('(g) MUTATION: each wiring assertion goes RED when its subject is broken', () => {
  const real = workflowText();

  /** Apply a needle->replacement, refusing a no-op (the CRLF/typo silent pass). */
  const mutate = (needle, repl) => {
    const n = real.split(needle).length - 1;
    assert.equal(n, 1, `needle must appear exactly once, found ${n}: ${needle.slice(0, 60)}`);
    const out = real.replace(needle, repl);
    assert.notEqual(out, real, 'mutation was a no-op');
    return activeLines(out);
  };

  // M1 — delete the invocation. (g)#1 must fail.
  const m1 = mutate('node scripts/ci/synthetic-monitor-verdict.mjs \\', 'true \\');
  assert.equal(invocationIndex(m1), -1, 'M1: the invocation check cannot see its own removal');

  // M2 — keep the invocation, throw the exit code away. (g)#2 must fail.
  const m2 = mutate('          exit "$VRC"', '          true  # swallowed');
  assert.ok(invocationIndex(m2) >= 0, 'M2 must not disturb the invocation');
  assert.equal(propagatesExitCode(m2), false, 'M2: a swallowed exit code reads as propagated');

  // M2b — move VRC=$? off the line after the invocation (a pipe, or a stray
  // line between, makes the captured code someone else's).
  const m2b = mutate('          VRC=$?', '          echo "verdict done"\n          VRC=$?');
  assert.equal(capturesExitCode(m2b), false, 'M2b: a displaced VRC=$? still reads as captured');

  // M3 — THE REVIEW FINDING: drop the execution scope from the per-journey
  // query while still claiming correlation, leaving only the ago(2h) COST
  // bound. This is the exact shape that promoted a prior execution's
  // UAT_REAL_FAILS line, and it must go RED.
  const m3 = mutate(
    "| where ContainerGroupName_s startswith '$EXEC' | where Log_s has_any",
    '| where Log_s has_any',
  );
  const jAssign = correlationAssignments(m3).find((a) => a.name === 'J_CORR');
  assert.ok(jAssign, 'M3 must leave the J_CORR assignment in place — that is the point');
  const jq = queryFeeding(m3, jAssign.idx);
  assert.ok(jq, 'M3: harness lost the query');
  assert.equal(jq.includes(SCOPE_FILTER), false, 'M3: a time-window-only query still reads as execution-scoped');

  // M3b — the same for the UAT_RESULT query (which had NO filter at all).
  const m3b = mutate(
    "| where ContainerGroupName_s startswith '$EXEC' | where Log_s contains 'UAT_RESULT'",
    "| where Log_s contains 'UAT_RESULT'",
  );
  const uAssign = correlationAssignments(m3b).find((a) => a.name === 'UAT_CORR');
  assert.ok(uAssign);
  assert.equal(queryFeeding(m3b, uAssign.idx).includes(SCOPE_FILTER), false, 'M3b: unscoped UAT query reads as scoped');

  // M4 — drop a correlation flag from the invocation. (g)#4 must fail.
  const m4 = mutate(' --journeys-correlation "$J_CORR"', '');
  assert.doesNotMatch(invocationCommand(m4), /--journeys-correlation/, 'M4: a dropped flag still reads as present');

  // ...and every one of these predicates is TRUE on the real file, so none of
  // the reds above is a predicate that simply never passes.
  const now = activeLines(real);
  assert.ok(invocationIndex(now) >= 0);
  assert.ok(capturesExitCode(now));
  assert.ok(propagatesExitCode(now));
  assert.match(invocationCommand(now), /--journeys-correlation/);
  for (const a of correlationAssignments(now)) {
    assert.ok(queryFeeding(now, a.idx).includes(SCOPE_FILTER));
  }
});

// -------------------------------------------------------- MUTATION CONTROL
test('MUTATION: delete the UNKNOWN branch and the zero-rows case FLIPS to journeys-failed', async () => {
  // The old behaviour, reconstructed: treat every non-Succeeded execution as
  // proof of failing journeys. If the real module ever regresses to this, the
  // (a) tests above go red — which is what this control proves.
  const src = readFileSync(SCRIPT, 'utf8');
  const needle = '  const hasRealFailEvidence = (realFails !== null && realFails > 0) || realFailLines.length > 0;';
  assert.ok(
    src.includes(needle),
    'the evidence test moved — re-point this mutation control at its new form rather than deleting it',
  );
  const mutated = src.replace(needle, '  const hasRealFailEvidence = true; // MUTANT: the pre-#4065 over-claim');
  assert.notEqual(mutated, src, 'mutation must actually change the source');

  const dir = mkdtempSync(join(tmpdir(), 'synthmon-mutant-'));
  const mutantPath = join(dir, 'mutant.mjs');
  writeFileSync(mutantPath, mutated);
  const mutant = await import(pathToFileURL(mutantPath).href);

  const r = mutant.syntheticMonitorVerdict(ZERO_ROWS_FAILED());
  assert.equal(r.verdict, 'journeys-failed', 'the mutant must reproduce the defect');

  // And the assertions that guard (a) must be the ones that catch it.
  assert.throws(
    () => assert.equal(r.verdict, 'unknown'),
    'test (a) would not have caught the regression — it has no teeth',
  );
  assert.throws(
    () => assert.doesNotMatch(r.message, /JOURNEYS FAILED/),
    'the no-over-claim assertion would not have caught the regression',
  );
});

test('MUTATION: promoting UAT_FAIL to real-failure evidence flips the gated-only case', async () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const needle = 'const REAL_FAILS_LINE = /(?:^|\\s)UAT_REAL_FAILS\\s/;';
  assert.ok(src.includes(needle), 'REAL_FAILS_LINE moved — re-point this control');
  const mutated = src.replace(needle, 'const REAL_FAILS_LINE = /(?:^|\\s)UAT_(?:REAL_)?FAILS?\\s/;');
  const dir = mkdtempSync(join(tmpdir(), 'synthmon-mutant2-'));
  const mutantPath = join(dir, 'mutant.mjs');
  writeFileSync(mutantPath, mutated);
  const mutant = await import(pathToFileURL(mutantPath).href);

  const i = ZERO_ROWS_FAILED();
  i.journeys = {
    state: 'rows',
    lines: ['UAT_FAIL synthetic-journeys.uat.ts:210 › J4 :: LOOM_WAREHOUSE_BACKEND not set'],
    rc: 0,
    // Correlated on purpose: this control is about UAT_FAIL vs UAT_REAL_FAILS,
    // and it must not be able to pass merely because the row was discarded for
    // an unrelated reason.
    correlatedTo: EXEC,
  };
  assert.equal(mutant.syntheticMonitorVerdict(i).verdict, 'journeys-failed', 'mutant must over-claim');
  assert.equal(syntheticMonitorVerdict(i).verdict, 'unknown', 'the real module must not');
});

/** Build a mutant module from a single unique needle->replacement. */
async function mutantOf(needle, repl, tag) {
  const src = readFileSync(SCRIPT, 'utf8');
  const n = src.split(needle).length - 1;
  assert.equal(n, 1, `${tag}: needle must appear exactly once, found ${n}`);
  const mutated = src.replace(needle, repl);
  assert.notEqual(mutated, src, `${tag}: mutation was a no-op`);
  const dir = mkdtempSync(join(tmpdir(), `synthmon-${tag}-`));
  const p = join(dir, 'mutant.mjs');
  writeFileSync(p, mutated);
  return import(pathToFileURL(p).href);
}

test('MUTATION: dropping the correlation gate lets a PRIOR execution\'s line become this verdict', async () => {
  // The literal defect the review found: rows retrieved by an unscoped query
  // promoted to "this execution's journeys failed".
  const mutant = await mutantOf(
    '  const jCorrelated = jHasData && isCorrelated(execution, input?.journeys?.correlatedTo);',
    '  const jCorrelated = jHasData; // MUTANT: any row will do',
    'corr',
  );
  const i = ZERO_ROWS_FAILED();
  i.journeys = {
    state: 'rows',
    lines: ['UAT_REAL_FAILS app=console crashes=[j3-editor] empties=[] infraGatedSteps=0'],
    rc: 0,
    correlatedTo: 'loom-synthetic-monitor-PREVIOUS',
  };
  assert.equal(mutant.syntheticMonitorVerdict(i).verdict, 'journeys-failed', 'the mutant must misattribute');
  assert.equal(syntheticMonitorVerdict(i).verdict, 'unknown', 'the real module must refuse');
  // ...and the (d) assertion is the one that catches it.
  assert.throws(
    () => assert.equal(mutant.syntheticMonitorVerdict(i).verdict, 'unknown'),
    'test (d) has no teeth against an uncorrelated promotion',
  );
});

test('MUTATION: dropping the UAT correlation gate resurrects the stale-row claim', async () => {
  const mutant = await mutantOf(
    '  const uatCorrelated = uatHasData && isCorrelated(execution, input?.uat?.correlatedTo);',
    '  const uatCorrelated = uatHasData; // MUTANT: any row will do',
    'ucorr',
  );
  const i = ZERO_ROWS_FAILED();
  i.uat = { state: 'row', line: 'UAT_RESULT pass=4 fail=2 realFails=2 infraGated=0', rc: 0 };
  assert.equal(mutant.syntheticMonitorVerdict(i).realFails, 2, 'the mutant must read the uncorrelated count');
  assert.equal(syntheticMonitorVerdict(i).realFails, null, 'the real module must not');
});

test('MUTATION: dropping the non-data-state guard makes a zero-rows file the verdict', async () => {
  // The CLI reads --uat-file unconditionally; this guard is the only thing
  // that stops its contents counting when the query returned nothing.
  const mutant = await mutantOf(
    '  const uatLine = uatCorrelated ? (input?.uat?.line ?? null) : null;',
    '  const uatLine = input?.uat?.line ?? null; // MUTANT: trust the file',
    'nondata',
  );
  const i = ZERO_ROWS_FAILED();
  i.uat = { state: 'zero-rows', line: 'UAT_RESULT pass=0 fail=9 realFails=9 infraGated=0', rc: 0 };
  assert.equal(mutant.syntheticMonitorVerdict(i).verdict, 'journeys-failed', 'the mutant must trust the stray file');
  assert.equal(syntheticMonitorVerdict(i).verdict, 'unknown', 'the real module must not');
});

test('MUTATION: a boundary-free realFails regex accepts a PREFIXED token', async () => {
  const mutant = await mutantOf(
    "  const m = /(?:^|\\s)realFails=(\\d+)(?:\\s|$)/.exec(line);",
    '  const m = /realFails=(\\d+)/.exec(line); // MUTANT: no word boundaries',
    'rf',
  );
  assert.equal(mutant.parseRealFails('xrealFails=3'), 3, 'the mutant must accept the prefixed token');
  assert.equal(parseRealFails('xrealFails=3'), null, 'the real module must reject it');
  assert.equal(mutant.parseRealFails('realFailsX=3'), null, 'both regexes reject the SUFFIX case — which is why it could not discriminate');
});

test('MUTATION: defaulting an unrecognised state resurrects the false NOT ATTEMPTED line', async () => {
  // The pre-round-2 behaviour: any unknown state falls through the if/else
  // chain to the terminal branch, which asserts the query was never attempted
  // and that no workspace resolved — both false, about a query that ran.
  const mutant = await mutantOf(
    '  if (!VALID_STATES.has(s)) {',
    '  if (false) { // MUTANT: accept anything and let it fall through',
    'state',
  );
  const i = ZERO_ROWS_FAILED();
  i.journeys = { state: 'row', lines: ['UAT_REAL_FAILS app=console crashes=[j1] empties=[]'], rc: 0, correlatedTo: EXEC };
  // 'row' on the journeys side is the spelling the published type USED to
  // allow. Under the mutant it is unrecognised-and-defaulted...
  const bad = mutant.syntheticMonitorVerdict({ ...i, journeys: { ...i.journeys, state: 'Rows' } });
  assert.match(
    bad.evidence.join('\n'),
    /Per-journey query was NOT ATTEMPTED/,
    'the mutant must produce the false line',
  );
  // ...while the real module refuses rather than asserting it.
  assert.throws(() => syntheticMonitorVerdict({ ...i, journeys: { ...i.journeys, state: 'Rows' } }), TypeError);
  // And 'row'/'rows' both work on both sides in the real module (the round-1
  // type/implementation mismatch).
  assert.equal(syntheticMonitorVerdict(i).verdict, 'journeys-failed');
});


// ------------------------------- (h) THE CORRELATION CONTRACT, AND THE CLI'S
//                                     OWN DEFAULTS
//
// Round 2 made execution-correlation the load-bearing control: it is the only
// thing standing between "a UAT_REAL_FAILS row exists" and "THIS execution's
// journeys failed". Round 3 measured how well the suite actually held it, by
// mutating the module and re-running: 17 independent arms, 8 of which SURVIVED
// a fully green 41/41. Three classes of survivor mattered, and this section is
// each of them, with the mutant that used to live through it named in-place.
//
//   1. Correlation matched by PREFIX instead of exactly. The fixtures were
//      'e1' vs 'e0-previous' — neither is a prefix of the other, so the pair
//      could not tell `s === execution` from `execution.startsWith(s)`. That
//      is not a hypothetical drift: the QUERY deliberately uses
//      `ContainerGroupName_s startswith '$EXEC'` (replicas are
//      <execution>-<suffix>), so "make the comparison match the query" is the
//      most likely wrong turn a future editor takes — and it re-opens exactly
//      the cross-execution promotion round 2 closed, because the JOB NAME is a
//      prefix of every execution this job has ever run.
//   2. The CLI's DEFAULTS. Every (d) test calls syntheticMonitorVerdict()
//      with correlatedTo spelled out, which by construction cannot detect that
//      the CLI hands it the wrong thing. Measured: the uat side's default was
//      pinned, the journeys side's was not, so `?? a.execution` (silent
//      self-correlation — every row correlates to the run reading it) survived
//      green. Same for the query STATES: defaulting an unsupplied state to
//      'zero-rows'/'rows' asserts a measurement about a query that never ran,
//      which is this module's founding R7 error, and nothing caught it.
//   3. UAT_FAIL's word boundaries. REAL_FAILS_LINE's were pinned; the sibling
//      regex's were not.
//
// Every test below is paired with a POSITIVE control on the same inputs, so a
// green can never mean "the module refuses everything".

/** A realistic execution name, and the JOB NAME that is a prefix of it. */
const JOB = 'loom-synthetic-monitor';
const EXEC_H = `${JOB}-06cuztq`;

/** journeys rows carrying one real-failure line, scoped to `scopedTo`. */
const withJourneyRealFail = (scopedTo) => ({
  status: 'Failed',
  execution: EXEC_H,
  jobName: JOB,
  resourceGroup: 'rg-csa-loom-admin-centralus',
  uat: { state: 'zero-rows', line: null, rc: 0 },
  journeys: {
    state: 'rows',
    lines: ['UAT_REAL_FAILS app=console crashes=[j3-editor] empties=[] infraGatedSteps=0'],
    rc: 0,
    correlatedTo: scopedTo,
  },
});

test('(h) correlation is an EXACT match — the JOB NAME is a prefix of every execution and must NOT correlate', () => {
  // The shape that matters live: a query scoped only to the job name would
  // hand back rows from any of the ~12 executions inside a 2h window, and its
  // honest correlation token is the job name — which is a PREFIX of the
  // execution under test.
  const byJobName = syntheticMonitorVerdict(withJourneyRealFail(JOB));
  assert.equal(byJobName.verdict, 'unknown', 'a job-name-scoped row must not become this execution s failure');
  assert.equal(byJobName.reason, 'uncorrelated-evidence');
  assert.doesNotMatch(byJobName.message, /JOURNEYS FAILED/);

  // ...and the other direction: a token that merely EXTENDS the execution name
  // (a replica name, say) is also not the execution.
  const byReplica = syntheticMonitorVerdict(withJourneyRealFail(`${EXEC_H}-xhk2p`));
  assert.equal(byReplica.verdict, 'unknown');
  assert.equal(byReplica.reason, 'uncorrelated-evidence');

  // POSITIVE CONTROL — the exact token still promotes, so the two reds above
  // are about exactness and not about a gate that refuses everything.
  const exact = syntheticMonitorVerdict(withJourneyRealFail(EXEC_H));
  assert.equal(exact.verdict, 'journeys-failed');
  assert.match(exact.message, /JOURNEYS FAILED/);
});

test('(h) MUTATION: prefix-matching correlation resurrects the cross-execution promotion', async () => {
  // Both directions of the loosening, because they are different edits and the
  // old fixture pair ('e1' / 'e0-previous') was blind to each of them.
  const needle = "  return s === execution && execution !== '' && execution !== UNKNOWN_EXECUTION;";

  const wide = await mutantOf(
    needle,
    "  return execution.startsWith(s) && execution !== '' && execution !== UNKNOWN_EXECUTION; // MUTANT",
    'corrprefix',
  );
  assert.equal(
    wide.syntheticMonitorVerdict(withJourneyRealFail(JOB)).verdict,
    'journeys-failed',
    'the mutant must promote a job-name-scoped row',
  );
  assert.equal(syntheticMonitorVerdict(withJourneyRealFail(JOB)).verdict, 'unknown', 'the real module must not');

  const narrow = await mutantOf(
    needle,
    "  return s.startsWith(execution) && execution !== '' && execution !== UNKNOWN_EXECUTION; // MUTANT",
    'corrextend',
  );
  const replicaToken = `${EXEC_H}-xhk2p`;
  assert.equal(
    narrow.syntheticMonitorVerdict(withJourneyRealFail(replicaToken)).verdict,
    'journeys-failed',
    'the mutant must promote an extended token',
  );
  assert.equal(syntheticMonitorVerdict(withJourneyRealFail(replicaToken)).verdict, 'unknown');
});

test('(h) UAT_FAIL needs whole-token boundaries too, not just UAT_REAL_FAILS', () => {
  const base = () => ({
    status: 'Failed',
    execution: EXEC_H,
    jobName: JOB,
    uat: { state: 'zero-rows', line: null, rc: 0 },
    journeys: { state: 'rows', rc: 0, correlatedTo: EXEC_H, lines: [] },
  });

  // A line that merely CONTAINS the token inside a longer word is a different
  // field, exactly as `xrealFails=3` is.
  const embedded = base();
  embedded.journeys.lines = ['synthetic J2 warehouse ok NOUAT_FAIL residue'];
  const r = syntheticMonitorVerdict(embedded);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'no-real-fail-markers', 'an embedded token was counted as a UAT_FAIL');

  // POSITIVE CONTROL — a properly delimited UAT_FAIL still registers, and moves
  // the reason to the gated-only branch.
  const real = base();
  real.journeys.lines = ['UAT_FAIL synthetic-journeys.uat.ts:210 > J4 :: LOOM_WAREHOUSE_BACKEND not set'];
  assert.equal(syntheticMonitorVerdict(real).reason, 'gated-fails-only');
});

test('(h) MUTATION: a boundary-free UAT_FAIL regex counts an embedded token', async () => {
  const mutant = await mutantOf(
    "const ANY_FAIL_LINE = /(?:^|\\s)UAT_FAIL\\s/;",
    'const ANY_FAIL_LINE = /UAT_FAIL/; // MUTANT: no word boundaries',
    'anyfail',
  );
  const i = {
    status: 'Failed',
    execution: EXEC_H,
    jobName: JOB,
    uat: { state: 'zero-rows', line: null, rc: 0 },
    journeys: { state: 'rows', rc: 0, correlatedTo: EXEC_H, lines: ['synthetic J2 ok NOUAT_FAIL residue'] },
  };
  assert.equal(mutant.syntheticMonitorVerdict(i).reason, 'gated-fails-only', 'the mutant must miscount');
  assert.equal(syntheticMonitorVerdict(i).reason, 'no-real-fail-markers', 'the real module must not');
});

// ---- the CLI's own defaults. These drive the REAL entry point with the flags
// ---- OMITTED, which is the only way to observe what it substitutes.

test('(h) CLI: the JOURNEYS correlation default is ABSENT, never the execution under test', () => {
  // The uat side of this was already pinned; the journeys side was not, and
  // `?? a.execution` (every row silently correlates to whoever is reading it)
  // survived a green suite.
  const dir = mkdtempSync(join(tmpdir(), 'synthmon-jdefault-'));
  const jFile = join(dir, 'j.txt');
  writeFileSync(jFile, 'UAT_REAL_FAILS app=console crashes=[j3-editor] empties=[] infraGatedSteps=0\n');
  const args = [SCRIPT, '--status', 'Failed', '--execution', EXEC_H, '--uat-state', 'zero-rows',
    '--journeys-state', 'rows', '--journeys-file', jFile];

  const bare = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(bare.status, 1, `stdout:\n${bare.stdout}\nstderr:\n${bare.stderr}`);
  assert.match(bare.stdout, /UNKNOWN/);
  assert.doesNotMatch(bare.stdout, /JOURNEYS FAILED/);
  assert.match(bare.stdout, /DISCARDED/);

  // POSITIVE CONTROL — supplying the token on the same command line promotes.
  const corr = spawnSync(process.execPath, [...args, '--journeys-correlation', EXEC_H], { encoding: 'utf8' });
  assert.equal(corr.status, 1);
  assert.match(corr.stdout, /JOURNEYS FAILED/);
});

test('(h) CLI: an unsupplied query state is NOT ATTEMPTED — never a measurement nobody took', () => {
  // Both files are supplied and both correlate; ONLY the states are omitted.
  // So if a default ever becomes a data state the lines below get promoted,
  // and if it becomes 'zero-rows' the module reports a query that never ran as
  // having returned nothing.
  const dir = mkdtempSync(join(tmpdir(), 'synthmon-statedefault-'));
  const uatFile = join(dir, 'uat.txt');
  const jFile = join(dir, 'j.txt');
  writeFileSync(uatFile, 'UAT_RESULT pass=4 fail=2 skip=0 realFails=2 infraGated=0\n');
  writeFileSync(jFile, 'UAT_REAL_FAILS app=console crashes=[j3-editor] empties=[] infraGatedSteps=0\n');

  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--status', 'Failed', '--execution', EXEC_H,
      '--uat-file', uatFile, '--uat-correlation', EXEC_H,
      '--journeys-file', jFile, '--journeys-correlation', EXEC_H],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /UAT_RESULT query was NOT ATTEMPTED/);
  assert.match(r.stdout, /Per-journey query was NOT ATTEMPTED/);
  assert.doesNotMatch(r.stdout, /JOURNEYS FAILED/);
  assert.doesNotMatch(r.stdout, /realFails=2/);
});

test('(h) CLI: a valueless flag does not swallow the NEXT flag as its value', () => {
  // `--uat-correlation` with nothing after it (the shape a future edit produces
  // by dropping the quotes around an empty $UAT_CORR) must not consume
  // `--journeys-state`, or the journeys side silently reverts to NOT ATTEMPTED
  // while the run still reports a state it was handed.
  const dir = mkdtempSync(join(tmpdir(), 'synthmon-argv-'));
  const uatFile = join(dir, 'uat.txt');
  writeFileSync(uatFile, 'UAT_RESULT pass=4 fail=2 skip=0 realFails=2 infraGated=0\n');
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--status', 'Failed', '--execution', EXEC_H, '--uat-state', 'row', '--uat-file', uatFile,
      '--uat-correlation', '--journeys-state', 'zero-rows'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  // The journeys state SURVIVED the valueless flag ahead of it.
  assert.match(r.stdout, /Per-journey query succeeded with ZERO ROWS/);
  // ...and the uat row is uncorrelated (its token became the literal 'true'),
  // so it is discarded rather than promoted.
  assert.doesNotMatch(r.stdout, /JOURNEYS FAILED/);
});

// ---- and the other half of the wiring: the workflow must hand the module
// ---- every input it READS, not just the ones someone remembered to list.

/**
 * The module's real CLI input contract, DERIVED from its source rather than
 * transcribed. A hand-kept list is a second thing to forget — and forgetting
 * it is the defect this test exists for, so it must not be the mechanism.
 */
function moduleInputFlags() {
  const src = readFileSync(SCRIPT, 'utf8');
  const flags = new Set();
  for (const m of src.matchAll(/\ba\['([a-z0-9-]+)'\]/g)) flags.add(m[1]);
  for (const m of src.matchAll(/\ba\.([a-zA-Z][a-zA-Z0-9]*)/g)) flags.add(m[1]);
  return [...flags].sort();
}

/** Which of `flags` the invocation never passes. */
const missingFlags = (cmd, flags) => flags.filter((f) => !cmd.includes(`--${f} `));

test('(h) the workflow hands the module EVERY input it reads', () => {
  // MEASURED gap this closes: section (g) pinned the states and the correlation
  // tokens, but not the PAYLOAD flags — so deleting `--journeys-file "$J_FILE"`
  // from the production invocation left all 48 tests green. The consequence is
  // not a smaller verdict, it is a dead one: with no journey file the module
  // can never see a UAT_REAL_FAILS line again, so every future run resolves to
  // `unknown`/`no-journey-data` and the monitor silently loses real-failure
  // detection entirely, with every gate still green. That is the hollow-control
  // shape, one level out from the module.
  const flags = moduleInputFlags();
  // Population control FIRST: a derivation that quietly returns [] would make
  // the loop below pass vacuously, which is the same defect wearing a hat.
  assert.ok(flags.length >= 12, `derived only ${flags.length} input flags: ${JSON.stringify(flags)}`);
  for (const required of ['uat-file', 'journeys-file', 'uat-state', 'journeys-state',
    'uat-correlation', 'journeys-correlation', 'status', 'execution']) {
    assert.ok(flags.includes(required), `the derivation lost --${required}; it is no longer watching`);
  }

  const cmd = invocationCommand(activeLines(workflowText()));
  assert.ok(cmd, 'no invocation found');
  assert.deepEqual(
    missingFlags(cmd, flags),
    [],
    'the module reads these inputs and the workflow never passes them',
  );
});

test('(h) MUTATION: dropping ANY single input flag from the invocation is detected', () => {
  const flags = moduleInputFlags();
  const cmd = invocationCommand(activeLines(workflowText()));

  // Every flag individually, so this cannot pass because one loud one is
  // covered while the quiet ones are not.
  for (const f of flags) {
    const broken = cmd.replace(`--${f} `, `--renamed-${f} `);
    assert.notEqual(broken, cmd, `mutation for --${f} was a no-op`);
    assert.deepEqual(
      missingFlags(broken, flags),
      [f],
      `dropping --${f} from the invocation is not detected`,
    );
  }

  // ...and the real invocation is clean, so none of the reds above comes from
  // a predicate that simply never passes.
  assert.deepEqual(missingFlags(cmd, flags), []);
});

test('(h) every input the workflow passes is a QUOTED shell variable, never a literal', () => {
  // Two defects in one property.
  //
  //   1. A hardcoded value. `--journeys-state rows` or `--job loom-monitor`
  //      keeps the flag present (so the contract test above still passes) while
  //      detaching it from what the run actually measured — a measurement
  //      asserted regardless of what happened, which is this module's founding
  //      R7 error moved to the call site.
  //   2. An UNQUOTED expansion. `--uat-correlation $UAT_CORR` with an empty
  //      UAT_CORR does not pass an empty argument, it passes NOTHING — the flag
  //      becomes valueless and swallows the flag after it. The CLI-side of that
  //      is covered above; this is the side that produces it.
  const flags = moduleInputFlags();
  const cmd = invocationCommand(activeLines(workflowText()));
  assert.ok(cmd, 'no invocation found');
  assert.ok(flags.length >= 12, `derived only ${flags.length} input flags`);

  const notVariableFed = flags.filter((f) => !cmd.includes(`--${f} "$`));
  assert.deepEqual(
    notVariableFed,
    [],
    'these inputs are not fed by a quoted shell variable (hardcoded, or unquoted and therefore droppable)',
  );
});

test('(h) MUTATION: hardcoding or unquoting any input is detected', () => {
  const flags = moduleInputFlags();
  const cmd = invocationCommand(activeLines(workflowText()));
  const notVariableFed = (c) => flags.filter((f) => !c.includes(`--${f} "$`));

  for (const f of flags) {
    // Hardcoded literal in place of the variable.
    const hard = cmd.replace(new RegExp(`--${f} "\\$[A-Z_]+"`), `--${f} a-literal-value`);
    assert.notEqual(hard, cmd, `hardcode mutation for --${f} was a no-op`);
    assert.deepEqual(notVariableFed(hard), [f], `a hardcoded --${f} is not detected`);

    // Same variable, quotes removed — the empty-value argv shift.
    const bare = cmd.replace(new RegExp(`--${f} "(\\$[A-Z_]+)"`), `--${f} $1`);
    assert.notEqual(bare, cmd, `unquote mutation for --${f} was a no-op`);
    assert.deepEqual(notVariableFed(bare), [f], `an unquoted --${f} is not detected`);
  }

  assert.deepEqual(notVariableFed(cmd), [], 'the real invocation must be clean');
});
