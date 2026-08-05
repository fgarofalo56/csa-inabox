#!/usr/bin/env node
/**
 * full-app-deploy-commercial.yml — the three lists that must agree. (refs #2958)
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * That workflow is the Commercial image producer named by no-vaporware.md as
 * step 2 of the from-scratch path. Whether it actually produces what the deploy
 * needs is decided by three lists that live in three different places and were
 * maintained BY HAND:
 *
 *   1. the `build` job's matrix          — what gets built
 *   2. the `verify-images` job's APPS=() — what gets signature-verified
 *   3. the deploy contract, derived from params/commercial.bicepparam by
 *      scripts/ci/resolve-image-preflight-refs.mjs — what the deploy PULLS
 *
 * Every drift between them has already happened at least once:
 *
 *   • (3) but not (1): `loom-script-runner` is declared in the paramfile with a
 *     `v0.1` default and NOTHING in .github/workflows ever built it. It is in
 *     the live registry only because it was pushed out of band, so a genuine
 *     from-scratch estate could never produce it.
 *   • (1) but not (2): `loom-duckdb` joined the matrix on 2026-07-23 and the
 *     hand-copied APPS=() list is the only thing that decides whether the
 *     signature gate looks at it.
 *   • (1) with the wrong TAG: the matrix built `:$TAG` from the `tag` input and
 *     never stamped the contract tag, so `loom-duckdb:v0.1` did not exist even
 *     though every one of its builds succeeded.
 *
 * A comment saying "keep in sync" is not a control. This is.
 *
 * Run: node scripts/ci/check-full-app-deploy-contract.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = path.join(
  REPO_ROOT,
  '.github',
  'workflows',
  'full-app-deploy-commercial.yml',
);

/**
 * Apps in the `build` job matrix — `- app: <name>` lines.
 * @param {string} src workflow yaml
 * @returns {string[]}
 */
export function parseMatrixApps(src) {
  return [...String(src).matchAll(/^\s*-\s*app:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

/**
 * Apps in the verify-images `APPS=( … )` bash array.
 * @param {string} src workflow yaml
 * @returns {string[]}
 */
export function parseVerifyApps(src) {
  const m = String(src).match(/^\s*APPS=\(([^)]*)\)/m);
  if (!m) return [];
  return m[1].split(/\s+/).filter(Boolean);
}

/**
 * @param {object} o
 * @param {string} o.workflowSrc
 * @param {string[]} o.contractRepos repos the deploy will pull (repo, not repo:tag)
 * @returns {string[]} human-readable problems; empty means consistent
 */
export function findDrift({ workflowSrc, contractRepos }) {
  const matrix = parseMatrixApps(workflowSrc);
  const verify = parseVerifyApps(workflowSrc);
  const problems = [];

  if (matrix.length === 0) problems.push('build matrix has no `- app:` entries — the parser or the workflow changed shape');
  if (verify.length === 0) problems.push('verify-images has no APPS=( … ) array — the parser or the workflow changed shape');

  for (const app of matrix) {
    if (!verify.includes(app)) {
      problems.push(
        `${app} is BUILT by the matrix but absent from verify-images APPS=() — its image would ship without a signature check`,
      );
    }
  }
  for (const app of verify) {
    if (!matrix.includes(app)) {
      problems.push(
        `${app} is in verify-images APPS=() but NOT in the build matrix — the gate is verifying an image this workflow does not produce`,
      );
    }
  }
  for (const repo of contractRepos) {
    if (!matrix.includes(repo)) {
      problems.push(
        `${repo} is in the DEPLOY CONTRACT (params/commercial.bicepparam declares its tag, so an apps-enabled deploy pulls it) but NO matrix entry builds it — a from-scratch estate could never produce this image`,
      );
    }
  }
  return problems;
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const { resolveRefs } = await import('./resolve-image-preflight-refs.mjs');
  const paramSrc = readFileSync(
    path.join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'params', 'commercial.bicepparam'),
    'utf8',
  );
  // env:{} on purpose — the contract is the PARAMFILE DEFAULT set, i.e. what a
  // from-scratch estate (nothing running, so no reconcile pin) would pull.
  const { refs } = resolveRefs({ paramSrc, env: {}, boundary: 'commercial' });
  const contractRepos = refs.map((r) => r.slice(0, r.lastIndexOf(':')));

  const problems = findDrift({
    workflowSrc: readFileSync(WORKFLOW, 'utf8'),
    contractRepos,
  });

  if (problems.length) {
    console.error('full-app-deploy-commercial image lists are INCONSISTENT:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nFix the workflow (add the matrix entry / the APPS=() entry), or change the ' +
        'paramfile if the deploy genuinely does not pull that image.',
    );
    process.exit(1);
  }
  console.log(
    `full-app-deploy-commercial: build matrix, verify-images APPS=(), and the ${contractRepos.length}-image deploy contract all agree.`,
  );
}
