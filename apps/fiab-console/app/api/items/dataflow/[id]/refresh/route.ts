/**
 * POST /api/items/dataflow/[id]/refresh?workspaceId=...
 *   Refresh (run) a Dataflow Gen2.
 *
 * Azure-native, no Fabric: compiles the saved Power Query (M) into an ADF
 * WranglingDataFlow and runs it on ADF Spark via an ExecuteWranglingDataflow
 * activity, writing the output query to the configured ADLS / Azure SQL
 * destination. Returns the ADF runId. Per no-fabric-dependency.md this is the
 * only backend — no Fabric capacity or workspace is required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { runDataflowAdf } from '@/lib/azure/dataflow-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const { id } = await ctx.params;

  try {
    const result = await runDataflowAdf(id, workspaceId);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error, ...(result.hint ? { hint: result.hint } : {}) },
        { status: result.status },
      );
    }
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
