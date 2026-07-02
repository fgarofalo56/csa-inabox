/**
 * POST /api/items/data-pipeline/[id]/validate?workspaceId=...
 *   body: { definition?: { properties: {...} } }  // in-flight canvas payload
 *
 * Runs a REAL server-side structural validation of the pipeline definition —
 * the same class of checks ADF / Fabric Studio's "Validate" performs before a
 * pipeline can run: activity name uniqueness + types, dependsOn references
 * resolve, dependency conditions are legal, the dependency graph is acyclic,
 * and @pipeline().parameters / variables() references are declared.
 *
 * WHY NOT AN ADF REST CALL: the Azure Data Factory MANAGEMENT REST API does
 * NOT expose a public "validate pipeline" action — there is no
 * `factories/{f}/validatePipeline` or `pipelines/{name}/validate` endpoint
 * (the `Validate()` methods on Learn are client-SDK object validators, and the
 * Studio "Validate all" button is Studio-internal). Calling such a URL 404s.
 * So per no-vaporware.md we implement the validation server-side here — a real
 * backend computation over the posted definition, not a client-only pretense —
 * rather than claim an ADF REST round-trip that does not exist.
 *
 * Returns the structured {ok, data, error} contract. ok=true when there are no
 * structural errors (warnings do not fail validation).
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { validatePipelineSpec } from '@/lib/azure/pipeline-validate';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export async function POST(req: NextRequest, ctx: { params: { id: string } | Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);

  const params = await Promise.resolve(ctx.params);
  const body = await req.json().catch(() => ({} as any));

  // Resolve the definition to validate. Prefer the in-flight canvas payload the
  // editor POSTs; otherwise fall back to the persisted Cosmos definition so
  // Validate also works on a freshly-loaded, unedited pipeline.
  let definition = body?.definition;
  if (!definition) {
    try {
      const items = await itemsContainer();
      const { resource } = await items.item(params.id, workspaceId).read<WorkspaceItem>();
      if (!resource || resource.itemType !== 'data-pipeline') return apiError('pipeline not found', 404);
      definition = (resource.state as any)?.definition || (resource.state as any)?.content || { properties: { activities: [] } };
    } catch (e: any) {
      return apiError(e?.message || String(e), e?.status || 502);
    }
  }

  try {
    const result = validatePipelineSpec(definition);
    return NextResponse.json({
      ok: result.ok,
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
    return apiError(e?.message || String(e), 500);
  }
}
