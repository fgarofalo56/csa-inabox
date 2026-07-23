/**
 * POST /api/admin/spark/chaos — A13 Spark chaos-drill harness (fault injection).
 *
 * A resilience DRILL tool: injects REAL faults into the Spark plane so the A11
 * auto-recovery + A12 reaper + warm-pool refill path can be exercised
 * end-to-end (not mocked) in a NON-PROD deployment. Two faults:
 *
 *   { action: 'kill-sessions', poolName?, count? }
 *       Kill up to `count` (default 1) live Livy sessions on the pool — the
 *       leaked/crashed-session class the #1796 reaper + warm refill recover from.
 *
 *   { action: 'mark-faulted', poolName }
 *       Arm the warm-pool circuit breaker for the pool so it classifies as
 *       `suspect` (the "Succeeded but can't launch" fault) — the A11 detector's
 *       target. The next keep-warm heartbeat's autoRecoverTick delete+recreates.
 *
 * TRIPLE-GATED (this is a destructive testing tool):
 *   1. Tenant admin session (withTenantAdmin).
 *   2. LOOM_SPARK_CHAOS_ENABLED=true — OFF by default; MUST stay off in prod.
 *   3. A valid LOOM_INTERNAL_TOKEN on the request (Bearer / x-loom-internal-token)
 *      — the same machine-trust secret the keep-warm heartbeat uses.
 *
 * REAL backend only (no-vaporware): killLivySession hits the live Synapse Livy
 * DELETE; markPoolFaultedForDrill arms the real in-process breaker.
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiForbidden, apiServerError } from '@/lib/api/respond';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import {
  listLivySessions,
  killLivySession,
  defaultSparkPool,
} from '@/lib/azure/synapse-livy-client';
import { markPoolFaultedForDrill, sparkPoolBackendStatus } from '@/lib/azure/spark-session-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** LOOM_SPARK_CHAOS_ENABLED — default OFF (opt-in for a drill only). */
function chaosEnabled(): boolean {
  const v = (process.env.LOOM_SPARK_CHAOS_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function presentedInternalToken(req: NextRequest): string | null {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return bearer || req.headers.get(INTERNAL_TOKEN_HEADER);
}

export const POST = withTenantAdmin(async (req: NextRequest) => {
  // Gate 2 — chaos must be explicitly enabled (OFF in prod).
  if (!chaosEnabled()) {
    return apiForbidden(
      'Spark chaos-drill harness is disabled. Set LOOM_SPARK_CHAOS_ENABLED=true in a NON-PROD deployment to run a resilience drill.',
    );
  }
  // Gate 3 — a valid internal trust token must accompany the admin session.
  if (!isValidInternalToken(presentedInternalToken(req))) {
    return apiForbidden('chaos-drill requires a valid LOOM_INTERNAL_TOKEN (Bearer or x-loom-internal-token).');
  }

  const backend = sparkPoolBackendStatus();
  if (backend.backend !== 'synapse' || !backend.configured) {
    return apiError(`chaos-drill is Synapse-only and the backend is not configured (${backend.missing || backend.backend}).`, 409);
  }

  const body = (await req.json().catch(() => ({}))) as { action?: unknown; poolName?: unknown; count?: unknown };
  const action = typeof body.action === 'string' ? body.action : '';
  const poolName = typeof body.poolName === 'string' && body.poolName.trim() ? body.poolName.trim() : defaultSparkPool();

  try {
    if (action === 'kill-sessions') {
      const count = Math.max(1, Math.min(20, Number(body.count) || 1));
      const live = await listLivySessions(poolName, { hardCap: 200 });
      // Prefer non-terminal sessions (they actually hold capacity).
      const targets = live
        .filter((s) => typeof s.id === 'number')
        .filter((s) => !['dead', 'killed', 'error', 'shutting_down'].includes(String(s.state).toLowerCase()))
        .slice(0, count);
      const killed: number[] = [];
      const failed: Array<{ id: number; error: string }> = [];
      for (const s of targets) {
        try {
          await killLivySession(poolName, s.id);
          killed.push(s.id);
        } catch (e) {
          failed.push({ id: s.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return apiOk({ action, poolName, requested: count, killed, failed, liveBefore: live.length });
    }

    if (action === 'mark-faulted') {
      const armed = markPoolFaultedForDrill(poolName, 'A13 chaos-drill — injected FAULTED breaker');
      return apiOk({
        action,
        poolName,
        armedGroups: armed,
        note: 'Warm-pool circuit breaker armed → the pool now classifies as "suspect"; the next keep-warm heartbeat auto-recovers it (if a11-spark-autorecover is ON).',
      });
    }

    return apiError("body must be { action: 'kill-sessions' | 'mark-faulted', poolName?, count? }", 400);
  } catch (e) {
    return apiServerError(e, 'chaos-drill failed — see the server logs.');
  }
});
