/**
 * /api/admin/spark/recover — A11 manual Spark-pool recovery + auto-recover status.
 *
 *   GET  → { config, autoEnabled, backend, quota }
 *          The auto-recovery config (LOOM_SPARK_AUTORECOVER_ENABLED /
 *          LOOM_SPARK_RECOVER_MAX_ATTEMPTS), the live a11-spark-autorecover
 *          runtime-flag state (the admin "auto" toggle), the active Spark
 *          backend, and the A12 session-quota status — so the Spark pools tab
 *          renders the recreate control + auto toggle with real state.
 *
 *   POST { poolName } → { result }
 *          Operator-initiated delete + recreate of one FAULTED/suspect pool
 *          (force past the thrash guard — the admin explicitly clicked). Fires
 *          the unified dispatchAlert (operator-alertable) + returns the
 *          structured RecreateResult.
 *
 * REAL backend only (no-vaporware): recreateSparkPool drives the Synapse ARM
 * bigDataPools delete + PUT. Tenant-admin gated (withTenantAdmin). No Spark
 * backend configured → the honest 503 gate envelope with its Fix-it.
 *
 * The AUTO toggle itself is flipped via the existing PUT
 * /api/admin/runtime-flags/a11-spark-autorecover (audited) — this route only
 * READS the flag state for display.
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { sparkPoolBackendStatus, sparkSessionQuotaStatus } from '@/lib/azure/spark-session-pool';
import {
  recreateSparkPool,
  sparkAutoRecoverConfig,
  recentAttempts,
} from '@/lib/azure/spark-pool-recovery';
import { dispatchAlert } from '@/lib/azure/alert-dispatch';
import { runtimeFlag } from '@/lib/admin/runtime-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(async () => {
  const backend = sparkPoolBackendStatus();
  const autoEnabled = await runtimeFlag('a11-spark-autorecover').catch(() => true);
  const quota = await sparkSessionQuotaStatus().catch(() => null);
  return apiOk({
    config: sparkAutoRecoverConfig(),
    autoEnabled,
    backend,
    quota,
  });
});

export const POST = withTenantAdmin(async (req: NextRequest) => {
  const backend = sparkPoolBackendStatus();
  if (backend.backend !== 'synapse' || !backend.configured) {
    // Recreate is a Synapse ARM control-plane op — honest gate for the active backend.
    return apiHonestGateError(backend.backend === 'databricks' ? 'svc-databricks' : 'svc-synapse');
  }
  const body = (await req.json().catch(() => ({}))) as { poolName?: unknown };
  const poolName = typeof body.poolName === 'string' ? body.poolName.trim() : '';
  if (!poolName) return apiError('body must be { poolName: string }', 400);

  try {
    // Manual = operator intent → force past the thrash guard.
    const result = await recreateSparkPool(poolName, { force: true });
    // Operator-alertable event (dispatchAlert is best-effort; never blocks).
    const severity = result.ok ? 'P3' : 'P2';
    await dispatchAlert({
      source: 'spark-autorecover',
      severity,
      title: result.ok
        ? `Spark pool ${poolName} recreated (manual)`
        : `Manual Spark pool ${poolName} recreate did not succeed`,
      body: result.ok
        ? `An operator delete+recreated Spark pool "${poolName}"; it is now ${result.provisioningState || 'provisioned'} (${Math.round((result.durationMs || 0) / 1000)}s).`
        : `Manual recreate of "${poolName}" ended as ${result.action}: ${result.reason || 'unknown'}. Follow the spark-pools runbook.`,
      dedupKey: `spark-autorecover:${poolName}`,
    }).catch(() => {});
    return apiOk({ result, recentAttempts: recentAttempts(poolName).length });
  } catch (e) {
    return apiServerError(e, 'Could not recreate the Spark pool — see the server logs.');
  }
});
