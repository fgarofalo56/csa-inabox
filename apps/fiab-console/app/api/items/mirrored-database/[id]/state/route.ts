/**
 * POST /api/items/mirrored-database/[id]/state?workspaceId=...
 *   body: { action: 'start' | 'stop' }
 *   Drives /startMirroring + /stopMirroring on the Fabric Mirroring API.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { startMirroredDatabase, stopMirroredDatabase, getMirroringStatus, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  if (action !== 'start' && action !== 'stop') {
    return NextResponse.json({ ok: false, error: "action must be 'start' or 'stop'" }, { status: 400 });
  }
  try {
    if (action === 'start') await startMirroredDatabase(workspaceId, ctx.params.id);
    else await stopMirroredDatabase(workspaceId, ctx.params.id);
    // Poll status once so the UI sees the post-action state immediately.
    const status = await getMirroringStatus(workspaceId, ctx.params.id).catch(() => null);
    return NextResponse.json({ ok: true, action, status });
  } catch (e: any) {
    const status = e instanceof FabricError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), endpoint: e?.endpoint, hint: e?.hint }, { status });
  }
}
