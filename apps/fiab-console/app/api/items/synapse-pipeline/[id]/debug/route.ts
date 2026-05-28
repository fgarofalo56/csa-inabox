/**
 * POST /api/items/synapse-pipeline/[id]/debug
 *   body: { params?: { ... } }
 *
 * Invokes the pipeline in DEBUG mode (?isDebugRun=true). Equivalent to
 * Synapse Studio's Debug button: evaluates activities against the saved
 * spec but tags the run as a debug run for filtering in the run history.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { debugPipeline } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    const res = await debugPipeline(ctx.params.id, body?.params || {});
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
