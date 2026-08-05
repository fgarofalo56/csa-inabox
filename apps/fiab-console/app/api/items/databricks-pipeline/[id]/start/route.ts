/**
 * POST /api/items/databricks-pipeline/[id]/start
 * body { pipelineId, fullRefresh? }
 * Triggers a DLT pipeline update; returns the real update_id.
 *
 * #2996 — ran on `getSession()` alone and started a caller-supplied pipeline id,
 * so any signed-in user could trigger another tenant's DLT pipeline (and with
 * `fullRefresh` force a full recompute of their tables). WRITE-scoped — the body
 * executes — with the pipelineId bound to the item (`_lib/pipeline-scope.ts`).
 * `databricksConfigGate()` below is a CONFIG gate, not an authorization one.
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/respond';
import { databricksConfigGate, startDltUpdate } from '@/lib/azure/databricks-client';
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
  const fullRefresh = body?.fullRefresh === true;

  try {
    const { update_id } = await startDltUpdate(bound.pipelineId, fullRefresh);
    return apiOk({ update_id, fullRefresh }, { status: 202 });
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
}
