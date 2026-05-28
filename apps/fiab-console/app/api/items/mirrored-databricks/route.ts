/**
 * Mirrored Databricks list + create.
 *
 * The Fabric REST type is MirroredAzureDatabricksCatalog. Loom persists the
 * mount config (UC catalog name + Databricks workspace hostname) into Cosmos
 * and surfaces live UC metadata to the editor via the [id]/catalog route.
 *
 * Per .claude/rules/no-vaporware.md the editor exposes either a real
 * Databricks UC listing or an honest MessageBar if LOOM_DATABRICKS_HOSTNAME
 * is missing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(extra || {}) }, { status });
}

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
      parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'mirrored-databricks' }],
    }, { partitionKey: workspaceId }).fetchAll();
    return NextResponse.json({
      ok: true, workspaceId,
      mirrors: resources.map(r => ({
        id: r.id, displayName: r.displayName, description: r.description,
        catalogName: (r.state as any)?.catalogName,
        hostname: (r.state as any)?.hostname,
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
  const catalogName = String(body?.catalogName || '').trim();
  if (!displayName) return err('displayName required', 400);
  if (!catalogName) return err('catalogName required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const items = await itemsContainer();
    const now = new Date().toISOString();
    const item: WorkspaceItem = {
      id: crypto.randomUUID(), workspaceId, itemType: 'mirrored-databricks',
      displayName, description: body?.description,
      state: {
        catalogName,
        hostname: body?.hostname || process.env.LOOM_DATABRICKS_HOSTNAME || null,
        mirrorMode: body?.mirrorMode || 'AllTables',
      },
      createdBy: s.claims.upn || s.claims.email || s.claims.oid,
      createdAt: now, updatedAt: now,
    };
    const { resource } = await items.items.create(item);
    return NextResponse.json({ ok: true, mirror: resource });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}
