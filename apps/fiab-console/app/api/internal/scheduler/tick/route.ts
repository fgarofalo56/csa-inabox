/**
 * POST /api/internal/scheduler/tick — the unified scheduler's EVALUATOR (rel-T81).
 *
 * Next.js has no always-on cron daemon, so scheduled firing is driven by an
 * EXTERNAL timer (an ACA cron Job / GitHub Actions schedule / Azure Monitor
 * scheduled query) that POSTs this endpoint once a minute. Each tick:
 *   1. loads every ENABLED schedule (all tenants — this runs as the platform,
 *      not a user session),
 *   2. for each, tests whether its cron fired in the window (lastTickAt, now]
 *      evaluated in the schedule's timezone,
 *   3. triggers the REAL backend run (same run-adapter the run-now route uses),
 *      records the run, fires failure notifications, and advances the watermark.
 *
 * Auth: the shared, bicep-wired internal trust token (LOOM_INTERNAL_TOKEN),
 * accepted as `Authorization: Bearer <token>` or `x-loom-internal-token`. NOT
 * cookie-authenticated (a timer has no MSAL session) and FAILS CLOSED when the
 * token env var is unset — so this endpoint is inert until a deployment opts in.
 *
 * Idempotency: the (lastTickAt, now] window + a per-schedule watermark means a
 * missed or duplicated tick invocation never double-fires the same minute.
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import {
  listAllEnabledSchedules,
  upsertSchedule,
  recordRun,
  schedulerConfigGate,
  type RunDoc,
  type ScheduleDoc,
} from '@/lib/azure/scheduler-store';
import { firedInWindow } from '@/lib/scheduler/cron';
import { gateFor, triggerRun } from '@/lib/scheduler/run-adapters';
import { notifyFailure } from '@/lib/scheduler/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Cap how many due schedules a single tick will run, so one minute can't stall. */
const MAX_PER_TICK = 25;

function presentedToken(req: NextRequest): string | null {
  const h = req.headers.get(INTERNAL_TOKEN_HEADER);
  if (h) return h;
  const auth = req.headers.get('authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return null;
}

async function runDueSchedule(schedule: ScheduleDoc, now: Date): Promise<'ran' | 'skipped' | 'gated'> {
  const backendGate = await gateFor(schedule.jobKind);
  if (backendGate) {
    // Advance the watermark so we don't re-evaluate the same window forever,
    // but do NOT fabricate a run — the backend isn't configured.
    await upsertSchedule({ ...schedule, lastTickAt: now.toISOString() });
    return 'gated';
  }
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const result = await triggerRun(schedule);
  const finishedAt = new Date().toISOString();
  const run: RunDoc = {
    id: crypto.randomUUID(),
    scheduleId: schedule.id,
    tenantId: schedule.tenantId,
    trigger: 'scheduled',
    status: result.status,
    startedAt,
    finishedAt,
    durationMs: Date.now() - t0,
    ...(result.runId ? { runId: result.runId } : {}),
    ...(result.exitValue ? { exitValue: result.exitValue } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
  await recordRun(run);
  await upsertSchedule({
    ...schedule,
    lastRunAt: finishedAt,
    lastStatus: result.status,
    lastTickAt: now.toISOString(),
    updatedAt: finishedAt,
  });
  if (result.status === 'failed') await notifyFailure(schedule, run);
  return 'ran';
}

export async function POST(req: NextRequest) {
  if (!isValidInternalToken(presentedToken(req))) {
    return apiError('unauthorized', 401);
  }
  const gate = schedulerConfigGate();
  if (gate) return apiError(`Scheduler store not configured: ${gate.missing}`, 503, { gate });

  const now = new Date();
  try {
    const schedules = await listAllEnabledSchedules();
    let evaluated = 0;
    let ran = 0;
    let gated = 0;
    const due: ScheduleDoc[] = [];
    for (const s of schedules) {
      evaluated++;
      // Window opens at the last watermark (or 1 minute ago on first sight) and
      // closes now. A fresh schedule with no watermark only fires from "now".
      const after = s.lastTickAt ? new Date(s.lastTickAt) : new Date(now.getTime() - 60000);
      if (firedInWindow(s.cron, after, now, s.timezone)) due.push(s);
      else await upsertSchedule({ ...s, lastTickAt: now.toISOString() }); // advance watermark for non-due
    }
    for (const s of due.slice(0, MAX_PER_TICK)) {
      const outcome = await runDueSchedule(s, now);
      if (outcome === 'ran') ran++;
      else if (outcome === 'gated') gated++;
    }
    return apiOk({ evaluated, due: due.length, ran, gated, at: now.toISOString() });
  } catch (e) {
    return apiServerError(e, 'scheduler tick failed');
  }
}
