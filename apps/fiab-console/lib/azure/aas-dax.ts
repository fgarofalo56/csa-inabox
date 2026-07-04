/**
 * aas-dax — pure, credential-free helpers for the Loom-native report renderer.
 *
 * Split out from aas-client.ts so the deterministic DAX-synthesis / row-shaping
 * / binding-resolution logic can be imported and unit-tested WITHOUT pulling in
 * @azure/identity (which the credentialed executeAasQuery needs). No network,
 * no Azure SDK — only cloud-endpoints (suffix/parse) helpers.
 */

import { parseAasServer } from './cloud-endpoints';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

/** Parsed row shape returned by the AAS query endpoint. */
export type AasRow = Record<string, unknown>;

/** Single result table from the AAS executeQueries response. */
export interface AasTable {
  rows: AasRow[];
}

/** Full executeQueries response envelope. */
export interface AasQueryResult {
  results: Array<{ tables: AasTable[] }>;
}

/**
 * Resolve the AAS binding for a report item. Prefers the per-item state
 * (`state.aasServer` / `state.aasDatabase`); falls back to the platform-level
 * `LOOM_AAS_SERVER` / `LOOM_AAS_DATABASE` env vars. Returns null when neither
 * a server nor a database can be resolved, or the server string can't be
 * parsed into region + serverName.
 */
export function resolveAasBinding(
  stateServer?: string,
  stateDatabase?: string,
): { region: string; serverName: string; database: string } | null {
  const server = (stateServer || process.env.LOOM_AAS_SERVER || '').trim();
  const database = (stateDatabase || process.env.LOOM_AAS_DATABASE || '').trim();
  if (!server || !database) return null;
  const parsed = parseAasServer(server);
  if (!parsed) return null;
  return { ...parsed, database };
}

/**
 * A single field assignment in a visual's well (Axis/Category, Values, Legend).
 * Either a model column (`table` + `column`, optionally aggregated) or a model
 * measure (`measure`). Mirrors the Power BI field-well model 1:1 so the Loom
 * report designer can author multi-field visuals without typed DAX
 * (no-freeform-config.md).
 */
export interface DaxWellField {
  table?: string;
  column?: string;
  measure?: string;
  /** Aggregation applied to a column in the Values well. Ignored for measures. */
  aggregation?: 'Sum' | 'Avg' | 'Count' | 'Min' | 'Max' | 'None';
}

/** A visual definition the DAX synthesizer understands — single-field (legacy)
 *  or rich field wells (designer). */
export interface DaxVisual {
  type: string;
  field?: string;
  wells?: {
    category?: DaxWellField[];
    values?: DaxWellField[];
    legend?: DaxWellField[];
  };
}

/** Map a Loom aggregation choice to its DAX function. "Count" uses COUNTA so it
 *  works on text columns too (matches Power BI's default "Count"). */
const DAX_AGG_FN: Record<string, string> = {
  Sum: 'SUM',
  Avg: 'AVERAGE',
  Count: 'COUNTA',
  Min: 'MIN',
  Max: 'MAX',
};

/** Single-quote a table name (always safe; escapes embedded quotes). */
function daxTable(t: string): string {
  return `'${escapeSqlLiteral(t)}'`;
}
/** Build a `'Table'[Column]` reference (bracket-escaped). */
function daxColumnRef(w: DaxWellField): string | null {
  if (!w.column) return null;
  const tbl = w.table ? daxTable(w.table) : '';
  return `${tbl}[${w.column.replace(/\]/g, ']]')}]`;
}
/** Build a `[Measure]` reference (measures are model-global). */
function daxMeasureRef(w: DaxWellField): string | null {
  if (!w.measure) return null;
  return `[${w.measure.replace(/\]/g, ']]')}]`;
}
/** Quote a string literal for a SUMMARIZECOLUMNS / ROW alias. */
function daxAlias(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Build an aggregated value expression + its result-column alias from a well
 *  field. Measures pass through; columns get wrapped in their aggregation
 *  (defaulting to SUM when none chosen). Returns null when the field is empty. */
function daxValueExpr(w: DaxWellField): { alias: string; expr: string } | null {
  const m = daxMeasureRef(w);
  if (m && w.measure) return { alias: w.measure, expr: m };
  const c = daxColumnRef(w);
  if (c && w.column) {
    const useAgg = w.aggregation && w.aggregation !== 'None';
    const fn = useAgg ? DAX_AGG_FN[w.aggregation as string] || 'SUM' : 'SUM';
    const label = useAgg ? `${w.aggregation} of ${w.column}` : `Sum of ${w.column}`;
    return { alias: label, expr: `${fn}(${c})` };
  }
  return null;
}

/**
 * Build a DAX EVALUATE from a visual's rich field wells. Returns null when the
 * visual has no usable wells (caller falls back to the single-`field` path).
 *
 *   category/legend + values → EVALUATE TOPN(1000, SUMMARIZECOLUMNS(<grp>, <"alias",expr>…))
 *   values only (card/KPI)   → EVALUATE ROW(<"alias", expr>…)
 *   category only (slicer)   → EVALUATE TOPN(1000, SUMMARIZECOLUMNS(<grp>))
 */
export function buildDaxFromWells(visual: DaxVisual): string | null {
  const wells = visual.wells;
  if (!wells) return null;
  const group = [...(wells.category || []), ...(wells.legend || [])]
    .map(daxColumnRef)
    .filter((x): x is string => !!x);
  const values = (wells.values || [])
    .map(daxValueExpr)
    .filter((x): x is { alias: string; expr: string } => !!x);
  if (group.length === 0 && values.length === 0) return null;

  const valueParts = values.map((v) => `${daxAlias(v.alias)}, ${v.expr}`);
  if (group.length === 0) {
    // No grouping → a single-row card / KPI.
    return `EVALUATE ROW(${valueParts.join(', ')})`;
  }
  if (values.length === 0) {
    // Categories only (slicer / distinct-value table).
    return `EVALUATE TOPN(1000, SUMMARIZECOLUMNS(${group.join(', ')}))`;
  }
  return `EVALUATE TOPN(1000, SUMMARIZECOLUMNS(${group.join(', ')}, ${valueParts.join(', ')}))`;
}

/**
 * Synthesize a safe DAX EVALUATE expression for a visual. Prefers the rich
 * field-well model (designer); falls back to the single-`field` shape so the
 * legacy read-only viewer + Copilot-applied visuals keep working. Every branch
 * returns a real, executable DAX string (no vaporware):
 *   - rich wells (category/values/legend)     → SUMMARIZECOLUMNS / ROW (see above)
 *   - already an EVALUATE expression          → pass through
 *   - measure/column ([..]) + card type       → EVALUATE ROW("Value", <field>)
 *   - measure/column ([..]) + other type      → EVALUATE TOPN(100, ROW("Value", <field>))
 *   - bare table name (no brackets / parens)  → EVALUATE TOPN(100, <table>)
 *   - empty field                             → null (caller skips the visual)
 */
export function buildDaxFromVisual(visual: DaxVisual): string | null {
  // Rich field wells take precedence (back-compatible: absent wells → fall through).
  const fromWells = buildDaxFromWells(visual);
  if (fromWells) return fromWells;

  const field = (visual.field || '').trim();
  if (!field) return null;
  if (/^EVALUATE\b/i.test(field)) return field;
  // Measure or column reference: contains [ but not a function-call paren.
  if (field.includes('[') && !field.includes('(')) {
    if (visual.type === 'card') return `EVALUATE ROW("Value", ${field})`;
    return `EVALUATE TOPN(100, ROW("Value", ${field}))`;
  }
  // Plain table name — TOPN guard avoids full-table dumps.
  return `EVALUATE TOPN(100, ${field})`;
}

/**
 * Flatten the AAS query response into a simple rows array, stripping the AAS
 * column-name prefix ("[Table].[Column]" / "[Column]" → "Column") for the UI.
 */
export function flattenAasRows(result: AasQueryResult): AasRow[] {
  const tables = result?.results?.[0]?.tables;
  if (!tables?.length) return [];
  return (tables[0].rows || []).map((row) => {
    const flat: AasRow = {};
    for (const [k, v] of Object.entries(row)) {
      const bare = k
        .replace(/^\[[^\]]+\]\.\[([^\]]+)\]$/, '$1')
        .replace(/^\[([^\]]+)\]$/, '$1');
      flat[bare] = v;
    }
    return flat;
  });
}
