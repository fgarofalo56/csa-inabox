/**
 * POST /api/items/warehouse/[id]/query
 *
 * Fabric "Warehouse" is implemented in Loom-Gov by the Synapse Dedicated
 * SQL pool. This handler is a thin wrapper around the dedicated pool
 * query path so the WarehouseEditor UI works identically.
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r (the "weak signal only" band). `withSession`
 * resolved a session and `params.id` was read ONLY to tag a FinOps receipt —
 * nothing authorized the caller against the item. `body.database` then
 * RE-POINTED the TDS connection at any other database on the shared Synapse SQL
 * server, and the statement is arbitrary caller-authored T-SQL executed as the
 * Console UAMI (AAD admin on the workspace; no OBO on this path).
 *
 * BOTH LAYERS now, and here Layer 2 is a real bound rather than a floor:
 *   LAYER 1 — `guardSynapseItemRequest` authorizes the caller against the
 *     warehouse item. Write-scoped: this endpoint executes arbitrary T-SQL, so
 *     it is NOT read-only even though the editor's common case is a SELECT.
 *   LAYER 2 — `scopeSynapseDatabase` admits `body.database` only when it is
 *     bound to an item in this item's OWN workspace. Blank still resolves to the
 *     item's own database, which is what the editor sends by default, so the
 *     working path is unchanged.
 *
 * NOT closed by this: the statement runs INSIDE the admitted database, and the
 * shared dedicated pool has no item→schema.table ownership, so a caller can
 * still address any table in the one shared pool. See
 * `_lib/synapse-item-scope.ts` and the PR ledger.
 */

import { NextRequest, NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { dedicatedTarget, executeQuery, type SynapseQueryParam } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { recordQueryRun } from '@/lib/finops/query-run';
import { guardSynapseItemRequest, scopeSynapseDatabase } from '../../../_lib/synapse-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WAREHOUSE_NOT_FOUND = 'warehouse not found';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: 'warehouse',
    notFound: WAREHOUSE_NOT_FOUND,
  });
  if (guard.res) return guard.res;
  const { session, item } = guard.ctx;

  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;

  const body = await req.json().catch(() => ({}));
  const sqlText = (body?.sql || '').toString().trim();
  const queryId = (body?.queryId || '').toString().trim() || undefined;
  if (!sqlText) return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ error: 'sql too large (>64KB)' }, { status: 413 });

  // LAYER 2 — the database is bound to the item's workspace BEFORE any TDS work.
  const scopedDb = await scopeSynapseDatabase(item, body?.database);
  if (!scopedDb.ok) {
    return NextResponse.json({ ok: false, error: scopedDb.error }, { status: scopedDb.status });
  }

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
  const database: string = scopedDb.database;
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
      itemId: id, itemType: 'warehouse',
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
}
