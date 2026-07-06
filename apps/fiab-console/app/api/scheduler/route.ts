/**
 * /api/scheduler — the UNIFIED cross-item scheduler collection (rel-T81).
 *
 *   GET  → { ok, configured, schedules, jobKinds, gate? } — every schedule in
 *          the caller's tenant (tenant-scoped by tenantScopeId). When Cosmos is
 *          unconfigured, { ok:true, configured:false, gate } so the page renders
 *          an honest MessageBar instead of erroring.
 *   POST → create a schedule (validated). { ok, schedule }.
 *
 * Tenant isolation: schedules are partitioned by the caller's Entra tenant id.
 * A read/write never crosses tenants. Real Cosmos data plane — no mocks.
 */
import { NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import {
  listSchedules,
  upsertSchedule,
  scheduleId,
  schedulerConfigGate,
  JOB_KINDS,
  type ScheduleDoc,
} from '@/lib/azure/scheduler-store';
import { validateScheduleInput } from '@/lib/scheduler/schedule-input';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const gate = schedulerConfigGate();
  if (gate) return apiOk({ configured: false, gate, schedules: [], jobKinds: JOB_KINDS });

  try {
    const tenantId = tenantScopeId(session);
    const schedules = await listSchedules(tenantId);
    return apiOk({ configured: true, schedules, jobKinds: JOB_KINDS });
  } catch (e) {
    return apiServerError(e, 'failed to list schedules');
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const gate = schedulerConfigGate();
  if (gate) return apiError(`Scheduler store not configured: ${gate.missing}`, 503, { gate });

  const body = await req.json().catch(() => ({}));
  const parsed = validateScheduleInput(body);
  if ('errors' in parsed) return apiError(parsed.errors.join('; '), 400, { errors: parsed.errors });

  try {
    const tenantId = tenantScopeId(session);
    const now = new Date().toISOString();
    const doc: ScheduleDoc = {
      id: scheduleId(parsed.value.displayName),
      tenantId,
      displayName: parsed.value.displayName,
      itemRef: parsed.value.itemRef,
      jobKind: parsed.value.jobKind,
      jobConfig: parsed.value.jobConfig,
      cron: parsed.value.cron,
      timezone: parsed.value.timezone,
      enabled: parsed.value.enabled,
      notify: parsed.value.notify,
      createdBy: session.claims.oid,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await upsertSchedule(doc);
    try { console.info(`[scheduler.POST] receipt: ${JSON.stringify({ ok: true, id: saved.id, jobKind: saved.jobKind }).slice(0, 300)}`); } catch { /* noop */ }
    return apiOk({ schedule: saved });
  } catch (e) {
    return apiServerError(e, 'failed to create schedule');
  }
}
