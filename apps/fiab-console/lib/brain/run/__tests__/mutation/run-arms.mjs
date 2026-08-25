#!/usr/bin/env node
/**
 * LOOM BRAIN W10 — the MUTATION RUNNER (#3936 acceptance 5).
 *
 *     node lib/brain/run/__tests__/mutation/run-arms.mjs            # every arm
 *     node lib/brain/run/__tests__/mutation/run-arms.mjs <arm-id>   # one arm
 *
 * Run from `apps/fiab-console`. For each arm in `./mutations.mjs` it applies the
 * source edit, runs `vitest run lib/brain/run`, records the raw exit code, and
 * RESTORES the file — from an in-memory copy, in a `finally`, so an interrupted
 * run cannot leave the tree mutated.
 *
 * ── THE THREE OUTCOMES, AND WHY THERE ARE THREE ───────────────────────────
 *   CAUGHT         the suite went red. The property is defended.
 *   SURVIVED       the suite stayed green. Either the arm is a declared blind
 *                  spot (`expect: 'survives'`) or IT IS A FINDING — a mutation
 *                  that does not move the verdict is itself the result, and it
 *                  is printed as such rather than folded into a pass rate.
 *   NEEDLE-MISSED  the edit did not change the file at all.
 *
 * The third exists because a needle that does not match is a silent no-op that
 * reads exactly like "the mutation was caught" — measured in this repo as
 * `csa_loom_crlf_makes_mutation_needles_silently_noop`, where CRLF line endings
 * made every needle miss and a whole mutation sweep reported a perfect score
 * having changed nothing.
 *
 * ── LINE ENDINGS ARE NORMALISED BEFORE MATCHING (review of #4014) ─────────
 * Reporting NEEDLE-MISSED loudly is necessary and not sufficient: it turns a
 * silent no-op into a loud one, but the sweep still cannot run. `.gitattributes`
 * does not pin `*.mjs` or `lib/brain/**`, so this file and its subjects are LF
 * in the repository and CRLF in a fresh Windows checkout — the reviewer of #4014
 * measured CRLF where this working tree had LF, and both observations were
 * correct. So matching happens against an LF-normalised copy and the original
 * ending style is restored on write. The runner is then immune to the checkout
 * it happens to be run from, which is stronger than pinning one file.
 *
 * ── NO RAW ESC BYTES (review of #4014) ────────────────────────────────────
 * The ANSI strip below builds its escape with `String.fromCharCode(27)`. A raw
 * 0x1b byte in a source file makes `gh pr diff` refuse to print the whole PR —
 * measured on #4014 — and in a public repository a literal terminal-control byte
 * is a terminal-injection shape. Never embed one.
 *
 * ── EXIT CODE ─────────────────────────────────────────────────────────────
 * 0 only when every arm landed on its DECLARED expectation. An unexpected
 * survivor, an unexpected catch, or any needle miss exits 1.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATIONS } from './mutations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = resolve(HERE, '..', '..', '..', '..', '..');

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Run the suite. Returns the RAW exit code — never a boolean. */
function runSuite() {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        join(CONSOLE_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        'lib/brain/run',
        '--reporter=basic',
      ],
      { cwd: CONSOLE_ROOT, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, CI: '1' } },
    );
    // The SUCCESS output is captured too, not discarded. A green run that
    // executed ZERO tests is #3783 — a required check reporting success having
    // run nothing — and it is invisible if only failure output is read.
    return { code: 0, output: stdout ?? '' };
  } catch (err) {
    // NOT a swallow: the code and the output are both carried forward and
    // printed. `status` is null when the process was killed by a signal, which
    // is a different fact from a non-zero exit and is reported as one.
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

/**
 * How many tests the suite actually EXECUTED, from vitest's own summary line.
 *
 * Read on the BASELINE. A green sweep over a suite that executed ZERO tests is
 * #3783 — a required check reporting success having run nothing — and under it
 * every arm would read as CAUGHT for entirely the wrong reason.
 */
function executedCount(output) {
  const m = summarize(output).match(/\((\d+)\)\s*$/);
  return m === null ? null : Number(m[1]);
}

/**
 * The floor the baseline must clear.
 *
 * Measured 240 at the time of writing; set ~10% below so ordinary churn does not
 * trip it while a suite that silently stopped executing does. RAISE this as the
 * suite grows — never lower it.
 */
const MIN_BASELINE_TESTS = 300;

/** Apply an edit against an LF-normalised view, restoring the original endings. */
function applyMutation(original, find, replace) {
  const wasCrlf = original.includes('\r\n');
  const lf = wasCrlf ? original.split('\r\n').join('\n') : original;
  const mutatedLf = lf.replace(find, replace);
  if (mutatedLf === lf) return null;
  return wasCrlf ? mutatedLf.split('\n').join('\r\n') : mutatedLf;
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
    '\nBASELINE IS RED. Every arm would report as CAUGHT against a suite that already ' +
      'fails, which is a perfect score over a broken tree. Fix the suite first.\n',
  );
  console.error(baseline.output.slice(-4000));
  process.exit(1);
}
if (baselineTests === null || baselineTests < MIN_BASELINE_TESTS) {
  console.error(
    `\nBASELINE EXECUTED ${baselineTests ?? 'an UNREADABLE number of'} test(s), below the ` +
      `${MIN_BASELINE_TESTS} floor. A green sweep over a suite that ran nothing scores every ` +
      'arm as CAUGHT for the wrong reason — that is #3783, a required check reporting success ' +
      'over an unexecuted suite. Refusing to run the arms.\n',
  );
  process.exit(1);
}

const results = [];
for (const arm of arms) {
  const path = join(CONSOLE_ROOT, arm.file);
  const original = readFileSync(path, 'utf8');
  let outcome;
  let rc = null;
  let tests = '';
  try {
    const mutated = applyMutation(original, arm.find, arm.replace);
    if (mutated === null) {
      outcome = 'NEEDLE-MISSED';
    } else {
      writeFileSync(path, mutated, 'utf8');
      const run = runSuite();
      rc = run.code;
      tests = summarize(run.output);
      outcome = run.code === 0 ? 'SURVIVED' : 'CAUGHT';
    }
  } finally {
    // Restored from the in-memory copy, in a finally, so an interrupt or a
    // throw cannot leave the working tree mutated.
    writeFileSync(path, original, 'utf8');
  }
  const expected = arm.expect === 'caught' ? 'CAUGHT' : 'SURVIVED';
  const ok = outcome === expected;
  results.push({ id: arm.id, file: arm.file, outcome, expected, rc, tests, ok, why: arm.why });
  console.log(
    `== ${arm.id}\n   ${arm.file}\n   outcome=${outcome} expected=${expected} RC=${rc ?? 'n/a'}  ${tests}`,
  );
  if (!ok) console.log('   ^^ UNEXPECTED');
}

console.log('\n================ MUTATION TABLE ================');
console.log('| arm | file | expected | outcome | RC | verdict |');
console.log('|---|---|---|---|---|---|');
for (const r of results) {
  console.log(
    `| ${r.id} | ${r.file} | ${r.expected} | ${r.outcome} | ${r.rc ?? 'n/a'} | ${r.ok ? 'as declared' : 'UNEXPECTED'} |`,
  );
}

const unexpected = results.filter((r) => !r.ok);
const declaredSurvivors = results.filter((r) => r.expected === 'SURVIVED' && r.ok);
if (declaredSurvivors.length > 0) {
  console.log('\nDECLARED BLIND SPOTS (survived, and that is written down, not discovered):');
  for (const r of declaredSurvivors) console.log(`  - ${r.id}: ${r.why}`);
}
if (unexpected.length > 0) {
  console.log('\nUNEXPECTED — each of these is a FINDING about the tests, not a pass:');
  for (const r of unexpected) console.log(`  - ${r.id}: got ${r.outcome}, expected ${r.expected}`);
}
process.exit(unexpected.length === 0 ? 0 : 1);
