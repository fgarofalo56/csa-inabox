#!/usr/bin/env node
/**
 * GUARDRAIL: bicep-sync  (merge-blocker)
 * ------------------------------------------------------------------------
 * RULE (no-vaporware.md "Bicep sync requirement"): the platform bicep must
 *   stay coherent so a from-scratch `az deployment` reproduces the running
 *   Loom. This is a lighter STRUCTURAL check with two parts:
 *
 *   1. ORPHAN MODULES — every `platform/fiab/bicep/modules/**\/*.bicep` must
 *      be invoked as a `module <name> '<path>'` from some other bicep file
 *      (transitively reachable from an entrypoint). An orphan module is dead
 *      infra that no deployment ever creates — either wire it in or delete it.
 *      Known top-level ENTRYPOINTS and intentionally-standalone modules are
 *      allowlisted below.
 *
 *   2. ENV-SYNC CORE — re-runs the read-but-not-emitted LOOM_* var scan from
 *      check-env-sync.mjs (see that file for the rule + allowlist).
 *
 * Exits 1 if there are un-allowlisted orphan modules OR any read-but-not-
 * emitted env var. Exits 0 clean.
 *
 * HOW TO ADD AN ALLOWLIST ENTRY:
 *   - Orphan: if a module is a legitimate standalone entrypoint / template
 *     invoked out-of-band (deploymentScript, pipeline, `az deployment ... -f
 *     <module>` directly), add its repo-relative POSIX path to
 *     ORPHAN_ALLOWLIST with a reason. Otherwise wire it into its orchestrator.
 *   - Env var: edit the ALLOWLIST in check-env-sync.mjs (single source).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, walk, computeMissing } from './check-env-sync.mjs';

const BICEP_ROOT = path.join(REPO_ROOT, 'platform', 'fiab', 'bicep');
const MODULES_ROOT = path.join(BICEP_ROOT, 'modules');

// Modules that are legitimately not invoked by another bicep file.
// Seeded from the current tree (2026-07): opt-in / out-of-band-deployed
// feature & RBAC modules, and modules with a tracked TODO to wire in.
const ORPHAN_ALLOWLIST = new Map([
  ['platform/fiab/bicep/modules/admin-plane/aas-adls-rbac.bicep', 'opt-in AAS→ADLS RBAC; deployed only when the AAS semantic layer is enabled'],
  ['platform/fiab/bicep/modules/admin-plane/conditional-access.bicep', 'opt-in Entra Conditional Access policy; applied out-of-band by tenant admins'],
  ['platform/fiab/bicep/modules/admin-plane/cosmos-navigator-keys-rbac.bicep', 'opt-in Cosmos navigator-keys RBAC; deployed on demand'],
  ['platform/fiab/bicep/modules/admin-plane/cost-management-rbac.bicep', 'opt-in cost-management chargeback RBAC; deployed on demand'],
  ['platform/fiab/bicep/modules/admin-plane/devcenter.bicep', 'opt-in Deployment Environments DevCenter; TODO wire into orchestrator (release-environment honest-gate documents it)'],
  ['platform/fiab/bicep/modules/admin-plane/gh-runner-job.bicep', 'standalone entrypoint: scale-to-zero self-hosted GitHub runner ACA Job, deployed out-of-band (az deployment -f gh-runner-job.bicep; its doc block shows the optional in-orchestrator wiring)'],
  ['platform/fiab/bicep/modules/shared/diagnostic-settings.bicep', 'shared scope:<resource> diagnostic-settings helper template (loom-law-monitoring runbook documents it); TODO wire callers per-resource'],
  ['platform/fiab/bicep/modules/admin-plane/mcp-catalog-app.bicep', 'opt-in MCP-catalog ACA app; deployed when the MCP catalog is enabled'],
  ['platform/fiab/bicep/modules/landing-zone/databricks-scim-bootstrap.bicep', 'opt-in Databricks SCIM bootstrap; run out-of-band during DLZ setup'],
  ['platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep', 'opt-in per-workspace identity module; deployed on demand by the workspace provisioner'],
]);

const MODULE_DECL_RE = /module\s+[A-Za-z0-9_]+\s+'([^']+)'/g;

function rel(f) {
  return path.relative(REPO_ROOT, f).split(path.sep).join('/');
}

/**
 * Strip `//` line comments so a `module x '<path>'` snippet quoted in a
 * comment (e.g. gh-runner-job.bicep's own "how to wire me" doc block) does
 * not count as a real reference. `https://` survives (preceded by `:`).
 */
function stripLineComments(src) {
  return src.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Set of absolute module paths referenced by any `module '<path>'` decl. */
function collectReferenced() {
  const referenced = new Set();
  const files = walk(BICEP_ROOT, ['.bicep']);
  for (const f of files) {
    const src = stripLineComments(fs.readFileSync(f, 'utf8'));
    let m;
    MODULE_DECL_RE.lastIndex = 0;
    while ((m = MODULE_DECL_RE.exec(src)) !== null) {
      const target = path.resolve(path.dirname(f), m[1]);
      referenced.add(target);
    }
  }
  return referenced;
}

function findOrphans() {
  const moduleFiles = walk(MODULES_ROOT, ['.bicep']);
  const referenced = collectReferenced();
  const orphans = [];
  for (const f of moduleFiles) {
    if (referenced.has(path.resolve(f))) continue;
    const r = rel(f);
    if (ORPHAN_ALLOWLIST.has(r)) continue;
    orphans.push(r);
  }
  return { total: moduleFiles.length, orphans };
}

function main() {
  let failed = false;

  // ── Part 1: orphan modules ──
  const { total, orphans } = findOrphans();
  console.log(`[bicep-sync] modules scanned: ${total}`);
  console.log(`[bicep-sync] orphan-allowlisted: ${ORPHAN_ALLOWLIST.size}`);
  console.log(`[bicep-sync] orphan modules: ${orphans.length}`);
  if (orphans.length) {
    failed = true;
    console.error('\n[bicep-sync] FAIL — these modules are never invoked by any `module` declaration');
    console.error('(dead infra a from-scratch deploy would never create):');
    for (const o of orphans) console.error(`  - ${o}`);
    console.error('\nFix: wire the module into its orchestrator (add a `module <name> \'<path>\' = {..}`');
    console.error('reference), delete it if obsolete, or — if it is a standalone entrypoint invoked');
    console.error('out-of-band — add it to ORPHAN_ALLOWLIST in scripts/ci/check-bicep-sync.mjs.');
  } else {
    console.log('[bicep-sync] OK — every module is invoked.');
  }

  // ── Part 2: env-sync core ──
  const { reads, emitted, missing } = computeMissing();
  console.log(`\n[bicep-sync] env-sync core: reads=${reads.size} emitted=${emitted.size} missing=${missing.length}`);
  if (missing.length) {
    failed = true;
    console.error('[bicep-sync] FAIL — read-but-not-emitted LOOM_* vars (see check-env-sync.mjs):');
    for (const n of missing) console.error(`  - ${n}`);
  } else {
    console.log('[bicep-sync] OK — env-sync core clean.');
  }

  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
