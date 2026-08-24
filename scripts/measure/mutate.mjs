#!/usr/bin/env node
/**
 * mutate.mjs — proves measure.mjs's guards can FAIL.
 *
 * A self-test that passes proves nothing on its own; it must go RED when the
 * thing it watches is broken. Each arm below breaks one guard, runs the suite,
 * and asserts it fails. Every needle is asserted to match EXACTLY ONCE, and the
 * file is restored and byte-compared (sha256) after every arm.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SUBJECT = 'scripts/measure/measure.mjs';
const SUITE = 'scripts/measure/measure.test.mjs';

const original = readFileSync(SUBJECT, 'utf8');
const originalHash = createHash('sha256').update(original).digest('hex');

// Line endings differ between the blob (LF) and the working tree (CRLF via
// core.autocrlf). A needle with the wrong ending matches ZERO times and reads
// exactly like a passing arm -- measure it, never assume.
const crlf = (original.match(/\r\n/g) || []).length;
const bareLf = (original.match(/(?<!\r)\n/g) || []).length;
console.log(`subject EOL: ${crlf} CRLF, ${bareLf} bare LF -> ${crlf > bareLf ? 'CRLF' : 'LF'}`);
const EOL = crlf > bareLf ? '\r\n' : '\n';

function runSuite() {
  const r = spawnSync(process.execPath, ['--test', SUITE], { encoding: 'utf8', shell: false });
  const out = (r.stdout || '') + (r.stderr || '');
  const pass = Number((out.match(/^ℹ pass (\d+)/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^ℹ fail (\d+)/m) || [])[1] ?? -1);
  return { rc: r.status, pass, fail };
}

const ARMS = [
  {
    name: 'R5 control check removed (the core guard)',
    find: `if (controlValue === UNKNOWN || !(Number(controlValue) > 0)) {`,
    repl: `if (false) {`,
  },
  {
    name: 'R5 UNKNOWN-subject check removed',
    find: `if (value === UNKNOWN) {`,
    repl: `if (false) {`,
  },
  {
    // R1's throw now lives after the retry loop, so the arm targets the EARLY
    // RETURN instead: making it unconditional means a non-zero exit yields a
    // value and never reaches the throw.
    name: 'R1 non-zero exit no longer throws (early-return made unconditional)',
    find: `    if (res.status === 0 || allowNonZero) {`,
    repl: `    if (true) {`,
  },
  {
    // NOTE: this needle quotes measure.mjs's own source text. When that line
    // changes, the needle matches ZERO times and the arm reports "INVALID" --
    // which reads nothing like a failure. It last moved when `${bin}` became
    // `${label}` (a Symbol sentinel cannot be interpolated). Re-run this file
    // after ANY edit to runJson.
    name: 'R4 empty stdout returns {} instead of throwing',
    find: `throw new MeasurementError(\`\${label} succeeded but produced NO output`,
    repl: `return {}; throw new MeasurementError(\`\${label} succeeded but produced NO output`,
  },
  {
    // Reintroduces the LIVE 2026-08-24 bypass in one line: reduce the lookup key
    // to a basename and `/tmp/evil/gh.cmd` is allowlisted as `gh` again. This is
    // the mutation the original guard could not survive, so an arm for it is the
    // only thing separating "the hole is closed" from "a comment says it is".
    //
    // Caught on both platforms, by different routes: on win32 the PATH scan
    // finds the real gh and the call SUCCEEDS where the suite demands a throw;
    // on linux the spawn ENOENTs with "failed to launch", which is not the
    // "paths are not accepted" the suite demands. Either way, red.
    name: 'BYPASS: allowlist keyed to the BASENAME instead of the whole string',
    find: `  const key = bin.toLowerCase();`,
    repl: `  const key = bin.toLowerCase().split(/[\\\\/]/).pop().replace(/\\.(cmd|exe|bat)$/, '');`,
  },
  {
    // `${symbol}` throws TypeError, so without binLabel every error path on the
    // SELF_NODE branch would crash inside the reporter and the real failure would
    // be lost. Mutating binLabel to the identity proves the suite notices.
    //
    // NOTE the needle is binLabel's BODY, not `const label = binLabel(bin);` --
    // that call appears twice (run and runJson) and a 2-hit needle is an INVALID
    // arm, which prints nothing like a failure.
    name: 'SELF_NODE label helper made the identity (TypeError inside the reporter)',
    find: `  return bin === SELF_NODE ? \`node (\${process.execPath})\` : String(bin);`,
    repl: `  return bin;`,
  },

  // ---------------------------------------------------------------------------
  // Arms below were added after an independent review measured that the six
  // above ALL target run/runJson/measureWithControl/canonicalBinary -- so they
  // proved those six things and nothing else. Fifteen independently-written arms
  // were run against the suite as it then stood and ELEVEN survived: every
  // fake-zero refusal in the two functions that actually talk to Azure and
  // GitHub could be deleted with the suite still green. The cause was that the
  // suite asserted against local re-implementations of those parsers rather than
  // importing them, and the copies had already drifted from production in both
  // directions. The parsers are now exported and these arms hold them shut.
  // ---------------------------------------------------------------------------
  {
    // THE headline invariant of this whole module. The fix's entire claim is that
    // the spawned string originates in the source file rather than the caller;
    // returning `bin` puts the caller back in control of it. Not exploitable in
    // isolation (the value must already lowercase to an allowlist key), but this
    // is the one line the security rewrite exists to protect and nothing pinned it.
    name: 'TAINT: canonicalBinary returns the CALLER string instead of the table literal',
    find: `return ALLOWED_BINARIES[key];`,
    repl: `return bin;`,
  },
  {
    // The saturated-page incident in one line: 100 of 137 read as the whole set,
    // and a vitest check on page 2 became "no vitest check on this SHA".
    name: 'checkRuns TRUNCATION refusal removed (a partial page reported as the total)',
    find: `if (total !== null && all.length < total) {`,
    repl: `if (false) {`,
  },
  {
    // The twenty-PR incident: a 403 yields an empty array, and 0/0/0 reads as
    // "all green" on every PR at once.
    name: 'checkRuns ZERO-runs refusal removed (a 403 becomes 0/0/0)',
    find: `if (all.length === 0) {`,
    repl: `if (false) {`,
  },
  {
    // cancelled == UNKNOWN. Folding it into red makes a re-runnable check look
    // like a hard failure; the inverse (drain-status ignoring it) made an
    // all-cancelled PR read READY. It has to stay its own column.
    name: 'checkRuns folds CANCELLED into red (an UNKNOWN reported as a failure)',
    find: `red: all.filter((r) => ['failure', 'timed_out'].includes(r.conclusion)).length,`,
    repl: `red: all.filter((r) => ['failure', 'timed_out', 'cancelled'].includes(r.conclusion)).length,`,
  },
  {
    name: 'metricTotal: no series returns 0 instead of UNKNOWN (the fake zero)',
    find: `if (!Array.isArray(series) || series.length === 0) return UNKNOWN;`,
    repl: `if (!Array.isArray(series) || series.length === 0) return 0;`,
  },
  {
    name: 'metricTotal: no datapoints returns 0 instead of UNKNOWN (the fake zero)',
    find: `if (!Array.isArray(pts) || pts.length === 0) return UNKNOWN;`,
    repl: `if (!Array.isArray(pts) || pts.length === 0) return 0;`,
  },
  {
    // A hollow green is how a required check passes having executed nothing.
    // Hard-wiring the verdict to false makes the detector unable to ever say so.
    name: 'hollowness hard-wired to false (a green that ran nothing reads as sound)',
    find: `hollow: substantive.length > 0 && ran.length === 0,`,
    repl: `hollow: false,`,
  },
];

// Baseline MUST be green, or no arm below means anything.
const base = runSuite();
console.log(`\nBASELINE  rc=${base.rc} pass=${base.pass} fail=${base.fail}`);
if (base.rc !== 0) {
  console.error('BASELINE IS RED - aborting; no mutation result would be interpretable.');
  process.exit(1);
}

let allCaught = true;
for (const arm of ARMS) {
  const needle = arm.find.split('\n').join(EOL);
  const hits = original.split(needle).length - 1;
  if (hits !== 1) {
    console.log(`\n${arm.name}\n  NEEDLE MATCHED ${hits} TIMES - arm INVALID (expected exactly 1)`);
    allCaught = false;
    continue;
  }
  writeFileSync(SUBJECT, original.replace(needle, arm.repl.split('\n').join(EOL)), 'utf8');
  const m = runSuite();
  writeFileSync(SUBJECT, original, 'utf8');
  const restored = createHash('sha256').update(readFileSync(SUBJECT, 'utf8')).digest('hex');

  const caught = m.rc !== 0;
  if (!caught) allCaught = false;
  console.log(`\n${arm.name}`);
  console.log(`  mutated  rc=${m.rc} pass=${m.pass} fail=${m.fail}  -> ${caught ? 'CAUGHT' : '*** SURVIVED ***'}`);
  console.log(`  restored byte-identical: ${restored === originalHash}`);
}

const final = runSuite();
console.log(`\nRESTORED  rc=${final.rc} pass=${final.pass} fail=${final.fail}`);
console.log(allCaught && final.rc === 0 ? '\nALL ARMS CAUGHT' : '\nSOME ARM SURVIVED - the guard is not watching');
process.exit(allCaught && final.rc === 0 ? 0 : 1);
