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
 * All calls honest-gate (503 `not_configured`) when no Databricks workspace is
 * wired. Operates on the shared bound workspace resolved by item TYPE — the
 * pipelineId is a Databricks id, not a per-tenant Cosmos item.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiBadRequest, apiError, apiServerError } from '@/lib/api/respond';
import { databricksConfigGate, getDltPipeline, createDltPipelineFromSql } from '@/lib/azure/databricks-client';
import {
  compileDltSql,
  compileDltPipelineSpec,
  validateDltModel,
  parseLibraryGraph,
  type DltPipelineModel,
} from '@/lib/editors/databricks/dlt-spec';

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

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const blocked = gate();
  if (blocked) return blocked;

  const pipelineId = req.nextUrl.searchParams.get('pipelineId');
  if (!pipelineId) return apiBadRequest('pipelineId is required');

  try {
    const pipeline = await getDltPipeline(pipelineId);
    const graph = parseLibraryGraph((pipeline as { spec?: unknown }).spec as any);
    return apiOk({ pipeline, graph });
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const blocked = gate();
  if (blocked) return blocked;

  const body = await req.json().catch(() => ({}));
  const model = body?.model as DltPipelineModel | undefined;
  if (!model || typeof model !== 'object') return apiBadRequest('model is required');

  const problems = validateDltModel(model);
  if (problems.length) {
    return apiError(`Pipeline model is invalid: ${problems.join(' ')}`, 400, { problems });
  }

  try {
    const sql = compileDltSql(model);
    // Import target: a stable per-pipeline path under a Shared Loom folder.
    const safeName = (model.name || 'pipeline').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
    const libraryPath = `/Shared/loom-dlt/${safeName}`;
    const spec = compileDltPipelineSpec(model, libraryPath);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { libraries, ...specNoLibs } = spec;
    const created = await createDltPipelineFromSql(specNoLibs, libraryPath, sql);
    return apiOk({ pipeline_id: created.pipeline_id, libraryPath: created.libraryPath, sql });
  } catch (e: any) {
    // Honest-gate typed errors would carry their own message; a raw Databricks
    // REST failure is genericized (no 500 leak).
    return apiServerError(e, 'Failed to create the DLT pipeline.', 'dlt_create_failed');
  }
}
