/**
 * check-dockerfile-copy-closure self-test (#3886).
 *
 * THE BUG THIS GUARD EXISTS FOR. azure-functions/copilot-evaluator/Dockerfile
 * hand-copies individual console modules into its build context. On 2026-08-28
 * it copied the three files `src/` imports DIRECTLY, and the Gov ACR build died
 * at `RUN npm run build` with four TS2307s, because `cloud-endpoints.ts`
 * re-exports from `./cloud-boundary` and `./cloud-endpoints-graph` and neither
 * was in the context (gov-provision-runner-images run 33191237788).
 *
 * A guard for that has to (a) go RED on the real shape of the miss, (b) still
 * be red when the miss is one level DEEPER than the file that was copied, and
 * (c) refuse to go green by finding nothing. All three are proved below against
 * fixture trees driven through the REAL checker via --root, plus one mutation
 * of the actual repository tree, so nothing here re-implements the thing under
 * test.
 *
 * Run: node --test scripts/ci/__tests__/dockerfile-copy-closure.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  relativeImportsOf,
  stripJsComments,
  specifierVariants,
  resolveRelativeImport,
  evaluateDockerfile,
  scanRepo,
  isSourceFile,
} from '../check-dockerfile-copy-closure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'check-dockerfile-copy-closure.mjs');
const REPO = resolve(HERE, '..', '..', '..');

/** Build a throwaway repo root from `<repo-relative path> -> <contents>`. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'copy-closure-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

function run(root, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...extra], { encoding: 'utf8' });
}

/**
 * The evaluator's real shape, reduced: an app that copies its own `src` plus
 * named files from a sibling app, where the sibling file re-exports a THIRD
 * file. `closed` decides whether that third file is copied.
 */
function evaluatorShape({ closed }) {
  const copyChain = [
    'COPY other/lib/endpoints.ts /repo/other/lib/endpoints.ts',
    ...(closed ? ['COPY other/lib/boundary.ts /repo/other/lib/boundary.ts'] : []),
  ].join('\n');
  return {
    'app/Dockerfile': [
      'FROM node:20-bookworm-slim AS build',
      'WORKDIR /repo/app',
      'COPY app/src ./src',
      copyChain,
      'RUN npm run build',
      '',
    ].join('\n'),
    'app/src/main.ts': "import type { Cloud } from '../../other/lib/endpoints';\nexport const x: Cloud = 1;\n",
    'other/lib/endpoints.ts': "export { detect } from './boundary';\nexport type Cloud = number;\n",
    'other/lib/boundary.ts': 'export const detect = () => 1;\n',
  };
}

test('a Dockerfile whose copy list IS closed passes', () => {
  const root = fixture(evaluatorShape({ closed: true }));
  try {
    const res = run(root);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /PASS: every hand-copied source file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * THE NEGATIVE CONTROL — and it is deliberately the DEEP case, the exact shape
 * of the incident. The missing file is not imported by anything the author
 * wrote in `app/src`; it is reached only through a file they DID remember to
 * copy. A checker that reads only the app's own sources passes this tree, which
 * is why the walk is seeded with every DELIVERED source file instead. A control
 * that cannot fail is not a control: narrow that seed and this test dies.
 */
test('a copy list that is NOT closed FAILS, naming the missing file and the COPY to add', () => {
  const root = fixture(evaluatorShape({ closed: false }));
  try {
    const res = run(root);
    assert.equal(res.status, 1, `expected a non-zero exit; got ${res.status}\n${res.stdout}`);
    assert.match(res.stderr, /::error::FAIL: 1 unclosed Dockerfile copy list/);
    assert.match(res.stderr, /other\/lib\/endpoints\.ts imports "\.\/boundary"/);
    assert.match(res.stderr, /COPY other\/lib\/boundary\.ts \/repo\/other\/lib\/boundary\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The direct-import miss too — the shallower half of the same defect, from the
 * file the Dockerfile author is most likely to be looking at.
 */
test('a direct import that is never copied FAILS', () => {
  const files = evaluatorShape({ closed: true });
  files['app/src/main.ts'] =
    "import { helper } from '../../other/lib/helper';\nexport const y = helper();\n";
  files['other/lib/helper.ts'] = 'export const helper = () => 1;\n';
  const root = fixture(files);
  try {
    const res = run(root);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /other\/lib\/helper\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * COPIED IS NOT ENOUGH — IT HAS TO LAND WHERE THE IMPORT LOOKS. tsc resolves a
 * relative specifier against the importer's location in the IMAGE, so a file
 * copied to some other path satisfies a "the path appears in the Dockerfile"
 * check and still fails the build. This pins that the guard judges the in-image
 * layout, which is the whole reason it does not just grep for the filename.
 */
test('a required file copied to the WRONG image path still FAILS', () => {
  const files = evaluatorShape({ closed: false });
  files['app/Dockerfile'] = files['app/Dockerfile'].replace(
    'COPY other/lib/endpoints.ts /repo/other/lib/endpoints.ts',
    'COPY other/lib/endpoints.ts /repo/other/lib/endpoints.ts\nCOPY other/lib/boundary.ts /repo/elsewhere/boundary.ts',
  );
  const root = fixture(files);
  try {
    const res = run(root);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /nothing is delivered to \/repo\/other\/lib\/boundary\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A stage that copies the WHOLE context delivers everything, so there is no
 * closure to violate — and treating it as in scope would put this guard on the
 * console image and its ~40k-file context.
 */
test('a whole-context COPY is not in scope', () => {
  const files = evaluatorShape({ closed: false });
  files['app/Dockerfile'] = files['app/Dockerfile'].replace('COPY app/src ./src', 'COPY . .');
  const root = fixture(files);
  try {
    const res = run(root);
    // Nothing left in scope -> the population floor fires, NOT a closure failure.
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /empty population/);
    assert.doesNotMatch(res.stderr, /unclosed Dockerfile copy list/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A .dockerignore'd file is COPY'd and delivers nothing — the #2816 R4 shape. */
test('a copied file excluded by .dockerignore FAILS', () => {
  const files = evaluatorShape({ closed: true });
  files['.dockerignore'] = 'boundary.ts\n';
  const root = fixture(files);
  try {
    const res = run(root);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /excluded by \.dockerignore/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** An import that resolves to nothing at all is reported, not skipped (R1). */
test('an import that resolves to no file in the context is reported', () => {
  const files = evaluatorShape({ closed: true });
  files['other/lib/endpoints.ts'] = "export { gone } from './does-not-exist';\nexport type Cloud = number;\n";
  const root = fixture(files);
  try {
    const res = run(root);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /resolves to no file under the build context/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * THE SELF-CHECK. A guard that passes when it found nothing to check is the
 * defect class this repo keeps hitting. Point it at an empty tree and it must
 * FAIL, not report success.
 */
test('finding ZERO in-scope Dockerfiles FAILS (a guard cannot pass on nothing)', () => {
  const root = fixture({ 'README.md': 'nothing here\n' });
  try {
    const res = run(root);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /empty population/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ...and a tree that HAS the shape but walks no import edge is equally empty.
 * This is the half a "count the Dockerfiles" floor would miss.
 */
test('an in-scope Dockerfile with ZERO import edges still FAILS the floor', () => {
  const root = fixture({
    'app/Dockerfile': 'FROM node:20\nWORKDIR /repo/app\nCOPY app/src/main.ts /repo/app/src/main.ts\n',
    'app/src/main.ts': 'export const x = 1;\n',
  });
  try {
    const res = run(root);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /walked 0 relative import/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the parser's own edges ───────────────────────────────────────────────────

test('a comment or a string cannot invent an import', () => {
  const src = [
    "// import { a } from './commented-out';",
    "/* from './block-comment' */",
    "const url = 'https://example.test/not-a-comment';",
    "const talk = \"see ./docs/readme for from './fake'\";",
    "import { real } from './real';",
  ].join('\n');
  assert.deepEqual(relativeImportsOf(src), ['./real']);
});

test('stripJsComments preserves length exactly (the offset read depends on it)', () => {
  const src = "// x\nimport a from './b';\n/* y */ const s = 'q\\'q';\n`t${1}`\n";
  assert.equal(stripJsComments(src).length, src.length);
});

test('every module-graph form is picked up, and bare specifiers are not', () => {
  const src = [
    "import a from './a';",
    "export { b } from './b';",
    "import './side-effect';",
    "const c = await import('./c');",
    "const d = require('./d');",
    "import fs from 'node:fs';",
    "import lib from 'some-package';",
  ].join('\n');
  assert.deepEqual(relativeImportsOf(src).sort(), ['./a', './b', './c', './d', './side-effect']);
});

test('a NodeNext .js specifier resolves to the .ts source beside it', () => {
  const root = fixture({ 'lib/a.ts': "import './b.js';\n", 'lib/b.ts': 'export const b = 1;\n' });
  try {
    assert.deepEqual(specifierVariants('./b.js'), ['./b.js', './b.ts']);
    const hit = resolveRelativeImport('lib/a.ts', './b.js', root);
    assert.equal(hit.ctxRel, 'lib/b.ts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a .d.ts is not walked as a source file', () => {
  assert.equal(isSourceFile('x/y.d.ts'), false);
  assert.equal(isSourceFile('x/y.ts'), true);
  assert.equal(isSourceFile('x/y.json'), false);
});

// ── the real repository ──────────────────────────────────────────────────────

test('the actual repository passes, having measured a non-empty population', () => {
  const res = run(REPO);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const { inScopeCount, edges } = scanRepo(REPO);
  assert.ok(inScopeCount > 0, 'no in-scope Dockerfile found in the real repo');
  assert.ok(edges > 0, 'no import edge walked in the real repo');
});

/**
 * MUTATION AGAINST THE REAL TREE. Take the evaluator Dockerfile exactly as it
 * is on disk, delete the two COPY lines #3886 added, and confirm the checker
 * reports precisely the two modules the ACR task log named. This is the test
 * that ties the guard to the incident rather than to a fixture that resembles
 * it.
 */
test('#3886 — deleting the two closure COPYs reproduces the real ACR failure', () => {
  const rel = 'azure-functions/copilot-evaluator/Dockerfile';
  const text = readFileSync(join(REPO, rel), 'utf8');
  const mutated = text
    .split('\n')
    .filter((l) => !/^COPY apps\/fiab-console\/lib\/azure\/cloud-(boundary|endpoints-graph)\.ts /.test(l))
    .join('\n');
  assert.notEqual(mutated, text, 'the two COPY lines are gone from the Dockerfile — the fix was reverted');

  const clean = evaluateDockerfile({ dockerfileRel: rel, text, root: REPO });
  assert.deepEqual(clean.problems, [], 'the Dockerfile on disk must be closed');
  assert.ok(clean.edges > 0, 'the Dockerfile on disk must walk import edges');

  const broken = evaluateDockerfile({ dockerfileRel: rel, text: mutated, root: REPO });
  assert.equal(broken.problems.length, 2, broken.problems.join('\n'));
  const joined = broken.problems.join('\n');
  // The exact two modules tsc named in run 33191237788.
  assert.match(joined, /cloud-boundary\.ts/);
  assert.match(joined, /cloud-endpoints-graph\.ts/);
});
