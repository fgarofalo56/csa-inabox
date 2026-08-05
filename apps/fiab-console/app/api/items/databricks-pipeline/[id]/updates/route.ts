/**
 * GET /api/items/databricks-pipeline/[id]/updates?pipelineId=&max=
 * The DLT pipeline's run/update history (one update per Start).
 *
 * #2996 — ran on `getSession()` alone against a caller-supplied pipeline id, so
 * any signed-in user could read another tenant's pipeline run history.
 * READ-scoped: the body is a single `pipelines/{id}/updates` GET and writes
 * nothing (decided from the BODY, not the verb — #2973).
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/respond';
import { databricksConfigGate, getDltPipelineUpdates } from '@/lib/azure/databricks-client';
import {
  authorizeDatabricksPipelineItem,
  resolveAuthorizedPipelineId,
} from '../../_lib/pipeline-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorizeDatabricksPipelineItem(id, {
    workspaceId: req.nextUrl.searchParams.get('workspaceId'),
    read: true,
  });
  if (denied) return denied;

  const g = databricksConfigGate();
  if (g) {
    return apiError(`No Databricks workspace is wired. Set ${g.missing} on the Loom Console.`, 503, {
      code: 'not_configured',
      missing: g.missing,
    });
  }

  const bound = await resolveAuthorizedPipelineId(item, id, req.nextUrl.searchParams.get('pipelineId'));
  if (!bound.ok) return apiError(bound.error, bound.status);
  const max = Number(req.nextUrl.searchParams.get('max')) || 25;

  try {
    const updates = await getDltPipelineUpdates(bound.pipelineId, max);
    return apiOk({ updates });
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
}
