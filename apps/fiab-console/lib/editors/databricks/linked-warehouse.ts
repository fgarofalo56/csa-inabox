/**
 * #3669 — which warehouse the SQL warehouse editor opens on.
 *
 * The editor used to preselect `list[0]`, i.e. whichever warehouse Databricks
 * listed first, owned by this item or not. It now preselects ONLY the warehouse
 * the server reports as linked to this item (`linkedWarehouseId`, computed from
 * the live `loom_item_id` tags by `GET .../[id]/warehouses`), and nothing when
 * there is none. The id must also be in the returned list, so a stale or
 * malformed field can never select a warehouse the picker does not show.
 *
 * Pure and dependency-free so it is unit-testable without rendering the editor.
 */
export function preselectWarehouseId(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as { linkedWarehouseId?: unknown; warehouses?: unknown };
  const linked = typeof b.linkedWarehouseId === 'string' ? b.linkedWarehouseId : '';
  if (!linked || !Array.isArray(b.warehouses)) return '';
  return b.warehouses.some((w) => (w as { id?: unknown } | null)?.id === linked) ? linked : '';
}
