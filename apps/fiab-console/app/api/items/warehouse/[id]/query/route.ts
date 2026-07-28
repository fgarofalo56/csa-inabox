/**
 * POST /api/items/warehouse/[id]/query
 *
 * Fabric "Warehouse" is implemented in Loom-Gov by the Synapse Dedicated
 * SQL pool. This handler is a thin wrapper around the dedicated pool
 * query path so the WarehouseEditor UI works identically.
 */

import { NextRequest, NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { withSession } from '@/lib/api/route-toolkit';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { dedicatedTarget, executeQuery, type SynapseQueryParam } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { recordQueryRun } from '@/lib/finops/query-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession(async (req: NextRequest, { session, params }) => {
  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;

  const body = await req.json().catch(() => ({}));
  const sqlText = (body?.sql || '').toString().trim();
  const queryId = (body?.queryId || '').toString().trim() || undefined;
  const database = (body?.database || '').toString().trim();
  if (!sqlText) return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ error: 'sql too large (>64KB)' }, { status: 413 });

  // Named parameters (`@name`) — bound via req.input(), NOT concatenated.
  const parameters: SynapseQueryParam[] = (Array.isArray(body?.parameters) ? body.parameters : [])
    .filter((p: any) => p && typeof p.name === 'string')
    .map((p: any) => ({ name: String(p.name), value: p.value == null ? null : String(p.value) }));

  const state = await getPoolState().catch(() => null);
  if (state && state.state !== 'Online') {
    return NextResponse.json(
      { ok: false, error: `Warehouse compute is ${state.state}. Resume via the Dedicated SQL pool editor.`, state: state.state, sku: state.sku },
      { status: 409 },
    );
  }

  const baseTarget = dedicatedTarget();
  const target = database && database !== baseTarget.database
    ? { ...baseTarget, database, cacheKey: `dedicated:${process.env.LOOM_SYNAPSE_WORKSPACE}:${database}` }
    : baseTarget;

  try {
    const started = Date.now();
    const result = await executeQuery(target, sqlText, 60_000, parameters, queryId);
    // B-N19e — FOCUS cost attribution: tag this run with WHO ran it and WHICH
    // warehouse item + workspace it belongs to (best-effort, never blocks).
    void recordQueryRun({
      tenantId: tenantScopeId(session), userOid: session.claims.oid, userName: session.claims.upn,
      engine: 'synapse-sql', statement: sqlText, durationMs: Date.now() - started,
      rowCount: (result as { rowCount?: number }).rowCount,
      queryId,
      itemId: params.id, itemType: 'warehouse',
      resourceId: target.database,
    });
    return NextResponse.json({
      ok: true,
      ...result,
      warehouse: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
      database: target.database,
      sku: state?.sku || 'unknown',
      // Receipt: the parameterized statement + bound params (values out-of-band).
      statement: sqlText,
      parameters,
      parametersCount: parameters.length,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    const canceled = /cancel/i.test(e?.message || '') || e?.code === 'ECANCEL';
    return NextResponse.json(
      {
        ok: false,
        canceled,
        error: canceled ? 'Query canceled by user.' : (e?.message || String(e)),
        code: e?.code,
        sqlNumber: e?.number,
      },
      { status: canceled ? 200 : 502 },
    );
  }
});
