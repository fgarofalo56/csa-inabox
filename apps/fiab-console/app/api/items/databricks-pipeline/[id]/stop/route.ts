/**
 * POST /api/items/databricks-pipeline/[id]/stop
 * body { pipelineId }
 * Requests the active DLT update to stop. Shared bound workspace resolved by
 * item TYPE.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiBadRequest, apiError } from '@/lib/api/respond';
import { databricksConfigGate, stopDltUpdate } from '@/lib/azure/databricks-client';

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
  if (!pipelineId) return apiBadRequest('pipelineId is required');

  try {
    await stopDltUpdate(pipelineId);
    return apiOk({ stopped: true });
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
}
