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
 *
 * WAVE-3 (AI visuals): the designer gallery gains `decompositionTree` and
 * `keyInfluencers`. They are added to DESIGNER_VISUAL_TYPES so the Copilot can
 * place them too — their structured wells map Analyze → `values` (the measure/
 * category being explained) and Explain by → `category`/`legend` (the fields to
 * break down by). Both self-query the unchanged POST …/query (GROUP-BY drill /
 * per-category lift) at render time, so they emit the same Apply card as any
 * other visual. The AI *text* visuals (Smart narrative, Q&A) are deliberately
 * NOT in this vocabulary — they live on the /ai-visual route. That route reuses
 * the EXACT same well validation as the Copilot's add-visual path by importing
 * the `sanitizeField` / `sanitizeList` helpers exported below (single source of
 * truth — Q&A specs and Copilot specs cannot drift apart).
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
  // Wave-3 AI visuals — self-query GROUP-BY drill / per-category lift over POST …/query.
  // Their wells map Analyze → values and Explain by → category/legend (see handler).
  'decompositionTree', 'keyInfluencers',
] as const;
export type DesignerVisualType = (typeof DESIGNER_VISUAL_TYPES)[number];

/** AI analyze-style visuals: Analyze well → values, Explain-by wells → category/legend. */
const AI_ANALYZE_TYPES = new Set<DesignerVisualType>(['decompositionTree', 'keyInfluencers']);

/**
 * Case-insensitive canonical lookup. Legacy types are lowercase, so a plain
 * `.toLowerCase()` compare worked; the wave-3 camelCase types (`decompositionTree`)
 * would never match their own lowercased form, so resolve through this map to
 * recover the canonical spelling regardless of how the model cased the value.
 */
const TYPE_BY_LOWER = new Map<string, DesignerVisualType>(
  DESIGNER_VISUAL_TYPES.map((t) => [t.toLowerCase(), t] as [string, DesignerVisualType]),
);

const AGGS = new Set(['Sum', 'Avg', 'Count', 'Min', 'Max']);

/** A single field placed in a well — a model column (with an aggregation) or a measure. */
export interface ActWellField { table?: string; column?: string; measure?: string; aggregation?: string }

/** The structured spec the pane applies to the designer (one new visual). */
export interface DesignerVisualSpec {
  type: DesignerVisualType;
  title: string;
  wells: { category: ActWellField[]; values: ActWellField[]; legend: ActWellField[] };
  w?: number;
  h?: number;
}

/**
 * Validate a single well field. EXPORTED so the /ai-visual route (Q&A) reuses the
 * EXACT same rule as the Copilot's add-visual path — a field must reference a real
 * column or measure — keeping Q&A specs and Copilot specs from drifting apart.
 */
export function sanitizeField(raw: unknown): ActWellField | null {
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

/** Validate a well (array of fields), dropping anything that references nothing real. EXPORTED — see sanitizeField. */
export function sanitizeList(raw: unknown): ActWellField[] {
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
      '`category` field. AI visuals `decompositionTree` and `keyInfluencers` put the measure to Analyze in ' +
      '`values` and the fields to "Explain by" in `category`/`legend` (one or more dimensions). Never write ' +
      'DAX — the designer synthesizes the query from these wells.',
    whenToUse: 'Act on "add a <chart> of X by Y" against the open report designer.',
    readsContext: true,
    parameters: obj(
      {
        type: { ...S_STRING, enum: [...DESIGNER_VISUAL_TYPES], description: 'The visual type.' },
        title: { ...S_STRING, description: 'Human-readable visual title.' },
        category: { type: 'array', items: FIELD_SCHEMA, description: 'Axis / Category / Rows wells (dimension fields). For decompositionTree/keyInfluencers these are "Explain by" fields.' },
        values: { type: 'array', items: FIELD_SCHEMA, description: 'Values / Columns / Fields wells (measures or aggregated columns). For decompositionTree/keyInfluencers this is the "Analyze" measure.' },
        legend: { type: 'array', items: FIELD_SCHEMA, description: 'Legend / Columns (matrix) wells (optional). Additional "Explain by" fields for decompositionTree/keyInfluencers.' },
        w: { ...S_NUMBER, description: 'Optional canvas span on a 12-column grid (2–12).' },
        h: { ...S_NUMBER, description: 'Optional row-height hint.' },
      },
      ['type', 'title'],
    ),
    handler: async ({ type, title, category, values, legend, w, h }) => {
      const t = TYPE_BY_LOWER.get(String(type || '').trim().toLowerCase());
      if (!t) {
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
      if (AI_ANALYZE_TYPES.has(t)) {
        // Analyze → values, Explain by → category/legend. Both are required: the
        // visual self-queries a GROUP-BY of the Analyze measure broken down by the
        // Explain-by field(s), so a missing well would emit an unrunnable spec.
        if (wells.values.length === 0) {
          throw new Error(`A ${t} visual needs an "Analyze" measure in Values.`);
        }
        if (wells.category.length + wells.legend.length === 0) {
          throw new Error(`A ${t} visual needs at least one "Explain by" field in Category/Legend.`);
        }
      }
      const ttl = String(title || '').trim();
      const spec: DesignerVisualSpec = {
        type: t,
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
