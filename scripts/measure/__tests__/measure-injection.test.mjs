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
 *   runs rc=0, 20 pass, 5 SKIPPED (25 tests; win32 rc=0, 25 pass, 0 skipped).
 *   The fifth skip is NOT a CI gap:
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
 *     - `SHAPE:` tests read both files' source and pin nine structures that
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
 *   ROUND 3 — the guard was keyed to `bin`, and the EXECUTABLE is not always `bin`
 *
 *   An independent review defeated round 2 by going one level out AGAIN. Round 2
 *   pinned the identifier `bin`; on the cmd.exe branch — the ONLY branch with a
 *   shell, and the entire subject of alert 983 — `cmd:` is the literal 'cmd.exe'
 *   and the program that actually runs is `buildCmdLine`'s FIRST ARGUMENT, which
 *   nothing constrained. The comment at the `cmd:` population assertion claimed
 *   to enumerate "every value that can BECOME the executable" and enumerated the
 *   `cmd:` fields only: the deploy-integrity R7 defect, third instance in this
 *   file's history.
 *
 *   MEASURED against round 2, isolated copies, baseline green first in both
 *   columns (win32 rc=0 18/0/0; forced-linux rc=0 13 pass/5 skipped). All four
 *   SURVIVED at rc=0 in BOTH columns — `cmd:` stays 'cmd.exe', the `bin` read
 *   count stays at 2, the `file` binding count stays at 1:
 *
 *     R12  buildCmdLine(process.env.LOOM_BIN || file, args)
 *     R11  needsWrapper returns the PATH-resolved path, spawnPlan interpolates it
 *          — violating measure.mjs's own written invariant that it never is
 *     RA   const alias = process.env.LOOM_BIN || file, interpolated in file's place
 *     R1   run() rewrites plan.cmd AFTER spawnPlan returned, non-cmd.exe branch
 *          only — the window between construction and the spawn, which every
 *          round-2 assertion was scoped to miss
 *
 *   ROUND 3, PART TWO — the round-3 fix reproduced the SAME shape, one ring out
 *
 *   The first round-3 guard pinned buildCmdLine's arg-0 and froze spawnPlan's
 *   vocabulary. Two arms invented against IT leave spawnPlan's body BYTE-
 *   IDENTICAL, so every function-scoped assertion sees nothing. MEASURED off
 *   that revision's own green baseline (win32 rc=0 20p/0f/0s; forced-linux rc=0
 *   15p/0f/5s), both SURVIVED at rc=0 in both columns:
 *
 *     E1   a top-level `function buildCmdLine` shadowing the import and
 *          forwarding `process.env.LOOM_BIN || f` to the real one
 *     E3   `gh: process.env.LOOM_GH || 'gh'` inside ALLOWED_BINARIES — which
 *          keeps canonicalBinary returning `ALLOWED_BINARIES[key]` exactly as
 *          its own SHAPE test demands, and makes the TABLE the taint source
 *
 *   E7 (`file = process.env.LOOM_BIN || file` at the top of cmd-quote.mjs's
 *   buildCmdLine) survived every measure.mjs-only formulation, which is why the
 *   control that closes these covers BOTH files.
 *
 *   That control is keyed to the TAINT SOURCE, not to any of those shapes:
 *   measure.mjs:181-183 already claims "Every value that can become the
 *   EXECUTABLE originates in this file … Nothing derived from argv or the
 *   environment does", and nothing enforced that sentence. `SHAPE: the
 *   taint-source population …` IS that sentence — every `process.<member>` read
 *   in both files, counted, with the bare-`process` total counted separately so
 *   a computed access cannot slip past the member enumeration. All ten round-3
 *   arms are rc1 RED in BOTH columns against the current revision.
 *
 *   THE ROUND-3 GUARDS, MUTATED
 *
 *     GS  break the suite's comment stripper so PROSE counts as code (13
 *         `process.X` mentions against 5 real reads)   rc1 RED both columns
 *         — caught by the stripper's POSITIVE CONTROL, not by the count
 *           drifting. A drifting count gets "corrected" upward and the slack
 *           then hides a real read.
 *     GB  revert `functionBody` to the pre-round-3 version, which returned
 *         run()'s destructured DEFAULTS (71 chars) rather than its body — a
 *         wrong extraction that reads exactly like a successful one
 *                                                     rc1 RED both columns
 *     GV  rename spawnPlan's `file` binding to `f`, behaviour-preserving
 *                                                     rc1 RED both columns
 *         — MEASURED reason: the vocabulary diff names `f` added, `file`
 *           removed. Fails CLOSED on a rename, in both directions.
 *     GE  delete the `process.env.PATH` read entirely  rc1 RED both columns
 *         — MEASURED reason: `expected {…"process.env":1…} found {…}`. The
 *           population fails CLOSED when a member DISAPPEARS, not only when one
 *           is added.
 *
 *   ROUND 4 — the token `process` is a SPELLING, and `args` needs no token
 *
 *   An independent review of round 3 defeated it SIX ways, five proven as live
 *   execution of an attacker-named binary through `run()`. Measured off round
 *   3's own green baseline (win32 rc=0 21p/0f/0s; forced-linux rc=0 16p/0f/5s),
 *   all SURVIVED at rc=0 in BOTH columns:
 *
 *     SS-TABLE   `/**` + `/` prefixed onto the ALLOWED_BINARIES line, with
 *                `gh: process.env.LOOM_GH || 'gh'` after it. A LITERAL
 *                environment read, hidden by a bug in round 3's own comment
 *                stripper: it dropped any line whose trimmed text STARTED with
 *                a block-comment opener, code included. The counts matched
 *                perfectly while counting the wrong text.
 *     NP-TABLE   `globalThis['pro' + 'cess'].env.LOOM_GH` in the table
 *     NP-SHADOW  the same, in a module-scope buildCmdLine shadow
 *     NP-CQ      the same, inside cmd-quote.mjs's buildCmdLine
 *     ARGV-EXEC  a module-scope buildCmdLine shadow deriving arg-0 from the
 *                CALLER'S args — no environment, no `process`, no obfuscation
 *     CQ-ARGV    the same derivation inside cmd-quote.mjs's own buildCmdLine
 *
 *   ARGV-EXEC is the sharpest: `args` IS the documented alert-983 source
 *   (drain-status.mjs:18 and red-tally.mjs:17 feed `process.argv` into `run`),
 *   and no taint-token contract can ever see it.
 *
 *   What closes them, by mechanism rather than by spelling:
 *
 *     - `stripComments` now removes the comment SPAN and never a line, and has
 *       its OWN fixture test. The counts it feeds are not its control: a
 *       stripper that eats code makes every count match.
 *     - `SHAPE: every name spawnPlan CALLS has exactly one top-level origin`
 *       — the callee list is DERIVED from spawnPlan's body, and buildCmdLine's
 *       single origin must be the import from './cmd-quote.mjs'. Closes both
 *       shadows.
 *     - `SHAPE: neither file can reach an ambient global` — `globalThis`,
 *       `global`, `eval`, `Function`, `require`, `module`, `exports` and
 *       dynamic `import(` pinned at ZERO in both files. A population of zero
 *       cannot be satisfied by an alias or a computed key.
 *     - `the built command line ALWAYS begins with the file it was given` —
 *       BEHAVIOURAL, and the only thing that can follow a value into another
 *       file. For all seven allowlisted names and every payload, the line
 *       `buildCmdLine` returns must start with the name it was handed. Closes
 *       CQ-ARGV and any `quoteForCmd` that rewrites its first token.
 *
 *   The round-4 guards were mutated too: reverting the stripper (GX), breaking
 *   the origin test's import parser (GO), and emptying the token list (GA) or
 *   the binary list (GP) so a loop iterates zero times all go rc=1 RED in both
 *   columns. GA and GP were real vacuity holes in the round-4 tests, found by
 *   mutating them and closed before the arms were recorded.
 *
 * WHAT THESE GUARDS ARE FOR, AND WHAT THEY CANNOT DO
 *
 *   Every `SHAPE:` assertion here reads source TEXT, and against an author who
 *   is deliberately hiding a reintroduction, source text is not a boundary and
 *   cannot be made into one — anyone who can edit this file can write the sink
 *   directly, and no assertion living in the same repository outranks that.
 *
 *   Four rounds have each been defeated by moving one scope outward: the call
 *   site, then the cmd.exe branch, then module scope, then an obfuscated global.
 *   The honest reading of that sequence is NOT that round four is finally
 *   airtight. It is that these guards catch REGRESSION and DECAY, which is what
 *   they exist for: the alert-983 triage is a claim, and a claim nobody re-runs
 *   becomes folklore the first time someone edits the file.
 *
 *   So where completeness is claimed below it is scoped explicitly to a named
 *   function body, and it is stated where the next ring is open. NOT covered:
 *   `quoteForCmd`'s internals beyond its own suite in cmd-quote.test.mjs;
 *   anything below `node:child_process`; and any construct none of the 34 arms
 *   in `__tests__/injection-arms.mjs` models. Those are gaps, named as gaps.
 *
 *   `node scripts/measure/__tests__/injection-arms.mjs` runs all 34 arms and
 *   exits 0 only if every one matches the verdict written here. MEASURED
 *   2026-08-26: rc=0, "ALL 34 ARMS MATCH THEIR DOCUMENTED VERDICT", off a
 *   baseline of win32 rc=0 25p/0f/0s and forced-linux rc=0 20p/0f/5s. Flipping
 *   one arm's recorded verdict makes it exit 1 with `*** EXPECTED SURVIVED ***`
 *   — measured, not assumed. It REFUSES to run on a non-win32 host, because its
 *   `win32` column means "un-forced on this host" and on an ubuntu runner that
 *   column would silently be linux; that refusal is also why it is still not
 *   wired into `guardrails`, where every lane is Linux.
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
/** cmd-quote.mjs, likewise — it is the other half of the cmd.exe command line. */
const CMD_QUOTE_MJS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cmd-quote.mjs');

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
 *
 * The PARAMETER LIST is skipped by balancing parens first. Without that step
 * `indexOf('{')` finds the first brace after the name, and for `run` — whose
 * signature ends `, { allowNonZero = false, … } = {})` — that brace opens the
 * DESTRUCTURED DEFAULTS. MEASURED: the previous version returned those 71
 * characters for `run` and every downstream assertion would have been made
 * against them, which is a wrong extraction that reads exactly like a
 * successful one. Byte-identical for `spawnPlan`, `canonicalBinary` and
 * `needsWrapper`, whose parameter lists contain no braces.
 *
 * @returns {string|null} null when the function is absent — never an empty
 * string, so a caller cannot mistake "not found" for "found and empty".
 */
function functionBody(src, name) {
  const m = new RegExp(`^(?:export )?function ${name}\\s*\\(`, 'm').exec(src);
  if (!m) return null;
  let depth = 0;
  let i = src.indexOf('(', m.index);
  for (; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') { depth -= 1; if (depth === 0) break; }
  }
  if (i >= src.length) return null;
  return braceBlock(src, src.indexOf('{', i));
}

/**
 * The argument lists of every `<name>(…)` call in `body`, split at top-level
 * commas by balancing `()[]{}`.
 *
 * @returns {string[][]} one entry per call site — so the CALLER asserts the
 * population and a name that appears zero times cannot read like a pass.
 */
function callSites(body, name) {
  const calls = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(body)) !== null) {
    const open = body.indexOf('(', m.index);
    const args = [];
    let depth = 0;
    let start = open + 1;
    for (let i = open; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) { args.push(body.slice(start, i).trim()); break; }
      } else if (ch === ',' && depth === 1) {
        args.push(body.slice(start, i).trim());
        start = i + 1;
      }
    }
    calls.push(args);
  }
  return calls;
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

/**
 * Drop comments, keeping every line and every scrap of CODE on it.
 *
 * The whole-line stripper above is not enough at FILE scope: measure.mjs's block
 * comments quote the very expressions the module-scope test below counts — the
 * doc above needsWrapper says "which put `process.env.PATH` on a dataflow path".
 * MEASURED: 13 `process.X` occurrences in the raw text against 5 real reads.
 *
 * TWO WAYS THIS CAN LIE, IN OPPOSITE DIRECTIONS, AND ONLY ONE IS SAFE:
 *
 *   - Strip too LITTLE and prose gets counted. The population never matches, the
 *     expected number gets "corrected" upward to accommodate prose, and a real
 *     read then hides in the slack. Loud, but corrodes.
 *   - Strip too MUCH and real code vanishes from the counted text. SILENT, and a
 *     straight miss. MEASURED: the first version of this dropped any line whose
 *     trimmed text STARTED with a block-comment opener — including the code
 *     after the closer. Prefixing the ALLOWED_BINARIES line with an empty block
 *     comment and writing `gh: process.env.LOOM_GH || 'gh'` after it SURVIVED at
 *     rc=0 in both columns, and ran an attacker-named binary end to end.
 *
 * So this removes the comment SPAN and never a line. `//` is honoured only when
 * it starts the line, because a trailing one may be inside a string or a regex
 * (`/[\s"^&|<>()]/` at cmd-quote.mjs:84 is exactly that) — and keeping a real
 * comment can only cause a false RED, which is the safe direction. The stripper
 * has its own fixture test below; that fixture is the control, not the counts.
 */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split(/\r?\n/)) {
    let rest = raw;
    let kept = '';
    for (;;) {
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end === -1) { rest = ''; break; }
        inBlock = false;
        rest = rest.slice(end + 2);
        continue;
      }
      const open = rest.indexOf('/*');
      const lineComment = /^\s*\/\//.test(rest) ? rest.search(/\/\//) : -1;
      if (lineComment !== -1 && (open === -1 || lineComment < open)) { rest = ''; break; }
      if (open === -1) { kept += rest; rest = ''; break; }
      kept += rest.slice(0, open);
      inBlock = true;
      rest = rest.slice(open + 2);
    }
    out.push(kept);
  }
  return out.join('\n');
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

  // ── the EXECUTABLE positions. Two of them, and the second one is the branch
  // that matters.
  //
  // A previous revision of this comment claimed to enumerate "every value that
  // can BECOME the executable" and then listed the `cmd:` fields only. That was
  // FALSE, and it is the deploy-integrity R7 defect this directory exists to
  // catch — the third instance in this file's history. On the cmd.exe branch
  // `cmd:` is the literal `'cmd.exe'` and the program that actually runs is
  // buildCmdLine's FIRST ARGUMENT, which nothing constrained. MEASURED
  // 2026-08-26 against that revision, isolated copies, green baseline first:
  // `buildCmdLine(process.env.LOOM_BIN || file, args)` and
  // `buildCmdLine(needsWrapper(file), args)` (with needsWrapper returning the
  // PATH-resolved path it is documented never to return) both SURVIVED at rc=0
  // 18p/0f/0s win32 and rc=0 13p/0f/5s forced-linux, as did a `const alias =
  // process.env.LOOM_BIN || file` binding interpolated in file's place.
  const cmdValues = (src.match(/\bcmd:\s*([^,\n]+)/g) || []).map((s) => s.replace(/^\bcmd:\s*/, '').trim());
  assert.equal(cmdValues.length, 3, `expected exactly three \`cmd:\` fields, found ${cmdValues.length}: ${JSON.stringify(cmdValues)}`);
  for (const v of cmdValues) {
    assert.ok(
      v === 'process.execPath' || v === 'file' || v === "'cmd.exe'",
      `\`cmd: ${v}\` is not one of the three values this file guarantees can reach spawnSync ` +
      "(process.execPath, the canonicalised `file`, or the literal 'cmd.exe').",
    );
  }

  const lines = callSites(src, 'buildCmdLine');
  assert.equal(
    lines.length, 1,
    'spawnPlan must build the cmd.exe command line exactly ONCE. ' +
    `Found ${lines.length}. Zero means this assertion measured nothing; more than one means there is a ` +
    'second command line whose executable this test never looked at.',
  );
  assert.equal(
    lines[0][0], 'file',
    `the cmd.exe command line's FIRST argument is the program cmd.exe runs, and it must be the canonicalised ` +
    `\`file\` — not \`${lines[0][0]}\`. This is the only branch with a shell and the entire subject of alert ` +
    '983. `process.env.X || file`, `needsWrapper(file)`, and an aliased binding all leave `cmd: \'cmd.exe\'` ' +
    'and the `bin` read count untouched, and all three were MEASURED surviving before this assertion existed.',
  );
});

test('SHAPE: spawnPlan\'s vocabulary is CLOSED — no new name can enter the function', () => {
  // The two assertions above pin the executable POSITIONS spawnPlan has today.
  // This is what makes that enumeration complete WITHIN THIS FUNCTION BODY — and
  // only within it. The set of names spawnPlan may mention is frozen, so a new
  // call, a new binding, a new property read, or a new environment lookup cannot
  // appear anywhere in the function without failing here, wherever its value
  // would have flowed.
  //
  // It is NOT complete for the file. Where those names COME FROM is module
  // scope, and MEASURED 2026-08-26 a top-level `buildCmdLine` shadow deriving
  // arg-0 from the caller's `args` survived every assertion in this function
  // while leaving its body byte-identical. That is closed by `SHAPE: every name
  // spawnPlan CALLS has exactly one top-level origin`, not by this test. Read
  // the two together; neither is sufficient alone.
  //
  // Deliberately NOT a list of forbidden names (`env`, `execSync`, `require`, …)
  // — that is the spelling-keyed guard this file's header warns about, and an
  // attacker-shaped value does not have to use a spelling anyone enumerated.
  //
  // Tokens contributed by STRING LITERALS are included on purpose (`cmd`, `exe`
  // from 'cmd.exe'; `d`, `s`, `c` from the cmd.exe switches; `$` from the
  // template's `${`). A new literal is a vocabulary change too, and blanking
  // literals would need a mini-lexer whose bugs would be silent.
  const body = functionBody(SRC, 'spawnPlan');
  assert.ok(body, 'POSITIVE CONTROL: spawnPlan not found in measure.mjs — this test measured NOTHING');
  const src = stripLineComments(body);
  assert.ok(/canonicalBinary/.test(src), 'POSITIVE CONTROL: comment stripping ate spawnPlan — this test measured NOTHING');

  const allowed = [
    '$', 'SELF_NODE', 'args', 'argv', 'bin', 'buildCmdLine', 'c', 'canonicalBinary', 'cmd',
    'const', 'd', 'exe', 'execPath', 'false', 'file', 'if', 'needsWrapper', 'process',
    'return', 's', 'true', 'verbatim',
  ];
  const found = [...new Set(src.match(/[A-Za-z_$][\w$]*/g) || [])].sort();
  assert.deepEqual(
    found, [...allowed].sort(),
    'spawnPlan\'s vocabulary changed. Every name in this function is either a value that can determine WHAT ' +
    'gets spawned or part of the syntax that carries one, so a name entering or leaving it is a change to the ' +
    'alert-983 dataflow argument in measure.mjs. Re-argue that triage FIRST, then update this list — in that ' +
    `order, never the other way round.\n  expected: ${JSON.stringify([...allowed].sort())}\n  found:    ${JSON.stringify(found)}`,
  );
});

test('SHAPE: run() never rewrites the plan between spawnPlan and spawnSync', () => {
  // spawnPlan's guarantees are about the object it RETURNS. Everything above
  // pins its source; nothing pinned the window between `plan = spawnPlan(…)`
  // and the `spawnSync(plan.cmd, …)` twelve lines later, where `bin` — the
  // caller's own string — is still in scope. MEASURED 2026-08-26: inserting
  // `if (plan.cmd !== 'cmd.exe' && typeof bin === 'string') plan.cmd = bin;`
  // into run() SURVIVED at rc=0 in BOTH columns. It targets the branch the
  // behavioural PRODUCTION PATH test does not reach on this host, and that test
  // stands down entirely in the forced-linux column, so nothing saw it.
  //
  // Keyed to the SHAPE of a write — `plan`, optionally through any property
  // path, followed by a single `=` — not to a list of properties. `plan.cmd`,
  // `plan.argv`, `plan.verbatim` and any field a later revision adds are all
  // covered by the same expression.
  const body = functionBody(SRC, 'run');
  assert.ok(body, 'POSITIVE CONTROL: run not found in measure.mjs — this test measured NOTHING');
  assert.ok(
    /spawnSync\(/.test(body) && !/^\s*allowNonZero/.test(body),
    'POSITIVE CONTROL: the extracted body is not run() — it must contain the spawnSync call and must NOT be ' +
    `the destructured parameter defaults. Got: ${JSON.stringify(body.slice(0, 120))}`,
  );
  const src = stripLineComments(body);

  const writes = src.match(/\bplan\b(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*=(?!=)/g) || [];
  assert.equal(
    writes.length, 1,
    'run() must write to `plan` exactly ONCE — the construction itself. ' +
    `Found ${writes.length}: ${JSON.stringify(writes)}. Zero means this assertion measured nothing; a second ` +
    'write is a path for a value spawnPlan refused to produce to become the executable anyway.',
  );
  assert.ok(
    !writes[0].includes('.'),
    `the single write to \`plan\` must replace the whole object, never a field of it. Got: ${JSON.stringify(writes[0])}`,
  );
  assert.match(
    src,
    /(?:^|\n)\s*plan\s*=\s*spawnPlan\(bin,\s*args\);/,
    'that one write must be `plan = spawnPlan(bin, args);` — the plan comes from the guarded builder and from ' +
    'nowhere else.',
  );
});

test('POSITIVE CONTROL: stripComments removes PROSE and keeps CODE that shares its line', () => {
  // This fixture is the control for the population test below, and it exists
  // because the counts are NOT their own control: a stripper that eats real code
  // makes every count match perfectly while measuring the wrong text. Each row
  // is a shape that has actually been used against this suite.
  const cases = [
    ['/**/  gh: process.env.LOOM_GH,', 'process.env.LOOM_GH', true],
    ['  /* why */ spawnSync(bin, args);', 'spawnSync', true],
    ['  const x = 1; /* trailing prose process.env.PATH */', 'process.env', false],
    ['  const y = 2; /* trailing prose process.env.PATH */', 'const y', true],
    ['  // process.env.LOOM_X is only prose here', 'process.env', false],
    ['  let line = quoteForCmd(String(file).replace(/\\//g, String.fromCharCode(92)));', 'quoteForCmd', true],
  ];
  for (const [input, needle, shouldKeep] of cases) {
    const got = stripComments(input);
    assert.equal(
      got.includes(needle), shouldKeep,
      `stripComments(${JSON.stringify(input)}) => ${JSON.stringify(got)}: expected ${shouldKeep ? 'to KEEP' : 'to DROP'} ` +
      `${JSON.stringify(needle)}. Dropping code is the SILENT failure — it makes the population below match perfectly ` +
      'while counting the wrong text.',
    );
  }
  // A block comment spanning lines must not eat the code after its closer.
  const multi = stripComments(['/**', ' * prose process.env.LOOM_A', ' */', "  gh: process.env.LOOM_B,"].join('\n'));
  assert.ok(!multi.includes('LOOM_A'), `multi-line prose survived: ${JSON.stringify(multi)}`);
  assert.ok(multi.includes('process.env.LOOM_B'), `code after the closer was eaten: ${JSON.stringify(multi)}`);
  // Line count is preserved — a stripper that deletes lines is one that can
  // delete code.
  assert.equal(stripComments('a\n/* x */\nb').split('\n').length, 3, 'stripComments must blank lines, never remove them');
});

test('SHAPE: every name spawnPlan CALLS has exactly one top-level origin', () => {
  // The vocabulary contract freezes which names spawnPlan may call. It says
  // nothing about where those names COME FROM, and at module scope that is a
  // third executable position. MEASURED 2026-08-26: a top-level
  // `function buildCmdLine(f, a)` shadowing the import and deriving arg-0 from
  // the CALLER'S args —
  //   `_bcl(String(a[0]).startsWith('!X:') ? String(a[0]).slice(3) : f, a)`
  // — SURVIVED at rc=0 in BOTH columns and executed an attacker-named binary end
  // to end. It leaves spawnPlan byte-identical and contains no `process` token
  // at all, so every function-scoped assertion AND the taint-source population
  // see nothing. `args` is the documented alert-983 source: drain-status.mjs:18
  // and red-tally.mjs:17 feed `process.argv` straight into `run`.
  //
  // The callee list is DERIVED from spawnPlan's body, not written here, so it
  // cannot drift from the vocabulary contract that freezes it.
  const body = functionBody(SRC, 'spawnPlan');
  assert.ok(body, 'POSITIVE CONTROL: spawnPlan not found in measure.mjs — this test measured NOTHING');
  const callees = [...new Set((stripLineComments(body).match(/\b[A-Za-z_$][\w$]*\s*\(/g) || [])
    .map((s) => s.replace(/\s*\($/, ''))
    .filter((n) => !['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof'].includes(n)))].sort();
  assert.deepEqual(
    callees, ['buildCmdLine', 'canonicalBinary', 'needsWrapper'],
    `spawnPlan's callees changed: ${JSON.stringify(callees)}. Each one decides or carries the executable.`,
  );

  const src = stripComments(SRC);
  const importBindings = new Map();
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';/gm)) {
    for (const raw of m[1].split(',')) {
      const t = raw.trim();
      if (!t) continue;
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(t);
      importBindings.set(as ? as[1] : t, m[2]);
    }
  }
  assert.ok(importBindings.size > 0, 'POSITIVE CONTROL: no import bindings parsed — this test measured NOTHING');

  for (const name of callees) {
    const declared = (src.match(new RegExp(`^(?:export )?(?:async )?function\\s+${name}\\b`, 'gm')) || []).length;
    const bound = (src.match(new RegExp(`^(?:export )?(?:const|let|var)\\s+${name}\\b`, 'gm')) || []).length;
    const imported = importBindings.has(name) ? 1 : 0;
    assert.equal(
      declared + bound + imported, 1,
      `\`${name}\` has ${declared + bound + imported} top-level origins in measure.mjs (function=${declared}, ` +
      `binding=${bound}, import=${imported}). Exactly one, or the last definition silently wins.`,
    );
  }
  assert.equal(
    importBindings.get('buildCmdLine'), './cmd-quote.mjs',
    "`buildCmdLine` must be the IMPORT from './cmd-quote.mjs'. A local function of that name shadows the quoting " +
    'layer entirely and chooses the program cmd.exe runs, while leaving spawnPlan byte-identical — MEASURED ' +
    `surviving before this assertion existed. Bound instead to: ${JSON.stringify(importBindings.get('buildCmdLine') ?? null)}`,
  );
});

test('SHAPE: neither file can reach an ambient global', () => {
  // The taint-source population counts `process.<member>` and the bare `process`
  // token. That is keyed to a SPELLING, and MEASURED 2026-08-26 three mutations
  // reached the same values without ever writing it — `globalThis['pro' +
  // 'cess'].env.LOOM_GH` in ALLOWED_BINARIES, in a buildCmdLine shadow, and in
  // cmd-quote.mjs — all SURVIVED at rc=0 in both columns and all executed an
  // attacker-named binary. So the population needs a companion that closes the
  // OTHER routes to the same object rather than another spelling of this one.
  //
  // Zero is the whole contract: neither file has any business reaching an
  // ambient global, and a population pinned at zero cannot be satisfied by an
  // alias, a computed key, or string concatenation.
  const forbidden = ['globalThis', 'global', 'eval', 'Function', 'require', 'module', 'exports'];
  assert.equal(
    forbidden.length, 7,
    'POSITIVE CONTROL: the forbidden list is not the expected size — emptying it makes every loop below iterate ' +
    'zero times and the test pass while measuring NOTHING.',
  );
  for (const [name, file] of [['measure.mjs', MEASURE_MJS], ['cmd-quote.mjs', CMD_QUOTE_MJS]]) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    assert.ok(/buildCmdLine|spawnSync/.test(src), `POSITIVE CONTROL: comment stripping ate ${name} — this test measured NOTHING`);
    for (const tok of forbidden) {
      const n = (src.match(new RegExp(`\\b${tok}\\b`, 'g')) || []).length;
      assert.equal(n, 0, `${name} mentions \`${tok}\` ${n} times. It is a route to the same objects the taint-source population pins, reachable without naming them.`);
    }
    const dynamic = (src.match(/\bimport\s*\(/g) || []).length;
    assert.equal(dynamic, 0, `${name} contains ${dynamic} DYNAMIC import(s). Only the frozen static specifier list is allowed.`);
  }
  // POSITIVE CONTROL: the detector can see these tokens when they are present.
  for (const tok of forbidden) {
    assert.equal((`x ${tok} y`.match(new RegExp(`\\b${tok}\\b`, 'g')) || []).length, 1, `the detector cannot see \`${tok}\` at all`);
  }
  assert.equal(('await import("x")'.match(/\bimport\s*\(/g) || []).length, 1, 'the dynamic-import detector cannot see one');
});

test('the built command line ALWAYS begins with the file it was given', () => {
  // Every contract above is source TEXT, and text cannot follow a value into
  // cmd-quote.mjs. MEASURED 2026-08-26: deriving arg-0 from `args` inside
  // `buildCmdLine` itself — `if (String(args[0]).startsWith('!X:')) file =
  // String(args[0]).slice(3)` — SURVIVED at rc=0 in both columns. No `process`
  // token, no change to measure.mjs, invisible to every SHAPE assertion.
  //
  // This is the behavioural companion, and it is the stronger claim because it
  // holds whatever the mechanism: for the only file values that can ever reach
  // this function — the seven ALLOWED_BINARIES literals — the line it returns
  // must START with that value, for EVERY argument. An argument that changes the
  // program cannot satisfy it, however it is spelled, and neither can a
  // quoteForCmd that rewrites its first token.
  const names = ['gh', 'az', 'git', 'node', 'npm', 'pnpm', 'pwsh'];
  assert.equal(
    names.length, 7,
    'POSITIVE CONTROL: the binary list is not the expected size — emptying it makes the loop below iterate zero ' +
    'times and every assertion in it vacuous.',
  );
  const marker = 'C:\\scratch\\PWNED.txt';
  const adversarial = [
    ['argv-prefix smuggling', '!X:evilprog'],
    ['absolute path', 'C:\\evil\\evilprog.exe'],
    ['relative path', '../evilprog'],
    ['bare name', 'evilprog'],
    ...payloads(marker),
  ];
  let checked = 0;
  for (const bin of names) {
    for (const [label, payload] of adversarial) {
      const line = buildCmdLine(bin, [payload]);
      assert.ok(
        line.startsWith(`${bin} `),
        `${bin} / ${label}: the built line does not begin with the file it was given — the ARGUMENT chose the ` +
        `program. Got: ${line}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 28, `POSITIVE CONTROL: only ${checked} combinations were checked — expected at least 28 (7 binaries x 4 adversarial shapes)`);
  // POSITIVE CONTROL: the assertion can actually FAIL. If it could not, every
  // row above is a tautology.
  assert.ok(!buildCmdLine('evilprog', ['x']).startsWith('gh '), 'the prefix check cannot distinguish two different programs');
});

test('SHAPE: the taint-source population of measure.mjs and cmd-quote.mjs is FIXED', () => {
  // Everything above is scoped to a function BODY. That is one level too narrow,
  // and it is the same mistake, one ring out, that this round was opened to fix.
  // MEASURED 2026-08-26 against the revision that added those tests, isolated
  // copies, green baseline first (win32 rc=0 20p/0f/0s; forced-linux rc=0
  // 15p/0f/5s) — two mutations that leave spawnPlan's body BYTE-IDENTICAL, so
  // the vocabulary contract, the `cmd:` pin and the buildCmdLine arg-0 pin all
  // see nothing, and both SURVIVED at rc=0 in BOTH columns:
  //
  //   - a top-level `function buildCmdLine(f, a)` shadowing the import and
  //     forwarding `process.env.LOOM_BIN || f` to the real one;
  //   - `gh: process.env.LOOM_GH || 'gh'` inside ALLOWED_BINARIES, which keeps
  //     canonicalBinary returning `ALLOWED_BINARIES[key]` exactly as its own
  //     SHAPE test demands while making the table's value environment-derived.
  //
  // A third, in cmd-quote.mjs (`file = process.env.LOOM_BIN || file` at the top
  // of buildCmdLine), also survived — which is why this test covers BOTH files.
  //
  // So the control is keyed to the taint source's IDENTIFIER rather than to any
  // of those three shapes. measure.mjs:181-183 claims "Every value that can
  // become the EXECUTABLE originates in this file … Nothing derived from argv or
  // the environment does", and until now nothing enforced it at all. This is the
  // ENVIRONMENT half of that sentence, as a population: every `process.<member>`
  // read in either file, counted, with the bare-`process` total counted
  // separately so a computed access (`process['env']`) cannot slip past the
  // member enumeration.
  //
  // BE PRECISE ABOUT WHAT THIS DOES NOT DO. It is keyed to the SPELLING
  // `process`, and MEASURED 2026-08-26 three mutations reached the same object
  // without writing it — `globalThis['pro' + 'cess'].env` in the table, in a
  // buildCmdLine shadow, and in cmd-quote.mjs — all SURVIVING this assertion at
  // rc=0 in both columns. Those are closed by `SHAPE: neither file can reach an
  // ambient global`, which is pinned at ZERO and therefore cannot be satisfied
  // by an alias or a computed key. The ARGV half of the sentence is not an
  // environment read at all and is closed behaviourally, by `the built command
  // line ALWAYS begins with the file it was given`. Three tests, three
  // mechanisms; this one on its own proves only the third of it.
  const files = {
    'measure.mjs': { src: stripComments(fs.readFileSync(MEASURE_MJS, 'utf8')), bare: 5, members: { 'process.execPath': 2, 'process.platform': 1, 'process.env': 1, 'process.stderr': 1 } },
    'cmd-quote.mjs': { src: stripComments(fs.readFileSync(CMD_QUOTE_MJS, 'utf8')), bare: 1, members: { 'process.platform': 1 } },
  };

  for (const [name, want] of Object.entries(files)) {
    assert.ok(
      /spawnSync|buildCmdLine/.test(want.src),
      `POSITIVE CONTROL: comment stripping ate ${name} — this test measured NOTHING`,
    );
    assert.ok(
      !/dataflow path|CVE-2024-27980/.test(want.src),
      `POSITIVE CONTROL: comment stripping left PROSE in ${name}, so every count below is of the wrong thing`,
    );

    const got = {};
    for (const m of (want.src.match(/\bprocess\s*\.\s*[A-Za-z_$][\w$]*/g) || [])) {
      const k = m.replace(/\s+/g, '');
      got[k] = (got[k] || 0) + 1;
    }
    assert.deepEqual(
      got, want.members,
      `the \`process.<member>\` population of ${name} changed. Every entry is a value the alert-983 triage ` +
      'argues cannot reach the executable; a new one is a new taint source and has to be argued for in ' +
      `measure.mjs BEFORE it is added here.\n  expected: ${JSON.stringify(want.members)}\n  found:    ${JSON.stringify(got)}`,
    );

    const bare = (want.src.match(/\bprocess\b/g) || []).length;
    assert.equal(
      bare, want.bare,
      `${name} mentions \`process\` ${bare} times but the member enumeration above accounts for ${want.bare}. ` +
      "A computed access (`process['env']`), a destructure (`const { env } = process`), or an alias reaches the " +
      'same values while matching no `process.<member>` needle — this count is what makes the enumeration a ' +
      'POPULATION rather than a list.',
    );
  }

  // The one environment read must stay where it is documented to be: inside
  // needsWrapper, which consumes the result for its EXTENSION and drops it.
  const raw = fs.readFileSync(MEASURE_MJS, 'utf8');
  const envReads = (stripComments(raw).match(/\bprocess\s*\.\s*env\s*\.\s*[A-Za-z_$][\w$]*/g) || []);
  assert.deepEqual(envReads.map((s) => s.replace(/\s+/g, '')), ['process.env.PATH'], 'the only environment read must be process.env.PATH');
  const nw = functionBody(raw, 'needsWrapper');
  assert.ok(nw, 'POSITIVE CONTROL: needsWrapper not found — this test measured NOTHING');
  assert.ok(
    stripComments(nw).includes('process.env.PATH'),
    'the single environment read moved OUT of needsWrapper. needsWrapper is the one function whose contract ' +
    'says the PATH scan discards what it finds; anywhere else that guarantee does not apply.',
  );

  // One sink, and one place the command line can come from.
  assert.equal(
    (stripComments(raw).match(/\bspawnSync\s*\(/g) || []).length, 1,
    'measure.mjs must contain exactly ONE spawnSync call. The options-block test finds it with indexOf, so a ' +
    'SECOND one is a sink no assertion in this file has ever looked at.',
  );
  const specifiers = [...stripComments(raw).matchAll(/^import[^;]*?from\s*'([^']+)';/gm)].map((m) => m[1]).sort();
  assert.deepEqual(
    specifiers, ['./cmd-quote.mjs', 'node:child_process', 'node:fs', 'node:path'],
    `measure.mjs's imports changed. buildCmdLine's origin is part of the executable's provenance, and a new ` +
    `module is a new one. Found: ${JSON.stringify(specifiers)}`,
  );
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
