/**
 * POST /api/items/databricks-pipeline/[id]/start
 * body { pipelineId, fullRefresh? }
 * Triggers a DLT pipeline update; returns the real update_id. Shared bound
 * workspace resolved by item TYPE.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiBadRequest, apiError } from '@/lib/api/respond';
import { databricksConfigGate, startDltUpdate } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const g = databricksConfigGate();
  if (g) {
    return apiError(`No Databricks workspace is wired. Set ${g.missing} on the Loom Console.`, 503, {
      code: 'not_configured',
      missing: g.missing,
    });
  }

  const body = await req.json().catch(() => ({}));
  const pipelineId = (body?.pipelineId || '').toString().trim();
  const fullRefresh = body?.fullRefresh === true;
  if (!pipelineId) return apiBadRequest('pipelineId is required');

  try {
    const { update_id } = await startDltUpdate(pipelineId, fullRefresh);
    return apiOk({ update_id, fullRefresh }, { status: 202 });
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
}
