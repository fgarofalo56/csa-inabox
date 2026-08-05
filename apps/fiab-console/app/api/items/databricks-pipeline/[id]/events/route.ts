/**
 * GET /api/items/databricks-pipeline/[id]/events?pipelineId=&max=
 * The DLT pipeline event log (info/warn/error rows incl. expectation
 * data-quality metrics).
 *
 * #2996 — ran on `getSession()` alone against a caller-supplied pipeline id. The
 * event log is not merely metadata: `flow_progress.data_quality` carries per-
 * expectation row counts, and ERROR rows carry the pipeline's own failure
 * messages, so this leaked another tenant's data-quality profile. READ-scoped:
 * the body is a single `pipelines/{id}/events` GET.
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/respond';
import { databricksConfigGate, getDltPipelineEvents } from '@/lib/azure/databricks-client';
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
  const max = Number(req.nextUrl.searchParams.get('max')) || 100;

  try {
    const events = await getDltPipelineEvents(bound.pipelineId, max);
    return apiOk({ events });
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
}
