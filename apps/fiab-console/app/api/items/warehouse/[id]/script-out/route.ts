/**
 * GET /api/items/warehouse/[id]/script-out
 *   ?schema=<s>&name=<n>&type=view|procedure|function&mode=create|alter|drop
 *
 * Mirrors the Dedicated SQL pool script-out — the Fabric Warehouse is backed
 * by the same Synapse Dedicated compute. create/alter return the real
 * OBJECT_DEFINITION body; drop returns a runnable DROP … IF EXISTS.
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r. `GET(req)` took no `ctx` and ran
 * `getSession()` alone, then returned the full `OBJECT_DEFINITION` of any
 * view / procedure / function in the shared dedicated pool — i.e. another
 * tenant's business logic, verbatim. Layer 1 now authorizes the caller against
 * the warehouse item (read-scoped). Per `_lib/synapse-item-scope.ts` there is no
 * item→object ownership in the shared pool to bind `schema`/`name` against, so
 * this is a FLOOR and not a BOUND; recorded in the PR ledger.
 */

import { NextRequest, NextResponse } from 'next/server';
import { dedicatedTarget } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import {
  scriptOutSqlObject, asScriptObjectType, asScriptMode,
} from '@/lib/azure/sql-object-scripting';
import { guardSynapseItemRequest } from '../../../_lib/synapse-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WAREHOUSE_NOT_FOUND = 'warehouse not found';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: 'warehouse',
    notFound: WAREHOUSE_NOT_FOUND,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

  const schema = req.nextUrl.searchParams.get('schema');
  const name = req.nextUrl.searchParams.get('name');
  const type = asScriptObjectType(req.nextUrl.searchParams.get('type'));
  const mode = asScriptMode(req.nextUrl.searchParams.get('mode'));
  if (!schema || !name) return NextResponse.json({ ok: false, error: 'schema and name are required' }, { status: 400 });
  if (!type) return NextResponse.json({ ok: false, error: 'type must be view|procedure|function' }, { status: 400 });
  if (!mode) return NextResponse.json({ ok: false, error: 'mode must be create|alter|drop' }, { status: 400 });

  if (mode !== 'drop') {
    const state = await getPoolState().catch(() => null);
    if (!state || state.state !== 'Online') {
      return NextResponse.json(
        { ok: false, state: state?.state || 'Unknown', error: 'Warehouse compute not Online — resume to script CREATE/ALTER.' },
        { status: 409 },
      );
    }
  }

  const result = await scriptOutSqlObject(dedicatedTarget(), { type, schema, name, mode });
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
