#!/usr/bin/env node
/**
 * GUARDRAIL: env-sync  (merge-blocker)
 * ------------------------------------------------------------------------
 * RULE (no-vaporware.md "Bicep sync requirement"):
 *   Every `process.env.LOOM_*` name that the fiab-console reads at runtime
 *   must EITHER be emitted by the platform bicep (so a from-scratch
 *   `az deployment` produces a working console) OR be explicitly declared
 *   here as a legitimately runtime-only / derived / opt-in variable.
 *
 *   A var that code reads but bicep never sets is silent config drift: it
 *   worked in the live deployment (where someone `az containerapp update`-d
 *   it by hand) but a clean redeploy ships it unset -> the feature gates off
 *   or 500s. This check catches that class before merge.
 *
 * WHAT IT DOES:
 *   1. Collects every LOOM_* name read under apps/fiab-console/{app,lib}.
 *   2. Collects every LOOM_* name emitted anywhere under
 *      platform/fiab/bicep/**\/*.bicep  (env-array `name: 'LOOM_..'` AND any
 *      other textual reference — params, vars, string interpolation).
 *   3. Reports read-but-never-emitted names that are NOT covered by an
 *      ALLOWLIST_PATTERN or the explicit ALLOWLIST below. Exits 1 if any.
 *
 * HOW TO ADD AN ALLOWLIST ENTRY (when you add a NEW read-only-at-runtime var):
 *   - If it fits an existing category (a tuning knob, a backend selector, a
 *     secret injected via KV secretRef, an AAD scope / host-suffix derived
 *     from the cloud, an *_API_VERSION pinned in code, an *_ENABLED flag),
 *     it is already matched by an ALLOWLIST_PATTERN — nothing to do.
 *   - Otherwise, if the var is genuinely derived at runtime (e.g. computed
 *     from another emitted var) or is an OPT-IN feature that is intentionally
 *     unset by default, add its exact name to the explicit ALLOWLIST array
 *     with a one-line `// reason`.
 *   - If instead the var SHOULD ship with the deployment, do NOT allowlist it
 *     — add it to the console app's env array in
 *     platform/fiab/bicep/modules/admin-plane/main.bicep (or the owning
 *     module). That is the fix this guard is asking for.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const BICEP_ROOT = path.join(REPO_ROOT, 'platform', 'fiab', 'bicep');

// ── Allowlist patterns: whole categories of legitimately-runtime-only vars ──
// Each is a regex tested against the bare NAME (e.g. "LOOM_QUERY_CACHE").
const ALLOWLIST_PATTERNS = [
  /_BACKEND$/,              // backend selectors — Azure-native is the DEFAULT; only set to opt into an alternative (no-fabric-dependency.md)
  /_ENABLED$/,              // feature toggles — default off, code has a fallback
  /_MS$/,                   // millisecond tuning knobs / TTLs / budgets (code default)
  /_TTL(_MS)?$/,            // cache TTLs
  /_BUDGET_MS$/,            // time budgets
  /_MAX_[A-Z0-9_]+$/,       // MAX_ROWS / MAX_TABLES / MAX_NODES / MAX_CONCURRENCY caps
  /_CONCURRENCY$/,          // concurrency caps
  /_POLLS$/,                // poll-count knobs
  /_CACHE$/,                // cache on/off knobs
  /_RATE_LIMIT$/,           // rate-limit knob
  /_ROWS_PER_PAGE$/,        // paging knob
  /_MAX_AGE_SECS$/,         // session lifetime knob
  /_KEY$/,                  // secrets — injected via KV secretRef (not a plain bicep env literal)
  /_SECRET$/,               // secrets — KV secretRef
  /_TOKEN$/,                // secrets — KV secretRef / PAT
  /_BEARER$/,               // secrets — KV secretRef
  /_CONNECTION_STRING$/,    // secrets — KV secretRef
  /_SCOPE$/,                // AAD resource scopes derived from the cloud (cloud-endpoints.ts)
  /_SUFFIX$/,               // data-plane host suffixes derived from the cloud
  /_API_VERSION$/,          // service API versions pinned in code with a default
  /_MCP_ENDPOINT$/,         // opt-in MCP server endpoints (unset unless deployed)
];

// ── Explicit allowlist: named vars that are runtime-derived, ambient, or opt-in.
// Seeded from the CURRENT tree (2026-07). Each MUST carry a reason.
const ALLOWLIST = new Set([
  // ---- Build / ambient (injected by the container runtime or platform, not app bicep) ----
  'LOOM_BUILD_SHA',                 // stamped at image build time
  'LOOM_BUILD_TIMESTAMP',           // stamped at image build time
  'LOOM_TENANT_ID',                 // ambient Entra tenant (from MSI / token)
  'LOOM_ENTRA_TENANT_ID',           // ambient Entra tenant alias
  'LOOM_REGION',                    // ambient deployment region
  'LOOM_AZURE_LOCATION',            // ambient deployment region alias
  'LOOM_GCCH',                      // cloud flag derived from ARM environment
  'LOOM_IL5',                       // cloud flag derived from ARM environment
  'LOOM_TEMPLATE_TENANT',           // opt-in multi-tenant template mode
  'LOOM_SKIP_DEPLOY_PREFLIGHT',     // dev/opt-in escape hatch
  'LOOM_PYLSP_DEBUG',               // dev-only language-server debug flag
  'LOOM_PYLSP_PYTHON',              // dev-only python path override
  'LOOM_POWERPLATFORM_ASSUME_CRED', // opt-in Power Platform cred mode
  'LOOM_INTERNAL_ALLOWED_OIDS',     // opt-in allowlist of automation oids for the token-gated internal surface (rel-T10/B3); unset default = any well-formed GUID
  'LOOM_MCP_EGRESS_ALLOW',          // opt-in SSRF egress allow-list for admin MCP test-connection (rel-T13)
  'LOOM_MULTIUSER_ACL',             // opt-out kill switch for the multi-user ACL fallback (default on in code; rel-T11)

  // ---- Derived from an emitted var at runtime (KV name<->url, cosmos endpoint<->id, etc.) ----
  'LOOM_KEY_VAULT_NAME',            // derived from LOOM_KEY_VAULT_URL
  'LOOM_KEY_VAULT_URL',             // derived from KV name / emitted per-module
  'LOOM_COSMOS_DB',                 // default 'loom'; derived when unset
  'LOOM_COSMOS_ACCOUNT_ENDPOINT',   // derived from cosmos account id
  'LOOM_COSMOS_ACCOUNT_ID',         // derived from account name + sub
  'LOOM_CAE_ID',                    // derived from CAE name + rg
  'LOOM_CAE_NAME',                  // derived / ambient container-app env name
  'LOOM_CAE_DEFAULT_DOMAIN',        // derived from CAE ingress
  'LOOM_CONSOLE_APP_NAME',          // ambient container-app name
  'LOOM_CONSOLE_PUBLIC_URL',        // derived from ingress FQDN / Front Door
  'LOOM_PUBLIC_BASE_URL',           // derived from ingress FQDN / Front Door
  'LOOM_DOMAIN_NAME',               // derived per-workspace domain
  'LOOM_UAMI_APP_ID',               // derived from the bound user-assigned MI
  'LOOM_UAMI_NAME',                 // derived from the bound user-assigned MI
  'LOOM_ONELAKE_BASE',              // derived from cloud endpoints
  'LOOM_ONELAKE_DFS_BASE',          // derived from cloud endpoints
  'LOOM_DLP_GRAPH_BASE',            // derived from cloud endpoints (Graph)
  'LOOM_DEVOPS_BASE',               // derived from cloud endpoints (Azure DevOps)
  'LOOM_DOCS_BASE_URL',             // derived from public docs site
  'LOOM_POWER_PLATFORM_BAP_BASE',   // derived from cloud endpoints (BAP)
  'LOOM_POWERBI_EMBED_HOST',        // derived from cloud endpoints (Power BI)
  'LOOM_AZURE_MAPS_SEARCH_HOST',    // derived from cloud endpoints (Azure Maps)
  'LOOM_AML_DATAPLANE_HOST',        // derived from AML workspace region
  'LOOM_FABRIC_UDF_HOST',           // opt-in Fabric UDF host
  'LOOM_ARG_URL',                   // derived ARM Resource Graph endpoint
  'LOOM_DIRECTLINE_TOKEN_URL',      // derived DirectLine endpoint

  // ---- Optional / opt-in service targets (unset unless that service is provisioned) ----
  'LOOM_AAS_DB',                    // Azure Analysis Services db (opt-in semantic layer)
  'LOOM_AAS_LOCATION',              // AAS region (opt-in)
  'LOOM_AAS_SKU',                   // AAS sku (opt-in)
  'LOOM_AAS_XMLA_URL',              // AAS XMLA endpoint (opt-in)
  'LOOM_ADLS_CONTAINER',            // default 'loom'; derived when unset
  'LOOM_AML_SCHEDULE_ENVIRONMENT',  // AML curated env name (code default)
  'LOOM_AML_SPARK_INSTANCE_TYPE',   // AML spark sizing (code default)
  'LOOM_AML_SPARK_RUNTIME',         // AML spark runtime version (code default)
  'LOOM_AML_WORKSPACE_NAME',        // derived from Foundry hub
  'LOOM_AOAI_CLIENT_V2',            // opt-in AOAI client switch
  'LOOM_AZURE_SQL_DEFAULT_DB',      // sample-DB default (code default)
  'LOOM_AZURE_SQL_DEFAULT_SERVER',  // sample-DB default (code default)
  'LOOM_BI_RENDER_FUNCTION_NAME',   // derived report-render function name
  'LOOM_COPILOT_FUNCTION_URL',      // derived copilot function endpoint
  'LOOM_COSMOS_VCORE_DATABASE',     // opt-in cosmos vCore (pgvector alt)
  'LOOM_COST_SUBSCRIPTIONS',        // opt-in cost-scope subscription list
  'LOOM_DATABRICKS_CATALOG',        // UC catalog default (code default)
  'LOOM_DATABRICKS_CLUSTER_ID',     // derived / opt-in default cluster
  'LOOM_DATABRICKS_DEFAULT_CATALOG',// UC catalog default (code default)
  'LOOM_DATABRICKS_DEFAULT_SCHEMA', // UC schema default (code default)
  'LOOM_DATABRICKS_SCHEMA',         // UC schema default (code default)
  'LOOM_DATABRICKS_SUBSCRIPTIONS',  // opt-in databricks discovery scope
  'LOOM_DBT_RUNNER_AUDIENCE',       // opt-in dbt runner audience
  'LOOM_DEFAULT_POWERBI_WORKSPACE', // opt-in Power BI workspace (Fabric-family, opt-in)
  'LOOM_DELTA_SHARING_VOLUME',      // opt-in delta-sharing volume
  'LOOM_DEVCENTER_CATALOG',         // opt-in DevCenter catalog
  'LOOM_DEVCENTER_ENV_TYPE',        // opt-in DevCenter env type
  'LOOM_DEVCENTER_URI',             // opt-in DevCenter uri
  'LOOM_DIRECT_LAKE_COSMOS_CONTAINER', // opt-in Direct Lake mirror
  'LOOM_DIRECT_LAKE_COSMOS_DB',     // opt-in Direct Lake mirror
  'LOOM_DQ_SOURCE_CONNECTION_STRING', // handled by _CONNECTION_STRING pattern; kept for clarity
  'LOOM_DSPM_AI_AGENT_ITEM_TYPES',  // classifier config list (code default)
  'LOOM_EVENTSTREAM_EVENTS_TABLE',  // ADX table default (code default)
  'LOOM_FABRIC_GRAPH_WORKSPACE',    // opt-in Fabric graph workspace
  'LOOM_FABRIC_SEMANTIC_MODEL_ID',  // opt-in Fabric semantic model
  'LOOM_FABRIC_WORKSPACE_ID',       // opt-in Fabric workspace (no-fabric-dependency.md: never a default gate)
  'LOOM_FOUNDRY_EVAL_DATASET',      // opt-in eval dataset
  'LOOM_FOUNDRY_EVAL_DEPLOYMENT',   // opt-in eval deployment
  'LOOM_FOUNDRY_HUB_NAME',          // derived from Foundry hub
  'LOOM_FOUNDRY_PROJECT',           // derived from Foundry project
  'LOOM_GHCR_OWNER',                // opt-in GHCR mirror owner
  'LOOM_GHCR_REGISTRY',             // opt-in GHCR mirror registry
  'LOOM_GITHUB_REPO_NAME',          // opt-in GitHub integration
  'LOOM_GITHUB_REPO_OWNER',         // opt-in GitHub integration
  'LOOM_FEEDBACK_REPO_NAME',        // opt-in feedback repo
  'LOOM_FEEDBACK_REPO_OWNER',       // opt-in feedback repo
  'LOOM_IOTHUB_RG',                 // opt-in IoT Hub resource group
  'LOOM_IOTHUB_SUB',                // opt-in IoT Hub subscription
  'LOOM_KUSTO_FABRIC_MANAGED',      // opt-in Fabric-managed Kusto flag
  'LOOM_LOGIC_LOCATION',            // Logic App region (derived)
  'LOOM_MIRROR_SOURCE_CONNECTION_ID', // opt-in mirror source binding
  'LOOM_OPEN_MIRROR_POOL',          // opt-in open-mirror pool
  'LOOM_PGVECTOR_DATABASE',         // opt-in pgvector db
  'LOOM_PGVECTOR_HOST',             // opt-in pgvector host
  'LOOM_POSTGRES_HOST',             // opt-in postgres host
  'LOOM_PURVIEW_AUTOSCAN',          // opt-in Purview auto-register flag
  'LOOM_PURVIEW_DEFAULT_DOMAIN_NAME', // Purview domain default (code default)
  'LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID', // derived Purview governance domain
  'LOOM_PURVIEW_MANAGED_VNET',      // opt-in Purview managed VNet flag
  'LOOM_PURVIEW_MANAGED_VNET_IR',   // opt-in Purview managed VNet IR
  'LOOM_PURVIEW_SHIR_IR_NAME',      // Purview SHIR IR name (code default)
  'LOOM_REPORT_CERTIFIERS',         // report certifier list (code default)
  'LOOM_SERVERLESS_DB',             // Synapse serverless db default (code default)
  'LOOM_SWA_RG',                    // opt-in Static Web Apps resource group
  'LOOM_SYNAPSE_LAKEHOUSE_DB',      // Synapse lakehouse db default (code default)
  'LOOM_WAREHOUSE_DB',              // Synapse warehouse db default (code default)
  'LOOM_WAREHOUSE_SERVER',          // derived Synapse SQL endpoint
  'LOOM_WS_IDENTITY_RG',            // opt-in per-workspace identity resource group
  'LOOM_WS_IDENTITY_SUB',           // opt-in per-workspace identity subscription
  'LOOM_LOGIC_SUB',                 // opt-in Logic App subscription
  'LOOM_DLZ_SUB',                   // opt-in data-landing-zone subscription
  'LOOM_AML_SUB',                   // opt-in AML subscription override
  'LOOM_CAPACITY_LCU',              // capacity-unit tuning knob (code default)
  'LOOM_OBO_CLIENT_ID',             // opt-in on-behalf-of flow (default off; EH Phase-1 scaffold)
  'LOOM_OBO_DATA_PLANE',            // opt-in on-behalf-of data-plane target (default off)
  'LOOM_QUERY_CACHE_COSMOS_CONTAINER', // opt-in query-cache container (derived; default off)
  'LOOM_QUERY_CACHE_DISABLED',      // query-cache toggle (code default)
  'LOOM_QUERY_CACHE_MAX',           // query-cache size cap (code default)
  'LOOM_ADMIN_CENTER_MCP_ENDPOINT', // opt-in M365 Admin Center MCP
  'LOOM_DATAVERSE_MCP_ENDPOINT',    // opt-in Dataverse MCP
  'LOOM_ONEDRIVE_SHAREPOINT_MCP_ENDPOINT', // opt-in OneDrive/SharePoint MCP
]);

// ── Filesystem helpers (no deps) ──
export function walk(dir, exts, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === 'temp' || e.name === 'dist') continue;
      walk(full, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

const ENV_READ_RE = /process\.env\.(LOOM_[A-Z0-9_]+)/g;
const LOOM_TOKEN_RE = /LOOM_[A-Z0-9_]+/g;

/** Every LOOM_* name read under apps/fiab-console/{app,lib}. */
export function collectReads() {
  const reads = new Set();
  const files = [
    ...walk(path.join(CONSOLE_ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(CONSOLE_ROOT, 'lib'), ['.ts', '.tsx']),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    ENV_READ_RE.lastIndex = 0;
    while ((m = ENV_READ_RE.exec(src)) !== null) reads.add(m[1]);
  }
  return reads;
}

/** Every LOOM_* name referenced anywhere under the platform bicep. */
export function collectEmitted() {
  const emitted = new Set();
  const files = walk(BICEP_ROOT, ['.bicep', '.bicepparam']);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    LOOM_TOKEN_RE.lastIndex = 0;
    while ((m = LOOM_TOKEN_RE.exec(src)) !== null) emitted.add(m[0]);
  }
  return emitted;
}

function isAllowlisted(name) {
  if (ALLOWLIST.has(name)) return true;
  return ALLOWLIST_PATTERNS.some((re) => re.test(name));
}

export function computeMissing() {
  const reads = collectReads();
  const emitted = collectEmitted();
  const missing = [];
  for (const name of [...reads].sort()) {
    if (emitted.has(name)) continue;
    if (isAllowlisted(name)) continue;
    missing.push(name);
  }
  return { reads, emitted, missing };
}

function main() {
  const { reads, emitted, missing } = computeMissing();
  console.log(`[env-sync] LOOM_* read by console:   ${reads.size}`);
  console.log(`[env-sync] LOOM_* emitted by bicep:   ${emitted.size}`);
  console.log(`[env-sync] read-but-not-emitted (unallowlisted): ${missing.length}`);
  if (missing.length) {
    console.error('\n[env-sync] FAIL — these LOOM_* vars are read by the console but neither');
    console.error('emitted by platform/fiab/bicep nor allowlisted in scripts/ci/check-env-sync.mjs:');
    for (const n of missing) console.error(`  - ${n}`);
    console.error('\nFix: add the var to the console app env array in');
    console.error('platform/fiab/bicep/modules/admin-plane/main.bicep (or the owning module),');
    console.error('OR, if it is genuinely runtime-only/derived/opt-in, add it to the');
    console.error('ALLOWLIST in scripts/ci/check-env-sync.mjs with a one-line reason.');
    process.exit(1);
  }
  console.log('[env-sync] OK — every read LOOM_* var is emitted or allowlisted.');
  process.exit(0);
}

// Run main() only when invoked directly (not when imported by check-bicep-sync.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
