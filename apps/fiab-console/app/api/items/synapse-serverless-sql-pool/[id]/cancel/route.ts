/**
 * POST /api/items/synapse-serverless-sql-pool/[id]/cancel
 * body: { queryId }
 *
 * Sends a TDS ATTENTION packet (mssql `Request.cancel()`) to abort the
 * in-flight T-SQL batch on the Serverless SQL endpoint. See the Dedicated
 * cancel route for the same-process / scale-out semantics.
 *
 * Cancel is scoped to the caller's own queries on the item:
 *   - the caller is authorized on the route ITEM with the same guard as the
 *     query route (`guardSqlPoolQueryItem`, read roles accepted, 404 for an id
 *     naming no item), before the body is read;
 *   - the query route registers a running query under the caller's oid, the
 *     item id and the queryId together (`sqlPoolQueryKey`), and this route
 *     looks up exactly that key, so a queryId started by another caller, or on
 *     another item, is not found here.
 * Nothing found is a 404 and cancels nothing. On scale-out a cancel can also
 * land on a replica that is not running the query; that is the same 404.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { cancelActiveQuery } from '@/lib/azure/synapse-sql-client';
import { guardSqlPoolQueryItem, sqlPoolQueryKey } from '../../_lib/query-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession(async (req: NextRequest, { session, params }) => {
  const guard = await guardSqlPoolQueryItem(params.id);
  if (guard.res) return guard.res;
  const { item } = guard.ctx;

  const body = await req.json().catch(() => ({}));
  const queryId = (body?.queryId || '').toString().trim();
  if (!queryId) return NextResponse.json({ ok: false, error: 'queryId is required' }, { status: 400 });

  const found = cancelActiveQuery(sqlPoolQueryKey(session.claims.oid, item.id, queryId));
  if (!found) {
    return NextResponse.json(
      {
        ok: false,
        canceled: false,
        found: false,
        error: 'No query of yours with that id is running on this item on this server.',
      },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, canceled: true, found: true, canceledBy: session.claims?.upn });
});
