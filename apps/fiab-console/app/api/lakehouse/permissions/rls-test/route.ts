/**
 * RLS test-predicate BFF (F8) — runs a free-form row-level-security WHERE
 * predicate against LIVE rows of the target Synapse Dedicated SQL pool table
 * WITHOUT creating a policy, so an admin can preview the rows a given identity
 * would see before saving the policy.
 *
 * The predicate is validated server-side (same `validateWhereClause` rules the
 * editor mirrors). `@cmp` binds to each row's filter-column value;
 * USER_NAME()/SUSER_SNAME() bind to the supplied `testIdentity` (defaults to
 * the signed-in admin's UPN). Azure-native — NO Fabric dependency.
 *
 * POST { objectId:number, filterColumnId:number, whereClause:string, testIdentity?:string, sampleRows?:number }
 *   200 { ok:true, schema, table, filterColumn, testIdentity, columns, rows, rowCount, executionMs, truncated }
 *   400 { ok:false, error, code:'invalid_where_clause' }
 *   401 { ok:false, error:'unauthenticated' }
 *   503 { ok:false, gate:true, missing, hint }
 *   502 { ok:false, error }   (live SQL parse/bind error — e.g. unknown column)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget, testRlsPredicate, type SynapseTarget } from '@/lib/azure/synapse-permissions-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Honest infra-gate when the Synapse Dedicated SQL pool isn't configured. */
function resolveDedicated(): { target: SynapseTarget } | { gate: NextResponse } {
  try {
    return { target: dedicatedTarget() };
  } catch {
    return {
      gate: NextResponse.json(
        {
          ok: false,
          gate: true,
          missing: 'LOOM_SYNAPSE_WORKSPACE + LOOM_SYNAPSE_DEDICATED_POOL',
          hint: 'Row-level security runs on the Azure-native Synapse Dedicated SQL pool. Set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL on loom-console (already wired in admin-plane/main.bicep) and grant the Console UAMI db_owner on the pool database.',
        },
        { status: 503 },
      ),
    };
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const objectId = Number(body?.objectId);
  const filterColumnId = Number(body?.filterColumnId);
  const whereClause = body?.whereClause == null ? '' : String(body.whereClause);
  if (!Number.isInteger(objectId) || !Number.isInteger(filterColumnId)) {
    return NextResponse.json({ ok: false, error: 'objectId and filterColumnId required' }, { status: 400 });
  }
  // Default the simulated identity to the signed-in admin's UPN; allow an
  // explicit override so an admin can test "what would <user> see".
  const testIdentity = String(body?.testIdentity || session.claims.upn || '').trim();
  const sampleRows = Number(body?.sampleRows) || undefined;

  const r = resolveDedicated();
  if ('gate' in r) return r.gate;

  try {
    const { schema, table, filterColumn, result } = await testRlsPredicate(r.target, {
      objectId,
      filterColumnId,
      whereClause,
      testIdentity,
      sampleRows,
    });
    return NextResponse.json({
      ok: true,
      schema,
      table,
      filterColumn,
      testIdentity,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      truncated: result.truncated,
    });
  } catch (e: any) {
    if (e?.code === 'invalid_where_clause') {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
