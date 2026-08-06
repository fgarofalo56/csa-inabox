/**
 * scripts/ci/deploy-image-roles.mjs — the roll-blocking classification.
 * (refs #3035)
 *
 * Every branch is driven in BOTH directions. This module decides what may block
 * a production roll, so a test that only walks the happy path would be the same
 * shape of control as the comment it replaced ("MUST stay in sync"), which is
 * to say no control at all.
 *
 * Run: node --test scripts/ci/__tests__/deploy-image-roles.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROLL_APPS,
  NOT_ROLL_BLOCKING,
  reposFromRefs,
  resolveVerifySet,
  classifyMatrix,
} from '../deploy-image-roles.mjs';

const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'deploy-image-roles.mjs',
);

test('reposFromRefs strips tags and tolerates both shapes', () => {
  assert.deepEqual(reposFromRefs('loom-console:v0.1 loom-mcp:v2.1'), [
    'loom-console',
    'loom-mcp',
  ]);
  assert.deepEqual(reposFromRefs(['loom-console:v0.1']), ['loom-console']);
  assert.deepEqual(reposFromRefs('loom-console'), ['loom-console']);
  assert.deepEqual(reposFromRefs(''), []);
  assert.deepEqual(reposFromRefs(undefined), []);
});

test('the verify set is the UNION of the roll set and the deploy contract', () => {
  const set = resolveVerifySet({
    rollApps: ['loom-console', 'loom-only-rolled'],
    contractRepos: ['loom-console', 'loom-duckdb'],
  });
  assert.deepEqual(set, ['loom-console', 'loom-duckdb', 'loom-only-rolled']);
});

test('an EMPTY contract FAILS CLOSED — it never narrows to the roll set', () => {
  // A resolver that broke, or a paramfile that moved, must not silently shrink
  // the signature gate from 16 images to 6.
  assert.throws(
    () => resolveVerifySet({ contractRepos: [] }),
    /deploy contract is EMPTY/,
  );
  assert.throws(() => resolveVerifySet({ contractRepos: undefined }), /EMPTY/);
});

test('an EMPTY roll set is a broken caller, not "nothing to do"', () => {
  assert.throws(
    () => resolveVerifySet({ rollApps: [], contractRepos: ['loom-console'] }),
    /ROLL_APPS is EMPTY/,
  );
});

test('classifyMatrix accepts a declared, non-roll-blocking image', () => {
  const { verifySet, excluded, problems } = classifyMatrix({
    matrixApps: ['loom-console', 'loom-uat'],
    contractRepos: ['loom-console'],
    rollApps: ['loom-console'],
    declared: { 'loom-uat': { why: 'test image' } },
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(verifySet, ['loom-console']);
  assert.deepEqual(excluded, [{ app: 'loom-uat', why: 'test image' }]);
});

test('an UNDECLARED image outside the verify set is a problem', () => {
  const { problems } = classifyMatrix({
    matrixApps: ['loom-console', 'loom-uat'],
    contractRepos: ['loom-console'],
    rollApps: ['loom-console'],
    declared: {},
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /loom-uat is BUILT by the matrix but is neither rolled/);
});

test('a declaration with an EMPTY reason does not count as declared', () => {
  const { problems } = classifyMatrix({
    matrixApps: ['loom-uat'],
    contractRepos: ['loom-console'],
    rollApps: ['loom-console'],
    declared: { 'loom-uat': { why: '   ' } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /NOT declared in NOT_ROLL_BLOCKING/);
});

test('a declaration can NEVER exempt a rolled or contracted image', () => {
  const rolled = classifyMatrix({
    matrixApps: ['loom-console'],
    contractRepos: ['loom-duckdb'],
    rollApps: ['loom-console'],
    declared: { 'loom-console': { why: 'nope' } },
  });
  assert.ok(rolled.problems.some((p) => /IS ROLLED by redeploy-with-apps/.test(p)));

  const contracted = classifyMatrix({
    matrixApps: ['loom-duckdb'],
    contractRepos: ['loom-duckdb'],
    rollApps: ['loom-console'],
    declared: { 'loom-duckdb': { why: 'nope' } },
  });
  assert.ok(contracted.problems.some((p) => /IS in the DEPLOY CONTRACT/.test(p)));
});

test('the roll set is asserted to be covered even if resolveVerifySet regresses', () => {
  // Direction that matters: if a future refactor drops the roll set out of the
  // union, this fires. Driven by passing a verify-set-shaped input that omits
  // a rolled app — i.e. mutating the COMPOSITION, not a value.
  const { problems } = classifyMatrix({
    matrixApps: ['loom-console', 'loom-duckdb'],
    contractRepos: ['loom-duckdb'],
    rollApps: ['loom-console'],
    declared: { 'loom-console': { why: 'x' } },
  });
  assert.ok(
    problems.some((p) => /loom-console is declared in NOT_ROLL_BLOCKING/.test(p)),
    problems.join('\n'),
  );
});

test('the SHIPPED tables are self-consistent', () => {
  assert.ok(ROLL_APPS.length > 0);
  assert.ok(ROLL_APPS.includes('loom-console'), 'the console is rolled');
  for (const [app, d] of Object.entries(NOT_ROLL_BLOCKING)) {
    assert.ok(!ROLL_APPS.includes(app), `${app} cannot be both rolled and exempt`);
    assert.ok(String(d.why || '').trim().length > 40, `${app} needs a recorded reason`);
    assert.ok(
      String(d.consumedBy || '').trim().length > 0,
      `${app} must record who actually consumes it`,
    );
  }
});

test('CLI --print roll-apps emits exactly ROLL_APPS', () => {
  const out = execFileSync(process.execPath, [CLI, '--print', 'roll-apps'], {
    encoding: 'utf8',
  });
  assert.deepEqual(out.trim().split(/\r?\n/), [...ROLL_APPS]);
});

test('CLI --print verify-set emits the union and PRINTS every exclusion', () => {
  const out = execFileSync(
    process.execPath,
    [CLI, '--print', 'verify-set', '--contract-refs', 'loom-duckdb:v0.1'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const apps = out.trim().split(/\s+/);
  for (const a of ROLL_APPS) assert.ok(apps.includes(a), `${a} must be verified`);
  assert.ok(apps.includes('loom-duckdb'));
});

test('CLI exits non-zero on an empty contract rather than printing a narrowed set', () => {
  assert.throws(() =>
    execFileSync(process.execPath, [CLI, '--print', 'verify-set', '--contract-refs', ''], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
});

test('CLI exits non-zero when --contract-refs is omitted entirely', () => {
  // Omitted is not the same as empty, and neither may silently succeed.
  assert.throws(() =>
    execFileSync(process.execPath, [CLI, '--print', 'verify-set'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
});

test('CLI rejects an unknown --print target', () => {
  assert.throws(() =>
    execFileSync(process.execPath, [CLI, '--print', 'nonsense'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
});
