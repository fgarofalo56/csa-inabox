/**
 * POST /api/internal/spark/keep-warm  (also GET for probe)
 *
 * External-heartbeat keep-warm for the Spark session pool.
 *
 * WHY this exists: the warm pool (`spark-session-pool.ts`) keeps `min` Livy
 * sessions warm via an in-process `setInterval` sweeper. In a serverless
 * Container App that sweeper is unreliable — the Node process is only alive
 * while handling requests, replicas recycle, and EVERY roll resets the warm
 * pool to cold. Result: the pool sits cold and the first notebook run pays the
 * full Synapse Spark cold-start (minutes → the 12-min watchdog), which reads as
 * "notebooks are painfully slow". Fabric/Databricks avoid this by keeping compute
 * perpetually warm.
 *
 * The fix is the SAME pattern the scheduler uses (`/api/internal/scheduler/tick`):
 * an EXTERNAL timer (a GitHub Actions `schedule:` / ACA cron Job) pings this
 * endpoint every few minutes. Each hit (a) starts the sweeper if the process
 * just came up, (b) re-adopts any cross-replica warm session from the shared
 * store, and (c) tops the pool back up to `min` — so a warm session is always
 * standing by and the user's run adopts it instead of cold-starting.
 *
 * Auth: the shared internal trust token (`LOOM_INTERNAL_TOKEN`), accepted as
 * `Authorization: Bearer <token>` or `x-loom-internal-token`. NOT a user
 * session — this is machine-to-machine, exactly like the scheduler tick.
 *
 * No mocks: `warmPool()` provisions REAL Livy/Databricks sessions.
 */

import { NextRequest } from 'next/server';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import {
  sparkPoolEnabled,
  sparkPoolBackendStatus,
  ensureWarmPoolStarted,
  adoptFromStore,
  warmPool,
  sparkPoolConfig,
  getPoolStatus,
} from '@/lib/azure/spark-session-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authed(req: NextRequest): boolean {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const header = req.headers.get(INTERNAL_TOKEN_HEADER);
  return isValidInternalToken(bearer || null) || isValidInternalToken(header);
}

async function keepWarm() {
  if (!sparkPoolEnabled()) {
    return apiOk({ skipped: true, reason: 'warm pool disabled (LOOM_SPARK_POOL_ENABLED=false)' });
  }
  const gate = sparkPoolBackendStatus();
  if (!gate.configured) {
    // Honest no-op: nothing to warm against yet (no Spark backend configured).
    return apiOk({ skipped: true, reason: `Spark backend not configured — ${gate.missing || 'set the Synapse/Databricks env'}` });
  }
  // (a) ensure the in-process sweeper is running after a cold start / recycle,
  // (b) re-adopt any warm session another replica registered in the shared
  //     store, then (c) top the DEFAULT group back up to `min`.
  ensureWarmPoolStarted();
  await adoptFromStore().catch(() => {});
  await warmPool().catch(() => {});
  const cfg = sparkPoolConfig();
  const status = getPoolStatus();
  return apiOk({
    keptWarm: true,
    min: cfg.min,
    totals: status?.totals ?? null,
    replicaId: status?.store?.replicaId,
  });
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return apiError('unauthorized — internal token required', 401);
  try {
    return await keepWarm();
  } catch (e) {
    return apiServerError(e);
  }
}

// GET is convenient for a curl heartbeat / uptime probe with the same auth.
export async function GET(req: NextRequest) {
  if (!authed(req)) return apiError('unauthorized — internal token required', 401);
  try {
    return await keepWarm();
  } catch (e) {
    return apiServerError(e);
  }
}
