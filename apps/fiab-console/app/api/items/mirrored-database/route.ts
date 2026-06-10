/**
 * Mirrored Database list + create. Cosmos-backed in v3.25; the mirroring
 * engine itself is the loom-mirroring-engine container app (existing).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
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
  } catch (e: any) { return err(e?.message || String(e), 500); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  if (!displayName) return err('displayName required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const items = await itemsContainer();
    const now = new Date().toISOString();
    // Persist the source config in a flat, engine-readable shape (sourceType +
    // server/database + connectionId + optional table subset) so Start can run
    // the Azure-native mirror without re-deriving everything from definition.
    const definition = body?.definition || {};
    const srcProps = definition?.properties?.source?.typeProperties || {};
    const item: WorkspaceItem = {
      id: crypto.randomUUID(), workspaceId, itemType: 'mirrored-database',
      displayName, description: body?.description,
      state: {
        definition,
        sourceType: body?.sourceType || definition?.properties?.source?.type || '',
        server: body?.server || srcProps.server || '',
        database: body?.database || srcProps.database || '',
        connectionId: body?.connectionId || undefined,
        tables: Array.isArray(body?.tables) ? body.tables : [],
        // Snowflake-only: also mirror Snowflake-managed Iceberg tables.
        includeIcebergTables: !!body?.includeIcebergTables,
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
  } catch (e: any) { return err(e?.message || String(e), 500); }
}
