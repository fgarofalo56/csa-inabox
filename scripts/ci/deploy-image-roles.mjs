#!/usr/bin/env node
/**
 * deploy-image-roles.mjs — WHICH images may block the roll, and which may not.
 * (refs #2958, refs #3035)
 *
 * ── THE DEFECT THIS EXISTS TO REMOVE ───────────────────────────────────────
 * `full-app-deploy-commercial.yml`'s SC1 verify-before-roll gate carried a
 * HAND-MAINTAINED array of 17 app names under this comment:
 *
 *     # MUST stay in sync with the build matrix above — enforced by
 *     # scripts/ci/check-full-app-deploy-contract.mjs (loom-guardrails)
 *     # Verify the :TAG refs — that is exactly what the redeploy-with-apps
 *     # job rolls.
 *
 * The last sentence was FALSE, and deploy-integrity.md R7 is explicit that an
 * error/claim must not assert something the code did not establish. The
 * `redeploy-with-apps` job rolls SIX Container Apps:
 *
 *     loom-console loom-mcp loom-setup-orchestrator
 *     loom-activator loom-mirroring loom-direct-lake-shim
 *
 * The other eleven names in that array are not rolled by that job at all. Ten
 * of them are still legitimately roll-blocking for a different reason — they
 * are in the DEPLOY CONTRACT (params/commercial.bicepparam declares a tag, so
 * the apps-enabled `az deployment sub create` pulls them), and shipping an
 * unsigned one to the estate is exactly what SC1 exists to stop.
 *
 * `loom-uat` is the one name that is NEITHER, and on 2026-08-05 that cost a
 * production deploy. Run 31066164706: 20 jobs green, `loom-uat`'s build leg red
 * on a single Trivy CRITICAL (CVE-2025-68121, Go stdlib inside the
 * `@esbuild/linux-x64` binary that `pnpm install` drops into the test image),
 * so `loom-uat` was never signed, so the SC1 gate failed with
 * "unsigned image(s): loom-uat. The roll job is BLOCKED", so
 * `redeploy-with-apps` was SKIPPED and none of the six Container Apps moved.
 * A finding in a Playwright test image stopped the console from deploying.
 *
 * Worse, blocking the roll did not protect loom-uat's ACTUAL consumer either.
 * The Trivy step runs AFTER `az acr build` has already pushed `:$TAG`, `:$SHA`
 * and `:latest`, and the live `loom-uat` Container App JOB pulls `:latest` at
 * execution time. So the vulnerable manifest was in the registry and reachable
 * by its consumer regardless of what the gate did to the roll. The gate blocked
 * the thing it does not protect and did not protect the thing it does.
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 *   The roll-blocking verify set is DERIVED as
 *       ROLL_APPS  ∪  the deploy contract
 *   and any built image outside it must be DECLARED here with a recorded
 *   reason. A declaration can never remove an image that is rolled or in the
 *   contract — check-full-app-deploy-contract.mjs fails if one tries, so this
 *   table cannot become the loophole that quietly narrows the gate.
 *
 * Deriving rather than hand-copying is the property that survives an edit: add
 * a Container App to the roll, or an `appImageTags` key to the paramfile, and
 * the signature gate follows automatically. A hard-coded list is how the
 * duckdb-only Gov preflight missed four other images.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 * Nothing here excuses an image from being BUILT, SCANNED or SIGNED. Every
 * matrix entry still runs the Trivy CRITICAL gate and the cosign sign step in
 * its own build job, and a failure there still turns that job — and the whole
 * run — red. This module only decides whether that failure additionally
 * BLOCKS THE ROLL of images it is not part of.
 *
 * Run: node --test scripts/ci/__tests__/deploy-image-roles.test.mjs
 */
import { fileURLToPath } from 'node:url';

/**
 * The Container Apps `redeploy-with-apps` actually rolls
 * (`az containerapp update --image`).
 *
 * SINGLE SOURCE OF TRUTH: check-full-app-deploy-contract.mjs asserts that the
 * `APPS=( … )` array inside that job matches this list EXACTLY, both
 * directions, so the workflow and this table cannot drift.
 *
 * Verified against the live Commercial estate 2026-08-05
 * (`az containerapp list -o tsv`, rg-csa-loom-admin-centralus): all six exist
 * as Container Apps.
 *
 * @type {ReadonlyArray<string>}
 */
export const ROLL_APPS = Object.freeze([
  'loom-console',
  'loom-mcp',
  'loom-setup-orchestrator',
  'loom-activator',
  'loom-mirroring',
  'loom-direct-lake-shim',
]);

/**
 * Images the build matrix produces that are NOT roll-blocking — i.e. neither
 * rolled by `redeploy-with-apps` nor pulled by the apps-enabled deploy.
 *
 * WHY THIS IS NOT A LOOPHOLE. The same shape — an exclusion table — is how a
 * guard quietly stops measuring, so it carries the same rules the
 * DEPLOY_CONDITIONS table in resolve-image-preflight-refs.mjs carries:
 * every entry needs a check that PROVES the exclusion, the reason is recorded
 * inline, every exclusion is PRINTED at run time, an entry that IS rolled or
 * IS in the contract is a hard guard failure, a dead entry is a hard guard
 * failure, and anything not listed is verified. The default is "verify it".
 *
 * @type {Readonly<Record<string, {why: string, consumedBy: string}>>}
 */
export const NOT_ROLL_BLOCKING = Object.freeze({
  'loom-uat': {
    why:
      'Playwright/UAT runner image. It has no appImageTags key (grep loom-uat ' +
      'scripts/ci/reconcile-policy.mjs and params/commercial.bicepparam both ' +
      'return ZERO), so it is not in the deploy contract and no ' +
      '`az deployment sub create` pulls it by tag; and it is not a Container ' +
      'App (`az containerapp list` on the live Commercial estate 2026-08-05 ' +
      'returns 21 apps, none of them loom-uat), so redeploy-with-apps has ' +
      'nothing to roll. Its build job still runs the Trivy CRITICAL gate and ' +
      'cosign sign, and a failure there still fails that job and the run.',
    consumedBy:
      'the loom-uat Container App JOB (and the synthetic-monitor / ' +
      'cost-anomaly-monitor / asset-reconciler job modules), every one of ' +
      'which pins `${acr}/loom-uat:latest` and re-pulls per execution — a tag ' +
      '`az acr build` pushes BEFORE the Trivy step runs, so gating the roll on ' +
      'it never protected that path anyway.',
  },
});

/**
 * `loom-console:v0.1` -> `loom-console`. Tolerates a bare repo with no tag.
 * @param {ReadonlyArray<string>|string} refs space-separated or array
 * @returns {string[]}
 */
export function reposFromRefs(refs) {
  const list = Array.isArray(refs) ? refs : String(refs || '').split(/\s+/);
  return list
    .map((r) => String(r).trim())
    .filter(Boolean)
    .map((r) => (r.includes(':') ? r.slice(0, r.lastIndexOf(':')) : r));
}

/**
 * The roll-blocking verify set: every image whose signature must be proven
 * before `redeploy-with-apps` may run.
 *
 * FAILS CLOSED on an empty contract. An empty contract means the resolver
 * broke or the paramfile moved; narrowing the signature gate to six apps on
 * the strength of that would be a gate silently measuring less, which is the
 * exact class this repo keeps getting burned by.
 *
 * @param {object} o
 * @param {ReadonlyArray<string>} [o.rollApps]
 * @param {ReadonlyArray<string>} o.contractRepos repos (not repo:tag)
 * @returns {string[]} sorted, deduped
 */
export function resolveVerifySet({ rollApps = ROLL_APPS, contractRepos }) {
  if (!Array.isArray(contractRepos) || contractRepos.length === 0) {
    throw new Error(
      'deploy-image-roles: the deploy contract is EMPTY, so the roll-blocking ' +
        'verify set cannot be derived. Refusing to fall back to the roll set ' +
        'alone — that would silently stop verifying every image the ' +
        'apps-enabled deploy pulls.',
    );
  }
  if (!Array.isArray(rollApps) || rollApps.length === 0) {
    throw new Error(
      'deploy-image-roles: ROLL_APPS is EMPTY. The roll set is what this gate ' +
        'exists to protect; an empty one is a broken caller, not "nothing to do".',
    );
  }
  return [...new Set([...rollApps, ...contractRepos])].sort();
}

/**
 * Classify every built image and surface anything unaccounted for.
 *
 * @param {object} o
 * @param {ReadonlyArray<string>} o.matrixApps  build-matrix `- app:` entries
 * @param {ReadonlyArray<string>} o.contractRepos
 * @param {ReadonlyArray<string>} [o.rollApps]
 * @param {Readonly<Record<string,{why:string,consumedBy?:string}>>} [o.declared]
 * @returns {{verifySet:string[], excluded:Array<{app:string,why:string}>, problems:string[]}}
 */
export function classifyMatrix({
  matrixApps,
  contractRepos,
  rollApps = ROLL_APPS,
  declared = NOT_ROLL_BLOCKING,
}) {
  const problems = [];
  const excluded = [];
  const verifySet = resolveVerifySet({ rollApps, contractRepos });
  const inVerify = new Set(verifySet);
  const inRoll = new Set(rollApps);
  const inContract = new Set(contractRepos);

  // Direction that matters #1: an image the roll ships must be verified.
  // Structurally guaranteed by resolveVerifySet today — asserted anyway so a
  // future refactor of that function cannot silently drop the roll set.
  for (const app of rollApps) {
    if (!inVerify.has(app)) {
      problems.push(
        `${app} is ROLLED by redeploy-with-apps but is NOT in the derived verify set — ` +
          `the roll would ship an image whose signature was never checked`,
      );
    }
  }
  // Direction that matters #2: an image the apps-enabled deploy pulls.
  for (const repo of contractRepos) {
    if (!inVerify.has(repo)) {
      problems.push(
        `${repo} is in the DEPLOY CONTRACT but is NOT in the derived verify set — ` +
          `an apps-enabled deploy would pull an image whose signature was never checked`,
      );
    }
  }

  for (const app of matrixApps) {
    if (inVerify.has(app)) continue;
    const d = declared[app];
    if (!d || !String(d.why || '').trim()) {
      problems.push(
        `${app} is BUILT by the matrix but is neither rolled by redeploy-with-apps nor in ` +
          `the deploy contract, and it is NOT declared in NOT_ROLL_BLOCKING. Either it ships ` +
          `to the estate (add it to ROLL_APPS, or give it an appImageTags key so the contract ` +
          `covers it) or record WHY it does not — an image nobody can account for must not ` +
          `silently escape the signature gate`,
      );
      continue;
    }
    excluded.push({ app, why: d.why });
  }

  for (const [app, d] of Object.entries(declared)) {
    // The anti-loophole rule: a declaration can never remove a real dependency.
    if (inRoll.has(app) || inContract.has(app)) {
      problems.push(
        `${app} is declared in NOT_ROLL_BLOCKING ("${String(d.why).slice(0, 60)}…") but it IS ` +
          `${inRoll.has(app) ? 'ROLLED by redeploy-with-apps' : 'in the DEPLOY CONTRACT'}. ` +
          `A declaration must never exempt an image the deploy actually ships — remove the ` +
          `declaration, or remove the image from the ${inRoll.has(app) ? 'roll' : 'contract'}`,
      );
    }
    if (!matrixApps.includes(app)) {
      problems.push(
        `${app} is declared in NOT_ROLL_BLOCKING but NO build-matrix entry produces it — a dead ` +
          `declaration is how an exclusion table stops describing reality`,
      );
    }
  }

  return { verifySet, excluded, problems };
}

// ── CLI ────────────────────────────────────────────────────────────────────
// Guarded so the module can be imported by the guard + tests without running.
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const argv = process.argv.slice(2);
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const what = flagValue('--print') || 'verify-set';

  if (what === 'roll-apps') {
    for (const a of ROLL_APPS) console.log(a);
    process.exit(0);
  }

  if (what !== 'verify-set') {
    console.error(
      `deploy-image-roles: unknown --print ${what} (expected verify-set | roll-apps)`,
    );
    process.exit(2);
  }

  const contractRefs = flagValue('--contract-refs');
  if (contractRefs === undefined) {
    console.error(
      'deploy-image-roles: --contract-refs "<repo:tag …>" is required for ' +
        '--print verify-set. Pass the resolve job\'s contract_refs output.',
    );
    process.exit(2);
  }
  const contractRepos = reposFromRefs(contractRefs);
  let verifySet;
  try {
    verifySet = resolveVerifySet({ contractRepos });
  } catch (e) {
    console.error(`deploy-image-roles: ${e?.message || e}`);
    process.exit(2);
  }

  // Every exclusion is PRINTED. A gate that narrows itself silently is the
  // failure mode this whole file exists to avoid.
  console.error(
    `[deploy-image-roles] roll-blocking verify set = ${ROLL_APPS.length} rolled Container Apps ` +
      `∪ ${contractRepos.length} deploy-contract images = ${verifySet.length} images.`,
  );
  for (const [app, d] of Object.entries(NOT_ROLL_BLOCKING)) {
    console.error(
      `[deploy-image-roles]   NOT ROLL-BLOCKING  ${app} — ${d.why} Consumed by: ${d.consumedBy}`,
    );
  }

  console.log(verifySet.join(' '));
}
