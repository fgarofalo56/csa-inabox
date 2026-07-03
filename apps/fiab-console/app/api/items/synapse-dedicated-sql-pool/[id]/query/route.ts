/**
 * POST /api/items/synapse-dedicated-sql-pool/[id]/query
 * Executes T-SQL on the Dedicated SQL pool. If pool is Paused, returns
 * 409 with { state: 'Paused' } so the UI can call /resume. After resume
 * completes the UI re-issues the query.
 *
 * Data-access mode (F10): when the item's state.accessMode is 'user', the
 * query runs under the signed-in user's own Azure identity via their cached
 * delegated SQL token; otherwise it runs as the Loom service identity (default).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { dedicatedTarget, executeQuery, executeQueryAsUser, type SynapseQueryParam } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { resolveAccessMode } from '@/lib/azure/sql-access-mode';
import { getUserSqlToken } from '@/lib/azure/sql-user-token-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const sqlText = (body?.sql || '').toString().trim();
  const queryId = (body?.queryId || '').toString().trim() || undefined;
  // Cross-database picker: when the editor's database dropdown selects a
  // database other than the env-bound pool, open the TDS connection against
  // that database so 3-part names (other_db.schema.table) resolve natively.
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
      { ok: false, error: `Pool is ${state.state}. Call /resume first.`, state: state.state, sku: state.sku },
      { status: 409 },
    );
  }

  const accessMode = await resolveAccessMode(id, 'synapse-dedicated-sql-pool');

  // Resolve the TDS target — default to the env-bound pool, or a selected
  // sibling database for cross-DB queries (keyed separately so its own pool
  // is cached).
  const baseTarget = dedicatedTarget();
  const target = database && database !== baseTarget.database
    ? { ...baseTarget, database, cacheKey: `dedicated:${process.env.LOOM_SYNAPSE_WORKSPACE}:${database}` }
    : baseTarget;

  try {
    let result;
    if (accessMode === 'user') {
      const userToken = await getUserSqlToken(session.claims.oid);
      if (!userToken) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "User's identity mode is on, but no valid SQL token is cached for you. Sign out and sign back in, then retry. If it still fails, your admin must grant admin consent for the Azure SQL delegated permission on the Loom app registration (scripts/csa-loom/grant-sql-delegated-permission.sh).",
            code: 'NO_USER_SQL_TOKEN',
          },
          { status: 403 },
        );
      }
      result = await executeQueryAsUser(target, sqlText, userToken, session.claims.oid, 60_000, parameters, queryId);
    } else {
      result = await executeQuery(target, sqlText, 60_000, parameters, queryId);
    }
    return NextResponse.json({
      ok: true,
      ...result,
      accessMode,
      pool: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
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
        accessMode,
      },
      { status: canceled ? 200 : 502 },
    );
  }
}
