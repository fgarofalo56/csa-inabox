/**
 * /api/powerbi/datasources — semantic-model gateway binding + data sources.
 *
 *   GET  /api/powerbi/datasources?workspaceId=W&datasetId=D
 *          → { ok, datasources, boundGatewayDatasources, gateways }
 *            (Get Datasources + Get Bound Gateway Datasources + Discover Gateways)
 *   POST /api/powerbi/datasources  { workspaceId, datasetId, action:'bind',
 *            gatewayObjectId, datasourceObjectIds? }                    (BindToGateway)
 *   POST /api/powerbi/datasources  { workspaceId, datasetId, action:'updateDatasources',
 *            updateDetails:[...] }                                      (UpdateDatasources)
 *
 * Every call hits the real Power BI REST via powerbi-client.ts (no mocks).
 * Config-gate → 503; tenant 401/403 surfaced verbatim with the SP hint.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/datasets/bind-to-gateway-in-group
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  PowerBiError,
  powerbiConfigGate,
  POWERBI_SP_HINT,
  getDatasetDatasources,
  getBoundGatewayDatasources,
  discoverGateways,
  bindToGateway,
  updateDatasetDatasources,
  type UpdateDatasourceDetail,
} from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate(): NextResponse | null {
  const g = powerbiConfigGate();
  if (g) return NextResponse.json({ ok: false, code: 'not_configured', error: g.detail, missing: g.missing }, { status: 503 });
  return null;
}
function fail(e: unknown): NextResponse {
  const status = e instanceof PowerBiError ? e.status : 502;
  const message = e instanceof Error ? e.message : String(e);
  const hint = status === 401 || status === 403 ? POWERBI_SP_HINT : undefined;
  return NextResponse.json({ ok: false, error: message, hint }, { status: status >= 400 ? status : 502 });
}
function requireAuth(): NextResponse | null {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return null;
}

export async function GET(req: NextRequest) {
  const unauth = requireAuth(); if (unauth) return unauth;
  const g = gate(); if (g) return g;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')?.trim();
  const datasetId = req.nextUrl.searchParams.get('datasetId')?.trim();
  if (!workspaceId || !datasetId) {
    return NextResponse.json({ ok: false, error: 'workspaceId and datasetId query params are required' }, { status: 400 });
  }
  try {
    const [datasources, boundGatewayDatasources, gateways] = await Promise.all([
      getDatasetDatasources(workspaceId, datasetId),
      getBoundGatewayDatasources(workspaceId, datasetId),
      discoverGateways(workspaceId, datasetId),
    ]);
    return NextResponse.json({ ok: true, datasources, boundGatewayDatasources, gateways });
  } catch (e) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const unauth = requireAuth(); if (unauth) return unauth;
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({} as any));
  const workspaceId: string = (body?.workspaceId || '').trim();
  const datasetId: string = (body?.datasetId || '').trim();
  const action: string = (body?.action || '').trim();
  if (!workspaceId || !datasetId) {
    return NextResponse.json({ ok: false, error: 'workspaceId and datasetId are required' }, { status: 400 });
  }
  try {
    if (action === 'bind') {
      const gatewayObjectId: string = (body?.gatewayObjectId || '').trim();
      if (!gatewayObjectId) return NextResponse.json({ ok: false, error: 'gatewayObjectId is required to bind' }, { status: 400 });
      const datasourceObjectIds: string[] | undefined = Array.isArray(body?.datasourceObjectIds) ? body.datasourceObjectIds : undefined;
      await bindToGateway(workspaceId, datasetId, gatewayObjectId, datasourceObjectIds);
      const boundGatewayDatasources = await getBoundGatewayDatasources(workspaceId, datasetId);
      return NextResponse.json({ ok: true, boundGatewayDatasources });
    }
    if (action === 'updateDatasources') {
      const updateDetails: UpdateDatasourceDetail[] = Array.isArray(body?.updateDetails) ? body.updateDetails : [];
      if (updateDetails.length === 0) return NextResponse.json({ ok: false, error: 'updateDetails[] is required' }, { status: 400 });
      await updateDatasetDatasources(workspaceId, datasetId, updateDetails);
      const datasources = await getDatasetDatasources(workspaceId, datasetId);
      return NextResponse.json({ ok: true, datasources });
    }
    return NextResponse.json({ ok: false, error: `action '${action}' is not supported (use 'bind' or 'updateDatasources')` }, { status: 400 });
  } catch (e) { return fail(e); }
}
