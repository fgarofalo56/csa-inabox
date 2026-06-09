/**
 * GET   /api/items/semantic-model/[id]/refresh-schedule
 * PATCH /api/items/semantic-model/[id]/refresh-schedule
 *
 * Power BI backend (LOOM_BI_BACKEND=powerbi or no-AAS legacy fallback):
 *   reads/writes the dataset's scheduled refresh against the REAL Power BI
 *   REST API (groupId-scoped, ?workspaceId=...). Times must be on a 30-minute
 *   boundary (a Power BI constraint).
 *
 * AAS backend (Azure-native default): reads/writes the schedule as a JSON ARM
 *   tag (`loom-refresh-schedule`) on the AAS server resource via
 *   set/getRefreshSchedule() in aas-client.ts. AAS has no 30-minute-boundary
 *   constraint (the schedule is Loom-managed), so times are stored verbatim.
 *   When AAS is selected but LOOM_AAS_SERVER_NAME is unset → 503 honest gate.
 *
 * Both backends return { ok, schedule } and validate shape before touching the
 * backend so the editor gets fast, precise client-side errors. No mocks.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/datasets/update-refresh-schedule-in-group
 *       https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getRefreshSchedule as pbiGetRefreshSchedule,
  patchRefreshSchedule,
  PowerBiError,
  type RefreshScheduleWrite,
} from '@/lib/azure/powerbi-client';
import {
  getRefreshSchedule as aasGetRefreshSchedule,
  setRefreshSchedule as aasSetRefreshSchedule,
  aasConfigGate,
  AasError,
  type AasScheduleWrite,
} from '@/lib/azure/aas-client';
import { usingAas } from '../../_lib/bi-backend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_DAYS = new Set([
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]);
const PBI_TIME_RE = /^([01]\d|2[0-3]):(00|30)$/; // HH:MM on 30-minute boundaries (Power BI)
const AAS_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/; // HH:MM any minute (AAS — Loom-managed)

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;

  if (usingAas()) {
    const gate = aasConfigGate();
    if (gate) {
      return NextResponse.json({ ok: false, error: `Azure Analysis Services not configured: ${gate.missing}`, gate }, { status: 503 });
    }
    try {
      const schedule = await aasGetRefreshSchedule();
      try { console.info(`[aas/refresh-schedule.GET] receipt: ${JSON.stringify({ ok: true, schedule }).slice(0, 300)}`); } catch { /* noop */ }
      return NextResponse.json({ ok: true, schedule });
    } catch (e: any) {
      const status = e instanceof AasError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const schedule = await pbiGetRefreshSchedule(workspaceId, id);
    return NextResponse.json({ ok: true, schedule });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // ── AAS path ──────────────────────────────────────────────────────────
  if (usingAas()) {
    const gate = aasConfigGate();
    if (gate) {
      return NextResponse.json({ ok: false, error: `Azure Analysis Services not configured: ${gate.missing}`, gate }, { status: 503 });
    }
    const enabled = !!body.enabled;
    const days = Array.isArray(body.days) ? (body.days as string[]) : [];
    const times = Array.isArray(body.times) ? (body.times as string[]) : [];
    const badDays = days.filter((d) => !VALID_DAYS.has(d));
    if (badDays.length) return NextResponse.json({ ok: false, error: `invalid day(s): ${badDays.join(', ')}` }, { status: 400 });
    const badTimes = times.filter((t) => !AAS_TIME_RE.test(t));
    if (badTimes.length) return NextResponse.json({ ok: false, error: `times must be HH:MM (24h); invalid: ${badTimes.join(', ')}` }, { status: 400 });
    if (enabled && (days.length === 0 || times.length === 0)) {
      return NextResponse.json({ ok: false, error: 'enabling the schedule requires at least one day and one time' }, { status: 400 });
    }
    const notifyOption = body.notifyOption === 'MailOnFailure' ? 'MailOnFailure' : 'NoNotification';
    const write: AasScheduleWrite = {
      enabled,
      days: days as AasScheduleWrite['days'],
      times,
      localTimeZoneId: typeof body.localTimeZoneId === 'string' && body.localTimeZoneId ? body.localTimeZoneId : 'UTC',
      notifyOption,
    };
    try {
      const schedule = await aasSetRefreshSchedule(write);
      const out = { ok: true as const, schedule };
      try { console.info(`[aas/refresh-schedule.PATCH] receipt: ${JSON.stringify(out).slice(0, 300)}`); } catch { /* noop */ }
      return NextResponse.json(out);
    } catch (e: any) {
      const status = e instanceof AasError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  // ── Power BI path ─────────────────────────────────────────────────────
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const value: RefreshScheduleWrite = {};
  if (typeof body.enabled === 'boolean') value.enabled = body.enabled;
  if (Array.isArray(body.days)) {
    const bad = (body.days as string[]).filter((d) => !VALID_DAYS.has(d));
    if (bad.length) return NextResponse.json({ ok: false, error: `invalid day(s): ${bad.join(', ')}` }, { status: 400 });
    value.days = body.days as string[];
  }
  if (Array.isArray(body.times)) {
    const bad = (body.times as string[]).filter((t) => !PBI_TIME_RE.test(t));
    if (bad.length) {
      return NextResponse.json({ ok: false, error: `times must be HH:MM on a 30-minute boundary; invalid: ${bad.join(', ')}` }, { status: 400 });
    }
    value.times = body.times as string[];
  }
  if (typeof body.localTimeZoneId === 'string' && body.localTimeZoneId) value.localTimeZoneId = body.localTimeZoneId;
  if (body.notifyOption === 'MailOnFailure' || body.notifyOption === 'NoNotification') {
    value.notifyOption = body.notifyOption;
  }
  if (value.enabled === true && ((value.days?.length ?? 0) === 0 || (value.times?.length ?? 0) === 0)) {
    return NextResponse.json({ ok: false, error: 'enabling the schedule requires at least one day and one time' }, { status: 400 });
  }
  try {
    await patchRefreshSchedule(workspaceId, id, value);
    const schedule = await pbiGetRefreshSchedule(workspaceId, id);
    return NextResponse.json({ ok: true, schedule });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}
