/**
 * GET /api/items/notebook/[id]/jobs?workspaceId=...
 *   Returns recent job instances (run history) for this notebook.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listJobInstances, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const jobs = await listJobInstances(workspaceId, (await ctx.params).id);
    return NextResponse.json({ ok: true, jobs });
  } catch (e: any) {
    const status = e instanceof FabricError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), endpoint: e?.endpoint, hint: e?.hint }, { status });
  }
}
