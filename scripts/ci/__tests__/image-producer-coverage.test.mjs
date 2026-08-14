/**
 * Self-test for scripts/ci/check-image-producer-coverage.mjs.
 *
 * The guard's whole value is one distinction: a workflow that BUILDS an app
 * image versus a workflow that merely NAMES it. Every case below exists to hold
 * that line, because the permissive version of this check would have been green
 * on the tree that shipped loom-sharing with no producer at all (#2619).
 *
 * Run: node --test scripts/ci/__tests__/image-producer-coverage.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-image-producer-coverage.mjs');

/** Build a throwaway tree: { apps: [names], workflows: { name: body } }. */
function fixture({ apps = [], workflows = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'loom-img-cov-'));
  for (const a of apps) {
    mkdirSync(join(root, 'apps', a), { recursive: true });
    writeFileSync(join(root, 'apps', a, 'Dockerfile'), 'FROM scratch\n');
  }
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  for (const [name, body] of Object.entries(workflows)) {
    writeFileSync(join(root, '.github', 'workflows', name), body);
  }
  return root;
}

function run(root) {
  try {
    const stdout = execFileSync(process.execPath, [CHECKER, '--root', root], { encoding: 'utf8' });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const REAL_BUILD = (ctx) => `name: producer
on: workflow_dispatch
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: az acr build --registry "$ACR" --image x:1 ${ctx}
`;

test('an app built by a real az acr build step passes', () => {
  const root = fixture({ apps: ['alpha'], workflows: { 'p.yml': REAL_BUILD('apps/alpha') } });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok\s+alpha/);
  rmSync(root, { recursive: true, force: true });
});

test('an app no workflow mentions at all FAILS', () => {
  const root = fixture({ apps: ['alpha', 'orphan'], workflows: { 'p.yml': REAL_BUILD('apps/alpha') } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /apps\/orphan/);
  assert.match(r.out, /no workflow builds it/);
  // CONTROL: the covered sibling is still reported ok in the SAME run, so a
  // failure here cannot be an over-broad "everything is broken" verdict.
  assert.match(r.out, /ok\s+alpha/);
  rmSync(root, { recursive: true, force: true });
});

test('being named only inside an echo is NOT a build — the sharpest case', () => {
  // The path is present in the file, in a workflow that really does build
  // something. A substring match would score this as covered. #2816 is the
  // precedent: a ::warning:: string counted as a deploy path for months.
  const wf = `${REAL_BUILD('apps/alpha')}      - run: echo "build apps/ghost yourself with az acr build"\n`;
  const root = fixture({ apps: ['alpha', 'ghost'], workflows: { 'p.yml': wf } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /apps\/ghost/);
  assert.match(r.out, /only as text/);
  rmSync(root, { recursive: true, force: true });
});

test('being named only in a YAML comment is NOT a build', () => {
  const wf = `${REAL_BUILD('apps/alpha')}      # apps/ghost is built out of band\n`;
  const root = fixture({ apps: ['alpha', 'ghost'], workflows: { 'p.yml': wf } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /apps\/ghost/);
  rmSync(root, { recursive: true, force: true });
});

test('being named only inside a ::warning:: annotation is NOT a build', () => {
  const wf = `${REAL_BUILD('apps/alpha')}      - run: printf '::warning::deploy apps/ghost manually'\n`;
  const root = fixture({ apps: ['alpha', 'ghost'], workflows: { 'p.yml': wf } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /apps\/ghost/);
  rmSync(root, { recursive: true, force: true });
});

test('a workflow that names the app but never builds anything does not count', () => {
  const wf = `name: tester
on: push
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - run: node --test
        working-directory: apps/ghost
`;
  const root = fixture({ apps: ['alpha', 'ghost'], workflows: { 'p.yml': REAL_BUILD('apps/alpha'), 't.yml': wf } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /apps\/ghost/);
  // This is exactly the tree loom-sharing shipped on: a unit-test job with
  // working-directory: apps/loom-sharing, and no producer anywhere.
  assert.match(r.out, /no workflow builds it/);
  rmSync(root, { recursive: true, force: true });
});

test('docker/build-push-action counts as a producer', () => {
  const wf = `name: producer
on: push
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: docker/build-push-action@v6
        with:
          context: apps/alpha
`;
  const root = fixture({ apps: ['alpha'], workflows: { 'p.yml': wf } });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  rmSync(root, { recursive: true, force: true });
});

test('an allowlisted app that HAS become built fails as a stale entry', () => {
  // loom-onelake is in KNOWN_UNBUILT. The day someone gives it a producer the
  // entry must come out, or the allowlist stops being a record of real gaps.
  const root = fixture({ apps: ['loom-onelake'], workflows: { 'p.yml': REAL_BUILD('apps/loom-onelake') } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /STALE-ALLOW|stale/i);
  rmSync(root, { recursive: true, force: true });
});

test('an allowlisted, genuinely-unbuilt app is tolerated and reported', () => {
  const root = fixture({ apps: ['alpha', 'loom-onelake'], workflows: { 'p.yml': REAL_BUILD('apps/alpha') } });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /known-unbuilt\s+loom-onelake/);
  rmSync(root, { recursive: true, force: true });
});

test('a tree with no app Dockerfiles FAILS rather than reporting success on nothing', () => {
  const root = fixture({ apps: [], workflows: { 'p.yml': REAL_BUILD('apps/alpha') } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no apps\/<name>\/Dockerfile found/);
  rmSync(root, { recursive: true, force: true });
});

test('a tree whose workflows contain no build invocation FAILS rather than passing everything', () => {
  // If the build matcher ever drifts from how the repo builds images, this must
  // be loud. Silently finding zero builders would mark every app UNBUILT, or —
  // worse in a future refactor — mark none of them checked.
  const wf = 'name: nothing\non: push\njobs:\n  n:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';
  const root = fixture({ apps: ['alpha'], workflows: { 'p.yml': wf } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no workflow contains an image-build invocation/);
  rmSync(root, { recursive: true, force: true });
});

// ── LOGICAL LINES (#3420 / #3427) ───────────────────────────────────────────
// #3427 declared this guard PHYSICAL-LINES-OK on the grounds that its predicates
// are single-token PRESENCE. `isBuildReference` is not: it discards a line
// carrying `echo`, and a folded command routinely puts its own failure message
// on the same physical line as the build context. The scanner now folds and
// scopes the prose test to the text BEFORE the match; these hold both halves.

test('a build whose context shares a physical line with its own `|| echo` still counts', () => {
  const folded = `name: producer
on: workflow_dispatch
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: |
          az acr build --registry "$ACR" --image x:1 \\
            apps/alpha || echo "::error::apps/alpha build failed"
`;
  const root = fixture({ apps: ['alpha'], workflows: { 'p.yml': folded } });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok\s+alpha\s+p\.yml/);
  rmSync(root, { recursive: true, force: true });
});

test('an echo folded across two lines is still prose, not a build', () => {
  const foldedEcho = `name: producer
on: workflow_dispatch
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "nothing here builds \\
            apps/alpha yet"
          az acr build --registry "$ACR" --image o:1 apps/other
`;
  const root = fixture({ apps: ['alpha', 'other'], workflows: { 'p.yml': foldedEcho } });
  const r = run(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /UNBUILT\s+alpha/);
  rmSync(root, { recursive: true, force: true });
});
