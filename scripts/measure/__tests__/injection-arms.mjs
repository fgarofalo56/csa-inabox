#!/usr/bin/env node
/**
 * injection-arms.mjs — the mutation harness for measure-injection.test.mjs.
 *
 * WHY THIS FILE EXISTS
 *
 *   The suite's header carries an arm table: "break X, the suite goes RED".
 *   Twice now that table has been PROSE, and twice a reviewer defeated the suite
 *   with a mutation the table did not contain — the second time by moving the
 *   allowlist result off the call site while every one of the 16 tests stayed
 *   green. A table nobody can re-run is a claim, and a claim nobody re-runs
 *   decays into folklore, which is the exact failure this whole directory
 *   exists to catch. So the arms are executable now.
 *
 *   Run it. Every arm must print the verdict the table says it has.
 *
 *     node scripts/measure/__tests__/injection-arms.mjs
 *
 * NOT named `*.test.mjs`, for the same reason `mutate.mjs` is not: CI must not
 * discover it as a suite. `TEST_FILE_RE` in scripts/ci/check-node-test-suites.mjs
 * is /\.test\.(mjs|cjs|js)$/, so this name is invisible to discovery — VERIFIED
 * with `--list`, not assumed.
 *
 * THREE THINGS THAT MAKE A MUTATION HARNESS LIE, ALL HANDLED HERE
 *
 *   1. A needle that matches ZERO times reads exactly like a survival. Every
 *      arm asserts its needle matches EXACTLY ONCE and aborts otherwise.
 *   2. These files are CRLF (core.autocrlf). A needle written with bare `\n`
 *      matches zero times — see (1). Multi-line needles are built from the
 *      SUBJECT'S OWN detected EOL, never from a literal.
 *   3. A baseline that is already red makes every arm "CAUGHT" for free. The
 *      baseline is run first, in both columns, and a non-green baseline aborts
 *      the run rather than reporting arms against it.
 *
 * It never writes to the tree: each arm gets its own mkdtemp copy of
 * scripts/measure. `mutate.mjs` restores-and-sha256-compares instead; copying is
 * strictly safer, and it is what lets the SUITE itself be an arm subject.
 *
 * THE TWO COLUMNS
 *
 *   win32        — this host, as-is.
 *   linux-forced — process.platform redefined to 'linux' via --import, to
 *                  approximate what an ubuntu lane sees. It is an
 *                  APPROXIMATION: the OS underneath does not change, so the one
 *                  test that spawns a real child stands down (os.type() does not
 *                  follow the forgery). Arms whose only catcher is that test
 *                  therefore read SURVIVED in this column BY CONSTRUCTION. That
 *                  is recorded per-arm as `expect`, so an expected survival can
 *                  never be mistaken for a hole — and, equally, so a NEW
 *                  survival cannot hide among them.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUBJECT_DIR = path.join(HERE, '..');
const SUITE_REL = path.join('__tests__', 'measure-injection.test.mjs');

// A FOURTH way a mutation harness lies, and the reason this refuses to run
// anywhere but win32: the `expect` table below is keyed `win32` / `linux`, where
// `win32` means "the un-forced column on THIS host". On an ubuntu runner the
// un-forced column IS linux, so every verdict labelled win32 would be compared
// against the wrong column and the run would report arms that were never
// measured. Deriving a correct ubuntu expectation set needs a real ubuntu host,
// which this lane has never had (see the suite header). Until one runs it, the
// honest behaviour is to refuse rather than to guess — that is also why this
// file is still not wired into `guardrails`, where every lane is Linux.
if (process.platform !== 'win32') {
  console.error(
    `injection-arms.mjs: REFUSING to run on ${process.platform}. The expected verdicts are keyed to a win32 ` +
    'host — the un-forced column here would be linux, and every `win32` row would be compared against it. ' +
    'A wrong verdict reported confidently is worse than no verdict. Derive an ubuntu expectation set on a ' +
    'real ubuntu host first, then key the table by host.',
  );
  process.exit(2);
}

/** Detect the subject's own line ending. See lie (2) above. */
function eolOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const bareLf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > bareLf ? '\r\n' : '\n';
}

/**
 * Each arm: which file it edits, the needle, the replacement, and the verdict
 * the suite header claims. `expect` is per column and is asserted, so this file
 * fails if reality stops matching the documentation — in EITHER direction.
 */
const ARMS = [
  {
    id: 'I',
    what: 'the allowlist result moved OFF the call site — helper still correct, spawnPlan stops consuming it',
    file: 'measure.mjs',
    find: '  const file = canonicalBinary(bin);',
    repl: ['  canonicalBinary(bin);', '  const file = bin;'],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'the mutation that defeated the previous revision at rc=0, 16 pass/0 fail',
  },
  {
    id: 'N',
    what: 'the direct (no-wrapper) branch spawns `bin` instead of `file`',
    file: 'measure.mjs',
    find: 'if (!needsWrapper(file)) return { cmd: file, argv: args, verbatim: false };',
    repl: ['if (!needsWrapper(file)) return { cmd: bin, argv: args, verbatim: false };'],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'not reachable behaviourally on win32 for a .cmd shim — the SHAPE assertion is what catches it there',
  },
  {
    id: 'W',
    what: 'the cmd.exe branch interpolates `bin` into the command line instead of `file`',
    file: 'measure.mjs',
    find: 'buildCmdLine(file, args)',
    repl: ['buildCmdLine(bin, args)'],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
  },
  {
    id: 'C',
    what: 'canonicalBinary returns a value DERIVED from its argument, not the table literal',
    file: 'measure.mjs',
    find: '  return ALLOWED_BINARIES[key];',
    repl: ['  return key;'],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'observably identical for every allowed input — only a SHAPE assertion can see it',
  },

  // ── arms invented AGAINST the finished guard, so it is not an enumeration of
  //    the mutations that already defeated it.
  {
    id: 'X',
    what: 'const file = canonicalBinary(bin) && bin;  — keeps the literal prefix a substring check looks for',
    file: 'measure.mjs',
    find: '  const file = canonicalBinary(bin);',
    repl: ['  const file = canonicalBinary(bin) && bin;'],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
  },
  {
    id: 'Y',
    what: 'const file = (canonicalBinary(bin), bin);  — comma operator; the allowlist runs, its value is discarded',
    file: 'measure.mjs',
    find: '  const file = canonicalBinary(bin);',
    repl: ['  const file = (canonicalBinary(bin), bin);'],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
  },
  {
    id: 'Z',
    what: 'a launder() helper OUTSIDE spawnPlan — the `bin` READ COUNT stays at exactly 2',
    file: 'measure.mjs',
    find: 'function spawnPlan(bin, args) {',
    repl: ['function launder(x) { canonicalBinary(x); return x; }', 'function spawnPlan(bin, args) {'],
    also: { find: '  const file = canonicalBinary(bin);', repl: ['  const file = launder(bin);'] },
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'the population assertion ALONE would pass this — the named-binding assertion is what catches it',
  },

  // ── the guards themselves. A guard that cannot fail is not a guard.
  {
    id: 'P',
    what: 'rename spawnPlan\'s `bin` parameter — behaviour-preserving, and the read count drops to ZERO',
    file: 'measure.mjs',
    rewriteSpawnPlan: true,
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'proves the count assertion FAILS CLOSED ("Found 0") rather than reading absence as a pass',
  },
  {
    id: 'G2',
    what: 'silence the win32 shim, so PRODUCTION PATH can observe nothing at all',
    file: SUITE_REL,
    find: String.raw`'@echo off\r\necho INVOKED_AS=%0\r\n'`,
    repl: [String.raw`'@echo off\r\n'`],
    expect: { win32: 'CAUGHT', linux: 'SURVIVED' },
    note: 'CAUGHT via "the shim did not report at all — this test measured NOTHING". SURVIVES the forced column because the test it breaks stands down there — by construction, not a hole.',
  },
  {
    id: 'G',
    what: 'silence the POSIX shim',
    file: SUITE_REL,
    find: String.raw`'#!/bin/sh\necho "INVOKED_AS=$0"\n'`,
    repl: [String.raw`'#!/bin/sh\n'`],
    expect: { win32: 'SURVIVED', linux: 'SURVIVED' },
    note: 'UNMEASURABLE on Windows: the POSIX shim is never written here and the forced column skips the test. This control needs a real Linux runner — it is declared, not silently omitted.',
  },

  // ── ROUND 3. An independent review defeated the round-2 guard by going one
  //    level out AGAIN: it was keyed to the identifier `bin`, and on the cmd.exe
  //    branch — the only branch with a shell — the executable is buildCmdLine's
  //    FIRST ARGUMENT, which nothing constrained. Arms R11/R12/R1 are that
  //    review's; RA/RR/RS were invented alongside them.
  {
    id: 'R12',
    what: 'an ENV VAR chooses the program cmd.exe runs — buildCmdLine(process.env.LOOM_BIN || file, args)',
    file: 'measure.mjs',
    find: 'buildCmdLine(file, args)',
    repl: ['buildCmdLine(process.env.LOOM_BIN || file, args)'],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'SURVIVED the round-2 guard at rc=0 in BOTH columns: `cmd:` stays \'cmd.exe\' and the `bin` read count stays at 2.',
  },
  {
    id: 'R11',
    what: 'needsWrapper returns the PATH-resolved path and spawnPlan interpolates it',
    file: 'measure.mjs',
    edits: [
      { find: '      if (existsSync(found)) return needsCmdWrapper(found);', repl: ['      if (existsSync(found)) return needsCmdWrapper(found) && found;'] },
      { find: 'buildCmdLine(file, args)', repl: ['buildCmdLine(needsWrapper(file), args)'] },
    ],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'violates measure.mjs\'s own written invariant that `found` "must never be returned, spawned, or interpolated". SURVIVED round 2. Introduces NO new name, so only the buildCmdLine arg-0 pin catches it — the vocabulary contract does not.',
  },
  {
    id: 'R1',
    what: 'run() rewrites plan.cmd AFTER spawnPlan returned, on the non-cmd.exe branch only',
    file: 'measure.mjs',
    find: '  let last = null;',
    repl: ["  if (plan.cmd !== 'cmd.exe' && typeof bin === 'string') plan.cmd = bin;", '  let last = null;'],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'the window between `plan = spawnPlan(...)` and the spawnSync, which every round-2 guard was scoped to miss. Targets the branch PRODUCTION PATH does not reach on this host, and that test stands down entirely in the forced column.',
  },
  {
    id: 'RA',
    what: 'ALIAS: a `const alias = process.env.LOOM_BIN || file` binding is interpolated in file\'s place',
    file: 'measure.mjs',
    edits: [
      { find: '  const file = canonicalBinary(bin);', repl: ['  const file = canonicalBinary(bin);', '  const alias = process.env.LOOM_BIN || file;'] },
      { find: 'buildCmdLine(file, args)', repl: ['buildCmdLine(alias, args)'] },
    ],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'SURVIVED round 2 — the `file` BINDING count stays at 1 because the new name is not `file`.',
  },
  {
    id: 'RR',
    what: 'REASSIGN: `let file`, then `file = needsWrapper(file)` — no new name, binding count unchanged',
    file: 'measure.mjs',
    edits: [
      { find: '      if (existsSync(found)) return needsCmdWrapper(found);', repl: ['      if (existsSync(found)) return needsCmdWrapper(found) && found;'] },
      { find: '  const file = canonicalBinary(bin);', repl: ['  let file = canonicalBinary(bin);'] },
      { find: "  return {\r\n    cmd: 'cmd.exe',", repl: ['  file = needsWrapper(file);', '  return {', "    cmd: 'cmd.exe',"] },
    ],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'already held in round 2, by the `const` in the named-binding assertion — a const cannot be reassigned, so pinning the keyword is what closes the whole reassignment class.',
  },
  {
    id: 'RS',
    what: 'the cmd.exe branch spawns a different LITERAL interpreter',
    file: 'measure.mjs',
    find: "    cmd: 'cmd.exe',",
    repl: ["    cmd: 'powershell.exe',"],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'already held in round 2 by the `cmd:` value population — recorded because it is the arm people assume is the dangerous one, and it is not.',
  },

  // ── ROUND 3, PART TWO. Arms invented against the round-3 guard itself. E1 and
  //    E3 leave spawnPlan's body BYTE-IDENTICAL and both SURVIVED it — the same
  //    "scoped one level too narrow" shape, reproduced by the fix for it. They
  //    are what the module-scope taint-source contract was written for.
  {
    id: 'E1',
    what: 'SHADOW: a top-level buildCmdLine wrapper — spawnPlan untouched, arg-0 still `file`',
    file: 'measure.mjs',
    find: "import { buildCmdLine, needsCmdWrapper, CmdQuoteError } from './cmd-quote.mjs';",
    repl: [
      "import { buildCmdLine as _realBuildCmdLine, needsCmdWrapper, CmdQuoteError } from './cmd-quote.mjs';",
      'function buildCmdLine(f, a) { return _realBuildCmdLine(process.env.LOOM_BIN || f, a); }',
    ],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'defeats every function-scoped assertion by construction. Caught ONLY by the taint-source population.',
  },
  {
    id: 'E3',
    what: 'TABLE: an ALLOWED_BINARIES value stops being a literal',
    file: 'measure.mjs',
    find: "  gh: 'gh', az: 'az', git: 'git', node: 'node', npm: 'npm', pnpm: 'pnpm', pwsh: 'pwsh',",
    repl: ["  gh: process.env.LOOM_GH || 'gh', az: 'az', git: 'git', node: 'node', npm: 'npm', pnpm: 'pnpm', pwsh: 'pwsh',"],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'canonicalBinary still returns `ALLOWED_BINARIES[key]`, exactly as its own SHAPE test demands — the TABLE became the taint source. Caught ONLY by the taint-source population.',
  },
  {
    id: 'E6',
    what: 'SECOND SINK: an extra spawnSync in run() executes the caller string directly',
    file: 'measure.mjs',
    find: '  let last = null;',
    repl: ["  spawnSync(bin, args, { encoding: 'utf8', shell: false });", '  let last = null;'],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'was ALREADY caught by the behavioural marker tests before the one-sink assertion existed — recorded so that is on the record rather than credited to the new guard.',
  },
  {
    id: 'E7',
    what: 'ONE RING OUT: buildCmdLine in cmd-quote.mjs itself honours an env override',
    file: 'cmd-quote.mjs',
    find: 'export function buildCmdLine(file, args) {',
    repl: ['export function buildCmdLine(file, args) {', '  file = process.env.LOOM_BIN || file;'],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'the reason the taint-source contract covers BOTH files. It survived every measure.mjs-only formulation.',
  },

  // ── the ROUND-3 guards, mutated.
  {
    id: 'GS',
    what: 'GUARD: break the suite\'s comment stripper so PROSE is counted as code',
    file: SUITE_REL,
    find: "    'measure.mjs': { src: stripComments(fs.readFileSync(MEASURE_MJS, 'utf8')),",
    repl: ["    'measure.mjs': { src: fs.readFileSync(MEASURE_MJS, 'utf8'),"],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'measure.mjs carries 13 `process.X` mentions in prose against 5 real reads. Caught by the stripper POSITIVE CONTROL, not by the count drifting — a count that drifted would just get "corrected" upward.',
  },
  {
    id: 'GB',
    what: 'GUARD: revert functionBody to the version that returns run()\'s destructured DEFAULTS',
    file: SUITE_REL,
    find: "  return braceBlock(src, src.indexOf('{', i));",
    repl: ["  return braceBlock(src, src.indexOf('{', m.index));"],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'the pre-round-3 helper returned 71 characters for `run` — the parameter defaults. A wrong extraction that reads exactly like a successful one.',
  },
  {
    id: 'GV',
    what: 'GUARD: rename spawnPlan\'s `file` binding to `f` — behaviour-preserving',
    file: 'measure.mjs',
    edits: [
      { find: '  const file = canonicalBinary(bin);', repl: ['  const f = canonicalBinary(bin);'] },
      { find: '  if (!needsWrapper(file)) return { cmd: file, argv: args, verbatim: false };', repl: ['  if (!needsWrapper(f)) return { cmd: f, argv: args, verbatim: false };'] },
      { find: 'buildCmdLine(file, args)', repl: ['buildCmdLine(f, args)'] },
    ],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'MEASURED reason: the vocabulary diff names `f` as added and `file` as removed. The set assertion fails CLOSED on a rename, in both directions.',
  },
  {
    id: 'GE',
    what: 'GUARD: delete the process.env.PATH read entirely — is ABSENCE read as a pass?',
    file: 'measure.mjs',
    find: "  for (const dir of (process.env.PATH || '').split(path.delimiter)) {",
    repl: ["  for (const dir of ''.split(path.delimiter)) {"],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'MEASURED reason: `expected {…"process.env":1…} found {…}` — the population assertion fails CLOSED when a member DISAPPEARS, not only when one is added.',
  },

  // ── ROUND 4. An independent review of the round-3 guard defeated it SIX ways,
  //    five of them proven as live execution of an attacker-named binary. Two
  //    classes: the token `process` is a SPELLING and can be reached without
  //    writing it, and a value derived from `args` needs no taint token at all.
  //    One of the six was a bug in the round-3 comment stripper itself.
  {
    id: 'SS-TABLE',
    what: 'STRIPPER BUG: a `/**/` prefix made the round-3 stripper drop the CODE along with the comment',
    file: 'measure.mjs',
    find: "  gh: 'gh', az: 'az', git: 'git', node: 'node', npm: 'npm', pnpm: 'pnpm', pwsh: 'pwsh',",
    repl: ["  /**/  gh: process.env.LOOM_GH || 'gh', az: 'az', git: 'git', node: 'node', npm: 'npm', pnpm: 'pnpm', pwsh: 'pwsh',"],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'a LITERAL `process.env` in the table, hidden by a stripper that ate its line. The counts matched perfectly while counting the wrong text — which is why the stripper now has a FIXTURE test rather than being controlled by the counts it feeds.',
  },
  {
    id: 'NP-TABLE',
    what: "OBFUSCATED: globalThis['pro'+'cess'].env in the table — no `process` token anywhere",
    file: 'measure.mjs',
    find: "  gh: 'gh', az: 'az', git: 'git', node: 'node', npm: 'npm', pnpm: 'pnpm', pwsh: 'pwsh',",
    repl: ["  gh: globalThis['pro' + 'cess'].env.LOOM_GH || 'gh', az: 'az', git: 'git', node: 'node', npm: 'npm', pnpm: 'pnpm', pwsh: 'pwsh',"],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'the taint-source population is keyed to a SPELLING. Caught now by the ambient-global contract, which is pinned at ZERO and so cannot be satisfied by an alias or a computed key.',
  },
  {
    id: 'NP-SHADOW',
    what: "OBFUSCATED SHADOW: module-scope buildCmdLine wrapper reading globalThis['pro'+'cess'].env",
    file: 'measure.mjs',
    find: "import { buildCmdLine, needsCmdWrapper, CmdQuoteError } from './cmd-quote.mjs';",
    repl: [
      "import { buildCmdLine as _bcl, needsCmdWrapper, CmdQuoteError } from './cmd-quote.mjs';",
      "function buildCmdLine(f, a) { return _bcl(globalThis['pro' + 'cess'].env.LOOM_BIN || f, a); }",
    ],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'E1 with the token hidden. Caught by BOTH the ambient contract and the origin contract.',
  },
  {
    id: 'NP-CQ',
    what: 'OBFUSCATED, ONE RING OUT: the same globalThis env override inside cmd-quote.mjs',
    file: 'cmd-quote.mjs',
    find: 'export function buildCmdLine(file, args) {',
    repl: ['export function buildCmdLine(file, args) {', "  file = globalThis['pro' + 'cess'].env.LOOM_BIN || file;"],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'E7 with the token hidden — the reason the ambient contract covers BOTH files.',
  },
  {
    id: 'ARGV-EXEC',
    what: "NO TAINT TOKEN AT ALL: a module-scope buildCmdLine shadow derives arg-0 from the CALLER's args",
    file: 'measure.mjs',
    find: "import { buildCmdLine, needsCmdWrapper, CmdQuoteError } from './cmd-quote.mjs';",
    repl: [
      "import { buildCmdLine as _bcl, needsCmdWrapper, CmdQuoteError } from './cmd-quote.mjs';",
      "function buildCmdLine(f, a) { return _bcl(a.length > 0 && String(a[0]).startsWith('!X:') ? String(a[0]).slice(3) : f, a); }",
    ],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'the sharpest arm in the whole table: plain, unobfuscated, no environment, no `process`. `args` IS the alert-983 source (drain-status.mjs:18, red-tally.mjs:17 feed process.argv into run). Only the ORIGIN contract catches it — buildCmdLine must be the import.',
  },
  {
    id: 'CQ-ARGV',
    what: "NO TAINT TOKEN, ONE RING OUT: cmd-quote.mjs's own buildCmdLine derives arg-0 from its args",
    file: 'cmd-quote.mjs',
    find: 'export function buildCmdLine(file, args) {',
    repl: [
      'export function buildCmdLine(file, args) {',
      "  if (args.length > 0 && String(args[0]).startsWith('!X:')) file = String(args[0]).slice(3);",
    ],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'source text cannot follow a value into another file, so this one is closed BEHAVIOURALLY: the built line must begin with the file it was given, for all seven allowlisted names and every payload. That claim holds whatever the mechanism.',
  },

  // ── the ROUND-4 guards, mutated.
  {
    id: 'GX',
    what: 'GUARD: revert stripComments to the LINE-DROPPING version that ate code',
    file: SUITE_REL,
    find: "      if (open === -1) { kept += rest; rest = ''; break; }",
    repl: ["      if (open === -1) { kept += rest; rest = ''; break; }", "      if (true) { rest = ''; break; }"],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'caught by the stripper FIXTURE, which is the point of having one — the counts it feeds would have matched.',
  },
  {
    id: 'GO',
    what: 'GUARD: break the import-binding parser in the origin test',
    file: SUITE_REL,
    find: "  for (const m of src.matchAll(/^import\\s*\\{([^}]*)\\}\\s*from\\s*'([^']+)';/gm)) {",
    repl: ["  for (const m of src.matchAll(/^NEVERMATCHES\\s*\\{([^}]*)\\}\\s*from\\s*'([^']+)';/gm)) {"],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'a parser that matches nothing would report every callee as having ZERO origins. The population control fires instead.',
  },
  {
    id: 'GA',
    what: 'GUARD: empty the forbidden-token list so the ambient test iterates zero times',
    file: SUITE_REL,
    find: "  const forbidden = ['globalThis', 'global', 'eval', 'Function', 'require', 'module', 'exports'];",
    repl: ['  const forbidden = [];'],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'an empty list makes BOTH the assertion loop and its own positive-control loop vacuous. Found while mutating the round-4 guards, and closed before this arm was recorded.',
  },
  {
    id: 'GP',
    what: 'GUARD: empty the binary list so the command-line prefix test iterates zero times',
    file: SUITE_REL,
    find: "  const names = ['gh', 'az', 'git', 'node', 'npm', 'pnpm', 'pwsh'];",
    repl: ['  const names = [];'],
    expect: { win32: 'CAUGHT', linux: 'CAUGHT' },
    note: 'same vacuity, same round, same fix — the floor is now an absolute number, not one derived from the list being counted.',
  },
];

function tally(out) {
  const g = (k) => {
    const m = new RegExp(`^\\u2139 ${k} (\\d+)$`, 'm').exec(out);
    return m === null ? null : Number(m[1]);
  };
  return { tests: g('tests'), pass: g('pass'), fail: g('fail'), skipped: g('skipped') };
}

function runSuite(dir, forced) {
  const args = ['--test'];
  if (forced) args.push('--import', pathToFileURL(path.join(dir, '.force-linux.mjs')).href);
  args.push(path.join(dir, SUITE_REL));
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 900000, shell: false });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const t = tally(out);
  if (t.tests === null) {
    throw new Error(`the suite produced no tally — it did not run. rc=${r.status}\n${out.slice(0, 800)}`);
  }
  return { rc: r.status, ...t, by: [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]) };
}

function isolate(id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `inj-arm-${id}-`));
  fs.cpSync(SUBJECT_DIR, dir, { recursive: true });
  // The forgery preload lives INSIDE the copy, so the harness has nothing to
  // clean up and two concurrent runs cannot share state.
  fs.writeFileSync(
    path.join(dir, '.force-linux.mjs'),
    "Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });\n",
  );
  return dir;
}

/** Apply one find/replace, asserting the needle matches EXACTLY once. See lie (1). */
function edit(file, find, replLines) {
  const before = fs.readFileSync(file, 'utf8');
  const n = before.split(find).length - 1;
  if (n !== 1) {
    throw new Error(
      `needle matched ${n} times (expected exactly 1) in ${path.basename(file)}. ` +
      'A needle that matches zero times reads exactly like a survival, so this aborts ' +
      `rather than report one. Needle: ${JSON.stringify(find)}`,
    );
  }
  fs.writeFileSync(file, before.split(find).join(replLines.join(eolOf(before))));
}

/**
 * Arm P rewrites every `bin` in spawnPlan's body. Done structurally rather than
 * as a needle, because the point of the arm is that the rename is COMPLETE — a
 * partial rename would change behaviour and catch for the wrong reason.
 */
function rewriteSpawnPlan(file) {
  const src = fs.readFileSync(file, 'utf8');
  const eol = eolOf(src);
  const start = src.indexOf('function spawnPlan(bin, args) {');
  if (start < 0) throw new Error('spawnPlan(bin, args) not found — the harness is stale, not the subject');
  const end = src.indexOf(`${eol}}${eol}`, start);
  if (end < 0) throw new Error('could not find the end of spawnPlan');
  const body = src.slice(start, end);
  fs.writeFileSync(file, src.slice(0, start) + body.replace(/\bbin\b/g, 'b') + src.slice(end));
}

function fmt(r) {
  return `rc=${r.rc} ${r.pass}p/${r.fail}f/${r.skipped}s`;
}

// ─────────────────────────────────────────────────────────── baseline, first
const baseDir = isolate('base');
const base = { win32: runSuite(baseDir, false), linux: runSuite(baseDir, true) };
console.log('BASELINE (isolated copy, unmutated)');
console.log(`  win32        ${fmt(base.win32)}  tests=${base.win32.tests}`);
console.log(`  linux-forced ${fmt(base.linux)}  tests=${base.linux.tests}`);
if (base.win32.rc !== 0 || base.linux.rc !== 0) {
  console.error('\nBASELINE IS NOT GREEN. Every arm below would report CAUGHT for free, so nothing is measured. Stopping.');
  process.exit(2);
}

/**
 * An arm's edits, normalised. `edits: [...]` for arms that need three; the older
 * `find`/`repl` (+ optional `also`) shape still works and means the same thing.
 * Population-checked by the caller: an arm that produces ZERO edits would apply
 * no mutation and report a survival that measured nothing.
 */
function editsOf(arm) {
  if (arm.edits) return arm.edits;
  return [{ find: arm.find, repl: arm.repl }, ...(arm.also ? [arm.also] : [])];
}

// ──────────────────────────────────────────────────────────────────── the arms
let failures = 0;
for (const arm of ARMS) {
  const dir = isolate(arm.id);
  const target = path.join(dir, arm.file);
  if (arm.rewriteSpawnPlan) {
    rewriteSpawnPlan(target);
  } else {
    const edits = editsOf(arm);
    if (edits.length === 0) throw new Error(`arm ${arm.id} has no edits — it would report a survival off an unmutated copy`);
    for (const e of edits) edit(target, e.find, e.repl);
  }

  const got = { win32: runSuite(dir, false), linux: runSuite(dir, true) };
  console.log(`\n[${arm.id}] ${arm.what}`);
  if (arm.note) console.log(`     note: ${arm.note}`);
  for (const col of ['win32', 'linux']) {
    const verdict = got[col].rc === 0 ? 'SURVIVED' : 'CAUGHT';
    const ok = verdict === arm.expect[col];
    if (!ok) failures++;
    const label = col === 'win32' ? 'win32       ' : 'linux-forced';
    console.log(`  ${ok ? ' ' : '!'} ${label} ${fmt(got[col])}  -> ${verdict}` +
      (ok ? '' : `  *** EXPECTED ${arm.expect[col]} ***`));
    if (got[col].by.length) console.log(`       caught by: ${[...new Set(got[col].by)].join(' | ')}`);
  }
}

console.log('');
if (failures > 0) {
  console.error(`${failures} arm/column pair(s) did not match the documented verdict. The suite's header ` +
    'and its behaviour have diverged — fix one of them before trusting either.');
  process.exit(1);
}
console.log(`ALL ${ARMS.length} ARMS MATCH THEIR DOCUMENTED VERDICT`);
