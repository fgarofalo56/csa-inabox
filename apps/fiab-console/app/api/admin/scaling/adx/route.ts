/**
 * GET  /api/admin/scaling/adx — current ADX cluster SKU + state.
 * POST /api/admin/scaling/adx — { sku, capacity? } scale the cluster.
 *
 * Real ARM PATCH against Microsoft.Kusto/clusters/{name}. Tier is
 * derived: Dev(No SLA)_* → "Basic", everything else → "Standard".
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getKustoClusterArm, updateKustoClusterSku, KustoNotConfiguredError,
} from '@/lib/azure/kusto-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const cluster = await getKustoClusterArm();
    return NextResponse.json({ ok: true, cluster });
  } catch (e: any) {
    if (e instanceof KustoNotConfiguredError) {
      return NextResponse.json({
        ok: false, error: e.message,
        hint: `Set ${e.missing.join(', ')} on loom-console. Bicep: platform/fiab/bicep/modules/real-time-intelligence/adx.bicep`,
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { sku?: string; capacity?: number };
  if (!body?.sku) return NextResponse.json({ ok: false, error: 'sku required (e.g. Standard_E2ads_v5)' }, { status: 400 });
  try {
    const result = await updateKustoClusterSku(body.sku, body.capacity);
    return NextResponse.json({ ok: true, cluster: result });
  } catch (e: any) {
    if (e instanceof KustoNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
