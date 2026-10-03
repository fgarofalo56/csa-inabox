/**
 * POST /api/items/warehouse/[id]/cancel
 * body: { queryId }
 *
 * Fabric "Warehouse" is backed by the Synapse Dedicated SQL pool in Loom, so
 * cancel is the same TDS ATTENTION path as the dedicated pool. Sends
 * mssql `Request.cancel()` to abort the in-flight batch. See the Dedicated
 * cancel route for same-process / scale-out semantics.
 *
 * Cancel is scoped to the caller's own queries on the item:
 *   - the caller is authorized on the route ITEM with the same guard as the
 *     warehouse query route (`guardSynapseItemRequest`, 404 for an id naming no
 *     item), before the body is read;
 *   - the query route registers a running query under the warehouse family, the
 *     caller's oid, the item id and the queryId together (`SqlCancelKey`), and
 *     this route looks up exactly that key, so a queryId started by another
 *     caller, on another item, or through another route family is not found.
 * Nothing found is a 404 and cancels nothing.
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
    itemType: 'warehouse',
    notFound: 'warehouse not found',
  });
  if (guard.res) return guard.res;
  const { session, item } = guard.ctx;

  const body = await req.json().catch(() => ({}));
  const queryId = (body?.queryId || '').toString().trim();
  if (!queryId) return NextResponse.json({ ok: false, error: 'queryId is required' }, { status: 400 });

  const found = cancelActiveQuery({ family: 'warehouse', oid: session.claims.oid, itemId: item.id, queryId });
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
