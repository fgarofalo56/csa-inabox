/**
 * Mirrored Database list + create. Cosmos-backed in v3.25; the mirroring
 * engine itself is the loom-mirroring-engine container app (existing).
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError, apiServerError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { mirrorBindingMismatch } from '@/lib/azure/connection-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// NOTE — this owner-only `loadWs()` is the idiom #2947 removed elsewhere: it
// answers "did you CREATE this workspace", never "may you ACCESS it", so a
// tenant admin or a shared member gets a 404 on their own workspace. Replacing
// it with the canonical `authorizeWorkspace()` ladder is a WIDENING of who can
// reach this route — a security-surface change that needs its own test and its
// own review, not a ride inside a P0 mirroring hotfix. Tracked separately; left
// exactly as it was so this PR changes no authorization behaviour at all.
async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return apiError('workspace not found', 404);
    const items = await itemsContainer();
    const { resources } = await items.items.query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'mirrored-database' }],
    }, { partitionKey: workspaceId }).fetchAll();
    return NextResponse.json({
      ok: true, workspaceId,
      mirroredDatabases: resources.map(r => ({
        id: r.id, displayName: r.displayName, description: r.description,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
      })),
    });
  } catch (e: any) { return apiServerError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  if (!displayName) return apiError('displayName required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return apiError('workspace not found', 404);
    const items = await itemsContainer();
    const now = new Date().toISOString();
    // Persist the source config in a flat, engine-readable shape (sourceType +
    // server/database + connectionId + optional table subset) so Start can run
    // the Azure-native mirror without re-deriving everything from definition.
    const definition = body?.definition || {};
    const srcProps = definition?.properties?.source?.typeProperties || {};
    const sourceType = body?.sourceType || definition?.properties?.source?.type || '';
    // A mirror is never CREATED with a source type that contradicts its
    // connection. Refused here rather than left for Start to discover, so the
    // bad binding never reaches Cosmos in the first place.
    {
      const mismatch = await mirrorBindingMismatch(s.claims.oid, sourceType, body?.connectionId || undefined);
      if (mismatch) return apiError(mismatch.message, 400);
    }
    const item: WorkspaceItem = {
      id: crypto.randomUUID(), workspaceId, itemType: 'mirrored-database',
      displayName, description: body?.description,
      state: {
        definition,
        sourceType,
        server: body?.server || srcProps.server || '',
        database: body?.database || srcProps.database || '',
        connectionId: body?.connectionId || undefined,
        tables: Array.isArray(body?.tables) ? body.tables : [],
        // Snowflake-only: also mirror Snowflake-managed Iceberg tables.
        includeIcebergTables: !!body?.includeIcebergTables,
        // Ongoing-replication mode (snapshot | incremental | continuous) — consumed
        // by the engine to pick snapshot vs. watermark-incremental vs. ADF CDC/copy.
        syncMode: body?.syncMode || srcProps.syncMode || undefined,
        // Source-specific fields surfaced by the wizard for BigQuery (projectId)
        // and Oracle (serviceName + on-prem data gateway/SHIR + syncUser). Stored
        // flat so Start/edit/monitor read them without re-parsing the definition.
        projectId: body?.projectId || srcProps.projectId || undefined,
        serviceName: body?.serviceName || srcProps.serviceName || undefined,
        gateway: body?.gateway || srcProps.gateway || undefined,
        syncUser: body?.syncUser || srcProps.syncUser || undefined,
        mirroringStatus: 'NotStarted',
      },
      createdBy: s.claims.upn || s.claims.email || s.claims.oid,
      createdAt: now, updatedAt: now,
    };
    const { resource } = await items.items.create(item);
    return NextResponse.json({ ok: true, mirroredDatabase: resource });
  } catch (e: any) { return apiServerError(e); }
}
