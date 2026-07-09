/**
 * GET /api/items/loom-app-runtime/[id]/logs?tail=200
 *
 * Tail the deployed app's stdout/stderr from Log Analytics
 * (ContainerAppConsoleLogs). Owner-scoped read via resolveItemAccessByOid.
 * Honest-gates when the deployment has no Log Analytics workspace wired
 * (LOOM_LOG_ANALYTICS_WORKSPACE_ID) — the editor shows the exact env to set.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError, apiHonestError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import { tailAppLogs, LoomAppsNotConfiguredError } from '@/lib/azure/loom-apps-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  const tail = Number(req.nextUrl.searchParams.get('tail') || '200');
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    const rt = readAppRuntime(access.item);
    if (!rt.containerAppName) return apiOk({ lines: [], note: 'App not deployed yet.' });
    const lines = await tailAppLogs(rt.containerAppName, { tail: Number.isFinite(tail) ? tail : 200 });
    return apiOk({ lines });
  } catch (e: any) {
    if (e instanceof LoomAppsNotConfiguredError) return apiHonestError(e.message, 503);
    // MonitorNotConfiguredError from the log path — surface honestly.
    if (e?.name === 'MonitorNotConfiguredError') {
      return apiHonestError(
        'Live logs need a Log Analytics workspace. Set LOOM_LOG_ANALYTICS_WORKSPACE_ID on the console ' +
          '(wired by platform/fiab/bicep/modules/admin-plane/main.bicep).',
        503,
      );
    }
    return apiServerError(e, 'failed to read logs');
  }
}
