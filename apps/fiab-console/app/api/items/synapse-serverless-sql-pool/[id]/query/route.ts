/**
 * POST /api/items/synapse-serverless-sql-pool/[id]/query
 * Executes T-SQL on Synapse Serverless SQL endpoint via TDS + AAD.
 * Body: { sql: string, database?: string }
 * Auth: session-required.
 *
 * Data-access mode (F10): when the item's state.accessMode is 'user', the query
 * runs under the signed-in user's own Azure identity via their cached delegated
 * SQL token; otherwise it runs as the Loom service identity (default).
 */

import { NextRequest, NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { withSession } from '@/lib/api/route-toolkit';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { serverlessTarget, serverlessEndpoint, executeQuery, executeQueryAsUser, type SynapseQueryParam } from '@/lib/azure/synapse-sql-client';
import { resolveAccessMode } from '@/lib/azure/sql-access-mode';
import { getUserSqlToken } from '@/lib/azure/sql-user-token-store';
import { recordQueryRun } from '@/lib/finops/query-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession(async (req: NextRequest, { session, params }) => {
  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;

  const { id } = params;
  const body = await req.json().catch(() => ({}));
  const sqlText = (body?.sql || '').toString().trim();
  const database = (body?.database || 'master').toString();
  const queryId = (body?.queryId || '').toString().trim() || undefined;
  if (!sqlText) return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ error: 'sql too large (>64KB)' }, { status: 413 });

  // Named parameters (`@name`) — bound via req.input(), NOT concatenated.
  const parameters: SynapseQueryParam[] = (Array.isArray(body?.parameters) ? body.parameters : [])
    .filter((p: any) => p && typeof p.name === 'string')
    .map((p: any) => ({ name: String(p.name), value: p.value == null ? null : String(p.value) }));

  const accessMode = await resolveAccessMode(id, 'synapse-serverless-sql-pool');

  try {
    let result;
    const started = Date.now();
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
      result = await executeQueryAsUser(serverlessTarget(database), sqlText, userToken, session.claims.oid, 60_000, parameters, queryId);
    } else {
      result = await executeQuery(serverlessTarget(database), sqlText, 60_000, parameters, queryId);
    }
    // DDL (CREATE/ALTER/DROP VIEW|PROC|FUNCTION) and other non-SELECT statements
    // return no columns. Flag isDdl so the editor switches to the Messages pane
    // and shows "Command(s) completed successfully." instead of an empty grid.
    const isDdl = result.columns.length === 0;
    // B-N19e — FOCUS cost attribution for this Serverless SQL run (best-effort).
    void recordQueryRun({
      tenantId: tenantScopeId(session), userOid: session.claims.oid, userName: session.claims.upn,
      engine: 'synapse-serverless', statement: sqlText, durationMs: Date.now() - started,
      rowCount: (result as { rowCount?: number }).rowCount,
      queryId, itemId: id, itemType: 'synapse-serverless-sql-pool', resourceId: database,
    });
    return NextResponse.json({
      ok: true,
      ...result,
      isDdl,
      accessMode,
      endpoint: serverlessEndpoint(),
      database,
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
        sqlState: e?.originalError?.info?.state,
        sqlNumber: e?.number,
        accessMode,
      },
      { status: canceled ? 200 : 502 },
    );
  }
});
