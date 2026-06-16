/**
 * Phase 2 — Mirrored Databricks provisioner (audit H8).
 *
 * A MirroredAzureDatabricksCatalog mounts a Databricks Unity Catalog so its
 * tables are queryable elsewhere. Per .claude/rules/no-fabric-dependency.md this
 * is Azure-native: the UC tables are Delta files already in ADLS Gen2, and the
 * "mount" is realized by pairing a Synapse Serverless SQL endpoint that reads
 * them (OPENROWSET FORMAT='delta') — done by the paired
 * `synapse-serverless-sql-pool` provisioner via ITEM_PAIRING_RULES.
 *
 * THIS provisioner's job is to (a) validate the UC source against the real
 * Databricks REST surface and (b) resolve the catalog's queryable Delta tables +
 * their storage locations, stamping them onto `secondaryIds.ucTablesJson` so the
 * pairing rule can forward them. It does NOT itself talk to Synapse.
 *
 * Honest gates (no silent config-doc-only success):
 *   - LOOM_DATABRICKS_HOSTNAME unset  → NO_DATABRICKS remediation.
 *   - catalogName missing on the item → fix the mirror config.
 *   - catalog has no queryable Delta tables → NO_TABLES remediation.
 */
import type { Provisioner, ProvisionResult } from './types';
import { resolveUcMirrorTables } from '@/lib/azure/databricks-uc-mirror';

export const mirroredDatabricksProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const content = (input.content || {}) as { catalogName?: string; tables?: Array<{ schema: string; table: string }> };
  const catalogName = (content.catalogName || '').trim();

  if (!catalogName) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Mirrored Databricks item has no Unity Catalog name configured.',
        remediation:
          'Set the catalogName on the mirror (the Databricks Unity Catalog to mount), then retry. ' +
          'In the editor, pick the catalog from the UC browser.',
        link: 'https://learn.microsoft.com/azure/databricks/catalogs/',
      },
      steps,
    };
  }

  const resolved = await resolveUcMirrorTables(catalogName, {
    tableSubset: Array.isArray(content.tables) ? content.tables : undefined,
  });

  if (!resolved.ok) {
    if (resolved.code === 'NO_DATABRICKS') {
      return {
        status: 'remediation',
        gate: {
          reason: 'Databricks workspace not provisioned in this deployment — cannot validate the Unity Catalog source.',
          remediation:
            'Set LOOM_DATABRICKS_HOSTNAME (e.g. adb-…azuredatabricks.net) on the Console container app and grant the ' +
            'Console UAMI workspace-user + USE CATALOG on the metastore (see docs/fiab/v3-tenant-bootstrap.md). No Fabric required.',
          link: 'https://learn.microsoft.com/azure/databricks/dev-tools/api/',
        },
        steps,
      };
    }
    return {
      status: 'remediation',
      gate: {
        reason: resolved.error || `Could not resolve queryable Delta tables for catalog "${catalogName}".`,
        remediation:
          'Ensure the mounted catalog contains Delta tables with a resolvable ADLS storage location (EXTERNAL Delta ' +
          'tables, or MANAGED tables whose storage_location the UC API returns) and that the Console UAMI has ' +
          'USE CATALOG / USE SCHEMA / SELECT on them.',
        link: 'https://learn.microsoft.com/azure/databricks/connect/unity-catalog/external-locations',
      },
      steps,
    };
  }

  steps.push(
    `Validated Unity Catalog "${catalogName}": ${resolved.tables.length} queryable Delta table(s) ` +
      `(${resolved.skipped} skipped, no resolvable storage location).`,
  );

  return {
    status: 'created',
    resourceId: catalogName,
    secondaryIds: {
      backend: 'databricks-uc',
      catalogName,
      tableCount: String(resolved.tables.length),
      // Forwarded to ITEM_PAIRING_RULES['mirrored-databricks'].deriveContent so
      // the paired Synapse Serverless endpoint can build a view per table.
      ucTablesJson: JSON.stringify(resolved.tables),
    },
    steps,
  };
};
