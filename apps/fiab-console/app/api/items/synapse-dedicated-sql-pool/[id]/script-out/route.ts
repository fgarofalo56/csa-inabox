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
