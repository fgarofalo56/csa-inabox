/**
 * POST /api/admin/lakehouse-roots/keep — "Keep root for <lakehouse>".
 *
 * The Fix-it for the readiness check "Lakehouses sharing a storage root"
 * (lib/admin/env-checks/lakehouse-shared-roots.ts). Two or more lakehouses
 * resolve to one directory; the admin names the one whose data it is.
 *
 *   body: { itemId: string }
 *
 * WHAT IT DOES
 *   1. Re-reads every lakehouse and re-derives the group from the store — the
 *      client names only the keeper, never the group or any location.
 *   2. Every OTHER member (recycled ones too) gets a root of its own: its
 *      id-bearing item root, created with its ownership marker in the container
 *      auto-bind would use, and recorded on the item. The installer receipt's
 *      location fields are cleared on those members, since they name the
 *      common root and the resolver reads them first.
 *   3. The keeper's location is recorded on the keeper and its directory is
 *      marked for it, so the resolver keeps it without reading other items.
 *
 * Nothing is copied or deleted: the common root and its files stay where
 * they are, now marked for the keeper. Admin-only (`admin.env-config`), like the
 * readiness route that lists the groups. Each write is conditional on the item's
 * ETag; a member that fails is reported, and the others are still applied.
 */
import { NextResponse } from 'next/server';
import { withCapability } from '@/lib/api/route-toolkit';
import { apiBadRequest, apiConflict } from '@/lib/api/respond';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { configuredContainerNames, type KnownContainer } from '@/lib/azure/adls-client';
import {
  createOwnedLakehouseRoot,
  listLakehouseRootFacts,
  mayAdoptRoot,
  readLakehouseRootOwner,
  stampLakehouseRootOwner,
} from '@/lib/azure/lakehouse-abfss';
import {
  isLakehouseRootShape,
  lakehouseContainerOrder,
  lakehouseItemRootPath,
  lakehouseRootLocation,
} from '@/lib/azure/backing-name';
import { findSharedLakehouseRoots } from '@/lib/admin/env-checks/lakehouse-shared-roots';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import type { WorkspaceItem } from '@/lib/types/workspace';

interface Reassigned { id: string; name: string; container: string; root: string }
interface Failed { id: string; name: string; error: string }

/** The installer receipt without the three fields that name a location. */
function withoutReceiptLocation(state: Record<string, any>): Record<string, any> {
  const prov = state.provisioning;
  if (!prov || typeof prov !== 'object' || !prov.secondaryIds || typeof prov.secondaryIds !== 'object') return state;
  const { adlsRoot: _a, container: _c, rootPath: _r, ...keep } = prov.secondaryIds as Record<string, unknown>;
  return { ...state, provisioning: { ...prov, secondaryIds: keep } };
}

export const POST = withCapability('admin.env-config', 'Admin', async (req, { session }) => {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('invalid JSON body');
  }
  const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : '';
  if (!itemId) return apiBadRequest('itemId is required');

  const rows = await listLakehouseRootFacts(undefined, { includeRecycled: true });
  const group = findSharedLakehouseRoots(rows).find((g) => g.ids.includes(itemId));
  if (!group) {
    return apiConflict(
      'That lakehouse is not in a group of lakehouses sharing a storage root, so nothing was changed. '
      + 'The group may already be resolved; refresh Readiness.',
    );
  }
  const keeper = group.members.find((m) => m.id === itemId)!;
  if (keeper.recycled) {
    return apiConflict(`"${keeper.name}" is in the recycle bin. Restore it before keeping its root; nothing was changed.`);
  }
  const loc = lakehouseRootLocation(rows.find((r) => r.id === itemId)!);
  if (!loc) return apiConflict('The lakehouse record could not be read; nothing was changed.');
  if (loc.account) {
    return apiConflict(
      `"${keeper.name}" keeps its files on another storage account (${loc.account}), which this action does not change. Nothing was changed.`,
    );
  }
  const configured = configuredContainerNames() as KnownContainer[];
  const keeperRoot = loc.segments.join('/');
  // The keeper's container: the recorded one, or the first container that
  // actually holds its (derived) root.
  let keeperContainer = loc.container;
  if (!keeperContainer) {
    for (const c of configured) {
      const r = await readLakehouseRootOwner(c, keeperRoot).catch(() => null);
      if (r?.exists) { keeperContainer = c; break; }
    }
  }
  if (!keeperContainer || !(configured as string[]).includes(keeperContainer)) {
    return apiConflict(
      `Loom found no directory "${keeperRoot}" for "${keeper.name}" in a configured container, so there is nothing to keep. Nothing was changed.`,
    );
  }
  const target = lakehouseContainerOrder(configured)[0];
  const items = await itemsContainer();
  const reassigned: Reassigned[] = [];
  const failed: Failed[] = [];

  for (const m of group.members) {
    if (m.id === itemId) continue;
    try {
      const { resource } = await items.item(m.id, m.workspaceId).read<WorkspaceItem>();
      if (!resource) throw new Error('the item was not found');
      const root = lakehouseItemRootPath(resource.displayName || '', resource.id);
      try {
        await createOwnedLakehouseRoot(target, root, resource.id);
      } catch (e: any) {
        if (e?.statusCode !== 409 && e?.statusCode !== 412) throw e;
        const r = await readLakehouseRootOwner(target, root);
        if (!r.exists || !mayAdoptRoot(r.owner, resource.id)) {
          throw new Error(`${target}/${root} already exists and is marked for another item`);
        }
      }
      const state = withoutReceiptLocation({ ...((resource.state as Record<string, any>) || {}) });
      const etag = (resource as { _etag?: unknown })._etag;
      await items.item(resource.id, m.workspaceId).replace<WorkspaceItem>(
        { ...resource, state: { ...state, adlsContainer: target, lakehouseRoot: root }, updatedAt: new Date().toISOString() },
        typeof etag === 'string' && etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : undefined,
      );
      reassigned.push({ id: m.id, name: m.name, container: target, root });
    } catch (e: any) {
      failed.push({ id: m.id, name: m.name, error: e?.message || String(e) });
    }
  }

  // The keeper: record the location and mark the directory for it.
  let keeperMarked = false;
  try {
    const { resource } = await items.item(keeper.id, keeper.workspaceId).read<WorkspaceItem>();
    if (!resource) throw new Error('the item was not found');
    if (isLakehouseRootShape(keeperRoot)) {
      const etag = (resource as { _etag?: unknown })._etag;
      await items.item(resource.id, keeper.workspaceId).replace<WorkspaceItem>(
        {
          ...resource,
          state: { ...((resource.state as Record<string, any>) || {}), adlsContainer: keeperContainer, lakehouseRoot: keeperRoot },
          updatedAt: new Date().toISOString(),
        },
        typeof etag === 'string' && etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : undefined,
      );
    }
    const dir = await readLakehouseRootOwner(keeperContainer, keeperRoot);
    keeperMarked = dir.exists && (await stampLakehouseRootOwner(keeperContainer, keeperRoot, keeper.id, dir));
    if (!keeperMarked) throw new Error(`could not mark ${keeperContainer}/${keeperRoot} for this lakehouse`);
  } catch (e: any) {
    failed.push({ id: keeper.id, name: keeper.name, error: e?.message || String(e) });
  }

  emitAuditEvent({
    actorOid: session.claims.oid,
    actorUpn: session.claims.upn,
    action: 'lakehouse-root.keep',
    targetType: 'lakehouse',
    targetId: keeper.id,
    outcome: failed.length ? 'failure' : 'success',
    detail: { container: keeperContainer, root: keeperRoot, reassigned: reassigned.map((r) => r.id), failed: failed.map((f) => f.id) },
    tenantId: (session.claims as { tid?: string }).tid || '',
  });

  return NextResponse.json(
    {
      ok: failed.length === 0,
      kept: { id: keeper.id, name: keeper.name, container: keeperContainer, root: keeperRoot, marked: keeperMarked },
      reassigned,
      failed,
    },
    { status: failed.length ? 502 : 200 },
  );
});
