/**
 * Iceberg namespaces and state rows for `/api/lakehouse/interop`.
 *
 * Default namespace. A table exposed as Iceberg is registered in the catalog as
 * `<namespace>.<table>`. The default namespace is derived from the lakehouse
 * ITEM (`lh_<12 hex of sha256(itemId)>`, the same digest the item's Spark
 * databases use, see `spark-namespace.ts`), plus the table's sub-folders joined
 * with `.`. Two lakehouse items therefore get different default names even
 * when they share a storage container. A namespace already recorded for the
 * table (in the item's state, or in the earlier container-keyed state) is
 * reused, so an existing catalog entry keeps its name.
 *
 * Earlier state. Interop state used to be one doc per storage container
 * (`interop:<container>`). `mergeInteropTables` adds the rows of that doc to
 * the item's own rows, marked `legacy`, when the caller has attributed the
 * container to this item alone (`legacyContainerKeyFor`); a table the item's
 * own doc already has keeps its own row.
 */
import type { InteropTableState, LakehouseInteropDoc } from '@/lib/azure/lakehouse-interop-model';
import { normalizeTableKey } from '@/lib/azure/lakehouse-interop-model';
import { itemSparkPrefix } from './spark-namespace';

/**
 * Accepted shape of a namespace supplied in the request: dot-separated levels
 * of letters, digits, `_` and `-`, each starting with a letter, digit or `_`.
 */
export const NAMESPACE_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}(\.[A-Za-z0-9_][A-Za-z0-9_-]{0,63}){0,7}$/;

/** The item's namespace root, `lh_<12 hex>`. */
export function itemNamespaceBase(lakehouseId: string): string {
  return itemSparkPrefix(lakehouseId).replace(/_$/, '');
}

/** The default namespace for `tableKey` in the lakehouse item `lakehouseId`. */
export function itemDefaultNamespace(lakehouseId: string, tableKey: string): string {
  const folders = tableKey.split('/').filter(Boolean).slice(0, -1)
    .map((s) => s.replace(/[^A-Za-z0-9_-]/g, ''))
    .filter(Boolean);
  return [itemNamespaceBase(lakehouseId), ...folders].join('.');
}

/** One row of the merged state; `legacy` marks a row read from the container-keyed doc. */
export type MergedInteropRow = InteropTableState & { legacy?: true };

/** The item's rows, then the earlier doc's rows for tables the item's doc does not have. */
export function mergeInteropTables(
  own: LakehouseInteropDoc | null,
  legacy: LakehouseInteropDoc | null,
): MergedInteropRow[] {
  const rows: MergedInteropRow[] = [...(own?.tables || [])];
  const seen = new Set(rows.map((t) => normalizeTableKey(t.table).toLowerCase()));
  for (const t of legacy?.tables || []) {
    const key = normalizeTableKey(t.table).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...t, legacy: true });
  }
  return rows;
}

/** The namespace recorded for `tableKey` in the item's doc, else the earlier doc, else ''. */
export function recordedNamespaceFor(
  own: LakehouseInteropDoc | null,
  legacy: LakehouseInteropDoc | null,
  tableKey: string,
): string {
  const key = tableKey.toLowerCase();
  for (const doc of [own, legacy]) {
    const hit = (doc?.tables || []).find((t) => normalizeTableKey(t.table).toLowerCase() === key);
    const ns = String(hit?.namespace || '').trim();
    if (ns) return ns;
  }
  return '';
}
