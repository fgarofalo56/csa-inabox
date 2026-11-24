/**
 * /api/health/tenants/[id]/apps/[clientId]   (#5454 A6)
 *
 *   PATCH  `{status?: 'active'|'disabled', launchUri?: string|null}` on one app
 *          client of the item's tenant. The client must belong to THIS tenant:
 *          the CP's PATCH is keyed by client id alone, so without the check an
 *          admin of one tenant could disable another tenant's app. A launch URI
 *          must be https. Needs Contributor on `health.tenant-admin`.
 */
import { withHealthTenantAdmin } from '../../../_lib/tenant-admin-gate';
import { apiError, apiOk } from '@/lib/api/respond';
import { cp } from '../../../_lib/cp-client';
import { CLIENT_ID, appsOfTenant, boundTenant, cpFailure, parseLaunchUri, toAppRow } from '../../../_lib/smart-apps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 25;

export const PATCH = withHealthTenantAdmin<{ id: string; clientId: string }>('Contributor', async (req, { session, params }) => {
  if (!CLIENT_ID.test(params.clientId)) return apiError('Unknown app', 404);
  const tenant = await boundTenant(params.id, session);
  if (typeof tenant !== 'string') return tenant;
  let body: Record<string, unknown>;
  try { body = (await req.json()) ?? {}; } catch { return apiError('A JSON body is required', 400); }
  const patch: { status?: 'active' | 'disabled'; launchUri?: string | null } = {};
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'disabled') return apiError('status: active or disabled', 400);
    patch.status = body.status;
  }
  if (body.launchUri !== undefined) {
    if (body.launchUri === null) patch.launchUri = null;
    else {
      const u = parseLaunchUri(body.launchUri);
      if (!u) return apiError('launchUri: must be an https URL without credentials or fragment', 400);
      patch.launchUri = u;
    }
  }
  if (patch.status === undefined && patch.launchUri === undefined) return apiError('Supply status and/or launchUri', 400);
  try {
    const mine = appsOfTenant(await cp.listClients(), tenant).some((c) => c.clientId === params.clientId);
    if (!mine) return apiError('Unknown app', 404);
    return apiOk({ app: toAppRow(await cp.updateClient(params.clientId, patch)) });
  } catch (e) {
    return cpFailure(e);
  }
});
