/**
 * PURE mapping: Azure ARM resource type → the private-link "group ids"
 * (sub-resources) a private endpoint can target on that resource.
 *
 * This module is intentionally free of the Azure SDK / node credential chain so
 * it can be imported by BOTH the managed-private-endpoints BFF route (server-side
 * groupId validation + SQL target normalization) AND the create-dialog client
 * component (the sub-resource Dropdown). Same split as connectable-types.ts.
 *
 * Sub-resource ("groupId") names are the documented private-link resource
 * sub-resources per service.
 * Learn: https://learn.microsoft.com/azure/private-link/private-endpoint-overview
 *        #private-link-resource
 */

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
