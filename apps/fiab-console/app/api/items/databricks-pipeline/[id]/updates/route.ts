/**
 * GET /api/items/databricks-pipeline/[id]/updates?pipelineId=&max=
 * The DLT pipeline's run/update history (one update per Start). Shared bound
 * workspace resolved by item TYPE.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiBadRequest, apiError } from '@/lib/api/respond';
import { databricksConfigGate, getDltPipelineUpdates } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const g = databricksConfigGate();
  if (g) {
    return apiError(`No Databricks workspace is wired. Set ${g.missing} on the Loom Console.`, 503, {
      code: 'not_configured',
      missing: g.missing,
    });
  }

  const pipelineId = req.nextUrl.searchParams.get('pipelineId');
  if (!pipelineId) return apiBadRequest('pipelineId is required');
  const max = Number(req.nextUrl.searchParams.get('max')) || 25;

  try {
    const updates = await getDltPipelineUpdates(pipelineId, max);
    return apiOk({ updates });
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
}
