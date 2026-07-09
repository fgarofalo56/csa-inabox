/**
 * External (cross-tenant) data sharing — collection route (FGC-30).
 *
 *   GET  /api/external-shares?sourceItemId=<id>&sourceItemType=<type>
 *        → { ok, shares }  (tenant-scoped list for one source item)
 *   POST /api/external-shares
 *        body { sourceItemId, sourceItemType, sharedPath, targetUpnOrDomain,
 *               expiry }
 *        → { ok, share }
 *
 * The Azure-native cross-tenant mechanism — an Entra B2B guest + a scoped ADLS
 * grant on JUST the shared path — with NO Microsoft Fabric dependency. The
 * caller must OWN the source item (tenant-scoped ownership check) to share it;
 * the container + storage-root are resolved from the item's provisioning
 * receipt, and the shared subset is validated to sit under that root.
 */
import { NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiForbidden, apiHonestError, apiServerError } from '@/lib/api/respond';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem, Workspace } from '@/lib/types/workspace';
import {
  createExternalShare,
  listExternalShares,
  externalSharingEnabled,
  ExternalSharingNotConfiguredError,
  GraphIdentityError,
} from '@/lib/azure/external-share-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Load the item + verify the caller's tenant owns its workspace. */
async function loadOwnedItem(itemId: string, itemType: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @i AND c.itemType = @t',
      parameters: [{ name: '@i', value: itemId }, { name: '@t', value: itemType }],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    return resource && resource.tenantId === tenantId ? item : null;
  } catch {
    return null;
  }
}

/** Resolve the item's ADLS container + storage-root from its provisioning receipt. */
function resolveItemStorage(item: WorkspaceItem): { container?: string; root?: string } {
  const state = (item.state || {}) as Record<string, any>;
  const sec = (state.provisioning?.secondaryIds || {}) as Record<string, string>;
  const container = sec.container || state.adlsContainer || undefined;
  const root = sec.rootPath || state.adlsPath || state.rootPath || undefined;
  return { container, root };
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const url = new URL(req.url);
  const sourceItemId = (url.searchParams.get('sourceItemId') || '').trim();
  const sourceItemType = (url.searchParams.get('sourceItemType') || '').trim();
  if (!sourceItemId) return apiError('sourceItemId is required', 400);

  try {
    // Ownership check (best-effort — a share row is tenant-partitioned anyway).
    if (sourceItemType) {
      const item = await loadOwnedItem(sourceItemId, sourceItemType, tenantScopeId(session));
      if (!item) return apiForbidden('not the owner of this item');
    }
    const shares = await listExternalShares(sourceItemId, tenantScopeId(session));
    return apiOk({ shares, enabled: externalSharingEnabled() });
  } catch (e: any) {
    return apiServerError(e, 'Failed to list external shares');
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const body = await req.json().catch(() => ({} as any));
  const sourceItemId = String(body?.sourceItemId || '').trim();
  const sourceItemType = String(body?.sourceItemType || '').trim();
  const sharedPath = String(body?.sharedPath || '').trim();
  const targetUpnOrDomain = String(body?.targetUpnOrDomain || '').trim();
  const expiry = String(body?.expiry || '').trim();

  if (!sourceItemId || !sourceItemType) return apiError('sourceItemId and sourceItemType are required', 400);

  try {
    if (!externalSharingEnabled()) {
      const gate = new ExternalSharingNotConfiguredError();
      return apiHonestError(gate, 503, `${gate.message} ${gate.hint}`);
    }
    const item = await loadOwnedItem(sourceItemId, sourceItemType, tenantScopeId(session));
    if (!item) return apiForbidden('not the owner of this item');
    const { container, root } = resolveItemStorage(item);
    if (!container) {
      return apiError(
        'This item has no resolved ADLS container in its provisioning receipt — external sharing needs a storage-backed item (lakehouse / dataset).',
        409,
      );
    }
    // The shared subset must sit under the item's storage root (defense in depth).
    const cleanRoot = (root || '').replace(/^\/+|\/+$/g, '');
    const cleanShared = sharedPath.replace(/^\/+/, '');
    if (cleanRoot && !(cleanShared === cleanRoot || cleanShared.startsWith(`${cleanRoot}/`))) {
      return apiError(`The shared path must be within the item's storage root "${cleanRoot}".`, 400);
    }

    const origin = new URL(req.url).origin;
    const share = await createExternalShare({
      sourceItemId,
      sourceItemType,
      sourceItemName: (item as any).displayName || (item as any).name,
      tenantId: tenantScopeId(session),
      container,
      sharedPath: cleanShared || cleanRoot,
      targetUpnOrDomain,
      expiry,
      createdBy: session.claims.upn || session.claims.oid,
      redirectUrl: `${origin}/external-shares/received`,
    });
    return apiOk({ share });
  } catch (e: any) {
    if (e instanceof ExternalSharingNotConfiguredError) return apiHonestError(e, 503, `${e.message} ${e.hint}`);
    if (e instanceof GraphIdentityError) {
      // A 403 here is a missing User.Invite.All consent — surface it honestly.
      const status = e.status === 403 ? 403 : (e.status || 502);
      return apiHonestError(
        e,
        status,
        status === 403
          ? 'Sending the B2B invitation was denied — grant the Console UAMI the Microsoft Graph app permission User.Invite.All (09850681-111b-4a89-9bed-3f2cae46d706) with admin consent.'
          : undefined,
      );
    }
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
      return apiError(e.message || 'invalid external share', e.status);
    }
    return apiServerError(e, 'Failed to create the external share');
  }
}
