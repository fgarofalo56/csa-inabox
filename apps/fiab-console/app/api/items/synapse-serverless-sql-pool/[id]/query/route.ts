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
import { getSession } from '@/lib/auth/session';
import { serverlessTarget, serverlessEndpoint, executeQuery, executeQueryAsUser } from '@/lib/azure/synapse-sql-client';
import { resolveAccessMode } from '@/lib/azure/sql-access-mode';
import { getUserSqlToken } from '@/lib/azure/sql-user-token-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const sqlText = (body?.sql || '').toString().trim();
  const database = (body?.database || 'master').toString();
  const queryId = (body?.queryId || '').toString().trim() || undefined;
  if (!sqlText) return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ error: 'sql too large (>64KB)' }, { status: 413 });

  const accessMode = await resolveAccessMode(id, 'synapse-serverless-sql-pool');

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
      result = await executeQueryAsUser(serverlessTarget(database), sqlText, userToken, session.claims.oid, 60_000, queryId);
    } else {
      result = await executeQuery(serverlessTarget(database), sqlText, 60_000, queryId);
    }
    // DDL (CREATE/ALTER/DROP VIEW|PROC|FUNCTION) and other non-SELECT statements
    // return no columns. Flag isDdl so the editor switches to the Messages pane
    // and shows "Command(s) completed successfully." instead of an empty grid.
    const isDdl = result.columns.length === 0;
    return NextResponse.json({
      ok: true,
      ...result,
      isDdl,
      accessMode,
      endpoint: serverlessEndpoint(),
      database,
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
}
