/**
 * Server-side resolution of the asset behind a catalog access request.
 *
 * `POST /api/catalog/request-access` and the final tier of
 * `POST /api/access-requests/[id]/decision` both need three facts about the
 * requested asset: that it exists and the caller may see it, which access model
 * governs it, and which scope(s) a grant binds to. All three come from the
 * asset's own record — never from the request body:
 *
 *   - existence + visibility — the item is loaded by id. A data product must be
 *     published (or deprecated) and discoverable to the caller
 *     (`resolveDiscoveryAccess`); any other catalog item must be in a workspace
 *     the caller belongs to, or in the caller's own Entra tenant
 *     (`sameTenantConfirmed`). Everything else is the one not-found answer.
 *   - access model — a data product's `state.accessModel` (governed |
 *     self-serve | request, default governed). Every other item is governed.
 *   - grant scope — a data product's bound output ports / ADLS data assets
 *     (`resolveGrantTargets`), falling back to the product itself (a Loom-native
 *     item-scope grant). Every other item is an item-scope grant on itself.
 *
 * Self-serve grants the product's self-serve role only. Data products carry no
 * per-product role setting, so that role is Read; a request for more than Read
 * goes through the governed approval workflow instead.
 */
import type { SessionPayload } from '@/lib/auth/session';
import { authorizeWorkspace } from '@/lib/auth/workspace-guard';
import { sameTenantConfirmed } from '@/lib/auth/tenant-boundary';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { AccessPermission } from '@/lib/azure/access-policy-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  DISCOVERABLE, resolveDiscoveryAccess, workspaceTid,
} from '@/lib/dataproducts/discoverability';
import { resolveLifecycleState } from '@/lib/dataproducts/lifecycle';
import { resolveGrantTargets, type GrantTarget } from '@/lib/dataproducts/fulfillment';

export type RequestAccessModel = 'governed' | 'self-serve' | 'request';

const ACCESS_MODELS: ReadonlySet<string> = new Set(['governed', 'self-serve', 'request']);

/** The role a self-serve request is granted without approval. */
export const SELF_SERVE_PERMISSION: AccessPermission = 'read';

/** The one not-found wording for "no such asset" and "not visible to you". */
export const ASSET_NOT_FOUND = 'Asset not found';

export interface RequestableAsset {
  item: WorkspaceItem;
  /** Display name recorded on the item (state.displayName wins, as elsewhere). */
  name: string;
  accessModel: RequestAccessModel;
}

/** Load a catalog item by id (any item type). Returns null when absent. */
export async function loadCatalogItem(assetId: string): Promise<WorkspaceItem | null> {
  const id = String(assetId || '').trim();
  if (!id) return null;
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: id }],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/** The access model an item is governed by. Only data products carry one. */
export function accessModelOf(item: WorkspaceItem): RequestAccessModel {
  if (item.itemType !== 'data-product') return 'governed';
  const am = (item.state as Record<string, unknown> | undefined)?.accessModel;
  return typeof am === 'string' && ACCESS_MODELS.has(am) ? (am as RequestAccessModel) : 'governed';
}

/**
 * Every scope a grant for `item` binds to, at `permission`. Never empty: an item
 * with no bound physical output is granted at item scope on itself.
 */
export function deriveRequestTargets(item: WorkspaceItem, permission: AccessPermission): GrantTarget[] {
  if (item.itemType === 'data-product') {
    const targets = resolveGrantTargets(item.state as Record<string, unknown> | undefined, permission);
    if (targets.length > 0) return targets;
    return [{ scopeType: 'item', scopeRef: item.id, permission, source: 'data product' }];
  }
  return [{ scopeType: 'item', scopeRef: item.id, permission, source: `${item.itemType || 'catalog'} item` }];
}

/**
 * Resolve the asset a caller is requesting access to, or null when it does not
 * exist, is not published (data products), or is not visible to the caller.
 */
export async function resolveRequestableAsset(
  session: SessionPayload,
  assetId: string,
): Promise<RequestableAsset | null> {
  const item = await loadCatalogItem(assetId);
  if (!item) return null;

  if (item.itemType === 'data-product') {
    if (!DISCOVERABLE.has(resolveLifecycleState(item.state as Record<string, unknown>))) return null;
    if ((await resolveDiscoveryAccess(session, item)) === 'denied') return null;
  } else {
    const denied = await authorizeWorkspace(session, item.workspaceId, { allowReadRoles: true });
    if (denied && !sameTenantConfirmed(session.claims.tid, await workspaceTid(item.workspaceId))) {
      return null;
    }
  }

  const stateName = (item.state as Record<string, unknown> | undefined)?.displayName;
  return {
    item,
    name: (typeof stateName === 'string' && stateName) || item.displayName || item.id,
    accessModel: accessModelOf(item),
  };
}
