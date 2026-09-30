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
 *       file the workflow executes (plus what those files load) is covered;
 *   (b) `push` to main keeps its corpus filter UNCHANGED;
 *   (c) `schedule` (and `workflow_dispatch`) are still present;
 *   (d) the two checks a docs/PRPs-only PR used to get from this workflow
 *       (the corpus stager and the eval-set lint, both of which READ docs/ and
 *       PRPs/) run on EVERY pull_request in loom-guardrails.yml instead.
 *
 * The paths under test are LIFTED FROM THE YAML at runtime. The expected sets
 * are LITERALS on purpose: an expectation derived from the file under test
 * could not disagree with it.
 *
 * WHAT THE (a) SEAM CHECK DETECTS -- exactly these forms, each with a fixture
 * positive control below and a sandbox mutation arm in the PR:
 *   in the workflow (outside `on:`, on non-comment lines), any relative path
 *   with a directory part and a .mjs/.cjs/.js/.sh/.py/.ps1 extension,
 *   WHATEVER launches it: `node scripts/x.mjs`, `node ./scripts/x.mjs`,
 *   `node --flag scripts/x.mjs`, `python scripts/x.py`, `./scripts/x.sh`,
 *   `"$GITHUB_WORKSPACE/scripts/x.mjs"`, `"${{ github.workspace }}/scripts/…"`;
 *   a local `uses: ./path` (action dir or reusable workflow), whose own file is
 *   lifted the same way;
 *   in a JS file: `from './x'`, side-effect `import './x'`, `import('./x')`,
 *   `require('./x')`, plus any repo-relative path token on a non-comment line;
 *   in a shell file: any path under a variable assigned from the script's own
 *   dirname (`$(dirname "$0")`, `$(dirname "${BASH_SOURCE[0]}")`,
 *   `${BASH_SOURCE%/*}`, with a `/../..` suffix resolved), the same dirname
 *   expressions used inline (so `. "$(dirname "$0")/lib.sh"` and
 *   `source "$HERE/lib.sh"` are both seen), plus any repo-relative path token
 *   on a non-comment line.
 * Deliberately conservative: a non-comment MENTION of such a path counts as an
 * execution, so the failure mode is a false red, never a false green.
 *
 * WHAT IT DOES NOT DETECT (not witnessed -- do not read a green run as
 * covering these): a path assembled from a variable that is not a dirname of
 * the script (`S=scripts/ci; node $S/x.mjs`); a bare filename run after `cd` or
 * under `working-directory:`; Python `import` and PowerShell dot-sourcing
 * inside a lifted .py/.ps1; computed JS specifiers (`new URL(...)`,
 * `path.join(__dirname, ...)`); and DATA files a script reads (other than the
 * content/evals/** glob, which the filter covers wholesale).
 *
 * No YAML library is installed at the repo root, so the workflows are read by
 * small indentation parsers. Each has a POSITIVE CONTROL on a literal fixture,
 * so a parser that silently returns nothing reads RED there rather than green
 * everywhere else.
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
const GUARDRAILS_REL = '.github/workflows/loom-guardrails.yml';

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

/** (d) The exact command lines loom-guardrails.yml must run. */
const STAGE_CMD = 'bash scripts/csa-loom/stage-copilot-corpus.sh';
const LINT_CMD = 'node scripts/csa-loom/lint-eval-sets.mjs';

const SCRIPT_EXT = 'mjs|cjs|js|sh|py|ps1';
const sorted = (xs) => [...xs].sort();
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
const isComment = (line) => /^\s*#/.test(line);
const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Parse the top-level `on:` block into
 * { trigger: { present, keys, branches, paths, cron } }.
 * Indentation-based: triggers at 2 spaces, their keys at 4, list items deeper.
 * Comment and blank lines are skipped. Also returns the block's line range so
 * the lift can skip it.
 */
function parseOnBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^on:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  const triggers = {};
  let trigger = null;
  let key = null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && !/^#/.test(line)) { end = i; break; } // next top-level key ends `on:`
    if (/^\s*(#.*)?$/.test(line)) continue;
    let m;
    if ((m = /^ {2}([A-Za-z_]+):\s*(.*)$/.exec(line))) {
      trigger = m[1];
      key = null;
      triggers[trigger] = { present: true, keys: [], branches: undefined, paths: undefined, cron: [] };
      continue;
    }
    if (!trigger) continue;
    if ((m = /^ {4}([A-Za-z_-]+):\s*(.*)$/.exec(line))) {
      key = m[1];
      triggers[trigger].keys.push(key);
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
  Object.defineProperty(triggers, 'range', { value: [start, end], enumerable: false });
  return triggers;
}

/**
 * Parse every `steps:` list into [{ keys, name, if, runLines }]. `runLines`
 * are the trimmed, non-blank, non-comment lines of the step's `run:` (block
 * or inline).
 */
function parseSteps(text) {
  const lines = text.split(/\r?\n/);
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const sm = /^(\s*)steps:\s*$/.exec(lines[i]);
    if (!sm) continue;
    const base = sm[1].length;
    let dash = -1;
    let cur = null;
    let runIndent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*$/.test(line)) continue;
      const ind = indentOf(line);
      if (cur && runIndent >= 0 && ind >= runIndent) {
        if (!isComment(line)) cur.runLines.push(line.trim());
        continue;
      }
      runIndent = -1;
      if (isComment(line)) continue;
      if (ind <= base) { i = j - 1; break; }
      if (dash < 0) dash = ind;
      let m;
      if (ind === dash && (m = /^\s*-\s+(.*)$/.exec(line))) {
        cur = { keys: [], name: undefined, if: undefined, runLines: [] };
        steps.push(cur);
        m = /^([\w-]+):\s*(.*)$/.exec(m[1]);
      } else if (cur && ind === dash + 2) {
        m = /^\s*([\w-]+):\s*(.*)$/.exec(line);
      } else {
        continue;
      }
      if (!m || !cur) continue;
      const [, k, v] = m;
      cur.keys.push(k);
      if (k === 'name') cur.name = unquote(v);
      if (k === 'if') cur.if = v.trim();
      if (k === 'run') {
        if (/^[|>][-+]?\s*$/.test(v)) runIndent = dash + 3;
        else cur.runLines.push(v.trim());
      }
    }
  }
  return steps;
}

/** Exact match, or a `dir/**` glob prefix. */
function isCovered(file, paths) {
  return paths.some((p) => (p.endsWith('/**') ? file.startsWith(p.slice(0, -2)) : p === file));
}

/** Drop the forms that resolve to the checkout root, so the token regex sees a bare relative path. */
const stripWorkspace = (line) =>
  line.replace(/\$\{\{\s*github\.workspace\s*\}\}\//g, '').replace(/\$\{?GITHUB_WORKSPACE\}?\//g, '');

/** A relative path with a directory part and a script extension, optionally led by `./`. */
const PATH_TOKEN = new RegExp(
  String.raw`(?<![\w/.$-])(?:\./)?((?:\.?[\w-][\w.-]*/)+[\w.-]+\.(?:${SCRIPT_EXT}))(?!\w)`,
  'g',
);

/**
 * Repo-relative script paths a text names on non-comment lines, whatever
 * launches them. `skip` is a [start, end) line range to ignore (the `on:` block).
 */
function liftScripts(text, { skip = [0, 0], commentRe = /^\s*#/ } = {}) {
  const found = new Set();
  text.split(/\r?\n/).forEach((line, i) => {
    if (i >= skip[0] && i < skip[1]) return;
    if (commentRe.test(line)) return;
    for (const m of stripWorkspace(line).matchAll(PATH_TOKEN)) found.add(posix.normalize(m[1]));
  });
  return [...found];
}

/** `uses: ./x` targets (local actions and reusable workflows), repo-relative. */
function localUses(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (isComment(line)) continue;
    const m = /^\s*(?:-\s+)?uses:\s*['"]?\.\/([^\s'"#]+)/.exec(line);
    if (m) out.push(posix.normalize(m[1]).replace(/\/$/, ''));
  }
  return out;
}

/** The file a local `uses:` target actually loads. */
function usesFile(target) {
  if (/\.ya?ml$/.test(target)) return target;
  for (const f of ['action.yml', 'action.yaml']) if (existsSync(join(REPO, target, f))) return `${target}/${f}`;
  return `${target}/action.yml`;
}

const JS_COMMENT = /^\s*(\/\/|\*|\/\*)/;

/** Files a JS module loads by relative specifier, plus repo-relative path tokens. */
function jsRefs(rel, src) {
  const dir = posix.dirname(rel);
  const specs = [
    ...[...src.matchAll(/(?:\bfrom|\bimport)\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/\b(?:import|require)\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];
  return [
    ...specs.map((s) => posix.normalize(posix.join(dir, s))),
    ...liftScripts(src, { commentRe: JS_COMMENT }),
  ];
}

/** `$(dirname "$0")`, `$(dirname "${BASH_SOURCE[0]}")`, `${BASH_SOURCE%/*}` -- the script's own directory. */
const SELF_DIR = String.raw`(?:\$\(\s*dirname\s+["']?\$(?:0|\{BASH_SOURCE(?:\[0\])?\}|BASH_SOURCE)["']?\s*\)|\$\{BASH_SOURCE(?:\[0\])?%/\*\})`;
const SH_PATH = String.raw`([\w./-]+\.(?:${SCRIPT_EXT}))(?!\w)`;

/** Files a shell script reaches through its own dirname, plus repo-relative path tokens. */
function shellRefs(rel, src) {
  const dir = posix.dirname(rel);
  const out = [];
  const bases = new Map();
  const code = src.split(/\r?\n/).filter((l) => !isComment(l));
  for (const line of code) {
    const a = new RegExp(String.raw`^\s*(?:(?:export|readonly|local|declare(?:\s+-\w+)?)\s+)?([A-Za-z_]\w*)=.*?${SELF_DIR}(/[^"'\s)&;|]*)?`).exec(line);
    if (a) bases.set(a[1], posix.normalize(posix.join(dir, `.${a[2] ?? ''}`)));
  }
  for (const line of code) {
    for (const m of line.matchAll(new RegExp(`${SELF_DIR}/${SH_PATH}`, 'g'))) out.push(posix.normalize(posix.join(dir, m[1])));
    for (const [v, base] of bases) {
      for (const m of line.matchAll(new RegExp(String.raw`\$\{?${v}\}?/${SH_PATH}`, 'g'))) {
        out.push(posix.normalize(posix.join(base, m[1])));
      }
    }
  }
  return [...out, ...liftScripts(src)];
}

/** Everything `rel` loads, transitively, by the forms above. */
function localDeps(rel, seen = new Set()) {
  if (seen.has(rel)) return seen;
  seen.add(rel);
  const abs = join(REPO, rel);
  if (!existsSync(abs) || statSync(abs).isDirectory()) return seen;
  const src = readFileSync(abs, 'utf8');
  let refs = [];
  if (/\.(mjs|cjs|js)$/.test(rel)) refs = jsRefs(rel, src);
  else if (/\.sh$/.test(rel)) refs = shellRefs(rel, src);
  else if (/\.ya?ml$/.test(rel)) refs = [...liftScripts(src), ...localUses(src).map(usesFile)];
  else refs = liftScripts(src); // .py / .ps1: path tokens only (imports / dot-sourcing not followed)
  for (const r of refs) localDeps(r, seen);
  return seen;
}

const TEXT = readFileSync(join(REPO, WORKFLOW_REL), 'utf8');
const ON = parseOnBlock(TEXT);
const GTEXT = readFileSync(join(REPO, GUARDRAILS_REL), 'utf8');

test('parser positive control: a literal fixture parses to its known values', () => {
  // Breaks if the parser drops quoted items, mis-reads a flow-style branch
  // list, loses a trigger, picks a list item up under the wrong key, or stops
  // recording a trigger's keys (which (d) relies on to see a `paths:` filter).
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
    '    paths-ignore:',
    "      - 'z/**'",
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
  assert.deepEqual(got.pull_request.keys, ['branches', 'paths-ignore', 'paths']);
  assert.deepEqual(got.schedule.cron, ['1 2 * * *']);
  assert.equal(got.workflow_dispatch.present, true);
  assert.equal(got.workflow_dispatch.paths, undefined, 'dispatch inputs must not be read as paths');
  assert.deepEqual(got.range, [1, 20]);
});

test('step-parser positive control: a literal fixture parses to its known steps', () => {
  // Breaks if the parser loses a step, merges two, reads a comment or a
  // block-scalar body line as a key, or keeps comment lines inside `run: |`.
  const fixture = [
    'jobs:',
    '  j:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      # comment between steps',
    '      - name: one',
    '        if: ${{ !cancelled() }}',
    '        run: node scripts/a.mjs',
    '      - name: two',
    '        continue-on-error: true',
    '        run: |',
    '          # a comment inside the block',
    '          X=1',
    '          name: not-a-key',
    '          bash scripts/b.sh',
    '  k:',
    '    steps:',
    '      - run: echo hi',
  ].join('\n');
  const got = parseSteps(fixture);
  assert.equal(got.length, 4);
  assert.deepEqual(got.map((s) => s.name), [undefined, 'one', 'two', undefined]);
  assert.equal(got[1].if, '${{ !cancelled() }}');
  assert.deepEqual(got[1].runLines, ['node scripts/a.mjs']);
  assert.deepEqual(got[2].keys, ['name', 'continue-on-error', 'run']);
  assert.deepEqual(got[2].runLines, ['X=1', 'name: not-a-key', 'bash scripts/b.sh']);
  assert.deepEqual(got[3].runLines, ['echo hi']);
});

test('detector positive controls: every form the seam check claims is recognised', () => {
  // One literal per claimed form. Breaks if any regex stops matching its form
  // -- which would make the seam test below blind to it while still green.
  const wf = [
    'node ./scripts/ci/f1.mjs',
    'node "$GITHUB_WORKSPACE/scripts/ci/f2.mjs"',
    'node "${GITHUB_WORKSPACE}/scripts/ci/f3.mjs" --x',
    'node "${{ github.workspace }}/scripts/ci/f4.mjs"',
    'node --no-warnings --max-old-space-size=4096 scripts/ci/f5.mjs',
    'python scripts/ci/f6.py',
    './scripts/ci/f7.sh arg',
    'pwsh -File tools/f8.ps1',
    '# node scripts/ci/commented-out.mjs',
    'node ../scripts/ci/parent-relative.mjs',
    'bash /tmp/absolute.sh',
    'node "$RUNNER_TEMP/runner-temp.mjs"',
  ].join('\n');
  assert.deepEqual(sorted(liftScripts(wf)), sorted([
    'scripts/ci/f1.mjs', 'scripts/ci/f2.mjs', 'scripts/ci/f3.mjs', 'scripts/ci/f4.mjs',
    'scripts/ci/f5.mjs', 'scripts/ci/f6.py', 'scripts/ci/f7.sh', 'tools/f8.ps1',
  ]));
  assert.deepEqual(liftScripts('on:\n  pull_request:\n    paths:\n      - scripts/x.mjs\njobs:\n  node scripts/y.mjs', { skip: [0, 4] }), ['scripts/y.mjs']);

  assert.deepEqual(localUses('      - uses: ./.github/actions/foo\n      - uses: "./.github/workflows/r.yml"\n      - uses: actions/checkout@v4\n      # - uses: ./.github/actions/commented'),
    ['.github/actions/foo', '.github/workflows/r.yml']);

  const js = [
    "import { a } from './j1.mjs';",
    "import './j2.mjs';",
    "export * from '../ci/j3.mjs';",
    "const m = await import('./j4.mjs');",
    "const c = require('./j5.cjs');",
    "execFileSync('node', ['scripts/ci/j6.mjs']);",
    "// import './commented.mjs' -- a comment line still counts: conservative",
    "import fs from 'node:fs';",
  ].join('\n');
  assert.deepEqual(sorted(jsRefs('scripts/csa-loom/x.mjs', js)), sorted([
    'scripts/csa-loom/j1.mjs', 'scripts/csa-loom/j2.mjs', 'scripts/ci/j3.mjs',
    'scripts/csa-loom/j4.mjs', 'scripts/csa-loom/j5.cjs', 'scripts/ci/j6.mjs',
    'scripts/csa-loom/commented.mjs',
  ]));

  const sh = [
    'set -euo pipefail',
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'ROOT="$(cd "$(dirname "$0")/../.." && pwd)"',
    'D=${BASH_SOURCE%/*}',
    'source "$HERE/s1.sh"',
    '. "$(dirname "$0")/s2.sh"',
    'node "${HERE}/s3.mjs"',
    'bash "$ROOT/tools/s4.sh"',
    '. "$D/s5.sh"',
    'node scripts/ci/s6.mjs',
    '# source "$HERE/commented.sh"',
    'cat "$ROOT/docs/readme.md"',
  ].join('\n');
  assert.deepEqual(sorted(shellRefs('scripts/ci/x.sh', sh)), sorted([
    'scripts/ci/s1.sh', 'scripts/ci/s2.sh', 'scripts/ci/s3.mjs', 'tools/s4.sh',
    'scripts/ci/s5.sh', 'scripts/ci/s6.mjs',
  ]));
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

test('(a) every file the workflow executes, and what it loads, is in the PR filter', () => {
  // The seam check, over the forms listed in the header (and ONLY those).
  // Breaks when the workflow gains a call to a new script in any of those
  // forms, a `uses: ./...` step, or when an executed file gains a load of a
  // new local file, without the filter following.
  const direct = liftScripts(TEXT, { skip: ON.range });
  // Positive control on the lift over the REAL file: a regex that matched
  // nothing would make the coverage loop below vacuously green.
  for (const s of EXPECTED_DIRECT_SCRIPTS) {
    assert.ok(direct.includes(s), `lift missed ${s} (lifted: ${direct.join(', ')})`);
  }
  const uses = localUses(TEXT).map(usesFile);
  const all = new Set();
  for (const s of [...direct, ...uses]) for (const d of localDeps(s)) all.add(d);
  // Positive control on dependency following: these three are reached ONLY
  // through a load, never named in a run step (two via `from`, two via the
  // shell's `$HERE`).
  for (const s of ['scripts/ci/redact-secrets.mjs', 'scripts/ci/parse-reindex-poll.mjs', 'scripts/csa-loom/eval-regression-lib.mjs', 'scripts/ci/classify-reindex-result.mjs']) {
    assert.ok(all.has(s), `dependency walk missed ${s}`);
  }
  const uncovered = [...all].filter((f) => !isCovered(f, ON.pull_request.paths)).sort();
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

test('(d) loom-guardrails stages the corpus and lints the eval sets on EVERY pull_request', () => {
  // What narrowing (a) moved here. Breaks on: a branches/paths filter added to
  // guardrails' pull_request trigger; either command line deleted, commented
  // out, or suffixed (`|| true`); the lint step no longer directly after the
  // stager (it reads the manifest the stager leaves); `continue-on-error`,
  // `shell:` (the default `bash -e` is what fails the step) or a `set +e` on
  // either step; the `!cancelled()` guard dropped (an earlier red guard would
  // then skip them); the lint step losing its no-manifest check.
  // NOT checked: a job-level `if:` or `needs:` on the guardrails job.
  const g = parseOnBlock(GTEXT);
  assert.ok(g?.pull_request, `${GUARDRAILS_REL} lost its pull_request trigger`);
  const filters = g.pull_request.keys.filter((k) => ['branches', 'branches-ignore', 'paths', 'paths-ignore'].includes(k));
  assert.deepEqual(filters, [], `guardrails' pull_request is filtered (${filters.join(', ')}) — it would no longer run on every PR`);

  const steps = parseSteps(GTEXT);
  const iStage = steps.findIndex((s) => s.runLines.includes(STAGE_CMD));
  const iLint = steps.findIndex((s) => s.runLines.includes(LINT_CMD));
  assert.ok(iStage >= 0, `no guardrails step runs exactly \`${STAGE_CMD}\``);
  assert.ok(iLint >= 0, `no guardrails step runs exactly \`${LINT_CMD}\``);
  assert.equal(iLint, iStage + 1, 'the lint step must directly follow the stager step: it lints the manifest the stager leaves');
  for (const s of [steps[iStage], steps[iLint]]) {
    assert.equal(s.if, '${{ !cancelled() }}', `${s.name}: must carry if: \${{ !cancelled() }}`);
    for (const k of ['continue-on-error', 'shell']) assert.ok(!s.keys.includes(k), `${s.name}: must not set ${k}`);
    const swallow = s.runLines.filter((l) => /^set\s+\+e\b|\|\|\s*(true|:)\s*$/.test(l));
    assert.deepEqual(swallow, [], `${s.name}: a line would discard the result`);
  }
  assert.ok(steps[iLint].runLines.some((l) => l.includes('! -f "$CORPUS/.corpus-manifest.json"')),
    'the lint step must fail when no staged manifest exists (otherwise it silently degrades to repo-tree-only)');
});
