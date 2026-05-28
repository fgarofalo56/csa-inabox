/**
 * Fabric SQL Database detail / delete.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  getFabricSqlDatabase, deleteFabricSqlDatabase,
} from '@/lib/azure/fabric-client';
import type { Workspace } from '@/lib/types/workspace';

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

function fabricWsIdOf(ws: Workspace | null): string | null {
  if (!ws) return null;
  const cap: any = (ws as any).capacity;
  return cap?.fabricWorkspaceId || cap?.id || null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const fabricWs = fabricWsIdOf(ws);
    if (!fabricWs) return err('Fabric workspace not attached', 503, { code: 'NO_FABRIC_WS' });
    const value = await getFabricSqlDatabase(fabricWs, (await ctx.params).id);
    return NextResponse.json({ ok: true, sqlDatabase: value });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 500, e?.hint ? { hint: e.hint } : undefined);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const fabricWs = fabricWsIdOf(ws);
    if (!fabricWs) return err('Fabric workspace not attached', 503, { code: 'NO_FABRIC_WS' });
    await deleteFabricSqlDatabase(fabricWs, (await ctx.params).id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 500, e?.hint ? { hint: e.hint } : undefined);
  }
}
