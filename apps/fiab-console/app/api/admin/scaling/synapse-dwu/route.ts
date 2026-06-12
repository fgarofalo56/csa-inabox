/**
 * GET  /api/admin/scaling/synapse-dwu — list Synapse Dedicated SQL pools + current SKU.
 * POST /api/admin/scaling/synapse-dwu — { pool, sku } scale a pool (DW100c → DW30000c).
 *
 * Real ARM PATCH against Microsoft.Synapse/workspaces/{ws}/sqlPools/{pool}.
 * Scale is asynchronous; the pool state moves to "Scaling" for a few
 * minutes then back to "Online". The route returns the immediate ARM
 * response so the UI can show "Scaling…".
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import {
  listDedicatedSqlPools, updateDedicatedPoolSku, getDedicatedPool,
} from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return NextResponse.json({
      ok: false,
      error: 'Synapse workspace not configured',
      hint: 'Set LOOM_SYNAPSE_WORKSPACE on loom-console — bicep module: platform/fiab/bicep/modules/data-platform/synapse.bicep',
    }, { status: 503 });
  }
  try {
    const pools = await listDedicatedSqlPools();
    return NextResponse.json({ ok: true, pools });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  const body = await req.json().catch(() => ({})) as { pool?: string; sku?: string };
  if (!body?.pool) return NextResponse.json({ ok: false, error: 'pool required' }, { status: 400 });
  if (!body?.sku || !/^DW\d+c$/i.test(body.sku)) {
    return NextResponse.json({ ok: false, error: 'sku must match DWxxxxc (e.g. DW500c)' }, { status: 400 });
  }
  try {
    const before = await getDedicatedPool(body.pool);
    const result = await updateDedicatedPoolSku(body.pool, body.sku);
    return NextResponse.json({
      ok: true,
      previousSku: before?.sku?.name,
      newSku: result?.sku?.name || body.sku,
      provisioningState: result?.properties?.provisioningState || 'Scaling',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
