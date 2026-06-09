/**
 * GET /api/items/warehouse/[id]/script-out
 *   ?schema=<s>&name=<n>&type=view|procedure|function&mode=create|alter|drop
 *
 * Mirrors the Dedicated SQL pool script-out — the Fabric Warehouse is backed
 * by the same Synapse Dedicated compute. create/alter return the real
 * OBJECT_DEFINITION body; drop returns a runnable DROP … IF EXISTS.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import {
  scriptOutSqlObject, asScriptObjectType, asScriptMode,
} from '@/lib/azure/sql-object-scripting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

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
