/**
 * /api/health/tenants/[id]/apps   SMART apps registered on the item's health tenant (#5454 A6)
 *
 *   GET   The tenant's app clients, read live from the control plane's
 *         Authorization Server (GET /api/health/auth/clients, filtered to this
 *         tenant). Needs Reader on `health.tenant-admin` and read access to the item.
 *   POST  Register an app client (public, or asymmetric with a JWKS URL).
 *         The tenant is the item's binding, never the body. Needs Contributor
 *         on `health.tenant-admin` and write access to the item.
 *
 * Envelope: `{ok:true, apps}` / `{ok:true, app}`; failures `{ok:false, error}`
 * with the CP's own 400/404/409, 503 gate envelope when the CP is not
 * configured, 502 when it is unreachable.
 */
import { withHealthTenantAdmin } from '../../_lib/tenant-admin-gate';
import { apiError, apiOk } from '@/lib/api/respond';
import { cp } from '../../_lib/cp-client';
import { appsOfTenant, boundTenant, cpFailure, parseRegister, toAppRow } from '../../_lib/smart-apps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 25;

export const GET = withHealthTenantAdmin<{ id: string }>('Reader', async (_req, { session, params }) => {
  const tenant = await boundTenant(params.id, session, { allowReadRoles: true });
  if (typeof tenant !== 'string') return tenant;
  try {
    const clients = await cp.listClients();
    return apiOk({ tenant, apps: appsOfTenant(clients, tenant).map(toAppRow) });
  } catch (e) {
    return cpFailure(e);
  }
});

export const POST = withHealthTenantAdmin<{ id: string }>('Contributor', async (req, { session, params }) => {
  const tenant = await boundTenant(params.id, session);
  if (typeof tenant !== 'string') return tenant;
  let body: unknown;
  try { body = await req.json(); } catch { return apiError('A JSON body is required', 400); }
  const parsed = parseRegister(body);
  if ('error' in parsed) return apiError(parsed.error, 400);
  const a = parsed.app;
  try {
    const created = await cp.createClient({
      clientId: a.clientId,
      tenant,
      clientType: 'app',
      displayName: a.displayName,
      allowedScopes: a.allowedScopes,
      redirectUris: a.redirectUris,
      launchUri: a.launchUri,
      ...(a.jwksUrl ? { jwksUrl: a.jwksUrl } : {}),
    });
    return apiOk({ app: toAppRow(created) }, { status: 201 });
  } catch (e) {
    return cpFailure(e);
  }
});
