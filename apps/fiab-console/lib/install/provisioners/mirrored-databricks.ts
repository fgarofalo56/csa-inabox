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
 * THE PRIVILEGES ARE GRANTED, NOT REQUESTED (#3509, auto-bind-by-default).
 * This item type has ONE path — there is no opt-in alternative — and it used to
 * answer a privilege-shaped resolution failure with a remediation telling the
 * operator to grant `USE CATALOG` / `USE SCHEMA` / `SELECT` to the Console UAMI
 * by hand. `unity-catalog-client` has exported `updatePermissions()` and
 * `grantPrivilegesSQL()` the whole time, and `/api/catalog/permissions` calls
 * them in production. A gate over an action the platform could perform is a
 * defect, so the provisioner now self-grants and re-resolves once.
 *
 * Note this is a SYMPTOM-shaped trigger, deliberately: Unity Catalog HIDES
 * securables the caller cannot see, so insufficient privileges surface as
 * "catalog has no queryable Delta tables" (NO_TABLES), not as a 403. Keying the
 * self-heal to a 403 alone would miss the case that actually happens.
 *
 * Honest gates (no silent config-doc-only success):
 *   - LOOM_DATABRICKS_HOSTNAME unset  → NO_DATABRICKS remediation.
 *   - catalogName missing on the item → fix the mirror config.
 *   - the self-grant itself was REFUSED (the Console UAMI is not the catalog
 *     owner and holds no MANAGE) → a genuine deploy-time gap, reported with
 *     Databricks' own refusal rather than a guess.
 *   - grant succeeded and the catalog STILL exposes no queryable Delta tables →
 *     it is genuinely empty. Said in exactly those words, because "grant these
 *     privileges" would now be false (deploy-integrity.md R7).
 */
import type { Provisioner, ProvisionResult } from './types';
import {
  resolveUcMirrorTables,
  selfGrantUcMirrorPrivileges,
  UC_MIRROR_PRIVILEGES,
  type UcMirrorResolution,
} from '@/lib/azure/databricks-uc-mirror';

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

  const subset = Array.isArray(content.tables) ? content.tables : undefined;
  let resolved: UcMirrorResolution = await resolveUcMirrorTables(catalogName, { tableSubset: subset });

  if (!resolved.ok && resolved.code === 'NO_DATABRICKS') {
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

  if (!resolved.ok) {
    // SELF-HEAL, once. `NO_TABLES` and `ERROR` are both privilege-shaped here:
    // Unity Catalog hides what the caller cannot see, so a missing SELECT looks
    // like an empty catalog, and a missing USE CATALOG throws on the schema
    // list. Grant, then re-resolve — one attempt, so a catalog that is genuinely
    // empty fails closed instead of looping against the Databricks API.
    steps.push(
      `Catalog "${catalogName}" resolved no queryable tables (${resolved.code}); granting ` +
        `${UC_MIRROR_PRIVILEGES.join(' / ')} to the Console identity and retrying.`,
    );
    const grant = await selfGrantUcMirrorPrivileges(catalogName);
    if (!grant.granted) {
      // The one genuinely-unfixable case: the platform is not entitled to grant.
      return {
        status: 'remediation',
        gate: {
          reason:
            `Loom could not read catalog "${catalogName}" and could not grant itself access to it.`,
          remediation:
            `The grant was attempted automatically and did not succeed: ${grant.reason} ` +
            'Make the Console UAMI the catalog owner, or grant it MANAGE on the catalog (or metastore-admin), ' +
            'so Loom can bind mirrors without a per-catalog manual step.',
          link: 'https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/manage-privileges/',
        },
        steps,
      };
    }
    steps.push(`Granted ${UC_MIRROR_PRIVILEGES.join(' / ')} on CATALOG ${catalogName} to ${grant.principal}.`);
    resolved = await resolveUcMirrorTables(catalogName, { tableSubset: subset });
  }

  if (!resolved.ok) {
    // Post-grant. The privileges are now in place, so "grant these privileges"
    // would be a FALSE remediation (deploy-integrity.md R7). Say what is
    // actually left: the catalog has nothing this mirror can read.
    return {
      status: 'remediation',
      gate: {
        reason: resolved.error || `Catalog "${catalogName}" exposes no queryable Delta tables to Loom.`,
        remediation:
          `Loom already holds ${UC_MIRROR_PRIVILEGES.join(' / ')} on this catalog — the grant was made during this ` +
          'install and the catalog still returned nothing. Ensure it contains Delta tables with a resolvable ADLS ' +
          'storage location (EXTERNAL Delta tables, or MANAGED tables whose storage_location the UC API returns).',
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
