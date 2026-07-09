/**
 * POST /api/items/adf-pipeline/[id]/debug — debug-run the bound pipeline.
 * body: { params?: { ... } }
 *
 * Maps to ADF createRun (isRecovery=false) via adf-client.debugPipeline so the
 * run surfaces under the Debug invocation in run history. Real ARM REST.
 *
 * `[id]` is the Loom item GUID; the Azure pipeline name is resolved from the
 * item's state.pipelineName binding. 412 when unbound.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { debugPipeline } from '@/lib/azure/adf-client';
import { withFactoryOverride } from '@/lib/azure/adf-factory-context';
import { resolveBinding, bindingErrorResponse, bindingFactoryOverride } from '@/lib/azure/pipeline-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Accept the aliased persist form ('data-pipeline') alongside the native type —
// see pipeline-binding.ts loadPipelineItem for why.
const ACCEPTED_TYPES = ['adf-pipeline', 'data-pipeline'];

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  let binding: Awaited<ReturnType<typeof resolveBinding>>;
  try {
    binding = await resolveBinding(id, ACCEPTED_TYPES, session.claims.oid);
  } catch (e) {
    const { status, body: errBody } = bindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
  const { pipelineName } = binding;
  // Debug-run against the SAME factory the item was bound against.
  return withFactoryOverride(bindingFactoryOverride(binding), async () => {
    try {
      const res = await debugPipeline(pipelineName, body?.params || {});
      return NextResponse.json({ ok: true, boundTo: pipelineName, ...res });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  });
}
