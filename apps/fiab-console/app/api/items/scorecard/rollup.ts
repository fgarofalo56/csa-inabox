/**
 * Scorecard rollup + status-rule engine — pure TypeScript, no Cosmos / no HTTP.
 *
 * Azure-native default: this engine runs entirely in the Loom BFF. It is the
 * canonical implementation of Fabric/Power-BI Metrics "subgoal rollup" + per-
 * goal "status rules" — neither of which the preview Fabric Metrics REST
 * exposes programmatically. No Fabric workspace is required; the engine is
 * driven from `state.content` (loom: items) or from live Fabric goals enriched
 * with a Cosmos-stored config overlay.
 *
 * Rollup methods (grounded in learn.microsoft.com/power-bi/create-reports/
 * service-goals-subgoals): SUM / AVERAGE / MIN / MAX. MIN = "worst child" —
 * the parent reflects the lowest child value, the standard compliance-scorecard
 * semantic.
 *
 * Status rules (learn.microsoft.com/.../service-goals-status-rules): ordered
 * conditions `(value | % of target) (>= | <= | > | < | =) threshold → status`.
 * First match wins; an "Otherwise" fallback applies when no rule fires.
 */

import type { ScorecardOkr, StatusColor, StatusRule, RollupMethod } from '@/lib/apps/content-bundles/types';

export interface ComputedGoal {
  id: string;
  name: string;
  description?: string;
  metric: string;
  /** Raw leaf value as authored / checked-in. */
  currentValue?: number;
  /** Set when a rollupMethod aggregated this goal's children. Takes precedence
   * over currentValue for status evaluation + display. */
  computedValue?: number;
  targetValue?: number;
  /** Resolved status color from the rule engine. */
  status: StatusColor;
  parentId?: string;
  rollupMethod?: RollupMethod;
  statusRules?: StatusRule[];
  otherwiseStatus?: StatusColor;
}

function toNum(v: number | string | undefined): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function aggregate(method: RollupMethod, values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  switch (method) {
    case 'sum': return values.reduce((a, b) => a + b, 0);
    case 'avg': return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min': return Math.min(...values); // worst-child
    case 'max': return Math.max(...values);
    default: return undefined;
  }
}

/**
 * Evaluate ordered status rules against an effective value. First match wins.
 * `metricKind: 'percent-of-target'` compares (value / target) * 100 to the
 * threshold; `'value'` compares the raw value. Returns the otherwiseStatus
 * (or 'not-started') when no rule matches or the value is unknown.
 */
export function applyStatusRules(
  effectiveValue: number | undefined,
  targetValue: number | undefined,
  rules: StatusRule[] | undefined,
  otherwiseStatus: StatusColor | undefined,
): StatusColor {
  const fallback: StatusColor = otherwiseStatus ?? 'not-started';
  if (effectiveValue === undefined || !rules || rules.length === 0) return fallback;
  for (const rule of rules) {
    let metric: number;
    if (rule.metricKind === 'percent-of-target') {
      if (!targetValue || targetValue === 0) continue; // can't compute % w/o target
      metric = (effectiveValue / targetValue) * 100;
    } else {
      metric = effectiveValue;
    }
    let hit = false;
    switch (rule.operator) {
      case '>=': hit = metric >= rule.threshold; break;
      case '<=': hit = metric <= rule.threshold; break;
      case '>': hit = metric > rule.threshold; break;
      case '<': hit = metric < rule.threshold; break;
      case '=': hit = metric === rule.threshold; break;
    }
    if (hit) return rule.status;
  }
  return fallback;
}

/**
 * Compute rollups + status for a flat list of OKRs/goals. Parent goals (those
 * carrying a `rollupMethod` and having children via `parentId`) get a
 * `computedValue` aggregated from their children's effective values; that
 * computed value (in preference to the raw `current`) drives status. Leaf
 * goals use their own `current`.
 */
export function computeRollups(okrs: ScorecardOkr[]): ComputedGoal[] {
  const childrenOf = new Map<string, ScorecardOkr[]>();
  for (const o of okrs) {
    if (o.parentId) {
      const list = childrenOf.get(o.parentId) || [];
      list.push(o);
      childrenOf.set(o.parentId, list);
    }
  }

  return okrs.map((o) => {
    const currentValue = toNum(o.current);
    const targetValue = toNum(o.target);
    let computedValue: number | undefined;

    if (o.rollupMethod) {
      const kids = childrenOf.get(o.id) || [];
      const childValues = kids
        .map((k) => toNum(k.current))
        .filter((v): v is number => v !== undefined);
      computedValue = aggregate(o.rollupMethod, childValues);
    }

    const effectiveValue = computedValue !== undefined ? computedValue : currentValue;
    const status = applyStatusRules(effectiveValue, targetValue, o.statusRules, o.otherwiseStatus);

    return {
      id: o.id,
      name: o.name,
      description: o.description || o.metric,
      metric: o.metric,
      currentValue,
      computedValue,
      targetValue,
      status,
      parentId: o.parentId,
      rollupMethod: o.rollupMethod,
      statusRules: o.statusRules,
      otherwiseStatus: o.otherwiseStatus,
    };
  });
}
