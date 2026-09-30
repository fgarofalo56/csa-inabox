/**
 * Read-time lookup of rows saved under the earlier container-name key.
 *
 * Schema rows, shortcut rows, interop state and settings used to be keyed by
 * the storage container name the editor had open (`bronze`, `silver`, ...),
 * which several lakehouse items can share. They are now keyed by the item id.
 *
 * A container-keyed row can be attributed to an item only when that item is
 * the ONE lakehouse bound to the container. `legacyContainerKeyFor` returns the
 * container name to read under in exactly that case, and null otherwise:
 *
 * - the item's storage does not resolve (no binding, withheld location);
 * - another lakehouse item records the same container;
 * - another lakehouse item records no container at all, so it could be bound
 *   to this one;
 * - the lakehouse list cannot be read.
 *
 * Nothing is written or re-keyed here. Callers read the legacy key as a
 * fallback and resolve deletes against whichever key holds the row.
 */
import { listLakehouseRootFacts, resolveLakehouseStorage } from '@/lib/azure/lakehouse-abfss';

type RootFacts = Awaited<ReturnType<typeof listLakehouseRootFacts>>[number];

/** The container a lakehouse item's server-recorded state names, or '' when none. */
export function recordedContainerOf(f: Partial<RootFacts>): string {
  const direct = [f.adlsContainer, f.provContainer]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find(Boolean);
  if (direct) return direct;
  const m = /^abfss:\/\/([^@/]+)@/i.exec(typeof f.provAdlsRoot === 'string' ? f.provAdlsRoot.trim() : '');
  return m ? m[1] : '';
}

/**
 * The legacy key (a container name) whose rows belong to `lakehouseId`, or
 * null when no container can be attributed to this item alone.
 */
export async function legacyContainerKeyFor(lakehouseId: string, workspaceId: string): Promise<string | null> {
  let container: string;
  try {
    const resolved = await resolveLakehouseStorage(lakehouseId, workspaceId);
    if (!resolved.ok) return null;
    container = String(resolved.bound.container || '').trim();
  } catch {
    return null;
  }
  if (!container) return null;
  let facts: RootFacts[];
  try {
    facts = await listLakehouseRootFacts();
  } catch {
    return null;
  }
  const shared = facts.some((f) => {
    if (f.id === lakehouseId) return false;
    const other = recordedContainerOf(f);
    return !other || other === container;
  });
  return shared ? null : container;
}
