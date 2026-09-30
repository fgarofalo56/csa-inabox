#!/usr/bin/env node
/**
 * Trigger contract for `.github/workflows/copilot-quality-evals.yml`
 * (operator decision 2026-09-30, "path-filter the evals").
 *
 * WHAT IS PINNED, AND WHY.
 *
 * The eval sweep scores the DEPLOYED console and the DEPLOYED evaluator image
 * (#3085: both the docs corpus and the eval sets are baked into images), so a
 * PR run measures only what it executes FROM THE CHECKOUT: the eval sets, the
 * harness scripts and the workflow itself. Every other PR run just queued a
 * 153-question sweep in the repo-wide `copilot-quality-evals-estate` group,
 * where GitHub keeps one pending run and cancels the rest at zero steps. So:
 *
 *   (a) `pull_request.paths` is EXACTLY the checkout-executed set, and every
 *       script the workflow runs (plus its local imports) is covered by it;
 *   (b) `push` to main keeps its corpus filter UNCHANGED;
 *   (c) `schedule` (and `workflow_dispatch`) are still present.
 *
 * The paths under test are LIFTED FROM THE YAML at runtime. The expected sets
 * are LITERALS on purpose: an expectation derived from the file under test
 * could not disagree with it.
 *
 * No YAML library is installed at the repo root, so the `on:` block is read
 * by a small indentation parser. Its first test is a POSITIVE CONTROL on a
 * literal fixture, so a parser that silently returns nothing reads RED there
 * rather than green everywhere else.
 *
 * Run: node --test scripts/ci/__tests__/copilot-evals-trigger-contract.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const WORKFLOW_REL = '.github/workflows/copilot-quality-evals.yml';
const WORKFLOW = join(REPO, WORKFLOW_REL);

/** (a) The checkout-executed set. Adding `docs/**` back, or dropping any entry, breaks it. */
const EXPECTED_PR_PATHS = [
  'content/evals/**',
  'scripts/csa-loom/stage-copilot-corpus.sh',
  'scripts/csa-loom/lint-eval-sets.mjs',
  'scripts/csa-loom/check-eval-regression.mjs',
  'scripts/csa-loom/eval-regression-lib.mjs',
  'scripts/ci/reindex-loom-docs.sh',
  'scripts/ci/parse-reindex-poll.mjs',
  'scripts/ci/classify-reindex-result.mjs',
  'scripts/ci/redact-secrets.mjs',
  'scripts/ci/run-outcome.mjs',
  '.github/workflows/copilot-quality-evals.yml',
];

/** (b) The push filter as it stood before this change (origin/main 1499db9b3). Any edit breaks it. */
const EXPECTED_PUSH_PATHS = [
  'docs/**',
  'PRPs/active/**',
  'PRPs/completed/csa-loom-pillar/**',
  'content/evals/**',
  'scripts/csa-loom/stage-copilot-corpus.sh',
  '.github/workflows/copilot-quality-evals.yml',
];

/** The five scripts the run steps name directly (positive control for the lift); the sixth harness script, classify-reindex-result.mjs, is reached via reindex-loom-docs.sh. */
const EXPECTED_DIRECT_SCRIPTS = [
  'scripts/csa-loom/stage-copilot-corpus.sh',
  'scripts/csa-loom/lint-eval-sets.mjs',
  'scripts/ci/reindex-loom-docs.sh',
  'scripts/csa-loom/check-eval-regression.mjs',
  'scripts/ci/run-outcome.mjs',
];

const sorted = (xs) => [...xs].sort();
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * Parse the top-level `on:` block into { trigger: { branches, paths, cron, present } }.
 * Indentation-based: triggers at 2 spaces, their keys at 4, list items deeper.
 * Comment and blank lines are skipped.
 */
function parseOnBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^on:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  const triggers = {};
  let trigger = null;
  let key = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && !/^#/.test(line)) break; // next top-level key ends `on:`
    if (/^\s*(#.*)?$/.test(line)) continue;
    let m;
    if ((m = /^ {2}([A-Za-z_]+):\s*(.*)$/.exec(line))) {
      trigger = m[1];
      key = null;
      triggers[trigger] = { present: true, branches: undefined, paths: undefined, cron: [] };
      continue;
    }
    if (!trigger) continue;
    if ((m = /^ {4}([A-Za-z_-]+):\s*(.*)$/.exec(line))) {
      key = m[1];
      const inline = m[2].replace(/\s+#.*$/, '').trim();
      if (key === 'branches' && /^\[.*\]$/.test(inline)) {
        triggers[trigger].branches = inline.slice(1, -1).split(',').map(unquote).filter(Boolean);
      } else if (key === 'paths' || key === 'branches') {
        triggers[trigger][key] = [];
      }
      continue;
    }
    if ((m = /^ {4,}-\s+(.*)$/.exec(line))) {
      const item = m[1].replace(/\s+#.*$/, '');
      if (trigger === 'schedule') {
        const c = /cron:\s*(.*)$/.exec(item);
        if (c) triggers.schedule.cron.push(unquote(c[1]));
      } else if (key === 'paths' || key === 'branches') {
        triggers[trigger][key].push(unquote(item));
      }
    }
  }
  return triggers;
}

/** Exact match, or a `dir/**` glob prefix. */
function isCovered(file, paths) {
  return paths.some((p) => (p.endsWith('/**') ? file.startsWith(p.slice(0, -2)) : p === file));
}

/** Scripts a non-comment line of the workflow runs with `node` / `bash`. */
function liftExecutedScripts(text) {
  const found = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(/\b(?:node|bash)\s+(scripts\/[\w./-]+\.(?:mjs|sh|js))/g)) found.add(m[1]);
  }
  return [...found];
}

/**
 * Local files a script pulls in: `from './x.mjs'` / `import('./x.mjs')` for
 * modules, `"$HERE/x.mjs"` for the shell scripts (reindex-loom-docs.sh's
 * idiom). Followed transitively. Bare-specifier (npm) imports are not files in
 * this repo and are not followed.
 */
function localDeps(rel, seen = new Set()) {
  if (seen.has(rel)) return seen;
  seen.add(rel);
  const abs = join(REPO, rel);
  if (!existsSync(abs)) return seen;
  const src = readFileSync(abs, 'utf8');
  const dir = posix.dirname(rel);
  const refs = [
    ...[...src.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/"\$HERE\/([^"$]+)"/g)].map((m) => `./${m[1]}`),
  ];
  for (const r of refs) localDeps(posix.normalize(posix.join(dir, r)), seen);
  return seen;
}

const TEXT = readFileSync(WORKFLOW, 'utf8');
const ON = parseOnBlock(TEXT);

test('parser positive control: a literal fixture parses to its known values', () => {
  // Breaks if the parser drops quoted items, mis-reads a flow-style branch
  // list, loses a trigger, or picks a list item up under the wrong key.
  const fixture = [
    'name: x',
    'on:',
    '  push:',
    '    branches: [main]',
    '    paths:',
    "      - 'a/**'",
    '      # a comment between items',
    '      - "b.sh"',
    '  pull_request:',
    '    branches: [main]',
    '    paths:',
    "      - 'c.mjs'",
    '  schedule:',
    "    - cron: '1 2 * * *'",
    '  workflow_dispatch:',
    '    inputs:',
    '      region:',
    '        default: centralus',
    'jobs: {}',
  ].join('\n');
  const got = parseOnBlock(fixture);
  assert.deepEqual(got.push.branches, ['main']);
  assert.deepEqual(got.push.paths, ['a/**', 'b.sh']);
  assert.deepEqual(got.pull_request.paths, ['c.mjs']);
  assert.deepEqual(got.schedule.cron, ['1 2 * * *']);
  assert.equal(got.workflow_dispatch.present, true);
  assert.equal(got.workflow_dispatch.paths, undefined, 'dispatch inputs must not be read as paths');
});

test('(a) pull_request.paths is EXACTLY the checkout-executed set', () => {
  // Breaks on: `docs/**` or `PRPs/active/**` added back; any harness script or
  // helper dropped; the `paths:` key deleted (-> undefined, i.e. every PR runs).
  assert.ok(ON?.pull_request, `${WORKFLOW_REL} has no pull_request trigger`);
  assert.deepEqual(ON.pull_request.branches, ['main']);
  assert.ok(Array.isArray(ON.pull_request.paths), 'pull_request has NO paths filter — every PR would queue a sweep');
  assert.deepEqual(sorted(ON.pull_request.paths), sorted(EXPECTED_PR_PATHS));
});

test('(a) every non-glob PR path names a file that exists', () => {
  // Breaks on a typo or a rename: a filter entry naming a missing file never
  // matches, so edits to the real file would silently stop triggering a run.
  for (const p of ON.pull_request.paths) {
    if (p.endsWith('/**')) {
      const d = join(REPO, p.slice(0, -3));
      assert.ok(existsSync(d) && statSync(d).isDirectory(), `glob root ${p} is not a directory`);
    } else {
      assert.ok(existsSync(join(REPO, p)), `PR filter names ${p}, which does not exist`);
    }
  }
});

test('(a) every script the workflow executes, and its local imports, is in the PR filter', () => {
  // The seam check. Breaks when a run step gains `node scripts/.../new.mjs`,
  // or a harness script gains a `./helper.mjs` import, without the filter
  // following -- the helper could then change a PR run's behaviour unevaluated.
  const direct = liftExecutedScripts(TEXT);
  // Positive control on the lift itself: a regex that matched nothing would
  // make the coverage loop below vacuously green.
  for (const s of EXPECTED_DIRECT_SCRIPTS) {
    assert.ok(direct.includes(s), `lift missed ${s} (lifted: ${direct.join(', ')})`);
  }
  const all = new Set();
  for (const s of direct) for (const d of localDeps(s)) all.add(d);
  // Positive control on dependency following: these three are reached ONLY
  // through imports, never named in a run step.
  for (const s of ['scripts/ci/redact-secrets.mjs', 'scripts/ci/parse-reindex-poll.mjs', 'scripts/csa-loom/eval-regression-lib.mjs']) {
    assert.ok(all.has(s), `dependency walk missed ${s}`);
  }
  const uncovered = [...all].filter((f) => !isCovered(f, ON.pull_request.paths));
  assert.deepEqual(uncovered, [], `executed from the checkout but not in pull_request.paths: ${uncovered.join(', ')}`);
});

test('(b) push to main keeps its corpus filter UNCHANGED', () => {
  // Breaks on any add/remove in push.paths, on deleting the key (-> undefined,
  // i.e. every main push queues a sweep), or on widening branches past main.
  assert.ok(ON?.push, 'push trigger removed');
  assert.deepEqual(ON.push.branches, ['main']);
  assert.ok(Array.isArray(ON.push.paths), 'push lost its paths filter');
  assert.deepEqual(sorted(ON.push.paths), sorted(EXPECTED_PUSH_PATHS));
});

test('(c) the nightly schedule and workflow_dispatch are still present', () => {
  // Breaks on deleting `schedule:` (cron list becomes absent) or changing the
  // cron, and on deleting `workflow_dispatch:`.
  assert.ok(ON?.schedule, 'schedule trigger removed');
  assert.deepEqual(ON.schedule.cron, ['30 8 * * *']);
  assert.equal(ON.workflow_dispatch?.present, true, 'workflow_dispatch removed');
});
