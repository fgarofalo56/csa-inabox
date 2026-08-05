/**
 * Tests for the two controls added with the full-app-deploy-commercial repair
 * (refs #2958):
 *
 *   scripts/ci/check-full-app-deploy-contract.mjs
 *   apps/fiab-console/scripts/assert-uat-supply-chain.mjs
 *
 * Both are guards, so the tests are written the way a guard has to be proven:
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
  parseVerifyApps,
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

const WORKFLOW_FIXTURE = `
jobs:
  build:
    strategy:
      matrix:
        include:
          - app: loom-console
            ctx: ./apps/fiab-console
          - app: loom-duckdb
            ctx: ./apps/loom-duckdb
          - app: loom-uat
            ctx: ./apps/fiab-console
            file: ./apps/fiab-console/Dockerfile.uat
  verify-images:
    steps:
      - run: |
          APPS=(loom-console loom-duckdb loom-uat)
`;

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

  test(`parseVerifyApps reads the bash array (${label})`, () => {
    assert.deepEqual(parseVerifyApps(withEol(WORKFLOW_FIXTURE, eol)), [
      'loom-console',
      'loom-duckdb',
      'loom-uat',
    ]);
  });
}

test('consistent lists produce no drift', () => {
  assert.deepEqual(
    findDrift({
      workflowSrc: WORKFLOW_FIXTURE,
      contractRepos: ['loom-console', 'loom-duckdb'],
    }),
    [],
  );
});

test('an image in the DEPLOY CONTRACT with no matrix entry is reported', () => {
  // This is the loom-script-runner case exactly: the paramfile declares a tag,
  // so an apps-enabled deploy pulls it, and nothing builds it.
  const problems = findDrift({
    workflowSrc: WORKFLOW_FIXTURE,
    contractRepos: ['loom-console', 'loom-duckdb', 'loom-script-runner'],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /loom-script-runner is in the DEPLOY CONTRACT/);
  assert.match(problems[0], /NO matrix entry builds it/);
});

test('an image BUILT but missing from the signature list is reported', () => {
  // The loom-duckdb case: it joined the matrix 2026-07-23 and the hand-copied
  // APPS=() is the only thing deciding whether the gate looks at it.
  const src = WORKFLOW_FIXTURE.replace(
    'APPS=(loom-console loom-duckdb loom-uat)',
    'APPS=(loom-console loom-uat)',
  );
  const problems = findDrift({
    workflowSrc: src,
    contractRepos: ['loom-console', 'loom-duckdb'],
  });
  assert.deepEqual(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /loom-duckdb is BUILT by the matrix but absent from verify-images/);
});

test('a verified image that nothing builds is reported', () => {
  const src = WORKFLOW_FIXTURE.replace(
    'APPS=(loom-console loom-duckdb loom-uat)',
    'APPS=(loom-console loom-duckdb loom-uat loom-ghost)',
  );
  const problems = findDrift({ workflowSrc: src, contractRepos: [] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^loom-ghost is in verify-images APPS=\(\) but NOT in the build matrix/);
});

test('a workflow the parsers cannot read FAILS rather than passing empty', () => {
  // UNKNOWN is not a pass. If the workflow changes shape, an empty parse must
  // be loud — otherwise this guard silently starts comparing [] with [].
  const problems = findDrift({ workflowSrc: 'jobs: {}', contractRepos: [] });
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /build matrix has no/);
  assert.match(problems.join('\n'), /no APPS=/);
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
