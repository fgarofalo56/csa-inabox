/**
 * POST /api/items/synapse-dedicated-sql-pool/[id]/cancel
 * body: { queryId }
 *
 * Sends a TDS ATTENTION packet (mssql `Request.cancel()`) to abort the
 * in-flight T-SQL batch on the Dedicated SQL pool. The client generates a
 * queryId and includes it in the /query body; this route resolves that id to
 * the running request and cancels it.
 *
 * Cancel is scoped to the caller's own queries on the item, the same way as the
 * serverless SQL pool cancel route:
 *   - the caller is authorized on the route ITEM with the same guard as this
 *     family's query route (`guardSynapseItemRequest`, 404 for an id naming no
 *     item), before the body is read;
 *   - the query route registers a running query under this family, the
 *     caller's oid, the item id and the queryId together (`SqlCancelKey`), and
 *     this route looks up exactly that key, so a queryId started by another
 *     caller, on another item, or through another route family is not found.
 * Nothing found is a 404 and cancels nothing.
 *
 * Same-process scope: the request must be in-flight on this Node.js process
 * (holds for single-instance Container App deployments). On scale-out the
 * cancel may land on a different replica; that is the same 404, and the query
 * completes normally on its own replica.
 */
import { NextRequest, NextResponse } from 'next/server';
import { cancelActiveQuery } from '@/lib/azure/synapse-sql-client';
import { guardSynapseItemRequest } from '../../../_lib/synapse-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: 'synapse-dedicated-sql-pool',
    notFound: 'dedicated SQL pool not found',
  });
  if (guard.res) return guard.res;
  const { session, item } = guard.ctx;

  const body = await req.json().catch(() => ({}));
  const queryId = (body?.queryId || '').toString().trim();
  if (!queryId) return NextResponse.json({ ok: false, error: 'queryId is required' }, { status: 400 });

  const found = cancelActiveQuery({ family: 'dedicated-sql-pool', oid: session.claims.oid, itemId: item.id, queryId });
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
}
