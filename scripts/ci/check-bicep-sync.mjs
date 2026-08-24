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
  ['platform/fiab/bicep/modules/admin-plane/cost-export.bicep', 'standalone entrypoint (Loom Brain cost): per-subscription Cost Management export to storage — the ONLY source a `billed` figure in lib/brain/cost can come from. Deployed out-of-band once per subscription (`az deployment sub create --subscription <id> --location <region> --template-file platform/fiab/bicep/modules/admin-plane/cost-export.bicep --parameters storageAccountResourceId=<id> containerName=loom-brain-cost`), for three reasons that are structural rather than convenience. (1) ONE Microsoft.CostManagement/exports resource covers exactly ONE billing scope, so wiring it into admin-plane/main.bicep would automate one subscription of six and leave the identical loop for the rest — the out-of-band pass does not go away, it only shrinks. (2) The blob-write grant for the export system-assigned identity CANNOT be declared inside this subscription-scoped file when the storage account sits in another resource group or subscription, which is the NORMAL case here (one central container, six subscriptions) — measured, BCP139 — so the module emits `blobWriteGrantCommand` fully filled in and the grant belongs beside whatever orchestrator invocation eventually lands (auto-bind-by-default.md §5). (3) `scheduleStartUtc` defaults to dateTimeAdd(utcNow(...), P1D), so an orchestrator-wired export would re-PATCH its own schedule window on EVERY deploy and register as permanent what-if drift. NOTHING DEGRADES SILENTLY WHILE IT IS UNWIRED, which is the actual bar this allowlist has to clear. Measured on this tree with no export supplied: attributions=1 billedCount=0 derivedCount=1 source="derived", rendered as `$23.65 (DERIVED estimate — not a bill; LOWER bound: ...)`, rowPopulation.blind=true, billedSource=none, and a degradeReason naming THIS module and the ~24h first-data latency. Never $0.00, never a throw. That is precisely the difference from compute/loom-directlake-app.bicep, whose entry was REMOVED in #3291 because its honest 503 named a bicep module no orchestrator ran AND an image no CI built — a remediation that was not executable. This one is executable today by copy-paste. The wire-vs-keep-out-of-band routing decision is owned by the admin-plane/main.bicep lane and tracked in issue 3965; DELETE THIS ENTRY the moment any orchestrator invokes the module, so the guard can catch a re-orphaning. NOT VERIFIED IN AZURE GOVERNMENT, stated rather than implied: the module has never been deployed there and the Gov ARM plane acceptance of api-version 2023-08-01 was not checked from an in-boundary runner (the module header carries the `az provider show` command that checks it).'],
  ['platform/fiab/bicep/modules/admin-plane/cost-management-rbac.bicep', 'opt-in cost-management chargeback RBAC; deployed on demand'],
  ['platform/fiab/bicep/modules/admin-plane/perf-benchmarks-dcr.bicep', 'opt-in PSR-1 LoomPerf_CL Log-Analytics export (perf-benchmark trend rows); STRICTLY additive — the authoritative store is the lazily-created Cosmos perf-benchmarks container. Standalone entrypoint deployed out-of-band (main.bicep at 256-param ceiling), then LOOM_PERF_DCR_ENDPOINT/LOOM_PERF_DCR_ID set on the console app; lib/perf/perf-export.ts honest-gates to a silent no-op until both are present'],
  ['platform/fiab/bicep/modules/admin-plane/devcenter.bicep', 'opt-in Deployment Environments DevCenter; TODO wire into orchestrator (release-environment honest-gate documents it)'],
  ['platform/fiab/bicep/modules/admin-plane/event-grid-webhooks.bicep', 'opt-in outbound-webhook Event Grid transport (BR-WEBHOOK); standalone entrypoint deployed out-of-band (main.bicep at 256-param ceiling), then LOOM_EVENTGRID_TOPIC_ENDPOINT/KEY set on the console app; the webhook-emitter honest-gates to direct HTTPS until both are present'],
  ['platform/fiab/bicep/modules/admin-plane/gh-runner-job.bicep', 'standalone entrypoint: scale-to-zero self-hosted GitHub runner ACA Job, deployed out-of-band (az deployment -f gh-runner-job.bicep; its doc block shows the optional in-orchestrator wiring)'],
  ['platform/fiab/bicep/modules/admin-plane/monitor-ops-agent.bicep', 'standalone entrypoint (G3 Operations Agent): the ops-agent evaluator Function App (timer trigger → AOAI reason → dispatch), the Teams adaptive-card approval Logic App (Consumption) + Teams API connection, and role assignments (Monitoring Reader on the RG, Database Viewer on the bound co-located Eventhouse/ADX). Deployed out-of-band (admin-plane/main.bicep at the 256-param ceiling), then LOOM_OPS_AGENT_EVALUATOR_FUNC / LOOM_OPS_AGENT_APPROVAL_LOGICAPP set on the console app; the ops-agent evaluator + approval channel honest-gate until wired. The per-trigger scheduledQueryRules are created dynamically by the Console (activator-monitor.ts), not templated here. Graph Chat.ReadWrite is an AAD app-role granted out-of-band. No Fabric/Power Automate dependency'],
  ['platform/fiab/bicep/modules/admin-plane/monitor-ops-agent-aca.bicep', 'standalone entrypoint (G3 Operations Agent, OSS / air-gapped-Gov fallback): the SAME evaluator container run as a Microsoft.App/jobs Scheduled job (KEDA cron scaler) for sovereign regions where Consumption Functions + Teams + Logic Apps are unavailable — dispatches via the trigger\'s Azure Monitor action group (email/webhook) instead of Teams. Deployed out-of-band into a Gov landing zone. Azure-native only (Container Apps Jobs + KEDA cron). No Fabric/Power Automate dependency'],
  ['platform/fiab/bicep/modules/shared/diagnostic-settings.bicep', 'shared scope:<resource> diagnostic-settings helper template (loom-law-monitoring runbook documents it); TODO wire callers per-resource'],
  ['platform/fiab/bicep/modules/admin-plane/mcp-catalog-app.bicep', 'opt-in MCP-catalog ACA app; deployed when the MCP catalog is enabled'],
  // compute/loom-directlake-app.bicep was here. REMOVED (#3291): admin-plane/
  // main.bicep now INVOKES it (`directLakeSvcActive`, default-ON via the
  // loomBackends bag) and emits LOOM_DIRECTLAKE_URL from the module's own fqdn
  // output. The old entry justified the orphan as "main.bicep at the 256-param
  // ceiling"; measured at the time of the fix that was 238 params with 18 of
  // headroom, and the wiring added ZERO new params because a child module's
  // params do not count against its parent's. While it sat here the guard could
  // not catch what was actually true: the BFF's honest 503 named a bicep module
  // no orchestrator ran and an image no CI built, so the remediation it handed
  // the operator was not executable (auto-bind-by-default.md sec 5).
  ['platform/fiab/bicep/modules/copilot/browser-tool.bicep', 'standalone entrypoint (AIF-18): scale-to-zero Playwright browser-automation ACA Job, deployed out-of-band (az deployment -f browser-tool.bicep) then LOOM_BROWSER_TOOL_JOB set to its resource id; the browser_automation agent tool honest-gates until wired'],
  ['platform/fiab/bicep/modules/copilot/copilot-chat-function.bicep', 'standalone entrypoint (#3429): the docs-site Copilot chat Function App (func-csa-inabox-copilot-fg). NOT orphaned in the sense this guard exists to catch — .github/workflows/deploy-copilot-function.yml APPLIES it with `az deployment group create --template-file`, on the `absent-here` preflight verdict, and lists it in its own `paths:` trigger so a change here re-runs that lane. NOTE the limit of that: re-running the lane is not the same as applying the change. Where the app already EXISTS the verdict is `found`, the apply is skipped, and a module change is merged-not-deployed until an operator reconciles it (azure-functions/copilot-chat/DEPLOYMENT.md, "Reconciling an existing app"); the lane states that in its own log on every such run rather than leaving the green check to imply otherwise. It is deliberately outside admin-plane/main.bicep because it deploys into the docs-site estate (rg-dlz-aiml-stack-dev), not the Loom admin plane, and shares neither its subscription nor its lifecycle. Sibling ownership is split on purpose: azure-functions/copilot-chat/deploy/main.bicep owns the Cosmos account + its sqlRoleAssignment, this module owns the app, its Y1 plan, its storage and its two Cognitive Services grants. check-function-app-producer-coverage.mjs is the guard that keeps the workflow and this file naming the same app'],
  ['platform/fiab/bicep/modules/landing-zone/databricks-scim-bootstrap.bicep', 'opt-in Databricks SCIM bootstrap; run out-of-band during DLZ setup'],
  ['platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep', 'opt-in per-workspace identity module; deployed on demand by the workspace provisioner'],
  ['platform/fiab/bicep/modules/landing-zone/workspace-identity-grants.bicep', 'opt-in I2 bulk-path sibling of workspace-identity.bicep (Event Hubs + Cosmos data-plane grants for a workspace UAMI); deployed on demand into the backend RG, per docs/fiab/runbooks/workspace-identity-grants.md'],
  ['platform/fiab/bicep/modules/landing-zone/postgres-flexible.bicep', 'standalone entrypoint (DBX-4 Lakebase): STRICTLY opt-in, METERED PostgreSQL Flexible Server (+pgvector allowlist) — the Azure-native DEFAULT Lakebase backend. Deployed out-of-band (az deployment group create -f postgres-flexible.bicep) OR the lakebase-postgres editor provisions/binds a server directly via ARM; no Databricks/Fabric dependency. Not wired into an orchestrator (metered + main.bicep at 256-param ceiling)'],
  ['platform/fiab/bicep/modules/integration/adt-instance.bicep', 'standalone entrypoint (FGC-12): STRICTLY opt-in Azure Digital Twins instance; the default Digital Twin Builder backend is ADX-native and needs none of this. Deployed out-of-band (az deployment -f adt-instance.bicep) then LOOM_ADT_ENDPOINT set to its hostName; the editor honest-gates until wired'],
  ['platform/fiab/bicep/modules/integration/prpt-renderer.bicep', 'standalone entrypoint: ACA host for the paginated-report renderer, deployed out-of-band (az deployment -f prpt-renderer.bicep) in estates whose Azure Policy forces publicNetworkAccess=Disabled on storage — the default azure-functions/paginated-report-renderer deploy cannot start there (Y1 has no VNet integration to reach its own AzureWebJobsStorage). LOOM_PAGINATED_RENDER_URL points at its internal FQDN; the editor honest-gates until wired'],
  ['platform/fiab/bicep/modules/compute/hband-shared.bicep', 'standalone entrypoint (HYP-16): the Hyperscale band SHARED substrate — one zone-redundant Azure Cache for Redis Premium (amortized across Loom Direct Lake segment residency + Capacity Broker timepoint ledger + PSR-3 Spark lease store + PSR-5/6 result cache) + the three dedicated least-privilege service UAMIs + Redis diagnostic settings. Deployed out-of-band (az deployment group create -f compute/hband-shared.bicep — admin-plane/main.bicep is at the 256-param ceiling), then LOOM_DIRECTLAKE_REDIS / LOOM_BROKER_REDIS and the per-service app URLs are set on the Console app. The per-service ACA app modules (compute/loom-{onelake,directlake,capacity-broker}-app.bicep) consume its UAMI + Redis outputs; unset ⇒ each console client honest-503 gates and silently falls back (no Fabric gate)'],
  ['platform/fiab/bicep/modules/compute/loom-onelake-app.bicep', 'opt-in Loom OneLake namespace/catalog ACA app (HYP-1); internal-ingress loom:// resolver + Cosmos registry. The HYP-16/platform workflow owns main.bicep and wires the module invocation + uami-loom-onelake + LOOM_ONELAKE_URL console env (the wiring block is documented in the module header). The console BFF /api/onelake/resolve honest-503s until LOOM_ONELAKE_URL is set'],
  ['platform/fiab/bicep/modules/compute/loom-capacity-broker-app.bicep', 'standalone entrypoint (HYP-9): Loom Capacity Broker admission-control ACA app (minReplicas 2). Deployed out-of-band (main.bicep at 256-param ceiling) then LOOM_CAPACITY_BROKER_URL set on the console app; capacity-broker-client honest-gates (503, job submission proceeds unthrottled — default-ON) until wired. Its doc block shows the in-orchestrator wiring.'],
  // data-plane/duckdb-aca.bicep was here. REMOVED (PR #2640 round 2): the N2b/N3
  // DuckDB serving tier is no longer an out-of-band standalone entrypoint —
  // admin-plane/main.bicep invokes it (`duckdbTierActive`, default-ON) and binds
  // LOOM_DUCKDB_URL / LOOM_FLIGHTSQL_URL on the Console. While it sat here the
  // env vars were emitted by NO bicep anywhere, which made the sibling
  // svc-ducklake-catalog gate cosmetic: the Postgres store deployed and billed
  // while listDucklakeTables() threw 503 `duckdb_tier_required` before reaching it.

  ['platform/fiab/bicep/modules/data-plane/loom-trino-aks.bicep', 'standalone entrypoint (N7e Trino Federated SQL — the OPT-IN SCALE-OUT path): PRIVATE AKS cluster (in-VNet, private API server) running MULTI-NODE Trino OSS (Apache-2.0) registered against the N1 Iceberg REST Catalog + external connectors. NOT the default any more: the DEFAULT-ON Federated SQL engine is data-plane/loom-trino-aca.bicep, a scale-to-zero single-node Trino Container App wired straight from admin-plane/main.bicep (loomBackends.trino, default enabled) so LOOM_TRINO_URL ships on a fresh push-button install in both clouds at ZERO idle cost. This AKS module is what an operator deploys when one container is no longer enough (large federated joins that need real worker parallelism); it costs an always-on system node pool, needs a separate Helm-install phase, and is deployed out-of-band, after which LOOM_TRINO_URL is repointed at the coordinator. Identity-based lake access via AKS Workload Identity (in-module UAMI federated to the trino k8s ServiceAccount + Storage Blob Data Reader on the DLZ lake; no keys, no secrets). Azure-native/OSS, no Fabric/OneLake/Power BI, no SaaS query federation (runs disconnected in IL5; SaaS-only external connectors stay honestly gated).'],
  // data-plane/loom-unity-postgres.bicep and compute/loom-unity-app.bicep were
  // here. REMOVED (finishline D2, 2026-08-06): since #3013 (svc-loom-unity-authz
  // reconcile) admin-plane/main.bicep invokes BOTH — `loomUnityPostgres` gated on
  // `loomUnityPostgresActive` and `loomUnity` gated on `loomUnityActive`
  // (default-ON via the loomBackends bag; the 256-param ceiling was never
  // reached because no new top-level param was added) — and emits
  // LOOM_UNITY_URL / _CLIENT_ID / _AUDIENCE / _AUTH_MODE onto the Console app.
  // The old entries also claimed "Commercial keeps using Databricks UC", which
  // #3013 made false. While they sat here the guard could not catch a regression
  // that re-orphaned either module.
  ['platform/fiab/bicep/modules/compute/loom-sharing-app.bicep', 'standalone entrypoint (GOV-PARITY, LU-9): the OSS Delta Sharing reference server (delta-io/delta-sharing, Apache-2.0) as the "loom-sharing" ACA app, serving the open sharing protocol over the SAME ADLS Gen2 Delta tables the lakehouse writes. Databricks Delta Sharing has no Azure Government endpoint and OSS Unity Catalog 0.5 does not implement the sharing server. INTERNAL ingress in every configuration - the module exposes no public switch - because the upstream server has a single global bearer and cannot scope a caller to a subset of shares; recipients terminate on the Console BFF (/api/delta-sharing/*), which authenticates them with Microsoft Entra tokens and enforces the per-recipient grant before proxying. Key Vault secretrefs for the server bearer + the storage OAuth principal; optional consoleAllowedCidrs IP pin. Deployed out-of-band (admin-plane/main.bicep at the 256-param ceiling), then LOOM_SHARING_URL + the LOOM_SHARING_BEARER secretref are set on the console app; until wired the sharing BFF honest-gates (LoomSharingNotConfiguredError) and Commercial keeps using Databricks Delta Sharing. Azure-native, no Fabric/Power BI dependency. See docs/fiab/delta-sharing-gov.md + docs/fiab/security/loom-sharing-threat-model.md.'],
  ['platform/fiab/bicep/modules/admin-plane/risingwave-root-secret.bicep', 'standalone entrypoint (out-of-band credential writer, NOT day-one infra): writes the MANDATORY loom-risingwave Postgres-wire root password into the existing Loom Key Vault and grants "Key Vault Secrets User" to exactly the loom-risingwave UAMI + the Console UAMI. The FULL deploy does NOT use this module — admin-plane/keyvault.bicep writes the same secret name inline, so the from-scratch chain is complete without it. It exists for the INCREMENTAL path (.github/workflows/gov-provision-streaming-migrate.yml), which cannot run `az keyvault secret set` because the Loom vault is publicNetworkAccess=Disabled + defaultAction=Deny and a GitHub-hosted runner has no route to its data plane; writing the secret as an ARM resource is a control-plane operation that works regardless of the firewall. Azure-native, no Fabric dependency.'],
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
