/**
 * GET /api/warehouse/history  — standalone Warehouse pane query history.
 *
 * Returns recent query requests from the live Synapse Dedicated SQL pool's
 * `sys.dm_pdw_exec_requests` DMV (the Loom-native Warehouse backend — NO
 * Microsoft Fabric required). Same real TDS path as the query route
 * (synapse-sql-client.executeQuery), with a pool-online check and an honest
 * config gate when Synapse isn't provisioned.
 *
 * This is the SSMS / Fabric Warehouse "Query insights / recent runs" parity
 * for the /warehouse pane's History tab.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { synapseRecentRequestsSql } from '@/lib/azure/warehouse-monitoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const url = new URL(req.url);
  const windowSecs = Number(url.searchParams.get('windowSecs') || '3600');

  // Resolve the dedicated-pool target. Unset env → honest config gate (no fake data).
  let target: ReturnType<typeof dedicatedTarget>;
  try {
    target = dedicatedTarget();
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Warehouse (Synapse Dedicated SQL pool) is not configured in this deployment. ' +
          'Set LOOM_SYNAPSE_WORKSPACE + LOOM_SYNAPSE_DEDICATED_POOL on the Console and grant the ' +
          'Console UAMI access on the pool. No Microsoft Fabric required.',
        gate: { reason: e?.message || String(e), missing: 'LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL' },
      },
      { status: 503 },
    );
  }

  const state = await getPoolState().catch(() => null);
  if (state && state.state !== 'Online') {
    return NextResponse.json(
      { ok: false, error: `Warehouse compute is ${state.state}. Resume it from the Dedicated SQL pool editor to view query history.`, state: state.state, sku: state.sku },
      { status: 409 },
    );
  }

  try {
    const result = await executeQuery(target, synapseRecentRequestsSql(windowSecs));
    return NextResponse.json({ ok: true, ...result, engine: 'synapse-dedicated' });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code, sqlNumber: e?.number },
      { status: 502 },
    );
  }
}
