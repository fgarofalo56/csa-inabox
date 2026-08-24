#!/usr/bin/env node
/**
 * cmd-quote.test.mjs — the .cmd launch path, tested without spawning anything.
 *
 * Run: node --test scripts/measure/cmd-quote.test.mjs
 *
 * This path was the library's ENTIRE reason to exist (`az` and `gh` are .cmd
 * shims on Windows), yet every test in measure.test.mjs spawns `node.exe`, so
 * the batch branch was never exercised and shipped throwing EINVAL. Splitting
 * the pure half out is what makes it testable on any platform, including the
 * Linux CI runner where no .cmd exists at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteForCmd, buildCmdLine, needsCmdWrapper, CmdQuoteError } from './cmd-quote.mjs';

test('quoteForCmd: values needing quotes get them; plain values do not', () => {
  assert.equal(quoteForCmd('plain'), 'plain');
  assert.equal(quoteForCmd(''), '""');
  assert.equal(quoteForCmd('has space'), '"has space"');
  assert.equal(quoteForCmd('a|b'), '"a|b"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""', 'inner quotes must be doubled for cmd');
});

test('quoteForCmd: a % argument is REFUSED, not silently expanded', () => {
  // cmd.exe expands %VAR% even inside double quotes and there is no reliable
  // command-line escape. Running a command different from the one requested is
  // exactly the class of silent wrongness this directory exists to prevent.
  assert.throws(() => quoteForCmd('%PATH%'), (e) => e instanceof CmdQuoteError && /would expand/.test(e.message));
  assert.throws(() => quoteForCmd('name-%-mid'), (e) => e instanceof CmdQuoteError);
  // CONTROL: a value WITHOUT % still passes, so the rule is not blanket-refusing.
  assert.equal(quoteForCmd('100-free-name'), '100-free-name');
});

test('buildCmdLine: an argument containing spaces survives as ONE token', () => {
  // The DEP0190 hazard: with shell:true Node concatenates args unescaped, so a
  // value with a space silently changes the command. Verbatim + explicit
  // quoting is what preserves it.
  const line = buildCmdLine('C:/p/az.cmd', ['graph', 'query', '-q', "resources | where name =~ 'a b'"]);
  assert.ok(line.startsWith('C:\\p\\az.cmd'), 'forward slashes must be normalised for cmd.exe');
  assert.ok(line.includes(`"resources | where name =~ 'a b'"`), 'the KQL argument must stay one token');
});

test('buildCmdLine: an ARM resource id passes through untouched (R3)', () => {
  // The leading-slash id is what Git Bash rewrote into a Windows path, turning
  // a real metric into null — and null was then read as zero. No shell here,
  // so it must survive verbatim.
  const id = '/subscriptions/SUB/resourceGroups/RG/providers/Microsoft.App/containerApps/loom-console';
  assert.ok(buildCmdLine('az.cmd', ['monitor', 'metrics', 'list', '--resource', id]).includes(id));
});

test('needsCmdWrapper: only a batch shim is wrapped', () => {
  assert.equal(needsCmdWrapper('C:\\p\\az.cmd', 'win32'), true);
  assert.equal(needsCmdWrapper('C:\\p\\thing.BAT', 'win32'), true, 'extension match is case-insensitive');
  // CONTROL: a real .exe must NOT be wrapped — routing one through cmd.exe
  // would re-introduce the quoting risk the wrapper exists to manage.
  assert.equal(needsCmdWrapper('C:\\p\\node.exe', 'win32'), false);
  assert.equal(needsCmdWrapper('/usr/bin/gh', 'linux'), false);
  // A .cmd name on a non-Windows platform is just a file, not a shim.
  assert.equal(needsCmdWrapper('/usr/bin/az.cmd', 'linux'), false);
});

// --------------------------------------------------- argument FIDELITY
// Both of these were measured end-to-end against a real .cmd shim on PATH that
// dumped its parsed argv. Neither is command injection -- every metacharacter
// payload tried (`& echo`, `| echo`, `^&`, `>`, quote-breakout) stayed literal,
// and a truncated remainder is DROPPED rather than executed. They are fidelity
// failures, which in a measurement harness is the worse of the two: the call
// succeeds, exits 0, and answers a different question than the one asked.

test('quoteForCmd: a NEWLINE is REFUSED — it truncates the whole command line', () => {
  // Measured: ["resources\n| where type =~ 'x'", "NEXT"] reached the child as
  // exactly ["resources"], rc=0, no error. A multi-line KQL query would have
  // silently run a shorter, different query and returned a confident answer.
  assert.throws(
    () => quoteForCmd("resources\n| where type =~ 'x'"),
    (e) => e instanceof CmdQuoteError && /TERMINATES a cmd\.exe command line/.test(e.message),
  );
  assert.throws(() => quoteForCmd('a\r\nb'), (e) => e instanceof CmdQuoteError);
  // A bare CR is quieter and just as wrong: measured, `a\rb` arrived as `ab`.
  assert.throws(() => quoteForCmd('a\rb'), (e) => e instanceof CmdQuoteError);
});

test('quoteForCmd CONTROL: ordinary whitespace is still quoted, not refused', () => {
  // Without this the newline guard could be widened to all whitespace and the
  // suite would not notice -- tabs and spaces must keep working.
  assert.equal(quoteForCmd('a b'), '"a b"');
  assert.equal(quoteForCmd('a\tb'), '"a\tb"');
});

test('quoteForCmd: a TRAILING BACKSLASH is doubled so it cannot escape the closing quote', () => {
  // CommandLineToArgvW reads `\"` as an escaped literal quote. Measured before
  // the fix: ["C:\my dir\", "--query", "SECRET"] arrived as the SINGLE token
  // `C:\my dir" --query SECRET` -- the closing quote was consumed and the
  // following arguments were spliced in. Node's own windowsQuoteArg doubles
  // them; this did not.
  assert.equal(quoteForCmd('C:\\my dir\\'), '"C:\\my dir\\\\"');
  assert.equal(quoteForCmd('C:\\my dir\\\\'), '"C:\\my dir\\\\\\\\"');
  // CONTROL: a backslash NOT at the end is untouched — doubling everywhere
  // would corrupt every ordinary Windows path.
  assert.equal(quoteForCmd('C:\\my dir\\file'), '"C:\\my dir\\file"');
});

test('buildCmdLine: a spliced trailing-backslash path cannot swallow later args', () => {
  const line = buildCmdLine('az.cmd', ['C:\\my dir\\', '--query', 'value']);
  // The argument boundary must survive: --query is its own token, not part of
  // the path argument.
  assert.ok(/"C:\\my dir\\\\" --query value$/.test(line), `boundary lost: ${line}`);
});
