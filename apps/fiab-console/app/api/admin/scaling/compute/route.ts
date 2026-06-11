/**
 * Azure-native compute scaling — the engine behind Admin → Capacity & compute →
 * "Scale & manage". Lets an admin change SKUs and pause/resume/scale the real
 * Azure compute Loom runs on, across every Azure boundary (no Fabric):
 *
 *   GET  /api/admin/scaling/compute
 *        → the scalable resources present in THIS deployment with current
 *          SKU / capacity / state (ADX cluster, Synapse dedicated pool, the
 *          scaled self-hosted IR VMSS). Each probe is best-effort — a resource
 *          that isn't configured is simply omitted (honest, no mocks).
 *
 *   POST /api/admin/scaling/compute  { kind, action, sku?, capacity? }
 *        kind 'adx'          action 'scale'         → PATCH cluster SKU (+capacity)
 *        kind 'synapse-pool' action 'pause'|'resume'→ ARM pause / resume
 *        kind 'shir-vmss'    action 'scale'         → VMSS capacity 0..N
 *
 * Every call hits real ARM. Failures surface verbatim. Needs the Console UAMI to
 * have the relevant Contributor role (ADX/Synapse/VMSS) — granted in bicep.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Scalable {
  kind: 'adx' | 'synapse-pool' | 'shir-vmss' | 'purview-shir-vmss';
  name: string;
  sku?: string;
  capacity?: number;
  state?: string;
  /** SKU choices for kinds that scale by SKU. */
  skuOptions?: string[];
  /** Lifecycle actions available. */
  actions: string[];
}

const ADX_SKUS = [
  'Dev(No SLA)_Standard_E2a_v4',
  'Standard_E2ads_v5', 'Standard_E4ads_v5', 'Standard_E8ads_v5', 'Standard_E16ads_v5',
  'Standard_L8as_v3', 'Standard_L16as_v3',
];

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const resources: Scalable[] = [];
  const errors: { kind: string; error: string }[] = [];

  // ADX cluster
  try {
    const { getKustoClusterArm } = await import('@/lib/azure/kusto-arm-client');
    const c: any = await getKustoClusterArm();
    resources.push({
      kind: 'adx', name: c?.name || 'ADX cluster',
      sku: c?.sku?.name || c?.sku, capacity: c?.sku?.capacity ?? c?.capacity,
      state: c?.state || c?.provisioningState,
      skuOptions: ADX_SKUS, actions: ['scale'],
    });
  } catch (e: any) { if (process.env.LOOM_KUSTO_CLUSTER_URI) errors.push({ kind: 'adx', error: e?.message || String(e) }); }

  // Synapse dedicated SQL pool
  try {
    const { getPoolState } = await import('@/lib/azure/synapse-pool-arm');
    const p = await getPoolState();
    resources.push({
      kind: 'synapse-pool', name: process.env.LOOM_SYNAPSE_DEDICATED_POOL || 'Dedicated SQL pool',
      sku: p.sku, state: p.state, actions: ['pause', 'resume'],
    });
  } catch (e: any) { if (process.env.LOOM_SYNAPSE_DEDICATED_POOL) errors.push({ kind: 'synapse-pool', error: e?.message || String(e) }); }

  // Scaled self-hosted IR VMSS
  try {
    const { shirVmssConfig, getVmssStatus } = await import('@/lib/azure/vmss-client');
    const cfg = shirVmssConfig();
    if (cfg) {
      const v = await getVmssStatus(cfg);
      const running = v.nodes.filter((n) => n.provisioningState === 'Succeeded').length;
      resources.push({
        kind: 'shir-vmss', name: v.name, capacity: v.capacity,
        state: v.capacity === 0 ? 'Stopped (0)' : `${running}/${v.capacity} nodes`,
        actions: ['scale'],
      });
    }
  } catch (e: any) { errors.push({ kind: 'shir-vmss', error: e?.message || String(e) }); }

  // Shared admin-zone Purview SHIR VMSS (separate from the DLZ ADF SHIR).
  try {
    const { purviewShirVmssConfig, getVmssStatus } = await import('@/lib/azure/vmss-client');
    const cfg = purviewShirVmssConfig();
    if (cfg) {
      const v = await getVmssStatus(cfg);
      const running = v.nodes.filter((n) => n.provisioningState === 'Succeeded').length;
      resources.push({
        kind: 'purview-shir-vmss', name: v.name, capacity: v.capacity,
        state: v.capacity === 0 ? 'Stopped (0)' : `${running}/${v.capacity} nodes`,
        actions: ['scale'],
      });
    }
  } catch (e: any) { if (process.env.LOOM_PURVIEW_SHIR_VMSS_NAME) errors.push({ kind: 'purview-shir-vmss', error: e?.message || String(e) }); }

  return NextResponse.json({ ok: true, resources, errors });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { kind?: string; action?: string; sku?: string; capacity?: number };

  try {
    if (body.kind === 'adx' && body.action === 'scale') {
      if (!body.sku) return NextResponse.json({ ok: false, error: 'sku required' }, { status: 400 });
      const { updateKustoClusterSku } = await import('@/lib/azure/kusto-arm-client');
      const r: any = await updateKustoClusterSku(body.sku, body.capacity);
      return NextResponse.json({ ok: true, kind: 'adx', state: r?.state || 'Updating', message: `Scaling ADX to ${body.sku}.` });
    }
    if (body.kind === 'synapse-pool' && (body.action === 'pause' || body.action === 'resume')) {
      const { pausePool, resumePool } = await import('@/lib/azure/synapse-pool-arm');
      if (body.action === 'pause') await pausePool(); else await resumePool();
      return NextResponse.json({ ok: true, kind: 'synapse-pool', message: `Synapse pool ${body.action} requested.` });
    }
    if (body.kind === 'shir-vmss' && body.action === 'scale') {
      const { shirVmssConfig, scaleVmss } = await import('@/lib/azure/vmss-client');
      const cfg = shirVmssConfig();
      if (!cfg) return NextResponse.json({ ok: false, error: 'SHIR VMSS not configured (LOOM_SHIR_VMSS_NAME).' }, { status: 400 });
      await scaleVmss(cfg, typeof body.capacity === 'number' ? body.capacity : 0);
      return NextResponse.json({ ok: true, kind: 'shir-vmss', message: `Scaling SHIR to ${body.capacity} node(s).` });
    }
    if (body.kind === 'purview-shir-vmss' && body.action === 'scale') {
      const { purviewShirVmssConfig, scaleVmss } = await import('@/lib/azure/vmss-client');
      const cfg = purviewShirVmssConfig();
      if (!cfg) return NextResponse.json({ ok: false, error: 'Purview SHIR VMSS not configured (LOOM_PURVIEW_SHIR_VMSS_NAME).' }, { status: 400 });
      await scaleVmss(cfg, typeof body.capacity === 'number' ? body.capacity : 0);
      return NextResponse.json({ ok: true, kind: 'purview-shir-vmss', message: `Scaling Purview SHIR to ${body.capacity} node(s).` });
    }
    return NextResponse.json({ ok: false, error: `Unsupported kind/action: ${body.kind}/${body.action}` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
