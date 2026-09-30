/**
 * A data product's output ports are written by its owner as free text: a port
 * names a container, a pool or a database. Before a grant is placed on what a
 * port names, it is checked against the stores the product's OWN workspace has
 * bound: the containers, dedicated pool and ADX databases that items in that
 * workspace resolve to through the bindings Loom records for them
 * (`resolveItemBackingScope`, lib/azure/item-backing-scope.ts).
 *
 *   adls-container → a container a lakehouse in the workspace is bound to
 *   adls-path      → a path inside such a container
 *   warehouse      → the deployment's dedicated pool, when the workspace has a
 *                    warehouse item (the grant always lands on that pool)
 *   kql-database   → an ADX database a KQL database / eventhouse in the
 *                    workspace is recorded as installed on
 *
 * A target that names anything else keeps its scope type with an EMPTY
 * scopeRef. The grant steps treat an empty scopeRef as "not bound yet": no grant
 * call, a pending result, and approval once the workspace binds that store.
 * If the workspace's items cannot be read, every store target is treated as
 * unverified (fail closed).
 */
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { resolveItemBackingScope } from '@/lib/azure/item-backing-scope';
import type { GrantTarget } from '@/lib/dataproducts/fulfillment';
import type { WorkspaceItem } from '@/lib/types/workspace';

const STORE_ITEM_TYPES: ReadonlySet<string> = new Set(['lakehouse', 'warehouse', 'kql-database', 'eventhouse']);
const STORE_SCOPES: ReadonlySet<string> = new Set(['adls-container', 'adls-path', 'warehouse', 'kql-database']);

export interface WorkspaceStores {
  containers: Set<string>;
  kqlDatabases: Set<string>;
  warehousePool: string | null;
}

/** The stores items in `workspaceId` are bound to. Throws when the items cannot be read. */
export async function workspaceStores(workspaceId: string): Promise<WorkspaceStores> {
  const out: WorkspaceStores = { containers: new Set(), kqlDatabases: new Set(), warehousePool: null };
  if (!workspaceId) return out;
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>(
      { query: 'SELECT * FROM c WHERE c.workspaceId = @w', parameters: [{ name: '@w', value: workspaceId }] },
      { partitionKey: workspaceId },
    )
    .fetchAll();
  for (const it of resources || []) {
    if (!it || !STORE_ITEM_TYPES.has(it.itemType)) continue;
    const scope = resolveItemBackingScope(it);
    if ('pending' in scope) continue;
    if (scope.scopeType === 'adls-container') out.containers.add(scope.scopeRef);
    else if (scope.scopeType === 'kql-database') out.kqlDatabases.add(scope.scopeRef);
    else if (scope.scopeType === 'warehouse') out.warehousePool = scope.scopeRef;
  }
  return out;
}

/** The container an ADLS path names: `gold/x/y` → `gold`; `abfss://gold@acct.dfs.../x` → `gold`. */
function containerOfPath(ref: string): string {
  const abfss = /^abfss:\/\/([^@/]+)@/i.exec(ref);
  if (abfss) return abfss[1];
  return ref.replace(/^\/+/, '').split('/')[0] || '';
}

/** Each target checked against `stores`; an unverified store target gets an empty scopeRef. */
export function verifyTargets(targets: GrantTarget[], stores: WorkspaceStores | null): GrantTarget[] {
  return targets.map((t) => {
    if (!STORE_SCOPES.has(t.scopeType)) return t;
    const unbound: GrantTarget = { ...t, scopeRef: '' };
    if (!stores) return unbound;
    switch (t.scopeType) {
      case 'adls-container':
        return stores.containers.has(t.scopeRef) ? t : unbound;
      case 'adls-path':
        return stores.containers.has(containerOfPath(t.scopeRef)) ? t : unbound;
      case 'warehouse':
        return stores.warehousePool ? { ...t, scopeRef: stores.warehousePool } : unbound;
      case 'kql-database':
        return stores.kqlDatabases.has(t.scopeRef) ? t : unbound;
      default:
        return unbound;
    }
  });
}

/** {@link verifyTargets} against the stores of `product`'s own workspace; fails closed. */
export async function verifyProductTargets(
  product: Pick<WorkspaceItem, 'workspaceId'>,
  targets: GrantTarget[],
): Promise<GrantTarget[]> {
  if (!targets.some((t) => STORE_SCOPES.has(t.scopeType))) return targets;
  let stores: WorkspaceStores | null = null;
  try {
    stores = await workspaceStores(product.workspaceId);
  } catch {
    stores = null;
  }
  return verifyTargets(targets, stores);
}
