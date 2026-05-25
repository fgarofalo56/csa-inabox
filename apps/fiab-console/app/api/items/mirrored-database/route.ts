/**
 * Mirrored Database (Fabric) list + create.
 * GET  /api/items/mirrored-database?workspaceId=...
 * POST /api/items/mirrored-database?workspaceId=...
 *   body: { displayName, description?, definition? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listMirroredDatabases, createMirroredDatabase, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  const status = e instanceof FabricError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), endpoint: e?.endpoint, hint: e?.hint }, { status });
}

export async function GET(req: NextRequest) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const items = await listMirroredDatabases(workspaceId);
    return NextResponse.json({ ok: true, workspaceId, mirroredDatabases: items });
  } catch (e) { return err(e); }
}

export async function POST(req: NextRequest) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  if (!body?.displayName) return NextResponse.json({ ok: false, error: 'displayName required' }, { status: 400 });
  try {
    const item = await createMirroredDatabase(workspaceId, body);
    return NextResponse.json({ ok: true, mirroredDatabase: item });
  } catch (e) { return err(e); }
}
