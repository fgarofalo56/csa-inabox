/**
 * GET /api/health/jobs/[id]   ([id] is a control-plane job id)
 *
 * Read-only proxy of one control-plane job and its receipts. It exists because a
 * `tenant.destroy` job outlives the Loom item that submitted it (DELETE of the
 * item returns `destroyJobId`), so /api/health/tenants/[itemId] can no longer
 * reach it. Same authorization as the tenant list: an explicit
 * `health.tenant-admin` grant (D12), Reader or above. Errors are true
 * (deploy-integrity R7): unconfigured -> gate envelope, unreachable -> 502 with
 * the control plane's own code, unknown id -> 404.
 */
import { withHealthTenantAdmin } from '../../tenants/_lib/tenant-admin-gate';
import { apiError, apiOk } from '@/lib/api/respond';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { cp, CpError, CpNotConfiguredError } from '../../tenants/_lib/cp-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withHealthTenantAdmin<{ id: string }>('Reader', async (_req, { params }) => {
  try {
    const job = await cp.getJob(params.id);
    return apiOk({ job });
  } catch (e) {
    if (e instanceof CpNotConfiguredError) {
      return apiHonestGateError('health-control-plane', { missing: e.missing, message: e.message });
    }
    if (e instanceof CpError) {
      return apiError(`${e.code}: ${e.message}`, e.status === 404 ? 404 : 502, { code: e.code });
    }
    throw e;
  }
});
