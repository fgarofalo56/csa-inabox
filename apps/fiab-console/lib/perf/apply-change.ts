/**
 * PERF-4.1 — executes a VALIDATED ApplyChange against the real backend.
 *
 * One executor shared by the manual Apply route (POST
 * /api/admin/performance/recommendations/apply) and the auto-tune engine
 * (`auto-tune.ts`) so both paths hit the exact same real writes:
 *
 *   spark-pool-config → setSparkPoolConfig (cross-replica Cosmos config doc)
 *   cache-override    → PerfTunables.cacheOverride (Cosmos; consumed live by
 *                       query-result-cache.ts)
 *   adx-autoscale     → updateKustoClusterAutoscale (REAL ARM PATCH)
 *   warehouse-scale   → scalePool (REAL ARM PATCH on the dedicated SQL pool)
 *
 * Every execution returns a receipt with the real before/after state and is
 * appended to the auto-tune audit trail (no-vaporware.md — the Apply button
 * really applies).
 */

import type { ApplyChange } from '@/lib/perf/recommendations';
import { appendAudit, getTunables, writeTunables } from '@/lib/perf/usage-store';

export interface ApplyReceipt {
  ok: boolean;
  kind: ApplyChange['kind'];
  /** Human summary of what was really changed. */
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** Which real surface was called. */
  backend: string;
  appliedAt: string;
  error?: string;
}

/**
 * Execute a validated+clamped change. `actor` is 'auto' (auto-tune) or the
 * admin UPN (manual Apply); `recommendationId` keys the audit row.
 */
export async function executeApplyChange(
  change: ApplyChange,
  actor: string,
  recommendationId: string,
): Promise<ApplyReceipt> {
  const appliedAt = new Date().toISOString();
  let receipt: ApplyReceipt;
  try {
    switch (change.kind) {
      case 'spark-pool-config': {
        const { sparkPoolConfig, setSparkPoolConfig } = await import('@/lib/azure/spark-session-pool');
        const before = sparkPoolConfig();
        const after = setSparkPoolConfig({
          enabled: change.patch.enabled,
          min: change.patch.min,
          max: change.patch.max,
          idleTtlMs: typeof change.patch.idleTtlSecs === 'number' ? change.patch.idleTtlSecs * 1000 : undefined,
          concurrent: change.patch.concurrent,
          reapEnabled: change.patch.reapEnabled,
        });
        receipt = {
          ok: true,
          kind: change.kind,
          summary: `Warm-pool config updated: ${Object.entries(change.patch)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`,
          before: { enabled: before.enabled, min: before.min, max: before.max, idleTtlMs: before.idleTtlMs, concurrent: before.concurrent, reapEnabled: before.reapEnabled },
          after: { enabled: after.enabled, min: after.min, max: after.max, idleTtlMs: after.idleTtlMs, concurrent: after.concurrent, reapEnabled: after.reapEnabled },
          backend: 'spark-session-pool config (cross-replica Cosmos doc + live apply)',
          appliedAt,
        };
        break;
      }
      case 'cache-override': {
        const { queryCacheStats } = await import('@/lib/azure/query-result-cache');
        const before = queryCacheStats();
        const t = await getTunables();
        const next = await writeTunables(
          { ...t, cacheOverride: { ...t.cacheOverride, ...change.patch } },
          actor,
        );
        const after = queryCacheStats();
        receipt = {
          ok: true,
          kind: change.kind,
          summary: `Result-cache runtime override updated: ${Object.entries(change.patch)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`,
          before: { enabled: before.enabled, ttlMs: before.ttlMs, size: before.size },
          after: { enabled: after.enabled, ttlMs: after.ttlMs, override: next.cacheOverride as unknown as Record<string, unknown> },
          backend: 'perf-tunables Cosmos doc → query-result-cache runtime override',
          appliedAt,
        };
        break;
      }
      case 'adx-autoscale': {
        const { getKustoClusterArm, updateKustoClusterAutoscale } = await import('@/lib/azure/kusto-arm-client');
        const beforeCluster = await getKustoClusterArm();
        const result = await updateKustoClusterAutoscale(change.isEnabled, change.minimum, change.maximum);
        receipt = {
          ok: true,
          kind: change.kind,
          summary: `ADX optimized autoscale ${change.isEnabled ? 'enabled' : 'disabled'} (${change.minimum}-${change.maximum} instances)`,
          before: {
            optimizedAutoscale: (beforeCluster.optimizedAutoscale ?? { isEnabled: false }) as unknown as Record<string, unknown>,
          } as Record<string, unknown>,
          after: result as unknown as Record<string, unknown>,
          backend: 'ARM PATCH Microsoft.Kusto/clusters (optimizedAutoscale)',
          appliedAt,
        };
        break;
      }
      case 'warehouse-scale': {
        const { getPoolState, scalePool } = await import('@/lib/azure/synapse-pool-arm');
        const before = await getPoolState();
        if (before.state !== 'Online') {
          receipt = {
            ok: false,
            kind: change.kind,
            summary: `Dedicated pool is ${before.state} — a DWU scale requires the pool Online.`,
            before: before as unknown as Record<string, unknown>,
            backend: 'ARM PATCH Microsoft.Synapse/workspaces/sqlPools (sku)',
            appliedAt,
            error: `pool state is ${before.state}, not Online`,
          };
          break;
        }
        const result = await scalePool(change.sku);
        receipt = {
          ok: true,
          kind: change.kind,
          summary: `Dedicated SQL pool scaling ${before.sku} → ${change.sku} (running queries reconnect after the scale).`,
          before: before as unknown as Record<string, unknown>,
          after: result as unknown as Record<string, unknown>,
          backend: 'ARM PATCH Microsoft.Synapse/workspaces/sqlPools (sku)',
          appliedAt,
        };
        break;
      }
      case 'none':
      default:
        receipt = {
          ok: false,
          kind: change.kind,
          summary: 'Nothing to apply',
          backend: 'none',
          appliedAt,
          error: 'informational recommendation',
        };
    }
  } catch (e) {
    receipt = {
      ok: false,
      kind: change.kind,
      summary: 'Apply failed',
      backend: 'error',
      appliedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Audit every attempt (best-effort).
  void appendAudit({
    at: Date.now(),
    actor,
    recommendationId,
    cls: change.kind,
    summary: receipt.summary,
    before: receipt.before,
    after: receipt.after,
    ok: receipt.ok,
    error: receipt.error,
  }).catch(() => {});

  return receipt;
}
