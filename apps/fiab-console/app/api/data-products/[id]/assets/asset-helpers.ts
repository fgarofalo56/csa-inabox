/**
 * Pure, framework-free helpers for the F9 data-assets route. Kept out of
 * route.ts so they can be unit-tested without Next's route-export constraints
 * (route.ts may only export HTTP handlers + segment config).
 */

/** Persisted reference (in state.dataAssets[]). Runtime flags are NOT persisted. */
export interface DataAssetRef {
  guid: string;
  name: string;
  qualifiedName?: string;
  entityType?: string;
  addedAt?: string;
}

/** A data-quality rule (subset) from the dq-rules:<tenantId> tenant-settings doc. */
export interface DqRule { id: string; scope?: string; enabled?: boolean; name?: string }

/** Type-chip → Atlas typeName mapping. Table / View / File buckets. */
export const ENTITY_TYPE_CHIPS: Record<string, string[]> = {
  Table: [
    'azure_sql_table', 'azure_synapse_dedicated_sql_table', 'azure_synapse_serverless_sql_table',
    'databricks_table', 'hive_table', 'azure_data_explorer_table', 'azure_cosmosdb_sqlapi_collection',
    'adls_gen2_resource_set', 'fabric_warehouse_table', 'fabric_lakehouse_table', 'DataSet',
  ],
  View: [
    'azure_sql_view', 'azure_synapse_dedicated_sql_view', 'azure_synapse_serverless_sql_view',
    'databricks_view', 'hive_view',
  ],
  File: [
    'azure_blob_path', 'adls_gen2_path', 'azure_datalake_gen2_path',
    'azure_datalake_gen2_filesystem', 'azure_storage_file_path', 'azure_blob',
  ],
};

/** True when a data-quality rule's scope targets the asset's table name. */
export function ruleCoversAsset(rule: DqRule, asset: DataAssetRef): boolean {
  const scope = (rule.scope || '').trim();
  if (!scope) return false;
  const name = (asset.name || '').trim();
  if (!name) return false;
  return scope === `table:${name}` || scope.startsWith(`column:${name}.`);
}

/** Name of the first enabled rule covering the asset, or null. */
export function dqRunningRuleName(rules: DqRule[], asset: DataAssetRef): string | null {
  const hit = rules.filter((r) => r.enabled).find((r) => ruleCoversAsset(r, asset));
  return hit ? (hit.name || hit.id) : null;
}
