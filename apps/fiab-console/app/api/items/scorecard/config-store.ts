/**
 * Scorecard rollup + status-rule config store (Cosmos `scorecard-config`).
 *
 * One row per scorecard (id = scorecardId, PK /scorecardId). Holds the per-goal
 * rollup + status-rule overlay that Fabric/Power-BI keeps authoring-only. The
 * BFF applies this overlay to live Fabric goals before running the rollup
 * engine. Azure-native default — no Fabric workspace is required for the engine
 * or the store; this is real Cosmos persistence via the Console UAMI.
 */

import { scorecardConfigContainer } from '@/lib/azure/cosmos-client';
import type { RollupMethod, StatusColor, StatusRule } from '@/lib/apps/content-bundles/types';
import type { ScorecardOkr } from '@/lib/apps/content-bundles/types';

/** Per-goal config overlay saved from the editor. */
export interface GoalConfig {
  goalId: string;
  /** Parent goal id — defines the rollup hierarchy when the live API doesn't. */
  parentId?: string;
  rollupMethod?: RollupMethod;
  statusRules?: StatusRule[];
  otherwiseStatus?: StatusColor;
}

interface ScorecardConfigDoc {
  id: string;          // scorecardId
  scorecardId: string; // partition key
  tenantId: string;
  goals: GoalConfig[];
  updatedAt: string;
  updatedBy?: string;
}

/** Validation allowlists — reject anything not in the typed unions (no-freeform-config). */
export const VALID_ROLLUP_METHODS = new Set<RollupMethod>(['sum', 'avg', 'min', 'max']);
export const VALID_STATUS_COLORS = new Set<StatusColor>(['on-track', 'at-risk', 'behind', 'completed', 'not-started']);
export const VALID_OPERATORS = new Set<StatusRule['operator']>(['>=', '<=', '>', '<', '=']);
export const VALID_METRIC_KINDS = new Set<StatusRule['metricKind']>(['value', 'percent-of-target']);

/**
 * Validate + normalize a goals[] payload from the editor. Returns the cleaned
 * GoalConfig[] or throws an Error (message used for the 400 response body).
 */
export function validateGoalConfigs(raw: unknown): GoalConfig[] {
  if (!Array.isArray(raw)) throw new Error('goals must be an array');
  const out: GoalConfig[] = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object') throw new Error('each goal must be an object');
    const goalId = String((g as any).goalId || '');
    if (!goalId) throw new Error('goalId is required on each goal');
    const gc: GoalConfig = { goalId };
    const pid = (g as any).parentId;
    if (pid !== undefined && pid !== null && pid !== '') gc.parentId = String(pid);
    const rm = (g as any).rollupMethod;
    if (rm !== undefined && rm !== null && rm !== '') {
      if (!VALID_ROLLUP_METHODS.has(rm)) throw new Error(`invalid rollupMethod: ${rm}`);
      gc.rollupMethod = rm;
    }
    const ow = (g as any).otherwiseStatus;
    if (ow !== undefined && ow !== null && ow !== '') {
      if (!VALID_STATUS_COLORS.has(ow)) throw new Error(`invalid otherwiseStatus: ${ow}`);
      gc.otherwiseStatus = ow;
    }
    const rules = (g as any).statusRules;
    if (rules !== undefined && rules !== null) {
      if (!Array.isArray(rules)) throw new Error('statusRules must be an array');
      const cleaned: StatusRule[] = [];
      for (const r of rules) {
        if (!r || typeof r !== 'object') throw new Error('each status rule must be an object');
        if (!VALID_OPERATORS.has((r as any).operator)) throw new Error(`invalid operator: ${(r as any).operator}`);
        if (!VALID_METRIC_KINDS.has((r as any).metricKind)) throw new Error(`invalid metricKind: ${(r as any).metricKind}`);
        if (!VALID_STATUS_COLORS.has((r as any).status)) throw new Error(`invalid status: ${(r as any).status}`);
        const threshold = Number((r as any).threshold);
        if (!Number.isFinite(threshold)) throw new Error('threshold must be a finite number');
        cleaned.push({
          operator: (r as any).operator,
          metricKind: (r as any).metricKind,
          status: (r as any).status,
          threshold,
        });
      }
      gc.statusRules = cleaned;
    }
    out.push(gc);
  }
  return out;
}

/** Read a scorecard's config row; returns null on miss / error (never throws). */
export async function loadScorecardConfig(
  scorecardId: string,
  tenantId: string,
): Promise<GoalConfig[]> {
  try {
    const c = await scorecardConfigContainer();
    const { resource } = await c.item(scorecardId, scorecardId).read<ScorecardConfigDoc>();
    if (!resource || resource.tenantId !== tenantId) return [];
    return resource.goals || [];
  } catch {
    return [];
  }
}

/** Upsert a scorecard's config row. */
export async function saveScorecardConfig(
  scorecardId: string,
  tenantId: string,
  goals: GoalConfig[],
  updatedBy?: string,
): Promise<void> {
  const c = await scorecardConfigContainer();
  const doc: ScorecardConfigDoc = {
    id: scorecardId,
    scorecardId,
    tenantId,
    goals,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  await c.items.upsert(doc);
}

/**
 * Overlay a GoalConfig[] onto live Fabric goals, producing ScorecardOkr[] the
 * rollup engine can consume. Live goal field names vary across the preview
 * Fabric Metrics API, so we read the common aliases defensively.
 */
export function mergeConfigOntoLiveGoals(goals: any[], cfg: GoalConfig[]): ScorecardOkr[] {
  const byId = new Map<string, GoalConfig>();
  for (const g of cfg) byId.set(g.goalId, g);
  return (goals || []).map((g) => {
    const id = String(g.id ?? g.goalId ?? '');
    const c = byId.get(id);
    const current = g.currentValue ?? g.value ?? g.lastValue;
    const target = g.target ?? g.targetValue;
    return {
      id,
      name: String(g.name ?? id),
      description: g.description,
      metric: String(g.metric ?? g.name ?? ''),
      target: typeof target === 'number' ? target : Number(target) || 0,
      current: typeof current === 'number' ? current : (current != null ? Number(current) : undefined),
      parentId: c?.parentId ?? g.parentId,
      rollupMethod: c?.rollupMethod,
      statusRules: c?.statusRules,
      otherwiseStatus: c?.otherwiseStatus,
    } as ScorecardOkr;
  });
}
