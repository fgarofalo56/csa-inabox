/**
 * GET   /api/items/semantic-model/[id]/refresh-schedule?workspaceId=...
 * PATCH /api/items/semantic-model/[id]/refresh-schedule?workspaceId=...
 *
 * Reads + writes the dataset's scheduled refresh against the REAL Power BI
 * REST API (groupId-scoped):
 *   GET   /groups/{ws}/datasets/{id}/refreshSchedule
 *   PATCH /groups/{ws}/datasets/{id}/refreshSchedule   body { value: {...} }
 *
 * Matches the Power BI service "Scheduled refresh" pane (enable toggle, days,
 * times, time zone, failure-notification). Power BI 400s if you enable the
 * schedule without at least one day + time, or if the calling principal isn't
 * the dataset owner — both surface verbatim so the editor can show a precise
 * MessageBar (use Take over to fix the ownership case). No mocks.
 *
 * Docs: https://learn.microsoft.com/rest/api/power-bi/datasets/update-refresh-schedule-in-group
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getRefreshSchedule,
  patchRefreshSchedule,
  PowerBiError,
  type RefreshScheduleWrite,
} from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_DAYS = new Set([
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]);
const TIME_RE = /^([01]\d|2[0-3]):(00|30)$/; // HH:MM on 30-minute boundaries

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const schedule = await getRefreshSchedule(workspaceId, (await ctx.params).id);
    return NextResponse.json({ ok: true, schedule });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as RefreshScheduleWrite;

  // Shape + validate before we touch Power BI so the editor gets fast, precise
  // client-side errors instead of an opaque PBI 400.
  const value: RefreshScheduleWrite = {};
  if (typeof body.enabled === 'boolean') value.enabled = body.enabled;
  if (Array.isArray(body.days)) {
    const bad = body.days.filter((d) => !VALID_DAYS.has(d));
    if (bad.length) {
      return NextResponse.json({ ok: false, error: `invalid day(s): ${bad.join(', ')}` }, { status: 400 });
    }
    value.days = body.days;
  }
  if (Array.isArray(body.times)) {
    const bad = body.times.filter((t) => !TIME_RE.test(t));
    if (bad.length) {
      return NextResponse.json(
        { ok: false, error: `times must be HH:MM on a 30-minute boundary; invalid: ${bad.join(', ')}` },
        { status: 400 },
      );
    }
    value.times = body.times;
  }
  if (typeof body.localTimeZoneId === 'string' && body.localTimeZoneId) value.localTimeZoneId = body.localTimeZoneId;
  if (body.notifyOption === 'MailOnFailure' || body.notifyOption === 'NoNotification') {
    value.notifyOption = body.notifyOption;
  }

  if (value.enabled === true && ((value.days?.length ?? 0) === 0 || (value.times?.length ?? 0) === 0)) {
    return NextResponse.json(
      { ok: false, error: 'enabling the schedule requires at least one day and one time' },
      { status: 400 },
    );
  }

  try {
    await patchRefreshSchedule(workspaceId, (await ctx.params).id, value);
    const schedule = await getRefreshSchedule(workspaceId, (await ctx.params).id);
    return NextResponse.json({ ok: true, schedule });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}
