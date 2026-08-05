/**
 * GET /api/items/databricks-pipeline/[id]/pipelines
 * Lists the Lakeflow Declarative Pipelines (DLT) in the bound Databricks
 * workspace — the picker the DLT editor opens with.
 *
 * #2996 — LAYER 1 ONLY, deliberately, and the residual is disclosed rather than
 * hidden. The caller is now authorized against the pipeline ITEM (read-scoped),
 * so an unrelated signed-in user can no longer enumerate anything. What this
 * does NOT do is scope the returned LIST per row: `pipelines/list` returns only
 * `{ pipeline_id, name, state, creator_user_name, catalog, target }` and carries
 * no `configuration`, so Loom's `loom_item_id` ownership marker is not present
 * on a list row. Filtering by owner would need one `pipelines/{id}` GET per row
 * — an N+1 against Databricks on every editor open.
 *
 * RESIDUAL: an authorized owner of ANY `databricks-pipeline` item can still see
 * the NAMES and states of every DLT pipeline in the shared workspace. That is
 * metadata disclosure, not access: every route that ACTS on a pipeline
 * (`spec`, `start`, `stop`, `updates`, `events`) binds the id to the item, so a
 * name learned here cannot be driven. Tracked as a follow-up — the real fix is a
 * Loom-side pipeline index so the picker never calls the workspace-wide list.
 *
 * Honest-gates (503 `not_configured`) with the exact env var to set when no
 * Databricks workspace is wired.
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/respond';
import { databricksConfigGate, listDltPipelines } from '@/lib/azure/databricks-client';
import { authorizeDatabricksPipelineItem } from '../../_lib/pipeline-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { denied } = await authorizeDatabricksPipelineItem(id, {
    workspaceId: req.nextUrl.searchParams.get('workspaceId'),
    read: true,
  });
  if (denied) return denied;

  const gate = databricksConfigGate();
  if (gate) {
    return apiError(
      `No Databricks workspace is wired. Set ${gate.missing} on the Loom Console to author Lakeflow Declarative Pipelines, or use the Azure-native Data pipeline item.`,
      503,
      { code: 'not_configured', missing: gate.missing },
    );
  }

  try {
    const pipelines = await listDltPipelines();
    return apiOk({ pipelines });
  } catch (e: any) {
    // Upstream Databricks failure (502 passthrough — not a literal-500 leak).
    return apiError(e?.message || String(e), 502);
  }
}
