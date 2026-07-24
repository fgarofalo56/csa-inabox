/**
 * GET /api/transform/[id]/history?limit=<n>
 *
 * The project's plan/apply history from `loom-transform-plans` (PK /itemId — a
 * single-partition read). Every row is a plan an operator actually previewed,
 * with the impact summary they saw and, when applied, the apply outcome.
 *
 * Cosmos-native: NOT gated on the runner, so history stays readable even when
 * LOOM_TRANSFORM_RUNNER_URL is unset.
 */

import { apiOk, apiServerError } from '@/lib/api/respond';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { listPlans } from '@/lib/transform/transform-plan-store';
import { TRANSFORM_ITEM_TYPE } from '../../_lib/project-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withWorkspaceOwner(TRANSFORM_ITEM_TYPE, { allowReadRoles: true },
  async (req, { item }) => {
    const limitRaw = Number(new URL(req.url).searchParams.get('limit') || '25');
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 25;
    try {
      return apiOk({ plans: await listPlans(item.id, limit) });
    } catch (e) {
      return apiServerError(e, 'plan history read failed', 'history_error');
    }
  });
