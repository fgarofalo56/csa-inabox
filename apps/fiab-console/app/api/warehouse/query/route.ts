/**
 * POST /api/warehouse/query  — standalone Warehouse pane query execution.
 *
 * Fabric "Warehouse" is implemented in Loom by the Synapse Dedicated SQL pool.
 * This was previously a STUB that echoed the SQL back as a fake row ("Real
 * query dispatch wires up in v1.1") — a no-vaporware grade-D surface. It now
 * runs the SAME real path as the warehouse editor's /api/items/warehouse/[id]/
 * query route: synapse-sql-client.executeQuery against the dedicated pool, with
 * a pool-online check and an honest config gate when Synapse isn't provisioned.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
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
      { ok: false, error: `Warehouse compute is ${state.state}. Resume it from the Dedicated SQL pool editor before running queries.`, state: state.state, sku: state.sku },
      { status: 409 },
    );
  }

  try {
    const result = await executeQuery(target, sqlText);
    // Shape: { columns, rows, rowCount } — what the Warehouse pane renders.
    return NextResponse.json({
      ok: true,
      ...result,
      engine: 'synapse-dedicated',
      warehouse: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
      sku: state?.sku || 'unknown',
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code, sqlNumber: e?.number },
      { status: 502 },
    );
  }
}
