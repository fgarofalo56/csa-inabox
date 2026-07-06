/**
 * /api/scheduler/[id]/runs — run history for a schedule (rel-T81).
 *
 *   GET → { ok, runs } — the most recent runs (status, trigger, exit value,
 *          duration, error), newest first. Real Cosmos read from the
 *          `schedule-runs` container. No mocks.
 *
 * Tenant isolation: the parent schedule is point-read with the caller's
 * tenantScopeId first; runs are only returned when the caller owns the schedule's
 * tenant (a wrong-tenant id 404s before any run is read).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { getSchedule, listRuns, schedulerConfigGate } from '@/lib/azure/scheduler-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tenant partition key for this caller (mirrors tenantScopeId) — the parent
 * schedule is point-read by (id, tenantId), so runs are only returned to the
 * owning tenant; a wrong-tenant id 404s before any run is read. */
function callerTenant(session: { claims: { tid?: string; oid: string } }): string {
  return session.claims.tid || session.claims.oid;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const gate = schedulerConfigGate();
  if (gate) return apiError(`Scheduler store not configured: ${gate.missing}`, 503, { gate });

  const { id } = await ctx.params;
  const tenantId = callerTenant(session);
  const limit = Number(req.nextUrl.searchParams.get('limit')) || 50;
  try {
    // Authorize: the caller must own the schedule (tenant-scoped point read).
    const schedule = await getSchedule(tenantId, id);
    if (!schedule) return apiNotFound('schedule not found');
    const runs = await listRuns(id, limit);
    return apiOk({ runs });
  } catch (e) {
    return apiServerError(e, 'failed to list runs');
  }
}
