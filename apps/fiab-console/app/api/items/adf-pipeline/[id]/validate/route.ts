/**
 * POST /api/items/adf-pipeline/[id]/validate — validate the bound pipeline's
 * structure.
 *
 * body: { definition?: { name?, properties } }
 *   - with a body → validate the in-flight payload (the editor's canvas)
 *   - without     → validate the persisted pipeline definition
 *
 * `[id]` is the Loom item GUID; the Azure pipeline name is resolved from the
 * item's state.pipelineName binding so the response can report `boundTo`.
 *
 * REAL backend: a server-side structural validation (activity names/types,
 * dependsOn references + conditions, DAG acyclicity, parameter/variable
 * references). The Azure Data Factory MANAGEMENT REST API exposes NO public
 * "validate pipeline" action — there is no `factories/{f}/validatePipeline`
 * or `pipelines/{name}/validate` endpoint to call (the SDK `Validate()` methods
 * are client-side object validators; "Validate all" in Studio is internal).
 * Per no-vaporware.md we therefore compute the verdict server-side here instead
 * of claiming an ADF REST round-trip that does not exist.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { validatePipelineSpec } from '@/lib/azure/pipeline-validate';
import { resolveBinding, bindingErrorResponse } from '@/lib/azure/pipeline-binding';
import { getPipeline } from '@/lib/azure/adf-client';

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
  const body = await req.json().catch(() => ({} as any));
  try {
    // In-flight canvas payload, or the persisted ADF pipeline definition.
    let definition = body?.definition;
    if (!definition) {
      const persisted = await getPipeline(pipelineName).catch(() => null);
      definition = persisted
        ? { name: persisted.name, properties: persisted.properties }
        : { properties: { activities: [] } };
    }
    const result = validatePipelineSpec(definition);
    return NextResponse.json({
      ok: result.ok,
      boundTo: pipelineName,
      validation: {
        activities: result.activities,
        issues: result.issues,
        errorCount: result.errorCount,
        warningCount: result.warningCount,
      },
      error: result.ok
        ? null
        : result.issues
            .filter((i) => i.severity === 'error')
            .map((i) => i.message)
            .join('; ') || 'Pipeline validation failed.',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
