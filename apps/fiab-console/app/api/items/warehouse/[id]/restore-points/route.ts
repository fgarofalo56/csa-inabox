/**
 * GET  /api/items/warehouse/[id]/restore-points
 *   Lists DISCRETE (user-defined) + CONTINUOUS (automatic, ~8h) restore points
 *   for the backing Synapse Dedicated SQL pool via the real ARM
 *   `sqlPools/restorePoints` API.
 *
 * POST /api/items/warehouse/[id]/restore-points
 *   { action: 'create', label }                      → real ARM POST (new DISCRETE point)
 *   { action: 'delete', name }                        → real ARM DELETE
 *   { action: 'restore', targetPool, restorePointInTime } → real ARM PUT (new pool)
 *
 * Fabric parity: the Azure-native backend behind Fabric Warehouse "restore
 * in-place". Dedicated pools cannot restore in-place, so restore provisions a
 * NEW pool from the chosen point in time — disclosed honestly in the UI.
 *   https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/backup-and-restore
 *   https://learn.microsoft.com/fabric/data-warehouse/restore-in-place
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import {
  getPoolState,
  listRestorePoints,
  createRestorePoint,
  deleteRestorePoint,
  restoreToNewPool,
} from '@/lib/azure/synapse-pool-arm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function poolConfigured(): boolean {
  return !!(process.env.LOOM_SYNAPSE_WORKSPACE && process.env.LOOM_SYNAPSE_DEDICATED_POOL);
}

export async function GET() {
  const session = getSession();
  if (!session) return apiUnauthorized();
  if (!poolConfigured()) {
    return apiError(
      'Warehouse compute is not configured. Set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL to the backing Synapse Dedicated SQL pool.',
      503, { gated: true, code: 'no_pool' },
    );
  }
  try {
    const [points, state] = await Promise.all([
      listRestorePoints(),
      getPoolState().catch(() => null),
    ]);
    return apiOk({
      warehouse: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
      poolState: state?.state || 'Unknown',
      restorePoints: points,
    });
  } catch (e) {
    return apiServerError(e, 'Failed to list restore points', 'list_failed');
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  if (!poolConfigured()) {
    return apiError(
      'Warehouse compute is not configured. Set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL to the backing Synapse Dedicated SQL pool.',
      503, { gated: true, code: 'no_pool' },
    );
  }

  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  // Restore points can only be created/taken while the pool is Online (paused
  // pools take no snapshots). Surface that as an honest 409, not a 500.
  if (action === 'create') {
    const label = String(body?.label || '').trim();
    if (!label || label.length > 256) return apiError('label is required (≤256 chars)', 400);
    const state = await getPoolState().catch(() => null);
    if (state && state.state !== 'Online') {
      return apiError(`Warehouse compute is ${state.state}. Resume the pool before creating a restore point.`, 409, { code: 'pool_offline', state: state.state });
    }
    try {
      await createRestorePoint(label);
      return apiOk({ action: 'create', label });
    } catch (e) {
      return apiServerError(e, 'Failed to create restore point', 'create_failed');
    }
  }

  if (action === 'delete') {
    const name = String(body?.name || '').trim();
    if (!name) return apiError('name is required', 400);
    try {
      await deleteRestorePoint(name);
      return apiOk({ action: 'delete', name });
    } catch (e) {
      return apiServerError(e, 'Failed to delete restore point', 'delete_failed');
    }
  }

  if (action === 'restore') {
    const targetPool = String(body?.targetPool || '').trim();
    const restorePointInTime = String(body?.restorePointInTime || '').trim();
    // Synapse SQL pool names: ≤60 chars, no special chars (portal rule).
    if (!/^[A-Za-z0-9_]{1,60}$/.test(targetPool)) {
      return apiError('targetPool must be 1–60 alphanumeric/underscore chars', 400);
    }
    if (!/^[0-9T:\- .+Z]{10,40}$/.test(restorePointInTime)) {
      return apiError('restorePointInTime must be an ISO8601 datetime', 400);
    }
    try {
      const { newPoolId } = await restoreToNewPool(targetPool, restorePointInTime);
      return apiOk({
        action: 'restore', targetPool, restorePointInTime, newPoolId,
        note: 'Restore provisions a NEW dedicated SQL pool from the chosen point in time (dedicated pools do not restore in-place). Provisioning is asynchronous — the new pool appears in the workspace once ready.',
      });
    } catch (e) {
      return apiServerError(e, 'Failed to start restore', 'restore_failed');
    }
  }

  return apiError("action must be 'create', 'delete', or 'restore'", 400);
}
