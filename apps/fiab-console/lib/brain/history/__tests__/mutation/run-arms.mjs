/**
 * THE MUTATION HARNESS for Loom Brain W9 (graph history, #3935).
 *
 * For each arm: break the subject, run the spec that asserts the property,
 * REQUIRE it to go RED, restore byte-for-byte, run again, REQUIRE it to go
 * GREEN. Both exit codes are printed.
 *
 *     node lib/brain/history/__tests__/mutation/run-arms.mjs
 *     node lib/brain/history/__tests__/mutation/run-arms.mjs --only c-prune-not-executed
 *     node lib/brain/history/__tests__/mutation/run-arms.mjs --property C
 *     node lib/brain/history/__tests__/mutation/run-arms.mjs --self-test
 *
 * Exit 0 only if EVERY arm behaved. An arm whose mutated run stayed GREEN is a
 * real finding about the code or the spec, and it is printed as ESCAPED rather
 * than swallowed.
 *
 * ── HOW THE EXIT CODE IS READ ────────────────────────────────────────────
 *
 * `spawnSync(...).status` — the CHILD's exit code, captured directly, with no
 * pipe, no wrapper and no command between the run and the read. This repo has
 * lost time to five different shapes of "the exit code you read is the
 * wrapper's, not the subject's", so the mechanism is stated rather than assumed.
 * A `null` status (killed by a signal) is a harness failure, never a verdict.
 *
 * ── THE TREE IS ALWAYS RESTORED ──────────────────────────────────────────
 *
 * Originals are captured as raw bytes before any write and put back in a
 * `finally`, with a byte-equality assertion after each arm. A harness that could
 * leave the tree mutated would turn a crash into a silently broken repo — and
 * `git stash` is REPO-GLOBAL here, so "just stash it" is not a recovery.
 *
 * One arm mutates `lib/api/route-toolkit.ts`, which this work item does not own.
 * It is restored byte-for-byte in the same `finally` and the equality assertion
 * covers it; nothing is left behind.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSOLE_ROOT,
  DIGEST,
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
 * prints CAUGHT-shaped output over a suite that was never challenged. So before
 * any arm runs, prove the three ways `applySubstitution` must abort.
 */
function selfTest() {
  const text = readOriginal(DIGEST);
  const checks = [];

  // 1. A needle carrying the WRONG line terminator for this file.
  //
  //    Derived from the file rather than hard-coded: `core.autocrlf` is true
  //    here, so the same bytes are CRLF in a Windows tree and LF on a Linux CI
  //    checkout. A hard-coded CRLF check would pass locally and FALSELY ALARM in
  //    CI — the same class of error it exists to catch.
  const crlf = (text.match(/\r\n/g) || []).length;
  const bareLf = (text.match(/[^\r]\n/g) || []).length;
  const dominant = crlf >= bareLf ? '\r\n' : '\n';
  const wrong = dominant === '\r\n' ? '\n' : '\r\n';
  const realLine = 'export function computeContentDigest(content: GraphVersionContent): string {';
  checks.push([
    `needle with the wrong terminator aborts (file is ${dominant === '\r\n' ? 'CRLF' : 'LF'}; ` +
      'this is the landmine that silently no-ops a whole arm)',
    () =>
      applySubstitution(
        text,
        { file: DIGEST, needle: `${realLine}${wrong}  return sha256Hex`, replacement: 'X' },
        'self-test',
      ),
  ]);

  // 2. A needle that matches nothing at all.
  checks.push([
    'a stale needle aborts',
    () =>
      applySubstitution(
        text,
        { file: DIGEST, needle: 'this string is not in the file', replacement: 'X' },
        'self-test',
      ),
  ]);

  // 3. A needle that matches more than once.
  checks.push([
    'an ambiguous needle aborts',
    () => applySubstitution(text, { file: DIGEST, needle: 'const', replacement: 'X' }, 'self-test'),
  ]);

  let ok = true;
  for (const [name, fn] of checks) {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    console.log(`  ${threw ? 'PASS' : 'FAIL'}  ${name}`);
    if (!threw) ok = false;
  }

  // 4. The positive control: a real needle DOES apply and DOES change the text.
  const applied = applySubstitution(
    text,
    { file: DIGEST, needle: realLine, replacement: '// MUTATED' },
    'self-test',
  );
  const changed = applied !== text && applied.includes('// MUTATED');
  console.log(`  ${changed ? 'PASS' : 'FAIL'}  a real needle applies and changes the text`);
  if (!changed) ok = false;

  return ok;
}

function runSpec(spec) {
  const r = spawnSync(process.execPath, [VITEST_ENTRY, 'run', spec], {
    cwd: CONSOLE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '' },
  });
  const status = r.status;
  if (status === null) {
    throw new Error(
      `vitest was killed by a signal (${r.signal}) rather than exiting. That is a harness ` +
        'failure, not a verdict, and it must not be read as either RED or GREEN.',
    );
  }
  return { status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const property = argv.includes('--property') ? argv[argv.indexOf('--property') + 1] : null;

  console.log('== harness self-test ==');
  const selfOk = selfTest();
  if (!selfOk) {
    console.error('SELF-TEST FAILED — the harness cannot be trusted to have applied anything.');
    process.exit(2);
  }
  if (argv.includes('--self-test')) process.exit(0);

  const arms = MUTATIONS.filter(
    (m) => (only === null || m.id === only) && (property === null || m.property.startsWith(property)),
  );
  if (arms.length === 0) {
    console.error('No arms selected. Refusing to report success over an empty run.');
    process.exit(2);
  }

  const results = [];
  for (const m of arms) {
    console.log(`\n== ${m.id}  [${m.arm}]  ${m.property}`);
    console.log(`   what:  ${m.what}`);
    console.log(`   spec:  ${m.spec}`);
    let originals = null;
    let mutated = null;
    try {
      originals = applyMutation(m);
      mutated = runSpec(m.spec);
      console.log(`   MUTATED RC=${mutated.status}  ${mutated.status === 0 ? 'ESCAPED' : 'CAUGHT'}`);
    } finally {
      if (originals) restore(originals);
    }

    // Byte equality after restore, before the clean run — otherwise a green
    // clean run could be green because the tree was left half-mutated in a way
    // that happens not to fail.
    let restoredOk = true;
    for (const [file, text] of originals) {
      if (readFileSync(file, 'utf8') !== text) {
        console.error(`   RESTORE FAILED for ${file}`);
        restoredOk = false;
      }
    }

    const clean = runSpec(m.spec);
    console.log(`   CLEAN   RC=${clean.status}  ${clean.status === 0 ? 'GREEN' : 'RED'}`);

    const behaved = mutated.status !== 0 && clean.status === 0 && restoredOk;
    if (!behaved && mutated.status === 0) {
      // Print enough of the mutated run to diagnose an escape without dumping
      // the whole suite output.
      console.log('   --- mutated run tail ---');
      console.log(
        mutated.out
          .split('\n')
          .slice(-25)
          .map((l) => `   ${l}`)
          .join('\n'),
      );
    }
    results.push({ id: m.id, arm: m.arm, mutated: mutated.status, clean: clean.status, behaved });
  }

  console.log('\n== summary ==');
  for (const r of results) {
    console.log(
      `  ${r.behaved ? 'OK     ' : 'PROBLEM'}  ${r.id.padEnd(42)} ` +
        `mutated RC=${r.mutated}  clean RC=${r.clean}`,
    );
  }
  const bad = results.filter((r) => !r.behaved);
  console.log(`\n${results.length - bad.length}/${results.length} arms behaved.`);
  process.exit(bad.length === 0 ? 0 : 1);
}

main();
