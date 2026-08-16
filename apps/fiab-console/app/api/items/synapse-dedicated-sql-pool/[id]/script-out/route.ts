/**
 * GET /api/items/synapse-dedicated-sql-pool/[id]/script-out
 *   ?schema=<s>&name=<n>&type=view|procedure|function&mode=create|alter|drop
 *
 * Returns a runnable T-SQL script for the object:
 *   - create → the real OBJECT_DEFINITION body (sys.sql_modules.definition)
 *   - alter  → the same body rewritten to CREATE OR ALTER
 *   - drop   → a DROP <kind> IF EXISTS [schema].[name];
 *
 * The schema/name come from the Explorer's catalog enumeration; they are
 * single-quote-escaped before the WHERE clause and bracket-sanitized in the
 * emitted DDL. Returns 409 when the pool is Paused (no compute to read from).
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r. Sibling of `warehouse/[id]/script-out` over
 * the same shared pool; `GET(req)` took no `ctx` and returned any object's
 * verbatim definition behind `getSession()` alone. Layer 1 authorizes against
 * the pool item (read-scoped); no item→object binding exists, so this is a
 * FLOOR — see the ledger.
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

const POOL_NOT_FOUND = 'dedicated SQL pool not found';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: 'synapse-dedicated-sql-pool',
    notFound: POOL_NOT_FOUND,
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

  // DROP needs no compute — emit it even when the pool is Paused.
  if (mode !== 'drop') {
    const state = await getPoolState().catch(() => null);
    if (!state || state.state !== 'Online') {
      return NextResponse.json(
        { ok: false, state: state?.state || 'Unknown', error: 'Pool not Online — resume to script CREATE/ALTER.' },
        { status: 409 },
      );
    }
  }

  const result = await scriptOutSqlObject(dedicatedTarget(), { type, schema, name, mode });
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
