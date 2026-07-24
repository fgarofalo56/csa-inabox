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
  ['platform/fiab/bicep/modules/admin-plane/perf-benchmarks-dcr.bicep', 'opt-in PSR-1 LoomPerf_CL Log-Analytics export (perf-benchmark trend rows); STRICTLY additive — the authoritative store is the lazily-created Cosmos perf-benchmarks container. Standalone entrypoint deployed out-of-band (main.bicep at 256-param ceiling), then LOOM_PERF_DCR_ENDPOINT/LOOM_PERF_DCR_ID set on the console app; lib/perf/perf-export.ts honest-gates to a silent no-op until both are present'],
  ['platform/fiab/bicep/modules/admin-plane/devcenter.bicep', 'opt-in Deployment Environments DevCenter; TODO wire into orchestrator (release-environment honest-gate documents it)'],
  ['platform/fiab/bicep/modules/admin-plane/event-grid-webhooks.bicep', 'opt-in outbound-webhook Event Grid transport (BR-WEBHOOK); standalone entrypoint deployed out-of-band (main.bicep at 256-param ceiling), then LOOM_EVENTGRID_TOPIC_ENDPOINT/KEY set on the console app; the webhook-emitter honest-gates to direct HTTPS until both are present'],
  ['platform/fiab/bicep/modules/admin-plane/gh-runner-job.bicep', 'standalone entrypoint: scale-to-zero self-hosted GitHub runner ACA Job, deployed out-of-band (az deployment -f gh-runner-job.bicep; its doc block shows the optional in-orchestrator wiring)'],
  ['platform/fiab/bicep/modules/admin-plane/monitor-ops-agent.bicep', 'standalone entrypoint (G3 Operations Agent): the ops-agent evaluator Function App (timer trigger → AOAI reason → dispatch), the Teams adaptive-card approval Logic App (Consumption) + Teams API connection, and role assignments (Monitoring Reader on the RG, Database Viewer on the bound co-located Eventhouse/ADX). Deployed out-of-band (admin-plane/main.bicep at the 256-param ceiling), then LOOM_OPS_AGENT_EVALUATOR_FUNC / LOOM_OPS_AGENT_APPROVAL_LOGICAPP set on the console app; the ops-agent evaluator + approval channel honest-gate until wired. The per-trigger scheduledQueryRules are created dynamically by the Console (activator-monitor.ts), not templated here. Graph Chat.ReadWrite is an AAD app-role granted out-of-band. No Fabric/Power Automate dependency'],
  ['platform/fiab/bicep/modules/admin-plane/monitor-ops-agent-aca.bicep', 'standalone entrypoint (G3 Operations Agent, OSS / air-gapped-Gov fallback): the SAME evaluator container run as a Microsoft.App/jobs Scheduled job (KEDA cron scaler) for sovereign regions where Consumption Functions + Teams + Logic Apps are unavailable — dispatches via the trigger\'s Azure Monitor action group (email/webhook) instead of Teams. Deployed out-of-band into a Gov landing zone. Azure-native only (Container Apps Jobs + KEDA cron). No Fabric/Power Automate dependency'],
  ['platform/fiab/bicep/modules/shared/diagnostic-settings.bicep', 'shared scope:<resource> diagnostic-settings helper template (loom-law-monitoring runbook documents it); TODO wire callers per-resource'],
  ['platform/fiab/bicep/modules/admin-plane/mcp-catalog-app.bicep', 'opt-in MCP-catalog ACA app; deployed when the MCP catalog is enabled'],
  ['platform/fiab/bicep/modules/compute/loom-directlake-app.bicep', 'standalone entrypoint (HYP-5 Loom Direct Lake): internal-ingress Rust/axum columnar scan+frame ACA app (Apache DataFusion + delta-rs), minReplicas>=1 (NOT scale-to-zero — warm-cache retention is the point). Deployed out-of-band (admin-plane/main.bicep at the 256-param ceiling), then LOOM_DIRECTLAKE_URL set on the console app; the /api/directlake/scan BFF honest-gates + the semantic layer falls back to AAS/Synapse-Serverless until wired. Azure-native, no Fabric/OneLake/Power BI dependency'],
  ['platform/fiab/bicep/modules/copilot/browser-tool.bicep', 'standalone entrypoint (AIF-18): scale-to-zero Playwright browser-automation ACA Job, deployed out-of-band (az deployment -f browser-tool.bicep) then LOOM_BROWSER_TOOL_JOB set to its resource id; the browser_automation agent tool honest-gates until wired'],
  ['platform/fiab/bicep/modules/landing-zone/databricks-scim-bootstrap.bicep', 'opt-in Databricks SCIM bootstrap; run out-of-band during DLZ setup'],
  ['platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep', 'opt-in per-workspace identity module; deployed on demand by the workspace provisioner'],
  ['platform/fiab/bicep/modules/landing-zone/workspace-identity-grants.bicep', 'opt-in I2 bulk-path sibling of workspace-identity.bicep (Event Hubs + Cosmos data-plane grants for a workspace UAMI); deployed on demand into the backend RG, per docs/fiab/runbooks/workspace-identity-grants.md'],
  ['platform/fiab/bicep/modules/landing-zone/postgres-flexible.bicep', 'standalone entrypoint (DBX-4 Lakebase): STRICTLY opt-in, METERED PostgreSQL Flexible Server (+pgvector allowlist) — the Azure-native DEFAULT Lakebase backend. Deployed out-of-band (az deployment group create -f postgres-flexible.bicep) OR the lakebase-postgres editor provisions/binds a server directly via ARM; no Databricks/Fabric dependency. Not wired into an orchestrator (metered + main.bicep at 256-param ceiling)'],
  ['platform/fiab/bicep/modules/integration/adt-instance.bicep', 'standalone entrypoint (FGC-12): STRICTLY opt-in Azure Digital Twins instance; the default Digital Twin Builder backend is ADX-native and needs none of this. Deployed out-of-band (az deployment -f adt-instance.bicep) then LOOM_ADT_ENDPOINT set to its hostName; the editor honest-gates until wired'],
  ['platform/fiab/bicep/modules/integration/prpt-renderer.bicep', 'standalone entrypoint: ACA host for the paginated-report renderer, deployed out-of-band (az deployment -f prpt-renderer.bicep) in estates whose Azure Policy forces publicNetworkAccess=Disabled on storage — the default azure-functions/paginated-report-renderer deploy cannot start there (Y1 has no VNet integration to reach its own AzureWebJobsStorage). LOOM_PAGINATED_RENDER_URL points at its internal FQDN; the editor honest-gates until wired'],
  ['platform/fiab/bicep/modules/compute/hband-shared.bicep', 'standalone entrypoint (HYP-16): the Hyperscale band SHARED substrate — one zone-redundant Azure Cache for Redis Premium (amortized across Loom Direct Lake segment residency + Capacity Broker timepoint ledger + PSR-3 Spark lease store + PSR-5/6 result cache) + the three dedicated least-privilege service UAMIs + Redis diagnostic settings. Deployed out-of-band (az deployment group create -f compute/hband-shared.bicep — admin-plane/main.bicep is at the 256-param ceiling), then LOOM_DIRECTLAKE_REDIS / LOOM_BROKER_REDIS and the per-service app URLs are set on the Console app. The per-service ACA app modules (compute/loom-{onelake,directlake,capacity-broker}-app.bicep) consume its UAMI + Redis outputs; unset ⇒ each console client honest-503 gates and silently falls back (no Fabric gate)'],
  ['platform/fiab/bicep/modules/compute/loom-onelake-app.bicep', 'opt-in Loom OneLake namespace/catalog ACA app (HYP-1); internal-ingress loom:// resolver + Cosmos registry. The HYP-16/platform workflow owns main.bicep and wires the module invocation + uami-loom-onelake + LOOM_ONELAKE_URL console env (the wiring block is documented in the module header). The console BFF /api/onelake/resolve honest-503s until LOOM_ONELAKE_URL is set'],
  ['platform/fiab/bicep/modules/compute/loom-capacity-broker-app.bicep', 'standalone entrypoint (HYP-9): Loom Capacity Broker admission-control ACA app (minReplicas 2). Deployed out-of-band (main.bicep at 256-param ceiling) then LOOM_CAPACITY_BROKER_URL set on the console app; capacity-broker-client honest-gates (503, job submission proceeds unthrottled — default-ON) until wired. Its doc block shows the in-orchestrator wiring.'],
  ['platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep', 'standalone entrypoint (N1 Iceberg REST Catalog): internal-ingress Unity Catalog OSS container serving the standard Apache Iceberg REST Catalog surface so external engines (Trino/Spark/DuckDB/Snowflake/Databricks) read Loom Delta tables off the customer-owned ADLS Gen2 with ZERO copy. Identity-based lake access (UAMI + in-module Storage Blob Data Reader role assignment; no keys, no secrets). Deployed out-of-band (admin-plane/main.bicep at the 256-param ceiling), then LOOM_ICEBERG_CATALOG_URL is set on the console app; unset => the lakehouse Interop tab still emits Delta<->Iceberg dual metadata into the lake and every surface honest-gates with a Fix-it. Azure-native/OSS, no Fabric/Power BI, no SaaS catalog (runs disconnected in IL5).'],
  ['platform/fiab/bicep/modules/compute/loom-unity-app.bicep', 'standalone entrypoint (GOV-PARITY): self-hosted OSS Unity Catalog server ACA app for Azure Government (Databricks Unity Catalog has no Gov endpoint). Internal-ingress, H2 file DB on a mounted Azure Files share (Postgres opt-in via LOOM_UNITY_DB_URL). Deployed out-of-band (admin-plane/main.bicep at the 256-param ceiling), then LOOM_UC_BACKEND=oss + LOOM_UNITY_URL set on the console app; the UC client (lib/azure/uc-backend.ts) honest-gates (OssUcNotConfiguredError) until wired and Commercial keeps using Databricks UC. Azure-native, no Fabric/Power BI dependency. See docs/fiab/unity-gov.md.'],
  ['platform/fiab/bicep/modules/compute/loom-memory-consolidate-job.bicep', 'standalone entrypoint (CTS-13): scheduled ACA Job that runs the nightly Copilot long-term-memory consolidation pass (dedupe/merge/decay per scope, audit doc). Deployed out-of-band (admin-plane/main.bicep at the 256-param ceiling) like the other compute-band jobs; the memory brain (CTS-08) works without it — consolidation is a maintenance pass, not a hot-path dependency. Azure-native (Cosmos + AOAI), no Fabric.'],
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
