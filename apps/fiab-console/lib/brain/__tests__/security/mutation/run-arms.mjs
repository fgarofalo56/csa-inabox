/**
 * THE MUTATION HARNESS.
 *
 * For each arm: break the subject, run the spec that asserts the subject is
 * clean, REQUIRE it to go RED, restore byte-for-byte, run again, REQUIRE it to
 * go GREEN. Both exit codes are printed.
 *
 *     node lib/brain/__tests__/security/mutation/run-arms.mjs            # all arms
 *     node lib/brain/__tests__/security/mutation/run-arms.mjs --only c1-narrow
 *     node lib/brain/__tests__/security/mutation/run-arms.mjs --arm narrow
 *
 * Exit 0 only if EVERY arm behaved. Any arm whose mutated run stayed GREEN is a
 * real finding about the detector or the spec, and this harness prints it as
 * "ESCAPED" rather than failing quietly.
 *
 * ── HOW THE EXIT CODE IS READ ────────────────────────────────────────────
 *
 * `spawnSync(...).status` — the CHILD's exit code, captured directly with no
 * pipe, no wrapper and no trailing test between the command and the read. This
 * repo has lost time to five different shapes of "the exit code you read is the
 * wrapper's, not the subject's", so the mechanism is stated rather than assumed.
 * A `null` status (killed by a signal) is treated as a failure of the harness,
 * never as a verdict.
 *
 * ── THE TREE IS ALWAYS RESTORED ──────────────────────────────────────────
 *
 * Originals are captured as raw bytes before any write and put back in a
 * `finally`, plus a byte-equality assertion after each arm. A harness that can
 * leave the tree mutated would turn a crash into a silently broken repo — and
 * `git stash` is REPO-GLOBAL here, so "just stash it" is not a safe recovery.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSOLE_ROOT,
  CORPUS,
  MUTATIONS,
  applyMutation,
  applySubstitution,
  readOriginal,
  restore,
} from './mutations.mjs';

const VITEST_ENTRY = join(CONSOLE_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

/**
 * THE HARNESS'S OWN CONTROL.
 *
 * A mutation harness that silently applies nothing is worse than no harness: it
 * prints CAUGHT-shaped output over a suite that was never challenged. This repo
 * has the exact failure on record — a needle written with an LF newline against
 * CRLF sources matches ZERO times and reads exactly like a pass.
 *
 * So before any arm runs, prove the three ways `applySubstitution` must abort.
 * Run with `--self-test` to see it alone; it runs unconditionally otherwise.
 */
function selfTest() {
  const text = readOriginal(CORPUS);
  const checks = [];

  // 1. A needle carrying the WRONG line terminator for this file.
  //
  //    Derived from the file rather than hard-coded, because `core.autocrlf` is
  //    `true` here: the same bytes are CRLF in a Windows working tree and LF on
  //    a Linux CI checkout. A check hard-coded to CRLF would pass locally and
  //    FALSELY ALARM in CI — which is the same class of error it exists to
  //    catch. Built from a real line so ONLY the terminator differs.
  const crlf = (text.match(/\r\n/g) || []).length;
  const bareLf = (text.match(/[^\r]\n/g) || []).length;
  const dominant = crlf >= bareLf ? '\r\n' : '\n';
  const wrong = dominant === '\r\n' ? '\n' : '\r\n';
  const realLine = 'allowPaths: [AP_CLEAN_DELEGATION], // MUT-C1';
  const wrongTerminatorNeedle = `${realLine}${wrong}        reachesPrivilegedSink: true,`;
  checks.push([
    `needle with the wrong terminator aborts (file is ${dominant === '\r\n' ? 'CRLF' : 'LF'}; ` +
      'this is the landmine that silently no-ops a whole arm)',
    () =>
      applySubstitution(
        text,
        { file: CORPUS, needle: wrongTerminatorNeedle, replacement: 'x' },
        'self',
      ),
  ]);

  // Sanity: the RIGHT terminator must match exactly once, or check 1 proved
  // nothing more than "that string is absent".
  checks.push([
    'the same needle with the CORRECT terminator matches exactly once (so check 1 is meaningful)',
    () => {
      const good = `${realLine}${dominant}        reachesPrivilegedSink: true,`;
      applySubstitution(text, { file: CORPUS, needle: good, replacement: 'x' }, 'self');
      // Inverted: this one must NOT throw, so signal failure by throwing when it
      // succeeds is wrong. Handled by the `expectThrow` flag below.
    },
    /* expectThrow */ false,
  ]);

  // 2. An ambiguous needle mutates more than the arm describes.
  checks.push([
    'ambiguous needle aborts',
    () => applySubstitution(text, { file: CORPUS, needle: '  }', replacement: 'x' }, 'self'),
  ]);

  // 3. A needle that is simply absent.
  checks.push([
    'absent needle aborts',
    () =>
      applySubstitution(
        text,
        { file: CORPUS, needle: 'NEEDLE-THAT-IS-NOT-THERE', replacement: 'x' },
        'self',
      ),
  ]);

  const failures = [];
  for (const [name, fn, expectThrow = true] of checks) {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    const ok = threw === expectThrow;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!ok) failures.push(name);
  }

  return failures;
}

/** Run one spec file. Returns the child's exit code, read with nothing in between. */
function runSpec(spec) {
  const res = spawnSync(process.execPath, [VITEST_ENTRY, 'run', spec, '--reporter=dot'], {
    cwd: CONSOLE_ROOT,
    encoding: 'utf8',
    // Never `inherit`: the child's bytes would land on this process's stdout,
    // which in an Actions `run:` step is the public log. Capture, then decide
    // what to print. (That is C4's inherited-fd class applied to this harness.)
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '' },
  });
  if (res.status === null) {
    throw new Error(
      `vitest was killed by ${res.signal ?? 'an unknown signal'} — that is a harness failure, ` +
        'not a verdict, and must not be read as either RED or GREEN.',
    );
  }
  return { rc: res.status, out: `${res.stdout}\n${res.stderr}` };
}

function summarise(out) {
  const m = out.match(/Tests\s+.*$/m);
  return (m ? m[0] : out.trim().split('\n').slice(-1)[0] || '').replace(/\[[0-9;]*m/g, '').trim();
}

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const armFilter = args.includes('--arm') ? args[args.indexOf('--arm') + 1] : null;

console.log('# harness self-test (the harness must be able to FAIL before its verdicts mean anything)');
const selfFailures = selfTest();
console.log('');
if (selfFailures.length > 0) {
  console.error('HARNESS SELF-TEST FAILED — no arm result below would be trustworthy:');
  for (const f of selfFailures) console.error(`  ${f}`);
  process.exit(2);
}
if (args.includes('--self-test')) process.exit(0);

const selected = MUTATIONS.filter(
  (m) => (!only || m.id === only) && (!armFilter || m.arm === armFilter),
);

if (selected.length === 0) {
  console.error('no mutations selected');
  process.exit(2);
}

console.log(`# mutation arms: ${selected.length}\n`);

const results = [];

for (const mutation of selected) {
  let originals = null;
  let record;
  try {
    originals = applyMutation(mutation);

    // Prove the restore target really differs — a mutation that produced an
    // identical file would sail through both arms and prove nothing.
    let changedSomething = false;
    for (const [file, before] of originals) {
      if (readFileSync(file, 'utf8') !== before) changedSomething = true;
    }
    if (!changedSomething) {
      throw new Error(
        `[${mutation.id}] applied cleanly but changed NO bytes. A no-op mutation is the silent ` +
          'failure this harness exists to catch.',
      );
    }

    const mutated = runSpec(mutation.spec);
    restore(originals);
    for (const [file, before] of originals) {
      if (readFileSync(file, 'utf8') !== before) {
        throw new Error(`[${mutation.id}] restore did not reproduce ${file} byte-for-byte.`);
      }
    }
    originals = null;
    const restored = runSpec(mutation.spec);

    record = {
      id: mutation.id,
      class: mutation.taxonomyClass,
      arm: mutation.arm,
      what: mutation.what,
      mutatedRc: mutated.rc,
      restoredRc: restored.rc,
      mutatedSummary: summarise(mutated.out),
      restoredSummary: summarise(restored.out),
      // RED-then-GREEN is the only passing shape. Anything else is reported.
      verdict: mutated.rc !== 0 && restored.rc === 0 ? 'CAUGHT' : mutated.rc === 0 ? 'ESCAPED' : 'DIRTY',
    };
  } catch (err) {
    record = {
      id: mutation.id,
      class: mutation.taxonomyClass,
      arm: mutation.arm,
      what: mutation.what,
      mutatedRc: null,
      restoredRc: null,
      verdict: 'HARNESS-ERROR',
      error: String(err && err.message ? err.message : err),
    };
  } finally {
    if (originals) restore(originals);
  }

  results.push(record);
  const head = `${record.verdict.padEnd(13)} ${record.class} ${record.arm.padEnd(6)} ${record.id}`;
  console.log(head);
  console.log(`    ${record.what}`);
  if (record.error) {
    console.log(`    ERROR: ${record.error}`);
  } else {
    console.log(`    mutated  RC=${record.mutatedRc}   ${record.mutatedSummary}`);
    console.log(`    restored RC=${record.restoredRc}   ${record.restoredSummary}`);
  }
  console.log('');
}

const escaped = results.filter((r) => r.verdict !== 'CAUGHT');

console.log('---');
console.log(`caught: ${results.length - escaped.length}/${results.length}`);
if (escaped.length > 0) {
  console.log('\nARMS THAT DID NOT BEHAVE — report these, do not hide them:');
  for (const r of escaped) {
    console.log(`  ${r.verdict}  ${r.id}  (mutated RC=${r.mutatedRc}, restored RC=${r.restoredRc})`);
  }
}

process.exit(escaped.length === 0 ? 0 : 1);
