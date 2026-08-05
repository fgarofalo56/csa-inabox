#!/usr/bin/env node
/**
 * loom-uat image — SC1 supply-chain assertion for the vendored node-tar.
 *
 * WHY THIS EXISTS
 * ---------------
 * CVE-2026-59873 (node-tar gzip-bomb DoS, fixed in tar >= 7.5.19) is a
 * CRITICAL that the SC1 Trivy gate blocks on. The 2026-07-31 scan of this
 * image (full-app-deploy-commercial run 30600236939, job 91063974555) found
 * tar 6.2.1 in TWO independent places:
 *
 *   usr/lib/node_modules/npm/node_modules/tar/package.json       (npm's copy)
 *   usr/lib/node_modules/pnpm/dist/node_modules/tar/package.json (pnpm 9's)
 *
 * Dockerfile.uat now (a) installs pnpm 10, whose vendored tar is 7.5.19, and
 * (b) deletes npm outright — nothing in this image invokes npm at run time.
 * Both of those are silent if they go wrong: a pnpm release could move or
 * downgrade its vendored copy, and an upstream base could relocate the global
 * node_modules root so the `rm -rf` hits nothing and exits 0 either way.
 *
 * So this asserts the OUTCOME rather than the action. It runs INSIDE the image
 * build, and a failure here fails the build — which is strictly better than
 * shipping the CVE and finding out from the gate 20 minutes later, and much
 * better than shipping it and having the gate not notice.
 *
 * It lives in a FILE, not an inline `node -e` / heredoc, for the reason
 * apps/loom-transform-runner/scripts/assert_security_pins.py documents: ACR
 * Tasks' classic builder does not support Dockerfile heredocs (they need
 * BuildKit) and a long escaped one-liner is unreviewable and untestable. This
 * one has a unit test — scripts/__tests__/assert-uat-supply-chain.test.mjs.
 *
 * Usage: node scripts/assert-uat-supply-chain.mjs <globalNodeModulesRoot>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Minimum node-tar that carries the CVE-2026-59873 fix. */
export const MIN_TAR = [7, 5, 19];

/**
 * @param {string} version e.g. "7.5.19"
 * @param {number[]} [min]
 * @returns {boolean} true when version >= min
 */
export function tarVersionIsPatched(version, min = MIN_TAR) {
  const got = String(version)
    .split('.')
    .map((p) => Number.parseInt(p, 10));
  if (got.length < 3 || got.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (got[i] > min[i]) return true;
    if (got[i] < min[i]) return false;
  }
  return true;
}

/**
 * Every directory under `root` whose path ends `…/npm/node_modules/tar`.
 *
 * Deliberately a real filesystem walk rather than a check of the one path we
 * expect: the point is to catch npm surviving somewhere we did not predict.
 *
 * @param {string} root
 * @param {{readdirSync?: typeof readdirSync}} [io] injectable for tests
 * @returns {string[]}
 */
export function findVendoredNpmTar(root, io = { readdirSync }) {
  const offenders = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = io.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable / missing — nothing to find here
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const p = path.posix.join(dir, entry.name);
      if (/\/npm\/node_modules\/tar$/.test(p)) offenders.push(p);
      stack.push(p);
    }
  }
  return offenders;
}

/**
 * @param {string} root global node_modules root (`npm root -g`)
 * @param {{readFileSync?: typeof readFileSync, readdirSync?: typeof readdirSync}} [io]
 * @returns {{ok: true, tar: string} | {ok: false, error: string}}
 */
export function assertSupplyChain(root, io = {}) {
  const rf = io.readFileSync || readFileSync;
  const pnpmTarJson = path.posix.join(root, 'pnpm/dist/node_modules/tar/package.json');

  let tar;
  try {
    tar = JSON.parse(rf(pnpmTarJson, 'utf8')).version;
  } catch (e) {
    // UNKNOWN is not a pass. If the layout moved, the scan result is unproven.
    return {
      ok: false,
      error:
        `cannot read pnpm's vendored node-tar at ${pnpmTarJson} ` +
        `(${e?.message || e}). pnpm's dist layout changed — re-derive the path ` +
        `and re-verify against CVE-2026-59873 before trusting this image.`,
    };
  }

  if (!tarVersionIsPatched(tar)) {
    return {
      ok: false,
      error:
        `pnpm vendors node-tar ${tar}, below ${MIN_TAR.join('.')} ` +
        `(CVE-2026-59873). Raise PNPM_VERSION in Dockerfile.uat — verified ` +
        `against registry.npmjs.org: pnpm 9.15.9 -> 6.2.1, 10.34.5 -> 7.5.19, ` +
        `11.20.0 -> 7.5.22.`,
    };
  }

  const offenders = findVendoredNpmTar(root, io.readdirSync ? io : { readdirSync });
  if (offenders.length) {
    return {
      ok: false,
      error:
        `npm was not removed — its vendored node-tar is still present at: ` +
        `${offenders.join(', ')}. The SC1 Trivy CRITICAL gate will reject this image.`,
    };
  }

  return { ok: true, tar };
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const root = process.argv[2];
  if (!root) {
    console.error('assert-uat-supply-chain: <globalNodeModulesRoot> is required');
    process.exit(2);
  }
  const result = assertSupplyChain(root);
  if (!result.ok) {
    console.error(`SC1 assertion FAILED: ${result.error}`);
    process.exit(1);
  }
  console.log(
    `SC1 ok: pnpm vendors node-tar ${result.tar} (>= ${MIN_TAR.join('.')}); npm removed from the image.`,
  );
}
