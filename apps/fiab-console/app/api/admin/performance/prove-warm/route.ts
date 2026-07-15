/**
 * PERF-4.3 — POST /api/admin/performance/prove-warm
 *
 * The "Prove warm session" probe: acquires a REAL session through the warm
 * pool exactly like a notebook run does (same default pool / kind / sizing,
 * exclusive lease), measures the wall-clock acquisition time, live-verifies the
 * Livy session state, then RETURNS the lease to the pool (non-destructive — the
 * session goes back to `warm`).
 *
 * Receipt on a warm HIT: leaseId, Livy sessionId + live state, acquiredMs
 * (seconds-scale on a hit vs the 2-4 min Synapse cold start), acquire/release
 * timestamps, and which store served it (memory = this replica / cosmos =
 * cross-replica claim). On a MISS: an honest miss receipt with the live pool
 * counts + last warm-failure reason — never a fabricated timing
 * (no-vaporware.md). Tenant-admin gated (it exercises pooled compute).
 */
import { apiError, apiOk, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import {
  acquireWarmSession,
  releaseSession,
  defaultSynapseSizing,
  sparkPoolBackendStatus,
  getPoolStatus,
} from '@/lib/azure/spark-session-pool';
import { defaultSparkPool } from '@/lib/azure/synapse-livy-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const gate = sparkPoolBackendStatus();
  if (!gate.configured) {
    return apiError(`Spark backend not configured — set ${gate.missing} to run the warm-session probe.`, 200, {
      configured: false,
      backend: gate,
    });
  }

  try {
    // The EXACT default combination a plain notebook run uses.
    let poolName: string;
    let sizing: ReturnType<typeof defaultSynapseSizing>['sizing'];
    let sizingKey: string;
    if (gate.backend === 'databricks') {
      poolName = process.env.LOOM_DATABRICKS_DEFAULT_CLUSTER || '';
      sizing = undefined;
      sizingKey = '';
      if (!poolName) {
        return apiError('LOOM_DATABRICKS_DEFAULT_CLUSTER is not set — nothing to probe.', 200, { configured: false });
      }
    } else {
      poolName = defaultSparkPool();
      const d = defaultSynapseSizing();
      sizing = d.sizing;
      sizingKey = d.sizingKey;
    }

    const acquiredAtIso = new Date().toISOString();
    const t0 = Date.now();
    const lease = await acquireWarmSession({
      backend: gate.backend,
      poolName,
      kind: 'pyspark',
      sizingKey,
      sizing,
      userOid: s.claims.oid,
      readOnly: false, // exclusive — representative of a real (write) notebook run
    });
    const acquireMs = Date.now() - t0;

    if (!lease) {
      // Honest miss — report the live pool state; acquire already kicked a refill.
      const status = getPoolStatus();
      const lastFailure = status.groups.find((grp) => grp.lastFailure)?.lastFailure;
      return apiOk({
        probe: {
          hit: false,
          acquireMs,
          acquiredAt: acquiredAtIso,
          backend: gate.backend,
          poolName,
          totals: status.totals,
          lastFailure: lastFailure ?? null,
          message:
            'No warm session was available — a notebook run right now would COLD-START (~2-4 min on Synapse). ' +
            'The acquire attempt kicked a background warm-up; re-run the probe once a session shows warm.',
        },
      });
    }

    // Live-verify the Livy session really is standing by (real REST read).
    let sessionState: string | null = null;
    if (gate.backend === 'synapse' && typeof lease.sessionId === 'number') {
      try {
        const { getLivySession } = await import('@/lib/azure/synapse-dev-client');
        const live = await getLivySession(poolName, lease.sessionId);
        sessionState = live.state;
      } catch {
        sessionState = null;
      }
    }

    // Non-destructive: return the lease so the session flips back to `warm`.
    releaseSession(lease.leaseId);
    const releasedAtIso = new Date().toISOString();

    return apiOk({
      probe: {
        hit: true,
        acquireMs,
        acquiredAt: acquiredAtIso,
        releasedAt: releasedAtIso,
        backend: gate.backend,
        poolName,
        sessionId: lease.sessionId ?? null,
        sessionState,
        leaseId: lease.leaseId,
        via: lease.via ?? 'memory',
        sizingKey: lease.sizingKey,
        coldStartComparisonMs: 150_000, // documented Synapse cold start ≈ 2-4 min (midpoint 2.5 min)
        message: `Warm hit — Livy session ${lease.sessionId} handed off in ${(acquireMs / 1000).toFixed(1)}s (a cold start takes ~2-4 minutes). Lease returned to the pool.`,
      },
      status: getPoolStatus(),
    });
  } catch (e) {
    return apiServerError(e, 'Warm-session probe failed');
  }
}
