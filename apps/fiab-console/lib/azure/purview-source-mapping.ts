/**
 * purview-source-mapping — the pure catalog that maps Loom's Azure estate to
 * Microsoft Purview **Data Map** data-source kinds, and the default System scan
 * ruleset / MI scan kind for each.
 *
 * This is intentionally free of the Azure SDK + cloud-endpoints credential
 * chain so BOTH the server route (`/api/admin/security/purview/discover`, which
 * builds sovereign-correct endpoints) AND the client wizard (`purview-panel`,
 * which renders the "Custom source" kind dropdown + the review/scan defaults)
 * import the same source of truth. No freeform kind strings anywhere — every
 * registerable kind comes from PURVIEW_SOURCE_KIND_SPECS (no-freeform-config).
 *
 * Kind values are the Purview scanning-plane `kind` enum (grounded in Microsoft
 * Learn "Register data source" + the scanning data-plane REST reference), NOT
 * portal display names:
 *   https://learn.microsoft.com/purview/data-gov-python-sdk#register-a-data-source
 *   https://learn.microsoft.com/purview/register-scan-adls-gen2
 *   https://learn.microsoft.com/purview/register-scan-azure-sql-database
 *
 * NO Fabric dependency: every kind here is an Azure-native backend
 * (no-fabric-dependency.md). Fabric/OneLake/Power BI are NOT in this catalog.
 */

/** ARM resource types enumerated during Loom-estate discovery (lower-case). */
export const PURVIEW_DISCOVERY_ARM_TYPES = [
  'microsoft.storage/storageaccounts',
  'microsoft.sql/servers',
  'microsoft.synapse/workspaces',
  'microsoft.kusto/clusters',
  'microsoft.documentdb/databaseaccounts',
  'microsoft.dbforpostgresql/flexibleservers',
  'microsoft.dbforpostgresql/servers',
] as const;

export interface PurviewKindSpec {
  /** Purview scanning-plane data-source kind (the PUT body `kind`). */
  kind: string;
  /** Human label shown in the picker / chip / review. */
  label: string;
  /** item-type-visual slug (icon + brand colour) reused by the picker. */
  tileSlug: string;
  /** Label for the endpoint field (differs per kind: DFS / server / cluster). */
  endpointLabel: string;
  /** Example endpoint shown as a placeholder on the explicit Custom path. */
  endpointExample: string;
  /** Which `properties` key carries the endpoint for this kind. */
  endpointProperty: 'endpoint' | 'serverEndpoint' | 'accountUri' | 'serverlessSqlEndpoint';
  /** Default System scan ruleset name for a first scan on this kind. */
  scanRulesetName: string;
  /** Default MI-based scan kind (Loom is MI-first per .claude/rules). */
  scanKind: string;
}

/**
 * The registerable Purview source catalog. Order = display order in the Custom
 * dropdown + the discovery grouping.
 */
export const PURVIEW_SOURCE_KIND_SPECS: PurviewKindSpec[] = [
  {
    kind: 'AdlsGen2',
    label: 'Azure Data Lake Storage Gen2',
    tileSlug: 'storage-adls',
    endpointLabel: 'DFS endpoint',
    endpointExample: 'https://contoso.dfs.core.windows.net/',
    endpointProperty: 'endpoint',
    scanRulesetName: 'AdlsGen2',
    scanKind: 'AdlsGen2Msi',
  },
  {
    kind: 'AzureStorage',
    label: 'Azure Blob Storage',
    tileSlug: 'storage-adls',
    endpointLabel: 'Blob endpoint',
    endpointExample: 'https://contoso.blob.core.windows.net/',
    endpointProperty: 'endpoint',
    scanRulesetName: 'AzureStorage',
    scanKind: 'AzureStorageMsi',
  },
  {
    kind: 'AzureSqlDatabase',
    label: 'Azure SQL Database',
    tileSlug: 'azure-sql-database',
    endpointLabel: 'Server endpoint',
    endpointExample: 'contoso.database.windows.net',
    endpointProperty: 'serverEndpoint',
    scanRulesetName: 'AzureSqlDatabase',
    // Scanning-plane scan-kind enum value (NOT "…ManagedIdentity", which is not
    // an enum member): https://learn.microsoft.com/rest/api/purview/scanningdataplane/scans
    scanKind: 'AzureSqlDatabaseMsi',
  },
  {
    kind: 'AzureSynapseWorkspace',
    label: 'Azure Synapse Analytics',
    tileSlug: 'synapse-serverless-sql-pool',
    endpointLabel: 'Serverless SQL endpoint',
    endpointExample: 'contoso-ondemand.sql.azuresynapse.net',
    endpointProperty: 'serverlessSqlEndpoint',
    scanRulesetName: 'AzureSynapseSQL',
    scanKind: 'AzureSynapseWorkspaceMsi',
  },
  {
    kind: 'AzureDataExplorer',
    label: 'Azure Data Explorer (Kusto)',
    tileSlug: 'kql-database',
    endpointLabel: 'Cluster URI',
    endpointExample: 'https://contoso.eastus.kusto.windows.net',
    endpointProperty: 'endpoint',
    scanRulesetName: 'AzureDataExplorer',
    scanKind: 'AzureDataExplorerMsi',
  },
  {
    kind: 'AzureCosmosDb',
    label: 'Azure Cosmos DB (NoSQL)',
    tileSlug: 'cosmos-account',
    endpointLabel: 'Account URI',
    endpointExample: 'https://contoso.documents.azure.com:443/',
    endpointProperty: 'accountUri',
    scanRulesetName: 'AzureCosmosDb',
    scanKind: 'AzureCosmosDbMsi',
  },
  {
    kind: 'AzurePostgreSql',
    label: 'Azure Database for PostgreSQL',
    tileSlug: 'postgres',
    endpointLabel: 'Server endpoint',
    endpointExample: 'contoso.postgres.database.azure.com',
    endpointProperty: 'serverEndpoint',
    scanRulesetName: 'AzurePostgreSql',
    scanKind: 'AzurePostgreSqlMsi',
  },
];

/** Lookup a spec by Purview kind (undefined for an unknown/legacy kind). */
export const PURVIEW_KIND_SPEC: Record<string, PurviewKindSpec | undefined> =
  Object.fromEntries(PURVIEW_SOURCE_KIND_SPECS.map((s) => [s.kind, s]));

/**
 * ARM provider path per Purview source kind — used to derive the
 * `properties.resourceId` the scan plane REQUIRES for Azure sources.
 *
 * PROVEN against the live classic account (2026-07-15 in-VNet probe): a PUT
 * /scan/datasources/{name} whose properties carry an endpoint but no
 * `resourceId` answers 403 `OperationNotAllowed: "Azure data source
 * registration requires a valid resourceId when an endpoint is specified."`
 * (Synapse variant: "…requires a valid resourceId or subscriptionId.")
 */
const ARM_PROVIDER_BY_KIND: Record<string, string | undefined> = {
  AdlsGen2: 'Microsoft.Storage/storageAccounts',
  AzureStorage: 'Microsoft.Storage/storageAccounts',
  AzureSqlDatabase: 'Microsoft.Sql/servers',
  AzureSynapseWorkspace: 'Microsoft.Synapse/workspaces',
  AzureDataExplorer: 'Microsoft.Kusto/clusters',
  AzureCosmosDb: 'Microsoft.DocumentDB/databaseAccounts',
  AzurePostgreSql: 'Microsoft.DBforPostgreSQL/flexibleServers',
};

/**
 * Derive the full ARM resource id for a Purview source registration from its
 * non-secret coordinates. Returns undefined when any coordinate is missing —
 * callers then register without it and surface Purview's honest
 * `OperationNotAllowed` message (never a fabricated id).
 */
export function derivePurviewArmResourceId(
  kind: string,
  coords: { subscriptionId?: string; resourceGroup?: string; resourceName?: string },
): string | undefined {
  const provider = ARM_PROVIDER_BY_KIND[kind];
  const { subscriptionId, resourceGroup, resourceName } = coords || {};
  if (!provider || !subscriptionId || !resourceGroup || !resourceName) return undefined;
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/${provider}/${resourceName}`;
}

/**
 * Sanitize a resource name into a Purview data-source referenceName: letters,
 * digits, hyphen, underscore only; must start with a letter/digit; <= 63 chars.
 * Purview rejects spaces / dots / slashes in a source name, so a raw ARM name
 * (e.g. a SQL server FQDN) must be normalised before it becomes the source id.
 */
export function toPurviewSourceName(raw: string): string {
  const cleaned = (raw || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 63);
  return cleaned || 'source';
}

/**
 * Discovery descriptor returned by GET /api/admin/security/purview/discover —
 * a ready-to-register Purview source derived from one Azure estate resource.
 * `properties` is the sovereign-correct PUT body MINUS `collection`, which the
 * wizard merges from the user's collection choice before posting.
 */
export interface DiscoveredPurviewSource {
  /** Full ARM resource id — non-secret provenance + client dedupe key. */
  armResourceId: string;
  /** Suggested (sanitized) Purview source referenceName. */
  suggestedName: string;
  /** Purview data-source kind (from the catalog above). */
  kind: string;
  /** Human label for the kind. */
  label: string;
  /** Visual slug (icon) for the kind. */
  tileSlug: string;
  /** Primary endpoint shown to the user (also inside `properties`). */
  endpoint: string;
  /** Sovereign-correct PUT `properties` (collection added client-side). */
  properties: Record<string, unknown>;
  subscriptionId: string;
  subscriptionName?: string;
  resourceGroup: string;
  location: string;
}
