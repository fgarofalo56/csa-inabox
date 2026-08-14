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
 * Run the helper with a fake `az` whose behaviour for the `list` call is given
 * by (stdout, stderr, exit). Every invocation is appended to a log file so the
 * test can assert whether `create` was reached.
 *
 * @returns {{status:number, out:string, calls:string[]}}
 */
function runHelper({ listStdout = '', listStderr = '', listExit = 0 }) {
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
    '    exit 0 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'az'), az, { mode: 0o755 });

  const script = [
    'set -uo pipefail',
    `. ${JSON.stringify(HELPER)}`,
    `grant_role_if_absent ${JSON.stringify(PID)} ${JSON.stringify(ROLE)} ${JSON.stringify(SCOPE)} "AcrPull"`,
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
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, calls };
}

const created = (calls) => calls.some((c) => c.includes('role assignment create'));

// ── EMBEDDED CONTROL ─────────────────────────────────────────────────────────

test('EMBEDDED CONTROL: the fake az is actually reached, and the two verdicts DIFFER', () => {
  // Without this, every assertion below could be passing against a helper that
  // never ran az at all, or one that always created.
  const absent = runHelper({ listStdout: '0' });
  const present = runHelper({ listStdout: '1' });
  assert.ok(absent.calls.some((c) => c.includes('role assignment list')), 'the probe must run');
  assert.equal(created(absent.calls), true, 'absent MUST create');
  assert.equal(created(present.calls), false, 'present MUST NOT create');
});

// ── THE NORMAL CASES ─────────────────────────────────────────────────────────

test('an existing grant is left alone — the template keeps its name', () => {
  const r = runHelper({ listStdout: '1' });
  assert.equal(r.status, 0);
  assert.equal(created(r.calls), false);
  assert.match(r.out, /already granted/);
});

test('an established absence creates, and SAYS the name will need converging', () => {
  const r = runHelper({ listStdout: '0' });
  assert.equal(r.status, 0);
  assert.equal(created(r.calls), true);
  assert.match(r.out, /converge-role-assignment\.mjs/);
});

// ── THE REGRESSION THE REVIEWER CAUGHT ───────────────────────────────────────

test('REGRESSION #3439: stderr on the probe must NOT suppress the create', () => {
  // The exact shape that broke it: az writes an update notice to stderr and the
  // real count to stdout, exit 0. Folding the two together made the value
  // unparseable and the grant was silently skipped.
  const r = runHelper({
    listStdout: '0',
    listStderr: 'WARNING: You have 2 updates available. Consider updating your CLI installation.\n',
  });
  assert.equal(
    created(r.calls),
    true,
    'a genuinely-absent grant must still be created when az pollutes stderr — otherwise the Container App cannot pull its image',
  );
});

test('stderr on the probe must not turn a PRESENT grant into a redundant create either', () => {
  const r = runHelper({
    listStdout: '3',
    listStderr: 'WARNING: the "identity" extension is in preview.\n',
  });
  assert.equal(created(r.calls), false, 'the count is on stdout and is readable; stderr is noise');
  assert.match(r.out, /already granted/);
});

test('a multi-line stderr banner is still only noise', () => {
  const r = runHelper({
    listStdout: '1',
    listStderr: 'WARNING: line one\nWARNING: line two\nWARNING: line three\n',
  });
  assert.equal(created(r.calls), false);
});

// ── UNREADABLE: create, and say why ──────────────────────────────────────────

test('a FAILED probe creates anyway, because the two errors are not symmetric', () => {
  // ARM refuses a duplicate triple, so a redundant create cannot mint a second
  // name. A skipped create on a real absence is an outage. The helper says so
  // rather than silently choosing.
  const r = runHelper({ listStdout: '', listStderr: 'ERROR: (AuthorizationFailed) …', listExit: 1 });
  assert.equal(created(r.calls), true);
  assert.match(r.out, /could NOT read/);
  assert.match(r.out, /refused by ARM, a skipped one is an outage/);
});

test('an empty stdout on exit 0 is unreadable, not "zero assignments"', () => {
  const r = runHelper({ listStdout: '', listExit: 0 });
  assert.equal(created(r.calls), true);
  assert.match(r.out, /could NOT read/);
});

test('a non-numeric count is unreadable, not absent', () => {
  const r = runHelper({ listStdout: 'null', listExit: 0 });
  assert.equal(created(r.calls), true);
  assert.match(r.out, /could NOT read/);
});

test('a CR-terminated count (Git Bash) is read as a number, not as unreadable', () => {
  const r = runHelper({ listStdout: '2\r\n' });
  assert.equal(created(r.calls), false);
  assert.match(r.out, /already granted/);
});

// ── USAGE ────────────────────────────────────────────────────────────────────

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
