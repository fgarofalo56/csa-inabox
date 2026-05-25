/**
 * Mirrored Database (Fabric) detail.
 * GET    /api/items/mirrored-database/[id]?workspaceId=...   — metadata + definition + mirroring status + tables status
 * DELETE /api/items/mirrored-database/[id]?workspaceId=...
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getMirroredDatabase, getMirroredDatabaseDefinition, getMirroringStatus,
  getTablesMirroringStatus, deleteMirroredDatabase, FabricError,
} from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  const status = e instanceof FabricError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), endpoint: e?.endpoint, hint: e?.hint }, { status });
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const [item, definition, status, tables] = await Promise.all([
      getMirroredDatabase(workspaceId, ctx.params.id),
      getMirroredDatabaseDefinition(workspaceId, ctx.params.id).catch(() => null),
      getMirroringStatus(workspaceId, ctx.params.id).catch((e) => ({ error: e?.message || String(e) })),
      getTablesMirroringStatus(workspaceId, ctx.params.id).catch(() => null),
    ]);
    return NextResponse.json({ ok: true, mirroredDatabase: item, definition, status, tables });
  } catch (e) { return err(e); }
}

export async function DELETE(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    await deleteMirroredDatabase(workspaceId, ctx.params.id);
    return NextResponse.json({ ok: true });
  } catch (e) { return err(e); }
}
