#!/usr/bin/env node
/**
 * measure-injection.test.mjs — the executable half of the CodeQL alert 983
 * triage (`js/indirect-command-line-injection`, CWE-078, measure.mjs:239).
 *
 * WHY THIS SUITE EXISTS
 *
 *   That alert was triaged as a FALSE POSITIVE: an unmodelled sanitizer, not an
 *   absent one. A triage note is a claim, and a claim nobody re-runs decays into
 *   folklore the first time someone edits the file. #3985 asked for exactly this
 *   — "add a test that pins the allowlist-returns-its-own-literal property, so
 *   the mitigation this rationale leans on cannot be quietly removed later".
 *
 *   So every load-bearing sentence in that triage is an assertion here.
 *
 * MUTATION CONTROL — what turns each test RED
 *
 *   These were not reasoned about; they were run (2026-08-25, win32, node
 *   v24.18.0), one single-token mutation at a time, results in the PR body:
 *
 *     measure.mjs   `shell: false`            -> `shell: true`
 *                     => "no shell interprets a direct argv" FAILS (the payload
 *                        is split, and on win32 the marker file is created).
 *     measure.mjs   restore `...plan.opts` spread after `shell: false`
 *                     => nothing fails today, which is the point: the spread is
 *                        latent, so it is guarded structurally by the line above
 *                        rather than by a test that cannot see it.
 *     cmd-quote.mjs `quoteForCmd` -> `return String(arg)`  (no quoting at all)
 *                     => "the cmd.exe wrapper neutralises every payload" FAILS
 *                        with real command execution (marker file present).
 *     cmd-quote.mjs drop the `%` / CR-LF refusals
 *                     => "the wrapper fails CLOSED" FAILS.
 *     measure.mjs   `return ALLOWED_BINARIES[key]` -> `return bin`
 *                     => "the allowlist returns its own literal" FAILS.
 *
 *   cmd-quote.mjs is NOT modified by this change — those two rows were measured
 *   against a scratch copy and reverted. They are recorded because a suppression
 *   is only honest if the thing it leans on is under test.
 *
 * POSITIVE CONTROLS (R5)
 *
 *   "No injection occurred" and "my detector is broken" produce the identical
 *   string, and the wrong one is always the more convenient. Every negative
 *   result below is therefore paired with a control that proves the harness can
 *   still observe the thing it is failing to find.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, canonicalBinary, MeasurementError, SELF_NODE } from '../measure.mjs';

const WIN = process.platform === 'win32';
const notWin = WIN ? false : 'the cmd.exe wrapper branch only exists on win32';

/** Scratch dir; mkdtemp per check-temp-artifact-safety (never a constant name). */
function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'measure-inj-'));
}

/**
 * A child that reports its own argv verbatim, so "what did the OS actually
 * deliver" is measured rather than inferred from the parent's intent.
 */
const DUMP = 'console.log("CHILD_ARGV=" + JSON.stringify(process.argv.slice(2)));\n';

/**
 * Payloads that each try to run a SECOND command creating `marker`. Every one is
 * a shell metacharacter construction that works in cmd.exe when unquoted.
 */
function payloads(marker) {
  const mk = `echo pwned> "${marker}"`;
  return [
    ['plain-amp', `x& ${mk}`],
    ['quote-breakout', `x" & ${mk} & "y`],
    ['pipe', `x| ${mk}`],
    ['and-and', `x&& ${mk}`],
    ['caret-amp', `x^& ${mk}`],
    ['subshell', `x& (${mk})`],
    ['redirect', `x> "${marker}"`],
    ['bang-delayed', `x!COMSPEC!& ${mk}`],
    ['trailing-bslash', 'C:\\my dir\\'],
  ];
}

// ────────────────────────────────────────────── every platform: the no-shell path
//
// Two of measure.mjs's three launch branches hand `argv` to the OS as an ARRAY.
// The absence of a shell is the whole mitigation there, and it is one token wide.

test('no shell interprets a direct argv — metacharacters reach the child literally', () => {
  const dir = scratch();
  const dump = path.join(dir, 'dump.mjs');
  const marker = path.join(dir, 'PWNED.txt');
  fs.writeFileSync(dump, DUMP);

  for (const [name, payload] of payloads(marker)) {
    const r = run(SELF_NODE, [dump, payload]);
    const got = JSON.parse(r.stdout.match(/CHILD_ARGV=(.*)/)[1]);
    assert.deepEqual(got, [payload], `${name}: must arrive as ONE literal argv element`);
    assert.equal(
      fs.existsSync(marker), false,
      `${name}: a second command EXECUTED — spawnSync is interpreting a shell`,
    );
  }
});

test('POSITIVE CONTROL: the marker detector can actually observe an execution', () => {
  // Without this, the assertion above would pass just as happily if `marker`
  // were an unwritable path, a stale variable, or a typo — "no injection" and
  // "I cannot see an injection" are the same string.
  const dir = scratch();
  const marker = path.join(dir, 'PWNED.txt');
  assert.equal(fs.existsSync(marker), false, 'precondition: marker absent');
  run(SELF_NODE, ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`]);
  assert.equal(
    fs.existsSync(marker), true,
    'the detector is blind: a child that DID write the marker went unnoticed',
  );
});

// ───────────────────────────────────── every platform: the #3985 regression pin
//
// The triage says the executable is never caller-derived. That is what makes the
// cmd.exe line safe to reason about at all, so it is asserted, not assumed.

test('TAINT: the allowlist returns its OWN literal, never the caller string', () => {
  // Key-widening is structurally inert because the VALUE is returned, not the
  // key. A case-widened input is the cheapest proof: the argument and the result
  // are different strings.
  assert.equal(canonicalBinary('GH'), 'gh');
  assert.notEqual(canonicalBinary('GH'), 'GH');
  assert.equal(canonicalBinary('AZ'), 'az');

  // Whatever comes back can never be a path, so it can never name a file an
  // attacker chose — this is the property `needsWrapper`'s PATH scan relies on.
  for (const nameIn of ['gh', 'GH', 'Az', 'git', 'NODE', 'pwsh']) {
    assert.match(canonicalBinary(nameIn), /^[a-z]+$/, 'a resolved binary is a bare lowercase name');
  }
});

test('TAINT: a path, a prototype key, and a non-string are all REFUSED', () => {
  // The 2026-08-24 hole verbatim: validate a PROJECTION, spawn the ORIGINAL.
  for (const evil of [
    'C:\\attacker\\gh.cmd',
    './gh',
    '../../gh',
    'sub/dir/az',
    '__proto__',
    'constructor',
    'toString',
  ]) {
    assert.throws(
      () => canonicalBinary(evil),
      (e) => e instanceof MeasurementError && /not an allowed binary/.test(e.message),
      `${evil} must be refused`,
    );
  }
  for (const bad of [null, undefined, 42, {}, ['gh'], Symbol('gh')]) {
    assert.throws(() => canonicalBinary(bad), MeasurementError, `${String(bad)} must be refused`);
  }
});

test('POSITIVE CONTROL: the allowlist is not refusing EVERYTHING', () => {
  // A guard with a 100% refusal rate passes every test above and takes the
  // toolkit down.
  assert.equal(canonicalBinary('az'), 'az');
});

// ──────────────────────────────────────────────── win32: the cmd.exe shell path
//
// This is the branch CodeQL flags, and the ONLY one where a shell exists. Node
// >= 20 refuses to spawn a .cmd directly (EINVAL, CVE-2024-27980) and `az` ships
// on Windows only as `az.cmd`, so the wrapper cannot be removed — which makes
// the quoting the mitigation, and makes measuring it obligatory.
//
// The shim shadows an allowlisted name on a PATH we prepend, so the payloads are
// delivered through the REAL code path (canonicalBinary -> needsWrapper ->
// buildCmdLine -> cmd.exe) rather than a reconstruction of it.

function withShim(fn) {
  const dir = scratch();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'dump.mjs'), DUMP);
  // A realistic shim: az.cmd forwards %* to its interpreter in exactly this way.
  fs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo off\r\nnode "%~dp0dump.mjs" %*\r\n');
  const savedPath = process.env.PATH;
  process.env.PATH = [bin, path.dirname(process.execPath), savedPath].join(path.delimiter);
  try {
    return fn(dir);
  } finally {
    process.env.PATH = savedPath;
  }
}

test('POSITIVE CONTROL: the wrapper path is genuinely exercised', { skip: notWin }, () => {
  // Without this, "0 injections" below could mean the shim was never reached and
  // the matrix measured nothing at all.
  withShim(() => {
    const r = run('npm', ['hello world']);
    assert.match(r.stdout, /CHILD_ARGV=/, 'the .cmd shim did not run — the matrix would be vacuous');
    assert.deepEqual(JSON.parse(r.stdout.match(/CHILD_ARGV=(.*)/)[1]), ['hello world']);
  });
});

test('the cmd.exe wrapper neutralises every injection payload', { skip: notWin }, () => {
  withShim((dir) => {
    const marker = path.join(dir, 'PWNED.txt');
    for (const [name, payload] of payloads(marker)) {
      if (fs.existsSync(marker)) fs.rmSync(marker);
      const r = run('npm', [payload]);
      const got = JSON.parse(r.stdout.match(/CHILD_ARGV=(.*)/)[1]);
      assert.equal(
        fs.existsSync(marker), false,
        `${name}: COMMAND INJECTION — a second command executed through cmd.exe`,
      );
      assert.deepEqual(got, [payload], `${name}: fidelity — must arrive byte-for-byte as one argument`);
    }
  });
});

test('the cmd.exe wrapper fails CLOSED on what it cannot quote', { skip: notWin }, () => {
  withShim(() => {
    // `%` — cmd expands %VAR% even inside double quotes, and `%%` only escapes
    // inside a batch FILE. Running a different command than the one requested is
    // the failure this directory exists to prevent, so it refuses.
    assert.throws(
      () => run('npm', ['%COMSPEC%']),
      (e) => e instanceof MeasurementError && /'%'/.test(e.message),
      'a % argument must be refused, not silently expanded',
    );
    // CR/LF — a newline TERMINATES a cmd command line: every later argument is
    // dropped and the call still exits 0. That is a fidelity failure rather than
    // injection, and for a measurement harness it is the worse of the two.
    for (const nl of ['a\nb', 'a\rb', 'a\r\nb']) {
      assert.throws(
        () => run('npm', [nl]),
        (e) => e instanceof MeasurementError && /newline/.test(e.message),
        `${JSON.stringify(nl)} must be refused, not truncated at rc=0`,
      );
    }
    // A refusal is raised as MeasurementError, not CmdQuoteError, so callers of
    // this toolkit still only have to catch one type (R1).
    assert.throws(() => run('npm', ['%X%']), MeasurementError);
  });
});

test('POSITIVE CONTROL: the wrapper is not refusing every argument', { skip: notWin }, () => {
  withShim(() => {
    // An ARM id is the canonical real argument here, and the leading slash is
    // exactly what MSYS path-mangling used to destroy (R3).
    const arm = '/subscriptions/0000/resourceGroups/rg/providers/Microsoft.Web/sites/app';
    const r = run('npm', [arm, '--query', 'a b']);
    assert.deepEqual(JSON.parse(r.stdout.match(/CHILD_ARGV=(.*)/)[1]), [arm, '--query', 'a b']);
  });
});
