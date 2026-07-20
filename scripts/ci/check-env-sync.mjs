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
  'LOOM_CONSOLE_URL',               // read only inside GENERATED hosted-app source (workshop eject-to-code server.js template in _palantir-codegen.ts) — the eject route seeds it as an app binding; never a console-runtime var
  'LOOM_READ_WARMER_DISABLED',      // runtime-only opt-out for the dashboard read-warmer (lib/perf/read-warmer.ts) — warming is on by default, never a deploy dependency
  'LOOM_READ_WARMER_INTERVAL_MS',   // runtime-only tuning knob for the read-warmer interval (default 10 min)
  'LOOM_BUILD_SHA',                 // stamped at image build time
  'LOOM_BUILD_TIMESTAMP',           // stamped at image build time
  'LOOM_APP_REVISION',              // ambient container revision fallback for the PSR-1 perf runner (CONTAINER_APP_REVISION is the real ACA-injected value; this is a manual override) — never a blocking dependency
  'LOOM_URL',                       // ambient console base-URL fallback for the PSR-1 perf runner's page-TTI GETs (LOOM_CONSOLE_BASE_URL / the request origin take precedence); also the standard UAT/e2e base-URL convention
  'LOOM_TENANT_ID',                 // ambient Entra tenant (from MSI / token)
  'LOOM_ENTRA_TENANT_ID',           // ambient Entra tenant alias
  'LOOM_REGION',                    // ambient deployment region
  'LOOM_AZURE_LOCATION',            // ambient deployment region alias
  'LOOM_GCCH',                      // cloud flag derived from ARM environment
  'LOOM_IL5',                       // cloud flag derived from ARM environment
  'LOOM_TEMPLATE_TENANT',           // opt-in multi-tenant template mode
  'LOOM_SKIP_DEPLOY_PREFLIGHT',     // dev/opt-in escape hatch
  'LOOM_MAPS_GEOCODE_URL',          // opt-in self-hosted OSS Nominatim (OpenStreetMap) geocoder for the MapLibre (GCC-High) backend; unset => the map's address-geocode sub-feature honest-gates (503) while lat/long + filled layers render. Not a deploy dependency.
  'LOOM_PYLSP_DEBUG',               // dev-only language-server debug flag
  'LOOM_PYLSP_PYTHON',              // dev-only python path override
  'LOOM_POWERPLATFORM_ASSUME_CRED', // opt-in Power Platform cred mode
  'LOOM_COPILOT_STUDIO_PORTAL_URL',  // opt-in cloud override for the Copilot Studio maker-portal deep link (default commercial copilotstudio.microsoft.com; set for Gov) — T93
  'LOOM_M365_ADMIN_CENTER_URL',      // opt-in cloud override for the M365 admin-center approval link (default commercial admin.microsoft.com; admin.microsoft.us for Gov) — T93
  'LOOM_INTERNAL_ALLOWED_OIDS',     // opt-in allowlist of automation oids for the token-gated internal surface (rel-T10/B3); unset default = any well-formed GUID
  'LOOM_MCP_EGRESS_ALLOW',          // opt-in SSRF egress allow-list for admin MCP test-connection (rel-T13)
  'LOOM_MULTIUSER_ACL',             // opt-out kill switch for the multi-user ACL fallback (default on in code; rel-T11)
  'LOOM_SEMANTIC_LINK',             // opt-out kill switch for injecting the Semantic Link notebook helper preamble (default on in code; FGC-17) — Azure-native, no Fabric
  'LOOM_SCHEDULER_EMAIL_WEBHOOK',   // opt-in email relay (ACS/Logic App/SMTP) for scheduler failure alerts (rel-T81); unset = alerts land in the Loom inbox + optional webhook only
  'LOOM_DATABRICKS_UC_STORAGE_ROOT', // opt-in managed-location base (abfss://…) for domain→UC-catalog sync when the metastore has no default storage_root; unset = send no storage_root (metastores with a default root work as-is)
  'LOOM_ITEM_VERSION_CAP',          // opt-in tuning knob for the per-item version-history retention cap (W6); unset default = 50 in code (lib/versions/item-version-store.ts)
  'LOOM_DAB_APP_NAME',              // opt-in override for the shared DAB preview Container App name (apply-to-runtime route #19); unset = derived from the LOOM_DAB_PREVIEW_URL host's first FQDN label
  'LOOM_CANVAS_COMMENT_CAP',        // opt-in tuning knob for the per-(item,canvas) comment/sticky retention cap (W4); unset default = 300 in code (lib/collab/canvas-comment-model.ts)
  'LOOM_ADT_ENDPOINT',
  'LOOM_SPARK_POOL_REAP',            // opt-out kill switch for the stale-Livy-session reaper (#1796; default ON — pool self-cleans leaked sessions)
  'LOOM_SPARK_POOL_REAP_GRACE',      // opt-in tune: grace seconds before an untracked Livy session is reaped (default 600)              // opt-in Azure Digital Twins endpoint (FGC-12); default twin backend is ADX-native — deploy platform/fiab/bicep/modules/integration/adt-instance.bicep to enable
  'LOOM_UNITY_URL',                 // opt-in self-hosted OSS Unity Catalog server URL (GOV-PARITY); the Azure-Government default UC backend (LOOM_UC_BACKEND=oss) since Databricks UC has no Gov endpoint. Deploy compute/loom-unity-app.bicep out-of-band (admin-plane/main.bicep at the 256-param ceiling), then set on the console app. Unset => the UC client honest-gates (OssUcNotConfiguredError) and Commercial keeps using Databricks UC. (LOOM_UC_BACKEND auto-allowed by /_BACKEND$/; LOOM_UNITY_TOKEN by /_TOKEN$/.)
  'LOOM_POWERBI_USER_PASSTHROUGH',  // opt-out kill switch for Power BI user-passthrough (OBO) auth (#1800 PBI slice; default ON in code — all Power BI tie-ins authenticate as the signed-in user, Synapse-style); set 'false' to revert every Power BI call to the console service principal
  'LOOM_RESULT_CACHE_REDIS_BREAKER_THRESHOLD', // opt-in tune: consecutive Redis-tier failures before the cache circuit breaker opens (default 3 in redis-cache-client.ts)
  'LOOM_SETUP_DISCOVERY_CACHE_DISABLED', // opt-out kill switch for the in-process cross-sub discovery SWR cache (Setup / Add-landing-zone wizards); default on in code (lib/azure/cross-sub-cache.ts) — a latency-only memo, no infra
  'LOOM_BATCH_SUB',                 // opt-in subscription override for the Azure Batch account (SVC-5); default = LOOM_SUBSCRIPTION_ID
  'LOOM_CANVAS_AI_SUGGEST',         // opt-out kill switch for the W7 AOAI ghost-suggestion engine (default on in code)
  'LOOM_COPILOT_MEMORY',            // opt-out kill switch for the CTS-06 dump-to-memory action (default on in code)
  'LOOM_COPILOT_MEMORY_AGENT_ID',   // opt-in override for the memory agent identity (CTS-06); unset default in code
  'LOOM_COPILOT_MEMORY_FLUSH_N',    // opt-in tuning knob: how many turns a memory flush extracts (CTS-06)
  'LOOM_COPILOT_MEMORY_CAP',        // opt-in tuning knob: per-scope memory cap before oldest-eviction (CTS-08)
  'LOOM_COPILOT_MEMORY_VEC_INDEX',  // opt-in override for the AI Search vector-mirror index name (CTS-08; default 'copilot-memory-vec' in code)
  'LOOM_COPILOT_MEMORY_L0_LIMIT',   // opt-in tuning knob: L0 identity/preference recall count (CTS-08)
  'LOOM_COPILOT_MEMORY_L1_LIMIT',   // opt-in tuning knob: L1 high-confidence fact recall count (CTS-08)
  'LOOM_COPILOT_MEMORY_L2_TOPK',    // opt-in tuning knob: L2 vector-relevant recall top-K (CTS-08)
  'LOOM_COPILOT_MEMORY_CONSOLIDATE_SCAN', // opt-in tuning knob: per-scope scan depth for the CTS-13 nightly pass
  'LOOM_COPILOT_MEMORY_DEDUPE_SIM', // opt-in tuning knob: Jaccard similarity threshold for CTS-13 near-duplicate merge
  'LOOM_COPILOT_MEMORY_TOPIC_MIN',  // opt-in tuning knob: min tag recurrence to promote a CTS-13 topic page
  'LOOM_SPARK_POOL_CONCURRENT',     // opt-out kill switch for the FGC-10 concurrent shared-session mode (default on in code)
  'LOOM_SPARK_POOL_SHARED_MAX',     // opt-in tuning knob: max read-only leases sharing one warm session (PSR-3/FGC-10)
  // PSR-5/6 result cache — all opt-in: unset default = in-process LRU (no Redis,
  // no behavior change). The shared Redis is the hband-shared.bicep instance
  // deployed out-of-band (admin-plane at the 256-param ceiling).
  'LOOM_RESULT_CACHE_REDIS',           // opt-in Redis host:port for the shared result-cache tier (PSR-5/6)
  'LOOM_RESULT_CACHE_REDIS_PASSWORD',  // opt-in Redis access key (PSR-5/6); prefer KV/secretRef when wired into bicep
  'LOOM_RESULT_CACHE_REDIS_TLS',       // opt-in TLS toggle for the Redis tier (default on for :6380)
  'LOOM_QUERY_CACHE_TTL_MS_DEDICATED', // opt-in tuning knob: dedicated-pool result TTL override (PSR-5)
  'LOOM_QUERY_CACHE_TTL_MS_SERVERLESS',// opt-in tuning knob: serverless result TTL override (PSR-5)
  // OBS-CACHE — per-backend result-TTL overrides for the observability routes'
  // stale-while-revalidate cache (chargeback/usage/audit/copilot-usage/monitor).
  // All opt-in tuning knobs: unset default = the route's own default TTL in code.
  'LOOM_QUERY_CACHE_TTL_MS_COSTMGMT',    // opt-in: chargeback / cost-attribution TTL override (default 20m)
  'LOOM_QUERY_CACHE_TTL_MS_USAGEROLLUP', // opt-in: usage-metrics TTL override (default 5m)
  'LOOM_QUERY_CACHE_TTL_MS_AUDITMERGE',  // opt-in: audit-log 3-backend-merge TTL override (default 5m)
  'LOOM_QUERY_CACHE_TTL_MS_COPILOTUSAGE',// opt-in: copilot-usage TTL override (default 10m)
  'LOOM_QUERY_CACHE_TTL_MS_MONITOR',     // opt-in: monitor inventory/health/activity/metrics TTL override (default 90s)
  // PSR-8 Copilot turn-latency SLO — opt-in tuning knobs; unset defaults match the
  // perf-budgets ceilings so the CI gate and the runtime SLO never disagree.
  'LOOM_COPILOT_SLO_FIRST_TOKEN_MS', // opt-in: streaming first-token p95 budget override (default 5000)
  'LOOM_COPILOT_SLO_FULL_TURN_MS',   // opt-in: full-turn p95 budget override (default 30000)
  'LOOM_COPILOT_SLO_OBJECTIVE',      // opt-in: SLO attainment objective 0..1 override (default 0.95)
  // Databricks pipeline linked-service binding — opt-in (Databricks is an
  // alternative Azure-native compute; Synapse is the default). Used by the
  // dev-pipeline seeder to auto-stub / bind the AzureDatabricks linked service a
  // bundle's Databricks-notebook activities require. Unset default = honest
  // remediation gate on those pipeline items (lib/install/provisioners/_seed-dev-pipeline.ts).
  'LOOM_DATABRICKS_WORKSPACE_URL',        // opt-in Databricks workspace URL (alias of LOOM_DATABRICKS_HOSTNAME with scheme)
  'LOOM_DATABRICKS_WORKSPACE_RESOURCE_ID', // opt-in Databricks workspace ARM resourceId — enables MSI auth on the auto-stubbed linked service
  'LOOM_DATABRICKS_LINKED_SERVICE',       // opt-in name of an already-registered AzureDatabricks linked service to reuse instead of auto-stubbing
  // SVC-1/SVC-8 — AI-enrichment cognitive endpoints. NOW EMITTED default-ON by
  // admin-plane/main.bicep (LOOM_DOCINTEL/VISION/LANGUAGE/TRANSLATOR_ENDPOINT +
  // LOOM_TRANSLATOR_REGION), derived from the multi-service AIServices (Foundry)
  // custom-domain endpoint the Console UAMI already has "Cognitive Services User"
  // on — so they are no longer allowlisted (a clean deploy wires them). Dedicated
  // single-kind accounts (deploy-planner/cognitive-account.bicep) remain an opt-in
  // override set via /admin/env-config.

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
  'LOOM_AML_SERVERLESS_VMSIZE',     // AML serverless job VM size (code default Standard_DS3_v2)
  'LOOM_AML_SPARK_INSTANCE_TYPE',   // AML spark sizing (code default)
  'LOOM_AML_SPARK_RUNTIME',         // AML spark runtime version (code default)
  'LOOM_ADMIN_RESOURCE_GROUP',      // script-context alias for LOOM_ADMIN_RG; falls back to resourceGroup()/ARM
  'LOOM_AML_WORKSPACE_NAME',        // derived from Foundry hub
  'LOOM_APPS_KEY_VAULT_URI',        // opt-in KV uri for Loom Apps secretRef env resolution; falls back to LOOM_KEY_VAULT_URI (loom-apps-client)
  'LOOM_AOAI_CLIENT_V2',            // opt-in AOAI client switch
  // Model-strategy M4 — OPT-IN APIM AI-gateway routing. Emitted by admin-plane/main.bicep
  // (default OFF/direct), and read via an injected `env` param in aoai-apim-gateway.ts
  // (resolveAoaiCallTarget) rather than a literal process.env.* — so the reader-scan
  // does not see them; allowlisted explicitly to document intent. Default = direct-with-MI.
  'LOOM_AOAI_VIA_APIM',             // opt-in: route AOAI through the APIM gateway (default false → direct)
  'LOOM_AOAI_APIM_URL',             // opt-in: APIM gateway URL (emitted only when the AI-gateway is authored)
  'LOOM_AOAI_APIM_SUBSCRIPTION_KEY',// opt-in APIM subscription key for the AI-gateway (secret; MI bearer works without it)
  // Model-strategy M5 — cloud-aware best-available model resolution. Opt-OUT
  // kill switch (default ON): the runtime degrades a configured-but-undeployed
  // model down to a supported one (per model-availability-matrix.ts) against the
  // account's live deployment list. Cached + non-fatal; never blocks a chat.
  'LOOM_AOAI_AVAILABILITY_CHECK',   // opt-out: disable the M5 best-available-model fallback (default ON → configured-but-missing model degrades gracefully instead of 404ing)
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
  'LOOM_PBI_CAPACITY_ID',           // opt-in Fabric/Premium capacity id (Weave→Power BI D2); unset default = the VM on-prem data gateway is used. When set, the Network pane recommends the managed VNet data gateway auto-upgrade (LOOM_PBI_GATEWAY_MODE=auto). Operator provides per D3.
  'LOOM_PBI_WORKSPACE_ID',          // opt-in bound Power BI workspace id (Weave→Power BI D3, real-PBI destination W5); unset default = the real Power BI Service destination honest-gates and the Azure-native/loom-native path is used. Operator provides.
  'LOOM_PBI_TEMPLATE_REPORT',       // opt-in blank template report (id or name) the real-PBI report/dashboard targets clone (Power BI REST has no create-report-bound-to-model API — W5); unset default = report/dashboard on the real-PBI path honest-gates. Operator uploads a blank .pbix + sets this.
  'LOOM_DELTA_SHARING_VOLUME',      // opt-in delta-sharing volume
  'LOOM_DEVCENTER_CATALOG',         // opt-in DevCenter catalog
  'LOOM_DEVCENTER_ENV_TYPE',        // opt-in DevCenter env type
  'LOOM_DEVCENTER_URI',             // opt-in DevCenter uri
  'LOOM_DIRECT_LAKE_COSMOS_CONTAINER', // opt-in Direct Lake mirror
  'LOOM_DIRECT_LAKE_COSMOS_DB',     // opt-in Direct Lake mirror
  'LOOM_DIRECTLAKE_URL',            // opt-in Loom Direct Lake columnar scan service (HYP-5); honest-503 gate when unset, semantic layer falls back to AAS/Synapse-Serverless. Deploy compute/loom-directlake-app.bicep out-of-band (admin-plane/main.bicep at the 256-param ceiling), then set on the console app
  'LOOM_DQ_SOURCE_CONNECTION_STRING', // handled by _CONNECTION_STRING pattern; kept for clarity
  'LOOM_DSPM_AI_AGENT_ITEM_TYPES',  // classifier config list (code default)
  'LOOM_DSPM_AI_WINDOW_DAYS',       // opt-in default usage-window override (code default 14)
  'LOOM_DSPM_AI_TTL_MS',            // opt-in posture-memo TTL tuning (code default 60s)
  'LOOM_EVENTHUB_CONSUMER_GROUP',   // opt-in consumer-group override for the EH health-exercise probe (code default 'loom')
  'LOOM_EVENTHUB_DEFAULT_HUB',      // opt-in default hub name for the EH health-exercise probe (code default 'loom-eventstream')
  'LOOM_EVENTSTREAM_EVENTS_TABLE',  // ADX table default (code default)
  'LOOM_ASA_REFERENCE_CONTAINER',   // opt-in blob container for the ASA reference-data geofence (falls back to 'landing' → first configured container)
  'LOOM_EVENTSTREAM_HUB',           // opt-in eventstream hub-name alias for the EH health-exercise probe (fallback for LOOM_EVENTHUB_DEFAULT_HUB)
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
  'LOOM_PURVIEW_ENDPOINT',          // optional operator override: explicit Purview data-plane base URL (default: ARM-derived endpoints → cloud-aware convention host; purview-endpoints.ts)
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
  'LOOM_QUERY_CACHE_COSMOS_CONTAINER', // opt-in override of the query-cache Cosmos container id (default 'query-result-cache' when a Cosmos endpoint is set — PSR-5 default-ON)
  'LOOM_QUERY_CACHE_COSMOS_DISABLED', // opt-OUT of the distributed (Cosmos) result-cache tier (PSR-5 default-ON; set '1' to disable)
  'LOOM_QUERY_CACHE_DISABLED',      // query-cache toggle (code default)
  'LOOM_QUERY_CACHE_MAX',           // query-cache size cap (code default)
  'LOOM_ADMIN_CENTER_MCP_ENDPOINT', // opt-in M365 Admin Center MCP
  'LOOM_DATAVERSE_MCP_ENDPOINT',    // opt-in Dataverse MCP
  'LOOM_ONEDRIVE_SHAREPOINT_MCP_ENDPOINT', // opt-in OneDrive/SharePoint MCP
  // AIF-18 — browser-automation tool runner. Opt-in, unset by default (the tool
  // honest-gates). Deploy platform/fiab/bicep/modules/copilot/browser-tool.bicep
  // (ACA Job) and set LOOM_BROWSER_TOOL_JOB to its resource id, or point
  // LOOM_BROWSER_TOOL_ENDPOINT at a synchronous HTTP Playwright runner.
  'LOOM_BROWSER_TOOL_JOB',          // opt-in Playwright ACA-job resource id (default off — honest gate)
  'LOOM_BROWSER_TOOL_ENDPOINT',     // opt-in synchronous Playwright HTTP runner (default off — honest gate)
  // BR-WEBHOOK — outbound webhook delivery. DIRECT HTTPS + HMAC is the zero-infra
  // DEFAULT (default-ON); Event Grid is the opt-in ALTERNATIVE transport. The
  // topic endpoint is unset unless the operator deploys the standalone
  // platform/fiab/bicep/modules/admin-plane/event-grid-webhooks.bicep module
  // (NOT wired into admin-plane/main.bicep — that file is at the 256-param
  // ceiling). LOOM_EVENTGRID_TOPIC_KEY is a secret (matched by the _KEY pattern).
  'LOOM_EVENTGRID_TOPIC_ENDPOINT',  // opt-in Event Grid custom-topic endpoint (default off — direct HTTPS delivery is used)
  'LOOM_ACCESS_REQUEST_WEBHOOK',    // opt-in best-effort Teams/Logic App incoming webhook pinged on a new sign-in access request (lib/access/signin-access-request.ts); unset = silent no-op, the /admin/access-requests queue is the source of truth
  'LOOM_ONBOARDING_ENTRA_GROUP_NAME', // opt-in display override for the onboarding group named in the approve-request instruction (app/api/admin/access-requests/[id]/route.ts); unset = falls back to LOOM_TENANT_ADMIN_GROUP_ID — cosmetic, never a gate
  'LOOM_SELF_BASE_URL',             // derived/ambient override for the server-side same-origin self-call base in demo-deploy (lib/apps/demo-deploy.ts); unset default = http://127.0.0.1:$PORT (the container hairpin), never a deployed literal
  'LOOM_UPDATE_IMAGE_REGISTRY',     // opt-in registry override for the in-place update-apply image resolution (app/api/admin/updates/apply/route.ts); unset default = swap the tag on the app's CURRENT image (its own private ACR), no public-ghcr dependency
  'LOOM_SKILL_LEARNER_MIN_SAMPLES', // CTS-11 opt-in tuning knob: min recurring prompts on a pane before the skill self-evolution learner proposes a SUGGESTED skill (default 5 in lib/azure/skill-learner.ts); admin-reviewed, never auto-published. (LOOM_SKILL_LEARNER_ENABLED matched by /_ENABLED$/, LOOM_SKILL_LEARNER_MAX_* by /_MAX_.../)
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
