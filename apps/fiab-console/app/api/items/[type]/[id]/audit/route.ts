/**
 * GET /api/items/[type]/[id]/audit — audit log entries for an item.
 * POST is server-internal (called when items are PATCHed). Surfaced here for
 * smoke testing only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer, itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function assertOwnedItem(itemId: string, itemType: string, tenantId: string) {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query({
      query: 'SELECT * FROM c WHERE c.id = @i AND c.itemType = @t',
      parameters: [
        { name: '@i', value: itemId },
        { name: '@t', value: itemType },
      ],
    })
    .fetchAll();
  const item = resources[0] as any;
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<any>();
    if (!resource || resource.tenantId !== tenantId) return null;
    return item;
  } catch {
    return null;
  }
}

export async function GET(_req: NextRequest, { params }: { params: { type: string; id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const item = await assertOwnedItem(params.id, params.type, s.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const c = await auditLogContainer();
  const { resources } = await c.items
    .query({
      query: 'SELECT TOP 200 * FROM c WHERE c.itemId = @i ORDER BY c._ts DESC',
      parameters: [{ name: '@i', value: params.id }],
    })
    .fetchAll();
  return NextResponse.json({ ok: true, entries: resources });
}

export async function POST(req: NextRequest, { params }: { params: { type: string; id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const item = await assertOwnedItem(params.id, params.type, s.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const c = await auditLogContainer();
  const doc = {
    id: crypto.randomUUID(),
    itemId: params.id,
    itemType: params.type,
    workspaceId: item.workspaceId,
    userId: s.claims.oid,
    upn: s.claims.upn,
    action: body.action || 'edit',
    summary: body.summary || '',
    diff: body.diff || null,
    at: new Date().toISOString(),
  };
  const { resource } = await c.items.create(doc);
  return NextResponse.json({ ok: true, entry: resource }, { status: 201 });
}
