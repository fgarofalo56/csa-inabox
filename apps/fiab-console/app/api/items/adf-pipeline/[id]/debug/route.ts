/**
 * POST /api/items/adf-pipeline/[id]/debug — debug-run a pipeline.
 * body: { params?: { ... } }
 *
 * Maps to ADF createRun (isRecovery=false) via adf-client.debugPipeline so
 * the run surfaces under the Debug invocation in run history. Real ARM REST.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { debugPipeline } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    const res = await debugPipeline((await ctx.params).id, body?.params || {});
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
