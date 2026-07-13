/**
 * GET /api/admin/access-requests — the sign-in-boundary onboarding queue for
 * tenant admins. Lists submissions from the front-door "Request access" form so
 * an admin can approve (onboard) or deny them.
 *
 * Query params:
 *   ?status=pending|approved|denied   default 'pending'
 *
 * Admin-only: the queue exposes prospective users' contact details, so it is
 * gated by requireTenantAdmin (the same fail-closed check every admin BFF route
 * uses). Returns a count summary so the admin nav / overview can badge pending.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { signinAccessRequestsContainer } from '@/lib/azure/cosmos-client';
import { deploymentTenantBucket } from '@/lib/access/signin-access-request';
import { apiOk, apiServerError } from '@/lib/api/respond';
import type { SigninAccessRequest, SigninAccessRequestStatus } from '@/lib/types/signin-access-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = new Set<SigninAccessRequestStatus>(['pending', 'approved', 'denied']);

export async function GET(req: NextRequest) {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;

  const statusParam = (req.nextUrl.searchParams.get('status') || 'pending') as SigninAccessRequestStatus;
  const status: SigninAccessRequestStatus = STATUSES.has(statusParam) ? statusParam : 'pending';
  const tenantId = deploymentTenantBucket();

  try {
    const c = await signinAccessRequestsContainer();
    const { resources } = await c.items
      .query<SigninAccessRequest>({
        query:
          'SELECT * FROM c WHERE c.tenantId = @t AND c.status = @s ORDER BY c.createdAt DESC',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@s', value: status },
        ],
      }, { partitionKey: tenantId })
      .fetchAll();

    // Cheap per-status counts for the queue tabs + a nav badge.
    const { resources: counts } = await c.items
      .query<{ status: SigninAccessRequestStatus; n: number }>({
        query: 'SELECT c.status, COUNT(1) AS n FROM c WHERE c.tenantId = @t GROUP BY c.status',
        parameters: [{ name: '@t', value: tenantId }],
      }, { partitionKey: tenantId })
      .fetchAll();
    const summary = { pending: 0, approved: 0, denied: 0 };
    for (const row of counts) {
      if (row.status in summary) summary[row.status] = row.n;
    }

    return apiOk({ requests: resources, counts: summary });
  } catch (e) {
    return apiServerError(e);
  }
}
