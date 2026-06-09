/**
 * Saved SQL queries — "My Queries" (private) + "Shared Queries" for the
 * azure-sql-database editor.  Real Cosmos-backed CRUD (no Fabric dependency).
 *
 *   GET    /api/items/azure-sql-database/[id]/queries
 *            → { ok, callerRole, queries: SavedQuery[] }
 *            Returns the caller's own private queries always, plus the
 *            workspace's shared queries when the caller is Admin/Member/
 *            Contributor (Viewers + non-members never see shared).
 *
 *   POST   /api/items/azure-sql-database/[id]/queries
 *            body { queryId?, name, description?, sql, scope }
 *            Upsert.  Create when queryId is absent; update when present
 *            (owner or workspace Admin only).  scope='shared' requires
 *            Admin/Member/Contributor (Viewer → 403).
 *
 *   DELETE /api/items/azure-sql-database/[id]/queries
 *            body { queryIds: string[] }   ← bulk delete
 *            → { ok, deleted, before, after }
 *            Deletes exactly the caller-permitted rows (own queries, or any
 *            row when the caller is workspace Admin) via Cosmos bulk ops.
 *
 * Authorization model: workspaces are partitioned by /tenantId == the creating
 * user's oid, so a *second* workspace member has a different oid and is NOT the
 * "owner".  Cross-member sharing is resolved through the workspace-roles store
 * (resolveEffectiveRole).  The creator is treated as Admin; everyone else gets
 * the role granted to them (or via their Entra groups).  No real-Fabric path.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer, savedQueriesContainer } from '@/lib/azure/cosmos-client';
import { resolveEffectiveRole } from '@/lib/azure/workspace-roles-client';
import type { WorkspaceRoleName } from '@/lib/azure/workspace-role-model';
import { BulkOperationType } from '@azure/cosmos';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'azure-sql-database';
const MAX_SQL = 65_536;
const MAX_BULK = 100;

/** Roles that may SEE shared queries. Viewers and non-members are excluded. */
const CAN_SEE_SHARED = new Set<WorkspaceRoleName>(['Admin', 'Member', 'Contributor']);
/** Roles that may CREATE / UPDATE a shared query. Same set as visibility. */
const CAN_WRITE_SHARED = new Set<WorkspaceRoleName>(['Admin', 'Member', 'Contributor']);

export interface SavedQuery {
  id: string;            // 'sq:<uuid>' — partition companion
  itemId: string;        // PK — the azure-sql-database Loom item id
  workspaceId: string;   // owning workspace — drives shared-query RBAC
  scope: 'private' | 'shared';
  ownerId: string;       // creator oid — scopes private reads + delete authz
  name: string;
  description?: string;
  sql: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;     // upn/email/oid for the audit trail
}

/**
 * Resolve the workspaceId for a given item id (cross-partition by id+type).
 * No tenant gate here — authorization is layered on top via the workspace role
 * so a second member (different oid) can still reach a shared query.
 */
async function resolveItemWorkspace(itemId: string): Promise<string | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ workspaceId: string }>({
      query: 'SELECT c.workspaceId FROM c WHERE c.id = @i AND c.itemType = @t',
      parameters: [{ name: '@i', value: itemId }, { name: '@t', value: ITEM_TYPE }],
    })
    .fetchAll();
  return resources[0]?.workspaceId ?? null;
}

/**
 * Effective workspace role for the caller on a workspace.
 * - The creator (workspace.tenantId === caller oid) is Admin.
 * - Otherwise the role is resolved from the workspace-roles store (direct or
 *   via the caller's transitive Entra groups).
 * Returns null when the caller has no relationship to the workspace.
 */
async function effectiveRole(session: SessionPayload, workspaceId: string): Promise<WorkspaceRoleName | null> {
  const oid = session.claims.oid;
  const ws = await workspacesContainer();
  const { resources } = await ws.items
    .query<{ tenantId: string }>({
      query: 'SELECT c.tenantId FROM c WHERE c.id = @w',
      parameters: [{ name: '@w', value: workspaceId }],
    })
    .fetchAll();
  if (resources[0]?.tenantId === oid) return 'Admin';
  return resolveEffectiveRole(oid, workspaceId, { userGroupIds: session.claims.groups });
}

function unauth() {
  return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
}

// ---------------------------------------------------------------------------
// GET — list the caller's private queries + (when permitted) shared queries.
// ---------------------------------------------------------------------------
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return unauth();
  const { id } = await ctx.params;

  const workspaceId = await resolveItemWorkspace(id);
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });

  const role = await effectiveRole(s, workspaceId);
  if (!role) return NextResponse.json({ ok: false, error: 'not a member of this workspace' }, { status: 403 });

  const c = await savedQueriesContainer();
  const { resources } = await c.items
    .query<SavedQuery>({
      query: 'SELECT * FROM c WHERE c.itemId = @i ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@i', value: id }],
    }, { partitionKey: id })
    .fetchAll();

  const mine = resources.filter((q) => q.scope === 'private' && q.ownerId === s.claims.oid);
  const shared = CAN_SEE_SHARED.has(role) ? resources.filter((q) => q.scope === 'shared') : [];
  return NextResponse.json({ ok: true, callerRole: role, queries: [...mine, ...shared] });
}

// ---------------------------------------------------------------------------
// POST — create or update a saved query (upsert by queryId).
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return unauth();
  const { id } = await ctx.params;

  const workspaceId = await resolveItemWorkspace(id);
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });

  const role = await effectiveRole(s, workspaceId);
  if (!role) return NextResponse.json({ ok: false, error: 'not a member of this workspace' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const queryId = typeof body?.queryId === 'string' ? body.queryId : undefined;
  const name = String(body?.name || '').trim();
  const description = typeof body?.description === 'string' ? body.description.trim() : undefined;
  const sql = typeof body?.sql === 'string' ? body.sql : '';
  const scope = body?.scope === 'shared' ? 'shared' : body?.scope === 'private' ? 'private' : null;

  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!sql.trim()) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });
  if (sql.length > MAX_SQL) return NextResponse.json({ ok: false, error: 'sql too large (>64KB)' }, { status: 413 });
  if (!scope) return NextResponse.json({ ok: false, error: 'scope must be private or shared' }, { status: 400 });
  if (scope === 'shared' && !CAN_WRITE_SHARED.has(role)) {
    return NextResponse.json({ ok: false, error: 'Viewer role cannot create shared queries' }, { status: 403 });
  }

  const now = new Date().toISOString();
  const c = await savedQueriesContainer();

  if (queryId) {
    let existing: SavedQuery | undefined;
    try {
      const { resource } = await c.item(queryId, id).read<SavedQuery>();
      existing = resource ?? undefined;
    } catch (e: any) {
      if (e?.code !== 404) throw e;
    }
    if (!existing) return NextResponse.json({ ok: false, error: 'query not found' }, { status: 404 });
    if (existing.ownerId !== s.claims.oid && role !== 'Admin') {
      return NextResponse.json({ ok: false, error: 'not authorized to modify this query' }, { status: 403 });
    }
    const updated: SavedQuery = {
      ...existing,
      name: name.slice(0, 120),
      description: description?.slice(0, 500) || undefined,
      sql,
      scope,
      updatedAt: now,
    };
    const { resource } = await c.items.upsert<SavedQuery>(updated);
    return NextResponse.json({ ok: true, query: resource });
  }

  const doc: SavedQuery = {
    id: `sq:${crypto.randomUUID()}`,
    itemId: id,
    workspaceId,
    scope,
    ownerId: s.claims.oid,
    name: name.slice(0, 120),
    description: description?.slice(0, 500) || undefined,
    sql,
    createdAt: now,
    updatedAt: now,
    createdBy: s.claims.upn || s.claims.email || s.claims.oid,
  };
  const { resource } = await c.items.create<SavedQuery>(doc);
  return NextResponse.json({ ok: true, query: resource }, { status: 201 });
}

// ---------------------------------------------------------------------------
// DELETE — bulk delete the selected queries. Receipt: { deleted, before, after }.
// ---------------------------------------------------------------------------
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return unauth();
  const { id } = await ctx.params;

  const workspaceId = await resolveItemWorkspace(id);
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });

  const role = await effectiveRole(s, workspaceId);
  if (!role) return NextResponse.json({ ok: false, error: 'not a member of this workspace' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const queryIds: string[] = Array.isArray(body?.queryIds)
    ? body.queryIds.filter((x: unknown) => typeof x === 'string')
    : [];
  if (queryIds.length === 0) return NextResponse.json({ ok: false, error: 'queryIds array required' }, { status: 400 });
  if (queryIds.length > MAX_BULK) {
    return NextResponse.json({ ok: false, error: `max ${MAX_BULK} queryIds per bulk delete` }, { status: 400 });
  }

  const c = await savedQueriesContainer();

  // Load the targeted docs (single-partition read) to authorize each one.
  const { resources: targeted } = await c.items
    .query<Pick<SavedQuery, 'id' | 'ownerId'>>({
      query: 'SELECT c.id, c.ownerId FROM c WHERE c.itemId = @i AND ARRAY_CONTAINS(@ids, c.id)',
      parameters: [{ name: '@i', value: id }, { name: '@ids', value: queryIds }],
    }, { partitionKey: id })
    .fetchAll();

  // Count of rows in the partition BEFORE the delete (receipt evidence).
  const { resources: beforeRows } = await c.items
    .query<{ id: string }>({
      query: 'SELECT c.id FROM c WHERE c.itemId = @i',
      parameters: [{ name: '@i', value: id }],
    }, { partitionKey: id })
    .fetchAll();
  const before = beforeRows.length;

  const permitted = targeted.filter((q) => q.ownerId === s.claims.oid || role === 'Admin');
  if (permitted.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'none of the selected queries can be deleted by this caller', before, after: before },
      { status: 403 },
    );
  }

  const ops = permitted.map((q) => ({
    operationType: BulkOperationType.Delete as const,
    id: q.id,
    partitionKey: id,
  }));
  await c.items.executeBulkOperations(ops);

  const { resources: afterRows } = await c.items
    .query<{ id: string }>({
      query: 'SELECT c.id FROM c WHERE c.itemId = @i',
      parameters: [{ name: '@i', value: id }],
    }, { partitionKey: id })
    .fetchAll();

  return NextResponse.json({ ok: true, deleted: permitted.length, before, after: afterRows.length });
}
