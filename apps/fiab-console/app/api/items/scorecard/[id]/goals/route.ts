/**
 * GET    /api/items/scorecard/[id]/goals
 * POST   /api/items/scorecard/[id]/goals   — create/update goal(s)
 * DELETE /api/items/scorecard/[id]/goals   — remove a goal
 *
 * Goal AUTHORING for a Loom-native scorecard: writes `state.content.okrs`
 * (`ScorecardContent`) on an EXISTING item — the SAME slot
 * `pbi-content-fallback.scorecardGoalsFromContent` READS and the sibling
 * `/config` PATCH decorates. Until now `/config` could only edit rollup/parent
 * metadata of goals that already existed, and goals only ever arrived via the
 * install bundle — so an empty scorecard shell (0 goals) had no way to author
 * goals. This route creates/updates/deletes them in place.
 *
 * POST body — a single goal or a batch (upsert by id):
 *   { goal:  ScorecardOkr }
 *   { goals: ScorecardOkr[] }
 *   A goal with no `id` is CREATED (server-mints a stable id); an id that already
 *   exists is UPDATED (merged).
 *
 * DELETE body: { goalId }
 *
 * A ScorecardOkr: { id?, name, metric, target, current?, description?, parentId?,
 *   rollupMethod?, statusRules?, otherwiseStatus?, status?, owner?, dueDate?,
 *   subGoalIds? }. Connected-metric bindings + live values live on the sibling
 *   scorecard-goals Cosmos records (POST /api/items/scorecard/[id]) — this route
 *   owns the goal DEFINITION only.
 *
 * 200 → { ok:true, goals }   (the persisted okr list)
 * 400 → invalid goal        404 → scorecard not found / not owned
 *
 * Azure-native (no-fabric-dependency), real Cosmos write via updateOwnedItem
 * (no-vaporware).
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import type { ScorecardContent, ScorecardOkr } from '@/lib/apps/content-bundles/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'scorecard';
const MAX_GOALS = 500;

function readOkrs(state: Record<string, unknown> | undefined): ScorecardOkr[] {
  const content = state?.content as Partial<ScorecardContent> | undefined;
  return content && content.kind === 'scorecard' && Array.isArray(content.okrs)
    ? (content.okrs as ScorecardOkr[])
    : [];
}

type NormResult = { ok: true; goal: ScorecardOkr } | { ok: false; error: string };

/** Validate + normalize one goal — rebuilt field-by-field (no garbage passthrough). */
function normalizeGoal(raw: unknown, existing?: ScorecardOkr): NormResult {
  const g = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : null;
  if (!g) return { ok: false, error: 'goal must be an object.' };

  const name = String(g.name ?? existing?.name ?? '').trim();
  if (!name) return { ok: false, error: 'goal.name is required.' };
  if (name.length > 200) return { ok: false, error: 'goal.name too long (>200).' };

  const metric = String(g.metric ?? existing?.metric ?? '').trim();
  if (!metric) return { ok: false, error: 'goal.metric is required (the unit/measure name).' };

  const rawTarget = g.target ?? existing?.target;
  if (rawTarget === undefined || rawTarget === null || String(rawTarget).trim() === '') {
    return { ok: false, error: 'goal.target is required.' };
  }
  const target: number | string = typeof rawTarget === 'number' ? rawTarget : String(rawTarget);

  const id = String(g.id ?? existing?.id ?? '').trim() || `goal-${crypto.randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) return { ok: false, error: `invalid goal id "${id}".` };

  const out: ScorecardOkr = { id, name, metric, target };

  const rawCurrent = g.current ?? existing?.current;
  if (rawCurrent !== undefined && rawCurrent !== null && String(rawCurrent).trim() !== '') {
    out.current = typeof rawCurrent === 'number' ? rawCurrent : String(rawCurrent);
  }
  const str = (v: unknown, max = 256): string | undefined => {
    const s = v === undefined ? undefined : String(v).trim();
    return s ? s.slice(0, max) : undefined;
  };
  const description = str(g.description ?? existing?.description, 1024); if (description) out.description = description;
  const parentId = str(g.parentId ?? existing?.parentId); if (parentId) out.parentId = parentId;
  const rollupMethod = (g.rollupMethod ?? existing?.rollupMethod); if (rollupMethod !== undefined) out.rollupMethod = rollupMethod as ScorecardOkr['rollupMethod'];
  const otherwiseStatus = (g.otherwiseStatus ?? existing?.otherwiseStatus); if (otherwiseStatus !== undefined) out.otherwiseStatus = otherwiseStatus as ScorecardOkr['otherwiseStatus'];
  const status = str(g.status ?? existing?.status); if (status) out.status = status;
  const owner = str(g.owner ?? existing?.owner); if (owner) out.owner = owner;
  const dueDate = str(g.dueDate ?? existing?.dueDate); if (dueDate) out.dueDate = dueDate;
  if (Array.isArray(g.statusRules)) out.statusRules = g.statusRules as ScorecardOkr['statusRules'];
  else if (existing?.statusRules) out.statusRules = existing.statusRules;
  const subGoalIds = Array.isArray(g.subGoalIds) ? g.subGoalIds.map((s) => String(s)).slice(0, 100)
    : existing?.subGoalIds;
  if (subGoalIds && subGoalIds.length) out.subGoalIds = subGoalIds;

  return { ok: true, goal: out };
}

async function persist(id: string, oid: string, okrs: ScorecardOkr[]) {
  const item = await loadOwnedItem(id, ITEM_TYPE, oid);
  if (!item) return null;
  const prevState = (item.state || {}) as Record<string, unknown>;
  const prevContent = (prevState.content as Partial<ScorecardContent> | undefined) || {};
  const content: ScorecardContent = { ...(prevContent as ScorecardContent), kind: 'scorecard', okrs };
  const nextState = { ...prevState, content };
  return updateOwnedItem(id, ITEM_TYPE, oid, { state: nextState });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const { id } = await ctx.params;
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiNotFound('scorecard not found or not owned by you');
    return apiOk({ goals: readOkrs(item.state as Record<string, unknown>) });
  } catch (e) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const incoming = Array.isArray(body.goals) ? body.goals
      : body.goal !== undefined ? [body.goal]
      : null;
    if (!incoming || incoming.length === 0) return apiError('provide a goal (or goals[]) to upsert.', 400);

    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiNotFound('scorecard not found or not owned by you');

    const okrs = readOkrs(item.state as Record<string, unknown>);
    const byId = new Map(okrs.map((o) => [o.id, o]));
    for (const raw of incoming) {
      const existingId = (raw && typeof raw === 'object') ? String((raw as any).id ?? '').trim() : '';
      const norm = normalizeGoal(raw, existingId ? byId.get(existingId) : undefined);
      if (!norm.ok) return apiError(norm.error, 400);
      byId.set(norm.goal.id, norm.goal);
    }
    if (byId.size > MAX_GOALS) return apiError(`too many goals (>${MAX_GOALS}).`, 400);

    const saved = await persist(id, session.claims.oid, Array.from(byId.values()));
    if (!saved) return apiNotFound('scorecard not found or not owned by you');
    return apiOk({ goals: readOkrs(saved.state as Record<string, unknown>) });
  } catch (e) {
    return apiServerError(e);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const goalId = String(body.goalId ?? '').trim();
    if (!goalId) return apiError('goalId is required.', 400);

    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiNotFound('scorecard not found or not owned by you');

    const okrs = readOkrs(item.state as Record<string, unknown>);
    const next = okrs.filter((o) => o.id !== goalId && o.parentId !== goalId);
    if (next.length === okrs.length) return apiError(`goal "${goalId}" not found on this scorecard.`, 404);

    const saved = await persist(id, session.claims.oid, next);
    if (!saved) return apiNotFound('scorecard not found or not owned by you');
    return apiOk({ goals: readOkrs(saved.state as Record<string, unknown>), removed: goalId });
  } catch (e) {
    return apiServerError(e);
  }
}
