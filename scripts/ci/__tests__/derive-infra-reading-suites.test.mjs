/*
 * #3819 item 2 — THE DERIVER THAT DECIDES WHETHER VITEST RUNS HAS NO TEST.
 *
 * `scripts/ci/derive-infra-reading-suites.mjs` produces two things that
 * `fiab-console-ci.yml` acts on directly:
 *
 *   --ere      the extended regex the change-detection step matches changed
 *              paths against. A directory missing from it means a PR touching
 *              only that directory matches NEITHER branch, vitest — a REQUIRED
 *              check and the roll gate — concludes success having executed zero
 *              tests, and `loom-roll-and-validate` rolls that SHA. That is #3783
 *              verbatim.
 *   --suites   the subset of console suites the infra lane runs.
 *
 * Every control INSIDE that script (SENTINEL, MIN_SUITES, REQUIRED_TRIGGER_DIRS,
 * the INCLUDE mirror) is an assertion the script makes about itself, and each was
 * added after a mutation walked past the previous one. Nothing asserted them from
 * OUTSIDE — so a control could be weakened, or deleted, and the only thing that
 * would notice is the control being weakened.
 *
 * This suite is that outside view. It SPAWNS the deriver rather than importing it
 * (the module calls `main()` at load, so importing it would run it), and it pins
 * the four things #3819 named: `escape()`, the `INCLUDE` mirror, the `--ere`
 * shape, and `REQUIRED_TRIGGER_DIRS`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not pin the derived suite COUNT or
 * the emitted directory LIST. Both move whenever a suite is added or a top-level
 * directory appears, neither movement is a defect, and a test that went red on
 * ordinary churn would be edited to match rather than read. What is pinned is
 * SHAPE, the floor's DIRECTION (it may rise, never fall), and the presence of
 * each deploy-chain directory.
 *
 * Run: node --test scripts/ci/__tests__/derive-infra-reading-suites.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'derive-infra-reading-suites.mjs');
const SRC = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');

/** Run the deriver and hand back the raw result — nothing is discarded. */
function derive(mode) {
  const r = spawnSync(process.execPath, [SCRIPT, mode], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.error, undefined, `spawning the deriver failed: ${r.error?.message}`);
  return { rc: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** A module-level `const NAME = [ … ];` array of string literals, from source. */
function sourceStringArray(name) {
  const m = new RegExp(`\\bconst ${name} = \\[([\\s\\S]*?)\\];`).exec(SRC);
  assert.ok(m, `${name} was renamed or is no longer a literal array — this suite lost its subject`);
  return [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
}

// ── escape() ────────────────────────────────────────────────────────────────

test('#3819 — escape() escapes EVERY regex metacharacter, not the ones in today\'s tree', () => {
  // `OUTSIDE` is DERIVED from `git ls-tree`, so a directory named with `+`, `(`
  // or `\` enters the emitted ERE the moment someone adds it — with no edit to
  // the deriver and no review of this line. An unescaped metacharacter turns a
  // literal into a pattern and silently changes which paths the trigger matches.
  const m = /const escape = \(dir\) => dir\.replace\((\/[^/]+\/g), '\\\\\$&'\);/.exec(SRC);
  assert.ok(m, 'escape() was rewritten — re-point this control rather than deleting it');
  // eslint-disable-next-line no-new-func -- the literal is read from the file under test, not from input
  const escape = new Function('dir', `return dir.replace(${m[1]}, '\\\\$&');`);

  for (const ch of ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']) {
    assert.equal(escape(ch), `\\${ch}`, `escape() left \`${ch}\` unescaped — it stays a metacharacter in the ERE`);
  }
  assert.equal(escape('azure-functions'), 'azure-functions', 'escape() mangled an ordinary directory name');
  assert.equal(escape('.github'), '\\.github', 'a leading dot is no longer escaped');

  // BEHAVIOURAL, because "the string has backslashes in it" is not the property
  // that matters: the escaped name must match ITSELF and nothing else.
  const ere = new RegExp(`^(${['a+b', 'x.y'].map((d) => escape(d)).join('|')})/`);
  assert.ok(ere.test('a+b/f'), 'the escaped literal no longer matches itself');
  assert.ok(ere.test('x.y/f'), 'the escaped literal no longer matches itself');
  assert.equal(ere.test('ab/f'), false, '`+` was left as a quantifier — the trigger matches a directory that does not exist');
  assert.equal(ere.test('aab/f'), false, '`+` was left as a quantifier');
  assert.equal(ere.test('xzy/f'), false, '`.` was left as a wildcard');
});

// ── the INCLUDE mirror ──────────────────────────────────────────────────────

test('#3819 — INCLUDE mirrors vitest.config.ts, and each arm actually selects its own files', () => {
  const config = fs.readFileSync(path.join(ROOT, 'apps', 'fiab-console', 'vitest.config.ts'), 'utf8');
  const expected = sourceStringArray('EXPECTED_VITEST_INCLUDE');
  assert.ok(expected.length >= 1, 'EXPECTED_VITEST_INCLUDE is empty — the mirror has nothing to compare');

  // The deriver compares these at runtime and refuses to emit on a mismatch.
  // Asserting it HERE names the config as the thing that moved, in a test that
  // runs on every PR rather than only when the deriver happens to be invoked.
  for (const glob of expected) {
    assert.ok(
      config.includes(`'${glob}'`) || config.includes(`"${glob}"`),
      `EXPECTED_VITEST_INCLUDE carries \`${glob}\`, which is no longer in vitest.config.ts — ` +
        'the mirror has drifted, which is exactly how the deriver came to select 1548 files ' +
        'out of the 1551 vitest runs (#3819/#3806).',
    );
  }

  // The regexes themselves, per arm. The runtime floor (MIN_VITEST_INCLUDED)
  // cannot see a SMALL arm being dropped — the console-root arm is 16 files
  // against a floor of 1400 — so each arm gets a positive and a negative here.
  const arms = /const INCLUDE = \[([\s\S]*?)\];/.exec(SRC);
  assert.ok(arms, 'INCLUDE was renamed or is no longer a literal array');
  const res = [...arms[1].matchAll(/\/(\^[^\n]*?)\/[a-z]*,/g)].map((x) => new RegExp(x[1]));
  assert.equal(res.length, 3, `expected 3 INCLUDE arms, found ${res.length}`);
  const hits = (p) => res.filter((r) => r.test(p)).length;
  assert.equal(hits('lib/deploy/__tests__/a.test.ts'), 1, 'the lib arm stopped matching a nested lib suite');
  assert.equal(hits('lib/__tests__/a.test.ts'), 1, 'the lib arm stopped matching a top-level lib suite');
  assert.equal(hits('app/api/__tests__/a.test.tsx'), 1, 'the app arm stopped matching');
  assert.equal(hits('__tests__/a.test.ts'), 1, 'the console-ROOT arm stopped matching — 16 files, invisible to the 1400 floor');
  assert.equal(hits('lib/deploy/a.test.ts'), 0, 'a suite outside a __tests__ directory is now selected');
  assert.equal(hits('lib/__tests__/a.ts'), 0, 'a non-test file inside __tests__ is now selected');
});

// ── the --ere shape ─────────────────────────────────────────────────────────

test('#3819 — --ere emits ONE anchored alternation, sorted and unique', () => {
  const { rc, out, err } = derive('--ere');
  assert.equal(rc, 0, `the deriver refused to emit: ${err}`);
  assert.equal(err, '', 'the deriver wrote to stderr on a clean tree');

  const lines = out.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1, `--ere emitted ${lines.length} lines; the workflow consumes exactly one`);
  const m = /^\^\((.+)\)\/$/.exec(lines[0]);
  assert.ok(m, `--ere shape changed: ${JSON.stringify(lines[0])}. fiab-console-ci.yml feeds this straight to \`grep -qE\`.`);

  const dirs = m[1].split('|');
  assert.ok(dirs.length >= 8, `only ${dirs.length} directories in the trigger — the deriver narrowed`);
  assert.deepEqual([...new Set(dirs)], dirs, 'the emitted alternation carries a duplicate');
  const unescaped = dirs.map((d) => d.replace(/\\(.)/g, '$1'));
  assert.deepEqual([...unescaped].sort(), unescaped, 'the emitted alternation is no longer sorted — the output is not stable across runs');

  // BEHAVIOURAL: the string is actually usable as the regex the workflow treats
  // it as, and it does NOT swallow the console (which has its own branch first).
  const ere = new RegExp(lines[0]);
  for (const d of unescaped) {
    assert.ok(ere.test(`${d}/x`), `the emitted ERE does not match a path in its own directory \`${d}\``);
  }
  assert.equal(ere.test('apps/fiab-console/lib/x.ts'), false, 'the infra trigger now matches the console — every console PR takes the infra branch');
  assert.equal(ere.test('README.md'), false, 'the infra trigger matches a repo-root file');
});

// ── REQUIRED_TRIGGER_DIRS ───────────────────────────────────────────────────

test('#3819 — every deploy-chain directory is in the emitted trigger, and the control that says so still exists', () => {
  const required = sourceStringArray('REQUIRED_TRIGGER_DIRS');
  // A floor, and the four members are the deploy chain. Shrinking this list is
  // the mutation the list exists to catch, so the list's own SIZE is pinned
  // from outside it.
  assert.ok(required.length >= 4, `REQUIRED_TRIGGER_DIRS shrank to ${required.length} entries: ${required.join(', ')}`);
  for (const d of ['.github', 'azure-functions', 'platform', 'scripts']) {
    assert.ok(required.includes(d), `REQUIRED_TRIGGER_DIRS no longer requires \`${d}\` in the emitted trigger`);
  }

  const { rc, out } = derive('--ere');
  assert.equal(rc, 0);
  const ere = new RegExp(out.trim());
  for (const d of required) {
    assert.ok(
      ere.test(`${d}/x`),
      `the emitted trigger does not match \`${d}/\`. A PR touching only that directory matches ` +
        'NEITHER branch of the change detection and vitest concludes success having run zero ' +
        'tests (#3783).',
    );
  }

  // …and the runtime control is still THERE. Its subject is a set that happens
  // to be complete today, so it has a zero population and would report clean if
  // it were deleted outright.
  assert.match(SRC, /const missing = REQUIRED_TRIGGER_DIRS\.filter\(/, 'the required-directory control was removed');
  assert.match(SRC, /if \(missing\.length\) \{[\s\S]{0,900}?process\.exit\(1\);/, 'the required-directory control no longer fails closed');
});

// ── the floor, and the fail-closed modes ────────────────────────────────────

test('#3819 — MIN_SUITES may RISE, never fall, and the real count clears it', () => {
  const m = /const MIN_SUITES = (\d+);/.exec(SRC);
  assert.ok(m, 'MIN_SUITES was renamed or is no longer a literal');
  const floor = Number(m[1]);
  // The #3819 finding was a floor of 12 against a measured 41 — "a floor that
  // far below reality is decoration". 38 is the reviewed value; lowering it is
  // the regression, and lowering it to make a red run pass is the specific one.
  assert.ok(floor >= 38, `MIN_SUITES was lowered to ${floor}. Below 38 the measured '.claude'-drop mutation (35 suites) passes again.`);

  const { rc, out, err } = derive('--suites');
  assert.equal(rc, 0, `the deriver refused to emit: ${err}`);
  const suites = out.split('\n').filter((l) => l !== '');
  assert.ok(suites.length >= floor, `the deriver emitted ${suites.length} suites, below its own floor of ${floor}`);
  assert.deepEqual([...new Set(suites)], suites, 'the emitted suite list carries a duplicate');
  assert.deepEqual([...suites].sort(), suites, 'the emitted suite list is no longer sorted');
  for (const s of suites) {
    assert.match(s, /\.test\.tsx?$/, `\`${s}\` is not a vitest suite — the workflow passes these straight to vitest`);
  }
});

test('#3819 — an unknown mode FAILS and emits nothing', () => {
  // The direction that matters: a typo in the workflow must not produce an empty
  // trigger that quietly matches nothing. Exit non-zero, stdout empty.
  const { rc, out, err } = derive('--not-a-mode');
  assert.notEqual(rc, 0, 'an unknown mode exited 0 — the workflow would consume empty output as a trigger');
  assert.equal(out, '', 'an unknown mode wrote to stdout');
  assert.match(err, /unknown mode/, 'the refusal does not say what was wrong');
});
