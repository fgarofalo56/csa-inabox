/**
 * POST /api/items/synapse-spark-pool/[id]/scale
 *
 * Body: { nodeCount?: number, autoScale?: { enabled, minNodeCount, maxNodeCount } }
 * One of nodeCount OR autoScale is required. PATCHes the ARM Synapse
 * bigDataPools resource — the Synapse RP applies the new scale without
 * requiring the full pool body.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { scaleSparkPool } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const nodeCount = typeof body?.nodeCount === 'number' ? body.nodeCount : undefined;
  const autoScale = body?.autoScale && typeof body.autoScale === 'object'
    ? {
        enabled: !!body.autoScale.enabled,
        minNodeCount: Number(body.autoScale.minNodeCount),
        maxNodeCount: Number(body.autoScale.maxNodeCount),
      }
    : undefined;

  if (nodeCount == null && !autoScale) {
    return NextResponse.json({ ok: false, error: 'nodeCount or autoScale required' }, { status: 400 });
  }
  if (autoScale && (!Number.isFinite(autoScale.minNodeCount) || !Number.isFinite(autoScale.maxNodeCount) || autoScale.minNodeCount < 3 || autoScale.maxNodeCount < autoScale.minNodeCount)) {
    return NextResponse.json({ ok: false, error: 'autoScale.minNodeCount must be ≥3 and ≤ maxNodeCount' }, { status: 400 });
  }
  if (nodeCount != null && (!Number.isFinite(nodeCount) || nodeCount < 3)) {
    return NextResponse.json({ ok: false, error: 'nodeCount must be ≥3' }, { status: 400 });
  }

  try {
    const pool = await scaleSparkPool(ctx.params.id, {
      nodeCount,
      autoScale,
      location: typeof body?.location === 'string' ? body.location : undefined,
    });
    return NextResponse.json({ ok: true, pool });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
