import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, docForItem } from '@/lib/azure/loom-search';
import { findItemType } from '@/lib/catalog/fabric-item-types';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { apiError, apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

/**
 * Shape a raw item doc for the LIST response (rel-T97). Flattens the governance
 * fields the browse surfaces (folders pane, object explorer, task flows) read —
 * endorsement / sensitivity / owner — as top-level fields, then DROPS the heavy
 * `state` blob (notebook cells, semantic-model BIM, report definitions, cached
 * query results, …). A workspace with large items no longer ships megabytes on
 * every list call; editors load the full `state` from the per-item detail route
 * (GET /api/cosmos-items/[type]/[id]), never from the list.
 */
function shapeForList(it: WorkspaceItem) {
  const st = (it.state ?? {}) as Record<string, unknown>;
  const endorsement =
    (typeof st.endorsement === 'string' && st.endorsement) ||
    (st.certified ? 'Certified' : undefined) || undefined;
  const sensitivity =
    (typeof st.sensitivityLabel === 'string' && st.sensitivityLabel) || undefined;
  const owner =
    (typeof st.ownerUpn === 'string' && st.ownerUpn) ||
    (typeof st.contact === 'string' && st.contact) ||
    (typeof st.steward === 'string' && st.steward) || undefined;
  // sqlEndpointFor is the auto-paired-warehouse back-reference — keep it as a
  // light top-level flag (some surfaces group/hide the paired endpoint) without
  // dragging the whole state along.
  const sqlEndpointFor = typeof st.sqlEndpointFor === 'string' ? st.sqlEndpointFor : undefined;
  const { state: _state, ...rest } = it;
  return {
    ...rest,
    ...(endorsement ? { endorsement } : {}),
    ...(sensitivity ? { sensitivity } : {}),
    ...(owner ? { owner } : {}),
    ...(sqlEndpointFor ? { sqlEndpointFor } : {}),
  };
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

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const ws = await loadWorkspace(params.id, session);
    if (!ws) return err('Workspace not found', 404, 'not_found');
    const items = await itemsContainer();
    const spec = {
      query: 'SELECT * FROM c WHERE c.workspaceId = @w ORDER BY c.createdAt DESC',
      parameters: [{ name: '@w', value: ws.id }],
    };

    // ADDITIVE pagination (rel-T97): opt-in via `?paginate=1` (or by passing a
    // `?continuation=<token>`). Returns `{ items, continuationToken }` so a huge
    // workspace can be paged with Cosmos continuation tokens instead of buffering
    // every item into one response. WITHOUT these params the response stays the
    // historical BARE ARRAY that existing callers (listItems, object-explorer,
    // task-flows) depend on — the shape contract is unchanged for them.
    const sp = req.nextUrl.searchParams;
    const wantPaged = sp.get('paginate') === '1' || sp.has('continuation');
    if (wantPaged) {
      const limit = Math.min(Math.max(Number(sp.get('limit')) || 100, 1), 500);
      const continuationToken = sp.get('continuation') || undefined;
      const iterator = items.items.query<WorkspaceItem>(spec, {
        partitionKey: ws.id,
        maxItemCount: limit,
        continuationToken,
      });
      const page = await iterator.fetchNext();
      return NextResponse.json({
        items: (page.resources ?? []).map(shapeForList),
        continuationToken: page.continuationToken ?? null,
      });
    }

    const { resources } = await items.items
      .query<WorkspaceItem>(spec, { partitionKey: ws.id })
      .fetchAll();
    // Bare array (existing contract) — governance fields flattened, heavy
    // `state` projected out per shapeForList.
    return NextResponse.json(resources.map(shapeForList));
  } catch (e: any) {
    return apiServerError(e, 'Failed to list items', 'cosmos_error');
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
    return apiServerError(e, 'Failed to create item', 'cosmos_error');
  }
}
