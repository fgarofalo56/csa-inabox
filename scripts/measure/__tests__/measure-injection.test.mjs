#!/usr/bin/env node
/**
 * measure-injection.test.mjs — the executable half of the CodeQL alert 983
 * triage (`js/indirect-command-line-injection`, CWE-078; the sink is the
 * `spawnSync` in `run()`, at measure.mjs:239 as of d9618dfd1e — the line moves
 * with every edit to the comment above it, so read the marker, not the number).
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
 * WHAT ACTUALLY RUNS IN CI, AND WHAT DOES NOT
 *
 *   This file is discovered and executed by scripts/ci/check-node-test-suites.mjs
 *   from the REQUIRED `guardrails` check — verified with `--list` (136 suites,
 *   this one among them), so no runner wiring is needed. But `runs-on: windows`
 *   appears in ZERO workflows in this repo (206 ubuntu-latest, 9 self-hosted
 *   Linux), so the four `{ skip: notWin }` tests — the cmd.exe wrapper matrix,
 *   the only branch with a shell — NEVER execute on any lane.
 *
 *   MEASURED with `process.platform` forced to 'linux'. Before this correction
 *   the suite ran rc=0, 5 pass, 4 SKIPPED — i.e. the ubuntu lanes exercised the
 *   allowlist and the no-shell argv path and NOTHING about the quoting. It now
 *   runs rc=0, 13 pass, 5 SKIPPED. The fifth skip is new and is NOT a CI gap:
 *   `PRODUCTION PATH` spawns a real child, so it cannot run under a FORGED
 *   platform (the OS underneath is still Windows). On a real Linux runner
 *   `process.platform` and `os.type()` agree, the skip predicate is false, and
 *   it executes — INFERRED from reading that predicate, NOT observed. No Linux
 *   host was available to this lane, so treat the forged column as the only
 *   measured Linux evidence and this sentence as a prediction.
 *
 *   An earlier revision of the suppression comment in measure.mjs claimed this
 *   suite "runs that matrix in CI". It does not, and that sentence has been
 *   corrected — a comment asserting a control the code does not establish is the
 *   deploy-integrity R7 defect this directory exists to catch.
 *
 *   So the properties the win32 matrix proves BEHAVIOURALLY are also pinned here
 *   in forms that execute everywhere:
 *
 *     - `the built cmd.exe line leaves no metacharacter LIVE` runs the same
 *       payload matrix through the same `buildCmdLine`, and applies cmd.exe's
 *       own liveness rule (a running quote toggle) to the result.
 *     - `the built cmd.exe line REFUSES what it cannot quote` holds the `%` and
 *       CR/LF fail-closed behaviour shut at the `buildCmdLine` layer.
 *     - `PRODUCTION PATH` drives the exported `run` with its real defaults and
 *       makes the spawned executable's IDENTITY observable, so the
 *       caller->spawnSync edge is pinned by execution and not only by shape.
 *     - `SHAPE:` tests read measure.mjs's source and pin four structures that
 *       no behavioural assertion in JavaScript can distinguish (see each).
 *
 *   What remains win32-only, and is therefore declared UNTESTED on the CI lanes:
 *   whether cmd.exe and CommandLineToArgvW really behave as modelled. Making
 *   that real needs a windows-latest job, which is a workflow change outside
 *   this lane's ownership. Filed as a gap, not implied working.
 *
 * MUTATION CONTROL — what turns each test RED
 *
 *   Not reasoned about — RUN, 2026-08-25, node v24.18.0, one single-token
 *   mutation at a time against an ISOLATED COPY of measure.mjs + cmd-quote.mjs +
 *   this file under `mkdtemp`; nothing tracked was ever written. Each needle is
 *   asserted to match EXACTLY ONCE, because a needle that matches zero times
 *   reads exactly like a passing arm. Every arm is run twice: on win32, and with
 *   `process.platform` forced to 'linux' to measure what the ubuntu lanes see.
 *   The linux column is the one that matters — a guard that only fires on a
 *   workstation is not a guard. Both harness runs assert a GREEN BASELINE first;
 *   the first attempt at the linux column reported all 8 arms CAUGHT off a RED
 *   baseline (a Windows path handed to `--import` is not a valid ESM specifier),
 *   and the baseline check is the only reason that was not reported as a result.
 *
 *     arm                                             win32          linux-forced
 *     A  measure.mjs   shell:false -> shell:true      rc1 12/4 RED   rc1  9/3 RED
 *     B  measure.mjs   return ALLOWED_BINARIES[key]
 *                        -> return bin                rc1 14/2 RED   rc1 10/2 RED
 *     C  measure.mjs   ... -> return key              rc1 15/1 RED   rc1 11/1 RED
 *     D  measure.mjs   restore ...plan.opts spread    rc1 15/1 RED   rc1 11/1 RED
 *     E  measure.mjs   drop the outer quote pair      rc1 15/1 RED   rc1 11/1 RED
 *     F  cmd-quote.mjs quoteForCmd -> String(arg)     rc1  9/7 RED   rc1  9/3 RED
 *     G  cmd-quote.mjs drop the '%' refusal           rc1 14/2 RED   rc1 11/1 RED
 *     H  cmd-quote.mjs drop the CR/LF refusal         rc1 14/2 RED   rc1 11/1 RED
 *
 *   Arms C, D and E all SURVIVED at rc=0, 9/9 against the previous revision of
 *   this suite. C is the narrow form of B: `key` is `bin.toLowerCase()`, a
 *   caller-derived string that defeats a case-widening detector by construction
 *   while restoring exactly the caller->spawnSync dataflow edge the triage rests
 *   on. D and E are latent, so no behavioural assertion can reach them. G and H
 *   survived on the LINUX lane only — the assertions holding them shut lived in
 *   the win32 matrix, which skips there.
 *
 *   THE CONSUMPTION SITE — arms I, N and W, added 2026-08-25, re-measured 2026-08-26
 *
 *   EVERY ARM BELOW IS RUNNABLE: `node scripts/measure/__tests__/injection-arms.mjs`.
 *   It carries each arm's documented verdict per column and exits non-zero if
 *   reality diverges in EITHER direction, so this table can be checked instead
 *   of believed. It had to become executable: twice this table was prose, and
 *   twice a reviewer defeated the suite with a mutation the prose did not
 *   contain.
 *
 *   Arms A–H all pin what `canonicalBinary` RETURNS. An independent review
 *   defeated that revision anyway, by moving the allowlist result off the CALL
 *   SITE instead: the helper still returns the table's literal, and spawnPlan
 *   stops using it. Re-measured here on an isolated copy, baseline green first
 *   (win32 rc=0 18/0/0; linux-forced rc=0 13 pass/5 skipped), each needle
 *   asserted to match exactly once (needles are built with the FILE's EOL —
 *   these files are CRLF, and a bare-`\n` needle matches zero times and reads
 *   exactly like a survival):
 *
 *     arm                                             win32          linux-forced
 *     I  measure.mjs   canonicalBinary(bin);
 *                        const file = bin;            rc1 16/2 RED   rc1 12/1 RED
 *     N  measure.mjs   direct branch cmd: file
 *                        -> cmd: bin                  rc1 17/1 RED   rc1 12/1 RED
 *     W  measure.mjs   buildCmdLine(file, args)
 *                        -> buildCmdLine(bin, args)   rc1 16/2 RED   rc1 12/1 RED
 *
 *   All three SURVIVED against the PREVIOUS revision of this suite — re-measured
 *   here, not quoted: rc=0, 16 pass/0 fail/0 skipped (win32) and rc=0, 12 pass/
 *   4 skipped (linux-forced), identical to that revision's own baseline in both
 *   columns. Arm I is caught BEHAVIOURALLY, not by shape alone: the assertion
 *   diff is `'GH' !== 'gh'` — the child reported that it was invoked under the
 *   caller's own string, which is the dataflow edge itself and not a proxy for
 *   it. On the forged-linux column every catch is the SHAPE test, because the
 *   behavioural one stands down there; on a real Linux runner arm N's
 *   `cmd: bin` also fails to RESOLVE (case-sensitive filesystem), which is
 *   INFERRED from the mechanism and not measured — no Linux host was available
 *   to this lane.
 *
 *   Arm C is re-run alongside them and is still caught, by exactly one test
 *   (`SHAPE: canonicalBinary …`), unchanged by this round.
 *
 *   NOT AN ENUMERATION — arms X, Y and Z, invented against the finished guard
 *
 *   A guard keyed to the three mutations that defeated the last revision would
 *   pass this file's own arm table and still be a list. So three more were
 *   written specifically to slip past the assertions as worded, and each was
 *   measured in both columns:
 *
 *     X  `const file = canonicalBinary(bin) && bin;`   — keeps the literal
 *        prefix the regex looks for, so it survives a naive substring check.
 *        rc1 RED both columns.
 *     Y  `const file = (canonicalBinary(bin), bin);`   — comma operator; the
 *        allowlist still runs and still throws, its value is still discarded.
 *        rc1 RED both columns.
 *     Z  a `launder(x){ canonicalBinary(x); return x; }` helper defined OUTSIDE
 *        spawnPlan, called as `const file = launder(bin);`. This is the one
 *        that matters: the `bin` READ COUNT stays at exactly 2, so the
 *        population assertion alone would pass it. rc1 RED both columns —
 *        caught because the binding must be `canonicalBinary(bin)` by name,
 *        and behaviourally because the spawned executable is again `GH`.
 *
 *   Each of X, Y and Z is caught by BOTH guards on win32 and by the SHAPE one
 *   on the forged-linux column.
 *
 *   THE GUARDS THEMSELVES, mutated — a guard that cannot fail is not a guard
 *
 *     P  measure.mjs   rename spawnPlan's `bin` param to `b` throughout (a
 *                      behaviour-preserving refactor)
 *                                       rc1 17/1 RED win32, rc1 12/1 RED linux
 *                      — MEASURED reason: "must read `bin` exactly twice …
 *                        Found 0". The count assertion fails CLOSED; it does
 *                        not read absence as a pass.
 *     G2 the SUITE     silence the win32 shim so PRODUCTION PATH can observe
 *                      nothing                            rc1 17/1 RED win32
 *                      — MEASURED reason: "the shim did not report at all —
 *                        this test measured NOTHING. stdout: \"\"". So the
 *                        behavioural test is not passing on absence either.
 *                        SURVIVES the linux-forced column, because the test it
 *                        breaks skips there — expected, and the reason the
 *                        SHAPE companion exists.
 *     G  the SUITE     silence the POSIX shim             GREEN on this host
 *                      — and that is EXPECTED, not a hole: the POSIX shim is
 *                        never written on win32 and the forged-linux column
 *                        skips the test. The POSIX half of this control is
 *                        UNMEASURED here; it needs a real Linux runner.
 *
 *   cmd-quote.mjs is NOT modified by this change — its arms were applied to the
 *   isolated copy and never to the tree.
 *
 * POSITIVE CONTROLS (R5)
 *
 *   "No injection occurred" and "my detector is broken" produce the identical
 *   string, and the wrong one is always the more convenient. Every negative
 *   result below is therefore paired with a control that proves the harness can
 *   still observe the thing it is failing to find. The SHAPE tests carry the
 *   same discipline in the form the class needs: a source-text needle that
 *   matches zero times reads exactly like a passing assertion, so every
 *   extraction here asserts its own population first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, canonicalBinary, MeasurementError, SELF_NODE } from '../measure.mjs';
import { buildCmdLine } from '../cmd-quote.mjs';

const WIN = process.platform === 'win32';
const notWin = WIN ? false : 'the cmd.exe wrapper branch only exists on win32';

/**
 * The mutation harness runs this suite a second time with `process.platform`
 * forced to 'linux', to measure what a CI runner would see. That simulation is
 * sound for the tests that only build a command LINE, and unsound for any test
 * that spawns a real child: the OS underneath has not changed, so a POSIX shim
 * is unrunnable on Windows and a `.cmd` is unrunnable on Linux. A test that
 * fails for THAT reason would be a false RED masking a real one, so the one
 * spawning test below skips when the platform is being simulated.
 *
 * `os.type()` and NOT `os.platform()`: os.platform() is documented as
 * "equivalent to process.platform" and is literally that expression, so it
 * follows the forgery. os.type() comes from uv_os_uname and does not. MEASURED:
 * the first draft of this guard used os.platform(), never skipped, and the test
 * silently spawned the machine's REAL `gh` instead of the shim.
 */
const REAL_WIN = os.type() === 'Windows_NT';
const simulatedPlatform = WIN === REAL_WIN
  ? false
  : `process.platform is forged as '${process.platform}' on a real ${os.type()} host; this test spawns a real child`;

/** measure.mjs, read as TEXT. The SHAPE tests below pin structure, not behaviour. */
const MEASURE_MJS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'measure.mjs');

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
 *
 * The trailing-backslash case is deliberately NOT in here. It carries no
 * metacharacter and starts no second command, so its `existsSync(marker) ===
 * false` assertion would be vacuous — nothing could have written the marker. It
 * exercises a different property (the quote-consumption splice) and lives in
 * `fidelityPayloads()` below, so that "N injection detections" means N.
 */
function injectionPayloads(marker) {
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
  ];
}

/**
 * Not injection — FIDELITY. `C:\my dir\` ends in a backslash, and
 * CommandLineToArgvW reads `\"` as an escaped literal quote, so an undoubled
 * trailing backslash consumes the closing quote and splices every later argument
 * into this one. Measured in cmd-quote.mjs's own note: `["C:\my dir\",
 * "--query", "SECRET"]` arrived as one token. Only the deepEqual assertion
 * carries weight for this row.
 */
function fidelityPayloads() {
  return [['trailing-bslash', 'C:\\my dir\\']];
}

/** Every row, for the assertions (argv fidelity) that apply to both classes. */
function payloads(marker) {
  return [...injectionPayloads(marker), ...fidelityPayloads()];
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

  // Fidelity applies to every row; the marker assertion only to the rows that
  // actually try to start a second command.
  const injecting = new Set(injectionPayloads(marker).map(([n]) => n));
  for (const [name, payload] of payloads(marker)) {
    const r = run(SELF_NODE, [dump, payload]);
    const got = JSON.parse(r.stdout.match(/CHILD_ARGV=(.*)/)[1]);
    assert.deepEqual(got, [payload], `${name}: must arrive as ONE literal argv element`);
    if (!injecting.has(name)) continue;
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

// ────────────────── every platform: the CONSUMPTION site, driven through `run`
//
// Everything above pins what `canonicalBinary` RETURNS. Nothing above pins that
// the return is what gets SPAWNED, and those are different properties: on
// 2026-08-25 a reviewer defeated the previous revision with a one-line edit at
// the call site — `canonicalBinary(bin); const file = bin;` — which restores the
// exact caller->spawnSync executable edge the whole alert-983 triage rests on,
// and left all 16 tests GREEN in every column. That is the #3971 shape verbatim
// (validate a PROJECTION, spawn the ORIGINAL), against the one function this
// file exists to protect.
//
// So this test drives the PRODUCTION entry point — the exported `run`, with its
// real defaults, no inner function reached directly — and makes the identity of
// the spawned executable OBSERVABLE by having the child report the name it was
// invoked under. Passing an allowed name in the WRONG CASE is what separates the
// two: `canonicalBinary('GH')` is `'gh'`, so a correct build spawns `gh` and the
// child says `gh`; a build that spawns the caller's string says `GH` on win32
// (cmd's `%0` preserves the typed token — MEASURED) and fails to resolve at all
// on a case-sensitive filesystem. Both are RED, for the same reason, by
// different mechanisms.
//
// PATH is PREPENDED, never replaced: the win32 branch spawns the literal
// `cmd.exe` and lets libuv find it, so an empty PATH makes every arm ENOENT and
// the test would "pass" by measuring nothing.

/**
 * Write a shim named `name` that prints the name it was invoked under, and
 * return the directory holding it.
 *
 * win32 gets a `.cmd` so `needsWrapper` takes the cmd.exe branch — the one
 * branch where the executable is interpolated into a command LINE rather than
 * handed to the OS as argv[0].
 */
function invokedNameShim(name) {
  const dir = scratch();
  if (WIN) {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), '@echo off\r\necho INVOKED_AS=%0\r\n');
  } else {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '#!/bin/sh\necho "INVOKED_AS=$0"\n');
    fs.chmodSync(p, 0o755);
  }
  return dir;
}

/** The bare name the child reported, with any path and launcher extension removed. */
function reportedName(stdout) {
  const m = /INVOKED_AS=(.*)/.exec(stdout);
  assert.ok(m, `the shim did not report at all — this test measured NOTHING. stdout: ${JSON.stringify(stdout)}`);
  return path.basename(m[1].trim().replace(/^"|"$/g, '')).replace(/\.(cmd|exe|bat)$/i, '');
}

test('PRODUCTION PATH: run() spawns the TABLE literal, never the caller string', { skip: simulatedPlatform }, () => {
  const dir = invokedNameShim('gh');
  const saved = process.env.PATH;
  process.env.PATH = dir + path.delimiter + saved;
  try {
    // POSITIVE CONTROL, in-test: the shim is genuinely reachable through `run`
    // and genuinely reports. Without this, "the child never said GH" and "no
    // child ever ran" are the same assertion.
    const canonical = reportedName(run('gh', ['probe']).stdout);
    assert.equal(canonical, 'gh', 'POSITIVE CONTROL: the shim did not report its own name — the probe is blind');

    // The measurement. `run` is the exported entry point and takes its default
    // options here, so this is the same call shape drain-status.mjs and
    // red-tally.mjs use.
    const widened = reportedName(run('GH', ['probe']).stdout);
    assert.equal(
      widened, 'gh',
      "the executable is the CALLER's string, not the allowlist's literal. `canonicalBinary` may still be " +
      'returning the right value — what changed is that spawnPlan stopped CONSUMING it (e.g. ' +
      '`canonicalBinary(bin); const file = bin;`, or a `cmd:`/`buildCmdLine` that reads `bin`). That is the ' +
      'caller->spawnSync dataflow edge CodeQL alert 983 was triaged against, restored.',
    );
  } finally {
    process.env.PATH = saved;
  }
});

// ───────────────────────────── every platform: SHAPE pins, where behaviour ends
//
// Four of this file's load-bearing properties are DATAFLOW or STRUCTURAL, not
// behavioural, and no assertion written in JavaScript can see them on every
// branch:
//
//   1. `canonicalBinary` must return the TABLE's literal, not a value derived
//      from its argument. `return key` (i.e. `bin.toLowerCase()`) is observably
//      identical to `return ALLOWED_BINARIES[key]` — two equal primitive strings
//      are indistinguishable by `===`, by identity, by everything. It is not
//      exploitable today, and it restores exactly the caller->spawnSync edge the
//      whole alert-983 triage rests on. MEASURED: it used to survive at 9/9,
//      including against the case-widening assertion directly above, which it
//      defeats by construction.
//   2. The spawnSync options must carry no SPREAD. A spread after `shell: false`
//      silently outranks it, so the one option that must never be true is the
//      one a plan could set. No plan sets it — that is why no behavioural test
//      can reach it, and why removing the shape is the only guard available.
//   3. The cmd.exe command line must keep its OUTER quote pair. Documented as
//      required in README.md and in measure.mjs; nothing verified it.
//   4. `spawnPlan` must CONSUME what canonicalBinary returns. Property 1 is
//      about the helper; this one is about the call site, and they fail
//      independently — `canonicalBinary(bin); const file = bin;` keeps 1 true
//      and restores the whole dataflow edge. The behavioural `PRODUCTION PATH`
//      test above catches that on the branch it can reach; this pins it on all
//      three, including the two that only exist on the other platform.
//
// So they are pinned against the source TEXT. That is the repo's existing idiom
// for this class (scripts/measure/mutate.mjs quotes measure.mjs's own lines;
// scripts/ci/check-node-test-suites.mjs asserts against workflow YAML text), and
// it has one known failure mode: a needle that matches ZERO times reads exactly
// like a passing assertion. Every extraction below therefore asserts its own
// population BEFORE it asserts anything about the contents.

/** measure.mjs's source. Read once; `\r\n` is irrelevant to every match below. */
const SRC = fs.readFileSync(MEASURE_MJS, 'utf8');

/**
 * The body of a top-level `function <name>(…)`, by brace matching.
 * @returns {string|null} null when the function is absent — never an empty
 * string, so a caller cannot mistake "not found" for "found and empty".
 */
function functionBody(src, name) {
  const m = new RegExp(`^(?:export )?function ${name}\\s*\\(`, 'm').exec(src);
  if (!m) return null;
  return braceBlock(src, src.indexOf('{', m.index));
}

/** The text between `src[open]` and its matching close brace. */
function braceBlock(src, open) {
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** Statements that begin with `return`, so comment prose can never be one. */
function returnStatements(body) {
  return body.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^return\b/.test(l));
}

/**
 * Drop whole-line `//` comments.
 *
 * Needed because the options object below carries a comment that quotes the
 * removed `...plan.opts` verbatim — the first run of this test went RED on its
 * own prose, which is the correct failure direction for an imperfect stripper
 * (a missed comment can only produce a false RED, never a missed spread) but is
 * still a broken test. Deliberately naive: it does not strip trailing comments,
 * so writing `...` in one inside these blocks will fail this test. Put the prose
 * above the object.
 */
function stripLineComments(block) {
  return block.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

test('SHAPE: canonicalBinary returns an ALLOWED_BINARIES lookup, never a derived string', () => {
  const body = functionBody(SRC, 'canonicalBinary');
  assert.ok(body, 'POSITIVE CONTROL: canonicalBinary not found in measure.mjs — this test measured NOTHING');

  const returns = returnStatements(body);
  assert.equal(
    returns.length, 1,
    `POSITIVE CONTROL: expected exactly one return statement, found ${returns.length}: ${JSON.stringify(returns)}`,
  );
  assert.match(
    returns[0],
    /^return\s+ALLOWED_BINARIES\[[A-Za-z_$][\w$]*\];$/,
    'canonicalBinary must return a value read OUT of the frozen table. `return key` / `return bin` / ' +
    '`return bin.toLowerCase()` all produce the same string and are all the CWE-078 dataflow edge back. ' +
    'If this shape is changing on purpose, the alert-983 triage in measure.mjs has to be re-argued first.',
  );
  // Complementary, not redundant: the shape above permits `ALLOWED_BINARIES[bin]`
  // (an index by the RAW argument), which is a different defect — case
  // sensitivity — and is what the behavioural `canonicalBinary('GH')` assertions
  // above hold shut. Neither test catches the other's arm.
});

test('SHAPE: the spawnSync options carry no spread, and shell:false is literal', () => {
  const call = SRC.indexOf('spawnSync(plan.cmd, plan.argv, {');
  assert.notEqual(call, -1, 'POSITIVE CONTROL: the spawnSync call was not found — this test measured NOTHING');
  const block = braceBlock(SRC, SRC.indexOf('{', call));
  assert.ok(block && /windowsHide/.test(block), 'POSITIVE CONTROL: the options object did not extract cleanly');
  const opts = stripLineComments(block);
  assert.ok(/windowsHide/.test(opts), 'POSITIVE CONTROL: comment stripping ate the options object');

  assert.ok(
    !/\.\.\./.test(opts),
    'a SPREAD is back in the spawnSync options. Placed after `shell: false` it silently outranks it, so a ' +
    `plan could set shell/env/cwd/uid. Read every option BY NAME instead. Options block:\n${opts}`,
  );
  const shellKeys = opts.match(/(^|[\s,{])shell\s*:\s*[^,\n]*/g) || [];
  assert.equal(shellKeys.length, 1, `expected exactly one \`shell:\` key, found ${shellKeys.length}`);
  assert.match(
    shellKeys[0].trim(),
    /^shell\s*:\s*false\s*,?$/,
    '`shell` must be the literal `false`, not a variable, a plan field, or an expression',
  );
  assert.match(
    opts,
    /windowsVerbatimArguments\s*:\s*plan\.verbatim\b/,
    'windowsVerbatimArguments must be read off the plan BY NAME — that is what replaced the spread',
  );
});

test('SHAPE: the cmd.exe command line keeps its outer quote pair', () => {
  const body = functionBody(SRC, 'spawnPlan');
  assert.ok(body, 'POSITIVE CONTROL: spawnPlan not found in measure.mjs — this test measured NOTHING');
  const argvLine = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.includes("'/c'"));
  assert.ok(argvLine, "POSITIVE CONTROL: no `'/c'` argument found in spawnPlan — this test measured NOTHING");
  assert.match(
    argvLine,
    /`"\$\{buildCmdLine\(.*\)\}"`/,
    'the /c argument must wrap buildCmdLine in a literal outer quote pair. cmd strips it, leaving the inner ' +
    'quoting intact; without it `/s` has nothing to strip and the documented invariant in README.md is false. ' +
    `Got: ${argvLine}`,
  );
});

test('SHAPE: spawnPlan reads `bin` ONLY to canonicalise it — nothing else consumes it', () => {
  // The behavioural companion to this is the PRODUCTION PATH test above, which
  // catches the same class by execution. This one catches it on EVERY branch,
  // including the two that only exist on the other platform, and it catches a
  // new read of `bin` that no payload happens to reach. Neither subsumes the
  // other: an enumeration of the mutations already tried is exactly the failure
  // mode this file's header warns about, so the assertion is on the POPULATION
  // of `bin` reads, not on a list of known-bad expressions.
  const body = functionBody(SRC, 'spawnPlan');
  assert.ok(body, 'POSITIVE CONTROL: spawnPlan not found in measure.mjs — this test measured NOTHING');
  const src = stripLineComments(body);
  assert.ok(/canonicalBinary/.test(src), 'POSITIVE CONTROL: comment stripping ate spawnPlan — this test measured NOTHING');

  const binReads = src.match(/\bbin\b/g) || [];
  assert.equal(
    binReads.length, 2,
    'spawnPlan must read `bin` exactly twice: the SELF_NODE comparison, and the argument to canonicalBinary. ' +
    `Found ${binReads.length}. Any third read is a path for the CALLER's string to reach the spawn — the ` +
    `#3971 shape (validate a projection, spawn the original). Body:\n${src}`,
  );
  assert.match(src, /\bbin\s*===\s*SELF_NODE\b/, 'the first `bin` read must be the SELF_NODE identity check');
  assert.match(
    src,
    /(?:^|\n)\s*const\s+file\s*=\s*canonicalBinary\(bin\);/,
    'the second `bin` read must be `const file = canonicalBinary(bin);`. `canonicalBinary(bin)` called for its ' +
    'THROW and then discarded — with `file` bound to `bin` — is the exact mutation that survived the previous ' +
    'revision of this suite.',
  );

  const fileBindings = src.match(/(?:const|let|var)\s+file\s*=/g) || [];
  assert.equal(fileBindings.length, 1, `expected exactly one \`file\` binding, found ${fileBindings.length}`);

  // Every value that can BECOME the executable, enumerated from the source
  // rather than assumed. The population assertion is what stops a needle that
  // matches zero times reading like a pass.
  const cmdValues = (src.match(/\bcmd:\s*([^,\n]+)/g) || []).map((s) => s.replace(/^\bcmd:\s*/, '').trim());
  assert.equal(cmdValues.length, 3, `expected exactly three \`cmd:\` fields, found ${cmdValues.length}: ${JSON.stringify(cmdValues)}`);
  for (const v of cmdValues) {
    assert.ok(
      v === 'process.execPath' || v === 'file' || v === "'cmd.exe'",
      `\`cmd: ${v}\` is not one of the three values this file guarantees can reach spawnSync ` +
      "(process.execPath, the canonicalised `file`, or the literal 'cmd.exe').",
    );
  }
});

// ────────────────── every platform: the cmd.exe LINE, without a cmd.exe to run
//
// The matrix below this point is the real thing — payloads through cmd.exe on a
// real .cmd shim — and it is SKIPPED on every lane this repo has. So the same
// payloads run through the same `buildCmdLine` here, and cmd.exe's own liveness
// rule is applied to the result: cmd decides whether `& | < > ( ) ^` is a
// metacharacter by a running quote toggle over the raw line, and understands no
// escape at all (not `\"`, not `^"`). Modelling that one rule is cheap and it is
// what quoteForCmd is written against.
//
// This is a weaker claim than the win32 matrix — it proves the LINE is quoted,
// not that cmd.exe then behaves — and it is the strongest one available on a
// runner with no cmd.exe. It is not a substitute for the Windows lane.

/** Offsets of every metacharacter cmd.exe would treat as LIVE in `line`. */
function liveMetachars(line) {
  const hits = [];
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && '&|<>()^'.includes(c)) hits.push(`${c}@${i}`);
  }
  return hits;
}

test('the built cmd.exe line leaves no metacharacter LIVE', () => {
  const marker = 'C:\\scratch\\PWNED.txt';
  for (const [name, payload] of payloads(marker)) {
    const line = buildCmdLine('npm.cmd', [payload]);
    assert.deepEqual(
      liveMetachars(line), [],
      `${name}: a metacharacter survives OUTSIDE quotes — cmd.exe would act on it: ${line}`,
    );
  }
});

test('POSITIVE CONTROL: liveMetachars can actually see an unquoted metacharacter', () => {
  // Without this the assertion above passes just as happily on a detector that
  // returns [] unconditionally — "nothing is live" and "I cannot see live" are
  // the same empty array.
  //
  // Two independent halves, because a control derived only from the detector
  // itself would move with it:
  //
  //   (a) hand-built lines whose verdict is known by inspection, so the detector
  //       is checked against something it did not produce;
  //   (b) POPULATION ACCOUNTING over the real matrix — how many rows the
  //       detector can discriminate at all. The first version of this test
  //       filtered on `!payload.includes('"')` and MEASURED 0 of 8 rows, i.e. it
  //       would have proven nothing while reading green. The floor is what
  //       catches that.
  assert.notDeepEqual(liveMetachars('npm.cmd x& echo hi'), [], 'a bare `&` outside quotes must read as LIVE');
  assert.notDeepEqual(liveMetachars('npm.cmd a|b'), [], 'a bare `|` outside quotes must read as LIVE');
  assert.deepEqual(liveMetachars('npm.cmd "x& echo hi"'), [], 'the same `&` INSIDE quotes must read as inert');
  assert.deepEqual(liveMetachars('npm.cmd plain'), [], 'a line with no metacharacter must read as clean');

  const marker = 'C:\\scratch\\PWNED.txt';
  const rows = injectionPayloads(marker);
  const discriminable = rows.filter(([, p]) => liveMetachars(`npm.cmd ${p}`).length > 0);
  assert.ok(
    discriminable.length >= 6,
    `only ${discriminable.length} of ${rows.length} payloads are discriminable unquoted — the matrix above ` +
    'is losing its teeth. (Two rows are legitimately invisible to this detector: `quote-breakout` supplies ' +
    "its own quote toggles, and the fidelity row carries no metacharacter at all — those are the win32 " +
    "matrix's to catch, not this one's.)",
  );
});

test('the built cmd.exe line REFUSES what it cannot quote', () => {
  // MEASURED: without this, mutating away the `%` refusal or the CR/LF refusal
  // left this suite at rc=0, 10 pass, 4 skipped on a Linux-like platform — the
  // only assertions holding them shut were in the win32 matrix, which skips
  // there. Two of the triage's load-bearing sentences were unguarded on every
  // lane the repo actually runs.
  //
  // Not a duplicate of cmd-quote.test.mjs: that file tests `quoteForCmd` in
  // isolation, this one goes through `buildCmdLine` — the exact call measure.mjs
  // makes — so a refusal dropped at the join layer is caught here and not there.
  for (const bad of ['%COMSPEC%', 'name-%-mid']) {
    assert.throws(
      () => buildCmdLine('npm.cmd', [bad]),
      (e) => /'%'/.test(e.message),
      `${bad}: a % argument must be refused, not silently expanded`,
    );
  }
  for (const nl of ['a\nb', 'a\rb', 'a\r\nb', "resources\n| where type =~ 'x'"]) {
    assert.throws(
      () => buildCmdLine('npm.cmd', [nl]),
      (e) => /newline/.test(e.message),
      `${JSON.stringify(nl)} must be refused, not truncated at rc=0`,
    );
  }
});

test('POSITIVE CONTROL: buildCmdLine is not refusing every argument', () => {
  // A refusal rate of 100% passes the test above and takes the toolkit down.
  const arm = '/subscriptions/0000/resourceGroups/rg/providers/Microsoft.Web/sites/app';
  assert.match(buildCmdLine('npm.cmd', [arm, '--query', 'a b']), /--query "a b"$/);
});

// ──────────────────────────────────── win32 ONLY: the cmd.exe shell path
//
// SKIPPED ON EVERY CI LANE THIS REPO HAS — see the header. Local evidence.
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
    for (const [name, payload] of injectionPayloads(marker)) {
      if (fs.existsSync(marker)) fs.rmSync(marker);
      const r = run('npm', [payload]);
      const got = JSON.parse(r.stdout.match(/CHILD_ARGV=(.*)/)[1]);
      assert.equal(
        fs.existsSync(marker), false,
        `${name}: COMMAND INJECTION — a second command executed through cmd.exe`,
      );
      assert.deepEqual(got, [payload], `${name}: fidelity — must arrive byte-for-byte as one argument`);
    }
    // The fidelity rows carry no metacharacter, so only the deepEqual is
    // meaningful for them — asserting "no marker" there would be vacuous.
    for (const [name, payload] of fidelityPayloads()) {
      const r = run('npm', [payload, '--query', 'SECRET']);
      assert.deepEqual(
        JSON.parse(r.stdout.match(/CHILD_ARGV=(.*)/)[1]),
        [payload, '--query', 'SECRET'],
        `${name}: the closing quote was consumed — later arguments spliced into this one`,
      );
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
