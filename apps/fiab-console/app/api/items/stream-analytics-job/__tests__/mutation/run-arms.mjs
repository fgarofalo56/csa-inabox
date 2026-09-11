#!/usr/bin/env node
/**
 * #3573 / #4354 — THE MUTATION RUNNER for the ASA R7 hint guard.
 *
 *     node app/api/items/stream-analytics-job/__tests__/mutation/run-arms.mjs
 *     node app/api/items/stream-analytics-job/__tests__/mutation/run-arms.mjs <arm-id>
 *
 * Run from `apps/fiab-console`. For each arm in `./mutations.mjs` it applies the
 * source edits and/or creates the files, runs the three ASA suites, records the
 * RAW exit code, and RESTORES the tree — from in-memory copies, in a `finally`,
 * so an interrupt cannot leave a mutant behind.
 *
 * Modelled on `lib/brain/run/__tests__/mutation/run-arms.mjs`, which is this
 * repo's established shape. Two things are different, because the arms here need
 * them: an arm may edit SEVERAL files at once (the round-4 MUT-A is three edits
 * across two files), and an arm may CREATE files (MUT-B/-C/-F are new routes).
 *
 * ── THE FOUR OUTCOMES ──────────────────────────────────────────────────────
 *   CAUGHT           the suite went red. The property is defended.
 *   SURVIVED         the suite stayed green. Either a declared blind spot
 *                    (`expect: 'survives'`) or A FINDING — printed as one,
 *                    never folded into a pass rate.
 *   NEEDLE-MISCOUNT  a needle matched a number of times other than the arm
 *                    declared (default: exactly 1).
 *   CREATE-COLLISION an arm tried to create a file that already exists, so the
 *                    arm is not measuring what it says.
 *
 * The third exists because a needle that matches ZERO times is a silent no-op
 * that reads exactly like a catch — measured in this repo as
 * `csa_loom_crlf_makes_mutation_needles_silently_noop`, where CRLF endings made
 * every needle miss and a whole sweep reported a perfect score having changed
 * nothing. `crlf-blind-needle-control` in the set is the live control for it:
 * its declared expectation IS `needle-miscount`, so the sweep fails if a
 * zero-match needle ever starts reading as a catch.
 *
 * A needle that matches MORE than once is equally a finding: the arm then
 * mutates more than its description, and a catch cannot be attributed.
 *
 * ── LINE ENDINGS ───────────────────────────────────────────────────────────
 * Matching happens against an LF-normalised copy and the original ending style
 * is restored on write, so the runner works from a CRLF Windows checkout and an
 * LF Linux one alike.
 *
 * ── NO RAW ESC BYTES ───────────────────────────────────────────────────────
 * The ANSI strip builds its escape with `String.fromCharCode(27)`. A raw 0x1b
 * byte makes `gh pr diff` refuse to print the whole PR, and in a public repo a
 * literal terminal-control byte is a terminal-injection shape.
 *
 * ── EXIT CODE ──────────────────────────────────────────────────────────────
 * 0 only when every arm landed on its DECLARED outcome. Any surprise exits 1.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATIONS } from './mutations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** …/apps/fiab-console — five levels up from __tests__/mutation. */
const CONSOLE_ROOT = resolve(HERE, '..', '..', '..', '..', '..', '..');

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

const SUITES = [
  'app/api/items/stream-analytics-job/__tests__/',
  'app/api/items/stream-analytics-job/[name]/__tests__/',
];

/** Run the suites. Returns the RAW exit code — never a boolean. */
function runSuite() {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(CONSOLE_ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...SUITES, '--reporter=basic'],
      { cwd: CONSOLE_ROOT, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, CI: '1' } },
    );
    // The SUCCESS output is captured too, not discarded: a green run that
    // executed ZERO tests is a required check reporting success over nothing,
    // and it is invisible if only failure output is read.
    return { code: 0, output: stdout ?? '' };
  } catch (err) {
    // NOT a swallow — code and output are both carried forward. `status` is
    // null when the process died on a signal, which is a different fact from a
    // non-zero exit and is reported as one.
    return {
      code: err.status === null || err.status === undefined ? -1 : err.status,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  }
}

function summarize(output) {
  const m = output.match(/Tests\s+(.+)$/m);
  return m ? m[1].replace(ANSI, '').trim() : '(no test summary line)';
}

function executedCount(output) {
  const m = summarize(output).match(/\((\d+)\)\s*$/);
  return m === null ? null : Number(m[1]);
}

/**
 * The floor the baseline must clear.
 *
 * MEASURED 2026-09-10 at this head: the three ASA suites execute 50 tests. 45
 * sits below that and comfortably above any plausible partial run. A sweep whose
 * baseline silently stopped executing would report every arm as CAUGHT — every
 * one of them "fails" when nothing runs — so this refuses to start below it.
 * RAISE it as the suites grow; never lower it.
 */
const MIN_BASELINE_TESTS = 45;

const asLf = (s) => s.split('\r\n').join('\n');
const toOriginalEndings = (lf, wasCrlf) => (wasCrlf ? lf.split('\n').join('\r\n') : lf);

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

const only = process.argv[2];
const arms = only ? MUTATIONS.filter((a) => a.id === only) : MUTATIONS;
if (arms.length === 0) {
  console.error(`no mutation arm with id '${only}'. Known ids:`);
  for (const a of MUTATIONS) console.error(`  ${a.id}`);
  process.exit(1);
}

// ── the BASELINE. A suite that is already red makes every arm read as CAUGHT,
//    which would score a perfect sweep against a broken tree.
console.log('== BASELINE (unmutated)');
const baseline = runSuite();
const baselineTests = executedCount(baseline.output);
console.log(`   RC=${baseline.code}  ${summarize(baseline.output)}`);
if (baseline.code !== 0) {
  console.error(
    '\nBASELINE IS RED. Every arm would report as CAUGHT against a suite that already fails, ' +
      'which is a perfect score over a broken tree. Fix the suite first.\n',
  );
  console.error(baseline.output.slice(-4000));
  process.exit(1);
}
if (baselineTests === null || baselineTests < MIN_BASELINE_TESTS) {
  console.error(
    `\nBASELINE EXECUTED ${baselineTests ?? 'an UNREADABLE number of'} test(s), below the ` +
      `${MIN_BASELINE_TESTS} floor. A green sweep over a suite that ran nothing scores every arm ` +
      'as CAUGHT for the wrong reason. Refusing to run the arms.\n',
  );
  process.exit(1);
}

const results = [];
for (const arm of arms) {
  const edits = arm.edits ?? [];
  const creates = arm.create ?? [];
  /** file -> original bytes, for restore. */
  const originals = new Map();
  const created = [];
  let outcome = null;
  let rc = null;
  let tests = '';
  let detail = '';

  try {
    // ── 1. needle-count every edit BEFORE writing anything. An arm that would
    //       be a partial application is not applied at all.
    //
    // Edits accumulate PER FILE, in order, against a working copy — several arms
    // here make three edits to the same file. The first version of this runner
    // counted each needle against the pristine text and wrote each result
    // independently, so the LAST edit to a file silently discarded the earlier
    // ones. Every one of those arms still reported CAUGHT, for a reason that was
    // not the one the arm names: a partially-applied mutant that goes red is
    // indistinguishable from a defended property unless the application itself
    // is checked. Hence a working copy, and hence `occurrences` counted against
    // what the PREVIOUS edits left behind.
    const working = new Map(); // abs -> { wasCrlf, lf }
    for (const e of edits) {
      const abs = join(CONSOLE_ROOT, e.file);
      if (!working.has(abs)) {
        const raw = readFileSync(abs, 'utf8');
        originals.set(abs, raw);
        working.set(abs, { wasCrlf: raw.includes('\r\n'), lf: asLf(raw) });
      }
      const state = working.get(abs);
      const want = e.occurrences ?? 1;
      const got = countOccurrences(state.lf, e.find);
      if (got !== want) {
        outcome = 'NEEDLE-MISCOUNT';
        detail = `${e.file}: needle matched ${got}x, arm declares ${want}x`;
        break;
      }
      state.lf = state.lf.split(e.find).join(e.replace);
    }
    const planned = outcome === null
      ? [...working.entries()].map(([abs, s]) => ({ abs, wasCrlf: s.wasCrlf, lf: s.lf }))
      : [];

    if (outcome === null) {
      for (const c of creates) {
        const abs = join(CONSOLE_ROOT, c.file);
        if (existsSync(abs)) {
          outcome = 'CREATE-COLLISION';
          detail = `${c.file} already exists — the arm is not measuring what it claims`;
          break;
        }
      }
    }

    if (outcome === null) {
      // ── 2. apply — one write per file, carrying every edit that targeted it.
      for (const p of planned) writeFileSync(p.abs, toOriginalEndings(p.lf, p.wasCrlf), 'utf8');
      for (const c of creates) {
        const abs = join(CONSOLE_ROOT, c.file);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, c.content, 'utf8');
        created.push(abs);
      }
      // ── 3. measure.
      const run = runSuite();
      rc = run.code;
      tests = summarize(run.output);
      outcome = run.code === 0 ? 'SURVIVED' : 'CAUGHT';
      if (outcome === 'CAUGHT') {
        const first = run.output.replace(ANSI, '').match(/^\s*(?:AssertionError|Error).*$/m);
        detail = first ? first[0].trim().slice(0, 160) : '';
      }
    }
  } finally {
    // Restored from in-memory copies, in a finally, so an interrupt or a throw
    // cannot leave the working tree mutated.
    for (const [abs, raw] of originals) writeFileSync(abs, raw, 'utf8');
    for (const abs of created) rmSync(abs, { force: true });
    // Directories the create-arms made are removed too — with `rmdirSync`, which
    // removes ONLY an empty directory. Never a recursive delete: a path that
    // still holds real code must survive, loudly, rather than be swept away.
    // Two passes, deepest-first, so `[name]/scale/deep` then `[name]/scale`.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const abs of [...created].sort((a, b) => b.length - a.length)) {
        let dir = dirname(abs);
        for (let up = 0; up < 2; up += 1) {
          try { rmdirSync(dir); } catch { break; } // not empty, or already gone
          dir = dirname(dir);
        }
      }
    }
  }

  const expected =
    arm.expect === 'caught' ? 'CAUGHT' : arm.expect === 'survives' ? 'SURVIVED' : 'NEEDLE-MISCOUNT';
  const ok = outcome === expected;
  results.push({ id: arm.id, outcome, expected, rc, tests, ok, why: arm.why, detail });
  console.log(`== ${arm.id}\n   outcome=${outcome} expected=${expected} RC=${rc ?? 'n/a'}  ${tests}`);
  if (detail) console.log(`   ${detail}`);
  if (!ok) console.log('   ^^ UNEXPECTED');
}

console.log('\n================ MUTATION TABLE ================');
console.log('| arm | expected | outcome | RC | tests | verdict |');
console.log('|---|---|---|---|---|---|');
for (const r of results) {
  console.log(
    `| ${r.id} | ${r.expected} | ${r.outcome} | ${r.rc ?? 'n/a'} | ${r.tests || 'n/a'} | ${r.ok ? 'as declared' : 'UNEXPECTED'} |`,
  );
}

const unexpected = results.filter((r) => !r.ok);
const declaredSurvivors = results.filter((r) => r.expected === 'SURVIVED' && r.ok);
if (declaredSurvivors.length > 0) {
  console.log('\nDECLARED BLIND SPOTS (survived, and that is written down, not discovered):');
  for (const r of declaredSurvivors) console.log(`  - ${r.id}: ${r.why}`);
}
if (unexpected.length > 0) {
  console.log('\nUNEXPECTED — each of these is a FINDING about the guard, not a pass:');
  for (const r of unexpected) console.log(`  - ${r.id}: got ${r.outcome}, expected ${r.expected}`);
}
process.exit(unexpected.length === 0 ? 0 : 1);
