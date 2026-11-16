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

// The control plane mints job ids as 'job-' + 32 hex (apps/loom-health-cp/src/jobs/runner.ts:37; its router
// matches the same shape, src/http/app.ts:56). cp.getJob only encodeURIComponent()s the id, and '..' survives
// that, so an unchecked id would let a Reader steer the console's CP bearer token at a CP path of their choosing.
const JOB_ID_RE = /^job-[0-9a-f]{32}$/;

export const GET = withHealthTenantAdmin<{ id: string }>('Reader', async (_req, { params }) => {
  if (!JOB_ID_RE.test(params.id)) return apiError('Invalid job id', 400, { code: 'invalid_job_id' });
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
