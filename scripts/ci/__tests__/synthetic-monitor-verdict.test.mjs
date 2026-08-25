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
 * MUTATION CONTROLS (a verdict that cannot change is not a verdict)
 *   - `MUTATION: …` at the end rewrites the module's evidence test to be
 *     unconditionally true — i.e. restores the old "always blame the journeys"
 *     behaviour — and asserts the zero-rows case FLIPS to `journeys-failed`.
 *     If someone deletes the UNKNOWN branch, that mutant becomes the real file
 *     and the zero-rows tests below go red. The control proves they can.
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

/**
 * The run measured on 2026-08-25T14:04:39Z, reproduced exactly: the execution
 * went Running -> Failed in ~65s and BOTH queries succeeded with zero rows.
 */
const ZERO_ROWS_FAILED = () => ({
  status: 'Failed',
  execution: 'loom-synthetic-monitor-06cuztq',
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

  // Where it is NOT: both of these were empty across all 25 runs.
  assert.doesNotMatch(rem, /ContainerAppConsoleLogs_CL/);
  assert.doesNotMatch(rem, /admin\/health/);
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
  i.uat = { state: 'row', line: 'UAT_RESULT pass=4 fail=2 skip=0 realFails=2 infraGated=0', rc: 0 };
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
  i.uat = { state: 'row', line: 'UAT_RESULT pass=6 fail=0 skip=0 realFails=0 infraGated=1', rc: 0 };
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
      '--journeys-state', 'zero-rows'],
    { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' } },
  );
  assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /JOURNEYS FAILED/);
  assert.match(r.stdout, /realFails=2/);
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
    { ...ZERO_ROWS_FAILED(), uat: { state: 'row', line: 'UAT_RESULT realFails=2', rc: 0 } },
    {
      ...ZERO_ROWS_FAILED(),
      journeys: { state: 'rows', lines: ['UAT_FAIL a.ts:1 › J1 :: gate'], rc: 0 },
    },
  ];
  for (const i of inputs) {
    const r = syntheticMonitorVerdict(i);
    const all = [r.message, ...r.evidence, ...r.remediation].join('\n');
    assert.ok(!all.includes('`'), `backtick in verdict output for status=${i.status}: ${all}`);
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
  };
  assert.equal(mutant.syntheticMonitorVerdict(i).verdict, 'journeys-failed', 'mutant must over-claim');
  assert.equal(syntheticMonitorVerdict(i).verdict, 'unknown', 'the real module must not');
});
