import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, docForItem } from '@/lib/azure/loom-search';
import { findItemType } from '@/lib/catalog/fabric-item-types';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

/**
 * ACL-aware workspace load (rel-T11/B4): owner fast-path, then the
 * workspace-roles ACL under the tid boundary. `write` additionally requires
 * a write-capable role (Owner/Admin/Member). Live-caught by the Wave-1
 * two-user receipt — the old owner-partition point-read 404'd item listing
 * for a Member of a shared workspace.
 */
async function loadWorkspace(id: string, session: SessionPayload, opts: { write?: boolean } = {}): Promise<Workspace | null> {
  const claims = session.claims as { oid: string; tid?: string; groups?: string[] };
  const access = await resolveWorkspaceAccessByOid(claims.oid, id, { groups: claims.groups, callerTid: claims.tid });
  if (!access) return null;
  if (opts.write && !access.canWrite) return null;
  return access.workspace;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const ws = await loadWorkspace(params.id, session);
    if (!ws) return err('Workspace not found', 404, 'not_found');
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT * FROM c WHERE c.workspaceId = @w ORDER BY c.createdAt DESC',
        parameters: [{ name: '@w', value: ws.id }],
      }, { partitionKey: ws.id })
      .fetchAll();
    // ADDITIVE: surface governance state as top-level fields so browse surfaces
    // (workspace Items list view, catalog) can sort/filter on them without
    // digging into `state`. `state.endorsement` is the canonical key (with the
    // legacy `state.certified` boolean fallback); `state.sensitivityLabel` is
    // the MIP-style sensitivity label. Response shape is otherwise unchanged
    // (still a bare array of the full item docs).
    const shaped = resources.map((it) => {
      const st = (it.state ?? {}) as Record<string, unknown>;
      const endorsement =
        (typeof st.endorsement === 'string' && st.endorsement) ||
        (st.certified ? 'Certified' : undefined) || undefined;
      const sensitivity =
        (typeof st.sensitivityLabel === 'string' && st.sensitivityLabel) || undefined;
      return {
        ...it,
        ...(endorsement ? { endorsement } : {}),
        ...(sensitivity ? { sensitivity } : {}),
      };
    });
    return NextResponse.json(shaped);
  } catch (e: any) {
    return err(e?.message || 'Failed to list items', 500, 'cosmos_error');
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  const { itemType, displayName, description, folderId, customAttributes } = body || {};
  if (!itemType || typeof itemType !== 'string') return err('itemType is required', 400, 'missing_itemType');
  if (!displayName || typeof displayName !== 'string') return err('displayName is required', 400, 'missing_displayName');
  // Reject junk slugs: itemType must be a real Fabric item type from the registry.
  if (!findItemType(itemType)) {
    return err(`Unknown itemType "${itemType}". Must be a registered Fabric item-type slug.`, 400, 'invalid_itemType');
  }

  try {
    // Item creation requires a write-capable role (Owner/Admin/Member).
    const ws = await loadWorkspace(params.id, session, { write: true });
    if (!ws) return err('Workspace not found', 404, 'not_found');
    const now = new Date().toISOString();
    // F17: persist admin-defined custom-attribute values on the item state so
    // they round-trip into the Edit dialog and surface in the catalog.
    const initialState: Record<string, unknown> = {};
    if (customAttributes && typeof customAttributes === 'object' && !Array.isArray(customAttributes)) {
      initialState.customAttributes = customAttributes;
    }
    const item: WorkspaceItem = {
      id: crypto.randomUUID(),
      workspaceId: ws.id,
      itemType,
      displayName: displayName.trim(),
      description: description?.trim() || undefined,
      folderId: typeof folderId === 'string' && folderId ? folderId : null,
      state: initialState,
      createdBy: session.claims.upn || session.claims.email || session.claims.oid,
      createdAt: now,
      updatedAt: now,
    };
    const items = await itemsContainer();
    const { resource } = await items.items.create<WorkspaceItem>(item);
    if (resource) void upsertLoomDoc(docForItem(resource, session.claims.oid));

    // Fabric parity: creating a Lakehouse also provisions a paired SQL
    // analytics endpoint (a Warehouse-typed item). Both live in the same
    // workspace + folder; the paired warehouse carries
    // `state.sqlEndpointFor: <lakehouseId>` so DELETE can cascade. Failures
    // here are non-fatal — the lakehouse is the primary write.
    if (resource && itemType === 'lakehouse') {
      try {
        const paired: WorkspaceItem = {
          id: crypto.randomUUID(),
          workspaceId: ws.id,
          itemType: 'warehouse',
          displayName: `${displayName.trim()} (SQL endpoint)`,
          description: `Auto-paired SQL analytics endpoint for lakehouse "${displayName.trim()}".`,
          folderId: item.folderId,
          state: { sqlEndpointFor: resource.id, autoCreated: true },
          createdBy: session.claims.upn || session.claims.email || session.claims.oid,
          createdAt: now,
          updatedAt: now,
        };
        const { resource: pairedResource } = await items.items.create<WorkspaceItem>(paired);
        if (pairedResource) void upsertLoomDoc(docForItem(pairedResource, session.claims.oid));
      } catch (pairErr) {
        // eslint-disable-next-line no-console
        console.warn('[items.POST] failed to auto-create paired SQL endpoint', pairErr);
      }
    }

    return NextResponse.json(resource, { status: 201 });
  } catch (e: any) {
    return err(e?.message || 'Failed to create item', 500, 'cosmos_error');
  }
}
