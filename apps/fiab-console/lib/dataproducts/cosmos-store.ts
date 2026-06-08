/**
 * CosmosDataProductStore — the Azure-native DEFAULT DataProductStore adapter.
 *
 * Wraps the shared item-crud helpers over the Loom `items` Cosmos container,
 * persisting/reading data products as `data-product` workspace items. Maps
 * WorkspaceItem <-> LoomDataProduct so the same BFF + UI work against either
 * backend (per .claude/rules/ui-parity.md).
 *
 * This is the backend the factory selects whenever the Purview Unified Catalog
 * adapter is not explicitly opted in (and ALWAYS on GCC / GCC-High / IL5). It
 * requires no Fabric and no Purview — just the Loom Cosmos account every
 * deployment already has.
 */
import type { SessionPayload } from '@/lib/auth/session';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  createOwnedItem,
  loadOwnedItem,
  listOwnedItems,
  updateOwnedItem,
  deleteOwnedItem,
} from '@/app/api/items/_lib/item-crud';
import type { DataProductStore, LoomDataProduct, LoomDataProductPayload } from './store';

const ITEM_TYPE = 'data-product';

function toLoom(item: WorkspaceItem): LoomDataProduct {
  const st = (item.state || {}) as Record<string, unknown>;
  return {
    id: item.id,
    name: item.displayName,
    description: item.description ?? (typeof st.description === 'string' ? st.description : undefined),
    domain: typeof st.domain === 'string' ? st.domain : undefined,
    status: typeof st.status === 'string' ? st.status : undefined,
    type: typeof st.type === 'string' ? st.type : undefined,
    endorsed: typeof st.endorsed === 'boolean' ? st.endorsed : undefined,
    contacts: st.contacts,
    businessUse: typeof st.businessUse === 'string' ? st.businessUse : undefined,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    source: 'cosmos',
    raw: item,
  };
}

/** Pull the data-product fields OUT of a payload into the item `state` blob. */
function toState(payload: Partial<LoomDataProductPayload>): Record<string, unknown> {
  const { name, workspaceId, description, ...rest } = payload;
  return { ...rest };
}

export class CosmosDataProductStore implements DataProductStore {
  readonly backendName = 'cosmos' as const;

  async list(session: SessionPayload): Promise<LoomDataProduct[]> {
    const items = await listOwnedItems(ITEM_TYPE, session.claims.oid).catch(() => []);
    return items.map(toLoom);
  }

  async get(session: SessionPayload, id: string): Promise<LoomDataProduct | null> {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    return item ? toLoom(item) : null;
  }

  async create(session: SessionPayload, payload: LoomDataProductPayload): Promise<LoomDataProduct> {
    if (!payload?.workspaceId) {
      throw new Error('workspaceId is required to create a data product in the Cosmos backend');
    }
    const r = await createOwnedItem(session, ITEM_TYPE, {
      workspaceId: payload.workspaceId,
      displayName: payload.name,
      description: payload.description,
      state: toState(payload),
    });
    if (!r.ok) {
      const err = new Error(r.error) as Error & { status?: number };
      err.status = r.status;
      throw err;
    }
    return toLoom(r.item);
  }

  async update(session: SessionPayload, id: string, patch: Partial<LoomDataProductPayload>): Promise<LoomDataProduct | null> {
    const current = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!current) return null;
    const nextState = { ...(current.state || {}), ...toState(patch) };
    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      displayName: typeof patch.name === 'string' ? patch.name : undefined,
      description: 'description' in patch ? patch.description : undefined,
      state: nextState,
    });
    return updated ? toLoom(updated) : null;
  }

  async remove(session: SessionPayload, id: string): Promise<boolean> {
    return deleteOwnedItem(id, ITEM_TYPE, session.claims.oid);
  }
}
