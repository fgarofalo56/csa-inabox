/**
 * /api/scheduler/[id]/run — trigger a schedule's job RIGHT NOW (rel-T81).
 *
 *   POST → run the schedule's real backend job immediately (manual trigger),
 *          record the run in history, fire failure notifications if it failed,
 *          and return { ok, run }.
 *
 * The run is REAL: it calls the same run-adapter the tick evaluator uses, which
 * invokes the existing ADF / ADX / AML-Spark / Synapse-Livy client. If the job
 * backend isn't configured in this deployment, returns an honest 503 naming the
 * missing env var (the UI renders a MessageBar). No mock runs.
 *
 * Tenant isolation: point-read scoped to the caller's tenantScopeId.
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import {
  getSchedule,
  upsertSchedule,
  recordRun,
  schedulerConfigGate,
  type RunDoc,
} from '@/lib/azure/scheduler-store';
import { gateFor, triggerRun } from '@/lib/scheduler/run-adapters';
import { notifyFailure } from '@/lib/scheduler/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Tenant partition key for this caller (mirrors tenantScopeId) — the schedule
 * is point-read by (id, tenantId) so a wrong-tenant id 404s before any run. */
function callerTenant(session: { claims: { tid?: string; oid: string } }): string {
  return session.claims.tid || session.claims.oid;
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const gate = schedulerConfigGate();
  if (gate) return apiError(`Scheduler store not configured: ${gate.missing}`, 503, { gate });

  const { id } = await ctx.params;
  const tenantId = callerTenant(session);
  try {
    const schedule = await getSchedule(tenantId, id);
    if (!schedule) return apiNotFound('schedule not found');

    // Honest backend gate — don't fake a run against an unconfigured backend.
    const backendGate = await gateFor(schedule.jobKind);
    if (backendGate) {
      return apiError(
        `${schedule.jobKind} backend not configured: set ${backendGate.missing}`,
        503,
        { gate: backendGate },
      );
    }

    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const result = await triggerRun(schedule);
    const finishedAt = new Date().toISOString();

    const run: RunDoc = {
      id: crypto.randomUUID(),
      scheduleId: schedule.id,
      tenantId,
      trigger: 'manual',
      status: result.status,
      startedAt,
      finishedAt,
      durationMs: Date.now() - t0,
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.exitValue ? { exitValue: result.exitValue } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    await recordRun(run);

    // Denormalize last-run onto the schedule for fast list rendering.
    await upsertSchedule({ ...schedule, lastRunAt: finishedAt, lastStatus: result.status, updatedAt: finishedAt });

    // Fire failure notifications (best-effort) when the run failed.
    let notified;
    if (result.status === 'failed') notified = await notifyFailure(schedule, run);

    try { console.info(`[scheduler.run] receipt: ${JSON.stringify({ ok: true, id: run.id, status: run.status, runId: run.runId }).slice(0, 300)}`); } catch { /* noop */ }
    return apiOk({ run, ...(notified ? { notified } : {}) });
  } catch (e) {
    return apiServerError(e, 'failed to run schedule');
  }
}
