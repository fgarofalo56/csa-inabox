/**
 * Shortcut registry reads for one lakehouse item, including rows saved under
 * the earlier container-name key.
 *
 * Rows are keyed by the lakehouse item id. Rows from before that were keyed by
 * the storage container name; `legacyContainerKeyFor` names that key only when
 * this item is the one lakehouse bound to the container, and these helpers read
 * it as a fallback in exactly that case. Nothing is re-keyed here: a caller that
 * changes a row does so under the key `findShortcutRow` reports.
 */
import { getShortcut, listShortcuts, type LakehouseShortcut } from '@/lib/azure/lakehouse-shortcuts';
import { legacyContainerKeyFor } from './legacy-container-key';

export type ListedShortcut = LakehouseShortcut & { legacy?: boolean };

/** Identity of a shortcut within one lakehouse, independent of the registry key. */
function slotOf(s: Pick<LakehouseShortcut, 'kind' | 'parentPath' | 'name'>): string {
  return `${s.kind}\u0000${s.parentPath || ''}\u0000${s.name}`;
}

/**
 * The item's shortcut rows, followed by rows under its legacy container key
 * (marked `legacy: true`) that do not occupy a slot an item-keyed row already
 * holds.
 */
export async function listShortcutsForItem(lakehouseId: string, workspaceId: string): Promise<ListedShortcut[]> {
  const own: ListedShortcut[] = await listShortcuts(lakehouseId);
  const legacyKey = await legacyContainerKeyFor(lakehouseId, workspaceId);
  if (!legacyKey) return own;
  const taken = new Set(own.map(slotOf));
  const out = [...own];
  for (const s of await listShortcuts(legacyKey)) {
    if (taken.has(slotOf(s))) continue;
    taken.add(slotOf(s));
    out.push({ ...s, legacy: true });
  }
  return out;
}

/**
 * The row `id` for this item and the registry key it is stored under: the item
 * id first, then the legacy container key. Null when neither holds it.
 */
export async function findShortcutRow(
  lakehouseId: string,
  workspaceId: string,
  id: string,
): Promise<{ row: LakehouseShortcut; key: string } | null> {
  const own = await getShortcut(lakehouseId, id);
  if (own) return { row: own, key: lakehouseId };
  const legacyKey = await legacyContainerKeyFor(lakehouseId, workspaceId);
  if (!legacyKey) return null;
  const legacy = await getShortcut(legacyKey, id);
  return legacy ? { row: legacy, key: legacyKey } : null;
}
