/**
 * internal-token single-writer guard (#3056).
 *
 * ── WHAT IT ENFORCES ─────────────────────────────────────────────────────────
 * The shared internal trust token has ONE owner: the live estate's
 * `loom-internal-token` Container Apps secret. bicep ADOPTS that value; it does
 * not mint one on an estate that already has a console. Two invariants keep
 * that true, and both are easy to undo by accident, so they are asserted here:
 *
 *  R1. `admin-plane/main.bicep` computes `loomInternalToken` from
 *      `loomInternalTokenValue` when supplied, falling back to the derived guid
 *      only when it is empty. If someone reverts that to a bare
 *      `guid(loomGeneratedSecretSeed, …)`, every deploy silently re-mints the
 *      token again — the exact defect that broke the estate three times in two
 *      days.
 *
 *  R2. Every workflow that runs `az deployment sub create` on
 *      `platform/fiab/bicep/main.bicep` first resolves the live value
 *      (`resolve-internal-token.sh`) AND passes `loomInternalTokenValue`. A
 *      deploy lane that skips either half is a lane that clobbers.
 *
 * ── WHY A STATIC GUARD AT ALL ────────────────────────────────────────────────
 * The live drift guard (loom-internal-token-drift.yml) catches divergence AFTER
 * a deploy has already caused it. This one refuses to merge the change that
 * would cause it. They are complements, not duplicates: the estate-side guard
 * cannot run on a PR, and this one cannot see a hand-run `az deployment`.
 *
 * Mutation-proven in scripts/ci/__tests__/internal-token-single-writer.test.mjs:
 * strip the adopt step from a deploy lane, or revert the bicep var, and the
 * corresponding assertion goes red.
 *
 * Usage: node scripts/ci/check-internal-token-single-writer.mjs [repo-root]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The bicep module that owns the token expression. */
export const OWNER_BICEP = 'platform/fiab/bicep/modules/admin-plane/main.bicep';
/** The shared existing-value lookup every deploy lane must call. */
export const RESOLVER = 'scripts/csa-loom/resolve-internal-token.sh';
/** The ARM parameter that carries the adopted value. */
export const ADOPT_PARAM = 'loomInternalTokenValue';

/**
 * R1 — the bicep var must be conditional on the adopted value, not a bare mint.
 * @param {string} src contents of admin-plane/main.bicep
 * @returns {string[]} failures
 */
export function checkBicepAdopts(src) {
  const fail = [];
  const assign = src.match(/^var loomInternalToken\s*=([\s\S]*?)(?=\n(?:var|param|resource|module|output|@)\s)/m);
  if (!assign) {
    fail.push(
      `${OWNER_BICEP}: could not find the \`var loomInternalToken =\` assignment. ` +
        'This guard cannot verify what it cannot find, and a guard that silently passes when its ' +
        'target moved is worse than no guard. Update the guard alongside the rename.',
    );
    return fail;
  }
  const expr = assign[1];
  if (!expr.includes(ADOPT_PARAM)) {
    fail.push(
      `${OWNER_BICEP}: \`loomInternalToken\` no longer reads \`${ADOPT_PARAM}\`, so every deploy MINTS a ` +
        'new trust token. `loomGeneratedSecretSeed` defaults to newGuid() — the compiled template carries ' +
        '"defaultValue": "[newGuid()]" — so the value changes on every deployment and every holder outside ' +
        'that deployment (the consumer jobs, the LOOM_INTERNAL_TOKEN GitHub secret) is silently invalidated. ' +
        'That is #3056. Restore the adopt-or-mint form.',
    );
  }
  if (!/empty\(\s*loomInternalTokenValue\s*\)/.test(expr)) {
    fail.push(
      `${OWNER_BICEP}: \`loomInternalToken\` must fall back to a minted guid ONLY when ${ADOPT_PARAM} is ` +
        'empty (the greenfield case). Without the empty() guard a day-one deploy has no token at all and ' +
        'isValidInternalToken() fails closed on every internal callback (the #3089 class).',
    );
  }
  return fail;
}

/**
 * Strip whole-line comments before matching.
 *
 * Measured on the first run of this guard: it flagged `deploy.yml` and
 * `full-app-deploy-commercial.yml`, and BOTH were false positives from prose.
 * `deploy.yml` deploys `deploy/bicep/landing-zone-alz/main.bicep` and only
 * mentions the platform template in a header comment; `full-app-deploy-commercial.yml`
 * contains the sentence "this deliberately does NOT run `az deployment sub create`".
 * A guard that fires on a comment teaches people to ignore it, so the match is
 * made against executable lines only — the same comment-stripping discipline the
 * ratchet guard already uses.
 *
 * @param {string} src
 * @returns {string} src with `#`-comment lines removed
 */
export function stripCommentLines(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/**
 * Does this workflow actually APPLY the platform template (as opposed to
 * merely mentioning it)? Requires `--template-file` and the platform path on
 * the SAME executable line, plus a real `az deployment sub create`.
 *
 * @param {string} src workflow contents
 * @returns {boolean}
 */
export function appliesPlatformTemplate(src) {
  const code = stripCommentLines(src);
  if (!/az deployment sub create/.test(code)) return false;
  return code
    .split('\n')
    .some((l) => l.includes('--template-file') && l.includes('platform/fiab/bicep/main.bicep'));
}

/**
 * R2 — every lane that applies main.bicep must resolve AND pass the value.
 * @param {string} name workflow filename
 * @param {string} src workflow contents
 * @returns {string[]} failures
 */
export function checkDeployLane(name, src) {
  const fail = [];
  if (!appliesPlatformTemplate(src)) return fail;

  const code = stripCommentLines(src);
  if (!code.includes(RESOLVER)) {
    fail.push(
      `${name} applies platform/fiab/bicep/main.bicep but never calls ${RESOLVER}. ` +
        'It therefore deploys with no adopted token and bicep re-mints one, stranding the consumer jobs ' +
        'and the LOOM_INTERNAL_TOKEN GitHub secret (#3056).',
    );
  }
  if (!code.includes(ADOPT_PARAM)) {
    fail.push(
      `${name} applies platform/fiab/bicep/main.bicep but never passes \`${ADOPT_PARAM}\`. ` +
        'Resolving the live value and then not passing it is the same clobber with extra steps.',
    );
  }
  return fail;
}

/** @param {string} root repo root */
export function run(root) {
  const failures = [];

  failures.push(...checkBicepAdopts(readFileSync(resolve(root, OWNER_BICEP), 'utf8')));

  const wfDir = resolve(root, '.github/workflows');
  const lanes = readdirSync(wfDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  let checked = 0;
  for (const f of lanes) {
    const src = readFileSync(join(wfDir, f), 'utf8');
    if (appliesPlatformTemplate(src)) checked += 1;
    failures.push(...checkDeployLane(f, src));
  }

  // A guard that inspected ZERO deploy lanes has measured nothing. Fail rather
  // than print a green line over an empty set.
  if (checked === 0) {
    failures.push(
      'No workflow was found that applies platform/fiab/bicep/main.bicep. Either the deploy lanes moved ' +
        '(update this guard) or the glob is wrong — either way this run verified nothing.',
    );
  }

  return { failures, checked };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  const root = process.argv[2] || process.cwd();
  const { failures, checked } = run(root);
  if (failures.length > 0) {
    for (const f of failures) console.error(`[internal-token-single-writer] FAIL — ${f}`);
    console.error(
      '[internal-token-single-writer] See docs/fiab/runbooks/internal-token-ownership.md for the ownership model.',
    );
    process.exit(1);
  }
  console.log(
    `[internal-token-single-writer] PASS — bicep adopts the estate value; ${checked} deploy lane(s) resolve and pass it.`,
  );
}
