/**
 * User preferences key/value store backed by Cosmos `user-prefs` (PK /userId).
 * GET    /api/user-prefs?key=foo  → { ok, value }
 * GET    /api/user-prefs          → { ok, prefs:{...all keys for user} }
 * POST   /api/user-prefs          → body {key,value}; upserts
 * DELETE /api/user-prefs?key=foo  → removes one key
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { userPrefsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function id(userId: string, key: string) {
  return `${userId}:${key}`;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const userId = s.claims.oid;
  const key = new URL(req.url).searchParams.get('key');
  const c = await userPrefsContainer();
  if (key) {
    try {
      const { resource } = await c.item(id(userId, key), userId).read<{ value: unknown }>();
      return NextResponse.json({ ok: true, value: resource?.value ?? null });
    } catch (e: any) {
      if (e?.code === 404) return NextResponse.json({ ok: true, value: null });
      throw e;
    }
  }
  const { resources } = await c.items
    .query({ query: 'SELECT * FROM c WHERE c.userId = @u', parameters: [{ name: '@u', value: userId }] })
    .fetchAll();
  const prefs: Record<string, unknown> = {};
  for (const r of resources as any[]) prefs[r.key] = r.value;
  return NextResponse.json({ ok: true, prefs });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.key) return NextResponse.json({ ok: false, error: 'key required' }, { status: 400 });
  const userId = s.claims.oid;
  const c = await userPrefsContainer();
  const doc = { id: id(userId, body.key), userId, key: body.key, value: body.value, updatedAt: new Date().toISOString() };
  await c.items.upsert(doc);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const key = new URL(req.url).searchParams.get('key');
  if (!key) return NextResponse.json({ ok: false, error: 'key required' }, { status: 400 });
  const userId = s.claims.oid;
  const c = await userPrefsContainer();
  try {
    await c.item(id(userId, key), userId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return NextResponse.json({ ok: true });
}
