/**
 * POST /api/items/loom-app-runtime/[id]/lifecycle
 *   body: { action: 'start' | 'stop' }
 *
 * Start / Stop the deployed Container App (real ACA start/stop action APIs).
 * Owner-scoped write. Stop is the per-app disable — it is ALWAYS allowed (so a
 * disabled runtime can be enforced by stopping running apps on their next
 * action, per the opt-out posture). Start is blocked when the runtime kill
 * switch is off.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError, apiHonestError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, saveAppRuntime, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import { resolveAppsRuntimeState, appsRuntimeDisabledReason } from '@/lib/apps/runtime-flag';
import { startApp, stopApp, LoomAppsNotConfiguredError, LoomAppsError } from '@/lib/azure/loom-apps-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  let body: any;
  try { body = await req.json(); } catch { return apiError('Invalid JSON', 400, { code: 'bad_json' }); }
  const action = String(body?.action || '');
  if (action !== 'start' && action !== 'stop') return apiError("action must be 'start' or 'stop'", 400);
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    if (!access.canWrite) return apiError('Read-only access', 403, { code: 'forbidden' });
    const rt = readAppRuntime(access.item);
    if (!rt.containerAppName) return apiError('No deployed app to control (deploy first)', 409, { code: 'not_deployed' });

    if (action === 'start') {
      // Start respects the kill switch; Stop never does (it is the disable path).
      const state = await resolveAppsRuntimeState(session.claims.oid);
      if (!state.enabled) return apiError(appsRuntimeDisabledReason(state), 403, { code: 'runtime_disabled' });
      const r = await startApp(rt.containerAppName);
      const updated = await saveAppRuntime(access.item, { disabled: false });
      return apiOk({ result: r, runtime: readAppRuntime(updated) });
    }
    const r = await stopApp(rt.containerAppName);
    const updated = await saveAppRuntime(access.item, { disabled: true });
    return apiOk({ result: r, runtime: readAppRuntime(updated) });
  } catch (e) {
    if (e instanceof LoomAppsNotConfiguredError) return apiHonestError(e.message, 503);
    if (e instanceof LoomAppsError) return apiHonestError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return apiServerError(e, 'lifecycle action failed');
  }
}
