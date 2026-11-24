/**
 * /api/health/tenants/[id]/apps/patient-search   (#5454 A6)
 *
 *   POST `{q, birthdate?}` -> `{ok:true, patients}` | `{ok:true, unavailable:true, reason}`
 *                           | `{ok:true, notPermitted:true, patients:[]}`
 *
 * Patient search for the EHR launcher, as the SIGNED-IN user (session oid,
 * never the body). The control plane's Authorization Server runs it with the
 * same role-bounded 60 s user token as its standalone picker, so the FHIR
 * engine and the PDP decide what this user may see. An unavailable search is an
 * honest flag the editor renders, never invented rows. Search terms are PHI and
 * travel in the POST body only.
 */
import { withHealthTenantAdmin } from '../../../_lib/tenant-admin-gate';
import { apiError, apiOk } from '@/lib/api/respond';
import { cp } from '../../../_lib/cp-client';
import { FHIR_DATE, boundTenant, cpFailure } from '../../../_lib/smart-apps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 25;

export const POST = withHealthTenantAdmin<{ id: string }>('Reader', async (req, { session, params }) => {
  const tenant = await boundTenant(params.id, session, { allowReadRoles: true });
  if (typeof tenant !== 'string') return tenant;
  let body: Record<string, unknown>;
  try { body = ((await req.json()) as Record<string, unknown> | null) ?? {}; } catch { return apiError('A JSON body is required', 400); }
  const q = typeof body.q === 'string' ? body.q.trim() : '';
  if (!q || q.length > 100) return apiError('q: a patient name of 1 to 100 characters', 400);
  const birthdate = typeof body.birthdate === 'string' ? body.birthdate.trim() : '';
  if (birthdate && !FHIR_DATE.test(birthdate)) return apiError('birthdate: YYYY, YYYY-MM or YYYY-MM-DD', 400);
  try {
    const r = await cp.patientSearch(tenant, { oid: session.claims.oid, q, ...(birthdate ? { birthdate } : {}) });
    if (r.unavailable) return apiOk({ unavailable: true, reason: r.reason, patients: [] });
    if (r.notPermitted) return apiOk({ notPermitted: true, patients: [] });
    return apiOk({ patients: r.patients ?? [] });
  } catch (e) {
    return cpFailure(e);
  }
});
