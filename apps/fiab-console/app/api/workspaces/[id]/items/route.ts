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
    if (!resource || resource.tenantId !== tenantId) return null;
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
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT * FROM c WHERE c.workspaceId = @w ORDER BY c.createdAt DESC',
        parameters: [{ name: '@w', value: ws.id }],
      }, { partitionKey: ws.id })
      .fetchAll();
    return NextResponse.json(resources);
  } catch (e: any) {
    return err(e?.message || 'Failed to list items', 500, 'cosmos_error');
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  const { itemType, displayName, description } = body || {};
  if (!itemType || typeof itemType !== 'string') return err('itemType is required', 400, 'missing_itemType');
  if (!displayName || typeof displayName !== 'string') return err('displayName is required', 400, 'missing_displayName');

  try {
    const ws = await loadWorkspace(params.id, session.claims.oid);
    if (!ws) return err('Workspace not found', 404, 'not_found');
    const now = new Date().toISOString();
    const item: WorkspaceItem = {
      id: crypto.randomUUID(),
      workspaceId: ws.id,
      itemType,
      displayName: displayName.trim(),
      description: description?.trim() || undefined,
      state: {},
      createdBy: session.claims.upn || session.claims.email || session.claims.oid,
      createdAt: now,
      updatedAt: now,
    };
    const items = await itemsContainer();
    const { resource } = await items.items.create<WorkspaceItem>(item);
    return NextResponse.json(resource, { status: 201 });
  } catch (e: any) {
    return err(e?.message || 'Failed to create item', 500, 'cosmos_error');
  }
}
