/**
 * Read the `owner` of ONE Unity Catalog securable.
 *
 * Lifted out of `uc-effective-permissions-live.ts` (#2651) because it is needed
 * on BOTH effective-permissions paths, not just the OSS resolver:
 *
 *   - OSS / Loom Unity — `computeEffectivePermissions` walks the containment
 *     chain and folds ownership into the synthesized assignments.
 *   - Databricks — the native `effective-permissions` endpoint NEVER reports
 *     ownership (see below), so the client reads the owner alongside the
 *     passthrough and returns it as a fact the pane can state.
 *
 * Why the Databricks answer omits it, verbatim from Learn:
 *   "Object owners can automatically perform all capabilities on the object they
 *    own. However, Azure Databricks doesn't explicitly grant the ALL PRIVILEGES
 *    privilege to the owner. This means you won't see ALL PRIVILEGES returned
 *    when listing permissions using the Databricks API or with a SHOW GRANTS
 *    command."
 *   learn.microsoft.com/azure/databricks/data-governance/unity-catalog/access-control/permissions-concepts#ownership
 *
 * So an empty effective-permissions answer is NOT evidence that a securable is
 * unowned — which is exactly the claim #2651 found the pane making.
 *
 * Nothing here is Databricks- or Fabric-specific: every read is UC 2.1 REST,
 * which the OSS Unity Catalog server serves too (no-fabric-dependency.md).
 */
import {
  getCatalog, getSchema, getTable, getVolume, getFunctionUc,
  getRegisteredModel, getExternalLocation, getStorageCredential,
  type UCSecurableType,
} from '@/lib/azure/unity-catalog-client';

/** Read the `owner` of one securable. Returns `undefined` for a type whose
 *  backend reports no owner; throws only on a real transport / authorization
 *  error, which every caller downgrades to a warning rather than a 502. */
export async function securableOwner(
  host: string,
  type: UCSecurableType,
  name: string,
): Promise<string | undefined> {
  switch (type) {
    case 'CATALOG': return (await getCatalog(host, name)).owner;
    case 'SCHEMA': return (await getSchema(host, name)).owner;
    case 'TABLE': return (await getTable(host, name)).owner;
    case 'VOLUME': return (await getVolume(host, name)).owner;
    case 'FUNCTION': return (await getFunctionUc(host, name)).owner;
    case 'REGISTERED_MODEL': return (await getRegisteredModel(host, name)).owner;
    case 'EXTERNAL_LOCATION': return (await getExternalLocation(host, name)).owner;
    case 'STORAGE_CREDENTIAL': return (await getStorageCredential(host, name)).owner;
    // Neither backend exposes an owner on the metastore itself: OSS Unity
    // Catalog's metastore_summary carries no owner field, and Databricks models
    // metastore administration through the account console, not an `owner`.
    case 'METASTORE': return undefined;
  }
}
