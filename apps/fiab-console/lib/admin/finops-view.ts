/**
 * finops-view — C4 (loom-next-level): PURE view-model assembly for the
 * /admin/finops hub. Zero server-only / Azure-SDK imports so it is unit-tested
 * and safe to import from the client page + the routes.
 *
 * Turns the real backend shapes (cost summary, forecast, anomalies, budgets)
 * into the KPI tiles + feed rows + budget-burn states the hub renders — no
 * hard-coded numbers (no-vaporware): every field is derived from the inputs.
 */
import type { CostAnomaly } from '@/lib/azure/cost-anomaly-core';
import type { CostBudget } from '@/lib/azure/cost-client';

export type TileIntent = 'neutral' | 'success' | 'warning' | 'error';

export interface FinopsTile {
  key: string;
  label: string;
  /** Formatted value (currency / count / percent) — display-ready. */
  value: string;
  /** Optional caption under the value. */
  caption?: string;
  intent: TileIntent;
}

export interface FinopsSummaryInput {
  currency: string;
  monthToDate: number;
  forecast: number;
  forecastMethod: 'api' | 'linear' | 'seasonal';
  trendPct: number | null;
  anomalies: CostAnomaly[];
  budgets: CostBudget[];
}

function fmtMoney(currency: string, n: number): string {
  const v = Math.round(n * 100) / 100;
  return `${currency ? `${currency} ` : ''}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Burn state for one budget: over (≥100%), warning (≥80%), else ok. */
export function budgetBurnState(budget: Pick<CostBudget, 'percentUsed'>): TileIntent {
  const p = Number(budget.percentUsed) || 0;
  if (p >= 100) return 'error';
  if (p >= 80) return 'warning';
  return 'success';
}

/** The worst (most-consumed) budget, or null when there are none. */
export function worstBudget(budgets: CostBudget[]): CostBudget | null {
  if (!budgets.length) return null;
  return [...budgets].sort((a, b) => (b.percentUsed || 0) - (a.percentUsed || 0))[0];
}

/** The KPI tiles across the top of the hub. */
export function assembleFinopsTiles(input: FinopsSummaryInput): FinopsTile[] {
  const { currency, monthToDate, forecast, forecastMethod, trendPct, anomalies, budgets } = input;
  const highAnoms = anomalies.filter((a) => a.severity === 'high').length;
  const worst = worstBudget(budgets);

  const tiles: FinopsTile[] = [
    {
      key: 'mtd',
      label: 'Spend (period to date)',
      value: fmtMoney(currency, monthToDate),
      caption: trendPct == null ? undefined : `${trendPct > 0 ? '+' : ''}${trendPct}% vs previous period`,
      intent: trendPct != null && trendPct > 25 ? 'warning' : 'neutral',
    },
    {
      key: 'forecast',
      label: 'Forecast (period end)',
      value: fmtMoney(currency, forecast),
      caption: `method: ${forecastMethod}`,
      intent: 'neutral',
    },
    {
      key: 'anomalies',
      label: 'Anomalies',
      value: String(anomalies.length),
      caption: highAnoms ? `${highAnoms} high-severity` : 'none high-severity',
      intent: highAnoms ? 'error' : anomalies.length ? 'warning' : 'success',
    },
    {
      key: 'budgets',
      label: 'Budgets',
      value: String(budgets.length),
      caption: worst ? `worst: ${worst.name} at ${worst.percentUsed}%` : 'none configured',
      intent: worst ? budgetBurnState(worst) : 'neutral',
    },
  ];
  return tiles;
}

export interface AnomalyFeedRow {
  date: string;
  cost: number;
  expected: number;
  deviationPct: number;
  severity: 'high' | 'medium';
  scope: string;
}

/** Flatten per-scope anomalies into a single most-severe-first feed. */
export function anomalyFeed(byScope: Record<string, CostAnomaly[]>): AnomalyFeedRow[] {
  const rows: AnomalyFeedRow[] = [];
  for (const [scope, anomalies] of Object.entries(byScope)) {
    for (const a of anomalies) rows.push({ ...a, scope });
  }
  return rows.sort((a, b) =>
    a.severity === b.severity ? (b.date > a.date ? 1 : b.date < a.date ? -1 : b.cost - a.cost) : a.severity === 'high' ? -1 : 1,
  );
}
