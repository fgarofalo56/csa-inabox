/**
 * GET  /api/admin/scaling/capacity — list Fabric + Power BI Premium capacities.
 * POST /api/admin/scaling/capacity — { resourceId, sku } scale a capacity.
 *
 * Reads Fabric REST /v1/capacities for the inventory list, then issues an
 * ARM PATCH against Microsoft.Fabric/capacities/{n} or
 * Microsoft.PowerBIDedicated/capacities/{n} based on the resource id.
 *
 * No mocks — every result hits real REST. If the UAMI lacks the Power BI
 * tenant SP toggle the GET surfaces the 401/403 verbatim so the admin
 * sees the precise remediation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import { listFabricCapacities, updateCapacitySku } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  try {
    const capacities = await listFabricCapacities();
    return NextResponse.json({ ok: true, capacities });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), hint: e?.hint },
      { status: e?.status === 401 || e?.status === 403 ? e.status : 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  const body = await req.json().catch(() => ({})) as { resourceId?: string; sku?: string };
  if (!body?.resourceId) {
    return NextResponse.json({ ok: false, error: 'resourceId required (ARM id of the capacity)' }, { status: 400 });
  }
  if (!body?.sku) {
    return NextResponse.json({ ok: false, error: 'sku required (e.g. F8, F64, P1)' }, { status: 400 });
  }
  try {
    const result = await updateCapacitySku(body.resourceId, body.sku);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), hint: e?.hint },
      { status: e?.status || 502 },
    );
  }
}
