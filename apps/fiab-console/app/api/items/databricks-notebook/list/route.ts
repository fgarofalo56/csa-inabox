/**
 * GET /api/items/databricks-notebook/list?path=/Workspace
 * → { ok, objects: [{ object_type, path, language }] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listWorkspace } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const path = req.nextUrl.searchParams.get('path') || '/Workspace';
  try {
    const objects = await listWorkspace(path);
    return NextResponse.json({ ok: true, path, objects });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: e?.status === 403 ? 403 : 502 },
    );
  }
}
