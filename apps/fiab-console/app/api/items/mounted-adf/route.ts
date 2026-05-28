/**
 * Mounted ADF list + create.
 *
 * A Loom "Mounted Data Factory" item stores a reference (subscriptionId,
 * resourceGroup, factoryName) so Loom can drive an existing ADF's pipelines
 * without copying them into Fabric. Detail routes call ARM REST against the
 * referenced factory.
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
      parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'mounted-adf' }],
    }, { partitionKey: workspaceId }).fetchAll();
    return NextResponse.json({
      ok: true, workspaceId,
      mounts: resources.map(r => ({
        id: r.id, displayName: r.displayName, description: r.description,
        subscriptionId: (r.state as any)?.subscriptionId,
        resourceGroup: (r.state as any)?.resourceGroup,
        factoryName: (r.state as any)?.factoryName,
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
  const subscriptionId = String(body?.subscriptionId || '').trim();
  const resourceGroup = String(body?.resourceGroup || '').trim();
  const factoryName = String(body?.factoryName || '').trim();
  if (!displayName) return err('displayName required', 400);
  if (!subscriptionId) return err('subscriptionId required', 400);
  if (!resourceGroup) return err('resourceGroup required', 400);
  if (!factoryName) return err('factoryName required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const items = await itemsContainer();
    const now = new Date().toISOString();
    const item: WorkspaceItem = {
      id: crypto.randomUUID(), workspaceId, itemType: 'mounted-adf',
      displayName, description: body?.description,
      state: { subscriptionId, resourceGroup, factoryName },
      createdBy: s.claims.upn || s.claims.email || s.claims.oid,
      createdAt: now, updatedAt: now,
    };
    const { resource } = await items.items.create(item);
    return NextResponse.json({ ok: true, mount: resource });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}
