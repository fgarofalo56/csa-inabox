/**
 * GET    /api/items/loom-app-runtime/[id]  → item runtime state + live app status
 * DELETE /api/items/loom-app-runtime/[id]  → delete the deployed Container App
 *
 * Owner-scoped: resolveItemAccessByOid authorizes the caller against THIS item
 * (owner → workspace ACL → item grant) before any read/mutate — never a bare
 * getSession. Real ARM: the live app status is a GET Microsoft.App/containerApps.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError, apiHonestError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, saveAppRuntime, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import { getApp, deleteApp, loomAppsConfigStatus, LoomAppsNotConfiguredError, LoomAppsError } from '@/lib/azure/loom-apps-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    const rt = readAppRuntime(access.item);
    const infra = loomAppsConfigStatus();
    let live: unknown = null;
    if (rt.containerAppName && infra.configured) {
      try { live = await getApp(rt.containerAppName); } catch (e) {
        // A 404 = the app was deleted out-of-band; report null, not an error.
        if (!(e instanceof LoomAppsError && e.status === 404)) throw e;
      }
    }
    return apiOk({ runtime: rt, infra, live });
  } catch (e) {
    if (e instanceof LoomAppsNotConfiguredError) return apiHonestError(e.message, 503);
    return apiServerError(e, 'failed to read app');
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    if (!access.canWrite) return apiError('Read-only access', 403, { code: 'forbidden' });
    const rt = readAppRuntime(access.item);
    if (rt.containerAppName) {
      await deleteApp(rt.containerAppName); // idempotent — 404 is success
    }
    const updated = await saveAppRuntime(access.item, {
      containerAppName: undefined, url: undefined, image: undefined, disabled: true,
    });
    return apiOk({ runtime: readAppRuntime(updated) });
  } catch (e) {
    if (e instanceof LoomAppsNotConfiguredError) return apiHonestError(e.message, 503);
    return apiServerError(e, 'failed to delete app');
  }
}
