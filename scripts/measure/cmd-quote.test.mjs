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
