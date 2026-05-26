/**
 * Open-tabs state per user — persists across browser sessions.
 * GET  /api/tabs    → { ok, tabs:[{type,id,name,workspaceId,openedAt}] }
 * POST /api/tabs    → body {tabs:[...]}; replaces full list
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tabsStateContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const c = await tabsStateContainer();
  try {
    const { resource } = await c.item(s.claims.oid, s.claims.oid).read<{ tabs: any[] }>();
    return NextResponse.json({ ok: true, tabs: resource?.tabs || [] });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true, tabs: [] });
    throw e;
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const tabs = Array.isArray(body?.tabs) ? body.tabs.slice(0, 50) : [];
  const c = await tabsStateContainer();
  await c.items.upsert({ id: s.claims.oid, userId: s.claims.oid, tabs, updatedAt: new Date().toISOString() });
  return NextResponse.json({ ok: true });
}
