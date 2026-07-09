/**
 * semantic-link.ts — PURE DAX builders for Semantic Link (FGC-17) and the
 * standalone DAX query view (FGC-21).
 *
 * FGC-17 "Semantic link / SemPy `LoomDataFrame`": the notebook helper
 * (lib/notebook/loom-semantic-link.py) calls the BFF
 * /api/items/semantic-model/[id]/semantic-link, which uses these builders to
 * turn an `add_measure(model, name)` request into an EVALUATE the Azure-native
 * tabular backend (tabular-eval-client → Synapse serverless, or AAS XMLA when
 * opted in) can run. NO Power BI / Fabric REST is ever called.
 *
 * FGC-21 "Standalone DAX query view": {@link daxQueryTemplate} generates the
 * right-click "New quick query" starter DAX for a table / column, run through
 * the same EVALUATE path.
 *
 * Everything here is a pure string function — deterministic + unit-testable.
 */

import { analyzeRelationships, type HealthTable, type HealthRelationship, type HealthFinding } from './model-health';

/** A DAX identifier that is safe to interpolate — no brackets/quotes. */
function safeName(s: string): string {
  return String(s ?? '').replace(/[[\]"']/g, '').trim();
}

/** Quote a table name for DAX: `'Name with spaces'` or bare `Name`. */
export function quoteTable(table: string): string {
  const t = safeName(table);
  return /[^A-Za-z0-9_]/.test(t) ? `'${t}'` : t;
}

/**
 * Normalize a measure expression into the row-scalar the loom-native
 * translator understands (`CALCULATE(AGG(Table[Col]))`), when possible:
 *   • already `CALCULATE(...)`  → returned unchanged
 *   • bare `AGG(Table[Col])`     → wrapped in `CALCULATE(...)`
 *   • anything else              → returned unchanged (full-DAX path; AAS only)
 */
export function normalizeScalarExpression(expression: string): string {
  const e = String(expression ?? '').trim().replace(/;+\s*$/, '');
  if (/^CALCULATE\s*\(/i.test(e)) return e;
  if (/^(SUM|COUNT|COUNTA|COUNTROWS|DISTINCTCOUNT|AVERAGE|MIN|MAX)\s*\(/i.test(e)) return `CALCULATE(${e})`;
  return e;
}

/**
 * Build the DAX for `add_measure`. With no `groupby` it evaluates the measure
 * to a single scalar via `EVALUATE ROW(...)` — which the loom-native Synapse
 * translator supports for aggregate measures (and AAS supports fully). With
 * `groupby` columns it builds `EVALUATE SUMMARIZECOLUMNS(...)`, which requires
 * the AAS backend (the loom-native translator returns an honest unsupported
 * error — surfaced to the notebook, never a fake result).
 *
 * @param measureName display label for the result column
 * @param expression  the measure's DAX expression (from the model store)
 * @param groupby      optional `Table[Column]` group-by keys
 */
export function buildMeasureEvalDax(measureName: string, expression: string, groupby: string[] = []): string {
  const label = safeName(measureName) || 'Value';
  const cols = (groupby || []).map((g) => String(g).trim()).filter(Boolean);
  if (cols.length === 0) {
    return `EVALUATE ROW("${label}", ${normalizeScalarExpression(expression)})`;
  }
  // Grouped: SUMMARIZECOLUMNS(<keys>, "<label>", <expr>).
  const keyList = cols.join(', ');
  return `EVALUATE SUMMARIZECOLUMNS(${keyList}, "${label}", ${normalizeScalarExpression(expression)})`;
}

export type DaxTemplateKind = 'table-preview' | 'top-n' | 'column-distinct' | 'column-summary' | 'row-count';

/**
 * Generate a starter DAX query for the right-click "New quick query" action in
 * the DAX query view (FGC-21). `column` is required for column-scoped kinds.
 */
export function daxQueryTemplate(kind: DaxTemplateKind, table: string, column?: string, topN = 100): string {
  const t = quoteTable(table);
  const col = safeName(column || '');
  switch (kind) {
    case 'table-preview':
      return `EVALUATE\nTOPN(${Math.max(1, topN)}, ${t})`;
    case 'top-n':
      return `EVALUATE\nTOPN(${Math.max(1, topN)}, ${t})`;
    case 'row-count':
      return `EVALUATE\nROW("Row count", COUNTROWS(${t}))`;
    case 'column-distinct':
      return `EVALUATE\nDISTINCT(${t}[${col}])`;
    case 'column-summary':
      return `EVALUATE\nSUMMARIZECOLUMNS(\n  ${t}[${col}],\n  "Count", COUNTROWS(${t})\n)`;
    default:
      return `EVALUATE\n${t}`;
  }
}

/** Basic guard: a DAX query for the query view must start with EVALUATE/DEFINE. */
export function looksLikeDaxQuery(dax: string): boolean {
  return /^\s*(DEFINE\b|EVALUATE\b)/i.test(String(dax ?? ''));
}

// ── Notebook `.validate_relationships()` — reuse the health analyzer ────────

export interface RelationshipReport {
  ok: boolean;
  /** Human-readable one-liners for the notebook receipt. */
  issues: string[];
  findings: HealthFinding[];
}

/**
 * Produce the `.validate_relationships()` report the notebook helper returns:
 * reuses {@link analyzeRelationships} so a broken/missing relationship is
 * flagged identically to the health scan. `ok` is true only when there are no
 * error-severity findings.
 */
export function validateRelationshipsReport(tables: HealthTable[], relationships: HealthRelationship[]): RelationshipReport {
  const { findings } = analyzeRelationships(tables, relationships);
  const issues = findings.map((f) => `[${f.severity}] ${f.title} — ${f.detail}`);
  return { ok: findings.every((f) => f.severity !== 'error'), issues, findings };
}
