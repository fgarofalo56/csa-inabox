/**
 * Warm Spark session pool — status + control BFF.
 *
 *   GET  /api/spark/session-pool
 *        → pool status: warm / leased / warming (cold-starting) counts per
 *          pool/kind/sizing group, effective config, and the resolved backend
 *          (+ honest gate when no Spark backend is configured).
 *
 *   POST /api/spark/session-pool   body: { action, ... }
 *        action:'warm'   → pre-provision (any authed user). Optional
 *                          { backend, poolName, kind } targets a specific pool;
 *                          defaults to the active backend's default Spark pool.
 *        action:'config' → set min / max / idleTtlMs / enabled (TENANT ADMIN).
 *
 * Session-gated (401 unauth). Config is admin-gated (403). No mocks — status
 * reflects REAL Livy/Databricks session state; warm provisions REAL sessions.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdminTier, TENANT_ADMIN_TIER_REMEDIATION, TENANT_ADMIN_BOOTSTRAP_ENV } from '@/lib/auth/domain-role';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import {
  getPoolStatus,
  warmPool,
  setSparkPoolConfig,
  sparkPoolBackendStatus,
  type SparkPoolBackend,
  type WarmTarget,
} from '@/lib/azure/spark-session-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  try {
    const status = getPoolStatus();
    return apiOk({ status });
  } catch (e) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = typeof body?.action === 'string' ? body.action : '';

  if (action === 'warm') {
    // Honest gate: no Spark backend configured → nothing to warm against.
    const gate = sparkPoolBackendStatus();
    if (!gate.configured) {
      return apiError(
        `Spark backend not configured — set ${gate.missing} to enable the warm pool.`,
        200,
        { configured: false, backend: gate },
      );
    }
    try {
      const target: WarmTarget = {
        backend: (['synapse', 'databricks'].includes(String(body?.backend)) ? body.backend : undefined) as SparkPoolBackend | undefined,
        poolName: typeof body?.poolName === 'string' ? body.poolName : undefined,
        kind: typeof body?.kind === 'string' ? (body.kind as WarmTarget['kind']) : undefined,
      };
      const res = await warmPool(target);
      return apiOk({ warmed: res.group, group: res.status, status: getPoolStatus() });
    } catch (e) {
      return apiServerError(e);
    }
  }

  if (action === 'config') {
    if (!isTenantAdminTier(s)) {
      return apiError('tenant admin required to change pool config', 403, {
        remediation: TENANT_ADMIN_TIER_REMEDIATION,
        bootstrapEnv: TENANT_ADMIN_BOOTSTRAP_ENV,
      });
    }
    try {
      const cfg = setSparkPoolConfig({
        enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
        min: typeof body?.min === 'number' ? body.min : undefined,
        max: typeof body?.max === 'number' ? body.max : undefined,
        idleTtlMs:
          typeof body?.idleTtlMs === 'number'
            ? body.idleTtlMs
            : typeof body?.idleTtlSecs === 'number'
            ? body.idleTtlSecs * 1000
            : undefined,
      });
      return apiOk({ config: cfg, status: getPoolStatus() });
    } catch (e) {
      return apiServerError(e);
    }
  }

  return apiError('unsupported action — use "warm" or "config"', 400);
}
