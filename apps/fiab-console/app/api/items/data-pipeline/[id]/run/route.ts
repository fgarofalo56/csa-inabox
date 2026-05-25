/**
 * POST /api/items/data-pipeline/[id]/run?workspaceId=...
 *   body: { parameters?: Record<string, unknown> }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { runDataPipeline, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  try {
    const res = await runDataPipeline(workspaceId, ctx.params.id, body);
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    const status = e instanceof FabricError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), endpoint: e?.endpoint, hint: e?.hint }, { status });
  }
}
