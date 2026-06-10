/**
 * POST /api/warehouse/explain  — standalone Warehouse pane explain plan.
 *
 * Returns the estimated execution plan for a T-SQL statement against the
 * Synapse Dedicated SQL pool (the Loom-native Warehouse backend — NO Microsoft
 * Fabric required). Runs `EXPLAIN WITH_RECOMMENDATIONS <sql>` via the same real
 * TDS path as the query route (synapse-sql-client.explainQuery), with a
 * pool-online check and an honest config gate when Synapse isn't provisioned.
 *
 * This is the SSMS "Display Estimated Execution Plan" parity for the /warehouse
 * pane's Explain plan tab — distinct from Copilot's optimize path.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget, explainQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sqlText = (body?.sql || '').toString().trim();
  if (!sqlText) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ ok: false, error: 'sql too large (>64KB)' }, { status: 413 });

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
      { ok: false, error: `Warehouse compute is ${state.state}. Resume it from the Dedicated SQL pool editor before generating a plan.`, state: state.state, sku: state.sku },
      { status: 409 },
    );
  }

  try {
    const planXml = await explainQuery(target, sqlText, true);
    return NextResponse.json({ ok: true, planXml, engine: 'synapse-dedicated' });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code, sqlNumber: e?.number },
      { status: 502 },
    );
  }
}
