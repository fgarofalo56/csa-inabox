/**
 * POST /api/items/databricks-notebook/[id]/run
 *   body { path, clusterId, params?: Record<string,string>, runName? }
 *   → { ok, run_id }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { runNotebook } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const path = (body?.path || '').toString().trim();
  const clusterId = (body?.clusterId || '').toString().trim();
  if (!path) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  if (!clusterId)
    return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });
  try {
    const r = await runNotebook(path, clusterId, body?.params, body?.runName);
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
