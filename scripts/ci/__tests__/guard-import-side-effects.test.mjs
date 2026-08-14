#!/usr/bin/env node
/**
 * guard-import-side-effects — MUTATION PROOFS. (refs #3436)
 *
 * This suite imports the guard to test `classify`, which is the exact thing the
 * guard exists to make safe. If the guard were unfenced, this import would run
 * its whole scan and `process.exit`. So the suite is its own end-to-end proof.
 *
 * Run: node --test scripts/ci/__tests__/guard-import-side-effects.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../check-guard-import-side-effects.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CI_DIR = path.join(REPO_ROOT, 'scripts', 'ci');
const GUARD = path.join(CI_DIR, 'check-guard-import-side-effects.mjs');

test('importing this guard did NOT run its scan — the suite proves its own premise', () => {
  // Reaching this assertion at all is the proof: a bare `main()` would have
  // scanned and likely process.exit()'d before node:test got here.
  assert.equal(typeof classify, 'function');
});

test('classify keys on the PROPERTY, not on a fence idiom', () => {
  assert.equal(classify('function main(){}\nmain();\n').unfenced, true);
  assert.equal(classify('function main(){}\nmain()\n').unfenced, true);
  // Both fence idioms in the repo must read as fenced — the first scan written
  // for #3436 keyed on `import.meta.url` and false-positived on this one.
  assert.equal(
    classify("function main(){}\nif (process.argv[1] && process.argv[1].endsWith('x.mjs')) {\n  main();\n}\n").unfenced,
    false,
  );
  assert.equal(
    classify('function main(){}\nif (import.meta.url === `file://${process.argv[1]}`) {\n  main();\n}\n').unfenced,
    false,
  );
  // …and a file that merely MENTIONS import.meta.url while calling main() bare
  // must still be caught. That false negative hid 4 of the 7 real offenders.
  assert.equal(
    classify('const d = path.dirname(fileURLToPath(import.meta.url));\nfunction main(){}\nmain();\n').unfenced,
    true,
  );
});

test('the real tree is clean, over a population that cannot be vacuous', () => {
  const files = readdirSync(CI_DIR).filter((f) => f.startsWith('check-') && f.endsWith('.mjs'));
  assert.ok(files.length >= 50, `enumerated only ${files.length} guards — the scan is broken`);
  const bad = files.filter((f) => classify(readFileSync(path.join(CI_DIR, f), 'utf8')).unfenced);
  assert.deepEqual(bad, [], `guards running their scan on import: ${bad.join(', ')}`);
});

test('the guard is NOT vacuous — re-breaking a real file flips the verdict', () => {
  // Mutate a REAL guard on disk, run the checker as CI would, restore. Line-
  // based and CRLF-safe: a whole-block regex silently matched nothing on this
  // checkout earlier today and a harness nearly banked that as a pass.
  const victim = path.join(CI_DIR, 'check-azd-provision-param-binding.mjs');
  const original = readFileSync(victim, 'utf8');

  const run = () => {
    try {
      execFileSync(process.execPath, [GUARD], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
      return 0;
    } catch (e) {
      return e.status ?? 1;
    }
  };

  assert.equal(run(), 0, 'the tree should be clean before mutation');

  const nl = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(nl);
  const at = lines.findIndex((l) => /^\s+main\(\)\s*;?\s*$/.test(l));
  assert.ok(at >= 0, 'mutation did not apply — no fenced main() found, so this control proves nothing');
  // Strip the fence: put the call back at column 0.
  lines[at] = 'main();';
  writeFileSync(victim, lines.join(nl));

  try {
    const mutated = run();
    assert.equal(mutated, 1, 'the guard did NOT catch a re-broken file — it is blind');
  } finally {
    writeFileSync(victim, original);
  }

  assert.equal(run(), 0, 'restore failed — the tree is left dirty');
});
