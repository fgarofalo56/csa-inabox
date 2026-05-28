/**
 * Share links for an item. Generates a signed token; viewer endpoint validates
 * the token + grants read-only access.
 *
 * POST   /api/items/[type]/[id]/share  body {expiresInHours?, scope?:'read'|'comment'}
 *        → { ok, url, token, expiresAt }
 * GET    /api/items/[type]/[id]/share  → existing shares for this item
 * DELETE /api/items/[type]/[id]/share?token=... → revoke
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { sharesContainer, itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function assertOwnedItem(itemId: string, itemType: string, tenantId: string) {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query({
      query: 'SELECT * FROM c WHERE c.id = @i AND c.itemType = @t',
      parameters: [{ name: '@i', value: itemId }, { name: '@t', value: itemType }],
    })
    .fetchAll();
  const item = resources[0] as any;
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<any>();
    return resource && resource.tenantId === tenantId ? item : null;
  } catch {
    return null;
  }
}

function origin(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ type: string; id: string }> }
) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedItem(params.id, params.type, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const c = await sharesContainer();
  const { resources } = await c.items
    .query({
      query: 'SELECT * FROM c WHERE c.itemId = @i ORDER BY c._ts DESC',
      parameters: [{ name: '@i', value: params.id }],
    })
    .fetchAll();
  return NextResponse.json({ ok: true, shares: resources });
}

export async function POST(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedItem(params.id, params.type, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const hours = Math.max(1, Math.min(24 * 30, Number(body?.expiresInHours) || 24));
  const scope = body?.scope === 'comment' ? 'comment' : 'read';
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
  const c = await sharesContainer();
  const doc = {
    id: token,
    itemId: params.id,
    itemType: params.type,
    token,
    scope,
    createdBy: s.claims.upn,
    createdAt: new Date().toISOString(),
    expiresAt,
  };
  await c.items.create(doc);
  const url = `${origin(req)}/share/${params.type}/${params.id}?token=${token}`;
  return NextResponse.json({ ok: true, url, token, expiresAt, scope }, { status: 201 });
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedItem(params.id, params.type, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const token = new URL(req.url).searchParams.get('token');
  if (!token) return NextResponse.json({ ok: false, error: 'token required' }, { status: 400 });
  const c = await sharesContainer();
  try {
    await c.item(token, params.id).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return NextResponse.json({ ok: true });
}
