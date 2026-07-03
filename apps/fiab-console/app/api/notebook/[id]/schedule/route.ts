/**
 * Notebook scheduling (recurrence only, no raw cron) for the Synapse Notebook
 * editor. Keyed by the Cosmos notebook item `id`. Drives the real Azure ML
 * `Microsoft.MachineLearningServices/workspaces/schedules` ARM resource (GA,
 * api-version 2024-10-01) via the Console UAMI (ChainedTokenCredential), which
 * already holds AzureML Data Scientist (covers schedules read/write + jobs
 * write — see platform/fiab/bicep/modules/deploy-planner/ml-workspace.bicep).
 *
 *   GET   /api/notebook/[id]/schedule
 *     → { ok, configured, schedules } — every AML schedule whose name starts
 *       with loom-nb-<id>-. When the AML workspace env is unset, returns
 *       { ok:true, configured:false, missing, hint } so the wizard shows an
 *       honest Fluent MessageBar (no Fabric dependency — this is Azure-native).
 *
 *   POST  /api/notebook/[id]/schedule
 *     body { displayName, frequency, interval, startTime?, timeZone?, computeId?, environmentId? }
 *     → PUTs a RecurrenceTrigger + CreateJob (Command) schedule. Returns
 *       { ok, schedule } with the real ARM resource shape.
 *
 *   PATCH /api/notebook/[id]/schedule
 *     body { scheduleName, isEnabled }
 *     → re-PUTs the existing schedule with isEnabled toggled. { ok, schedule }.
 *
 * Real ARM only — armBase() covers Commercial + GCC-High/IL5. No mocks, no cron.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  amlScheduleConfig,
  isAmlScheduleConfigured,
  notebookSchedulePrefix,
  listNotebookSchedules,
  createNotebookSchedule,
  setScheduleEnabled,
  AmlScheduleNotConfiguredError,
  FoundryError,
  type AmlFrequency,
} from '@/lib/azure/foundry-client';
import { loadAccessibleNotebook } from '../../_lib/notebook-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FREQUENCIES: AmlFrequency[] = ['Minute', 'Hour', 'Day', 'Week', 'Month'];

function gateBody() {
  // amlScheduleConfig throws AmlScheduleNotConfiguredError carrying the missing
  // vars + hint — surface it as an honest config-only state (HTTP 200, the
  // wizard renders a MessageBar rather than erroring).
  try {
    amlScheduleConfig();
    return null;
  } catch (e) {
    if (e instanceof AmlScheduleNotConfiguredError) {
      return { ok: true, configured: false, missing: e.missing, hint: e.hint, schedules: [] };
    }
    throw e;
  }
}

function errStatus(e: unknown): number {
  return e instanceof FoundryError && typeof e.status === 'number' && e.status >= 400 ? e.status : 502;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = gateBody();
  if (gate) return NextResponse.json(gate);

  const { id } = await ctx.params;
  // rel-T19 — only the notebook's owner / shared ACL members may list its
  // schedules; otherwise a stranger could enumerate them by guessing the id.
  const nb = await loadAccessibleNotebook(id, session.claims.oid, { write: false });
  if (!nb) return NextResponse.json({ ok: false, error: 'notebook not found' }, { status: 404 });
  try {
    const schedules = await listNotebookSchedules(notebookSchedulePrefix(id));
    return NextResponse.json({ ok: true, configured: true, schedules });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: errStatus(e) });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  if (!isAmlScheduleConfigured()) {
    const gate = gateBody();
    return NextResponse.json(gate ?? { ok: false, error: 'not configured' });
  }

  const { id } = await ctx.params;
  // rel-T19 — creating a schedule mutates a per-notebook AML resource; require
  // write-capable access to the notebook item.
  const nb = await loadAccessibleNotebook(id, session.claims.oid, { write: true });
  if (!nb) return NextResponse.json({ ok: false, error: 'notebook not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));

  const displayName: string = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
  if (!displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });

  const frequency = body?.frequency as AmlFrequency;
  if (!FREQUENCIES.includes(frequency)) {
    return NextResponse.json({ ok: false, error: `frequency must be one of ${FREQUENCIES.join(', ')}` }, { status: 400 });
  }

  const interval = Number(body?.interval);
  if (!Number.isFinite(interval) || interval < 1) {
    return NextResponse.json({ ok: false, error: 'interval must be a positive integer' }, { status: 400 });
  }

  const scheduleName = `${notebookSchedulePrefix(id)}${Date.now().toString(36)}`;
  try {
    const schedule = await createNotebookSchedule(scheduleName, {
      displayName,
      frequency,
      interval: Math.floor(interval),
      startTime: typeof body?.startTime === 'string' && body.startTime ? body.startTime : undefined,
      timeZone: typeof body?.timeZone === 'string' && body.timeZone ? body.timeZone : 'UTC',
      computeId: typeof body?.computeId === 'string' && body.computeId ? body.computeId : undefined,
      environmentId: typeof body?.environmentId === 'string' && body.environmentId ? body.environmentId : undefined,
    });
    return NextResponse.json({ ok: true, schedule });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: errStatus(e) });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  if (!isAmlScheduleConfigured()) {
    const gate = gateBody();
    return NextResponse.json(gate ?? { ok: false, error: 'not configured' });
  }

  const { id } = await ctx.params;
  // rel-T19 — toggling a schedule mutates a per-notebook AML resource; require
  // write-capable access to the notebook item.
  const nb = await loadAccessibleNotebook(id, session.claims.oid, { write: true });
  if (!nb) return NextResponse.json({ ok: false, error: 'notebook not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const scheduleName: string = typeof body?.scheduleName === 'string' ? body.scheduleName.trim() : '';
  if (!scheduleName) return NextResponse.json({ ok: false, error: 'scheduleName is required' }, { status: 400 });
  if (typeof body?.isEnabled !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'isEnabled (boolean) is required' }, { status: 400 });
  }
  // The schedule must belong to THIS notebook (its name carries the id prefix),
  // so an owner of notebook A cannot toggle notebook B's schedule.
  if (!scheduleName.startsWith(notebookSchedulePrefix(id))) {
    return NextResponse.json({ ok: false, error: "scheduleName does not belong to this notebook" }, { status: 403 });
  }

  try {
    const schedule = await setScheduleEnabled(scheduleName, body.isEnabled);
    return NextResponse.json({ ok: true, schedule });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: errStatus(e) });
  }
}
