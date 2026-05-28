/**
 * GET /api/items/synapse-spark-pool/[id]   — return pool config
 * PUT /api/items/synapse-spark-pool/[id]   — update pool config (autoscale, node size, version)
 *
 * The `id` segment is the pool name in the workspace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getSparkPool, upsertSparkPool } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const pool = await getSparkPool((await ctx.params).id);
    return NextResponse.json({ ok: true, pool });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    const pool = await upsertSparkPool((await ctx.params).id, body);
    return NextResponse.json({ ok: true, pool });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
