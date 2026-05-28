/**
 * POST /api/items/synapse-spark-pool/[id]/auto-pause
 *
 * Body: { enabled: boolean, delayInMinutes?: number }
 * Updates `properties.autoPause` via ARM PATCH. delayInMinutes is required
 * when enabled=true (Synapse min is 5).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { setSparkPoolAutoPause } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const enabled = !!body?.enabled;
  const delayInMinutes = typeof body?.delayInMinutes === 'number' ? body.delayInMinutes : undefined;
  if (enabled && (delayInMinutes == null || !Number.isFinite(delayInMinutes) || delayInMinutes < 5)) {
    return NextResponse.json({ ok: false, error: 'delayInMinutes ≥ 5 required when enabling auto-pause' }, { status: 400 });
  }

  try {
    const pool = await setSparkPoolAutoPause(ctx.params.id, {
      enabled,
      delayInMinutes,
      location: typeof body?.location === 'string' ? body.location : undefined,
    });
    return NextResponse.json({ ok: true, pool });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
