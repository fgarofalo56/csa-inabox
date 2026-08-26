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

// ──────────────────────────────────────────────────────────────────── the arms
let failures = 0;
for (const arm of ARMS) {
  const dir = isolate(arm.id);
  const target = path.join(dir, arm.file);
  if (arm.rewriteSpawnPlan) rewriteSpawnPlan(target);
  else edit(target, arm.find, arm.repl);
  if (arm.also) edit(target, arm.also.find, arm.also.repl);

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
