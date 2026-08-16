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
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — neither handler authorized the caller
 * against the model, so on the Power BI backend any signed-in caller could read
 * AND REWRITE a caller-named dataset's scheduled refresh. It was excused by
 * check-route-guards' SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos
 * ownership to scope"; eight sibling routes under `semantic-model/[id]/**`
 * resolve the SAME `[id]` as an owned Loom item.
 *
 * `authorizeItemWorkspace`, not `withWorkspaceOwner`: `[id]` is legitimately a
 * RAW Power BI dataset GUID on the opt-in path and `loadOwnedItem` renders
 * "no item" as 404. The `?workspaceId=` is a Power BI group id, so the scope is
 * resolved FROM THE ITEM. GET admits read roles; PATCH does not.
 *
 * WHAT THIS DOES **NOT** FIX, stated rather than implied: on the AAS backend the
 * schedule is a JSON ARM tag on the DEPLOYMENT'S SINGLE AAS SERVER —
 * `aasGetRefreshSchedule()` / `aasSetRefreshSchedule(write)` take no model id at
 * all, so that branch is deployment-wide, not per-model, and the guard below can
 * only require that the caller holds a role on SOME model they named. Making the
 * AAS schedule per-model is a storage-shape change, not an authorization one, and
 * is reported rather than silently folded in here.
 */
import { NextRequest, NextResponse } from 'next/server';
import { type SessionPayload } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import {
  getRefreshSchedule as pbiGetRefreshSchedule,
  patchRefreshSchedule,
  PowerBiError,
  type RefreshScheduleWrite,
} from '@/lib/azure/powerbi-client';
import {
  getRefreshSchedule as aasGetRefreshSchedule,
  setRefreshSchedule as aasSetRefreshSchedule,
  aasServerConfigGate,
  AasError,
  type AasScheduleWrite,
} from '@/lib/azure/aas-server-client';
import { usingAasAsync } from '../../_lib/bi-backend';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_DAYS = new Set([
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]);
const PBI_TIME_RE = /^([01]\d|2[0-3]):(00|30)$/; // HH:MM on 30-minute boundaries (Power BI)
const AAS_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/; // HH:MM any minute (AAS — Loom-managed)

/** Canonical owner → tenant-admin → shared-ACL ladder for this model, with the
 *  workspace resolved FROM THE ITEM so authorization cannot be skipped (or
 *  misdirected) by the caller's Power BI `?workspaceId=`. */
async function denyUnlessAuthorized(session: SessionPayload, id: string, opts?: { allowReadRoles?: boolean }) {
  return authorizeItemWorkspace(session, {
    workspaceId: null,
    itemId: id,
    itemType: 'semantic-model',
    notFound: 'semantic model not found',
    ...(opts?.allowReadRoles ? { allowReadRoles: true } : {}),
  });
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const id = params.id;
  // READ surface → any workspace role may view the schedule.
  const denied = await denyUnlessAuthorized(session, id, { allowReadRoles: true });
  if (denied) return denied;

  if (await usingAasAsync()) {
    const gate = aasServerConfigGate();
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
});

export const PATCH = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const id = params.id;
  // WRITE surface → no `allowReadRoles`.
  const denied = await denyUnlessAuthorized(session, id);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // ── AAS path ──────────────────────────────────────────────────────────
  if (await usingAasAsync()) {
    const gate = aasServerConfigGate();
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
});
