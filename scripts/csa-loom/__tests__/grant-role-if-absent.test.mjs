/**
 * grant-role-if-absent.test.mjs — the shell helper is EXECUTED, with a fake `az`.
 *
 * WHY THIS SUITE EXISTS
 *
 * The first cut of the #3439 fix introduced a NEW fail-open, in the very change
 * that removed the old one. The probe was
 *
 *     EXISTING=$(az role assignment list … --query "length(@)" -o tsv 2>&1 | tr -d '\r')
 *
 * `2>&1` folds az's stderr into the value that is then compared. With a single
 * CLI update notice on stderr the value is neither "0" nor a positive integer,
 * so it fell through to the "could not read" branch and did NOT create. A new
 * uami-loom-* identity would then never receive AcrPull and its Container App
 * could not pull its image — on any run where az happened to warn. The previous
 * code always created, so that was a regression on Commercial AND Gov.
 *
 * A unit test over a JS re-implementation would not have caught it: the defect
 * is in the shell. So these tests run the REAL helper under `bash`, with a fake
 * `az` on PATH that reproduces the exact stdout/stderr/exit shapes az produces.
 *
 * Run: node --test scripts/csa-loom/__tests__/grant-role-if-absent.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HELPER = path.resolve(import.meta.dirname, '..', '_grant-role-if-absent.sh');
const PID = '11111111-2222-3333-4444-555555555555';
const ROLE = '7f951dda-4ed3-4680-a7ca-43fe172d538d';
const SCOPE = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acr';

/**
 * THE TWO CALLERS RUN DIFFERENT SHELLS, so every case runs under BOTH.
 *
 *   full-app-deploy-commercial.yml:319   set +e
 *   gov-provision-streaming-migrate.yml:286   set -euo pipefail
 *
 * The first cut of this suite drove only `set -uo pipefail`. Under `errexit` a
 * bare `x=$(az …)` assignment carries az's exit status, so a failing probe
 * killed the step before `rc=$?` was ever read — the create-on-unreadable branch
 * could not run on Gov, and the block after the loop never ran either. The suite
 * was green the whole time because its driver was not the Gov caller's shell.
 *
 * A fixture that models one caller's environment while a second caller runs a
 * different one is the same defect class as the bug it was written to catch, so
 * the shell is a test dimension now, not a constant.
 */
const SHELLS = [
  { name: 'set +e (Commercial caller)', opts: 'set +e' },
  { name: 'set -uo pipefail', opts: 'set -uo pipefail' },
  { name: 'set -euo pipefail (Gov caller)', opts: 'set -euo pipefail' },
];

/**
 * Run the helper with a fake `az` whose behaviour for the `list` call is given
 * by (stdout, stderr, exit). Every invocation is appended to a log file so the
 * test can assert whether `create` was reached.
 *
 * @returns {{status:number, out:string, calls:string[]}}
 */
function runHelper({
  listStdout = '',
  listStderr = '',
  listExit = 0,
  createExit = 0,
  createStderr = '',
  shellOpts = 'set -uo pipefail',
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grant-'));
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);

  // The payloads go to FILES the fake az `cat`s, so the bytes reach the helper
  // exactly as written — including a bare CR. Interpolating them into the shell
  // source instead does not: JSON.stringify('2\r') hands bash a literal
  // backslash-r, which is a different (and non-numeric) two-character string,
  // and the CR case then tests nothing it claims to.
  const outFile = path.join(dir, 'stdout.bin');
  const errFile = path.join(dir, 'stderr.bin');
  fs.writeFileSync(outFile, listStdout, 'utf8');
  fs.writeFileSync(errFile, listStderr, 'utf8');

  const az = [
    '#!/usr/bin/env bash',
    `echo "$*" >> ${JSON.stringify(log)}`,
    'case "$*" in',
    '  *"role assignment list"*)',
    `    cat ${JSON.stringify(outFile)}`,
    `    cat ${JSON.stringify(errFile)} >&2`,
    `    exit ${listExit} ;;`,
    '  *"role assignment create"*)',
    `    printf '%s' ${JSON.stringify(createStderr)} >&2`,
    `    exit ${createExit} ;;`,
    'esac',
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'az'), az, { mode: 0o755 });

  const script = [
    shellOpts,
    `. ${JSON.stringify(HELPER)}`,
    `grant_role_if_absent ${JSON.stringify(PID)} ${JSON.stringify(ROLE)} ${JSON.stringify(SCOPE)} "AcrPull"`,
    // Proves the caller SURVIVES the helper. Under errexit the old shape exited
    // here, so nothing after the loop in the Gov step would have run.
    'echo "CALLER-REACHED-END"',
    '',
  ].join('\n');
  const scriptPath = path.join(dir, 'run.sh');
  fs.writeFileSync(scriptPath, script, 'utf8');

  const r = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { status: r.status, out, calls, survived: out.includes('CALLER-REACHED-END') };
}

const created = (calls) => calls.some((c) => c.includes('role assignment create'));

// ── EVERY BEHAVIOURAL CASE, UNDER EVERY CALLER'S SHELL ───────────────────────

for (const shell of SHELLS) {
  const run = (opts) => runHelper({ ...opts, shellOpts: shell.opts });

  // ── EMBEDDED CONTROL ───────────────────────────────────────────────────────

  test(`[${shell.name}] EMBEDDED CONTROL: the fake az is reached, and the two verdicts DIFFER`, () => {
    // Without this, every assertion below could be passing against a helper that
    // never ran az at all, or one that always created.
    const absent = run({ listStdout: '0' });
    const present = run({ listStdout: '1' });
    assert.ok(absent.calls.some((c) => c.includes('role assignment list')), 'the probe must run');
    assert.equal(created(absent.calls), true, 'absent MUST create');
    assert.equal(created(present.calls), false, 'present MUST NOT create');
  });

  // ── THE NORMAL CASES ───────────────────────────────────────────────────────

  test(`[${shell.name}] an existing grant is left alone — the template keeps its name`, () => {
    const r = run({ listStdout: '1' });
    assert.equal(r.status, 0);
    assert.equal(created(r.calls), false);
    assert.match(r.out, /already granted/);
    assert.ok(r.survived);
  });

  test(`[${shell.name}] an established absence creates, and SAYS the name will need converging`, () => {
    const r = run({ listStdout: '0' });
    assert.equal(r.status, 0);
    assert.equal(created(r.calls), true);
    assert.match(r.out, /converge-role-assignment\.mjs/);
    assert.ok(r.survived);
  });

  // ── REGRESSION: stderr must not corrupt the count ──────────────────────────

  test(`[${shell.name}] REGRESSION #3439: stderr on the probe must NOT suppress the create`, () => {
    const r = run({
      listStdout: '0',
      listStderr: 'WARNING: You have 2 updates available. Consider updating your CLI installation.\n',
    });
    assert.equal(
      created(r.calls),
      true,
      'a genuinely-absent grant must still be created when az pollutes stderr — otherwise the Container App cannot pull its image',
    );
  });

  test(`[${shell.name}] stderr must not turn a PRESENT grant into a redundant create either`, () => {
    const r = run({ listStdout: '3', listStderr: 'WARNING: the "identity" extension is in preview.\n' });
    assert.equal(created(r.calls), false, 'the count is on stdout and is readable; stderr is noise');
    assert.match(r.out, /already granted/);
  });

  test(`[${shell.name}] a multi-line stderr banner is still only noise`, () => {
    const r = run({ listStdout: '1', listStderr: 'WARNING: one\nWARNING: two\nWARNING: three\n' });
    assert.equal(created(r.calls), false);
  });

  // ── UNREADABLE PROBE: create, survive, and say why ─────────────────────────
  //
  // THE BLOCKER THIS DIMENSION EXISTS FOR. Under `set -euo pipefail` the old
  // `existing=$(az …); rc=$?` shape exited the shell the instant az returned
  // non-zero: no warning, no create, and nothing after the caller's loop. The
  // Gov step opens exactly that shell, so create-on-unreadable — the delta's
  // headline claim — could never fire there. Only this case, under this shell,
  // catches it.

  test(`[${shell.name}] a FAILED probe creates anyway, because the two errors are not symmetric`, () => {
    const r = run({ listStdout: '', listStderr: 'ERROR: (AuthorizationFailed) …', listExit: 1 });
    assert.equal(created(r.calls), true, 'errexit must not swallow the create-on-unreadable branch');
    assert.match(r.out, /could NOT read/);
    assert.match(r.out, /refused by ARM, a skipped one is an outage/);
  });

  test(`[${shell.name}] a FAILED probe does not abort the CALLER`, () => {
    const r = run({ listStdout: '', listStderr: 'ERROR: (AuthorizationFailed) …', listExit: 1 });
    assert.ok(
      r.survived,
      'the step must continue — on Gov the Storage Blob Data Contributor block runs AFTER this loop',
    );
    assert.equal(r.status, 0);
  });

  test(`[${shell.name}] an empty stdout on exit 0 is unreadable, not "zero assignments"`, () => {
    const r = run({ listStdout: '', listExit: 0 });
    assert.equal(created(r.calls), true);
    assert.match(r.out, /could NOT read/);
  });

  test(`[${shell.name}] a non-numeric count is unreadable, not absent`, () => {
    const r = run({ listStdout: 'null', listExit: 0 });
    assert.equal(created(r.calls), true);
    assert.match(r.out, /could NOT read/);
  });

  test(`[${shell.name}] a CR-terminated count (Git Bash) is read as a number, not as unreadable`, () => {
    const r = run({ listStdout: '2\r\n' });
    assert.equal(created(r.calls), false);
    assert.match(r.out, /already granted/);
  });

  // ── R7: the ✓ must describe what actually happened ────────────────────────

  test(`[${shell.name}] a DENIED create never prints a tick`, () => {
    // The previous shape piped the create through `grep -viE "already exists"`
    // and then printed "✓ $label" unconditionally, so an AuthorizationFailed was
    // followed immediately by a tick and the caller could not tell granted from
    // denied.
    const r = run({
      listStdout: '0',
      createExit: 1,
      createStderr: 'ERROR: (AuthorizationFailed) The client does not have authorization to perform action.',
    });
    assert.doesNotMatch(r.out, /✓ AcrPull/, 'a refused grant must not be reported as granted');
    assert.match(r.out, /the grant was NOT created/);
    assert.match(r.out, /this role is MISSING/);
  });

  test(`[${shell.name}] a DENIED create still returns 0, so the rest of the step runs`, () => {
    // Deliberate: the callers loop under errexit, so a non-zero return would
    // abort the step and skip everything after it — re-creating the sovereign
    // lane failure this fix exists to remove. The OUTCOME lives in the message.
    const r = run({ listStdout: '0', createExit: 1, createStderr: 'ERROR: (AuthorizationFailed) denied' });
    assert.equal(r.status, 0);
    assert.ok(r.survived);
  });

  test(`[${shell.name}] a SUCCESSFUL create is reported as granted`, () => {
    const r = run({ listStdout: '0', createExit: 0 });
    assert.match(r.out, /✓ AcrPull \(granted\)/);
  });

  test(`[${shell.name}] ARM refusing a duplicate triple is the expected no-op, not a failure`, () => {
    // This is the proof that a redundant create cannot mint a competing name —
    // the property the create-on-unreadable branch relies on.
    const r = run({
      listStdout: '0',
      createExit: 1,
      createStderr: 'ERROR: (RoleAssignmentExists) The role assignment already exists.',
    });
    assert.match(r.out, /already granted — ARM refused a duplicate triple/);
    assert.doesNotMatch(r.out, /the grant was NOT created/);
    assert.equal(r.status, 0);
  });
}

// ── USAGE (shell-independent) ────────────────────────────────────────────────

test('a missing argument refuses rather than granting something unspecified', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grant-usage-'));
  const scriptPath = path.join(dir, 'run.sh');
  fs.writeFileSync(
    scriptPath,
    ['set -uo pipefail', `. ${JSON.stringify(HELPER)}`, 'grant_role_if_absent "" "" ""', ''].join('\n'),
    'utf8',
  );
  const r = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout ?? ''}${r.stderr ?? ''}`, /refusing to guess/);
});
