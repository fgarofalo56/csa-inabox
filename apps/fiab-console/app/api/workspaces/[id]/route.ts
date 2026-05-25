import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

async function loadWorkspace(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    if (!resource) return null;
    if (resource.tenantId !== tenantId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const ws = await loadWorkspace(params.id, session.claims.oid);
    if (!ws) return err('Workspace not found', 404, 'not_found');
    return NextResponse.json(ws);
  } catch (e: any) {
    return err(e?.message || 'Failed to fetch workspace', 500, 'cosmos_error');
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  try {
    const ws = await loadWorkspace(params.id, session.claims.oid);
    if (!ws) return err('Workspace not found', 404, 'not_found');
    const next: Workspace = {
      ...ws,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : ws.name,
      description: 'description' in body ? (body.description?.trim() || undefined) : ws.description,
      capacity: 'capacity' in body ? (body.capacity?.trim() || undefined) : ws.capacity,
      domain: 'domain' in body ? (body.domain?.trim() || undefined) : ws.domain,
      updatedAt: new Date().toISOString(),
    };
    const c = await workspacesContainer();
    const { resource } = await c.item(ws.id, ws.tenantId).replace<Workspace>(next);
    return NextResponse.json(resource);
  } catch (e: any) {
    return err(e?.message || 'Failed to update workspace', 500, 'cosmos_error');
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const ws = await loadWorkspace(params.id, session.claims.oid);
    if (!ws) return err('Workspace not found', 404, 'not_found');
    // Cascade delete items first
    const items = await itemsContainer();
    const { resources: children } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT c.id, c.workspaceId FROM c WHERE c.workspaceId = @w',
        parameters: [{ name: '@w', value: ws.id }],
      }, { partitionKey: ws.id })
      .fetchAll();
    for (const child of children) {
      await items.item(child.id, ws.id).delete().catch(() => {});
    }
    const wsContainer = await workspacesContainer();
    await wsContainer.item(ws.id, ws.tenantId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || 'Failed to delete workspace', 500, 'cosmos_error');
  }
}
