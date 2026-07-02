/**
 * PURE mapping: Azure ARM resource type → the private-link "group ids"
 * (sub-resources) a private endpoint can target on that resource, plus the
 * groupId → `privatelink.*` private DNS zone each needs for FQDN resolution.
 *
 * This module is intentionally free of the Azure SDK / node credential chain so
 * it can be imported by BOTH the managed-private-endpoints BFF route (server-side
 * groupId validation + SQL target normalization) AND the create-dialog client
 * component (the sub-resource Dropdown). Same split as connectable-types.ts.
 * (cloud-endpoints is a pure env-reading module — no SDK — so importing its
 * suffix helpers keeps that property.)
 *
 * Sub-resource ("groupId") names are the documented private-link resource
 * sub-resources per service.
 * Learn: https://learn.microsoft.com/azure/private-link/private-endpoint-overview
 *        #private-link-resource
 *        https://learn.microsoft.com/azure/private-link/private-endpoint-dns
 */
import {
  isGovCloud, getBlobSuffix, dfsSuffix, getFileSuffix, getSqlSuffix,
  serviceBusSuffix, cosmosSuffix, synapseSqlSuffix,
} from './cloud-endpoints';

export interface PeGroupOption {
  /** The ARM `groupIds` value written on the private-link connection. */
  id: string;
  /** Human label shown in the sub-resource Dropdown. */
  label: string;
}

/**
 * groupIds keyed by LOWERCASED ARM resource type. The FIRST entry is the
 * sensible default the create-dialog pre-selects for that resource type.
 */
export const PE_SUBRESOURCE_GROUPS: Record<string, PeGroupOption[]> = {
  'microsoft.storage/storageaccounts': [
    { id: 'dfs', label: 'dfs — ADLS Gen2 (Data Lake)' },
    { id: 'blob', label: 'blob — Blob storage' },
    { id: 'file', label: 'file — Azure Files' },
    { id: 'queue', label: 'queue — Queue storage' },
    { id: 'table', label: 'table — Table storage' },
    { id: 'web', label: 'web — Static website' },
  ],
  'microsoft.sql/servers': [{ id: 'sqlServer', label: 'sqlServer — Azure SQL' }],
  // The connectables picker surfaces SQL at the database grain; a PE targets the
  // parent SERVER (normalizePrivateLinkTargetId strips the /databases/… suffix).
  'microsoft.sql/servers/databases': [{ id: 'sqlServer', label: 'sqlServer — Azure SQL' }],
  'microsoft.dbforpostgresql/flexibleservers': [{ id: 'postgresqlServer', label: 'postgresqlServer — PostgreSQL' }],
  'microsoft.dbforpostgresql/servers': [{ id: 'postgresqlServer', label: 'postgresqlServer — PostgreSQL' }],
  'microsoft.documentdb/databaseaccounts': [
    { id: 'Sql', label: 'Sql — Core (SQL) API' },
    { id: 'MongoDB', label: 'MongoDB — MongoDB API' },
    { id: 'Cassandra', label: 'Cassandra — Cassandra API' },
    { id: 'Gremlin', label: 'Gremlin — Gremlin API' },
    { id: 'Table', label: 'Table — Table API' },
    { id: 'Analytical', label: 'Analytical — analytical store' },
  ],
  'microsoft.synapse/workspaces': [
    { id: 'SqlOnDemand', label: 'SqlOnDemand — serverless SQL' },
    { id: 'Sql', label: 'Sql — dedicated SQL pools' },
    { id: 'Dev', label: 'Dev — Studio + artifact REST' },
  ],
  'microsoft.databricks/workspaces': [
    { id: 'databricks_ui_api', label: 'databricks_ui_api — workspace UI / API' },
    { id: 'browser_authentication', label: 'browser_authentication — SSO login' },
  ],
  'microsoft.eventhub/namespaces': [{ id: 'namespace', label: 'namespace — Event Hubs' }],
  'microsoft.servicebus/namespaces': [{ id: 'namespace', label: 'namespace — Service Bus' }],
  'microsoft.keyvault/vaults': [{ id: 'vault', label: 'vault — Key Vault' }],
};

/** Sub-resource options for a resource type (empty when the type is unknown). */
export function groupOptionsForArmType(armType: string | undefined | null): PeGroupOption[] {
  return PE_SUBRESOURCE_GROUPS[(armType || '').toLowerCase()] || [];
}

/** Every valid groupId across all types — the server-side POST allowlist. */
export const ALL_PE_GROUP_IDS: string[] = Array.from(
  new Set(Object.values(PE_SUBRESOURCE_GROUPS).flatMap((g) => g.map((x) => x.id))),
);

/**
 * Normalize a picked resource id to the id a private endpoint must actually
 * target. A SQL private endpoint targets the SERVER (groupId `sqlServer`), not
 * an individual database — so an id ending in `/databases/<db>` is trimmed back
 * to its parent `Microsoft.Sql/servers/<server>`. Every other type targets the
 * resource id unchanged.
 */
export function normalizePrivateLinkTargetId(resourceId: string, armType?: string): string {
  const id = (resourceId || '').trim();
  const isSqlDb =
    (armType || '').toLowerCase() === 'microsoft.sql/servers/databases' ||
    /\/providers\/Microsoft\.Sql\/servers\/[^/]+\/databases\//i.test(id);
  if (isSqlDb) {
    const m = /^(.*\/providers\/Microsoft\.Sql\/servers\/[^/]+)\/databases\//i.exec(id);
    if (m) return m[1];
  }
  return id;
}

/**
 * The `privatelink.*` private DNS zone NAME a private endpoint with this
 * sub-resource (groupId) registers its FQDN into — the zone a
 * privateDnsZoneGroups config must reference for the endpoint to resolve after
 * approval. Cloud-aware: Gov (GCC-High / IL5 / DoD) variants come from the
 * cloud-endpoints suffix helpers (or the documented Gov literals where no
 * helper exists). Returns undefined for a groupId with no documented zone.
 *
 * `targetResourceId` disambiguates the one colliding groupId: `Sql` is BOTH
 * Cosmos DB Core API (privatelink.documents.*) and Synapse dedicated pools
 * (privatelink.sql.azuresynapse.*).
 *
 * Zone names per Learn: azure/private-link/private-endpoint-dns (+ the
 * Azure Government DNS-zone values in azure/azure-government/compare-azure-government-global-azure).
 */
export function privateDnsZoneNameForGroupId(groupId: string, targetResourceId?: string): string | undefined {
  const gov = isGovCloud();
  const target = (targetResourceId || '').toLowerCase();
  // Storage sibling zones share the blob suffix shape (queue/table/web swap the
  // service label): blob.core.windows.net → queue.core.windows.net etc.
  const storageZone = (svc: string) => `privatelink.${getBlobSuffix().replace(/^blob\./, `${svc}.`)}`;
  const cosmosApiZone = (api: string) =>
    gov ? `privatelink.${api}.cosmos.azure.us` : `privatelink.${api}.cosmos.azure.com`;
  switch (groupId) {
    // ── Storage (per-service zones) ──
    case 'blob': return `privatelink.${getBlobSuffix()}`;
    case 'dfs': return `privatelink.${dfsSuffix()}`;
    case 'file': return `privatelink.${getFileSuffix()}`;
    case 'queue': return storageZone('queue');
    case 'table': return storageZone('table');
    case 'web': return storageZone('web');
    // ── SQL / PostgreSQL ──
    case 'sqlServer': return `privatelink.${getSqlSuffix()}`;
    case 'postgresqlServer':
      return gov ? 'privatelink.postgres.database.usgovcloudapi.net' : 'privatelink.postgres.database.azure.com';
    // ── Cosmos DB (per-API zones; NOTE 'Table' ≠ storage 'table') ──
    case 'Sql':
      // Synapse dedicated pools reuse the 'Sql' groupId — key off the target type.
      return target.includes('/providers/microsoft.synapse/')
        ? `privatelink.${synapseSqlSuffix()}`
        : `privatelink.${cosmosSuffix()}`;
    case 'MongoDB': return cosmosApiZone('mongo');
    case 'Cassandra': return cosmosApiZone('cassandra');
    case 'Gremlin': return cosmosApiZone('gremlin');
    case 'Table': return cosmosApiZone('table');
    case 'Analytical': return cosmosApiZone('analytics');
    // ── Synapse ──
    case 'SqlOnDemand': return `privatelink.${synapseSqlSuffix()}`;
    case 'Dev':
      return gov ? 'privatelink.dev.azuresynapse.usgovcloudapi.net' : 'privatelink.dev.azuresynapse.net';
    // ── Databricks (one zone covers both sub-resources) ──
    case 'databricks_ui_api':
    case 'browser_authentication':
      return gov ? 'privatelink.databricks.azure.us' : 'privatelink.azuredatabricks.net';
    // ── Event Hubs / Service Bus (shared zone) ──
    case 'namespace': return `privatelink.${serviceBusSuffix()}`;
    // ── Key Vault ──
    case 'vault':
      return gov ? 'privatelink.vaultcore.usgovcloudapi.net' : 'privatelink.vaultcore.azure.net';
    default:
      return undefined;
  }
}
