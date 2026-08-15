#!/usr/bin/env node
/**
 * check-python-deps-resolve-coverage.mjs
 *
 * RULE. Every tracked `requirements.txt` that python-deps-resolve.yml's OWN
 * trigger globs match must be either in that workflow's `resolve` matrix, or
 * declared — with a reason — in python-deps-resolve-exclusions.json.
 *
 * WHY. The workflow triggers on `**\/requirements.txt` and resolved a
 * hand-listed subset. Measured 2026-08-15: 21 tracked files matched the
 * trigger, 7 were in the matrix. So a PR whose only change was one of the other
 * 14 got a PASSING "resolve" check that had resolved seven unrelated files.
 * That verdict is indistinguishable from a real pass — the gate was keyed to
 * the wrong population.
 *
 * The worst of the 14 was `portal/shared/requirements.txt`, which is what the
 * SHIPPED portal-backend image installs
 * (portal/kubernetes/docker/backend/Dockerfile:19) — the single most
 * consequential pin set in the repo for image contents, and the one the resolve
 * gate did not cover (#3486).
 *
 * This is the INVERSE of check-build-trigger-covers-matrix.mjs, which asserts
 * every matrix entry is reachable by the trigger. This one asserts every file
 * the trigger REACHES is actually judged. Both directions are needed: the first
 * catches work that never runs, this one catches a verdict about nothing.
 *
 * Both sets are machine-readable, so the drift is checkable rather than
 * reviewable — and it WILL recur otherwise, the next time anyone adds a
 * requirements.txt anywhere in the tree.
 *
 * SELF-DEFENCE. Fails if the workflow cannot be read, if the trigger globs or
 * the matrix come back EMPTY, if a matrix entry names a file that does not
 * exist, or if an exclusion is stale (path gone, or also in the matrix). A rule
 * that can no longer read what it judges must not report a pass.
 *
 * CONTROL. `--self-test` runs the detector against embedded fixtures — a
 * workflow with a known drift (must FAIL) and one without (must PASS) — so a
 * clean scan is evidence that the rule can still fail, not just that it ran.
 *
 * MODE:
 *   node scripts/ci/check-python-deps-resolve-coverage.mjs
 *   node scripts/ci/check-python-deps-resolve-coverage.mjs --self-test
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const WF_REL = '.github/workflows/python-deps-resolve.yml';
const EXCLUSIONS_REL = 'scripts/ci/python-deps-resolve-exclusions.json';

/**
 * Compile ONE GitHub Actions path filter to a RegExp.
 *
 * `**` crosses `/`, `*` does not. `**\/` is treated as "zero or more path
 * segments" so a top-level `requirements.txt` is covered by `**\/requirements.txt`
 * — the SUPERSET reading. Under-matching here would shrink the population this
 * rule judges and hand back a pass it did not earn, which is the exact failure
 * class the rule exists to catch.
 */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` -> zero or more segments; a bare `**` -> anything incl. `/`.
        if (glob[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2; } else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * The `paths:` lists under `on: pull_request:` and `on: push:`, scanned by
 * INDENTATION rather than one regex — the technique
 * check-build-trigger-covers-matrix.mjs settled on, because these lists are
 * interleaved with comments and a lazy match stops at the first one and reports
 * "no path filter" on a healthy workflow.
 *
 * PHYSICAL-LINES-OK: parses a YAML LIST by indentation. YAML sequence items are
 * not spliced by a trailing backslash (#3420).
 */
export function readTriggerGlobs(text) {
  const lines = text.split(/\r?\n/);
  const globs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s{4}paths:\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (/^\s*#/.test(raw)) continue;
      if (raw.trim() === '') continue;
      const m = /^\s{6,}-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(raw);
      if (!m) break; // dedented -> end of the list
      globs.push(m[1]);
    }
  }
  return [...new Set(globs)];
}

/** Every `req:` value in the resolve job's matrix. */
export function readMatrixReqs(text) {
  const reqs = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s+req:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (m) reqs.push(m[1]);
  }
  return reqs;
}

/**
 * The population: tracked files named `requirements.txt` that at least one
 * trigger glob matches. Keyed off the TRIGGER, not off a second hand-list —
 * re-declaring the population is how the first list drifted.
 */
export function population(files, globs) {
  const res = globs.map(globToRegExp);
  return files.filter((f) => /(^|\/)requirements\.txt$/.test(f) && res.some((re) => re.test(f)));
}

/** The rule itself, pure over its inputs so the self-test drives the real code. */
export function analyze({ text, files, exclusions, fileExists }) {
  const failures = [];
  const globs = readTriggerGlobs(text);
  const reqs = readMatrixReqs(text);

  if (globs.length === 0) {
    failures.push(
      'found NO trigger path filter in the workflow. Either the trigger was removed (nothing resolves on a PR) '
      + 'or this rule can no longer read it. Refusing to report a pass.',
    );
    return { failures, globs, reqs, pop: [], excluded: [] };
  }
  if (reqs.length === 0) {
    failures.push(
      'found NO `req:` entries in the resolve matrix. The workflow would run and check nothing. '
      + 'Refusing to report a pass.',
    );
    return { failures, globs, reqs, pop: [], excluded: [] };
  }

  const pop = population(files, globs);
  if (pop.length === 0) {
    failures.push(
      `the trigger globs (${globs.join(', ')}) match NO tracked requirements.txt. A rule with an empty `
      + 'population cannot fail, so it must not pass.',
    );
    return { failures, globs, reqs, pop, excluded: [] };
  }

  const inMatrix = new Set(reqs);
  const excluded = Object.keys(exclusions);

  // 1. Every triggered file is judged, or declared.
  for (const f of pop) {
    if (inMatrix.has(f)) continue;
    if (Object.hasOwn(exclusions, f)) continue;
    failures.push(
      `${f}: matches this workflow's trigger but is in NEITHER the resolve matrix NOR ${EXCLUSIONS_REL}. `
      + 'A PR changing only this file would get a PASSING resolve check that resolved other files. Add it to the '
      + 'matrix, or declare it with a measured reason.',
    );
  }

  // 2. The matrix cannot name a file that is not there.
  for (const r of reqs) {
    if (!fileExists(r)) {
      failures.push(`${r}: in the resolve matrix but does not exist. The job would fail on every run — drop the row.`);
    }
  }

  // 3. Exclusions stay exact in BOTH directions, so the list cannot rot.
  for (const [f, reason] of Object.entries(exclusions)) {
    if (!fileExists(f)) {
      failures.push(`${f}: declared in ${EXCLUSIONS_REL} but does not exist — remove the entry (the gap is closed).`);
    }
    if (inMatrix.has(f)) {
      failures.push(
        `${f}: declared as EXCLUDED and also present in the resolve matrix. It is checked — remove the exclusion.`,
      );
    }
    if (typeof reason !== 'string' || reason.trim().length < 40) {
      failures.push(
        `${f}: its exclusion reason is missing or too short to be a reason. An entry here means the file is `
        + 'UNCHECKED at PR time; say why, measured.',
      );
    }
    if (!pop.includes(f)) {
      failures.push(
        `${f}: declared in ${EXCLUSIONS_REL} but no trigger glob matches it, so it was never in scope. `
        + 'Remove the entry — a stale exclusion hides the next real one.',
      );
    }
  }

  return { failures, globs, reqs, pop, excluded };
}

// ── the embedded control ─────────────────────────────────────────────────────
const FIXTURE_CLEAN = [
  'on:',
  '  pull_request:',
  '    paths:',
  "      - '**/requirements.txt'",
  'jobs:',
  '  resolve:',
  '    strategy:',
  '      matrix:',
  '        include:',
  '          - app: a',
  '            req: apps/a/requirements.txt',
].join('\n');

const FIXTURE_DRIFTED = FIXTURE_CLEAN.replace(
  '            req: apps/a/requirements.txt',
  '            req: apps/b/requirements.txt',
);

function selfTest() {
  const files = ['apps/a/requirements.txt', 'apps/b/requirements.txt'];
  const exists = (p) => files.includes(p);
  const cases = [];

  // The known-violating fixture: apps/b is in the matrix, apps/a triggers and is
  // covered by nothing. The rule MUST see it.
  const drifted = analyze({ text: FIXTURE_DRIFTED, files, exclusions: {}, fileExists: exists });
  cases.push([
    'a triggered file covered by nothing FAILS',
    drifted.failures.some((f) => f.startsWith('apps/a/requirements.txt:')),
  ]);

  // …and the clean fixture must PASS, or the rule is just always-red.
  const clean = analyze({
    text: FIXTURE_CLEAN,
    files: ['apps/a/requirements.txt'],
    exclusions: {},
    fileExists: (p) => p === 'apps/a/requirements.txt',
  });
  cases.push(['a matrix that covers its trigger PASSES', clean.failures.length === 0]);

  // An empty matrix and an empty trigger must both refuse to pass.
  cases.push([
    'an empty matrix refuses to pass',
    analyze({ text: FIXTURE_CLEAN.split('          - app: a')[0], files, exclusions: {}, fileExists: exists })
      .failures.length > 0,
  ]);
  cases.push([
    'an empty trigger refuses to pass',
    analyze({ text: FIXTURE_CLEAN.replace("      - '**/requirements.txt'", ''), files, exclusions: {}, fileExists: exists })
      .failures.length > 0,
  ]);

  // A stale exclusion (file gone) must fail.
  cases.push([
    'a stale exclusion fails',
    analyze({
      text: FIXTURE_CLEAN,
      files: ['apps/a/requirements.txt'],
      exclusions: { 'apps/gone/requirements.txt': 'x'.repeat(50) },
      fileExists: (p) => p === 'apps/a/requirements.txt',
    }).failures.some((f) => f.startsWith('apps/gone/requirements.txt:')),
  ]);

  // An exclusion with no real reason must fail.
  cases.push([
    'an unreasoned exclusion fails',
    analyze({ text: FIXTURE_DRIFTED, files, exclusions: { 'apps/a/requirements.txt': 'because' }, fileExists: exists })
      .failures.some((f) => f.includes('too short to be a reason')),
  ]);

  const failed = cases.filter(([, ok]) => !ok);
  for (const [name, ok] of cases) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (failed.length > 0) {
    console.error(
      `::error::check-python-deps-resolve-coverage self-test FAILED (${failed.length} case(s)). The detector cannot `
      + 'see its own known-violating fixture, so a clean scan proves NOTHING.',
    );
    process.exit(1);
  }
  console.log('check-python-deps-resolve-coverage self-test passed.');
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  let text;
  try {
    text = readFileSync(join(ROOT, WF_REL), 'utf8');
  } catch (e) {
    console.error(`::error::python-deps-resolve-coverage: cannot read ${WF_REL}: ${e.message}`);
    process.exit(1);
  }

  let exclusions;
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, EXCLUSIONS_REL), 'utf8'));
    exclusions = raw.entries;
    if (exclusions == null || typeof exclusions !== 'object') throw new Error('no `entries` object');
  } catch (e) {
    console.error(`::error::python-deps-resolve-coverage: cannot read ${EXCLUSIONS_REL}: ${e.message}`);
    process.exit(1);
  }

  let files;
  try {
    files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (e) {
    console.error(`::error::python-deps-resolve-coverage: \`git ls-files\` failed: ${e.message}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error('::error::python-deps-resolve-coverage: `git ls-files` returned nothing. Refusing to report a pass.');
    process.exit(1);
  }

  const { failures, globs, pop, excluded } = analyze({
    text,
    files,
    exclusions,
    fileExists: (p) => existsSync(join(ROOT, p)),
  });

  if (failures.length > 0) {
    console.error(
      `::error::python-deps-resolve-coverage: ${failures.length} problem(s). The set of requirements.txt files that `
      + 'TRIGGER python-deps-resolve.yml and the set it actually RESOLVES do not agree, so at least one file can '
      + 'produce a green resolve check without having been resolved.',
    );
    for (const f of failures) console.error(`::error file=${WF_REL}::${f}`);
    process.exit(1);
  }

  // The declared gaps are printed on a PASSING run — an exclusion that is only
  // visible on failure is a silent exclusion.
  console.log(
    `python-deps-resolve-coverage OK — ${pop.length} tracked requirements.txt matched by ${globs.length} trigger `
    + `glob(s); ${pop.length - excluded.length} resolved by the matrix, ${excluded.length} declared.`,
  );
  for (const f of excluded) console.log(`  DECLARED, NOT RESOLVED: ${f}`);
}

// Run as a script, not as an import side effect (#3436). Without this,
// `import`ing this module to unit-test its helpers runs the WHOLE scan and can
// process.exit() inside the test runner — which surfaces as a runner that dies
// with no failed assertion, the same non-diagnostic shape as a `set -u` abort.
if (process.argv[1] && process.argv[1].endsWith('check-python-deps-resolve-coverage.mjs')) {
  main();
}
