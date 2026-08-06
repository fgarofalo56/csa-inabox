#!/usr/bin/env node
/**
 * full-app-deploy-commercial.yml — the lists that must agree. (refs #2958, #3035)
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * That workflow is the Commercial image producer named by no-vaporware.md as
 * step 2 of the from-scratch path. Whether it actually produces — and proves —
 * what the deploy needs is decided by lists that live in different places and
 * were maintained BY HAND:
 *
 *   1. the `build` job's matrix               — what gets built
 *   2. the `verify-images` job's set          — what gets signature-verified
 *   3. the `redeploy-with-apps` job's APPS=() — what gets ROLLED
 *   4. the deploy contract, derived from params/commercial.bicepparam by
 *      scripts/ci/resolve-image-preflight-refs.mjs — what the deploy PULLS
 *
 * Every drift between them has already happened at least once:
 *
 *   • (4) but not (1): `loom-script-runner` is declared in the paramfile with a
 *     `v0.1` default and NOTHING in .github/workflows ever built it. It is in
 *     the live registry only because it was pushed out of band, so a genuine
 *     from-scratch estate could never produce it.
 *   • (1) but not (2): `loom-duckdb` joined the matrix on 2026-07-23 and the
 *     hand-copied APPS=() list was the only thing that decided whether the
 *     signature gate looked at it.
 *   • (1) with the wrong TAG: the matrix built `:$TAG` from the `tag` input and
 *     never stamped the contract tag, so `loom-duckdb:v0.1` did not exist even
 *     though every one of its builds succeeded.
 *
 * ── THE INVARIANT THIS FILE ENFORCED, AND WHY IT WAS WRONG (#3035) ─────────
 * It used to enforce (1) == (2): the build matrix and the verify list must be
 * EQUAL. That is not the property that matters, and enforcing it caused a P0.
 * Equality forced `loom-uat` — a Playwright test image that is neither rolled
 * nor pulled by the apps-enabled deploy — into the gate that blocks the roll.
 * On 2026-08-05 run 31066164706 a single Trivy CRITICAL in that test image left
 * it unsigned, the SC1 gate failed with "unsigned image(s): loom-uat. The roll
 * job is BLOCKED", and `redeploy-with-apps` was SKIPPED: 20 green jobs and not
 * one Container App moved.
 *
 * The correct invariant is a SUPERSET, not an equality:
 *
 *     verify-set  ⊇  roll-set  ∪  deploy-contract
 *
 * with every built image outside that set explicitly DECLARED in
 * scripts/ci/deploy-image-roles.mjs `NOT_ROLL_BLOCKING`, and a declaration
 * unable to exempt anything that is rolled or in the contract. Weaker only
 * where it was wrong; strictly stronger where it counts — the old equality
 * check could not have noticed the ROLL SET growing at all, because it never
 * read the roll set.
 *
 * A comment saying "keep in sync" is not a control. This is.
 *
 * Run: node scripts/ci/check-full-app-deploy-contract.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ROLL_APPS,
  NOT_ROLL_BLOCKING,
  classifyMatrix,
} from './deploy-image-roles.mjs';

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
 * Slice one top-level job out of the workflow.
 *
 * WHY BY JOB, AND NOT BY A REGEX ACROSS THE WHOLE FILE. The previous parser
 * took the FIRST `APPS=( … )` in the file, which happened to be the verify
 * job's. Deriving the verify set removes that array — and a file-wide regex
 * would then have silently started reading the ROLL job's array and comparing
 * it against the build matrix. That is a guard whose MEANING changes while its
 * name, its call site and its result all stay the same. Jobs are addressed
 * explicitly so that cannot happen.
 *
 * @param {string} src workflow yaml
 * @param {string} jobName top-level job key (2-space indent)
 * @returns {string|null} the job's yaml block, or null if absent
 */
export function parseJobBlock(src, jobName) {
  const lines = String(src).split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^ {2}${jobName}:\\s*$`).test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * The `APPS=( … )` bash array inside a given job.
 * @param {string} src workflow yaml
 * @param {string} jobName
 * @returns {string[]|null} null when the job or the array is absent
 */
export function parseJobApps(src, jobName) {
  const block = parseJobBlock(src, jobName);
  if (block === null) return null;
  const m = block.match(/^\s*APPS=\(([^)]*)\)/m);
  if (!m) return null;
  return m[1].split(/\s+/).filter(Boolean);
}

/**
 * @param {object} o
 * @param {string} o.workflowSrc
 * @param {string[]} o.contractRepos repos the deploy will pull (repo, not repo:tag)
 * @param {ReadonlyArray<string>} [o.rollApps]
 * @param {Readonly<Record<string,{why:string,consumedBy?:string}>>} [o.declared]
 * @returns {string[]} human-readable problems; empty means consistent
 */
export function findDrift({
  workflowSrc,
  contractRepos,
  rollApps = ROLL_APPS,
  declared = NOT_ROLL_BLOCKING,
}) {
  const matrix = parseMatrixApps(workflowSrc);
  const workflowRoll = parseJobApps(workflowSrc, 'redeploy-with-apps');
  const verifyBlock = parseJobBlock(workflowSrc, 'verify-images');
  const problems = [];

  // UNKNOWN is never a pass. If the workflow changes shape, an unparseable
  // input must be LOUD — otherwise this guard silently compares [] with [].
  if (matrix.length === 0) {
    problems.push(
      'build matrix has no `- app:` entries — the parser or the workflow changed shape',
    );
  }
  if (workflowRoll === null) {
    problems.push(
      'redeploy-with-apps has no APPS=( … ) array — the parser or the workflow changed ' +
        'shape, so the ROLL SET cannot be read and nothing below can be trusted',
    );
  }
  if (verifyBlock === null) {
    problems.push(
      'verify-images job not found — the parser or the workflow changed shape',
    );
  }

  // The array in the workflow IS the roll set. ROLL_APPS must mirror it exactly
  // or the derived verify set is describing a roll that is not the one running.
  if (workflowRoll) {
    for (const app of workflowRoll) {
      if (!rollApps.includes(app)) {
        problems.push(
          `${app} is ROLLED by redeploy-with-apps but is absent from ROLL_APPS in ` +
            `scripts/ci/deploy-image-roles.mjs — the SC1 verify set is derived from ` +
            `ROLL_APPS, so the roll would ship an image whose signature nothing checked`,
        );
      }
    }
    for (const app of rollApps) {
      if (!workflowRoll.includes(app)) {
        problems.push(
          `${app} is listed in ROLL_APPS but redeploy-with-apps does NOT roll it — ` +
            `ROLL_APPS has drifted from the workflow it claims to describe`,
        );
      }
    }
  }

  // The verify set must be DERIVED. A re-hardcoded array is the exact defect
  // #3035 removed, and re-introducing one would re-open it silently.
  if (verifyBlock) {
    if (/^\s*APPS=\(/m.test(verifyBlock)) {
      problems.push(
        'verify-images contains a hard-coded APPS=( … ) array again — the roll-blocking ' +
          'verify set MUST be derived from scripts/ci/deploy-image-roles.mjs so it follows ' +
          'the roll set and the deploy contract automatically (refs #3035)',
      );
    }
    if (!verifyBlock.includes('deploy-image-roles.mjs --print verify-set')) {
      problems.push(
        'verify-images does not invoke `scripts/ci/deploy-image-roles.mjs --print ' +
          'verify-set` — the derivation this guard checks is not the one the workflow runs',
      );
    }
  }

  // verify-set ⊇ roll-set ∪ contract, every other built image DECLARED, and no
  // declaration able to exempt something the deploy actually ships.
  if (matrix.length > 0 && contractRepos.length > 0) {
    const { problems: classifyProblems } = classifyMatrix({
      matrixApps: matrix,
      contractRepos,
      rollApps,
      declared,
    });
    problems.push(...classifyProblems);
  }

  // An image the deploy pulls that nothing builds: a from-scratch estate could
  // never produce it. (The loom-script-runner case, unchanged.)
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
      '\nFix the workflow (add the matrix entry / the ROLL_APPS entry), declare the image ' +
        'in NOT_ROLL_BLOCKING with a recorded reason, or change the paramfile if the deploy ' +
        'genuinely does not pull that image.',
    );
    process.exit(1);
  }
  const excluded = Object.keys(NOT_ROLL_BLOCKING);
  console.log(
    `full-app-deploy-commercial: build matrix, the ${ROLL_APPS.length}-app roll set and the ` +
      `${contractRepos.length}-image deploy contract all agree; the SC1 verify set covers ` +
      `roll ∪ contract` +
      (excluded.length
        ? `, with ${excluded.length} declared non-roll-blocking image(s): ${excluded.join(', ')}.`
        : '.'),
  );
}
