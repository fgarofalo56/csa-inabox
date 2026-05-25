/**
 * GET  /api/items/synapse-spark-pool/[id]/state — provisioning state + auto-scale config
 * POST /api/items/synapse-spark-pool/[id]/state — { action: 'pause' | 'resume' }
 *
 * Synapse Spark pools auto-pause based on the pool's autoPause.delayInMinutes
 * setting; there is no explicit start/stop verb on the ARM surface. "pause"
 * therefore sets autoPause.delayInMinutes=1 (effectively forces shutdown);
 * "resume" sets autoPause.delayInMinutes=15 (default) and submits a no-op
 * batch to warm. For now we mutate the autoPause property and surface
 * provisioningState.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getSparkPool, upsertSparkPool } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const pool = await getSparkPool(ctx.params.id);
    return NextResponse.json({
      ok: true,
      name: pool.name,
      provisioningState: pool.properties.provisioningState || 'Unknown',
      nodeSize: pool.properties.nodeSize,
      sparkVersion: pool.properties.sparkVersion,
      autoScale: pool.properties.autoScale,
      autoPause: pool.properties.autoPause,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  if (action !== 'pause' && action !== 'resume') {
    return NextResponse.json({ error: 'action must be pause or resume' }, { status: 400 });
  }
  try {
    const pool = await getSparkPool(ctx.params.id);
    const updated = {
      location: pool.location || 'eastus2',
      properties: {
        ...pool.properties,
        autoPause: {
          enabled: true,
          delayInMinutes: action === 'pause' ? 1 : (pool.properties.autoPause?.delayInMinutes || 15),
        },
      },
    };
    await upsertSparkPool(ctx.params.id, updated);
    return NextResponse.json({ ok: true, action, autoPause: updated.properties.autoPause });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
