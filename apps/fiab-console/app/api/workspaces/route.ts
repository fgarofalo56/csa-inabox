import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, docForWorkspace } from '@/lib/azure/loom-search';
import type { Workspace } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

export async function GET(_req: NextRequest) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  const tenantId = session.claims.oid;
  try {
    const c = await workspacesContainer();
    const { resources } = await c.items
      .query<Workspace>({
        query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
        parameters: [{ name: '@t', value: tenantId }],
      }, { partitionKey: tenantId })
      .fetchAll();
    return NextResponse.json(resources);
  } catch (e: any) {
    return err(e?.message || 'Failed to list workspaces', 500, 'cosmos_error');
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  const { name, description, capacity, domain } = body || {};
  if (!name || typeof name !== 'string') return err('name is required', 400, 'missing_name');

  const now = new Date().toISOString();
  const ws: Workspace = {
    id: crypto.randomUUID(),
    tenantId: session.claims.oid,
    name: name.trim(),
    description: description?.trim() || undefined,
    capacity: capacity?.trim() || undefined,
    domain: domain?.trim() || undefined,
    createdBy: session.claims.upn || session.claims.email || session.claims.oid,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const c = await workspacesContainer();
    const { resource } = await c.items.create<Workspace>(ws);
    if (resource) void upsertLoomDoc(docForWorkspace(resource));
    return NextResponse.json(resource, { status: 201 });
  } catch (e: any) {
    return err(e?.message || 'Failed to create workspace', 500, 'cosmos_error');
  }
}
