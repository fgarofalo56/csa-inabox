/**
 * /api/health/tenants/[id]/apps/[clientId]/launch   EHR launch (#5454 A6, gap G8)
 *
 *   POST `{patient?: <FHIR id>}` -> `{ok:true, url}`
 *
 * Mints a single-use launch handle on the control plane for the SIGNED-IN
 * user's own oid (from the session, never from the body: the AS binds the
 * handle to that oid, so a body-supplied oid would let one user mint a launch
 * another user's sign-in completes). The client must be an active app of THIS
 * tenant with a launch URI. The answer is the URL the browser goes to:
 * `launchUri?iss=<tenant FHIR base>&launch=<handle>`, where the FHIR base is the
 * `iss` the control plane returns (its token audience), never derived here.
 *
 * Without `patient` the launch has no patient context (valid SMART); the token
 * then carries no `patient` and no patient/ scope.
 */
import { withHealthTenantAdmin } from '../../../../_lib/tenant-admin-gate';
import { apiError, apiOk } from '@/lib/api/respond';
import { cp } from '../../../../_lib/cp-client';
import { CLIENT_ID, FHIR_ID, appsOfTenant, boundTenant, buildLaunchUrl, cpFailure, isParsableUrl } from '../../../../_lib/smart-apps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 25;

export const POST = withHealthTenantAdmin<{ id: string; clientId: string }>('Reader', async (req, { session, params }) => {
  if (!CLIENT_ID.test(params.clientId)) return apiError('Unknown app', 404);
  const tenant = await boundTenant(params.id, session, { allowReadRoles: true });
  if (typeof tenant !== 'string') return tenant;
  let body: Record<string, unknown> = {};
  try { body = ((await req.json()) as Record<string, unknown> | null) ?? {}; } catch { /* an empty body is a launch without a patient */ }
  let patient: string | undefined;
  if (body.patient !== undefined && body.patient !== null && body.patient !== '') {
    if (typeof body.patient !== 'string' || !FHIR_ID.test(body.patient)) return apiError('patient: must be a FHIR resource id', 400);
    patient = body.patient;
  }
  // Only the session's identity. Any `oid` in the body is ignored by construction.
  const oid = session.claims.oid;
  try {
    const client = appsOfTenant(await cp.listClients(), tenant).find((c) => c.clientId === params.clientId);
    if (!client) return apiError('Unknown app', 404);
    if (client.status !== 'active') return apiError('This app is disabled. Enable it to launch it.', 409);
    if (!client.launchUri) return apiError('This app has no launch URL. Set one with "Edit launch URL" first.', 409);
    // A malformed stored launch URI would make buildLaunchUrl's `new URL` throw (a raw 500). Checked BEFORE minting
    // so no launch handle is spent on a URL the browser cannot be sent to.
    if (!isParsableUrl(client.launchUri)) {
      return apiError('This app\'s stored launch URL is not a valid URL. Fix it with "Edit launch URL".', 409, { code: 'launch_uri_invalid' });
    }
    const minted = await cp.mintLaunch({ tenant, oid, clientId: client.clientId, ...(patient ? { patient } : {}) });
    if (typeof minted.iss !== 'string' || !minted.iss) {
      return apiError('The control plane did not return the tenant FHIR base (iss); it predates the EHR launcher (#5454 A6) and needs a roll.', 502, { code: 'iss_missing' });
    }
    return apiOk({ url: buildLaunchUrl(client.launchUri, minted.iss, minted.launch), expiresAt: minted.expiresAt });
  } catch (e) {
    return cpFailure(e);
  }
});
