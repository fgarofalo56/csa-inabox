/**
 * POST /api/items/databricks-pipeline/[id]/stop
 * body { pipelineId }
 * Requests the active DLT update to stop.
 *
 * #2996 — ran on `getSession()` alone against a caller-supplied pipeline id, so
 * any signed-in user could halt another tenant's running pipeline. WRITE-scoped
 * (it mutates run state) with the pipelineId bound to the item.
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/respond';
import { databricksConfigGate, stopDltUpdate } from '@/lib/azure/databricks-client';
import {
  authorizeDatabricksPipelineItem,
  resolveAuthorizedPipelineId,
} from '../../_lib/pipeline-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const { item, denied } = await authorizeDatabricksPipelineItem(id, {
    workspaceId: typeof body?.workspaceId === 'string' ? body.workspaceId : null,
  });
  if (denied) return denied;

  const g = databricksConfigGate();
  if (g) {
    return apiError(`No Databricks workspace is wired. Set ${g.missing} on the Loom Console.`, 503, {
      code: 'not_configured',
      missing: g.missing,
    });
  }

  const bound = await resolveAuthorizedPipelineId(item, id, body?.pipelineId);
  if (!bound.ok) return apiError(bound.error, bound.status);

  try {
    await stopDltUpdate(bound.pipelineId);
    return apiOk({ stopped: true });
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
}
