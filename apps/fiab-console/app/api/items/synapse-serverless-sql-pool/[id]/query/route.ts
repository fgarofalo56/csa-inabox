/**
 * POST /api/items/synapse-serverless-sql-pool/[id]/query
 * Executes T-SQL on Synapse Serverless SQL endpoint via TDS + AAD.
 * Body: { sql: string, database?: string, queryId?: string, parameters?: [...] }
 *
 * Auth and item scope (`../../_lib/query-scope.ts`):
 *   - The caller is authorized on the route ITEM: owner, tenant admin, or
 *     shared-ACL member of its workspace, with the workspace resolved from the
 *     item and a 404 for an id naming no item. Read roles are accepted because
 *     every non-admin query is classifier-accepted SELECT text (the same
 *     justification as the lakehouse SQL tab). The geo-dataset and geo-query
 *     editors post here with their own item id, so those types are accepted too.
 *   - A TENANT ADMIN runs the SQL unchanged, in the requested `database`
 *     (default `master`), with its named parameters.
 *   - Any other caller: the SQL passes the lakehouse SQL tab's classifier
 *     (SELECT only; no USE, no other database, no `sys` catalog outside the
 *     INFORMATION_SCHEMA views), and every OPENROWSET(BULK …) location must be a
 *     literal URL under the storage root of a lakehouse in this item's
 *     workspace, resolved server-side. It runs in `master` whatever the request
 *     names, on a connection pool of its own, with the batch starting
 *     `USE [master];` (`../../../lakehouse/_lib/query-reader.ts`). Variables
 *     and `@parameters` are refused for these callers.
 *   - A per-item serverless database (#4821) is the durable form of this
 *     boundary and lifts these restrictions.
 *
 * Data-access mode (F10): when the item's state.accessMode is 'user', the query
 * runs under the signed-in user's own Azure identity via their cached delegated
 * SQL token; otherwise it runs as the Loom service identity (default). The item
 * scope above applies in both modes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { withSession } from '@/lib/api/route-toolkit';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { serverlessTarget, serverlessEndpoint, executeQuery, executeQueryAsUser, type SynapseQueryParam } from '@/lib/azure/synapse-sql-client';
import { resolveAccessMode } from '@/lib/azure/sql-access-mode';
import { getUserSqlToken } from '@/lib/azure/sql-user-token-store';
import { recordQueryRun } from '@/lib/finops/query-run';
import { READER_DATABASE, readerTarget, readerBatch, withoutReaderUseMessage } from '../../../lakehouse/_lib/query-reader';
import { guardSqlPoolQueryItem, confineToWorkspaceLakehouses, SQL_POOL_READER_POOL_PREFIX } from '../../_lib/query-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession(async (req: NextRequest, { session, params }) => {
  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;

  const { id } = params;
  const guard = await guardSqlPoolQueryItem(id);
  if (guard.res) return guard.res;
  const { item } = guard.ctx;

  const body = await req.json().catch(() => ({}));
  const sqlText = (body?.sql || '').toString().trim();
  const queryId = (body?.queryId || '').toString().trim() || undefined;
  if (!sqlText) return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ error: 'sql too large (>64KB)' }, { status: 413 });

  // A tenant admin runs the SQL unchanged in the requested database; anyone
  // else runs classifier-accepted text in master (see the header).
  const admin = isTenantAdmin(session);
  const database = admin ? (body?.database || 'master').toString() : READER_DATABASE;
  if (!admin) {
    const refused = await confineToWorkspaceLakehouses(sqlText, item);
    if (refused) return refused;
  }
  const target = admin ? serverlessTarget(database) : readerTarget(SQL_POOL_READER_POOL_PREFIX);
  const batch = admin ? sqlText : readerBatch(sqlText);

  // Named parameters (`@name`) — bound via req.input(), NOT concatenated. The
  // classifier refuses `@` variables for non-admins, so none are bound there.
  const parameters: SynapseQueryParam[] = !admin ? [] : (Array.isArray(body?.parameters) ? body.parameters : [])
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
      result = await executeQueryAsUser(target, batch, userToken, session.claims.oid, 60_000, parameters, queryId);
    } else {
      result = await executeQuery(target, batch, 60_000, parameters, queryId);
    }
    if (!admin) result = { ...result, messages: withoutReaderUseMessage(result.messages) };
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
