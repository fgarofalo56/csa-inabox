/**
 * /api/health/tenants/[id]/apps   SMART apps registered on the item's health tenant (#5454 A6)
 *
 *   GET   The tenant's SMART clients (app and backend), read live from the control
 *         plane's Authorization Server (GET /api/health/auth/clients, filtered to
 *         this tenant). Inline keys are reduced to a count + kids (toAppRow).
 *         Needs Reader on `health.tenant-admin` and read access to the item.
 *   POST  Register a client: an app (public, or asymmetric) or a backend service
 *         (asymmetric, roleIds, system/ scopes, no redirect/launch URI). An
 *         asymmetric client sends exactly one of a JWKS URL or inline PUBLIC keys
 *         (`jwks`); a private JWK member is a 400 and nothing reaches the CP.
 *         The client id is generated here (OAuth dynamic registration: the
 *         server assigns client_id); a clientId in the body is ignored.
 *         The tenant is the item's binding, never the body. Needs Contributor
 *         on `health.tenant-admin` and write access to the item; a backend
 *         client or `introspect:true` needs Admin (operator decision 2026-11-28).
 *         GET also answers `canRegisterBackend` so the dialog can say so.
 *
 * Envelope: `{ok:true, apps}` / `{ok:true, app}`; failures `{ok:false, error}`
 * with the CP's own 400/404/409, 503 gate envelope when the CP is not
 * configured, 502 when it is unreachable.
 */
import { checkHealthTenantAdmin, enforceHealthTenantAdmin, withHealthTenantAdmin } from '../../_lib/tenant-admin-gate';
import { apiError, apiOk } from '@/lib/api/respond';
import { cp, CpError } from '../../_lib/cp-client';
import { boundTenant, clientsOfTenant, cpFailure, generateClientId, needsAdmin, parseRegister, toAppRow } from '../../_lib/smart-apps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 25;

export const GET = withHealthTenantAdmin<{ id: string }>('Reader', async (_req, { session, params }) => {
  const tenant = await boundTenant(params.id, session, { allowReadRoles: true });
  if (typeof tenant !== 'string') return tenant;
  try {
    const clients = await cp.listClients();
    // Tells the Register dialog whether to offer the Admin-only choices. Display only: POST re-checks.
    const canRegisterBackend = (await checkHealthTenantAdmin(session, 'Admin')).allow;
    return apiOk({ tenant, canRegisterBackend, apps: clientsOfTenant(clients, tenant).map(toAppRow) });
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
  // Operator decision 2026-11-28 (#5151): a backend client (system access, no user) or one that may introspect is
  // an Admin act on health.tenant-admin. App clients stay at Contributor (the wrapper above).
  if (needsAdmin(a)) {
    const denied = await enforceHealthTenantAdmin(session, 'Admin');
    if (denied) return denied;
  }
  // parseRegister guarantees at most one of jwksUrl / jwks; a backend client carries roleIds and no launch URI.
  const create = (clientId: string) => cp.createClient({
    clientId,
    tenant,
    clientType: a.clientType,
    displayName: a.displayName,
    allowedScopes: a.allowedScopes,
    redirectUris: a.redirectUris,
    ...(a.launchUri ? { launchUri: a.launchUri } : {}),
    ...(a.clientType === 'backend' ? { roleIds: a.roleIds } : {}),
    ...(a.introspect ? { introspect: true as const } : {}),
    ...(a.jwksUrl ? { jwksUrl: a.jwksUrl } : {}),
    ...(a.jwks ? { jwks: a.jwks } : {}),
  });
  try {
    // The client id is assigned here, never taken from the body. One retry with a fresh id on a CP 409 (an id
    // collision is ~2^-40 per pair, so a second 409 is reported as the CP's conflict rather than looped on).
    let created;
    try {
      created = await create(generateClientId(a.displayName));
    } catch (e) {
      if (!(e instanceof CpError && e.status === 409)) throw e;
      created = await create(generateClientId(a.displayName));
    }
    return apiOk({ app: toAppRow(created) }, { status: 201 });
  } catch (e) {
    return cpFailure(e);
  }
});
