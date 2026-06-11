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
