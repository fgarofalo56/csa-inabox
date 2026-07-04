/**
 * quick-measure-templates — pure, credential-free gallery of parameterized DAX
 * "quick measure" templates for the Wave-3 Model view.
 *
 * This is the structured alternative to hand-typed DAX (loom_no_freeform_config):
 * the editor renders a GALLERY of these templates, each with typed field
 * pickers (measure / column / date column / category). The user picks fields
 * from the REAL loaded model tables and the template GENERATES standard,
 * engine-portable DAX — zero free-form authoring. The generated measure lands
 * on `item.state.model.measures` (model-store) and therefore immediately drives
 * real `/query` results (no-vaporware).
 *
 * NO Azure SDK, NO React, NO network — only string synthesis grounded in the
 * picked field references. Unit-testable in isolation. The DAX produced targets
 * a tabular (AAS / Power BI / Loom-native semantic) engine; it is portable
 * across those engines because it uses only standard time-intelligence /
 * CALCULATE / RANKX / text functions and the user's own field refs.
 *
 * Field-reference quoting matches aas-dax.ts:
 *   table  → 'Table'           (single-quoted, '' escaped)
 *   column → 'Table'[Column]   (']' → ']]')
 *   measure→ [Measure]         (model-global, ']' → ']]')
 */

import { escapeSqlLiteral } from '@/lib/sql/quoting';

/* ────────────────────────────── types ────────────────────────────── */

/** The kind of model object a template field expects the user to pick. */
export type QuickMeasureFieldKind = 'measure' | 'column' | 'dateColumn' | 'category';

/** One typed field slot in a template's picker form. */
export interface QuickMeasureField {
  /** Stable key the generator reads from `picks`. */
  key: string;
  /** Human label shown next to the picker. */
  label: string;
  /** What kind of model object the picker is constrained to. */
  kind: QuickMeasureFieldKind;
  /** Optional helper hint shown under the picker (Caption1). */
  hint?: string;
}

/**
 * A single picked model object. Either a model measure (`measure`) or a column
 * (`table` + `column`). Mirrors the aas-dax field-well shape so the editor can
 * reuse the same field-picker control it already has.
 */
export interface QuickMeasureFieldPick {
  table?: string;
  column?: string;
  measure?: string;
}

/** Map of `field.key` → the object the user picked for it. */
export type QuickMeasurePicks = Record<string, QuickMeasureFieldPick | undefined>;

/** Optional scalar knobs that aren't model-field picks (e.g. star rating max). */
export interface QuickMeasureOptions {
  /** Star-rating ceiling (default 5). */
  maxRating?: number;
}

/** What a generator returns: a default measure name + the synthesized DAX. */
export interface QuickMeasureResult {
  /** Suggested (editable) measure name — DAX measure names may contain spaces. */
  name: string;
  /** The generated, ready-to-save DAX expression. */
  expression: string;
}

/** A quick-measure template: metadata for the gallery + a pure DAX generator. */
export interface QuickMeasureTemplate {
  /** Stable identifier. */
  key: string;
  /** Card title in the gallery. */
  title: string;
  /** One-line description (Caption1) of what the measure computes. */
  caption: string;
  /** Optional Fluent icon name the gallery maps to a glyph. */
  icon?: string;
  /** Typed field slots the user fills before generating. */
  fields: QuickMeasureField[];
  /** Pure generator: picks (+ options) → `{ name, expression }`. Throws a
   *  descriptive Error when a required field has no pick (the gallery gates the
   *  Add button on completeness, so this is a guard, not the happy path). */
  generate(picks: QuickMeasurePicks, options?: QuickMeasureOptions): QuickMeasureResult;
}

/* ──────────────────────────── ref helpers ─────────────────────────── */

/** Single-quote + escape a table name. */
function daxTable(t: string): string {
  return `'${escapeSqlLiteral(t)}'`;
}

/** Build the DAX reference for a pick: `[Measure]` or `'Table'[Column]`. */
function refOf(pick?: QuickMeasureFieldPick): string {
  if (!pick) return '';
  if (pick.measure) return `[${pick.measure.replace(/\]/g, ']]')}]`;
  if (pick.column) {
    const tbl = pick.table ? daxTable(pick.table) : '';
    return `${tbl}[${pick.column.replace(/\]/g, ']]')}]`;
  }
  return '';
}

/** Friendly label for a pick (for the suggested measure name). */
function labelOf(pick: QuickMeasureFieldPick | undefined, fallback: string): string {
  return (pick?.measure || pick?.column || fallback).trim() || fallback;
}

/**
 * Resolve a required field's ref, throwing a clear Error when it's unpicked.
 * Keeps generators terse and gives the UI / unit tests a deterministic signal.
 */
function requireRef(template: QuickMeasureTemplate, picks: QuickMeasurePicks, key: string): string {
  const field = template.fields.find((f) => f.key === key);
  const ref = refOf(picks[key]);
  if (!ref) {
    throw new Error(`Quick measure "${template.key}": pick a value for "${field?.label || key}".`);
  }
  return ref;
}

/** Clamp + default the star-rating ceiling to a sane positive integer. */
function resolveMaxRating(options?: QuickMeasureOptions): number {
  const n = Math.round(Number(options?.maxRating));
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/* ───────────────────────────── templates ──────────────────────────── */

const MEASURE_FIELD: QuickMeasureField = { key: 'measure', label: 'Base measure', kind: 'measure' };
const DATE_FIELD: QuickMeasureField = {
  key: 'date',
  label: 'Date column',
  kind: 'dateColumn',
  hint: 'A column from a date table marked as Time.',
};
const CATEGORY_FIELD: QuickMeasureField = { key: 'category', label: 'Category', kind: 'category' };

export const quickMeasureTemplates: QuickMeasureTemplate[] = [
  {
    key: 'ytd',
    title: 'Year-to-date total',
    caption: 'Accumulates the base measure from the start of the year to the current date.',
    icon: 'CalendarLtr',
    fields: [MEASURE_FIELD, DATE_FIELD],
    generate(picks) {
      const m = requireRef(this, picks, 'measure');
      const d = requireRef(this, picks, 'date');
      return {
        name: `${labelOf(picks.measure, 'Measure')} YTD`,
        expression: `TOTALYTD(${m}, ${d})`,
      };
    },
  },
  {
    key: 'yoy',
    title: 'Year-over-year %',
    caption: 'Percent change versus the same period in the prior year.',
    icon: 'ArrowTrendingLines',
    fields: [MEASURE_FIELD, DATE_FIELD],
    generate(picks) {
      const m = requireRef(this, picks, 'measure');
      const d = requireRef(this, picks, 'date');
      return {
        name: `${labelOf(picks.measure, 'Measure')} YoY %`,
        expression:
          `VAR __Prior = CALCULATE(${m}, SAMEPERIODLASTYEAR(${d}))\n` +
          `RETURN DIVIDE(${m} - __Prior, __Prior)`,
      };
    },
  },
  {
    key: 'runningTotal',
    title: 'Running total',
    caption: 'Cumulative total of the base measure across the date axis.',
    icon: 'DataArea',
    fields: [MEASURE_FIELD, DATE_FIELD],
    generate(picks) {
      const m = requireRef(this, picks, 'measure');
      const d = requireRef(this, picks, 'date');
      return {
        name: `${labelOf(picks.measure, 'Measure')} Running Total`,
        expression: `CALCULATE(${m}, FILTER(ALLSELECTED(${d}), ${d} <= MAX(${d})))`,
      };
    },
  },
  {
    key: 'perCategoryAverage',
    title: 'Average per category',
    caption: 'Average of the base measure evaluated over each distinct category value.',
    icon: 'TextBulletListSquare',
    fields: [MEASURE_FIELD, CATEGORY_FIELD],
    generate(picks) {
      const m = requireRef(this, picks, 'measure');
      const c = requireRef(this, picks, 'category');
      return {
        name: `Average ${labelOf(picks.measure, 'Measure')} per ${labelOf(picks.category, 'Category')}`,
        expression: `AVERAGEX(VALUES(${c}), ${m})`,
      };
    },
  },
  {
    key: 'percentOfTotal',
    title: '% of total',
    caption: 'The base measure as a share of its total across all selected categories.',
    icon: 'DataPie',
    fields: [MEASURE_FIELD, CATEGORY_FIELD],
    generate(picks) {
      const m = requireRef(this, picks, 'measure');
      const c = requireRef(this, picks, 'category');
      return {
        name: `${labelOf(picks.measure, 'Measure')} % of Total`,
        expression: `DIVIDE(${m}, CALCULATE(${m}, ALLSELECTED(${c})))`,
      };
    },
  },
  {
    key: 'rank',
    title: 'Rank by category',
    caption: 'Dense descending rank of each category by the base measure.',
    icon: 'NumberSymbol',
    fields: [MEASURE_FIELD, CATEGORY_FIELD],
    generate(picks) {
      const m = requireRef(this, picks, 'measure');
      const c = requireRef(this, picks, 'category');
      return {
        name: `${labelOf(picks.measure, 'Measure')} Rank by ${labelOf(picks.category, 'Category')}`,
        expression: `RANKX(ALLSELECTED(${c}), ${m}, , DESC, Dense)`,
      };
    },
  },
  {
    key: 'starRating',
    title: 'Star rating',
    caption: 'Renders the base measure as filled/empty star glyphs (default out of 5).',
    icon: 'Star',
    fields: [{ key: 'measure', label: 'Rating measure', kind: 'measure', hint: 'A value between 0 and the max.' }],
    generate(picks, options) {
      const m = requireRef(this, picks, 'measure');
      const max = resolveMaxRating(options);
      return {
        name: `${labelOf(picks.measure, 'Measure')} Stars`,
        expression:
          `VAR __Max = ${max}\n` +
          `VAR __Rating = MAX(0, MIN(__Max, ROUND(${m}, 0)))\n` +
          `RETURN REPT(UNICHAR(9733), __Rating) & REPT(UNICHAR(9734), __Max - __Rating)`,
      };
    },
  },
];

/* ───────────────────────────── lookups ────────────────────────────── */

/** Look up a template by key (gallery → generator). */
export function getQuickMeasureTemplate(key: string): QuickMeasureTemplate | undefined {
  return quickMeasureTemplates.find((t) => t.key === key);
}

/**
 * True when every declared field of the template has a usable pick — the
 * gallery uses this to enable/disable the "Add measure" button without having
 * to call `generate` (which throws on incomplete input).
 */
export function isQuickMeasureComplete(
  template: QuickMeasureTemplate,
  picks: QuickMeasurePicks,
): boolean {
  return template.fields.every((f) => !!refOf(picks[f.key]));
}
