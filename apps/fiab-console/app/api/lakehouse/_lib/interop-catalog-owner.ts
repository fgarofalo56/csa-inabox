/**
 * Whose table a catalog entry points at, for `/api/lakehouse/interop`.
 *
 * Iceberg catalog namespaces are not per lakehouse, so before the interop
 * route (re-)registers or de-registers `<namespace>.<table>` it reads the
 * existing entry and compares its metadata location with THIS item's table
 * root. Only an absent entry, or one that already points under this item's
 * table, is changed; an entry pointing anywhere else is left alone.
 */
import { IcebergCatalogError, loadTable } from '@/lib/azure/iceberg-catalog-client';
import { trimTrailingSlashes } from '@/lib/util/trim';

export type CatalogEntryOwner = 'absent' | 'ours' | 'other';

function under(location: string, tableRootUri: string): boolean {
  const root = trimTrailingSlashes(tableRootUri).toLowerCase();
  const loc = trimTrailingSlashes(location).toLowerCase();
  return loc === root || loc.startsWith(`${root}/`);
}

export async function catalogEntryOwner(
  namespace: string,
  table: string,
  tableRootUri: string,
): Promise<CatalogEntryOwner> {
  let entry;
  try {
    entry = await loadTable(namespace, table);
  } catch (e) {
    if (e instanceof IcebergCatalogError && e.status === 404) return 'absent';
    throw e;
  }
  const locations = [entry?.['metadata-location'], entry?.metadata?.location]
    .filter((l): l is string => typeof l === 'string' && l.length > 0);
  if (locations.length === 0) return 'other';
  return locations.every((l) => under(l, tableRootUri)) ? 'ours' : 'other';
}
