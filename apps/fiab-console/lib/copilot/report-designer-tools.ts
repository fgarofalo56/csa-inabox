/**
 * report-designer-tools.ts — structured "act on the open report DESIGNER" tools.
 *
 * The Power BI Copilot pane docked in the report DESIGNER (lib/editors/report-
 * designer.tsx) lets the user say "add a Bar chart of Sales by Region" or "add a
 * page". The model NEVER writes raw DAX (no-freeform-config.md): instead it calls
 * one of the two tools below, which VALIDATE + echo a STRUCTURED visual / page
 * spec. The spec travels back to the pane as a normal tool_result; the pane then
 * APPLIES it to the designer's in-memory state (a new visual with field wells, or
 * a new page) so it live-renders against the bound AAS tabular model via POST
 * …/query, and persists on the designer's Save (PUT …/definition). Nothing is
 * mutated server-side here — these tools are pure validators/emitters, exactly
 * like the dataflow-copilot pending-diff cards.
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): the spec targets
 * the Loom-native Azure Analysis Services designer wells — no Power BI / Fabric
 * workspace is required. The opt-in Power BI remote MCP only ADDS a live query
 * surface; it never replaces this acting path.
 *
 * NO-VAPORWARE: the wells reference REAL model fields (the route injects the bound
 * model's table/column/measure list into the system prompt); the tools reject a
 * field that names neither a column nor a measure, and an unknown visual type.
 */

import type { ToolDef } from '@/lib/azure/copilot-orchestrator';

const S_STRING = { type: 'string' } as const;
const S_NUMBER = { type: 'number' } as const;

function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

/** Designer visual vocabulary (matches report-designer.tsx VisualType). */
export const DESIGNER_VISUAL_TYPES = [
  'table', 'matrix', 'card', 'bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter', 'slicer',
] as const;
export type DesignerVisualType = (typeof DESIGNER_VISUAL_TYPES)[number];

const AGGS = new Set(['Sum', 'Avg', 'Count', 'Min', 'Max']);

/** A single field placed in a well — a model column (with an aggregation) or a measure. */
interface ActWellField { table?: string; column?: string; measure?: string; aggregation?: string }

/** The structured spec the pane applies to the designer (one new visual). */
export interface DesignerVisualSpec {
  type: DesignerVisualType;
  title: string;
  wells: { category: ActWellField[]; values: ActWellField[]; legend: ActWellField[] };
  w?: number;
  h?: number;
}

function sanitizeField(raw: unknown): ActWellField | null {
  const f = (raw || {}) as Record<string, unknown>;
  const table = typeof f.table === 'string' ? f.table.trim() : undefined;
  const column = typeof f.column === 'string' ? f.column.trim() : undefined;
  const measure = typeof f.measure === 'string' ? f.measure.trim() : undefined;
  if (!column && !measure) return null; // a well field must reference something real
  const aggRaw = typeof f.aggregation === 'string' ? f.aggregation : undefined;
  const aggregation = aggRaw && AGGS.has(aggRaw) ? aggRaw : (column ? 'Sum' : undefined);
  return {
    ...(table ? { table } : {}),
    ...(column ? { column } : {}),
    ...(measure ? { measure } : {}),
    ...(aggregation ? { aggregation } : {}),
  };
}

function sanitizeList(raw: unknown): ActWellField[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeField).filter((x): x is ActWellField => !!x);
}

const FIELD_SCHEMA = obj({
  table: { ...S_STRING, description: 'Model table the column belongs to (omit for a measure).' },
  column: { ...S_STRING, description: 'Model column name (omit for a measure).' },
  measure: { ...S_STRING, description: 'Model measure name (omit for a column).' },
  aggregation: { ...S_STRING, enum: ['Sum', 'Avg', 'Count', 'Min', 'Max'], description: 'Aggregation for a column placed in Values (default Sum).' },
});

/**
 * The two designer-acting tools. Pure: they validate + echo a spec the pane
 * applies — no Synapse/AAS/network call, safe in any registry.
 */
export function buildReportDesignerActTools(): ToolDef[] {
  const addVisual: ToolDef = {
    name: 'report_designer_add_visual',
    service: 'Report designer',
    description:
      'Add a visual to the OPEN report page by emitting a STRUCTURED spec the designer applies (the user ' +
      'approves it in the pane first — never claim it is added). Use this to act on requests like ' +
      '"add a Bar chart of <measure> by <category>". Reference ONLY fields from the model field list in ' +
      'the system prompt. Charts (bar/column/line/area/pie/donut/scatter) need a `category` (axis) AND ' +
      '`values`; a `card` needs `values`; a `table` needs `values` (its columns); a `slicer` needs one ' +
      '`category` field. Never write DAX — the designer synthesizes it from these wells.',
    whenToUse: 'Act on "add a <chart> of X by Y" against the open report designer.',
    readsContext: true,
    parameters: obj(
      {
        type: { ...S_STRING, enum: [...DESIGNER_VISUAL_TYPES], description: 'The visual type.' },
        title: { ...S_STRING, description: 'Human-readable visual title.' },
        category: { type: 'array', items: FIELD_SCHEMA, description: 'Axis / Category / Rows wells (dimension fields).' },
        values: { type: 'array', items: FIELD_SCHEMA, description: 'Values / Columns / Fields wells (measures or aggregated columns).' },
        legend: { type: 'array', items: FIELD_SCHEMA, description: 'Legend / Columns (matrix) wells (optional).' },
        w: { ...S_NUMBER, description: 'Optional canvas span on a 12-column grid (2–12).' },
        h: { ...S_NUMBER, description: 'Optional row-height hint.' },
      },
      ['type', 'title'],
    ),
    handler: async ({ type, title, category, values, legend, w, h }) => {
      const t = String(type || '').trim().toLowerCase();
      if (!(DESIGNER_VISUAL_TYPES as readonly string[]).includes(t)) {
        throw new Error(`Invalid visual type "${type}". Allowed: ${DESIGNER_VISUAL_TYPES.join(', ')}.`);
      }
      const wells = {
        category: sanitizeList(category),
        values: sanitizeList(values),
        legend: sanitizeList(legend),
      };
      if (wells.category.length + wells.values.length + wells.legend.length === 0) {
        throw new Error('A visual needs at least one field in a well (e.g. a measure in Values and a column in Category).');
      }
      const ttl = String(title || '').trim();
      const spec: DesignerVisualSpec = {
        type: t as DesignerVisualType,
        title: ttl || t,
        wells,
        ...(Number(w) >= 2 ? { w: Math.min(12, Math.round(Number(w))) } : {}),
        ...(Number(h) >= 1 ? { h: Math.round(Number(h)) } : {}),
      };
      // The pane reads `spec` and renders an Apply card. Not yet applied.
      return { ok: true, action: 'add_visual' as const, spec };
    },
  };

  const addPage: ToolDef = {
    name: 'report_designer_add_page',
    service: 'Report designer',
    description:
      'Add a new page to the OPEN report. Returns a structured action the designer applies after the user ' +
      'approves it in the pane. Pass an optional page name.',
    whenToUse: 'Act on "add a page" / "new report page".',
    parameters: obj({ name: { ...S_STRING, description: 'Optional page name (defaults to "Page N").' } }),
    handler: async ({ name }) => {
      const nm = String(name || '').trim();
      return { ok: true, action: 'add_page' as const, name: nm || undefined };
    },
  };

  return [addVisual, addPage];
}
