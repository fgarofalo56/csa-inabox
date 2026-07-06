/**
 * GET / POST /api/items/warehouse/[id]/query-acceleration
 *
 * Query acceleration for the Warehouse editor — the Azure-native parity of
 * Fabric's "GPU-accelerated warehouse" (Fabric Build 2026). Per
 * no-fabric-dependency.md this surface is 100% functional with no Fabric
 * capacity or workspace, on the Synapse Dedicated SQL pool (the only warehouse
 * backend). The two acceleration tiers are honest:
 *
 *   - GPU acceleration is a Fabric-warehouse-engine capability that Loom does
 *     NOT provision (the Fabric backend is not built). The Azure-native
 *     warehouse (Synapse Dedicated SQL) runs CPU batch-mode compute and has NO
 *     GPU. We do NOT pretend otherwise — `gpu.available` is always false and the
 *     disclosure names Loom's Azure-native GPU-class answer: Databricks Photon /
 *     a Databricks SQL warehouse.
 *
 *   - Result-set caching is the REAL Azure-native query-acceleration knob on
 *     the Synapse Dedicated SQL pool. The toggle issues a real
 *     `ALTER DATABASE … SET RESULT_SET_CACHING { ON | OFF }` and reflects the
 *     live state from `sys.databases.is_result_set_caching_on`. No mocks.
 *
 * GET  → { ok, backend, gpu, resultSetCaching }
 * POST → { accelerate: boolean }  toggles result-set caching on the live pool
 *        (Azure-native path), or returns the honest GPU disclosure gate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type WarehouseBackend = 'synapse-dedicated';

function backend(): WarehouseBackend {
  // Synapse Dedicated SQL pool is the only provisionable warehouse backend
  // (per no-fabric-dependency.md — the Fabric Warehouse backend is not built).
  return 'synapse-dedicated';
}

/**
 * GPU acceleration is a Fabric-warehouse-engine capability that Loom does NOT
 * provision (the Fabric backend is not built). The Azure-native warehouse
 * (Synapse Dedicated SQL) runs CPU batch-mode compute with no GPU, so we report
 * GPU honestly as unavailable and name Loom's Azure-native GPU-class answer
 * (Databricks Photon / a Databricks SQL warehouse) plus the real dedicated-pool
 * acceleration knob (result-set caching, below).
 */
function gpuStatus() {
  return {
    available: false as const,
    enabled: false as const,
    engine: 'synapse-dedicated' as const,
    detail:
      'The Azure-native warehouse (Synapse Dedicated SQL pool) runs CPU batch-mode ' +
      'columnar compute and has no GPU. Loom\'s Azure-native answer to Fabric\'s ' +
      'GPU-accelerated warehouse is Databricks Photon (a vectorized C++ engine) or a ' +
      'Databricks SQL warehouse for GPU-class throughput; on the dedicated pool, enable ' +
      'result-set caching below for real repeat-query acceleration.',
  };
}

/** Live result-set-caching state for the bound dedicated pool. */
async function readResultSetCaching(poolName: string): Promise<boolean | null> {
  try {
    const r = await executeQuery(
      dedicatedTarget(),
      `SELECT is_result_set_caching_on FROM sys.databases WHERE name = '${escapeSqlLiteral(poolName)}'`,
    );
    if (!r.rows.length) return null;
    return Boolean(r.rows[0][0]);
  } catch {
    return null;
  }
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const poolName = process.env.LOOM_SYNAPSE_DEDICATED_POOL || '';
  const state = await getPoolState().catch(() => null);
  const online = state?.state === 'Online';

  const resultSetCaching =
    online && poolName ? await readResultSetCaching(poolName) : null;

  return NextResponse.json({
    ok: true,
    backend: backend(),
    warehouse: poolName || null,
    sku: state?.sku || null,
    poolState: state?.state || 'Unknown',
    gpu: gpuStatus(),
    resultSetCaching: {
      // Real Azure-native acceleration knob. null = pool offline / unreadable.
      enabled: resultSetCaching,
      supported: true,
      detail:
        'Result-set caching stores query results so repeat queries return from cache without re-execution — the Azure-native query-acceleration parity for the Synapse Dedicated SQL pool.',
    },
  });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const accelerate = body?.accelerate === true;
  const tier = (body?.tier || 'result-set-caching').toString();

  // GPU tier is not available on the Azure-native warehouse — honest disclosure
  // gate (never silently no-op a control). Loom's GPU-class answer is Databricks
  // Photon / a Databricks SQL warehouse (see gpu.detail).
  if (tier === 'gpu') {
    const gpu = gpuStatus();
    return NextResponse.json(
      {
        ok: false,
        code: 'gpu_unavailable',
        error:
          'GPU-accelerated query execution is not available on the Azure-native warehouse. ' + gpu.detail,
        gpu,
      },
      { status: 409 },
    );
  }

  // Azure-native: result-set caching ALTER DATABASE on the live pool.
  const poolName = process.env.LOOM_SYNAPSE_DEDICATED_POOL;
  if (!poolName) {
    return NextResponse.json(
      {
        ok: false,
        code: 'no_pool',
        error:
          'Warehouse compute is not configured. Set LOOM_SYNAPSE_DEDICATED_POOL (and LOOM_SYNAPSE_WORKSPACE) to the backing Synapse Dedicated SQL pool.',
      },
      { status: 409 },
    );
  }

  const state = await getPoolState().catch(() => null);
  if (!state || state.state !== 'Online') {
    return NextResponse.json(
      {
        ok: false,
        code: 'pool_offline',
        error: `Warehouse compute is ${state?.state || 'Unknown'}. Resume the Synapse Dedicated SQL pool, then toggle acceleration.`,
        poolState: state?.state || 'Unknown',
      },
      { status: 409 },
    );
  }

  try {
    // ALTER DATABASE … SET RESULT_SET_CACHING { ON | OFF } is the dedicated-pool
    // statement; the pool name is a SQL identifier so it is bracket-quoted, not
    // a bind parameter (DDL identifiers cannot be parameterized).
    const safePool = poolName.replace(/]/g, ']]');
    await executeQuery(
      dedicatedTarget(),
      `ALTER DATABASE [${safePool}] SET RESULT_SET_CACHING ${accelerate ? 'ON' : 'OFF'};`,
    );
    const enabled = await readResultSetCaching(poolName);
    return NextResponse.json({
      ok: true,
      tier: 'result-set-caching',
      enabled: enabled ?? accelerate,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, code: 'alter_failed', error: e?.message || String(e) },
      { status: 502 },
    );
  }
}
