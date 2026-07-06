/**
 * /api/scheduler/[id] — single-schedule read / update / delete (rel-T81).
 *
 *   GET    → { ok, schedule, nextFires } — the schedule + a preview of the next
 *            fire times (computed from its cron + timezone).
 *   PATCH  → update a schedule. Two shapes:
 *              • { enabled: boolean }            — quick enable/disable toggle
 *              • a full validated schedule body  — edit cron/job/notify/etc.
 *   DELETE → remove the schedule.
 *
 * Tenant isolation: the schedule's partition key IS its tenantId, so a point
 * read/write with the caller's tenantScopeId can only ever touch the caller's
 * own tenant's schedule — a wrong-tenant id simply 404s (no cross-tenant hole).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import {
  getSchedule,
  upsertSchedule,
  deleteSchedule,
  schedulerConfigGate,
  type ScheduleDoc,
} from '@/lib/azure/scheduler-store';
import { validateScheduleInput } from '@/lib/scheduler/schedule-input';
import { nextFireTimes } from '@/lib/scheduler/cron';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tenant partition key for this caller — a schedule is owned by its tenant, so
 * every point read/write below is scoped by (id, tenantId): a wrong-tenant id
 * simply misses (404), never a cross-tenant read. Mirrors tenantScopeId(). */
function callerTenant(session: { claims: { tid?: string; oid: string } }): string {
  return session.claims.tid || session.claims.oid;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const gate = schedulerConfigGate();
  if (gate) return apiError(`Scheduler store not configured: ${gate.missing}`, 503, { gate });

  const { id } = await ctx.params;
  try {
    const schedule = await getSchedule(callerTenant(session), id);
    if (!schedule) return apiNotFound('schedule not found');
    const nextFires = nextFireTimes(schedule.cron, new Date(), 5, schedule.timezone).map((d) => d.toISOString());
    return apiOk({ schedule, nextFires });
  } catch (e) {
    return apiServerError(e, 'failed to read schedule');
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const gate = schedulerConfigGate();
  if (gate) return apiError(`Scheduler store not configured: ${gate.missing}`, 503, { gate });

  const { id } = await ctx.params;
  const tenantId = callerTenant(session);
  const body = await req.json().catch(() => ({}));

  try {
    const existing = await getSchedule(tenantId, id);
    if (!existing) return apiNotFound('schedule not found');

    // Quick enable/disable toggle — the ONLY key in the body is `enabled`.
    const keys = Object.keys(body);
    if (keys.length === 1 && typeof body.enabled === 'boolean') {
      const updated: ScheduleDoc = { ...existing, enabled: body.enabled, updatedAt: new Date().toISOString() };
      const saved = await upsertSchedule(updated);
      return apiOk({ schedule: saved });
    }

    // Full edit — validate the whole body.
    const parsed = validateScheduleInput(body);
    if ('errors' in parsed) return apiError(parsed.errors.join('; '), 400, { errors: parsed.errors });
    const updated: ScheduleDoc = {
      ...existing,
      displayName: parsed.value.displayName,
      itemRef: parsed.value.itemRef,
      jobKind: parsed.value.jobKind,
      jobConfig: parsed.value.jobConfig,
      cron: parsed.value.cron,
      timezone: parsed.value.timezone,
      enabled: parsed.value.enabled,
      notify: parsed.value.notify,
      updatedAt: new Date().toISOString(),
    };
    const saved = await upsertSchedule(updated);
    return apiOk({ schedule: saved });
  } catch (e) {
    return apiServerError(e, 'failed to update schedule');
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const gate = schedulerConfigGate();
  if (gate) return apiError(`Scheduler store not configured: ${gate.missing}`, 503, { gate });

  const { id } = await ctx.params;
  const tenantId = callerTenant(session);
  try {
    const existing = await getSchedule(tenantId, id);
    if (!existing) return apiNotFound('schedule not found');
    await deleteSchedule(tenantId, id);
    return apiOk({ deleted: id });
  } catch (e) {
    return apiServerError(e, 'failed to delete schedule');
  }
}
