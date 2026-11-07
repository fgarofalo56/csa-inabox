/**
 * GET /api/health/tenants
 *   The control plane's tenant registry, proxied for the Health Tenant Admin.
 *   Identities, pointers and quotas only: the control plane never holds
 *   clinical data (ADR-005).
 *
 * Auth: an explicit grant on `health.tenant-admin` (D12: not inherited from Loom Admin). Errors are true
 * (deploy-integrity R7): an unconfigured control plane is the
 * `health-control-plane` gate envelope, an unreachable or refusing one is a
 * 502 carrying the control plane's own code, never an empty list.
 */
import { withHealthTenantAdmin } from './_lib/tenant-admin-gate';
import { apiError, apiOk } from '@/lib/api/respond';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { cp, CpError, CpNotConfiguredError } from './_lib/cp-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withHealthTenantAdmin('Reader', async () => {
  try {
    const tenants = await cp.listTenants();
    return apiOk({ tenants });
  } catch (e) {
    if (e instanceof CpNotConfiguredError) {
      return apiHonestGateError('health-control-plane', { missing: e.missing, message: e.message });
    }
    if (e instanceof CpError) return apiError(`${e.code}: ${e.message}`, 502, { code: e.code });
    throw e;
  }
});
