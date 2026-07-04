/**
 * GET / POST /api/items/warehouse/[id]/query-acceleration
 *
 * Query acceleration for the Warehouse editor — the Azure-native parity of
 * Fabric's "GPU-accelerated warehouse" (Fabric Build 2026). Per
 * no-fabric-dependency.md this surface is 100% functional with
 * LOOM_DEFAULT_FABRIC_WORKSPACE UNSET, on the Synapse Dedicated SQL pool
 * (the DEFAULT warehouse backend). The two acceleration tiers are honest:
 *
 *   - GPU acceleration is a Fabric-engine-only capability. The Azure-native
 *     default (Synapse Dedicated SQL) runs on CPU batch-mode compute and has
 *     NO GPU. We do NOT pretend otherwise — `gpu.available` is true ONLY when
 *     the Fabric backend is explicitly opted into (LOOM_WAREHOUSE_BACKEND=
 *     fabric-warehouse + a bound Fabric workspace). Otherwise the toggle
 *     surfaces an honest gate naming exactly what's required.
 *
 *   - Result-set caching is the REAL Azure-native query-acceleration knob on
 *     the Synapse Dedicated SQL pool. The toggle issues a real
 *     `ALTER DATABASE … SET RESULT_SET_CACHING { ON | OFF }` and reflects the
 *     live state from `sys.databases.is_result_set_caching_on`. No mocks.
 *
 * GET  → { ok, backend, gpu, resultSetCaching }
 * POST → { accelerate: boolean }  toggles result-set caching on the live pool
 *        (Azure-native path), or returns the honest GPU gate (Fabric path).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type WarehouseBackend = 'synapse-dedicated' | 'fabric-warehouse';

function backend(): WarehouseBackend {
  return process.env.LOOM_WAREHOUSE_BACKEND === 'fabric-warehouse'
    ? 'fabric-warehouse'
    : 'synapse-dedicated';
}

/**
 * GPU acceleration is realized only by the Fabric warehouse engine, and only
 * when a capacity-backed Fabric workspace is bound. On the Azure-native default
 * we report it honestly as unavailable with the exact opt-in requirement.
 */
function gpuStatus() {
  const be = backend();
  const fabricWorkspace =
    process.env.LOOM_DEFAULT_FABRIC_WORKSPACE || process.env.LOOM_WAREHOUSE_FABRIC_WORKSPACE;
  if (be === 'fabric-warehouse' && fabricWorkspace) {
    return {
      available: true as const,
      enabled: true as const,
      engine: 'fabric' as const,
      detail:
        'GPU-accelerated query execution is served by the Fabric warehouse engine on the bound capacity.',
    };
  }
  return {
    available: false as const,
    enabled: false as const,
    engine: 'synapse-dedicated' as const,
    // Honest disclosure — Azure-native default has no GPU compute.
    detail:
      'The Azure-native default (Synapse Dedicated SQL pool) runs CPU batch-mode compute and has no GPU. ' +
      'GPU acceleration is a Fabric-engine capability — opt in by setting ' +
      'LOOM_WAREHOUSE_BACKEND=fabric-warehouse and binding a capacity-backed Fabric workspace ' +
      '(LOOM_WAREHOUSE_FABRIC_WORKSPACE). On the Azure-native path, enable result-set caching below for ' +
      'real query acceleration.',
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
      supported: backend() === 'synapse-dedicated',
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

  // GPU tier is Fabric-only. Honest gate — never silently no-op a control.
  if (tier === 'gpu') {
    const gpu = gpuStatus();
    if (!gpu.available) {
      return NextResponse.json(
        {
          ok: false,
          code: 'gpu_requires_fabric',
          error:
            'GPU acceleration requires the opt-in Fabric warehouse backend. ' + gpu.detail,
          gpu,
        },
        { status: 409 },
      );
    }
    // Fabric engine GPU acceleration is on by default when the backend is bound;
    // there is no per-warehouse on/off knob on the engine itself.
    return NextResponse.json({ ok: true, tier: 'gpu', enabled: true, gpu });
  }

  // Azure-native default: result-set caching ALTER DATABASE on the live pool.
  if (backend() !== 'synapse-dedicated') {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_supported_on_backend',
        error: `Result-set caching applies to the Synapse Dedicated SQL pool backend, not '${backend()}'.`,
      },
      { status: 409 },
    );
  }

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
