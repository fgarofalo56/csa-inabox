/**
 * Self-test for scripts/ci/check-image-build-context.mjs (#5171).
 *
 * Each red case is the exact defect shape that existed on main before the fix;
 * each green case is its fixed twin, so a checker that is simply always-red or
 * always-green fails one of them. Run:
 *   node --test scripts/ci/__tests__/image-build-context.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, '..', 'check-image-build-context.mjs');
const REPO = join(HERE, '..', '..', '..');

function fixture(workflows, dockerfile = 'FROM scratch\nCOPY apps/hcp/src ./src\nCOPY platform/x/ ./x/\n') {
  const root = mkdtempSync(join(tmpdir(), 'loom-img-ctx-'));
  mkdirSync(join(root, 'apps', 'hcp'), { recursive: true });
  writeFileSync(join(root, 'apps', 'hcp', 'Dockerfile'), dockerfile);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  for (const [n, b] of Object.entries(workflows)) writeFileSync(join(root, '.github', 'workflows', n), b);
  return root;
}
function run(root) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CHECKER, '--root', root], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}
function check(body, expectCode, df) {
  const root = fixture({ 'w.yml': body }, df);
  try {
    const r = run(root);
    assert.equal(r.code, expectCode, r.out);
    return r;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('RED: yaml matrix ctx bound to the app dir (the commercial defect)', () => {
  const r = check('jobs:\n  b:\n    strategy:\n      matrix:\n        include:\n          - app: hcp\n            ctx: ./apps/hcp\n', 1);
  assert.match(r.out, /hcp needs the repo root/);
});
test('GREEN: matrix ctx "." with --file is accepted', () => {
  check('jobs:\n  b:\n    strategy:\n      matrix:\n        include:\n          - app: hcp\n            ctx: .\n            file: ./apps/hcp/Dockerfile\n', 0);
});
test('RED: az acr build with trailing app-dir positional (the gov defect)', () => {
  check('steps:\n  - run: az acr build --registry "$ACR" --image "hcp:$TAG" apps/hcp\n', 1);
});
test('GREEN: az acr build --file apps/hcp/Dockerfile . is accepted', () => {
  check('steps:\n  - run: az acr build --registry "$ACR" --image "hcp:$TAG" --file apps/hcp/Dockerfile .\n', 0);
});
test('RED: the defect split over a backslash continuation is still seen (logical lines, not physical)', () => {
  check('steps:\n  - run: |\n      az acr build --registry "$ACR" \\\n        --image "hcp:$TAG" \\\n        apps/hcp\n', 1);
});
test('GREEN: the fixed build split over a backslash continuation is accepted', () => {
  check('steps:\n  - run: |\n      az acr build --registry "$ACR" \\\n        --file apps/hcp/Dockerfile \\\n        .\n', 0);
});
test('RED: JSON matrix ctx (the acr-tasks defect)', () => {
  check(`steps:\n  - run: |\n      APPS='[{"name":"hcp","ctx":"./apps/hcp"}]'\n`, 1);
});
test('GREEN: JSON matrix with ctx "." + file', () => {
  check(`steps:\n  - run: |\n      APPS='[{"name":"hcp","ctx":".","file":"./apps/hcp/Dockerfile"}]'\n`, 0);
});
test('a commented-out defective line is ignored (paired with a RED sibling above)', () => {
  check('# ctx: ./apps/hcp\njobs: {}\n', 0);
});
test('a Dockerfile with only context-relative COPYs is not root-context; with no subject the guard refuses to pass (exit 2)', () => {
  check('steps:\n  - run: az acr build --registry "$ACR" apps/hcp\n', 1, undefined); // root-context dockerfile -> red
  const r = check('steps:\n  - run: az acr build --registry "$ACR" apps/hcp\n', 2, 'FROM scratch\nCOPY src ./src\n');
  assert.match(r.out, /no root-context Dockerfile/);
});
test('the real tree passes and names loom-health-cp as root-context', () => {
  const r = run(REPO);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok\s+loom-health-cp/);
  assert.ok(existsSync(join(REPO, 'apps', 'loom-health-cp', 'Dockerfile')));
  assert.ok(readFileSync(join(REPO, 'apps', 'loom-health-cp', 'Dockerfile'), 'utf8').includes('COPY platform/'));
});
