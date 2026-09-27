#!/usr/bin/env node
/**
 * #4619 / #4621 — THE MUTATION RUNNER for the server-derived-scope guard.
 *
 *     cd apps/fiab-console
 *     node app/api/items/_lib/__tests__/mutation/run-arms.mjs
 *     node app/api/items/_lib/__tests__/mutation/run-arms.mjs A16
 *
 * For each arm in `./mutations.mjs` it applies the source edits, runs that arm's
 * declared population, records the RAW exit code, and RESTORES the tree — from
 * in-memory copies, in a `finally`, so an interrupt cannot leave a mutant
 * behind. Modelled on `app/api/items/stream-analytics-job/__tests__/mutation/
 * run-arms.mjs`, which is this repo's established shape; the differences are
 * per-arm populations (A18 has to be scoped to be attributable) and a
 * population-drift check.
 *
 * RUN IT IN A `git worktree`. See the header of `./mutations.mjs`.
 *
 * ── THE FOUR OUTCOMES ──────────────────────────────────────────────────────
 *   CAUGHT            the population went red, in at least one spec file that is
 *                     not on the KNOWN_UNSTABLE list. The property is defended.
 *   SURVIVED          it stayed green. Either a declared blind spot
 *                     (`expect: 'survives'`) or A FINDING — printed as one,
 *                     never folded into a pass rate.
 *   UNATTRIBUTED      red, but EVERY failing file is KNOWN_UNSTABLE. Red for a
 *                     reason that is not the mutation, so it is not a kill.
 *   NEEDLE-MISCOUNT   an anchor matched a number of times other than declared
 *                     (default: exactly 1).
 *   POPULATION-DRIFT  the arm executed a DIFFERENT number of tests than its
 *                     baseline, so a file failed to COLLECT rather than to
 *                     assert. That is red for the wrong reason and a kill
 *                     cannot be attributed to it.
 *
 * UNATTRIBUTED exists because of a defect found in this runner's own first
 * sweep. It reported 20/20 CAUGHT while printing only a SUMMARY COUNT, so a
 * `1 failed` verdict could not be distinguished from the mutation's spec going
 * red and an unrelated file going red. Twenty minutes later the same population
 * went red on an UNMUTATED baseline, in
 * `app/api/items/_lib/__tests__/sql-editor-item-types.control.test.ts` — a file
 * this PR does not touch, which walks an import closure over the filesystem and
 * is load-sensitive. Had that landed during an arm instead of after it, a kill
 * would have been credited to the wrong cause. Every arm now REPORTS the failing
 * spec files, so attribution is visible rather than assumed.
 *
 * NEEDLE-MISCOUNT exists because an anchor that matches ZERO times is a silent
 * no-op that reads exactly like a catch. Measured on THIS PR on 2026-09-24: an
 * independent reviewer's first sweep reported 10/10 NOT-RUN because the sandbox
 * was CRLF and the anchors were LF. Without this check it would have read as
 * 10/10 KILLED. Matching happens against an LF-normalised copy and the original
 * endings are restored on write, so a CRLF and an LF checkout both work.
 *
 * ── RESTORE IS VERIFIED, NOT ASSUMED ───────────────────────────────────────
 * After restoring, every touched file is re-read and compared byte-for-byte to
 * the copy taken before the arm. A run that cannot prove it put the tree back
 * ABORTS rather than continuing over an unknown tree — `|| echo reverted` after
 * a failed restore has fabricated success in this repo before.
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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATIONS, POPULATIONS } from './mutations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** …/apps/fiab-console — six levels up from app/api/items/_lib/__tests__/mutation. */
const CONSOLE_ROOT = resolve(HERE, '..', '..', '..', '..', '..', '..');

// A resolve that silently lands in the wrong directory would make every suite
// path miss and every arm read as CAUGHT over a collection error. Prove it.
if (!existsSync(join(CONSOLE_ROOT, 'vitest.config.ts'))) {
  console.error(`CONSOLE_ROOT resolved to ${CONSOLE_ROOT}, which has no vitest.config.ts. Refusing to run.`);
  process.exit(1);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Run one population. Returns the RAW exit code — never a boolean. */
function runSuite(suites) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(CONSOLE_ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...suites, '--reporter=basic'],
      { cwd: CONSOLE_ROOT, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: '1' } },
    );
    // The SUCCESS output is captured too, not discarded: a green run that
    // executed ZERO tests is a check reporting success over nothing, and it is
    // invisible if only failure output is read.
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

function fileSummary(output) {
  const m = output.match(/Test Files\s+(.+)$/m);
  return m ? m[1].replace(ANSI, '').trim() : '(no file summary line)';
}

/** Total tests EXECUTED — the `(N)` at the end of the summary. `null` when unreadable. */
function executedCount(output) {
  const m = summarize(output).match(/\((\d+)\)\s*$/);
  return m === null ? null : Number(m[1]);
}

/**
 * The spec FILES that went red, so a kill can be attributed instead of assumed.
 * `--reporter=basic` prints ` FAIL  <path> > <suite> > <test>` per failing test.
 */
function failingFiles(output) {
  const clean = output.replace(ANSI, '');
  const seen = new Set();
  const re = /^\s*FAIL\s+(\S+\.test\.tsx?)/gm;
  let m = re.exec(clean);
  while (m !== null) {
    seen.add(m[1]);
    m = re.exec(clean);
  }
  return [...seen].sort();
}

/**
 * Files whose redness is NOT evidence about any mutation here.
 *
 * MEASURED 2026-09-24, and the entry is a disclosure rather than a convenience:
 * `sql-editor-item-types.control.test.ts` derives a population by walking an
 * import closure across the filesystem. It passed on all 20 arms of the first
 * full sweep and then failed TWICE on an UNMUTATED baseline within the next
 * twenty minutes on a loaded machine (once under `CI=1`, i.e. through vitest's
 * two retries). It is not in #4621's diff and no arm here can reach it.
 *
 * An arm whose ONLY failing files are on this list is reported UNATTRIBUTED, not
 * CAUGHT. Keep this list SHORT and justified: every entry is a file whose kill
 * power this runner has deliberately blinded itself to.
 */
const KNOWN_UNSTABLE = ['app/api/items/_lib/__tests__/sql-editor-item-types.control.test.ts'];

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

// ── the PARSER'S OWN CONTROL. `executedCount` is the number every verdict below
//    is weighed against, so it is exercised on synthetic output — including an
//    ANSI-wrapped one and a zero-collection one — BEFORE any real output is
//    trusted. A parser that read the ANSI-wrapped token as a non-digit and
//    returned 0 is a measured failure on this PR; it would make every arm green
//    over an empty population.
{
  const cases = [
    ['plain green', 'Test Files  27 passed (27)\nTests  341 passed (341)\n', 341],
    ['ansi red', `Tests  ${ESC}[31m1 failed${ESC}[39m | 340 passed (341)\n`, 341],
    ['zero collection', 'No test files found, exiting with code 1\n', null],
  ];
  const bad = cases.filter(([, text, want]) => executedCount(text) !== want);
  if (bad.length > 0) {
    console.error('TALLY PARSER SELF-TEST FAILED — the instrument cannot be trusted:');
    for (const [name, text, want] of bad) {
      console.error(`  ${name}: got ${executedCount(text)}, expected ${want}`);
    }
    process.exit(1);
  }
  console.log('tally parser self-test: 3/3 OK (plain, ANSI-wrapped, zero-collection)');

  // The ATTRIBUTION parser gets the same treatment, and for the same reason: if
  // it silently returned `[]` on real output, every CAUGHT arm would become
  // UNATTRIBUTED (loud) — but if it returned a file on GREEN output, every arm
  // would be credited to a name that never failed. Both directions are probed,
  // including the ANSI-wrapped shape vitest actually emits and a repeat of one
  // file, which must de-duplicate rather than count twice.
  const attrCases = [
    ['none on green', 'Test Files  27 passed (27)\n', []],
    [
      'ansi-wrapped, repeated file, two files',
      `${ESC}[41m FAIL ${ESC}[49m a/b/x.test.ts${ESC}[2m > ${ESC}[22mone\n`
      + ` FAIL  a/b/x.test.ts > two\n${ESC}[41m FAIL ${ESC}[49m c/d/y.test.tsx > three\n`,
      ['a/b/x.test.ts', 'c/d/y.test.tsx'],
    ],
  ];
  const attrBad = attrCases.filter(([, text, want]) => failingFiles(text).join('|') !== want.join('|'));
  if (attrBad.length > 0) {
    console.error('ATTRIBUTION PARSER SELF-TEST FAILED — a kill could not be attributed:');
    for (const [name, text, want] of attrBad) {
      console.error(`  ${name}: got [${failingFiles(text)}], expected [${want}]`);
    }
    process.exit(1);
  }
  console.log('attribution parser self-test: 2/2 OK (green yields none; ANSI-wrapped de-duplicates)');
}

const only = process.argv[2];
const arms = only ? MUTATIONS.filter((a) => a.id === only) : MUTATIONS;
if (arms.length === 0) {
  console.error(`no mutation arm with id '${only}'. Known ids:`);
  for (const a of MUTATIONS) console.error(`  ${a.id}`);
  process.exit(1);
}

// ── BASELINES, one per population the selected arms actually use. A population
//    that is already red makes every arm read as CAUGHT, which would score a
//    perfect sweep against a broken tree.
const baselines = new Map();
for (const key of new Set(arms.map((a) => a.population))) {
  const pop = POPULATIONS[key];
  if (!pop) {
    console.error(`arm declares unknown population '${key}'`);
    process.exit(1);
  }
  console.log(`== BASELINE [${key}] (unmutated)`);
  const run = runSuite(pop.suites);
  const tests = executedCount(run.output);
  console.log(`   RC=${run.code}  ${fileSummary(run.output)} | ${summarize(run.output)}`);
  if (run.code !== 0) {
    const failed = failingFiles(run.output);
    const attributable = failed.filter((f) => !KNOWN_UNSTABLE.includes(f));
    if (failed.length === 0 || attributable.length > 0) {
      console.error(
        `\nBASELINE [${key}] IS RED. Every arm would report CAUGHT against a population that already ` +
          'fails, which is a perfect score over a broken tree. Fix the suite first.\n' +
          `Failing spec files: ${failed.join(', ') || '(none parsed — the failure is not a spec assertion)'}\n`,
      );
      console.error(run.output.slice(-4000));
      process.exit(1);
    }
    // Red ONLY in files this runner is already blind to. The sweep can proceed
    // because every arm subtracts the same set — but it is announced, never
    // absorbed silently, because a growing KNOWN_UNSTABLE list is how a suite
    // stops being evidence.
    console.log(`   WARNING: baseline red ONLY in KNOWN_UNSTABLE: ${failed.join(', ')} — continuing.`);
  }
  if (tests === null || tests < pop.minTests) {
    console.error(
      `\nBASELINE [${key}] EXECUTED ${tests ?? 'an UNREADABLE number of'} test(s), below the ` +
        `${pop.minTests} floor. A green sweep over a population that ran nothing scores every arm as ` +
        'CAUGHT for the wrong reason. Refusing to run the arms.\n',
    );
    process.exit(1);
  }
  baselines.set(key, { tests, files: fileSummary(run.output), summary: summarize(run.output) });
}

const results = [];
for (const arm of arms) {
  const pop = POPULATIONS[arm.population];
  const base = baselines.get(arm.population);
  /** abs -> original bytes, for restore AND for proving the restore happened. */
  const originals = new Map();
  let outcome = null;
  let rc = null;
  let tests = '';
  let detail = '';

  try {
    // ── 1. anchor-count every edit BEFORE writing anything. An arm that would
    //       be a partial application is not applied at all.
    //
    // Edits accumulate PER FILE, in order, against a working copy — A4 and A12
    // each make two edits to one file. Counting each anchor against the pristine
    // text and writing each result independently would let the LAST edit discard
    // the earlier ones, and the arm would still report CAUGHT, for a reason that
    // is not the one it names.
    const working = new Map(); // abs -> { wasCrlf, lf }
    for (const e of arm.edits) {
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
        detail = `${e.file}: anchor matched ${got}x, arm declares ${want}x`;
        break;
      }
      state.lf = state.lf.split(e.find).join(e.replace);
    }

    if (outcome === null) {
      // ── 2. apply — one write per file, carrying every edit that targeted it.
      for (const [abs, s] of working) writeFileSync(abs, toOriginalEndings(s.lf, s.wasCrlf), 'utf8');
      // ── 3. measure.
      const run = runSuite(pop.suites);
      rc = run.code;
      tests = `${fileSummary(run.output)} | ${summarize(run.output)}`;
      const executed = executedCount(run.output);
      if (executed !== base.tests) {
        // Red because a file stopped COLLECTING is not the same fact as red
        // because an assertion fired, and only the second attributes a kill.
        outcome = 'POPULATION-DRIFT';
        detail = `executed ${executed ?? 'unreadable'} test(s), baseline ${base.tests}`;
      } else {
        const failed = failingFiles(run.output);
        const attributable = failed.filter((f) => !KNOWN_UNSTABLE.includes(f));
        if (run.code === 0) {
          outcome = 'SURVIVED';
        } else if (attributable.length === 0) {
          // Red, but every failing file is one whose redness says nothing about
          // this mutation. Crediting it would be a kill attributed to the wrong
          // cause — the exact defect this branch was added to prevent.
          outcome = 'UNATTRIBUTED';
          detail = `only KNOWN_UNSTABLE files failed: ${failed.join(', ') || '(none parsed)'}`;
        } else {
          outcome = 'CAUGHT';
          const first = run.output.replace(ANSI, '').match(/^\s*(?:AssertionError|Error).*$/m);
          detail = `killed in: ${attributable.join(', ')}${first ? ` — ${first[0].trim().slice(0, 120)}` : ''}`;
        }
      }
    }
  } finally {
    // Restored from in-memory copies, in a finally, so an interrupt or a throw
    // cannot leave the working tree mutated — and then PROVEN, because a restore
    // that silently failed leaves every later arm measuring an unknown tree.
    const unrestored = [];
    for (const [abs, raw] of originals) {
      try {
        writeFileSync(abs, raw, 'utf8');
        if (readFileSync(abs, 'utf8') !== raw) unrestored.push(abs);
      } catch (e) {
        unrestored.push(`${abs} (${e.message})`);
      }
    }
    if (unrestored.length > 0) {
      console.error(`\nRESTORE FAILED after ${arm.id}. The tree is NOT back to where it started:`);
      for (const u of unrestored) console.error(`  ${u}`);
      console.error('ABORTING rather than measuring further arms against an unknown tree.\n');
      process.exit(2);
    }
  }

  const expected = arm.expect === 'caught' ? 'CAUGHT' : arm.expect === 'survives' ? 'SURVIVED' : 'NEEDLE-MISCOUNT';
  const ok = outcome === expected;
  results.push({ id: arm.id, population: arm.population, outcome, expected, rc, tests, ok, why: arm.why, detail });
  console.log(`== ${arm.id} [${arm.population}]\n   outcome=${outcome} expected=${expected} RC=${rc ?? 'n/a'}  ${tests}`);
  if (detail) console.log(`   ${detail}`);
  if (!ok) console.log('   ^^ UNEXPECTED');
}

console.log('\n================ MUTATION TABLE ================');
for (const [key, b] of baselines) console.log(`baseline [${key}]: ${b.files} | ${b.summary}`);
console.log('\n| arm | population | expected | outcome | RC | tests | verdict |');
console.log('|---|---|---|---|---|---|---|');
for (const r of results) {
  console.log(
    `| ${r.id} | ${r.population} | ${r.expected} | ${r.outcome} | ${r.rc ?? 'n/a'} | ${r.tests || 'n/a'} | ${r.ok ? 'as declared' : 'UNEXPECTED'} |`,
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
