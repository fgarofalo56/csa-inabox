/**
 * POST /api/items/adf-pipeline/[id]/validate — validate the bound pipeline
 * against ADF's syntactic + reference checker.
 *
 * body: { definition?: { name?, properties } }
 *   - with a body → validate the in-memory payload (validatePipeline by value)
 *   - without     → validate the persisted pipeline
 *
 * `[id]` is the Loom item GUID; the Azure pipeline name is resolved from the
 * item's state.pipelineName binding. 412 when unbound. Real ARM REST via
 * adf-client.validatePipeline — surfaces ADF's structured error verbatim.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { validatePipeline, type AdfPipeline } from '@/lib/azure/adf-client';
import { resolveBinding, bindingErrorResponse } from '@/lib/azure/pipeline-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let pipelineName: string;
  try {
    ({ pipelineName } = await resolveBinding(id, 'adf-pipeline', session.claims.oid));
  } catch (e) {
    const { status, body } = bindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const body = await req.json().catch(() => ({}));
  try {
    const spec: AdfPipeline | undefined = body?.definition?.properties
      ? { name: body.definition.name || pipelineName, properties: body.definition.properties }
      : undefined;
    const res = await validatePipeline(pipelineName, spec);
    if (!res.ok) {
      const msg = res.body?.error?.message || res.errorText || `validation failed (${res.status})`;
      return NextResponse.json({ ok: false, error: msg, status: res.status }, { status: 200 });
    }
    return NextResponse.json({ ok: true, validation: res.body, boundTo: pipelineName });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
