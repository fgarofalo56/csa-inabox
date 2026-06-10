/**
 * GET /api/items/warehouse/[id]/acceleration
 *
 * Honest "query acceleration" capability probe for the Warehouse editor.
 *
 * There is NO GPU acceleration on either warehouse backend — Fabric Data
 * Warehouse and the Azure-native Synapse Dedicated SQL pool are both CPU /
 * columnar batch-mode engines (the SQL Server batch-mode execution engine,
 * per Microsoft Learn). "Query acceleration" therefore means different things
 * per backend, and this route reports the REAL, currently-active model with no
 * fabricated GPU state:
 *
 *   • synapse-dedicated (DEFAULT, no-fabric-dependency.md): acceleration is
 *     governed by the dedicated pool's DWU SKU. Query throughput scales by
 *     resizing the pool (DW100c … DW30000c) — a real ARM operation surfaced on
 *     the Dedicated SQL pool editor. We read the live SKU + state via ARM.
 *   • fabric-warehouse (OPT-IN only, LOOM_WAREHOUSE_BACKEND=fabric-warehouse +
 *     a bound workspace): serverless distributed query processing that
 *     auto-scales compute nodes per query (burstable capacity + SSD/memory
 *     cache). Still CPU — no GPU. This backend is preview/roadmap in Loom.
 *
 * The response feeds the editor's Query-acceleration toggle and its honest
 * MessageBar. `gpuAvailable` is ALWAYS false — we never claim GPU.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type WarehouseBackend = 'synapse-dedicated' | 'fabric-warehouse' | 'unknown';

function resolveBackend(): WarehouseBackend {
  const b = (process.env.LOOM_WAREHOUSE_BACKEND || 'synapse-dedicated').toLowerCase();
  if (b === 'synapse-dedicated') return 'synapse-dedicated';
  if (b === 'fabric-warehouse') return 'fabric-warehouse';
  return 'unknown';
}

export async function GET(_req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const backend = resolveBackend();
  const fabricWorkspace = process.env.LOOM_DEFAULT_FABRIC_WORKSPACE || '';

  if (backend === 'fabric-warehouse') {
    // Opt-in Fabric backend. Serverless auto-scaling distributed query
    // processing — real acceleration, but still CPU (no GPU), and the Loom
    // Fabric Warehouse path is preview/roadmap. Disclose honestly.
    return NextResponse.json({
      ok: true,
      backend,
      accelerationModel: 'serverless-autoscale',
      gpuAvailable: false,
      // The serverless engine scales nodes automatically; there is no on/off
      // toggle for the user, hence the editor toggle is informational here.
      accelerationEnabled: true,
      userToggleable: false,
      fabricWorkspaceBound: !!fabricWorkspace,
      summary:
        'Fabric Data Warehouse uses serverless distributed query processing that auto-scales compute nodes per query (burstable capacity with SSD/memory caching). This is CPU batch-mode execution — there is no GPU acceleration. The Loom Fabric Warehouse path is preview.',
      scaleHint:
        'Acceleration is automatic and serverless on this backend — no manual scaling required. Larger Fabric capacity (SKU) increases concurrency headroom.',
    });
  }

  if (backend === 'unknown') {
    return NextResponse.json({
      ok: true,
      backend,
      accelerationModel: 'unknown',
      gpuAvailable: false,
      accelerationEnabled: false,
      userToggleable: false,
      summary: `Unknown LOOM_WAREHOUSE_BACKEND. Set LOOM_WAREHOUSE_BACKEND=synapse-dedicated (Azure-native default) or fabric-warehouse (opt-in).`,
    });
  }

  // synapse-dedicated (DEFAULT). Acceleration = DWU SKU. Read live SKU/state.
  let sku = 'unknown';
  let state: string = 'Unknown';
  let probeError: string | null = null;
  try {
    const s = await getPoolState();
    sku = s.sku || 'unknown';
    state = s.state;
  } catch (e: any) {
    probeError = e?.message || String(e);
  }

  return NextResponse.json({
    ok: true,
    backend,
    accelerationModel: 'dwu-sku',
    gpuAvailable: false,
    // The pool always runs at its provisioned DWU. There is no per-query
    // acceleration switch on dedicated pool, so the toggle is informational
    // and routes the user to the real scale action.
    accelerationEnabled: state === 'Online',
    userToggleable: false,
    sku,
    state,
    pool: process.env.LOOM_SYNAPSE_DEDICATED_POOL || null,
    ...(probeError ? { probeError } : {}),
    summary:
      'The Azure-native warehouse runs on a Synapse Dedicated SQL pool — a CPU, columnar batch-mode engine. There is no GPU acceleration. Query performance scales by resizing the pool\'s DWU SKU (DW100c … DW30000c).',
    scaleHint:
      'To accelerate queries, scale the Dedicated SQL pool to a larger DWU SKU on the Dedicated SQL pool editor (a real ARM resize), or enable result-set caching. A GPU-accelerated warehouse is not offered on either the Azure-native or Fabric backend.',
  });
}
