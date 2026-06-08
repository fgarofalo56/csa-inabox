/**
 * The data item types surfaced by the OneLake catalog Explore tab and its
 * Recycle bin — "lakehouses, warehouses, Fabric databases, mirrored items, and
 * other supported [data] item types" (Microsoft Learn — onelake-catalog-explore).
 *
 * Shared single source of truth between the OneLake page (app/onelake/page.tsx)
 * and the recycle BFF route (app/api/onelake/recycle/route.ts) so the catalog
 * and its recycle bin always agree on which types they cover.
 */
export const ONELAKE_TYPES = [
  'lakehouse',
  'warehouse',
  'sql-database',
  'mirrored-database',
  'mirrored-databricks',
  'kql-database',
  'eventhouse',
] as const;

export type OneLakeItemType = (typeof ONELAKE_TYPES)[number];

/** True when `itemType` is one the OneLake catalog/recycle bin manages. */
export function isOneLakeType(itemType: string): boolean {
  return (ONELAKE_TYPES as readonly string[]).includes(itemType);
}
