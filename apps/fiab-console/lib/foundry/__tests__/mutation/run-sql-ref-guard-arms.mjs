/**
 * THE MUTATION HARNESS for the ontology SQL-sink name-space guard (#4219).
 *
 * For each arm: break the guard, run the spec that asserts the guard refuses,
 * REQUIRE it to go RED for the REASON the arm predicts, restore byte-for-byte,
 * run again, REQUIRE it to go GREEN. Both exit codes are printed.
 *
 *     cd apps/fiab-console
 *     node lib/foundry/__tests__/mutation/run-sql-ref-guard-arms.mjs
 *     node lib/foundry/__tests__/mutation/run-sql-ref-guard-arms.mjs --only empty-part-trailing-only
 *     node lib/foundry/__tests__/mutation/run-sql-ref-guard-arms.mjs --arm narrow
 *     node lib/foundry/__tests__/mutation/run-sql-ref-guard-arms.mjs --self-test
 *
 * Exit 0 only if EVERY arm behaved. An arm whose mutated run stayed GREEN is a
 * real finding about the guard or the spec and is printed as ESCAPED, never
 * swallowed.
 *
 * ── RED IS NOT ENOUGH; RED FOR THE RIGHT REASON IS ───────────────────────
 *
 * A mutant can go red because it broke compilation, or because it tripped some
 * unrelated assertion. Either would let a blind spec masquerade as a strong one.
 * So each arm declares `mustFail`: substrings that MUST appear in the mutated
 * run's output — the names of the tests the arm's own mechanism predicts. An arm
 * that goes red without them is reported as WRONG-REASON, which is a finding.
 *
 * ── HOW THE EXIT CODE IS READ ────────────────────────────────────────────
 *
 * `spawnSync(...).status` — the CHILD's exit code, read directly with no pipe,
 * no wrapper and no intervening command. A `null` status (killed by a signal) is
 * a harness failure, never a verdict.
 *
 * ── THE TREE IS ALWAYS RESTORED ──────────────────────────────────────────
 *
 * Originals are captured as raw bytes before any write, put back in a `finally`,
 * and byte-compared afterwards. `git stash` is REPO-GLOBAL in this repo and other
 * agents share it, so "just stash it" is not a safe recovery and this harness
 * must never need one.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSOLE_ROOT,
  GUARD,
  MUTATIONS,
  applyMutation,
  applySubstitution,
  readOriginal,
  restore,
} from './sql-ref-guard-mutations.mjs';

const VITEST_ENTRY = join(CONSOLE_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

/**
 * THE HARNESS'S OWN CONTROL.
 *
 * A harness that silently applies nothing prints CAUGHT-shaped output over a
 * suite that was never challenged. Prove the ways `applySubstitution` must abort
 * BEFORE any verdict is produced.
 */
function selfTest() {
  const text = readOriginal(GUARD);

  // The wrong-terminator needle is derived from the file, never hard-coded:
  // `core.autocrlf` is true here, so the same blob is CRLF in a Windows working
  // tree and LF on a Linux CI checkout. A hard-coded CRLF check would pass
  // locally and FALSELY ALARM in CI — the same class of error it guards.
  const crlf = (text.match(/\r\n/g) || []).length;
  const bareLf = (text.match(/[^\r]\n/g) || []).length;
  const dominant = crlf >= bareLf ? '\r\n' : '\n';
  const wrong = dominant === '\r\n' ? '\n' : '\r\n';
  const realLine = 'export function ontologySqlRefViolation(ref: string, ownDatabase?: string): string | null {';
  const nextLine = '  const parts = sqlRefParts(ref);';
  const DUP = '  if (';
  const dupCount = text.split(DUP).length - 1;

  const checks = [
    [
      `a needle with the WRONG terminator aborts (this file is ${dominant === '\r\n' ? 'CRLF' : 'LF'}; ` +
        'a silent zero-match is what would no-op a whole arm)',
      () => applySubstitution(text, { file: GUARD, needle: `${realLine}${wrong}${nextLine}`, replacement: 'x' }, 'self'),
      true,
    ],
    [
      'the same needle with the CORRECT terminator matches exactly once, so the check above is meaningful',
      () => applySubstitution(text, { file: GUARD, needle: `${realLine}${dominant}${nextLine}`, replacement: 'x' }, 'self'),
      false,
    ],
    // `  if (` is the ambiguity control. Its own precondition is checked FIRST
    // and separately: a control that had quietly become unique would still make
    // `applySubstitution` throw, and the arm would read "ok" for the wrong
    // reason. Two checks, so each can only pass one way.
    [
      `the ambiguity control is genuinely repeated (occurs ${dupCount}x, needs >= 2)`,
      () => { if (dupCount < 2) throw new Error('control is no longer ambiguous'); },
      false,
    ],
    [
      'an AMBIGUOUS needle aborts',
      () => applySubstitution(text, { file: GUARD, needle: DUP, replacement: 'x' }, 'self'),
      true,
    ],
    [
      'an ABSENT needle aborts',
      () => applySubstitution(text, { file: GUARD, needle: 'NEEDLE-THAT-IS-NOT-THERE', replacement: 'x' }, 'self'),
      true,
    ],
  ];

  const failures = [];
  for (const [name, fn, expectThrow] of checks) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    const ok = threw === expectThrow;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!ok) failures.push(name);
  }

  // Every needle in the table must match exactly once RIGHT NOW. A stale needle
  // is caught here, before it can be mistaken for a surviving mutant.
  for (const mutation of MUTATIONS) {
    for (const sub of mutation.substitutions) {
      let ok = true;
      try { applySubstitution(readOriginal(sub.file), sub, mutation.id); } catch { ok = false; }
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  [${mutation.id}] needle matches exactly once`);
      if (!ok) failures.push(`${mutation.id} needle`);
    }
  }

  return failures;
}

/** Run one spec file. Returns the child's exit code, read with nothing in between. */
function runSpec(spec) {
  const res = spawnSync(process.execPath, [VITEST_ENTRY, 'run', spec, '--reporter=dot'], {
    cwd: CONSOLE_ROOT,
    encoding: 'utf8',
    // Never `inherit`: the child's bytes would land on this process's stdout,
    // which in an Actions `run:` step is a public log.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '' },
  });
  if (res.status === null) {
    throw new Error(
      `vitest was killed by ${res.signal ?? 'an unknown signal'} — that is a harness failure, not a ` +
        'verdict, and must not be read as either RED or GREEN.',
    );
  }
  return { rc: res.status, out: `${res.stdout}\n${res.stderr}`.replace(/\[[0-9;]*m/g, '') };
}

function summarise(out) {
  const m = out.match(/Tests\s+.*$/m);
  return (m ? m[0] : out.trim().split('\n').slice(-1)[0] || '').trim();
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

const selected = MUTATIONS.filter((m) => (!only || m.id === only) && (!armFilter || m.arm === armFilter));
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

    let changedSomething = false;
    for (const [file, before] of originals) {
      if (readFileSync(file, 'utf8') !== before) changedSomething = true;
    }
    if (!changedSomething) {
      throw new Error(
        `[${mutation.id}] applied cleanly but changed NO bytes. A no-op mutation is the silent failure ` +
          'this harness exists to catch.',
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

    const missing = (mutation.mustFail || []).filter((s) => !mutated.out.includes(s));

    record = {
      id: mutation.id,
      arm: mutation.arm,
      what: mutation.what,
      mutatedRc: mutated.rc,
      restoredRc: restored.rc,
      mutatedSummary: summarise(mutated.out),
      restoredSummary: summarise(restored.out),
      missing,
      verdict:
        mutated.rc === 0 ? 'ESCAPED'
          : restored.rc !== 0 ? 'DIRTY'
            : missing.length > 0 ? 'WRONG-REASON'
              : 'CAUGHT',
    };
  } catch (err) {
    record = {
      id: mutation.id,
      arm: mutation.arm,
      what: mutation.what,
      mutatedRc: null,
      restoredRc: null,
      missing: [],
      verdict: 'HARNESS-ERROR',
      error: String(err && err.message ? err.message : err),
    };
  } finally {
    if (originals) restore(originals);
  }

  results.push(record);
  console.log(`${record.verdict.padEnd(13)} ${record.arm.padEnd(6)} ${record.id}`);
  console.log(`    ${record.what}`);
  if (record.error) {
    console.log(`    ERROR: ${record.error}`);
  } else {
    console.log(`    mutated  RC=${record.mutatedRc}   ${record.mutatedSummary}`);
    console.log(`    restored RC=${record.restoredRc}   ${record.restoredSummary}`);
    if (record.missing.length > 0) {
      console.log(`    predicted failures NOT observed: ${JSON.stringify(record.missing)}`);
    }
  }
  console.log('');
}

const bad = results.filter((r) => r.verdict !== 'CAUGHT');

console.log('---');
console.log(`caught: ${results.length - bad.length}/${results.length}`);
if (bad.length > 0) {
  console.log('\nARMS THAT DID NOT BEHAVE — report these, do not hide them:');
  for (const r of bad) {
    console.log(`  ${r.verdict}  ${r.id}  (mutated RC=${r.mutatedRc}, restored RC=${r.restoredRc})`);
  }
}

process.exit(bad.length === 0 ? 0 : 1);
