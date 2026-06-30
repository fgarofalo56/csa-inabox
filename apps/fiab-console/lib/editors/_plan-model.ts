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

export type PlanLineItemKind = 'input' | 'subtotal' | 'formula';

export interface PlanLineItem {
  id: string;
  name: string;
  /** Optional grouping label (e.g. "Revenue", "OpEx"). */
  category?: string;
  /**
   * input   = user-entered assumption cells (leaf rows hold data);
   * subtotal = computed period subtotal of all leaf inputs;
   * formula  = computed per period from a guided {@link PlanFormulaToken} AST.
   * Any row that *has children* (another row points to it via `parentId`)
   * becomes a read-only roll-up regardless of kind — its value is the sum of
   * its descendants (member hierarchy / drill-down).
   */
  kind: PlanLineItemKind;
  /** Optional unit hint shown in the grid header (e.g. "USD", "%", "FTE"). */
  unit?: string;
  /**
   * Parent row id for hierarchy / roll-up (member nesting: Region → Country →
   * Store). Undefined/null = a top-level row. A row with children auto-aggregates
   * and is read-only in the grid (drill-down).
   */
  parentId?: string | null;
  /**
   * Guided formula token AST (kind === 'formula'). Built only via the Formula
   * builder dialog — never freeform text (`.claude/rules` loom_no_freeform_config).
   */
  formula?: PlanFormulaToken[];
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

/** Ids of rows that are *parents* (some other row points at them via parentId). */
export function parentRowIds(lineItems: PlanLineItem[]): Set<string> {
  const out = new Set<string>();
  for (const li of lineItems) if (li.parentId) out.add(li.parentId);
  return out;
}

/** Leaf input line items only — the rows that actually *hold* entered data. */
export function leafInputItems(lineItems: PlanLineItem[]): PlanLineItem[] {
  const parents = parentRowIds(lineItems);
  return lineItems.filter((li) => li.kind === 'input' && !parents.has(li.id));
}

/**
 * Sum of all *leaf input* line items for one period (a subtotal column). Roll-up
 * parent rows are excluded so a parent + its children are never double-counted.
 * Legacy flat plans (no parentId anywhere) keep the original "all inputs" total.
 */
export function periodTotal(sheet: PlanningSheet, scenarioId: string, periodId: string): number {
  return leafInputItems(sheet.lineItems)
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
    const inputs = leafInputItems(sheet.lineItems);
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
  status: ('todo' | 'doing' | 'done');
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

interface GanttTask { title: string; owner: string; due: string; status: ('todo' | 'doing' | 'done'); dependsOn?: string }

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

// ===================================================================
// EPM core — multidimensional Model (cube), member hierarchies, roll-ups,
// guided Formula AST + evaluator, and model validation.
//
// Azure-native parity of Microsoft Fabric IQ Plan's cube / hierarchies / user
// formulas (Anaplan-style connected planning). Pure + side-effect-free so the
// roll-up math, formula evaluation, and validation are vitest-covered without
// React or Azure. Persisted in Cosmos plan.state.model; NO Microsoft Fabric.
//   Fabric refs: /fabric/iq/plan/planning-overview#key-capabilities
// ===================================================================

/** Aggregation for a reusable measure over the cube. */
export type PlanAggKind = 'sum' | 'avg' | 'count' | 'min' | 'max';

/** A member of a dimension hierarchy (Region → Country → Store). */
export interface PlanMember {
  id: string;
  label: string;
  /** Parent member id; undefined/null = a top-level member. */
  parentId?: string | null;
}

export type PlanDimensionAxis = 'row' | 'column';

/** A dimension: a named hierarchy of members placed on the row or column axis. */
export interface PlanDimension {
  id: string;
  name: string;
  axis: PlanDimensionAxis;
  members: PlanMember[];
}

/** A reusable measure (SUM/AVG/COUNT/MIN/MAX) over the cube. */
export interface PlanMeasure {
  id: string;
  name: string;
  agg: PlanAggKind;
  /** Optional line-item id the measure aggregates (else the whole sheet). */
  scopeLineItemId?: string;
  unit?: string;
}

/** The cube definition for a plan: its dimensions + measures. */
export interface PlanModel {
  dimensions: PlanDimension[];
  measures: PlanMeasure[];
}

/** Empty cube. */
export function emptyPlanModel(): PlanModel {
  return { dimensions: [], measures: [] };
}

// ---- Member hierarchy helpers (pure) ----

/** Direct children of a member (or top-level members when parentId is null). */
export function memberChildren(members: PlanMember[], parentId: string | null): PlanMember[] {
  return members.filter((m) => (m.parentId || null) === (parentId || null));
}

/** Depth of a member (0 = top level). Cycle-safe (caps at members.length). */
export function memberDepth(members: PlanMember[], id: string): number {
  const byId = new Map(members.map((m) => [m.id, m]));
  let depth = 0;
  let cur = byId.get(id);
  const guard = members.length + 1;
  while (cur && cur.parentId && depth < guard) {
    cur = byId.get(cur.parentId);
    depth++;
  }
  return depth;
}

/**
 * Depth-first ordering of members (parents immediately before their children),
 * each tagged with depth + whether it has children. Top level first.
 */
export interface OrderedMember { member: PlanMember; depth: number; hasChildren: boolean }
export function orderMembers(members: PlanMember[]): OrderedMember[] {
  const out: OrderedMember[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const m of memberChildren(members, parentId)) {
      const kids = memberChildren(members, m.id);
      out.push({ member: m, depth, hasChildren: kids.length > 0 });
      if (kids.length) visit(m.id, depth + 1);
    }
  };
  visit(null, 0);
  // Any orphan members (parent missing) are surfaced at top level so they're
  // never silently dropped from the editor.
  const seen = new Set(out.map((o) => o.member.id));
  for (const m of members) {
    if (!seen.has(m.id)) out.push({ member: m, depth: 0, hasChildren: false });
  }
  return out;
}

// ---- Line-item hierarchy + roll-up (pure) ----

export interface OrderedLineItem { item: PlanLineItem; depth: number; hasChildren: boolean }

/**
 * Depth-first ordering of line items by `parentId` (parents before children),
 * each tagged with depth + hasChildren — the row order the grid renders with
 * indentation + expand/collapse carets.
 */
export function orderedLineItems(lineItems: PlanLineItem[]): OrderedLineItem[] {
  const childrenOf = (pid: string | null) =>
    lineItems.filter((li) => (li.parentId || null) === (pid || null));
  const out: OrderedLineItem[] = [];
  const visit = (pid: string | null, depth: number) => {
    for (const li of childrenOf(pid)) {
      const kids = childrenOf(li.id);
      out.push({ item: li, depth, hasChildren: kids.length > 0 });
      if (kids.length) visit(li.id, depth + 1);
    }
  };
  visit(null, 0);
  const seen = new Set(out.map((o) => o.item.id));
  for (const li of lineItems) if (!seen.has(li.id)) out.push({ item: li, depth: 0, hasChildren: false });
  return out;
}

// ---- Guided formula AST + evaluator (NO eval, NO freeform parsing) ----
//
// A formula is a structured token array assembled exclusively by the Formula
// builder dialog (function palette + row/measure picker + operator buttons +
// number field). The evaluator is a recursive-descent parser over the token
// array — there is no string lexer, so freeform text can never reach it
// (loom_no_freeform_config). Row tokens may carry a period `offset` (this
// period / previous / year-ago) so growth%/YoY are expressible without text.

export type PlanFormulaFn = 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'ABS';
export type PlanFormulaOp = '+' | '-' | '*' | '/';

export type PlanFormulaToken =
  | { k: 'row'; ref: string; offset?: number; label?: string }
  | { k: 'num'; value: number }
  | { k: 'op'; op: PlanFormulaOp }
  | { k: 'fn'; fn: PlanFormulaFn }
  | { k: 'lp' }
  | { k: 'rp' }
  | { k: 'comma' };

export interface FormulaEvalResult { ok: boolean; value: number; error?: string }

/** Set of distinct row refs a formula references (for cycle/ref validation). */
export function formulaRefs(tokens: PlanFormulaToken[]): string[] {
  const out = new Set<string>();
  for (const t of tokens) if (t.k === 'row') out.add(t.ref);
  return [...out];
}

/**
 * Evaluate a guided formula token AST. `resolve(ref, offset)` returns the value
 * of a referenced row at the requested period offset. Recursive descent:
 *   expr   := term (('+'|'-') term)*
 *   term   := factor (('*'|'/') factor)*
 *   factor := num | row | fn '(' args ')' | '(' expr ')'
 *   args   := expr (',' expr)*
 * Returns { ok:false } on any malformed structure or divide-by-zero rather than
 * throwing past the caller.
 */
export function evalFormula(
  tokens: PlanFormulaToken[],
  resolve: (ref: string, offset: number) => number,
): FormulaEvalResult {
  if (!Array.isArray(tokens) || tokens.length === 0) return { ok: false, value: 0, error: 'Empty formula' };
  let i = 0;
  const at = (): PlanFormulaToken | undefined => tokens[i];
  const eat = (): PlanFormulaToken => tokens[i++];

  function factor(): number {
    const t = at();
    if (!t) throw new Error('Unexpected end of formula');
    if (t.k === 'num') { eat(); return Number.isFinite(t.value) ? t.value : 0; }
    if (t.k === 'row') { eat(); const v = resolve(t.ref, t.offset || 0); return Number.isFinite(v) ? v : 0; }
    if (t.k === 'lp') { eat(); const v = expr(); expectRp(); return v; }
    if (t.k === 'fn') { eat(); return fnCall(t.fn); }
    throw new Error('Expected a value');
  }
  function expectRp() {
    const t = at();
    if (!t || t.k !== 'rp') throw new Error('Expected )');
    eat();
  }
  function fnCall(fn: PlanFormulaFn): number {
    const open = at();
    if (!open || open.k !== 'lp') throw new Error(`${fn} needs (`);
    eat();
    const args: number[] = [];
    if (at() && at()!.k !== 'rp') {
      args.push(expr());
      while (at() && at()!.k === 'comma') { eat(); args.push(expr()); }
    }
    expectRp();
    if (args.length === 0) throw new Error(`${fn} needs at least one argument`);
    switch (fn) {
      case 'SUM': return args.reduce((a, b) => a + b, 0);
      case 'AVG': return args.reduce((a, b) => a + b, 0) / args.length;
      case 'MIN': return Math.min(...args);
      case 'MAX': return Math.max(...args);
      case 'ABS': return Math.abs(args[0]);
      default: throw new Error(`Unknown function ${fn}`);
    }
  }
  function term(): number {
    let v = factor();
    while (at() && at()!.k === 'op' && ((at() as any).op === '*' || (at() as any).op === '/')) {
      const op = (eat() as any).op as PlanFormulaOp;
      const r = factor();
      if (op === '*') v *= r;
      else { if (r === 0) throw new Error('Divide by zero'); v /= r; }
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (at() && at()!.k === 'op' && ((at() as any).op === '+' || (at() as any).op === '-')) {
      const op = (eat() as any).op as PlanFormulaOp;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  try {
    const v = expr();
    if (i !== tokens.length) return { ok: false, value: 0, error: 'Unexpected trailing tokens' };
    if (!Number.isFinite(v)) return { ok: false, value: 0, error: 'Result is not a finite number' };
    return { ok: true, value: Math.round(v * 1e6) / 1e6 };
  } catch (e: any) {
    return { ok: false, value: 0, error: e?.message || 'Invalid formula' };
  }
}

const OFFSET_LABEL: Record<number, string> = { 0: '', [-1]: ' (prev)', [-4]: ' (yr ago)' };

/** Human-readable preview of a guided formula (for the builder live preview). */
export function formulaToText(tokens: PlanFormulaToken[], labelFor: (ref: string) => string): string {
  if (!Array.isArray(tokens) || tokens.length === 0) return '—';
  return tokens
    .map((t) => {
      switch (t.k) {
        case 'num': return String(t.value);
        case 'row': return `[${labelFor(t.ref) || t.ref}${OFFSET_LABEL[t.offset || 0] ?? ` (t${t.offset})`}]`;
        case 'op': return ` ${t.op} `;
        case 'fn': return t.fn;
        case 'lp': return '(';
        case 'rp': return ')';
        case 'comma': return ', ';
        default: return '';
      }
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Quick-formula generators (one-click guided formulas) ----

const row = (ref: string, offset = 0): PlanFormulaToken => ({ k: 'row', ref, offset });

/** SUM of the chosen rows (% of total numerator etc.). */
export function qfSum(refs: string[]): PlanFormulaToken[] {
  const out: PlanFormulaToken[] = [{ k: 'fn', fn: 'SUM' }, { k: 'lp' }];
  refs.forEach((r, idx) => { if (idx) out.push({ k: 'comma' }); out.push(row(r)); });
  out.push({ k: 'rp' });
  return out;
}
/** AVG of the chosen rows. */
export function qfAverage(refs: string[]): PlanFormulaToken[] {
  const out: PlanFormulaToken[] = [{ k: 'fn', fn: 'AVG' }, { k: 'lp' }];
  refs.forEach((r, idx) => { if (idx) out.push({ k: 'comma' }); out.push(row(r)); });
  out.push({ k: 'rp' });
  return out;
}
/** a − b. */
export function qfDifference(a: string, b: string): PlanFormulaToken[] {
  return [row(a), { k: 'op', op: '-' }, row(b)];
}
/** a ÷ b × 100 (ratio / % of). */
export function qfRatioPct(a: string, b: string): PlanFormulaToken[] {
  return [row(a), { k: 'op', op: '/' }, row(b), { k: 'op', op: '*' }, { k: 'num', value: 100 }];
}
/** Period-over-period growth %: (a − a₋₁) ÷ a₋₁ × 100. */
export function qfGrowthPct(ref: string, offset = -1): PlanFormulaToken[] {
  return [
    { k: 'lp' }, row(ref, 0), { k: 'op', op: '-' }, row(ref, offset), { k: 'rp' },
    { k: 'op', op: '/' }, row(ref, offset), { k: 'op', op: '*' }, { k: 'num', value: 100 },
  ];
}

// ---- Hierarchy- + formula-aware cell value resolution ----

/**
 * Value of any line item at a given period index for a scenario, resolving:
 *   • roll-up parents (sum of descendants),
 *   • formula rows (evaluate the guided AST, with period offsets),
 *   • subtotal rows (leaf-input period subtotal),
 *   • leaf inputs (the stored cell).
 * Cycle-safe via `seen`. Out-of-range period offsets resolve to 0.
 */
export function lineItemValueAt(
  sheet: PlanningSheet,
  scenarioId: string,
  lineItemId: string,
  periodIndex: number,
  seen: Set<string> = new Set(),
): number {
  if (periodIndex < 0 || periodIndex >= sheet.periods.length) return 0;
  if (seen.has(lineItemId)) return 0; // cycle guard
  const li = sheet.lineItems.find((x) => x.id === lineItemId);
  if (!li) return 0;
  const period = sheet.periods[periodIndex];

  const children = sheet.lineItems.filter((x) => x.parentId === li.id);
  if (children.length) {
    const next = new Set(seen); next.add(lineItemId);
    return children.reduce((acc, c) => acc + lineItemValueAt(sheet, scenarioId, c.id, periodIndex, next), 0);
  }
  if (li.kind === 'formula' && Array.isArray(li.formula) && li.formula.length) {
    const next = new Set(seen); next.add(lineItemId);
    const res = evalFormula(li.formula, (ref, offset) =>
      lineItemValueAt(sheet, scenarioId, ref, periodIndex + offset, next));
    return res.ok ? res.value : 0;
  }
  if (li.kind === 'subtotal') return periodTotal(sheet, scenarioId, period.id);
  return getCell(sheet.cells, li.id, period.id, scenarioId);
}

/** Row total of any line item (sum of {@link lineItemValueAt} across periods). */
export function lineItemRowTotal(sheet: PlanningSheet, scenarioId: string, lineItemId: string): number {
  let acc = 0;
  for (let i = 0; i < sheet.periods.length; i++) acc += lineItemValueAt(sheet, scenarioId, lineItemId, i);
  return acc;
}

// ---- Model validation (pure) ----

export interface ModelIssue { level: 'error' | 'warning'; message: string }
export interface ModelValidation { ok: boolean; issues: ModelIssue[] }

/** True when following `parentId` from `id` revisits any member (a cycle). */
function memberHasCycle(members: PlanMember[], id: string): boolean {
  const byId = new Map(members.map((m) => [m.id, m]));
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && cur.parentId) {
    if (seen.has(cur.id)) return true;
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
    if (cur && seen.has(cur.id)) return true;
  }
  return false;
}

/**
 * Validate a cube model: dimension/measure naming, member-parent integrity,
 * hierarchy cycles, duplicate ids, and measure scope refs. Pure — runs over
 * Cosmos state with no external service.
 */
export function validateModel(model: PlanModel, lineItemIds: string[] = []): ModelValidation {
  const issues: ModelIssue[] = [];
  const dims = Array.isArray(model?.dimensions) ? model.dimensions : [];
  const measures = Array.isArray(model?.measures) ? model.measures : [];

  const dimNames = new Map<string, number>();
  for (const d of dims) {
    if (!d.name?.trim()) issues.push({ level: 'error', message: `Dimension "${d.id}" has no name.` });
    else dimNames.set(d.name.trim().toLowerCase(), (dimNames.get(d.name.trim().toLowerCase()) || 0) + 1);

    const memberIds = new Set<string>();
    for (const m of d.members || []) {
      if (memberIds.has(m.id)) issues.push({ level: 'error', message: `Dimension "${d.name || d.id}" has a duplicate member id "${m.id}".` });
      memberIds.add(m.id);
      if (!m.label?.trim()) issues.push({ level: 'warning', message: `A member of "${d.name || d.id}" has no label.` });
    }
    for (const m of d.members || []) {
      if (m.parentId && !memberIds.has(m.parentId)) {
        issues.push({ level: 'error', message: `Member "${m.label || m.id}" in "${d.name || d.id}" points at a missing parent.` });
      }
      if (memberHasCycle(d.members || [], m.id)) {
        issues.push({ level: 'error', message: `Hierarchy cycle under member "${m.label || m.id}" in "${d.name || d.id}".` });
      }
    }
  }
  for (const [name, n] of dimNames) if (n > 1) issues.push({ level: 'error', message: `Duplicate dimension name "${name}".` });

  const measureNames = new Map<string, number>();
  for (const ms of measures) {
    if (!ms.name?.trim()) issues.push({ level: 'error', message: `A measure has no name.` });
    else measureNames.set(ms.name.trim().toLowerCase(), (measureNames.get(ms.name.trim().toLowerCase()) || 0) + 1);
    if (ms.scopeLineItemId && lineItemIds.length && !lineItemIds.includes(ms.scopeLineItemId)) {
      issues.push({ level: 'warning', message: `Measure "${ms.name || ms.id}" is scoped to a line item that no longer exists.` });
    }
  }
  for (const [name, n] of measureNames) if (n > 1) issues.push({ level: 'error', message: `Duplicate measure name "${name}".` });

  return { ok: issues.every((x) => x.level !== 'error'), issues };
}

/**
 * Validate formula line items across a sheet: every row ref must resolve to a
 * real line item, and formula→formula references must not form a cycle. Pure.
 */
export function validateFormulaRows(sheet: PlanningSheet): ModelValidation {
  const issues: ModelIssue[] = [];
  const ids = new Set(sheet.lineItems.map((li) => li.id));
  const formulaItems = sheet.lineItems.filter((li) => li.kind === 'formula' && Array.isArray(li.formula) && li.formula.length);

  for (const li of formulaItems) {
    for (const ref of formulaRefs(li.formula!)) {
      if (!ids.has(ref)) issues.push({ level: 'error', message: `Formula "${li.name}" references a missing row.` });
      else if (ref === li.id) issues.push({ level: 'error', message: `Formula "${li.name}" references itself.` });
    }
  }
  // Cycle detection across formula rows (DFS over ref graph).
  const byId = new Map(sheet.lineItems.map((li) => [li.id, li]));
  const colour = new Map<string, 0 | 1 | 2>();
  const dfs = (id: string): boolean => {
    const node = byId.get(id);
    if (!node || node.kind !== 'formula' || !Array.isArray(node.formula)) return false;
    colour.set(id, 1);
    for (const ref of formulaRefs(node.formula)) {
      const c = colour.get(ref);
      if (c === 1) return true;
      if (c === undefined && dfs(ref)) return true;
    }
    colour.set(id, 2);
    return false;
  };
  for (const li of formulaItems) {
    if (colour.get(li.id) === undefined && dfs(li.id)) {
      issues.push({ level: 'error', message: `Formula cycle detected involving "${li.name}".` });
    }
  }
  return { ok: issues.every((x) => x.level !== 'error'), issues };
}

/** A starter cube model — one Account dimension + a Total revenue measure. */
export function defaultPlanModel(): PlanModel {
  return {
    dimensions: [
      {
        id: 'dim_account', name: 'Account', axis: 'row',
        members: [
          { id: 'm_pnl', label: 'P&L' },
          { id: 'm_rev', label: 'Revenue', parentId: 'm_pnl' },
          { id: 'm_cost', label: 'Costs', parentId: 'm_pnl' },
        ],
      },
    ],
    measures: [
      { id: 'meas_total', name: 'Total', agg: 'sum', unit: 'USD' },
    ],
  };
}
