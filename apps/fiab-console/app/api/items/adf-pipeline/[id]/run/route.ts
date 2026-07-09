/**
 * POST /api/items/adf-pipeline/[id]/run — invoke the bound pipeline.
 * body: { params?: { ... } }
 *
 * `[id]` is the Loom item GUID; the real Azure pipeline name comes from the
 * item's state.pipelineName binding (resolveBinding). 412 when unbound.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { runPipeline } from '@/lib/azure/adf-client';
import { withFactoryOverride } from '@/lib/azure/adf-factory-context';
import { prewarmShirForPipeline } from '@/lib/azure/shir-autoscale';
import { resolveBinding, bindingErrorResponse, bindingFactoryOverride } from '@/lib/azure/pipeline-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  let binding: Awaited<ReturnType<typeof resolveBinding>>;
  try {
    binding = await resolveBinding(id, 'adf-pipeline', session.claims.oid);
  } catch (e) {
    const { status, body: errBody } = bindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
  const { pipelineName } = binding;
  // Target the SAME factory the item was bound against (persisted at bind time),
  // so the run — and the SHIR pre-warm — hit the selected factory, not the env
  // default. Absent selection → env default (unchanged).
  return withFactoryOverride(bindingFactoryOverride(binding), async () => {
    try {
      // Scale the SHIR VMSS up first if this pipeline runs on a Self-Hosted IR.
      const shir = await prewarmShirForPipeline(pipelineName);
      const res = await runPipeline(pipelineName, body?.params || {});
      return NextResponse.json({ ok: true, boundTo: pipelineName, ...res, ...(shir || {}) });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  });
}
