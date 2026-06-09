/**
 * GET  /api/admin/scaling/aks — list the AKS cluster's agent (node) pools.
 * POST /api/admin/scaling/aks — { pool, count } scale a pool's node count.
 *
 * Real ARM against Microsoft.ContainerService/managedClusters/{cluster}/agentPools.
 * AKS is the GCC-High / IL5 container platform (Commercial / GCC run Container
 * Apps) — so on Commercial / GCC LOOM_AKS_CLUSTER_NAME is unset and GET returns a
 * 503 honest gate the drawer renders as a MessageBar.
 *
 * Needs the Console UAMI to hold "Azure Kubernetes Service Cluster Admin" (or
 * Contributor) on the cluster — granted in container-platform.bicep.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listAksAgentPools, scaleAksAgentPool, AksNotConfiguredError,
} from '@/lib/azure/aks-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const pools = await listAksAgentPools();
    return NextResponse.json({ ok: true, pools });
  } catch (e: any) {
    if (e instanceof AksNotConfiguredError) {
      return NextResponse.json({
        ok: false, error: e.message,
        hint: `Set ${e.missing.join(', ')} on loom-console. AKS is the GCC-High / IL5 container platform; Commercial / GCC run on Container Apps. Bicep: platform/fiab/bicep/modules/admin-plane/container-platform.bicep`,
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { pool?: string; count?: number };
  if (!body?.pool) return NextResponse.json({ ok: false, error: 'pool required' }, { status: 400 });
  if (typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 0 || body.count > 1000) {
    return NextResponse.json({ ok: false, error: 'count must be an integer 0-1000' }, { status: 400 });
  }
  try {
    const pool = await scaleAksAgentPool(body.pool, body.count);
    return NextResponse.json({ ok: true, pool, count: pool.count, provisioningState: pool.provisioningState });
  } catch (e: any) {
    if (e instanceof AksNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status: e?.status || 502 });
  }
}
