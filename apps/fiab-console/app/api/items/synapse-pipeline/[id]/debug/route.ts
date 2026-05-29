/**
 * POST /api/items/synapse-pipeline/[id]/debug
 *   body: { params?: { ... } }
 *
 * Invokes the bound pipeline in DEBUG mode (?isDebugRun=true). Equivalent to
 * Synapse Studio's Debug button: evaluates activities against the saved spec
 * but tags the run as a debug run for filtering in the run history.
 *
 * `[id]` is the Loom item GUID; the Azure pipeline name is resolved from the
 * item's state.pipelineName binding. 412 when unbound.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { debugPipeline } from '@/lib/azure/synapse-dev-client';
import { resolveBinding, bindingErrorResponse } from '@/lib/azure/pipeline-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  let pipelineName: string;
  try {
    ({ pipelineName } = await resolveBinding(id, 'synapse-pipeline', session.claims.oid));
  } catch (e) {
    const { status, body: errBody } = bindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
  try {
    const res = await debugPipeline(pipelineName, body?.params || {});
    return NextResponse.json({ ok: true, boundTo: pipelineName, ...res });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
