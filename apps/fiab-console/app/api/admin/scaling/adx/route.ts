/**
 * GET  /api/admin/scaling/adx — current ADX cluster SKU + state.
 * POST /api/admin/scaling/adx — scale / reconfigure:
 *     { sku, capacity? }                                → PATCH cluster SKU
 *     { action:'autoscale', isEnabled, min, max }       → PATCH optimizedAutoscale
 *     { action:'streaming-ingest', isEnabled }          → PATCH enableStreamingIngest
 * PUT  /api/admin/scaling/adx — lifecycle:
 *     { action:'stop' | 'start' }                       → cluster stop / start (async 202)
 *     { action:'delete', confirm:'<clusterName>' }      → cluster delete (async 202, soft-delete)
 *
 * Real ARM PATCH/POST/DELETE against Microsoft.Kusto/clusters/{name}. Tier is
 * derived: Dev(No SLA)_* → "Basic", everything else → "Standard". The Console
 * UAMI's "Azure Kusto Contributor" grant covers SKU/autoscale/stop/start/delete.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import {
  getKustoClusterArm, updateKustoClusterSku, updateKustoClusterAutoscale,
  updateKustoStreamingIngest, stopKustoCluster, startKustoCluster,
  deleteKustoCluster, readKustoArmConfig, KustoNotConfiguredError,
} from '@/lib/azure/kusto-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
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
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  const body = await req.json().catch(() => ({})) as {
    sku?: string; capacity?: number;
    action?: 'autoscale' | 'streaming-ingest';
    isEnabled?: boolean; min?: number; max?: number;
  };
  try {
    if (body?.action === 'autoscale') {
      const isEnabled = body.isEnabled === true;
      const min = Number(body.min);
      const max = Number(body.max);
      if (isEnabled && (!Number.isFinite(min) || !Number.isFinite(max) || min < 2 || max < min)) {
        return NextResponse.json(
          { ok: false, error: 'autoscale requires min >= 2 and max >= min' },
          { status: 400 },
        );
      }
      const result = await updateKustoClusterAutoscale(isEnabled, isEnabled ? min : 2, isEnabled ? max : 2);
      return NextResponse.json({ ok: true, cluster: result });
    }
    if (body?.action === 'streaming-ingest') {
      const result = await updateKustoStreamingIngest(body.isEnabled === true);
      return NextResponse.json({ ok: true, cluster: result });
    }
    if (!body?.sku) {
      return NextResponse.json({ ok: false, error: 'sku required (e.g. Standard_E2a_v4)' }, { status: 400 });
    }
    const result = await updateKustoClusterSku(body.sku, body.capacity);
    return NextResponse.json({ ok: true, cluster: result });
  } catch (e: any) {
    if (e instanceof KustoNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  const body = await req.json().catch(() => ({})) as { action?: string; confirm?: string };
  const action = body?.action;
  if (!action || !['stop', 'start', 'delete'].includes(action)) {
    return NextResponse.json({ ok: false, error: "action required: 'stop' | 'start' | 'delete'" }, { status: 400 });
  }
  try {
    if (action === 'delete') {
      // Require the caller to echo the cluster name as a destructive-op guard.
      const cfg = readKustoArmConfig();
      if ((body?.confirm || '').trim() !== cfg.clusterName) {
        return NextResponse.json(
          { ok: false, error: `Confirmation mismatch: type the cluster name "${cfg.clusterName}" to delete.` },
          { status: 400 },
        );
      }
      const result = await deleteKustoCluster();
      return NextResponse.json({ ok: true, ...result });
    }
    const result = action === 'stop' ? await stopKustoCluster() : await startKustoCluster();
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    if (e instanceof KustoNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
