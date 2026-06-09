/**
 * Scorecard goals + connected metrics + check-ins BFF.
 *
 * GET  /api/items/scorecard/[id]?workspaceId=...
 *        Returns scorecard metadata + goals, with each goal merged with its
 *        extended Cosmos metadata (status / owner / dueDate / connectedMetric /
 *        subGoalIds). Add `&history=<goalId>` to return that goal's check-in
 *        history instead.
 *
 * POST /api/items/scorecard/[id]?workspaceId=...
 *        Records a goal check-in: { goalId, value, status?, noteText?,
 *        goalValueDate? }. Writes the value to the live Fabric scorecard (when
 *        the scorecard is live) AND appends an immutable check-in row to Cosmos.
 *        For bundle-template scorecards the Cosmos history write still happens.
 *
 * PUT  /api/items/scorecard/[id]?workspaceId=...
 *        Upserts extended goal metadata: { goalId, status?, owner?, dueDate?,
 *        connectedMetric?, subGoalIds? } into Cosmos scorecard-goals.
 *
 * The connected-metric live value is pulled by the sibling /metric-value route
 * (aas-client → Power BI executeQueries) — Azure-native, no Fabric required.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { getScorecard, listScorecardGoals, addScorecardGoalValue, PowerBiError } from '@/lib/azure/powerbi-client';
import {
  scorecardGoalsContainer, scorecardCheckinsContainer,
  type ScorecardGoalRecord, type ScorecardCheckIn, type ScorecardGoalStatus,
} from '@/lib/azure/cosmos-client';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem,
  scorecardGoalsFromContent, scorecardMetaFromContent,
} from '../../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_STATUS: ScorecardGoalStatus[] = ['notStarted', 'onTrack', 'atRisk', 'behindGoal', 'aheadOfGoal', 'completed'];
function coerceStatus(v: unknown): ScorecardGoalStatus | undefined {
  return typeof v === 'string' && (VALID_STATUS as string[]).includes(v) ? (v as ScorecardGoalStatus) : undefined;
}

/** Load every extended goal record for a scorecard (single-partition query). */
async function loadGoalRecords(scorecardId: string): Promise<Map<string, ScorecardGoalRecord>> {
  const c = await scorecardGoalsContainer();
  const { resources } = await c.items
    .query<ScorecardGoalRecord>({
      query: 'SELECT * FROM c WHERE c.scorecardId = @sid',
      parameters: [{ name: '@sid', value: scorecardId }],
    }, { partitionKey: scorecardId })
    .fetchAll();
  const map = new Map<string, ScorecardGoalRecord>();
  for (const r of resources) map.set(r.goalId, r);
  return map;
}

/** Merge base goals (Fabric/bundle) with their extended Cosmos metadata. */
function mergeGoals(base: any[], records: Map<string, ScorecardGoalRecord>): any[] {
  return (base || []).map((g) => {
    const rec = g.id ? records.get(String(g.id)) : undefined;
    if (!rec) return g;
    return {
      ...g,
      status: g.status ?? rec.status,
      owner: g.owner ?? rec.owner,
      dueDate: g.dueDate ?? rec.dueDate,
      connectedMetric: rec.connectedMetric,
      subGoalIds: g.subGoalIds ?? rec.subGoalIds,
      // Surface the last live metric pull as the current value when the goal
      // has no inline current value of its own.
      currentValue: g.currentValue ?? rec.connectedMetric?.lastValue,
    };
  });
}

async function loomScorecard(cosmosItemId: string, tenantId: string, workspaceId: string, scorecardKey: string) {
  const item = await loadContentBackedItem(cosmosItemId, 'scorecard', tenantId);
  if (!item) return null;
  const goals = scorecardGoalsFromContent(item);
  const scorecard = scorecardMetaFromContent(item);
  if (!goals || !scorecard) return null;
  const records = await loadGoalRecords(scorecardKey).catch(() => new Map<string, ScorecardGoalRecord>());
  return NextResponse.json({ ok: true, workspaceId, scorecard, goals: mergeGoals(goals, records) });
}

async function goalHistory(scorecardId: string, goalId: string) {
  const c = await scorecardCheckinsContainer();
  const { resources } = await c.items
    .query<ScorecardCheckIn>({
      query: 'SELECT * FROM c WHERE c.goalId = @gid AND c.scorecardId = @sid ORDER BY c.recordedAt DESC',
      parameters: [{ name: '@gid', value: goalId }, { name: '@sid', value: scorecardId }],
    }, { partitionKey: goalId })
    .fetchAll();
  return resources;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const id = (await ctx.params).id;

  // Check-in history for a single goal.
  const historyGoal = req.nextUrl.searchParams.get('history');
  if (historyGoal) {
    try {
      const checkIns = await goalHistory(id, historyGoal);
      return NextResponse.json({ ok: true, goalId: historyGoal, checkIns });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // Bundle-installed scorecard → OKR goals come from state.content.
  if (isLoomContentId(id)) {
    const resp = await loomScorecard(cosmosIdFromLoomId(id), session.claims.oid, workspaceId, id);
    if (resp) return resp;
    return NextResponse.json({ ok: false, error: 'scorecard template not found' }, { status: 404 });
  }

  try {
    const [scorecard, goals, records] = await Promise.all([
      getScorecard(workspaceId, id),
      listScorecardGoals(workspaceId, id).catch(() => []),
      loadGoalRecords(id).catch(() => new Map<string, ScorecardGoalRecord>()),
    ]);
    return NextResponse.json({ ok: true, workspaceId, scorecard, goals: mergeGoals(goals, records) });
  } catch (e: any) {
    if (e instanceof PowerBiError && e.status === 404) {
      const resp = await loomScorecard(id, session.claims.oid, workspaceId, id);
      if (resp) return resp;
    }
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const id = (await ctx.params).id;
  const goalId = String(body?.goalId || '');
  const value = Number(body?.value);
  if (!goalId || !Number.isFinite(value)) {
    return NextResponse.json({ ok: false, error: 'goalId and numeric value required' }, { status: 400 });
  }
  const status = coerceStatus(body?.status);
  const note = body?.noteText ? String(body.noteText) : undefined;
  const checkInDate = body?.goalValueDate ? String(body.goalValueDate) : undefined;

  // Always record the check-in to Cosmos history (the source of truth for the
  // editor's history view — works for live Fabric scorecards AND bundle
  // templates, with no Fabric dependency).
  const checkIn: ScorecardCheckIn = {
    id: crypto.randomUUID(),
    goalId,
    scorecardId: id,
    value,
    status,
    note,
    checkInDate: checkInDate || new Date().toISOString().slice(0, 10),
    source: body?.source === 'metric' ? 'metric' : 'manual',
    recordedAt: new Date().toISOString(),
    recordedBy: session.claims.oid,
  };
  try {
    const c = await scorecardCheckinsContainer();
    await c.items.create(checkIn);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `failed to record check-in: ${e?.message || String(e)}` }, { status: 502 });
  }

  // If the new check-in carries a status, fold it into the goal record so the
  // grid reflects the latest band immediately.
  if (status) {
    try {
      const gc = await scorecardGoalsContainer();
      const recId = `${id}:${goalId}`;
      let rec: ScorecardGoalRecord;
      try {
        const { resource } = await gc.item(recId, id).read<ScorecardGoalRecord>();
        rec = resource || { id: recId, scorecardId: id, goalId, updatedAt: '', updatedBy: '' };
      } catch {
        rec = { id: recId, scorecardId: id, goalId, updatedAt: '', updatedBy: '' };
      }
      rec.status = status;
      rec.updatedAt = new Date().toISOString();
      rec.updatedBy = session.claims.oid;
      await gc.items.upsert(rec);
    } catch { /* status fold is best-effort; history write already succeeded */ }
  }

  // Bundle-template scorecard (not yet a live Fabric scorecard): the Cosmos
  // check-in is recorded above; there is no live Fabric goal to push to.
  if (isLoomContentId(id)) {
    return NextResponse.json({
      ok: true,
      checkIn,
      fabric: { recorded: false, reason: 'scorecard_template_not_live' },
    });
  }

  // Live Fabric scorecard — also push the value to the Fabric goal.
  try {
    const result = await addScorecardGoalValue(workspaceId, id, goalId, {
      value,
      targetValue: typeof body?.targetValue === 'number' ? body.targetValue : undefined,
      noteText: note,
      goalValueDate: checkInDate,
    });
    return NextResponse.json({ ok: true, checkIn, fabric: { recorded: true, result } });
  } catch (e: any) {
    // The Cosmos history write already succeeded — surface the Fabric error but
    // keep ok:true so the editor records local history even when the Fabric
    // scorecard REST (preview) is unavailable in this tenant.
    const fabricStatus = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({
      ok: true,
      checkIn,
      fabric: { recorded: false, error: e?.message || String(e), status: fabricStatus },
    });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = (await ctx.params).id;
  const goalId = String(body?.goalId || '');
  if (!goalId) return NextResponse.json({ ok: false, error: 'goalId required' }, { status: 400 });

  // Validate an inbound connected-metric binding (all three fields required).
  let connectedMetric: ScorecardGoalRecord['connectedMetric'];
  if (body?.connectedMetric) {
    const m = body.connectedMetric;
    if (!m.workspaceId || !m.datasetId || !m.daxExpression) {
      return NextResponse.json({ ok: false, error: 'connectedMetric requires workspaceId, datasetId, and daxExpression' }, { status: 400 });
    }
    connectedMetric = {
      workspaceId: String(m.workspaceId),
      datasetId: String(m.datasetId),
      daxExpression: String(m.daxExpression),
    };
  }

  const recId = `${id}:${goalId}`;
  try {
    const gc = await scorecardGoalsContainer();
    let rec: ScorecardGoalRecord;
    try {
      const { resource } = await gc.item(recId, id).read<ScorecardGoalRecord>();
      rec = resource || { id: recId, scorecardId: id, goalId, updatedAt: '', updatedBy: '' };
    } catch {
      rec = { id: recId, scorecardId: id, goalId, updatedAt: '', updatedBy: '' };
    }
    if (connectedMetric) rec.connectedMetric = { ...rec.connectedMetric, ...connectedMetric };
    if (body?.clearMetric === true) rec.connectedMetric = undefined;
    const status = coerceStatus(body?.status);
    if (status) rec.status = status;
    if (body?.owner !== undefined) rec.owner = body.owner ? String(body.owner) : undefined;
    if (body?.dueDate !== undefined) rec.dueDate = body.dueDate ? String(body.dueDate) : undefined;
    if (Array.isArray(body?.subGoalIds)) rec.subGoalIds = body.subGoalIds.map(String);
    rec.updatedAt = new Date().toISOString();
    rec.updatedBy = session.claims.oid;
    const { resource } = await gc.items.upsert(rec);
    return NextResponse.json({ ok: true, goal: resource });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
