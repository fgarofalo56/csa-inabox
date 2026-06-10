/**
 * Spark / compute configuration — Pool tab (F13).
 *
 *   GET    /api/admin/workspaces/[id]/spark/pools
 *            → { ok, pools: InstancePool[], config: WorkspaceSparkConfig['pool'] }
 *   POST   /api/admin/workspaces/[id]/spark/pools
 *            body { action: 'create', spec: InstancePoolCreateSpec }
 *                   → real Databricks /api/2.0/instance-pools/create, then records
 *                     the pool id on the workspace's Cosmos config (mode='custom')
 *            body { action: 'select', instance_pool_id, instance_pool_name? }
 *                   → pin the workspace to an existing pool (mode='custom')
 *            body { action: 'starter' }
 *                   → use the pre-warmed starter path (mode='starter', clears pin)
 *   DELETE /api/admin/workspaces/[id]/spark/pools?poolId=...
 *            → real Databricks /api/2.0/instance-pools/delete + clears the pin if it
 *              matched
 *
 * Azure-native default (Databricks); no Microsoft Fabric dependency. Honest 503
 * gate when LOOM_DATABRICKS_HOSTNAME is unset or the cloud has no Databricks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  sparkConfigGate,
  getSparkConfig,
  upsertSparkConfig,
  listPools,
  createPool,
  deletePool,
} from '@/lib/clients/spark-config-client';
import type { InstancePoolCreateSpec } from '@/lib/clients/spark-config-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauth() {
  return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
}

function gated() {
  const g = sparkConfigGate();
  if (!g) return null;
  return NextResponse.json(
    { ok: false, gated: true, code: g.code, error: g.message, missing: g.missing },
    { status: 503 },
  );
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return unauth();
  const g = gated();
  if (g) return g;
  const { id } = await ctx.params;
  try {
    const [pools, config] = await Promise.all([listPools(), getSparkConfig(id)]);
    return NextResponse.json({ ok: true, pools, config: config.pool });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return unauth();
  const g = gated();
  if (g) return g;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    action?: 'create' | 'select' | 'starter';
    spec?: InstancePoolCreateSpec;
    instance_pool_id?: string;
    instance_pool_name?: string;
  };
  try {
    if (body.action === 'create') {
      if (!body.spec?.instance_pool_name || !body.spec?.node_type_id) {
        return NextResponse.json(
          { ok: false, error: 'spec.instance_pool_name and spec.node_type_id are required' },
          { status: 400 },
        );
      }
      const created = await createPool(body.spec);
      const config = await upsertSparkConfig(
        id,
        {
          pool: {
            mode: 'custom',
            instance_pool_id: created.instance_pool_id,
            instance_pool_name: body.spec.instance_pool_name,
            node_type_id: body.spec.node_type_id,
            min_idle_instances: body.spec.min_idle_instances,
            max_capacity: body.spec.max_capacity,
            idle_instance_autotermination_minutes:
              body.spec.idle_instance_autotermination_minutes,
            availability: body.spec.azure_attributes?.availability,
          },
        },
        s.claims?.oid,
      );
      return NextResponse.json({
        ok: true,
        instance_pool_id: created.instance_pool_id,
        config: config.pool,
      });
    }
    if (body.action === 'select') {
      if (!body.instance_pool_id) {
        return NextResponse.json({ ok: false, error: 'instance_pool_id required' }, { status: 400 });
      }
      const config = await upsertSparkConfig(
        id,
        {
          pool: {
            mode: 'custom',
            instance_pool_id: body.instance_pool_id,
            instance_pool_name: body.instance_pool_name,
          },
        },
        s.claims?.oid,
      );
      return NextResponse.json({ ok: true, config: config.pool });
    }
    if (body.action === 'starter') {
      const config = await upsertSparkConfig(
        id,
        { pool: { mode: 'starter', instance_pool_id: undefined, instance_pool_name: undefined } },
        s.claims?.oid,
      );
      return NextResponse.json({ ok: true, config: config.pool });
    }
    return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return unauth();
  const g = gated();
  if (g) return g;
  const { id } = await ctx.params;
  const poolId = req.nextUrl.searchParams.get('poolId');
  if (!poolId) return NextResponse.json({ ok: false, error: 'poolId required' }, { status: 400 });
  try {
    await deletePool(poolId);
    // If the workspace was pinned to this pool, revert to the starter path.
    const current = await getSparkConfig(id);
    if (current.pool.instance_pool_id === poolId) {
      await upsertSparkConfig(
        id,
        { pool: { mode: 'starter', instance_pool_id: undefined, instance_pool_name: undefined } },
        s.claims?.oid,
      );
    }
    return NextResponse.json({ ok: true, deleted: poolId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
