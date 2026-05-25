/**
 * POST /api/items/synapse-dedicated-sql-pool/[id]/query
 * Executes T-SQL on the Dedicated SQL pool. If pool is Paused, returns
 * 409 with { state: 'Paused' } so the UI can call /resume. After resume
 * completes the UI re-issues the query.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sqlText = (body?.sql || '').toString().trim();
  if (!sqlText) return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ error: 'sql too large (>64KB)' }, { status: 413 });

  const state = await getPoolState().catch(() => null);
  if (state && state.state !== 'Online') {
    return NextResponse.json(
      { ok: false, error: `Pool is ${state.state}. Call /resume first.`, state: state.state, sku: state.sku },
      { status: 409 },
    );
  }

  try {
    const result = await executeQuery(dedicatedTarget(), sqlText);
    return NextResponse.json({
      ok: true,
      ...result,
      pool: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
      sku: state?.sku || 'unknown',
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: e?.message || String(e),
        code: e?.code,
        sqlNumber: e?.number,
      },
      { status: 502 },
    );
  }
}
