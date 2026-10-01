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
 *       PRPs/) run on EVERY pull_request in loom-guardrails.yml instead, in
 *       their own ADVISORY job `copilot-corpus-lint` (operator decision
 *       2026-09-30: not inside the required `guardrails` job, and not a
 *       required context);
 *   (e) those two step bodies, EXECUTED under `bash -e` against stub
 *       scripts, fail when their script fails, with its code, and name only
 *       candidate paths the stager really hashes (see the (e) block below).
 *
 * The paths under test are LIFTED FROM THE YAML at runtime. The expected sets
 * are LITERALS on purpose: an expectation derived from the file under test
 * could not disagree with it.
 *
 * WHAT THE (a) SEAM CHECK WITNESSES -- CLOSED WORLD. It witnesses EXACTLY the
 * forms below, each with a fixture positive control below and a sandbox
 * mutation arm in the PR. Every other form is UNWITNESSED BY DESIGN: a green
 * run says nothing about it. (Measured examples of unwitnessed forms, all
 * GREEN on a sandbox: `$(dirname "$(readlink -f "$0")")`, `dirname -- "$0"`,
 * a template-literal `import(`./x`)`, `npx tsx scripts/x.ts`, an
 * extensionless `bash scripts/x`, and `npm --prefix … run <script>`.)
 *   1. In the workflow, outside `on:`, on non-comment lines: a relative path
 *      with a directory part and a .mjs/.cjs/.js/.sh/.py/.ps1 extension,
 *      optionally led by `./`, `$GITHUB_WORKSPACE/`, `${GITHUB_WORKSPACE}/` or
 *      `${{ github.workspace }}/`, whatever command precedes it.
 *   2. A local `uses: ./path` (action dir or reusable workflow); its own file
 *      is then read by forms 1 and 5-7.
 *   3. In a JS file: `from '<rel>'`, `import '<rel>'`, `import('<rel>')` and
 *      `require('<rel>')` with a single- or double-quoted relative specifier.
 *   4. In a JS file: form 1's path token on a non-comment line.
 *   5. In a shell file: a path after EXACTLY one of these three expressions for
 *      the script's own directory -- `$(dirname "$0")`,
 *      `$(dirname "${BASH_SOURCE[0]}")`, `${BASH_SOURCE%/*}` -- used inline.
 *   6. In a shell file: a path after `$VAR/` or `${VAR}/`, where VAR was
 *      assigned from one of those three expressions (a literal `/../..`
 *      suffix after the expression is resolved).
 *   7. In a shell file: form 1's path token on a non-comment line.
 * Forms 5-7 match the path wherever it appears, so `.`/`source`/`bash`/`node`
 * in front all count. A MENTION counts as an execution: a non-comment line
 * naming such a path is required to be covered even if it only echoes it.
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
import { readFileSync, existsSync, statSync, lstatSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
  'scripts/ci/eval-measurement.mjs',
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

/** The six scripts the run steps name directly (positive control for the lift); the seventh harness script, classify-reindex-result.mjs, is reached via reindex-loom-docs.sh. */
const EXPECTED_DIRECT_SCRIPTS = [
  'scripts/csa-loom/stage-copilot-corpus.sh',
  'scripts/csa-loom/lint-eval-sets.mjs',
  'scripts/ci/reindex-loom-docs.sh',
  'scripts/csa-loom/check-eval-regression.mjs',
  'scripts/ci/run-outcome.mjs',
  'scripts/ci/eval-measurement.mjs',
];

/** (d) The advisory job, and the exact command lines it must run. */
const ADVISORY_JOB = 'copilot-corpus-lint';
const STAGE_CMD = 'bash scripts/csa-loom/stage-copilot-corpus.sh || rc=$?';
const LINT_CMD = 'node scripts/csa-loom/lint-eval-sets.mjs';
const STAGE_FAIL_IF = 'if [ "$rc" -ne 0 ]; then';
const NO_MANIFEST_IF = 'if [ ! -f "$CORPUS/.corpus-manifest.json" ]; then';

/**
 * (d) Shapes that discard a failing step under the runner's `bash -e`. One
 * regex per shape (no alternation), each with a positive control in (d).
 */
const SWALLOWS = [
  ['`set +e` (or a flag cluster containing e)', /\bset\s+\+[a-z]*e/, 'set +eu'],
  ['`set +o errexit`', /\bset\s+\+o\s+errexit\b/, 'set +o errexit'],
  ['`|| true`', /\|\|\s*true\b/, 'cmd || true'],
  ['`|| :`', /\|\|\s*:/, 'cmd || :'],
  ['`exit 0` (including a trap ending in it)', /\bexit\s+0\b/, `trap 'git clean -fdqX -- "$CORPUS"; exit 0' EXIT`],
];

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
 * Parse every `steps:` list into [{ keys, name, if, runLines, runRaw }].
 * `runLines` are the trimmed, non-blank, non-comment lines of the step's
 * `run:` (block or inline); `runRaw` is the same script as the runner gets it
 * (block indentation removed, comments kept), for the behavioural test.
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
        if (cur.rawIndent === undefined) cur.rawIndent = ind;
        cur.runRaw.push(line.slice(Math.min(ind, cur.rawIndent)));
        if (!isComment(line)) cur.runLines.push(line.trim());
        continue;
      }
      runIndent = -1;
      if (isComment(line)) continue;
      if (ind <= base) { i = j - 1; break; }
      if (dash < 0) dash = ind;
      let m;
      if (ind === dash && (m = /^\s*-\s+(.*)$/.exec(line))) {
        cur = { keys: [], name: undefined, if: undefined, runLines: [], runRaw: [] };
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
        else {
          cur.runLines.push(v.trim());
          cur.runRaw.push(v.trim());
        }
      }
    }
  }
  return steps;
}

/**
 * Split the top-level `jobs:` block into { key: { keys, text } }. Job keys sit
 * at 2 spaces and a job's own keys at 4; `text` is the job's lines, for
 * parseSteps. Comment lines are kept in `text` but never read as keys.
 */
function parseJobs(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  const jobs = {};
  if (start < 0) return jobs;
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && !/^#/.test(line)) break;
    let m;
    if ((m = /^ {2}([\w-]+):\s*(#.*)?$/.exec(line))) {
      cur = { keys: [], lines: [] };
      jobs[m[1]] = cur;
      continue;
    }
    if (!cur) continue;
    cur.lines.push(line);
    if (!isComment(line) && (m = /^ {4}([\w-]+):/.exec(line))) cur.keys.push(m[1]);
  }
  for (const j of Object.values(jobs)) j.text = j.lines.join('\n');
  return jobs;
}

/**
 * The lines of the shell `if` that opens with `head`, through its matching
 * `fi` (nested multi-line `if`s are counted; a one-line `if …; fi` is not).
 * Returns null if `head` is absent or never closed.
 */
function ifBlock(lines, head) {
  const i = lines.indexOf(head);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (/^if\s/.test(l) && !/;\s*fi$/.test(l)) depth++;
    else if (l === 'fi') {
      if (depth === 0) return lines.slice(i, j + 1);
      depth--;
    }
  }
  return null;
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

/** The file a local `uses:` target actually loads (tried by READING, not by an existence check). */
function usesFile(target) {
  if (/\.ya?ml$/.test(target)) return target;
  for (const f of ['action.yml', 'action.yaml']) {
    try {
      readFileSync(join(REPO, target, f));
      return `${target}/${f}`;
    } catch {
      // not this name; try the next
    }
  }
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
  // One read, no existence pre-check (a check-then-read is a file-system race,
  // CodeQL js/file-system-race). A missing file or a directory throws, and a
  // file that does not exist loads nothing -- it is still in `seen`, so the
  // coverage check below still requires it.
  let src;
  try {
    src = readFileSync(join(REPO, rel), 'utf8');
  } catch {
    return seen;
  }
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
  // runRaw is what the behavioural test EXECUTES: block indent removed, the
  // comment kept, nested indentation preserved (here none), nothing trimmed away.
  assert.deepEqual(got[2].runRaw, ['# a comment inside the block', 'X=1', 'name: not-a-key', 'bash scripts/b.sh']);
  assert.deepEqual(got[1].runRaw, ['node scripts/a.mjs']);
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

test('(d) job-parser + helper positive controls: literal fixtures give their known values', () => {
  // Breaks if parseJobs loses a job, reads a comment or a block-scalar line as
  // a job or a job key, or leaks one job's steps into another; if ifBlock stops
  // at a nested `fi` or counts a one-line `if …; fi`; or if any SWALLOWS regex
  // stops matching its own sample (which would make (d) blind to it).
  const fixture = [
    'on:',
    '  pull_request:',
    'jobs:',
    '  a:',
    '    runs-on: x',
    '    steps:',
    '      - run: node scripts/a.mjs',
    '  # a comment between jobs',
    '  b:',
    '    needs: a',
    '    if: false',
    '    steps:',
    '      - run: |',
    '          echo "  fake:"',
    '          node scripts/b.mjs',
  ].join('\n');
  const jobs = parseJobs(fixture);
  assert.deepEqual(Object.keys(jobs), ['a', 'b']);
  assert.deepEqual(jobs.a.keys, ['runs-on', 'steps']);
  assert.deepEqual(jobs.b.keys, ['needs', 'if', 'steps']);
  assert.deepEqual(parseSteps(jobs.a.text).map((s) => s.runLines), [['node scripts/a.mjs']]);
  assert.deepEqual(parseSteps(jobs.b.text).map((s) => s.runLines), [['echo "  fake:"', 'node scripts/b.mjs']]);

  const sh = ['if [ x ]; then', 'if [ -d y ]; then z; fi', 'if [ w ]; then', 'a', 'fi', 'exit 1', 'fi', 'after'];
  assert.deepEqual(ifBlock(sh, 'if [ x ]; then'), sh.slice(0, 7));
  assert.equal(ifBlock(sh, 'if [ missing ]; then'), null);

  for (const [what, re, sample] of SWALLOWS) assert.ok(re.test(sample), `SWALLOWS regex for ${what} does not match its own sample`);
  for (const [what, re] of SWALLOWS) {
    for (const clean of ['exit "$rc"', 'exit 1', 'set -euo pipefail', 'rc=0']) assert.ok(!re.test(clean), `SWALLOWS ${what} matches the clean line ${clean}`);
  }
});

test('(d) the corpus stager + eval-set lint run on EVERY pull_request, in an ADVISORY job', () => {
  // What narrowing (a) moved to loom-guardrails.yml. WITNESSES EXACTLY THESE,
  // each named with the input that breaks it; anything else is unwitnessed:
  //   - guardrails' `pull_request:` carries ANY key (types/branches/paths/...);
  //   - job `copilot-corpus-lint` missing, or carrying a job-level `if:`,
  //     `needs:` or `continue-on-error:`;
  //   - either command run from a step of the REQUIRED `guardrails` job
  //     (operator decision 2026-09-30: advisory, not required);
  //   - `copilot-corpus-lint` listed in tools/drain/required_contexts.json (the
  //     snapshot; live branch protection is not read here);
  //   - either command line deleted, commented out or altered; the lint step
  //     not directly after the stager step;
  //   - `if: ${{ !cancelled() }}` dropped, or `continue-on-error:` / `shell:`
  //     added, on either step;
  //   - any SWALLOWS shape anywhere in either step;
  //   - the stager's failure branch losing `exit "$rc"` or its ::error:: line,
  //     or `rc=0` not set before the stager runs;
  //   - the lint's no-manifest branch losing `exit 1`.
  const g = parseOnBlock(GTEXT);
  assert.ok(g?.pull_request, `${GUARDRAILS_REL} lost its pull_request trigger`);
  assert.deepEqual(g.pull_request.keys, [], `guardrails' pull_request carries keys (${g.pull_request.keys.join(', ')}) — it would no longer run on every PR event`);

  const jobs = parseJobs(GTEXT);
  // Positive control: the required job must be FOUND, or the "not in guardrails" check below is vacuous.
  assert.ok(jobs.guardrails && parseSteps(jobs.guardrails.text).length > 100, 'parseJobs did not find the guardrails job and its steps');
  const inRequired = parseSteps(jobs.guardrails.text)
    .filter((s) => s.runLines.some((l) => l.includes('stage-copilot-corpus.sh') || l.includes('lint-eval-sets.mjs')))
    .map((s) => s.name);
  assert.deepEqual(inRequired, [], 'the stager / eval lint must NOT run in the REQUIRED guardrails job (operator decision 2026-09-30)');

  const job = jobs[ADVISORY_JOB];
  assert.ok(job, `${GUARDRAILS_REL} has no job ${ADVISORY_JOB}`);
  for (const k of ['if', 'needs', 'continue-on-error']) {
    assert.ok(!job.keys.includes(k), `${ADVISORY_JOB} must not set job-level ${k}: it could skip or mute the job`);
  }

  // A read, not an existence check: a missing snapshot throws and fails the test.
  const required = JSON.parse(readFileSync(join(REPO, 'tools/drain/required_contexts.json'), 'utf8')).contexts;
  assert.ok(required.includes('guardrails'), 'positive control: the required-contexts snapshot does not list guardrails, so it is not the file this reads');
  assert.ok(!required.includes(ADVISORY_JOB), `${ADVISORY_JOB} is listed as REQUIRED; the operator decided it is advisory`);

  const steps = parseSteps(job.text);
  const iStage = steps.findIndex((s) => s.runLines.includes(STAGE_CMD));
  const iLint = steps.findIndex((s) => s.runLines.includes(LINT_CMD));
  assert.ok(iStage >= 0, `no ${ADVISORY_JOB} step runs exactly \`${STAGE_CMD}\``);
  assert.ok(iLint >= 0, `no ${ADVISORY_JOB} step runs exactly \`${LINT_CMD}\``);
  assert.equal(iLint, iStage + 1, 'the lint step must directly follow the stager step: it lints the manifest the stager leaves');
  const stage = steps[iStage];
  const lint = steps[iLint];
  for (const s of [stage, lint]) {
    assert.equal(s.if, '${{ !cancelled() }}', `${s.name}: must carry if: \${{ !cancelled() }}`);
    for (const k of ['continue-on-error', 'shell']) assert.ok(!s.keys.includes(k), `${s.name}: must not set ${k}`);
    for (const [what, re] of SWALLOWS) {
      assert.deepEqual(s.runLines.filter((l) => re.test(l)), [], `${s.name}: ${what} would discard the step's failure`);
    }
  }

  const rc0 = stage.runLines.indexOf('rc=0');
  assert.ok(rc0 >= 0 && rc0 < stage.runLines.indexOf(STAGE_CMD), 'rc=0 must be set before the stager runs');
  const fail = ifBlock(stage.runLines, STAGE_FAIL_IF);
  assert.ok(fail, `the stager step has no \`${STAGE_FAIL_IF}\` … fi branch`);
  assert.ok(fail.includes('exit "$rc"'), 'the stager failure branch must exit with the stager\'s own code');
  assert.ok(fail.some((l) => l.includes('::error::scripts/csa-loom/stage-copilot-corpus.sh exited $rc')),
    'the stager failure branch must name the stager and its exit code in an ::error:: annotation');

  const noManifest = ifBlock(lint.runLines, NO_MANIFEST_IF);
  assert.ok(noManifest, 'the lint step must check for the staged manifest (otherwise it silently degrades to repo-tree-only)');
  assert.ok(noManifest.includes('exit 1'), 'the no-manifest branch must `exit 1`');
});

// ── (e) BEHAVIOURAL: the two step bodies, EXECUTED ──────────────────────────
//
// (d) reads the steps; this RUNS them. Both bodies are lifted from
// loom-guardrails.yml at runtime (parseSteps' runRaw) and executed under
// `bash -e` -- the runner's default shell for a `run:` step -- in a throwaway
// git repo with STUB scripts in place of the stager and the lint:
//   - the stager stub exits <rc> in its DEFAULT mode and, given
//     `--list-inputs`, runs the stager text that follows it (the real one, an
//     edited real one, or a hand-written list), exactly as CI would run it;
//   - the lint stub is `process.exit(<rc>)`.
// It witnesses EXACTLY the cases below: the step's exit code, the ::error:: /
// "may be the cause" lines it prints, and (lint) that the corpus dir is clean
// afterwards. Any edit that makes a failing step exit 0 INSIDE THIS FIXTURE
// turns a case RED whatever its spelling -- an extra `rc=0`, `exit "$rc"` under
// `if false`, a trap ending in `exit 00`, an ERR trap `exit $((0))`, a bare
// `exit`. An edit that exits 0 only under conditions the fixture does not
// reproduce (e.g. only when a real-repo file exists) is NOT witnessed. Not
// witnessed either: the broken-symlink and unreadable-file wording (only the
// directory case runs; symlinks and permission bits are not portable to the
// Windows runs).
//
// BASH: `bash` on Linux/macOS. On Windows the bare name resolves to WSL's
// System32 bash first, which cannot see this process's temp paths, so Git
// Bash is used (CONTRACT_TEST_BASH overrides); with neither, the test is
// SKIPPED and says so, and CI (ubuntu, `bash`) is the verdict.
const STAGER_REL = 'scripts/csa-loom/stage-copilot-corpus.sh';
const LINT_REL = 'scripts/csa-loom/lint-eval-sets.mjs';
const CORPUS_REL = 'apps/fiab-console/copilot-corpus';

function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [process.env.CONTRACT_TEST_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe'];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}
const BASH = findBash();
const SKIP_BEHAVIOUR = BASH ? false : 'win32 without Git Bash (set CONTRACT_TEST_BASH); WSL bash cannot see the temp paths. CI runs this on Linux.';

const REAL_STAGER = readFileSync(join(REPO, STAGER_REL), 'utf8');
/** Default mode exits <rc>; `--list-inputs` falls through to `body` (by default the REAL stager). */
const stubStager = (rc, body = REAL_STAGER) =>
  `#!/usr/bin/env bash\nif [ "\${1:-}" != "--list-inputs" ]; then echo "stub stager: exit ${rc}" >&2; exit ${rc}; fi\n${body}`;

/** The real stager with reviewer A's round-4 M6 and M7 edits applied (each anchor must match exactly once). */
function stagerWithM6M7() {
  const m6From = '$ROOT/PRPs/archive|PRPs/archive';
  const m7After = "  -not -path './fiab/audit/*'\n)\n";
  assert.equal(REAL_STAGER.split(m6From).length - 1, 1, 'M6 anchor ($ROOT/PRPs/archive|…) not found exactly once in the real stager');
  assert.equal(REAL_STAGER.split(m7After).length - 1, 1, 'M7 anchor (end of EXCLUDE_FIND) not found exactly once in the real stager');
  return REAL_STAGER
    .replace(m6From, '${ROOT}/PRPs/archive|PRPs/archive')
    .replace(m7After, `${m7After}EXCLUDE_FIND+=( -not -path './fiab/zz-new/*' )\n`);
}

function stepBodies() {
  const job = parseJobs(GTEXT)[ADVISORY_JOB];
  assert.ok(job, `${GUARDRAILS_REL} has no job ${ADVISORY_JOB}`);
  const steps = parseSteps(job.text);
  const stage = steps.find((s) => s.runLines.includes(STAGE_CMD));
  const lint = steps.find((s) => s.runLines.includes(LINT_CMD));
  assert.ok(stage && lint, 'could not find the stager / lint steps to execute');
  return { stage: `${stage.runRaw.join('\n')}\n`, lint: `${lint.runRaw.join('\n')}\n` };
}

/** A throwaway repo: stubbed stager + lint, a docs/ root, the gitignored corpus dir. */
function fixture({ stager, lintRc = 0, dirs = [], manifest = false, git = false }) {
  const root = mkdtempSync(join(tmpdir(), 'cc-lint-'));
  const put = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  put(STAGER_REL, stager);
  put(LINT_REL, `process.exit(${lintRc});\n`);
  put('docs/ok.md', '# ok\n');
  put(`${CORPUS_REL}/.gitkeep`, '');
  put('.gitignore', `${CORPUS_REL}/*\n!${CORPUS_REL}/.gitkeep\n`);
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  if (manifest) put(`${CORPUS_REL}/.corpus-manifest.json`, '{"files":{}}\n');
  if (git) {
    const g = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    assert.equal(g.status, 0, `git init failed in the fixture: ${g.stderr}`);
    // Committed, as in the real checkout (the corpus dir is a tracked
    // `.gitkeep` only). Untracked or merely staged, the step's own leftover
    // check reports it (`??` / `A`) -- measured, both.
    const a = spawnSync('git', ['add', '--', `${CORPUS_REL}/.gitkeep`, '.gitignore'], { cwd: root, encoding: 'utf8' });
    assert.equal(a.status, 0, `git add failed in the fixture: ${a.stderr}`);
    const c = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '-q', '--no-verify', '-m', 'fixture'], { cwd: root, encoding: 'utf8' });
    assert.equal(c.status, 0, `git commit failed in the fixture: ${c.stderr}`);
  }
  return root;
}

/** Run one step body under `bash -e` in `cwd`. */
function runStep(cwd, body) {
  const scratch = mkdtempSync(join(tmpdir(), 'cc-step-'));
  try {
    const file = join(scratch, 'step.sh');
    writeFileSync(file, body);
    const r = spawnSync(BASH, ['-e', file.replace(/\\/g, '/')], { cwd, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.error, undefined, `could not run ${BASH}: ${r.error}`);
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function corpusLeft(cwd) {
  const r = spawnSync('git', ['status', '--porcelain', '--ignored', '--', CORPUS_REL], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git status failed: ${r.stderr}`);
  return r.stdout.trim();
}

function withFixture(opts, fn) {
  const root = fixture(opts);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const causeLines = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('::error::may be the cause: '));

test('(e) the stager step, EXECUTED: a failing stager fails the step with its own code and names only real candidates', { skip: SKIP_BEHAVIOUR }, () => {
  const { stage } = stepBodies();

  // C0 control: a passing stager passes the step, silently. (Without this, a
  // step that ALWAYS exits non-zero would satisfy every case below.)
  withFixture({ stager: stubStager(0) }, (root) => {
    const r = runStep(root, stage);
    assert.equal(r.code, 0, `C0: a passing stager must pass the step:\n${r.out}`);
    assert.doesNotMatch(r.out, /::error::/, 'C0: no ::error:: when the stager passed');
  });

  // C1: the REAL stager's --list-inputs. docs/zz-real.md is a listed input
  // and a directory -> named. docs/fiab/audit/zz-ex.md is under a subtree the
  // stager EXCLUDES, so it is not listed and must never be blamed (the
  // round-3 R7 defect).
  withFixture({ stager: stubStager(7), dirs: ['docs/zz-real.md', 'docs/fiab/audit/zz-ex.md'] }, (root) => {
    const r = runStep(root, stage);
    assert.equal(r.code, 7, `C1: the step must exit with the stager's own code:\n${r.out}`);
    assert.match(r.out, /::error::scripts\/csa-loom\/stage-copilot-corpus\.sh exited 7\./);
    assert.deepEqual(causeLines(r.out), [
      '::error::may be the cause: docs/zz-real.md is a directory, and the stager lists it as an input (scripts/csa-loom/stage-copilot-corpus.sh --list-inputs). Rename it or change its extension.',
    ]);
    assert.ok(!r.out.includes('zz-ex.md'), `C1: blamed a path the stager excludes:\n${r.out}`);
  });

  // C2: nothing to blame -> says so, still exits with the stager's code.
  withFixture({ stager: stubStager(7) }, (root) => {
    const r = runStep(root, stage);
    assert.equal(r.code, 7, `C2:\n${r.out}`);
    assert.match(r.out, /::error::no candidate found: .* so the cause was NOT determined here\./);
    assert.deepEqual(causeLines(r.out), []);
  });

  // C3: the diagnostic uses EXACTLY what --list-inputs prints, nothing it
  // derives itself. This stager lists zz-root/n.md and docs/fiab/audit/b.md
  // (both directories, both named, in that order) and not
  // docs/zz-fixture-only/a.md (a directory too, never named). A diagnostic
  // that searched the tree itself would name a.md and, with the real
  // exclusions, skip b.md.
  const listed = "printf '%s\\0' zz-root/n.md docs/fiab/audit/b.md\nexit 0\n";
  withFixture({ stager: stubStager(9, listed), dirs: ['docs/zz-fixture-only/a.md', 'docs/fiab/audit/b.md', 'zz-root/n.md'] }, (root) => {
    const r = runStep(root, stage);
    assert.equal(r.code, 9, `C3:\n${r.out}`);
    assert.deepEqual(causeLines(r.out).map((l) => l.split(' ')[4]), ['zz-root/n.md', 'docs/fiab/audit/b.md']);
  });

  // C4: the 20-line cap. 22 candidates -> 20 lines + a count of the other 2.
  const many = Array.from({ length: 22 }, (_, i) => `docs/c${String(i + 1).padStart(2, '0')}.md`);
  withFixture({ stager: stubStager(7), dirs: many }, (root) => {
    const r = runStep(root, stage);
    assert.equal(r.code, 7, `C4:\n${r.out}`);
    assert.equal(causeLines(r.out).length, 20);
    assert.match(r.out, /::error::2 more candidate path\(s\) not listed \(the first 20 are shown\)\./);
  });

  // C5: --list-inputs itself fails -> "cause not determined", NO path named,
  // and the step still exits with the STAGER's code (not the lister's). The
  // lister prints docs/zz-real.md (a real directory, so a candidate) BEFORE
  // failing: a diagnostic that used a failed listing anyway would name it.
  withFixture({ stager: stubStager(5, "printf '%s\\0' docs/zz-real.md\nexit 4\n"), dirs: ['docs/zz-real.md'] }, (root) => {
    const r = runStep(root, stage);
    assert.equal(r.code, 5, `C5:\n${r.out}`);
    assert.match(r.out, /::error::could not list the stager's inputs \(scripts\/csa-loom\/stage-copilot-corpus\.sh --list-inputs exited 4\); cause not determined/);
    assert.deepEqual(causeLines(r.out), []);
  });

  // C6: reviewer A's round-4 M6 + M7 edits, applied to the REAL stager:
  //   M6  `${ROOT}/PRPs/archive` (the stager still hashes PRPs/archive)
  //   M7  `EXCLUDE_FIND+=( -not -path './fiab/zz-new/*' )` (it now skips docs/fiab/zz-new)
  // The round-4 parser of the script's text got both wrong; --list-inputs
  // EXECUTES the edited roots and exclusions, so it reflects both. Must name
  // PRPs/archive/zz-arch.md and must NOT name
  // docs/fiab/zz-new/zz-n.md.
  withFixture({ stager: stubStager(7, stagerWithM6M7()), dirs: ['PRPs/archive/zz-arch.md', 'docs/fiab/zz-new/zz-n.md'] }, (root) => {
    const r = runStep(root, stage);
    assert.equal(r.code, 7, `C6:\n${r.out}`);
    assert.deepEqual(causeLines(r.out).map((l) => l.split(' ')[4]), ['PRPs/archive/zz-arch.md']);
    assert.ok(!r.out.includes('zz-n.md'), `C6: named a path the M7-edited stager excludes:\n${r.out}`);
  });
});

test('(e) the lint step, EXECUTED: a failing lint or a missing manifest fails the step, and the corpus dir is restored', { skip: SKIP_BEHAVIOUR }, () => {
  const { lint } = stepBodies();

  // L0 control: manifest present, lint passes -> step passes, dir restored.
  withFixture({ stager: stubStager(0), manifest: true, git: true }, (root) => {
    const r = runStep(root, lint);
    assert.equal(r.code, 0, `L0:\n${r.out}`);
    assert.equal(corpusLeft(root), '', 'L0: the staged corpus must be cleaned up');
  });

  // L1: no manifest -> exit 1 with the no-manifest error, even though the lint passed.
  withFixture({ stager: stubStager(0), manifest: false, git: true }, (root) => {
    const r = runStep(root, lint);
    assert.equal(r.code, 1, `L1:\n${r.out}`);
    assert.match(r.out, /::error::no staged manifest at apps\/fiab-console\/copilot-corpus\/\.corpus-manifest\.json/);
    assert.equal(corpusLeft(root), '');
  });

  // L2: the lint fails -> the step exits with the lint's own code, and the trap still cleans.
  withFixture({ stager: stubStager(0), lintRc: 3, manifest: true, git: true }, (root) => {
    const r = runStep(root, lint);
    assert.equal(r.code, 3, `L2:\n${r.out}`);
    assert.equal(corpusLeft(root), '', 'L2: the EXIT trap must clean up on failure too');
  });
});

// ── (f) the STAGER's own contract: --list-inputs, and the default mode ──────
//
// Run on the REAL stager (copied into a throwaway tree, so ROOT is that tree),
// under the same bash as (e). WITNESSES EXACTLY:
//   (f1) `--list-inputs` exits 0, prints EXACTLY the expected inputs (the
//        literal below: every *.md, directories named *.md included, under the
//        four source roots, minus ./fiab/{parity-gap,prp,audit}/*), and
//        changes NOTHING in the tree or in $TMPDIR (a full before/after
//        snapshot: every path, its type, size and content hash);
//   (f2) the DEFAULT mode's output, against an oracle computed here from the
//        fixture's own bytes: the staged files (exact bytes), the
//        .corpus-hashes.tsv lines (as a set -- `sort` order is
//        locale-dependent), the .corpus-manifest.json (parsed; key order and
//        whitespace are not compared), the staged eval sets, and the summary
//        line, on a first run and on a no-change second run.
// Not witnessed: writes outside the tree and $TMPDIR; the incremental
// delete/change paths (the round-5 byte-identity proof in the PR covers them).
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** { relPath: 'd' | 'l' | `f:<size>:<sha256>` } for everything under `root`. */
function snapshot(root) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, r));
      if (st.isSymbolicLink()) out[r] = 'l';
      else if (st.isDirectory()) { out[r] = 'd'; walk(r); }
      else out[r] = `f:${st.size}:${sha256(readFileSync(join(root, r)))}`;
    }
  };
  walk('');
  return out;
}

const STAGER_FIXTURE_FILES = {
  'docs/ok.md': '# ok\n',
  'docs/sub/deep.md': '# deep\n\nbody\n',
  'docs/notes.txt': 'not markdown\n',
  'docs/fiab/audit/skip-audit.md': '# excluded\n',
  'docs/fiab/prp/skip-prp.md': '# excluded\n',
  'docs/fiab/parity-gap/skip-gap.md': '# excluded\n',
  'PRPs/active/a.md': '# a\n',
  'PRPs/archive/b.md': '# b\n',
  'PRPs/completed/csa-loom-pillar/c.md': '# c\n',
  'PRPs/other/not-a-root.md': '# not a source root\n',
  'content/evals/set.jsonl': '{"id":"x"}\n',
  'content/evals/_schema.json': '{}\n',
};
/** What the stager reads from STAGER_FIXTURE_FILES: a LITERAL, not derived from the stager. */
const EXPECTED_INPUT_FILES = ['PRPs/active/a.md', 'PRPs/archive/b.md', 'PRPs/completed/csa-loom-pillar/c.md', 'docs/ok.md', 'docs/sub/deep.md'];

function stagerFixture(extraDirs = []) {
  const root = mkdtempSync(join(tmpdir(), 'cc-stager-'));
  const put = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  put(STAGER_REL, REAL_STAGER);
  for (const [rel, body] of Object.entries(STAGER_FIXTURE_FILES)) put(rel, body);
  for (const d of extraDirs) mkdirSync(join(root, d), { recursive: true });
  return root;
}

function runStager(root, args, tmp) {
  // GIT_DIR points nowhere, so `git rev-parse HEAD` fails and sourceCommit is
  // deterministically "unknown" whatever repo the temp dir happens to sit in.
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, GIT_DIR: join(root, '.no-such-git') };
  const r = spawnSync(BASH, [`${root.replace(/\\/g, '/')}/${STAGER_REL}`, ...args], { cwd: root, env, encoding: 'buffer', timeout: 120000 });
  assert.equal(r.error, undefined, `could not run ${BASH}: ${r.error}`);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr.toString('utf8') };
}

test('(f1) stage-copilot-corpus.sh --list-inputs prints exactly its inputs and writes NOTHING', { skip: SKIP_BEHAVIOUR }, () => {
  // Breaks on: a listed path the stager excludes (docs/fiab/*/skip-*.md), a
  // non-root path (PRPs/other), a non-.md file, a missing input, the
  // directory-named-*.md input missing (docs/d.md: `find -name` matches it,
  // and it is exactly the case the diagnostic exists for); and on ANY write --
  // the corpus dir, a manifest, a mktemp file.
  const root = stagerFixture(['docs/d.md']);
  const tmp = mkdtempSync(join(tmpdir(), 'cc-stager-tmp-'));
  try {
    const before = snapshot(root);
    const r = runStager(root, ['--list-inputs'], tmp);
    assert.equal(r.code, 0, `--list-inputs exited ${r.code}: ${r.stderr}`);
    const listed = r.stdout.toString('utf8').split('\0').filter(Boolean).sort();
    assert.deepEqual(listed, [...EXPECTED_INPUT_FILES, 'docs/d.md'].sort());
    assert.deepEqual(snapshot(root), before, '--list-inputs changed the tree');
    assert.deepEqual(readdirSync(tmp), [], '--list-inputs wrote into $TMPDIR');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('(f2) stage-copilot-corpus.sh default mode: staged files, hashes, manifest and summary match an independent oracle', { skip: SKIP_BEHAVIOUR }, () => {
  // Breaks on any change to what the default mode stages or records: a file
  // dropped or added, a byte changed, a hash-line / manifest key losing its
  // `<destsub>/` prefix, a wrong fileCount or sourceCommit, the eval sets not
  // copied, or a changed summary line -- on a first run or a no-change rerun.
  const root = stagerFixture();
  const tmp = mkdtempSync(join(tmpdir(), 'cc-stager-tmp-'));
  try {
    const dest = join(root, CORPUS_REL);
    const hashOf = Object.fromEntries(EXPECTED_INPUT_FILES.map((p) => [p, sha256(Buffer.from(STAGER_FIXTURE_FILES[p]))]));
    const n = EXPECTED_INPUT_FILES.length;
    const check = (run, summary) => {
      const r = runStager(root, [], tmp);
      assert.equal(r.code, 0, `${run}: default mode exited ${r.code}: ${r.stderr}`);
      assert.equal(r.stdout.toString('utf8'), `${summary}\n`, `${run}: summary line`);
      const staged = Object.entries(snapshot(dest)).filter(([p, t]) => t.startsWith('f:') && !p.startsWith('.corpus-') && !p.startsWith('evals/')).map(([p]) => p).sort();
      assert.deepEqual(staged, [...EXPECTED_INPUT_FILES].sort(), `${run}: staged file set`);
      for (const p of EXPECTED_INPUT_FILES) assert.equal(readFileSync(join(dest, p), 'utf8'), STAGER_FIXTURE_FILES[p], `${run}: bytes of ${p}`);
      const tsv = readFileSync(join(dest, '.corpus-hashes.tsv'), 'utf8').split('\n').filter(Boolean).sort();
      assert.deepEqual(tsv, EXPECTED_INPUT_FILES.map((p) => `${p}\t${hashOf[p]}`).sort(), `${run}: .corpus-hashes.tsv`);
      assert.deepEqual(JSON.parse(readFileSync(join(dest, '.corpus-manifest.json'), 'utf8')), { sourceCommit: 'unknown', fileCount: n, files: hashOf }, `${run}: manifest`);
      for (const e of ['set.jsonl', '_schema.json']) {
        assert.equal(readFileSync(join(dest, 'evals', e), 'utf8'), STAGER_FIXTURE_FILES[`content/evals/${e}`], `${run}: staged eval ${e}`);
      }
    };
    const tail = '(commit unknown) → apps/fiab-console/copilot-corpus/';
    check('run 1', `staged corpus incrementally: copied=${n} skipped=0 deleted=0 total=${n} evals=2 ${tail}`);
    check('run 2 (no change)', `staged corpus incrementally: copied=0 skipped=${n} deleted=0 total=${n} evals=2 ${tail}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});
