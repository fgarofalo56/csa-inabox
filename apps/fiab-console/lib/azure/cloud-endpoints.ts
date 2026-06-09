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
// Azure Data Factory Studio (browser deep-links)
// ---------------------------------------------------------------------------

/**
 * Azure Data Factory Studio browser base URL (no trailing slash). Sovereign
 * cloud aware: Commercial + GCC run on the global ADF Studio
 * (https://adf.azure.com); GCC-High / IL5 / DoD run on the Azure Government
 * ADF Studio (https://adf.azure.us). Grounded in the Azure Government
 * endpoint mapping for Data Factory (Learn: azure-government/compare-azure-government-global-azure).
 *
 * Used to build "Get data" deep-links — `{adfStudioBase()}/copyDataTool?factory=…`,
 * `/authoring/pipeline/{name}?factory=…`, `/authoring/dataflow/{name}?factory=…`.
 */
export function adfStudioBase(): string {
  return isGovCloud() ? 'https://adf.azure.us' : 'https://adf.azure.com';
}

/**
 * Bare ARM resource ID of a Data Factory (NO management host prefix) —
 * `/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.DataFactory/factories/{name}`.
 * This is the value ADF Studio expects as its `factory=` deep-link query
 * parameter (URL-encode before appending). Pure string builder — no Azure SDK
 * dependency — so it is unit-testable without the credential chain.
 */
export function adfFactoryDeepLinkId(subscriptionId: string, resourceGroup: string, factoryName: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DataFactory/factories/${factoryName}`;
}

// ---------------------------------------------------------------------------
// Microsoft Graph (national-cloud aware)
// ---------------------------------------------------------------------------
//
// Graph has DISTINCT service roots per sovereign cloud (verified against
// Microsoft Learn — https://learn.microsoft.com/graph/deployments):
//
//   | National cloud                      | Microsoft Graph root            |
//   |-------------------------------------|---------------------------------|
//   | Global (Commercial / GCC)           | https://graph.microsoft.com     |
//   | US Government L4 (GCC High)          | https://graph.microsoft.us      |
//   | US Government L5 (DoD / IL5)         | https://dod-graph.microsoft.us  |
//
// Access tokens are NOT interchangeable across roots, so the scope must match
// the chosen base. A client that hard-codes graph.microsoft.com fails in Gov.

/** Friendly cloud-boundary label for UI/MessageBar copy (e.g. "GCC High (L4)"). */
export function cloudBoundaryLabel(): string {
  // Prefer the explicit deployment boundary when bicep wires it through; this
  // distinguishes GCC-High from IL5 (both map to AzureUSGovernment otherwise).
  const explicit = (process.env.LOOM_CLOUD_BOUNDARY || '').trim();
  if (explicit) {
    switch (explicit.toLowerCase()) {
      case 'commercial': return 'Commercial';
      case 'gcc': return 'GCC';
      case 'gcc-high': case 'gcchigh': return 'GCC High (L4)';
      case 'il5': case 'dod': return 'DoD (IL5/L5)';
      default: return explicit;
    }
  }
  switch (detectCloud()) {
    case 'AzureUSGovernment': return 'US Government (GCC High / IL5)';
    case 'AzureDOD': return 'DoD (IL5/L5)';
    default: return 'Commercial';
  }
}

/**
 * Whether Microsoft Graph exposes the `/beta/security/dataLossPreventionPolicies`
 * policy-management surface for the active cloud. This preview segment is NOT
 * available in the US Government / DoD Graph roots as of 2026 — DLP policy
 * authoring there remains Purview-compliance-portal + Security & Compliance
 * PowerShell only. DLP ALERTS (`/v1.0/security/alerts_v2`) and restrict-access
 * RBAC enforcement still work in every cloud.
 */
export function graphDlpPolicyApiAvailable(): boolean {
  return !isGovCloud();
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
// Microsoft Graph (Entra principal search, directory reads)
// ---------------------------------------------------------------------------

/**
 * Microsoft Graph data-plane base URL including the `/v1.0` version segment
 * (no trailing slash). Commercial / GCC use `graph.microsoft.com`; GCC-High /
 * IL5 / DoD (`AzureUSGovernment` / `AzureDOD`) use `graph.microsoft.us`.
 * `LOOM_GRAPH_BASE` overrides for non-standard sovereign clouds.
 */
export function graphBase(): string {
  const explicit = process.env.LOOM_GRAPH_BASE;
  if (explicit) return explicit.replace(/\/+$/, '');
  return isGovCloud()
    ? 'https://graph.microsoft.us/v1.0'
    : 'https://graph.microsoft.com/v1.0';
}

/** AAD `.default` scope for Microsoft Graph tokens (host root, not the /v1.0 path). */
export function graphScope(): string {
  const host = graphBase().replace(/\/v1\.0\/?$/, '');
  return `${host}/.default`;
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

/**
 * Convert a landed snapshot's https dfs URL into the abfss form Spark reads:
 *   https://ACCT.dfs.core.windows.net/CONTAINER/PATH
 *     → abfss://CONTAINER@ACCT.dfs.core.windows.net/PATH
 *
 * Sovereign-cloud aware: the dfs suffix comes from `dfsSuffix()` so a Gov URL
 * (`*.dfs.core.usgovcloudapi.net`) is converted too — a hard-coded
 * `.dfs.core.windows.net` regex would silently pass Gov URLs through unchanged
 * and break Spark `abfss://` reads in GCC-High / IL5. Returns the input
 * unchanged if it isn't a dfs https URL for the active cloud. Lives here (the
 * pure endpoint module) rather than in the mssql-importing mirror-engine so it
 * is unit-testable without the SQL/identity native dependency chain.
 */
export function httpsToAbfss(httpsUrl: string): string {
  const suffix = dfsSuffix().replace(/\./g, '\\.');
  const m = (httpsUrl || '').match(
    new RegExp(`^https://([^.]+)\\.${suffix}/([^/]+)/(.*)$`, 'i'),
  );
  if (!m) return httpsUrl;
  const [, account, container, path] = m;
  return `abfss://${container}@${account}.${dfsSuffix()}/${path}`;
}

// ---------------------------------------------------------------------------
// Azure AI Search (data plane)
// ---------------------------------------------------------------------------

/**
 * AI Search data-plane hostname suffix (no leading dot).
 *
 * Commercial / GCC (GCC runs on Commercial Azure) → `search.windows.net`.
 * GCC-High / IL5 (`AzureUSGovernment`) → `search.usgovcloudapi.net`. Hard-coding
 * the Commercial suffix silently fails AI Search auth + data-plane in Gov, so
 * every search client builds its base URL from this helper.
 */
export function searchSuffix(): string {
  return isGovCloud() ? 'search.usgovcloudapi.net' : 'search.windows.net';
}

/** Build the AI Search data-plane base URL from a bare service name (FQDNs pass through). */
export function searchEndpointBase(serviceName: string): string {
  if (serviceName.includes('.')) {
    return `https://${serviceName.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  }
  return `https://${serviceName}.${searchSuffix()}`;
}

/**
 * AAD scope for AI Search data-plane tokens. `https://search.azure.com/.default`
 * is cloud-invariant — the resource audience is byte-identical in Commercial,
 * GCC, GCC-High and IL5 (only the token issuer changes, not the resource). Kept
 * here so the separate literals across the search clients share one source.
 */
export const SEARCH_AAD_SCOPE = 'https://search.azure.com/.default';

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
// Azure Cosmos DB (data plane — documents endpoint)
// ---------------------------------------------------------------------------

/**
 * Cosmos DB data-plane document-endpoint hostname suffix (no leading dot).
 *   Commercial / GCC : documents.azure.com
 *   GCC-High / IL5   : documents.azure.us
 *
 * Grounded in the ARM-authoritative expression already used in
 * admin-plane/main.bicep for LOOM_COSMOS_ENDPOINT:
 *   environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'azure.us' : 'azure.com'
 * (GCC runs in the Commercial `AzureCloud` ARM environment, so its Cosmos
 * account is a Commercial `documents.azure.com` account — same as Commercial.)
 * This helper is the TypeScript canonical mirror so cloud-matrix.test.ts can
 * assert the suffix independently of the Bicep.
 * See: https://learn.microsoft.com/azure/cosmos-db/sql/sql-api-sdk-node
 */
export function cosmosSuffix(): string {
  return isGovCloud() ? 'documents.azure.us' : 'documents.azure.com';
}

/** Build the Cosmos data-plane endpoint URL for a given account name. */
export function cosmosEndpointFromName(accountName: string): string {
  return `https://${accountName}.${cosmosSuffix()}:443/`;
}

/**
 * Cosmos DB **Gremlin (Apache TinkerPop) API** data-plane hostname suffix
 * (no leading dot, no account prefix).
 *   Commercial / GCC : gremlin.cosmos.azure.com
 *   GCC-High / IL5 / DoD : gremlin.cosmos.azure.us
 *
 * The Gremlin endpoint is a DISTINCT host from the NoSQL `documents.azure.*`
 * document endpoint — a Gremlin client connects over the `gremlin.cosmos.*`
 * WebSocket host (verified against Microsoft Learn
 * https://learn.microsoft.com/azure/cosmos-db/gremlin and the Azure-Government
 * parity matrix). Hard-coding the Commercial `.azure.com` suffix silently
 * fails Gremlin auth + traversal in Gov, so every Gremlin endpoint URL builds
 * from this helper. GCC runs on the Commercial Azure environment, so its
 * Gremlin account is a `.azure.com` account — same as Commercial — which is
 * exactly what `isGovCloud()` (false for GCC) yields.
 */
export function gremlinSuffix(): string {
  return isGovCloud() ? 'gremlin.cosmos.azure.us' : 'gremlin.cosmos.azure.com';
}

/** Build the Cosmos Gremlin WebSocket endpoint URL for a given account name. */
export function gremlinEndpointFromName(accountName: string): string {
  return `wss://${accountName}.${gremlinSuffix()}:443/`;
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

/**
 * Wildcard pattern for the JDBC `hostNameInCertificate` property when an
 * external client connects to Synapse SQL (Dedicated or Serverless). Mirrors
 * the `synapseSqlSuffix()` Commercial/Gov split so the JDBC URL the console's
 * Connection details panel surfaces is valid on every sovereign boundary —
 * without it the Microsoft JDBC driver can reject the TLS cert because the
 * `*-ondemand` / pool FQDN does not match the leaf certificate subject.
 *   Commercial / GCC : *.sql.azuresynapse.net
 *   GCC-High / IL5   : *.sql.azuresynapse.usgovcloudapi.net
 *   DoD              : *.sql.azuresynapse.usgovcloudapi.net
 */
export function synapseSqlJdbcHostCert(): string {
  return `*.${synapseSqlSuffix()}`;
}

/**
 * Azure Analysis Services (AAS) data-plane server-name suffix (no leading dot).
 *   Commercial / GCC : asazure.windows.net
 *   GCC-High / IL5   : asazure.usgovcloudapi.net
 *   DoD              : asazure.usgovcloudapi.net (Gov AAS data-plane)
 * Mirrors the Az PowerShell `AnalysisServicesEndpointSuffix` boundary mapping
 * (`Get-AzEnvironment -Name AzureUSGovernment`). AAS is in the DoD IL5 PA scope:
 *   https://learn.microsoft.com/azure/azure-government/documentation-government-overview-dod
 * `LOOM_AAS_HOST_SUFFIX` overrides outright for any custom sovereign endpoint.
 */
export function aasSuffix(): string {
  if (process.env.LOOM_AAS_HOST_SUFFIX) return process.env.LOOM_AAS_HOST_SUFFIX;
  return isGovCloud() ? 'asazure.usgovcloudapi.net' : 'asazure.windows.net';
}

/**
 * Full AAS connection URI (as it appears in SSMS / Power BI "Analysis Services"
 * data source): `asazure://<region>.<suffix>/<serverName>`.
 */
export function aasConnectionUri(serverName: string, region: string): string {
  return `asazure://${region}.${aasSuffix()}/${serverName}`;
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

/**
/**
 * Azure Analysis Services token scope for the XMLA / async-refresh REST surface
 * used by the semantic-model incremental-refresh client. The async-refresh REST
 * audience is the cloud-specific Power BI analysis audience.
 * Commercial + GCC : https://analysis.windows.net/powerbi/api/.default
 * GCC-High / DoD   : https://analysis.usgovcloudapi.net/.default
 *
 * (`pbiRestScope()` further down owns the 4-way Direct-Lake-shim scope split;
 * this 2-way variant matches the existing HEAD test contract.)
 *
 * Docs: https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh
 */
export function aasXmlaScope(): string {
  return isGovCloud()
    ? 'https://analysis.usgovcloudapi.net/.default'
    : 'https://analysis.windows.net/powerbi/api/.default';
}

/**
 * Build the AAS HTTP REST base URL for a region + server + database. The AAS
 * REST surface only exposes async *refresh* operations; full TMSL command
 * execution (createOrReplace / alter) requires an XMLA TCP connection (TOM/AMO)
 * which is not issuable from Node.js — that is why the composite-model apply
 * path uses the Fabric updateDefinition REST API (which wraps XMLA) and falls
 * back to returning the TMSL as an offline `Invoke-ASCmd` receipt.
 *
 * `aasSuffix()` / `aasScope()` are the canonical AAS data-plane helpers — they
 * live in the "Azure Analysis Services (AAS) data plane" section below (the
 * scope MUST carry the literal `*` subdomain per the AAS REST auth spec).
 */
export function aasRestBase(region: string, serverName: string, databaseName: string): string {
  return `https://${region}.${aasSuffix()}/servers/${serverName}/models/${encodeURIComponent(databaseName)}`;
}

// ---------------------------------------------------------------------------
// Power BI / Azure Analysis Services XMLA (AAS) — Direct-Lake-shim refresh
// ---------------------------------------------------------------------------
//
// The Direct-Lake-shim drives Power BI Premium *enhanced refresh* over the
// Analysis Services (XMLA) data plane. The AAD audience for that token is the
// `analysis.*/powerbi/api` resource — DISTINCT from the ARM/Graph/Storage
// audiences — and it splits four ways across the sovereign boundaries.
// Grounded in Microsoft Learn (verified, not from memory):
//   - Commercial : https://analysis.windows.net/powerbi/api/.default
//   - GCC        : https://analysis.usgovcloudapi.net/powerbi/api/.default
//   - GCC High   : https://high.analysis.usgovcloudapi.net/powerbi/api/.default
//   - DoD        : https://mil.analysis.usgovcloudapi.net/powerbi/api/.default
// (power-bi/developer/embedded/embed-sample-for-customers-national-clouds —
//  the GCC/DoDCON/DoD `scopeBase` values.) A client that hard-codes the
// Commercial scope silently fails XMLA auth in every Gov boundary.

/**
 * AAD `.default` scope for the **Power BI REST / XMLA endpoint** token used by
 * the Direct-Lake-shim enhanced-refresh client (`aas-client.ts`). This is the
 * `analysis.* powerbi/api` audience — DISTINCT from the AAS data-plane audience
 * `https://*.asazure.windows.net` returned by `aasScope()` below. 4-way
 * sovereign split (Commercial / GCC / GCC-High / DoD). `LOOM_AAS_SCOPE`
 * overrides outright for clouds we don't enumerate (e.g. China:
 * `https://analysis.chinacloudapi.cn/powerbi/api/.default`).
 */
export function pbiRestScope(): string {
  const explicit = process.env.LOOM_AAS_SCOPE;
  if (explicit) return explicit;
  switch (detectLoomCloud()) {
    case 'DoD':
      return 'https://mil.analysis.usgovcloudapi.net/powerbi/api/.default';
    case 'GCC-High':
      return 'https://high.analysis.usgovcloudapi.net/powerbi/api/.default';
    case 'GCC':
      return 'https://analysis.usgovcloudapi.net/powerbi/api/.default';
    default:
      return 'https://analysis.windows.net/powerbi/api/.default';
  }
}

/**
 * Power BI XMLA endpoint connection URL for a workspace id —
 * `powerbi://{pbiHost}/v1.0/myorg/{workspaceId}`. This is the value persisted
 * as `SemanticModelConfig.XmlaEndpoint` and handed to the C# shim's
 * `TomRefreshClient.ConnectServer`. The host is the sovereign-correct Power BI
 * REST host from `getPbiGovHost()` (no Fabric host on the default path).
 */
export function xmlaEndpointFromWorkspace(workspaceId: string): string {
  const pbiHost = getPbiGovHost().replace(/^https?:\/\//, '');
  return `powerbi://${pbiHost}/v1.0/myorg/${workspaceId}`;
}

// ---------------------------------------------------------------------------
// Azure Analysis Services + Power BI XMLA (Analysis-Services tabular engine)
// ---------------------------------------------------------------------------
//
// The RLS/OLS Security tab authors model roles (row filters + object
// permissions) through the Analysis-Services XMLA protocol — either against an
// Azure Analysis Services server (`asazure://…`) or a Power BI Premium / Fabric
// capacity XMLA endpoint (`powerbi://…`). Both are Azure-native tabular engines
// reached over XMLA-over-HTTP; neither requires a Fabric workspace on the
// default path (the AAS path needs no Fabric/Power BI tenant at all). The
// Power BI XMLA scope helper below keeps the sovereign-cloud split out of the
// RLS/OLS aas-roles client. (aasSuffix() / aasScope() — the AAS host suffix +
// REST scope — are defined once, further down, and reused here.)

/**
 * AAD `.default` token scope for the Power BI XMLA endpoint (the tabular-engine
 * audience, distinct from the Power BI REST `analysis.windows.net/powerbi/api`
 * scope only by sovereign host).
 *   Commercial / GCC : https://analysis.windows.net/powerbi/api/.default
 *   GCC-High / IL5   : https://analysis.usgovcloudapi.net/powerbi/api/.default
 * Source: the Gov scope already used by the Direct-Lake replacement path and
 * the Commercial scope in powerbi-client.ts.
 */
export function pbiXmlaScope(): string {
  return isGovCloud()
    ? 'https://analysis.usgovcloudapi.net/powerbi/api/.default'
    : 'https://analysis.windows.net/powerbi/api/.default';
}

// (AAS data-plane suffix + scope live in the existing "Azure Analysis Services
// (AAS) data plane — Loom-native report renderer" section below as aasSuffix()
// + aasScope(). PR #976 layered a `getAasSuffix()` alias for new call sites —
// kept here as a delegating alias so we have ONE source of truth per suffix.)

/**
 * AAS data-plane hostname suffix — alias of aasSuffix() with an
 * LOOM_AAS_DATA_PLANE_SUFFIX override for sovereign clouds the matrix doesn't
 * enumerate (e.g. air-gapped DoD). Kept for the env-pinned aas-server-client
 * added by PR #976.
 */
export function getAasSuffix(): string {
  const override = process.env.LOOM_AAS_DATA_PLANE_SUFFIX;
  if (override) return override.replace(/^\./, '').replace(/\/+$/, '');
  return aasSuffix();
}

// ---------------------------------------------------------------------------
// Azure Analysis Services (XMLA data plane)
// ---------------------------------------------------------------------------
//
// AAS connection-string / HTTP endpoint format (Microsoft Learn —
// "Asynchronous refresh with the REST API"):
//   connection string : asazure://<region>.asazure.windows.net/<serverName>
//   HTTP base URL      : https://<region>.asazure.windows.net/servers/<serverName>/...
//   Token audience     : EXACTLY https://*.asazure.windows.net  (the `*` is a
//                        literal subdomain, NOT a placeholder — custom audiences
//                        such as https://westus.asazure.windows.net fail auth).
//   Permission         : the calling principal needs the AAS server-admin role.
//   Ref: https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh#authentication
//
// Azure Analysis Services IS available in Azure Government regions (USGov
// Virginia / Arizona / Texas) using the `asazure.usgovcloudapi.net` suffix.
// This is an Azure-native service — NOT Fabric / Power BI — so it is permitted
// here per no-fabric-dependency.md (AAS is the optional Azure-native backend
// for the semantic-model item type).

/** AAS XMLA data-plane hostname suffix (no leading dot). */
export function aasSuffix(): string {
  return isGovCloud() ? 'asazure.usgovcloudapi.net' : 'asazure.windows.net';
}

/**
 * AAD `.default` scope for AAS XMLA data-plane tokens. The audience must
 * contain the literal `*` subdomain exactly as shown (per Microsoft Learn —
 * the `*` is NOT a wildcard placeholder; any other subdomain fails auth).
 *   Commercial / GCC     : https://*.asazure.windows.net/.default
 *   GCC-High / IL5 / DoD : https://*.asazure.usgovcloudapi.net/.default
 */
export function aasScope(): string {
  return `https://*.${aasSuffix()}/.default`;
}

/**
 * Normalise an AAS connection-string or HTTP URL into a canonical HTTPS server
 * base URL (no trailing slash). Accepts the three forms operators paste in:
 *   asazure://westus.asazure.windows.net/myserver
 *     -> https://westus.asazure.windows.net/servers/myserver
 *   westus.asazure.windows.net/myserver
 *     -> https://westus.asazure.windows.net/servers/myserver
 *   https://westus.asazure.windows.net/servers/myserver  (already resolved)
 *     -> https://westus.asazure.windows.net/servers/myserver   (passthrough)
 * Returns '' for an empty / unparseable input so callers can gate honestly.
 */
export function aasServerBase(server: string): string {
  if (!server) return '';
  const trimmed = server.trim();
  // Already an HTTPS base URL — strip any trailing slash and pass through.
  if (/^https:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  // asazure:// connection string form.
  const m = trimmed.match(/^asazure:\/\/([^/]+)\/(.+)$/i);
  if (m) return `https://${m[1]}/servers/${m[2].replace(/\/+$/, '')}`;
  // Bare "region.asazure.<suffix>/serverName" form.
  const parts = trimmed.replace(/\/+$/, '').split('/');
  if (parts.length === 2 && parts[0].includes('.')) {
    return `https://${parts[0]}/servers/${parts[1]}`;
  }
  return '';
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

// ---------------------------------------------------------------------------
// Azure Analysis Services (AAS) data plane — Loom-native report renderer
// ---------------------------------------------------------------------------
//
// Commercial / GCC : asazure.windows.net
// GCC-High / IL5   : asazure.usgovcloudapi.net
//
// The AAD token scope is ALWAYS the literal string `https://*.asazure.windows.net`
// (or `*.asazure.usgovcloudapi.net` for Gov). Per the AAS REST API auth spec
// the `*` is NOT a wildcard — it is the required subdomain character. Using a
// real subdomain (e.g. https://eastus2.asazure.windows.net) FAILS auth.
// Ref: https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh

// aasSuffix() is declared once above (with LOOM_AAS_HOST_SUFFIX override
// support) — re-using that single source of truth here.

/**
 * AAD token scope for AAS data-plane calls. Per Microsoft Learn the literal
 * `*` character must appear as the subdomain — it is NOT a wildcard:
 *   "the audience must have the `*` character as the subdomain"
 */
export function aasScope(): string {
  return `https://*.${aasSuffix()}`;
}

/**
 * Parse a Loom `state.aasServer` value into `{ region, serverName }`.
 *
 * Accepts:
 *   - XMLA URI: "asazure://eastus2.asazure.windows.net/my-server"
 *   - FQDN:     "my-server.eastus2.asazure.windows.net"
 *
 * Returns null when the value cannot be parsed (e.g. a bare server name with
 * no region — callers must then supply the region via env).
 */
export function parseAasServer(
  raw: string,
): { region: string; serverName: string } | null {
  const s = (raw || '').trim();
  if (!s) return null;
  // XMLA URI form: asazure://<region>.asazure.{windows|usgovcloudapi}.net/<serverName>
  const xmla = s.match(/^asazure:\/\/([^.]+)\.asazure\.(?:windows|usgovcloudapi)\.net\/(.+)$/i);
  if (xmla) return { region: xmla[1], serverName: xmla[2] };
  // FQDN form: <serverName>.<region>.asazure.{windows|usgovcloudapi}.net
  const fqdn = s.match(/^([^.]+)\.([^.]+)\.asazure\.(?:windows|usgovcloudapi)\.net$/i);
  if (fqdn) return { serverName: fqdn[1], region: fqdn[2] };
  // Bare name — region unknown.
  return null;
}

/**
 * Build the AAS data-plane REST base URL for a given server + model, e.g.
 * https://eastus2.asazure.windows.net/servers/my-server/models/AdventureWorks
 * (no trailing slash).
 */
export function aasModelUrl(region: string, serverName: string, modelName: string): string {
  return `https://${region}.${aasSuffix()}/servers/${encodeURIComponent(serverName)}/models/${encodeURIComponent(modelName)}`;
}
