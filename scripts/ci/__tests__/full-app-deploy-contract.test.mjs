/**
 * Tests for the controls around the full-app-deploy-commercial repair
 * (refs #2958) and its SC1 scoping fix (refs #3035):
 *
 *   scripts/ci/check-full-app-deploy-contract.mjs
 *   scripts/ci/deploy-image-roles.mjs      (see also deploy-image-roles.test.mjs)
 *   apps/fiab-console/scripts/assert-uat-supply-chain.mjs
 *
 * All are guards, so the tests are written the way a guard has to be proven:
 * each one drives the FAILING branch as well as the passing one. A guard whose
 * test only exercises the happy path is a guard that can silently stop
 * measuring — the exact class this repo keeps getting burned by.
 *
 * Run: node --test scripts/ci/__tests__/full-app-deploy-contract.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMatrixApps,
  parseJobBlock,
  parseJobApps,
  findDrift,
} from '../check-full-app-deploy-contract.mjs';
import {
  tarVersionIsPatched,
  findVendoredNpmTar,
  assertSupplyChain,
  MIN_TAR,
} from '../../../apps/fiab-console/scripts/assert-uat-supply-chain.mjs';

// The workflow is CRLF in a Windows checkout and LF on a hosted runner. A
// parser that only handles one is a parser that passes locally and measures
// nothing in CI (or the reverse), so every parse case is driven both ways.
const withEol = (s, eol) => s.replace(/\n/g, eol);

const RESOLVER_CALL =
  'node scripts/ci/deploy-image-roles.mjs --print verify-set --contract-refs "$CONTRACT_REFS"';

const WORKFLOW_FIXTURE = [
  '',
  'jobs:',
  '  build:',
  '    strategy:',
  '      matrix:',
  '        include:',
  '          - app: loom-console',
  '            ctx: ./apps/fiab-console',
  '          - app: loom-duckdb',
  '            ctx: ./apps/loom-duckdb',
  '          - app: loom-uat',
  '            ctx: ./apps/fiab-console',
  '            file: ./apps/fiab-console/Dockerfile.uat',
  '  verify-images:',
  '    steps:',
  '      - run: |',
  `          VERIFY_APPS=$(${RESOLVER_CALL})`,
  '          read -ra APPS <<< "$VERIFY_APPS"',
  '  redeploy-with-apps:',
  '    steps:',
  '      - run: |',
  '          APPS=(loom-console)',
  '',
].join('\n');

/** The fixture's own world: one rolled app, one declared non-roll-blocking. */
const BASE = {
  workflowSrc: WORKFLOW_FIXTURE,
  contractRepos: ['loom-console', 'loom-duckdb'],
  rollApps: ['loom-console'],
  declared: { 'loom-uat': { why: 'test image; neither rolled nor in the contract' } },
};

for (const [label, eol] of [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
]) {
  test(`parseMatrixApps reads every matrix app (${label})`, () => {
    assert.deepEqual(parseMatrixApps(withEol(WORKFLOW_FIXTURE, eol)), [
      'loom-console',
      'loom-duckdb',
      'loom-uat',
    ]);
  });

  test(`parseJobApps reads the ROLL job bash array (${label})`, () => {
    assert.deepEqual(parseJobApps(withEol(WORKFLOW_FIXTURE, eol), 'redeploy-with-apps'), [
      'loom-console',
    ]);
  });
}

test('parseJobApps is scoped to the job it names — not the first APPS=() in the file', () => {
  // REGRESSION GUARD. The pre-#3035 parser took the first `APPS=( … )` in the
  // whole file (the verify job's). Once the verify set became derived, a
  // file-wide regex would silently have started reading the ROLL job's array
  // while still calling itself the verify list — a guard whose meaning changed
  // with no visible signal. Addressing jobs explicitly is what prevents that.
  const src = WORKFLOW_FIXTURE.replace(
    '          read -ra APPS <<< "$VERIFY_APPS"',
    '          APPS=(loom-ghost)',
  );
  assert.deepEqual(parseJobApps(src, 'verify-images'), ['loom-ghost']);
  assert.deepEqual(parseJobApps(src, 'redeploy-with-apps'), ['loom-console']);
  assert.equal(parseJobApps(src, 'no-such-job'), null);
  assert.equal(parseJobBlock(src, 'no-such-job'), null);
});

test('consistent lists produce no drift', () => {
  assert.deepEqual(findDrift(BASE), []);
});

test('an image in the DEPLOY CONTRACT with no matrix entry is reported', () => {
  // The loom-script-runner case exactly: the paramfile declares a tag, so an
  // apps-enabled deploy pulls it, and nothing builds it.
  const problems = findDrift({
    ...BASE,
    contractRepos: [...BASE.contractRepos, 'loom-script-runner'],
  });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /loom-script-runner is in the DEPLOY CONTRACT/);
  assert.match(problems[0], /NO matrix entry builds it/);
});

test('a built image that is neither rolled, in the contract, nor DECLARED is reported', () => {
  // The default is "verify it". An image nobody can account for must not
  // silently escape the signature gate just because it left the verify set.
  const problems = findDrift({ ...BASE, declared: {} });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /^loom-uat is BUILT by the matrix but is neither rolled/);
  assert.match(problems[0], /NOT declared in NOT_ROLL_BLOCKING/);
});

test('a declaration may NOT exempt an image the roll actually ships', () => {
  // The loophole this table would otherwise be. Mutation proof (a).
  const problems = findDrift({
    ...BASE,
    declared: { ...BASE.declared, 'loom-console': { why: 'pretend it is not rolled' } },
  });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /loom-console is declared in NOT_ROLL_BLOCKING/);
  assert.match(problems[0], /but it IS ROLLED by redeploy-with-apps/);
});

test('a declaration may NOT exempt an image the apps-enabled deploy pulls', () => {
  const problems = findDrift({
    ...BASE,
    declared: { ...BASE.declared, 'loom-duckdb': { why: 'pretend it is not pulled' } },
  });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /but it IS in the DEPLOY CONTRACT/);
});

test('a DEAD declaration (no matrix entry produces it) is reported', () => {
  const problems = findDrift({
    ...BASE,
    declared: { ...BASE.declared, 'loom-ghost': { why: 'nothing builds this' } },
  });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(
    problems[0],
    /loom-ghost is declared in NOT_ROLL_BLOCKING but NO build-matrix entry/,
  );
});

test('the ROLL SET growing without ROLL_APPS following is reported', () => {
  // The direction that matters: the roll starts shipping an image and the
  // derived verify set does not follow. The pre-#3035 guard could not have
  // noticed this at all — it never read the roll job.
  const src = WORKFLOW_FIXTURE.replace(
    'APPS=(loom-console)',
    'APPS=(loom-console loom-uat)',
  );
  const problems = findDrift({ ...BASE, workflowSrc: src });
  assert.ok(
    problems.some((p) =>
      /^loom-uat is ROLLED by redeploy-with-apps but is absent from ROLL_APPS/.test(p),
    ),
    problems.join('\n'),
  );
});

test('ROLL_APPS drifting AHEAD of the workflow is reported', () => {
  const problems = findDrift({ ...BASE, rollApps: ['loom-console', 'loom-duckdb'] });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(
    problems[0],
    /loom-duckdb is listed in ROLL_APPS but redeploy-with-apps does NOT roll it/,
  );
});

test('re-hard-coding the verify list is reported', () => {
  const src = WORKFLOW_FIXTURE.replace(
    '          read -ra APPS <<< "$VERIFY_APPS"',
    '          APPS=(loom-console loom-duckdb loom-uat)',
  );
  const problems = findDrift({ ...BASE, workflowSrc: src });
  assert.ok(
    problems.some((p) => /verify-images contains a hard-coded APPS=/.test(p)),
    problems.join('\n'),
  );
});

test('a verify job that does not invoke the resolver is reported', () => {
  const src = WORKFLOW_FIXTURE.replace(RESOLVER_CALL, 'echo hello');
  const problems = findDrift({ ...BASE, workflowSrc: src });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /does not invoke .*deploy-image-roles\.mjs --print verify-set/);
});

test('a workflow the parsers cannot read FAILS rather than passing empty', () => {
  // UNKNOWN is not a pass. If the workflow changes shape, an empty parse must
  // be loud — otherwise this guard silently starts comparing [] with [].
  const problems = findDrift({ ...BASE, workflowSrc: 'jobs: {}' });
  // 3 shape failures, plus both contract repos reported as unbuildable — an
  // unreadable workflow is maximally loud, which is the point.
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.match(problems.join('\n'), /build matrix has no/);
  assert.match(problems.join('\n'), /redeploy-with-apps has no APPS=/);
  assert.match(problems.join('\n'), /verify-images job not found/);
});

// ── assert-uat-supply-chain ────────────────────────────────────────────────

test('MIN_TAR is the CVE-2026-59873 fixed version', () => {
  assert.deepEqual(MIN_TAR, [7, 5, 19]);
});

test('tarVersionIsPatched is exact at the boundary', () => {
  // 6.2.1 is what the 2026-07-31 scan of loom-uat actually found, twice.
  assert.equal(tarVersionIsPatched('6.2.1'), false);
  assert.equal(tarVersionIsPatched('7.5.18'), false);
  assert.equal(tarVersionIsPatched('7.5.19'), true); // pnpm 10.34.5
  assert.equal(tarVersionIsPatched('7.5.22'), true); // pnpm 11.20.0
  assert.equal(tarVersionIsPatched('7.6.0'), true);
  assert.equal(tarVersionIsPatched('8.0.0'), true);
  assert.equal(tarVersionIsPatched('nonsense'), false);
  assert.equal(tarVersionIsPatched('7.5'), false);
});

/** Minimal fake FS: a map of dir -> child directory names. */
function fakeReaddir(tree) {
  return (dir) => {
    const children = tree[dir];
    if (!children) throw new Error(`ENOENT: ${dir}`);
    return children.map((name) => ({ name, isDirectory: () => true }));
  };
}

test('findVendoredNpmTar walks and finds npm’s vendored copy', () => {
  const tree = {
    '/usr/lib/node_modules': ['npm', 'pnpm'],
    '/usr/lib/node_modules/npm': ['node_modules'],
    '/usr/lib/node_modules/npm/node_modules': ['tar', 'chalk'],
    '/usr/lib/node_modules/npm/node_modules/tar': [],
    '/usr/lib/node_modules/npm/node_modules/chalk': [],
    '/usr/lib/node_modules/pnpm': [],
  };
  assert.deepEqual(findVendoredNpmTar('/usr/lib/node_modules', { readdirSync: fakeReaddir(tree) }), [
    '/usr/lib/node_modules/npm/node_modules/tar',
  ]);
});

test('findVendoredNpmTar returns nothing once npm is removed', () => {
  const tree = { '/usr/lib/node_modules': ['pnpm'], '/usr/lib/node_modules/pnpm': [] };
  assert.deepEqual(findVendoredNpmTar('/usr/lib/node_modules', { readdirSync: fakeReaddir(tree) }), []);
});

const ROOT = '/usr/lib/node_modules';
const PNPM_TAR = `${ROOT}/pnpm/dist/node_modules/tar/package.json`;
const cleanTree = { [ROOT]: ['pnpm'], [`${ROOT}/pnpm`]: [] };

test('assertSupplyChain passes on pnpm 10 + npm removed', () => {
  const r = assertSupplyChain(ROOT, {
    readFileSync: (p) => {
      assert.equal(p, PNPM_TAR);
      return JSON.stringify({ version: '7.5.19' });
    },
    readdirSync: fakeReaddir(cleanTree),
  });
  assert.deepEqual(r, { ok: true, tar: '7.5.19' });
});

test('assertSupplyChain FAILS on the pnpm 9 vendored tar (the finding)', () => {
  const r = assertSupplyChain(ROOT, {
    readFileSync: () => JSON.stringify({ version: '6.2.1' }),
    readdirSync: fakeReaddir(cleanTree),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /vendors node-tar 6\.2\.1/);
  assert.match(r.error, /CVE-2026-59873/);
});

test('assertSupplyChain FAILS when npm survived the rm', () => {
  const tree = {
    [ROOT]: ['npm', 'pnpm'],
    [`${ROOT}/npm`]: ['node_modules'],
    [`${ROOT}/npm/node_modules`]: ['tar'],
    [`${ROOT}/npm/node_modules/tar`]: [],
    [`${ROOT}/pnpm`]: [],
  };
  const r = assertSupplyChain(ROOT, {
    readFileSync: () => JSON.stringify({ version: '7.5.19' }),
    readdirSync: fakeReaddir(tree),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /npm was not removed/);
});

test('assertSupplyChain treats an UNREADABLE layout as a failure, not a pass', () => {
  const r = assertSupplyChain(ROOT, {
    readFileSync: () => {
      throw new Error('ENOENT: no such file or directory');
    },
    readdirSync: fakeReaddir(cleanTree),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot read pnpm/);
  assert.match(r.error, /layout changed/);
});
