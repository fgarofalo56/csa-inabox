/**
 * Notifications inbox. Loom backend (or scheduled jobs) writes notifications
 * keyed to /userId. UI reads + marks read.
 *
 * GET    /api/notifications              → { ok, unread, notifications:[...] }
 * PATCH  /api/notifications              → body {id, read:true}; marks read
 * POST   /api/notifications  (internal)  → body {userId, title, body, severity, link}
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { notificationsContainer } from '@/lib/azure/cosmos-client';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const c = await notificationsContainer();
  const { resources } = await c.items
    .query({
      query: 'SELECT TOP 50 * FROM c WHERE c.userId = @u ORDER BY c._ts DESC',
      parameters: [{ name: '@u', value: s.claims.oid }],
    })
    .fetchAll();
  const unread = (resources as any[]).filter((n) => !n.read).length;
  return NextResponse.json({ ok: true, unread, notifications: resources });
}

export async function PATCH(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  const c = await notificationsContainer();
  try {
    const { resource } = await c.item(body.id, s.claims.oid).read<any>();
    if (!resource || resource.userId !== s.claims.oid)
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    resource.read = true;
    resource.readAt = new Date().toISOString();
    await c.item(body.id, s.claims.oid).replace(resource);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    throw e;
  }
}

// Internal write — also reachable by the same user for self-test.
export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.title) return NextResponse.json({ ok: false, error: 'title required' }, { status: 400 });
  const userId = body.userId || s.claims.oid;
  const c = await notificationsContainer();
  const doc = {
    id: crypto.randomUUID(),
    userId,
    title: body.title,
    body: body.body || '',
    severity: body.severity || 'info',
    link: body.link || null,
    read: false,
    createdAt: new Date().toISOString(),
  };
  const { resource } = await c.items.create(doc);
  return NextResponse.json({ ok: true, notification: resource }, { status: 201 });
}
