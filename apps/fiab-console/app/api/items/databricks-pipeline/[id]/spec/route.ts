/**
 * GET  /api/items/databricks-pipeline/[id]/spec?pipelineId=
 *      → the full pipeline spec + latest state, plus a derived render graph
 *        (library nodes + target) for the canvas.
 *
 * POST /api/items/databricks-pipeline/[id]/spec
 *      body { model }  — compile the canvas DLT model to real DLT SQL, import it
 *      as a workspace notebook, and create the pipeline via POST /api/2.0/
 *      pipelines. Returns { pipeline_id, libraryPath, sql }.
 *
 * #2996 — BOTH handlers authorize the caller against the pipeline ITEM and bind
 * every coordinate they act on. `databricksConfigGate()` below is a CONFIG gate,
 * not an authorization one — it reads like a guard and is not one, which is how
 * this route family survived audit. See `_lib/pipeline-scope.ts` for the two
 * layers, and `_lib/databricks-resource-binding.ts` for why the pipeline id
 * recorded on the item is a client-writable claim rather than an attestation.
 *
 * The POST's write target is no longer caller-influenced: it derives from the
 * ITEM (`/Shared/loom-dlt/<item>/<name>`), which is what removes the
 * shared-path-with-overwrite clobber. All calls honest-gate (503
 * `not_configured`) when no Databricks workspace is wired.
 */

import { NextRequest } from 'next/server';
import { apiOk, apiBadRequest, apiError, apiServerError } from '@/lib/api/respond';
import { databricksConfigGate, getDltPipeline, createDltPipelineFromSql } from '@/lib/azure/databricks-client';
import {
  compileDltSql,
  compileDltPipelineSpec,
  validateDltModel,
  parseLibraryGraph,
  type DltPipelineModel,
} from '@/lib/editors/databricks/dlt-spec';
import {
  authorizeDatabricksPipelineItem,
  resolveAuthorizedPipelineId,
  pipelineLibraryPath,
  ownerConfiguration,
} from '../../_lib/pipeline-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = databricksConfigGate();
  if (!g) return null;
  return apiError(
    `No Databricks workspace is wired. Set ${g.missing} on the Loom Console to author Lakeflow Declarative Pipelines.`,
    503,
    { code: 'not_configured', missing: g.missing },
  );
}

/**
 * READ-scoped: the body performs a single `pipelines/{id}` GET and derives a
 * render graph from the response. No Databricks state is written, so a Viewer
 * may open the canvas. Decided from the BODY, not the verb (#2973).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorizeDatabricksPipelineItem(id, {
    workspaceId: req.nextUrl.searchParams.get('workspaceId'),
    read: true,
  });
  if (denied) return denied;
  const blocked = gate();
  if (blocked) return blocked;

  const bound = await resolveAuthorizedPipelineId(item, id, req.nextUrl.searchParams.get('pipelineId'));
  if (!bound.ok) return apiError(bound.error, bound.status);

  try {
    const pipeline = await getDltPipeline(bound.pipelineId);
    const graph = parseLibraryGraph((pipeline as { spec?: unknown }).spec as any);
    return apiOk({ pipeline, graph });
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
}

/**
 * WRITE-scoped: the body imports a notebook into the Databricks workspace and
 * creates a pipeline that executes it. `allowReadRoles` is deliberately not
 * passed — a read-only Viewer must never plant executable code.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const { denied } = await authorizeDatabricksPipelineItem(id, {
    workspaceId: typeof body?.workspaceId === 'string' ? body.workspaceId : null,
  });
  if (denied) return denied;
  const blocked = gate();
  if (blocked) return blocked;

  const model = body?.model as DltPipelineModel | undefined;
  if (!model || typeof model !== 'object') return apiBadRequest('model is required');

  const problems = validateDltModel(model);
  if (problems.length) {
    return apiError(`Pipeline model is invalid: ${problems.join(' ')}`, 400, { problems });
  }

  try {
    const sql = compileDltSql(model);
    // The import target derives from the AUTHORIZED ITEM, never from the
    // request. `model.name` still supplies the readable leaf but is sanitised
    // inside `pipelineLibraryPath` and cannot escape the item's own folder — so
    // `overwrite=true` can only ever replace this item's own previous compile.
    const libraryPath = pipelineLibraryPath(id, model.name);
    const spec = compileDltPipelineSpec(model, libraryPath);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { libraries, ...specNoLibs } = spec;
    // Stamp ownership LAST so a caller-supplied `model.configuration` cannot
    // overwrite the marker every other route in this family authorizes against.
    const owned = { ...specNoLibs, configuration: ownerConfiguration(id, specNoLibs.configuration) };
    const created = await createDltPipelineFromSql(owned, libraryPath, sql);
    return apiOk({ pipeline_id: created.pipeline_id, libraryPath: created.libraryPath, sql });
  } catch (e: any) {
    // Honest-gate typed errors would carry their own message; a raw Databricks
    // REST failure is genericized (no 500 leak).
    return apiServerError(e, 'Failed to create the DLT pipeline.', 'dlt_create_failed');
  }
}
