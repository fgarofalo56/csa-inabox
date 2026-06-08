/**
 * cloud-endpoints — the single source of truth for every sovereign-cloud
 * endpoint suffix and AAD scope used by the Loom Azure clients and BFF routes.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Loom runs in Commercial, GCC (which uses Commercial Azure), GCC-High and
 * IL5 (both `AzureUSGovernment`). Each cloud has DIFFERENT hostnames for the
 * ARM control plane, Key Vault, Service Bus / Event Hubs, ADLS Gen2 (DFS) and
 * ADX (Kusto). A client that hard-codes `management.azure.com` /
 * `servicebus.windows.net` / `kusto.windows.net` silently fails in Gov. To
 * keep the migration auditable (per the no-vaporware grep gate) EVERY such
 * literal lives here and nowhere else — clients import these helpers instead.
 *
 * SELECTION
 * ---------
 * Highest priority: `LOOM_ARM_ENDPOINT` (explicit ARM base override — wins for
 * sovereign clouds whose ARM host we don't enumerate). Otherwise `AZURE_CLOUD`
 * (`AzureCloud` | `AzureUSGovernment` | `AzureDOD`) drives the lookup. This
 * mirrors the gold-standard `armBase()` already in `adf-client.ts` so existing
 * deployments keep their exact behaviour.
 *
 * Per-cloud truth table (verified against Microsoft Learn):
 *
 *  | suffix            | Commercial / GCC      | GCC-High / IL5 (USGov)      |
 *  |-------------------|-----------------------|-----------------------------|
 *  | ARM base          | management.azure.com  | management.usgovcloudapi.net|
 *  | Key Vault         | vault.azure.net       | vault.usgovcloudapi.net     |
 *  | Service Bus / EH  | servicebus.windows.net| servicebus.usgovcloudapi.net|
 *  | ADLS Gen2 (DFS)   | dfs.core.windows.net  | dfs.core.usgovcloudapi.net  |
 *  | ADX (Kusto)       | kusto.windows.net     | kusto.usgovcloudapi.net     |
 *
 * No Fabric / Power BI endpoints are introduced here — every helper is
 * Azure-native (per no-fabric-dependency.md).
 */

export type CloudName = 'AzureCloud' | 'AzureUSGovernment' | 'AzureDOD';

/**
 * The four sovereign boundaries Loom targets, as a single canonical
 * discriminator. Unlike `CloudName` (which collapses GCC into `AzureCloud`
 * because GCC runs on Commercial Azure endpoints), `LoomCloud` keeps GCC
 * distinct so the console can badge it correctly and `getGraphHost()` can make
 * the 3-way Graph split (Commercial+GCC share, GCC-High differs, DoD differs
 * again).
 */
export type LoomCloud = 'Commercial' | 'GCC' | 'GCC-High' | 'DoD';

/**
 * Detect the active sovereign boundary. `LOOM_CLOUD` is the canonical, enum
 * signal (`Commercial | GCC | GCC-High | DoD`; `IL5` is accepted as an alias of
 * `GCC-High` since both run on `AzureUSGovernment` endpoints). When `LOOM_CLOUD`
 * is absent we fall back to the legacy `AZURE_CLOUD` value so existing
 * deployments keep their exact behaviour. Unknown values default to Commercial
 * (never crash — this is a host resolver, not a validator).
 */
export function detectLoomCloud(): LoomCloud {
  const lc = (process.env.LOOM_CLOUD || '').trim().toLowerCase();
  if (lc) {
    switch (lc) {
      case 'commercial':
        return 'Commercial';
      case 'gcc':
        return 'GCC';
      case 'gcc-high':
      case 'gcchigh':
      case 'il5':
        return 'GCC-High';
      case 'dod':
        return 'DoD';
      // Unknown LOOM_CLOUD value — fall through to AZURE_CLOUD below.
    }
  }
  switch ((process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase()) {
    case 'azureusgovernment':
      return 'GCC-High';
    case 'azuredod':
      return 'DoD';
    default:
      return 'Commercial';
  }
}

/** Normalise to the Azure-endpoint cloud (GCC collapses to Commercial). */
export function detectCloud(): CloudName {
  switch (detectLoomCloud()) {
    case 'GCC-High':
      return 'AzureUSGovernment';
    case 'DoD':
      return 'AzureDOD';
    default:
      // Commercial + GCC both run on Commercial Azure endpoints.
      return 'AzureCloud';
  }
}

/** True when running in an Azure Government boundary (GCC-High / IL5 / DoD). */
export function isGovCloud(): boolean {
  const c = detectCloud();
  return c === 'AzureUSGovernment' || c === 'AzureDOD';
}

// ---------------------------------------------------------------------------
// ARM control plane
// ---------------------------------------------------------------------------

/** ARM control-plane base URL (no trailing slash). */
export function armBase(): string {
  const explicit = process.env.LOOM_ARM_ENDPOINT;
  if (explicit) return explicit.replace(/\/+$/, '');
  switch (detectCloud()) {
    case 'AzureUSGovernment':
      return 'https://management.usgovcloudapi.net';
    // Azure Government Secret (DoD) — matches adf-client's existing mapping.
    case 'AzureDOD':
      return 'https://management.azure.microsoft.scloud';
    default:
      return 'https://management.azure.com';
  }
}

/** Bare ARM host (no scheme) for call sites that build their own URL string. */
export function armHost(): string {
  return armBase().replace(/^https?:\/\//, '');
}

/** AAD `.default` scope for ARM tokens. */
export function armScope(): string {
  return `${armBase()}/.default`;
}

/** ARM audience for MSI authentication (trailing slash, as ARM expects). */
export function armAudience(): string {
  return `${armBase()}/`;
}

/**
 * Strip the ARM base from a fully-qualified ARM URL, leaving the bare
 * `/subscriptions/...` resource path. Replaces the fragile per-client
 * `.replace('https://management.azure.com', '')` calls.
 */
export function stripArmBase(url: string): string {
  const base = armBase();
  return url.startsWith(base) ? url.slice(base.length) : url;
}

// ---------------------------------------------------------------------------
// Key Vault (data plane)
// ---------------------------------------------------------------------------

/** Key Vault data-plane hostname suffix (no leading dot). */
export function kvSuffix(): string {
  return isGovCloud() ? 'vault.usgovcloudapi.net' : 'vault.azure.net';
}

/** AAD scope for Key Vault data-plane tokens. */
export function kvScope(): string {
  return `https://${kvSuffix()}/.default`;
}

/** Build the Key Vault base URL from a bare vault name. */
export function kvUrlFromName(name: string): string {
  return `https://${name}.${kvSuffix()}`;
}

// ---------------------------------------------------------------------------
// Azure Cognitive Services / Azure OpenAI (data plane)
// ---------------------------------------------------------------------------

/**
 * AAD `.default` scope for Azure Cognitive Services / Azure OpenAI tokens.
 *
 * The cognitiveservices audience differs by sovereign boundary: Commercial /
 * GCC use `cognitiveservices.azure.com`; GCC-High / IL5 (both
 * `AzureUSGovernment`) use `cognitiveservices.azure.us`. Hard-coding the
 * Commercial scope silently fails AOAI auth in Gov — every AOAI token request
 * must go through this helper. The AOAI REST data-plane URL itself comes from
 * `LOOM_AOAI_ENDPOINT` (`*.openai.azure.com` vs `*.openai.azure.us`), which
 * Bicep wires per boundary.
 */
export function cogScope(): string {
  return isGovCloud()
    ? 'https://cognitiveservices.azure.us/.default'
    : 'https://cognitiveservices.azure.com/.default';
}

// ---------------------------------------------------------------------------
// Service Bus / Event Hubs (data plane)
// ---------------------------------------------------------------------------

/** Service Bus / Event Hubs FQDN suffix (no leading dot). */
export function serviceBusSuffix(): string {
  return isGovCloud() ? 'servicebus.usgovcloudapi.net' : 'servicebus.windows.net';
}

/** Build the fully-qualified namespace from a bare name (passes FQDNs through). */
export function serviceBusFqdn(namespace: string): string {
  return namespace.includes('.') ? namespace : `${namespace}.${serviceBusSuffix()}`;
}

// ---------------------------------------------------------------------------
// ADLS Gen2 (DFS data plane)
// ---------------------------------------------------------------------------

/** ADLS Gen2 DFS hostname suffix (no leading dot). */
export function dfsSuffix(): string {
  return isGovCloud() ? 'dfs.core.usgovcloudapi.net' : 'dfs.core.windows.net';
}

/** Build the DFS endpoint base URL for a storage account. */
export function dfsUrl(account: string): string {
  return `https://${account}.${dfsSuffix()}`;
}

// ---------------------------------------------------------------------------
// ADX / Kusto (data plane)
// ---------------------------------------------------------------------------

/** ADX cluster hostname suffix (no leading dot). */
export function kustoSuffix(): string {
  return isGovCloud() ? 'kusto.usgovcloudapi.net' : 'kusto.windows.net';
}

/** Build a cluster URI from `name` + `region` (e.g. `adx-loom`, `eastus2`). */
export function kustoClusterUri(clusterName: string, region: string): string {
  return `https://${clusterName}.${region}.${kustoSuffix()}`;
}

// ---------------------------------------------------------------------------
// Azure Machine Learning data plane (api.azureml.ms / api.ml.azure.us)
// ---------------------------------------------------------------------------

/**
 * AML regional data-plane host (no scheme) for a given workspace region. This
 * is the host the MLflow tracking / registry REST and the foundry data-plane
 * calls hang off — `<region>.api.azureml.ms` in Commercial/GCC, but
 * `<region>.api.ml.azure.us` in the US Government clouds (verified against
 * Microsoft Learn "reference-machine-learning-cloud-parity", e.g.
 * `usgovvirginia.api.ml.azure.us`). Hard-coding `api.azureml.ms` silently
 * fails in GCC-High / IL5 — every AML data-plane URL builds this host instead.
 *
 * `LOOM_AML_DATAPLANE_HOST` overrides the suffix outright for private-link
 * workspaces or clouds we don't enumerate (it may be a bare suffix like
 * `api.ml.azure.us` — the region is prefixed — or a full host already
 * containing the region, which is passed through).
 */
export function amlDataPlaneHost(region: string): string {
  const override = process.env.LOOM_AML_DATAPLANE_HOST;
  if (override) {
    const o = override.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    // Full host already carrying the region (contains it) is passed through;
    // otherwise treat the override as a suffix and prefix the region.
    return o.startsWith(`${region}.`) ? o : `${region}.${o}`;
  }
  switch (detectCloud()) {
    case 'AzureUSGovernment':
    case 'AzureDOD':
      return `${region}.api.ml.azure.us`;
    default:
      return `${region}.api.azureml.ms`;
  }
}

// ---------------------------------------------------------------------------
// Governance-client data-plane getters (the canonical `get*` surface)
// ---------------------------------------------------------------------------
//
// One getter per sovereign-variant suffix/host that the governance clients
// (cosmos, AI Search, MIP/DLP Graph, Synapse SQL) used to hard-code. Every
// suffix is verified against Microsoft Learn:
//   https://learn.microsoft.com/azure/azure-government/compare-azure-government-global-azure
//   https://learn.microsoft.com/graph/deployments
//
//  | getter                | Commercial / GCC          | GCC-High (USGov)        | DoD                        |
//  |-----------------------|---------------------------|-------------------------|----------------------------|
//  | getArmHost            | management.azure.com      | management.usgovcloudapi.net | management.azure.microsoft.scloud |
//  | getCosmosSuffix       | documents.azure.com       | documents.azure.us      | documents.azure.us         |
//  | getSearchSuffix       | search.windows.net        | search.azure.us         | search.azure.us            |
//  | getGraphHost          | graph.microsoft.com       | graph.microsoft.us      | dod-graph.microsoft.us     |
//  | getSqlSuffix          | database.windows.net      | database.usgovcloudapi.net | database.usgovcloudapi.net |
//  | getLogAnalyticsHost   | api.loganalytics.azure.com| api.loganalytics.us     | api.loganalytics.us        |
//  | getBlobSuffix         | blob.core.windows.net     | blob.core.usgovcloudapi.net | blob.core.usgovcloudapi.net |
//  | getOpenAiSuffix       | openai.azure.com          | openai.azure.us         | openai.azure.us            |
//  | getPbiGovHost         | api.powerbi.com           | api.powerbigov.us       | api.powerbigov.us          |
//
// Only `getGraphHost()` is a 3-way split (Graph has a distinct DoD host); the
// rest follow the Commercial-vs-Gov binary, so they key off `isGovCloud()`.

/** Bare ARM control-plane host (no scheme). Alias of `armHost()`. */
export function getArmHost(): string {
  return armHost();
}

/** Cosmos DB data-plane hostname suffix (no leading dot, no account prefix). */
export function getCosmosSuffix(): string {
  return isGovCloud() ? 'documents.azure.us' : 'documents.azure.com';
}

/** Azure AI Search data-plane hostname suffix (no leading dot). */
export function getSearchSuffix(): string {
  return isGovCloud() ? 'search.azure.us' : 'search.windows.net';
}

/**
 * Microsoft Graph host (full URL with scheme, no trailing slash). Per
 * Microsoft Learn `graph/deployments`, GCC uses the worldwide
 * `graph.microsoft.com` host (same as Commercial); GCC-High uses
 * `graph.microsoft.us`; DoD uses `dod-graph.microsoft.us`.
 */
export function getGraphHost(): string {
  switch (detectLoomCloud()) {
    case 'DoD':
      return 'https://dod-graph.microsoft.us';
    case 'GCC-High':
      return 'https://graph.microsoft.us';
    default:
      // Commercial + GCC both use the worldwide Graph endpoint.
      return 'https://graph.microsoft.com';
  }
}

/** AAD `.default` scope for Microsoft Graph tokens (host-derived per cloud). */
export function getGraphScope(): string {
  return `${getGraphHost()}/.default`;
}

/**
 * Azure SQL / Synapse TDS AAD token audience host (no scheme, no `.default`).
 * This is the generic SQL token resource — Synapse adds its own FQDN suffix
 * (`sql.azuresynapse.*`) on top, see `synapseSqlSuffix()`.
 */
export function getSqlSuffix(): string {
  return isGovCloud() ? 'database.usgovcloudapi.net' : 'database.windows.net';
}

/**
 * Synapse SQL endpoint domain suffix (no leading dot). Synapse uses a
 * service-specific suffix that differs from the generic SQL token audience,
 * so it gets its own getter rather than reusing `getSqlSuffix()`.
 */
export function synapseSqlSuffix(): string {
  return isGovCloud() ? 'sql.azuresynapse.usgovcloudapi.net' : 'sql.azuresynapse.net';
}

/** Log Analytics query-API host (full URL with scheme). */
export function getLogAnalyticsHost(): string {
  return isGovCloud() ? 'https://api.loganalytics.us' : 'https://api.loganalytics.azure.com';
}

/** Azure Blob storage hostname suffix (no leading dot, no account prefix). */
export function getBlobSuffix(): string {
  return isGovCloud() ? 'blob.core.usgovcloudapi.net' : 'blob.core.windows.net';
}

/** Azure OpenAI data-plane hostname suffix (no scheme, no account prefix). */
export function getOpenAiSuffix(): string {
  return isGovCloud() ? 'openai.azure.us' : 'openai.azure.com';
}

/**
 * Power BI REST API host (full URL, no `/v1.0/myorg` suffix). This is the
 * Azure-Government-backed Power BI REST host — NOT a Fabric API host — so it
 * is permitted here per no-fabric-dependency.md.
 */
export function getPbiGovHost(): string {
  return isGovCloud() ? 'https://api.powerbigov.us' : 'https://api.powerbi.com';
}

// ---------------------------------------------------------------------------
// Cloud-invariant constants
// ---------------------------------------------------------------------------

/**
 * Logic App / ARM-template `$schema` identifier. This is a JSON-schema
 * NAMESPACE, not a reachable endpoint — it is byte-identical in every cloud,
 * so it lives here (the only file allowed to contain the literal) and is
 * referenced by every Logic App workflow definition instead of being inlined.
 */
export const LOGIC_APP_WORKFLOW_SCHEMA =
  'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#';

// ---------------------------------------------------------------------------
// Legacy / alias accessors (kept for call sites that adopted the shorter
// `get*` names from the parallel sovereign-cloud work). These delegate to the
// canonical helpers above so there is still ONE source of truth per suffix.
// ---------------------------------------------------------------------------

/** True when running in an Azure US Government boundary. Alias of isGovCloud(). */
export function isUsGov(): boolean {
  return isGovCloud();
}

/** ADLS Gen2 DFS endpoint suffix for the active cloud. Alias of dfsSuffix(). */
export function getDfsSuffix(): string {
  return dfsSuffix();
}

/** ARM management endpoint for the active cloud. Alias of armBase(). */
export function getArmEndpoint(): string {
  return armBase();
}

/** Kusto (ADX) cluster URI host suffix for the active cloud. Alias of kustoSuffix(). */
export function getKustoSuffix(): string {
  return kustoSuffix();
}
