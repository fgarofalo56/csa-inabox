/**
 * _plan-model — pure, side-effect-free helpers for the Loom **Plan (preview)**
 * editor (audit-T64). Extracted from phase4-editors.tsx so the planning-sheet
 * math (cell addressing, row/period totals, scenario branching, plan-vs-actual
 * variance) is unit-testable without React or Azure.
 *
 * Loom's Plan is the Azure-native parity of Microsoft Fabric's **Plan (preview)**
 * EPM/CPM item (Fabric IQ): budgets, forecasts, scenario modeling, variance.
 * Fabric auto-provisions a Fabric SQL database for plan metadata + writeback;
 * the Loom default persists planning cells to Cosmos and (opt-in) writes back to
 * an Azure SQL database — NO Microsoft Fabric dependency
 * (.claude/rules/no-fabric-dependency.md). Variance is computed against actuals
 * read from a bound semantic model (XMLA/DAX, opt-in) or entered manually.
 *
 * Fabric Plan refs (Microsoft Learn):
 *   What is plan (preview)?            /fabric/iq/plan/overview
 *   Create a planning sheet            /fabric/iq/plan/planning-how-to-get-started
 *   Persist planning data (writeback)  /fabric/iq/plan/planning-writeback/planning-how-to-persist-data
 */

export type PlanScenarioKind = 'baseline' | 'optimistic' | 'pessimistic' | 'custom';

export interface PlanScenario {
  id: string;
  name: string;
  kind: PlanScenarioKind;
}

export type PlanLineItemKind = 'input' | 'subtotal';

export interface PlanLineItem {
  id: string;
  name: string;
  /** Optional grouping label (e.g. "Revenue", "OpEx"). */
  category?: string;
  /** input = user-entered assumption cells; subtotal = computed sum of inputs. */
  kind: PlanLineItemKind;
  /** Optional unit hint shown in the grid header (e.g. "USD", "%", "FTE"). */
  unit?: string;
}

export interface PlanPeriod {
  id: string;
  label: string;
}

export interface PlanningSheet {
  id: string;
  name: string;
  kind: 'planning';
  lineItems: PlanLineItem[];
  periods: PlanPeriod[];
  /** Flat cell store keyed by cellKey(lineItemId, periodId, scenarioId). */
  cells: Record<string, number>;
  /**
   * Manually-entered actuals keyed by cellKey(lineItemId, periodId, '__actual__').
   * When a semantic model is bound + XMLA configured, the variance route can
   * overlay live actuals; otherwise these support an offline variance overlay.
   */
  actuals?: Record<string, number>;
}

export interface PlanSemanticModelRef {
  itemId: string;
  displayName: string;
}

export interface PlanBackingDb {
  kind: 'azure-sql' | 'synapse-serverless';
  serverId?: string;
  serverName?: string;
  dbName?: string;
  provisionedAt?: string;
}

/** Sentinel scenario id used to store manually-entered actuals in the cell map. */
export const ACTUAL_SCENARIO = '__actual__';

/** Address a single planning cell. */
export function cellKey(lineItemId: string, periodId: string, scenarioId: string): string {
  return `${lineItemId}|${periodId}|${scenarioId}`;
}

/** Read a cell value (0 when unset). */
export function getCell(
  cells: Record<string, number> | undefined,
  lineItemId: string,
  periodId: string,
  scenarioId: string,
): number {
  const v = cells?.[cellKey(lineItemId, periodId, scenarioId)];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Sum of a line item's cells across every period for a scenario. */
export function rowTotal(sheet: PlanningSheet, scenarioId: string, lineItemId: string): number {
  return sheet.periods.reduce((acc, p) => acc + getCell(sheet.cells, lineItemId, p.id, scenarioId), 0);
}

/** Sum of all *input* line items for one period (a subtotal column). */
export function periodTotal(sheet: PlanningSheet, scenarioId: string, periodId: string): number {
  return sheet.lineItems
    .filter((li) => li.kind === 'input')
    .reduce((acc, li) => acc + getCell(sheet.cells, li.id, periodId, scenarioId), 0);
}

/** Grand total (all input line items, all periods) for a scenario. */
export function grandTotal(sheet: PlanningSheet, scenarioId: string): number {
  return sheet.periods.reduce((acc, p) => acc + periodTotal(sheet, scenarioId, p.id), 0);
}

/**
 * Branch a scenario: copy every cell belonging to `fromScenarioId` onto a new
 * `toScenarioId`, leaving the source untouched. Returns a NEW cell map.
 */
export function cloneScenarioCells(
  cells: Record<string, number>,
  fromScenarioId: string,
  toScenarioId: string,
): Record<string, number> {
  const next: Record<string, number> = { ...cells };
  for (const [k, v] of Object.entries(cells)) {
    const parts = k.split('|');
    if (parts.length === 3 && parts[2] === fromScenarioId) {
      next[cellKey(parts[0], parts[1], toScenarioId)] = v;
    }
  }
  return next;
}

/** Drop every cell belonging to a scenario (used when deleting a scenario). */
export function dropScenarioCells(
  cells: Record<string, number>,
  scenarioId: string,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(cells)) {
    if (k.split('|')[2] !== scenarioId) next[k] = v;
  }
  return next;
}

export interface VarianceRow {
  lineItemId: string;
  name: string;
  plan: number;
  actual: number;
  /** actual − plan. */
  delta: number;
  /** delta / plan as a fraction (null when plan is 0). */
  pct: number | null;
}

/** Plan-vs-actual variance per line item for a scenario, given an actuals map. */
export function computeVariance(
  sheet: PlanningSheet,
  scenarioId: string,
  actualByLineItem: Record<string, number>,
): VarianceRow[] {
  return sheet.lineItems
    .filter((li) => li.kind === 'input')
    .map((li) => {
      const plan = rowTotal(sheet, scenarioId, li.id);
      const actual = Number.isFinite(actualByLineItem[li.id]) ? actualByLineItem[li.id] : 0;
      const delta = actual - plan;
      return {
        lineItemId: li.id,
        name: li.name,
        plan,
        actual,
        delta,
        pct: plan !== 0 ? delta / plan : null,
      };
    });
}

let _seq = 0;
/** Short collision-resistant id (deterministic-ish; fine for client rows). */
export function newId(prefix: string): string {
  _seq = (_seq + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${_seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Default baseline + optimistic + pessimistic scenarios for a fresh plan. */
export function defaultScenarios(): PlanScenario[] {
  return [
    { id: 'baseline', name: 'Baseline', kind: 'baseline' },
    { id: 'optimistic', name: 'Optimistic', kind: 'optimistic' },
    { id: 'pessimistic', name: 'Pessimistic', kind: 'pessimistic' },
  ];
}

// ===================================================================
// PowerTable / Intelligence / InfoBridge helpers (audit-T64 finish).
//
// Pure, side-effect-free math/shaping for the three remaining Fabric Plan
// sheet kinds, extracted here so the grid flattening, trend/forecast math,
// Gantt layout, and source-mapping reconciliation are vitest-covered without
// React or Azure (parity with the Planning-sheet helpers above).
// ===================================================================

/** A flat PowerTable row — one editable cell across the whole plan. */
export interface PlanCellRow {
  /** Stable composite key = cellKey(lineItemId, periodId, scenarioId). */
  key: string;
  sheetId: string;
  sheetName: string;
  lineItemId: string;
  lineItem: string;
  periodId: string;
  period: string;
  scenarioId: string;
  scenario: string;
  value: number;
}

/**
 * Flatten every (sheet × input line item × period × scenario) cell into a
 * single tabular row set — the no-code, SQL-shaped grid PowerTable binds to.
 * Mirrors the `dbo.loom_plan_cells` columns so the SQL writeback round-trips
 * 1:1. Only input line items are emitted (subtotals are computed, not stored).
 */
export function flattenPlanCells(sheets: PlanningSheet[], scenarios: PlanScenario[]): PlanCellRow[] {
  const scById = new Map(scenarios.map((s) => [s.id, s]));
  const rows: PlanCellRow[] = [];
  for (const sheet of sheets) {
    const inputs = sheet.lineItems.filter((li) => li.kind === 'input');
    for (const li of inputs) {
      for (const p of sheet.periods) {
        for (const sc of scenarios) {
          const value = getCell(sheet.cells, li.id, p.id, sc.id);
          rows.push({
            key: cellKey(li.id, p.id, sc.id),
            sheetId: sheet.id,
            sheetName: sheet.name,
            lineItemId: li.id,
            lineItem: li.name,
            periodId: p.id,
            period: p.label,
            scenarioId: sc.id,
            scenario: scById.get(sc.id)?.name || sc.id,
            value,
          });
        }
      }
    }
  }
  return rows;
}

/** Filter PowerTable rows by a free-text query across the labelled columns. */
export function filterPlanRows(rows: PlanCellRow[], query: string): PlanCellRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    `${r.sheetName} ${r.lineItem} ${r.period} ${r.scenario} ${r.value}`.toLowerCase().includes(q));
}

export type PlanRowSortKey = 'sheetName' | 'lineItem' | 'period' | 'scenario' | 'value';

/** Stable sort PowerTable rows by a column (string or numeric), asc/desc. */
export function sortPlanRows(rows: PlanCellRow[], key: PlanRowSortKey, dir: 'asc' | 'desc'): PlanCellRow[] {
  const mult = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mult;
    return String(av).localeCompare(String(bv)) * mult;
  });
}

export interface PeriodPoint {
  periodId: string;
  label: string;
  /** Period subtotal (all input line items) for the scenario. */
  value: number;
  /** True once the point is a model forecast rather than an entered period. */
  forecast?: boolean;
}

/** The Intelligence trend series: one point per period (period subtotal). */
export function periodSeries(sheet: PlanningSheet, scenarioId: string): PeriodPoint[] {
  return sheet.periods.map((p) => ({ periodId: p.id, label: p.label, value: periodTotal(sheet, scenarioId, p.id) }));
}

export interface LinearFit {
  slope: number;
  intercept: number;
  /** Coefficient of determination R² (1 = perfect fit, 0 = no trend). */
  r2: number;
}

/**
 * Ordinary-least-squares fit of y against x = 0..n-1. Returns slope/intercept
 * and R². Degenerate inputs (n < 2) yield a flat line at the mean.
 */
export function linearFit(values: number[]): LinearFit {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? values[0] : 0, r2: 0 };
  const xs = values.map((_, i) => i);
  const xbar = xs.reduce((a, b) => a + b, 0) / n;
  const ybar = values.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xbar;
    const dy = values[i] - ybar;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = ybar - slope * xbar;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

/**
 * Forecast `horizon` future periods by extrapolating the OLS trend of the
 * period subtotals. Returns the historical series followed by the forecast
 * points (flagged `forecast:true`). Real least-squares math — no mock values.
 */
export function forecastPeriods(sheet: PlanningSheet, scenarioId: string, horizon: number): PeriodPoint[] {
  const hist = periodSeries(sheet, scenarioId);
  const h = Math.max(0, Math.floor(horizon));
  if (h === 0 || hist.length === 0) return hist;
  const fit = linearFit(hist.map((p) => p.value));
  const out: PeriodPoint[] = [...hist];
  for (let i = 0; i < h; i++) {
    const x = hist.length + i;
    out.push({
      periodId: `__fcst_${i}`,
      label: `F${i + 1}`,
      value: Math.round((fit.slope * x + fit.intercept) * 100) / 100,
      forecast: true,
    });
  }
  return out;
}

export interface GanttBar {
  title: string;
  status: PlanTask['status'];
  owner: string;
  /** Left offset as a fraction [0,1] of the project window. */
  startPct: number;
  /** Width as a fraction [0,1] of the project window. */
  widthPct: number;
  /** Whether the task has a (resolved) dependency. */
  hasDep: boolean;
  /** ISO due date (or null when unset). */
  due: string | null;
  /** True when the task is past due and not done. */
  overdue: boolean;
}

interface GanttTask { title: string; owner: string; due: string; status: PlanTask['status']; dependsOn?: string }

/**
 * Lay out plan tasks as a Gantt: each bar runs from its computed start (the
 * project start, or its dependency's due date) to its own due date, expressed
 * as fractions of the [projectStart, projectEnd] window. Tasks without a due
 * date span the full window. Deterministic — vitest-covered.
 */
export function ganttLayout(tasks: GanttTask[], todayIso?: string): GanttBar[] {
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const dued = tasks.filter((t) => t.due).map((t) => t.due);
  const dueByTitle = new Map(tasks.filter((t) => t.due).map((t) => [t.title, t.due]));
  const min = dued.length ? dued.reduce((a, b) => (a < b ? a : b)) : today;
  const max = dued.length ? dued.reduce((a, b) => (a > b ? a : b)) : today;
  const startMs = new Date(min).getTime();
  const endMs = new Date(max).getTime();
  const span = Math.max(1, endMs - startMs);
  const pct = (iso: string) => Math.min(1, Math.max(0, (new Date(iso).getTime() - startMs) / span));
  return tasks.map((t) => {
    const dep = t.dependsOn && dueByTitle.get(t.dependsOn);
    const startIso = dep || min;
    const endIso = t.due || max;
    const sp = pct(startIso);
    const ep = t.due ? pct(endIso) : 1;
    const startPct = Math.min(sp, ep);
    const widthPct = Math.max(0.02, Math.abs(ep - sp));
    return {
      title: t.title || '(untitled)',
      status: t.status,
      owner: t.owner,
      startPct,
      widthPct,
      hasDep: !!dep,
      due: t.due || null,
      overdue: t.status !== 'done' && !!t.due && t.due < today,
    };
  });
}

/** Computed (non-AI) narrative insights over a scenario's plan + variance. */
export function planInsights(sheet: PlanningSheet, scenarioId: string, variance: VarianceRow[]): string[] {
  const out: string[] = [];
  const series = periodSeries(sheet, scenarioId);
  const total = grandTotal(sheet, scenarioId);
  out.push(`Scenario total across ${series.length} period${series.length === 1 ? '' : 's'}: ${Math.round(total).toLocaleString()}.`);
  if (series.length >= 2) {
    const fit = linearFit(series.map((p) => p.value));
    const dir = fit.slope > 0 ? 'increasing' : fit.slope < 0 ? 'decreasing' : 'flat';
    out.push(`Period subtotals are ${dir} (slope ${Math.round(fit.slope).toLocaleString()}/period, R²=${fit.r2.toFixed(2)}).`);
    const peak = series.reduce((a, b) => (b.value > a.value ? b : a), series[0]);
    out.push(`Largest period is ${peak.label} at ${Math.round(peak.value).toLocaleString()}.`);
  }
  const withActuals = variance.filter((v) => v.actual !== 0);
  if (withActuals.length) {
    const worst = withActuals.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a), withActuals[0]);
    const sign = worst.delta < 0 ? 'under' : 'over';
    out.push(`Biggest variance: ${worst.name} is ${sign} plan by ${Math.abs(Math.round(worst.delta)).toLocaleString()}${worst.pct == null ? '' : ` (${Math.round(worst.pct * 100)}%)`}.`);
  } else {
    out.push('No actuals captured yet — map sources in InfoBridge or enter actuals on the Planning sheet to unlock variance insights.');
  }
  return out;
}

/** InfoBridge — a mapping from a plan line item to an external source field. */
export interface PlanSourceMapping {
  lineItemId: string;
  /** Where actuals for this line item come from. */
  sourceKind: 'semantic-model' | 'warehouse' | 'lakehouse' | 'manual';
  /** Real Loom item id of the source (omit for manual). */
  sourceItemId?: string;
  /** Display name of the source item (for the row label). */
  sourceName?: string;
  /** Measure / column / field name in the source. */
  field?: string;
  /** Current actual value carried by this mapping (feeds the variance overlay). */
  currentActual?: number;
}

/**
 * Reconcile InfoBridge mappings into a sheet's `actuals` map: every mapping
 * with a finite `currentActual` writes that value onto its line item. Returns
 * a NEW actuals map (mappings win over existing entries). This is what closes
 * the loop — mapped source values flow into the Planning variance overlay.
 */
export function applyMappingsToActuals(
  actuals: Record<string, number> | undefined,
  mappings: PlanSourceMapping[],
): Record<string, number> {
  const next: Record<string, number> = { ...(actuals || {}) };
  for (const m of mappings) {
    if (typeof m.currentActual === 'number' && Number.isFinite(m.currentActual)) {
      next[m.lineItemId] = m.currentActual;
    }
  }
  return next;
}

/** A starter planning sheet — 4 quarters × a couple of revenue/cost lines. */
export function defaultPlanningSheet(): PlanningSheet {
  const periods: PlanPeriod[] = [
    { id: 'q1', label: 'Q1' },
    { id: 'q2', label: 'Q2' },
    { id: 'q3', label: 'Q3' },
    { id: 'q4', label: 'Q4' },
  ];
  const lineItems: PlanLineItem[] = [
    { id: 'revenue', name: 'Revenue', category: 'Revenue', kind: 'input', unit: 'USD' },
    { id: 'cogs', name: 'Cost of goods', category: 'OpEx', kind: 'input', unit: 'USD' },
    { id: 'opex', name: 'Operating expense', category: 'OpEx', kind: 'input', unit: 'USD' },
  ];
  return { id: 'sheet1', name: 'Annual budget', kind: 'planning', periods, lineItems, cells: {}, actuals: {} };
}
