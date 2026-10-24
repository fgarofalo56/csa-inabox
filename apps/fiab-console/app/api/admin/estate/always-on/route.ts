/**
 * GET /api/admin/estate/always-on - the estate's "always on, not pausable" resources.
 *
 * Read-only. One Resource Graph query (the `loom-estate-id` tag, the same ownership
 * signal as the pause set) plus, per subscription, Cost Management month-to-date
 * spend for exactly the listed resource ids. It issues no pause, resume or any other
 * mutating call. Each row's cost says whether it is ACTUAL month-to-date, a list-price
 * ESTIMATE, or UNKNOWN; a failed inventory is returned as `incomplete`, never as an
 * empty list. See `@/lib/estate/estate-always-on`.
 *
 * Authorization is `withTenantAdmin` from the route toolkit (no inline gate line to
 * delete), like the sibling estate routes.
 *
 * Cloud: cloud-agnostic (cloud-aware ARM + Cost Management hosts) and UNEXERCISED in
 * GCC-High: list-price estimates exist for Commercial only, so Gov rows show actual
 * Cost Management spend or "cost unknown". No Gov receipt exists yet.
 */
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk } from '@/lib/api/respond';
import { detectLoomCloud } from '@/lib/azure/cloud-boundary';
import { discoverAlwaysOn } from '@/lib/estate/estate-always-on';
import { resolveEstateId } from '@/lib/estate/pause-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(async () => {
  const result = await discoverAlwaysOn({ estateId: resolveEstateId(), cloud: detectLoomCloud() });
  return apiOk({ ...result });
});
