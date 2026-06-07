/**
 * POST /api/items/dataflow/[id]/refresh?workspaceId=...
 *   Refresh (run) a Dataflow Gen2.
 *
 * DEFAULT (Azure-native, no Fabric): compiles the saved Power Query (M) into
 * an ADF WranglingDataFlow and runs it on ADF Spark via an
 * ExecuteWranglingDataflow activity, writing the output query to the
 * configured ADLS / Azure SQL destination. Returns the ADF runId.
 *
 * OPT-IN (Fabric): only when LOOM_DATAFLOW_BACKEND=fabric AND a bound
 * LOOM_DEFAULT_FABRIC_WORKSPACE — otherwise this branch is never taken. Per
 * no-fabric-dependency.md the Azure path is the silent default.
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

  const backend = process.env.LOOM_DATAFLOW_BACKEND || 'adf';

  if (backend === 'fabric') {
    // Opt-in Fabric path — requires a bound workspace. Honest gate otherwise.
    if (!process.env.LOOM_DEFAULT_FABRIC_WORKSPACE) {
      return NextResponse.json({
        ok: false,
        error: 'LOOM_DATAFLOW_BACKEND=fabric is set but no Fabric workspace is bound.',
        hint: 'Bind LOOM_DEFAULT_FABRIC_WORKSPACE, or unset LOOM_DATAFLOW_BACKEND to use the default Azure-native ADF backend.',
      }, { status: 503 });
    }
    return NextResponse.json({
      ok: false,
      error: 'The Fabric refresh backend is opt-in and not wired in this build.',
      hint: 'Unset LOOM_DATAFLOW_BACKEND to run on the default Azure-native ADF backend (no Fabric required).',
    }, { status: 503 });
  }

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
