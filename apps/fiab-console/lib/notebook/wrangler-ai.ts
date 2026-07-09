/**
 * Data Wrangler — AI-assist pure logic (FGC-16).
 *
 * The rule-based cleaning-suggestion generator + the AOAI-proposed-step
 * validator that back the Data Wrangler "AI assist" tab. Kept dependency-free
 * and side-effect-free so it is unit-testable and importable by both the BFF
 * route (server) and, if needed, the panel (client) — every function here is
 * pure.
 *
 * The suggestions and the NL-to-transform codegen both resolve to STRUCTURED
 * operations drawn from the closed Data Wrangler operation gallery
 * (WRANGLER_OPERATIONS) — never freeform code (loom_no_freeform_config). A
 * proposed step is only ever applied by appending it to the recipe, where the
 * REAL pandas host executes it and returns the live preview + the equivalent
 * pandas/PySpark code (no-vaporware). AOAI is used to RANK/EXPLAIN and to map a
 * natural-language request onto that same closed operation set — it never emits
 * arbitrary code that bypasses the real backend.
 *
 * No Microsoft Fabric dependency — grounded in Fabric's Data Wrangler operation
 * panel (https://learn.microsoft.com/fabric/data-science/data-wrangler-ai) but
 * executed entirely on the Azure-native pandas host.
 */

import { WRANGLER_OPERATIONS, type WranglerOp } from '@/lib/notebook/wrangler-operations';

/** One column's summary as returned by the wrangler host (`/preview`). */
export interface ColSummary {
  name: string;
  dtype: string;
  missing: number;
  unique: number;
}

/** A structured operation the recipe can execute (op id + its field params). */
export interface WranglerStep {
  op: string;
  [k: string]: unknown;
}

/** Category tags for grouping suggestion cards in the UI. */
export type SuggestionCategory = 'Missing' | 'Schema' | 'Text' | 'Rows' | 'Numeric';

/** One AI/rule cleaning suggestion — a titled, rationalised, applyable step. */
export interface WranglerSuggestion {
  /** Stable-ish id for React keys + de-dupe (op + target column/columns). */
  id: string;
  title: string;
  rationale: string;
  category: SuggestionCategory;
  /** The structured op appended to the recipe on Apply (executed for real). */
  step: WranglerStep;
  /** Where the suggestion came from — profile heuristics vs the AOAI ranker. */
  source: 'rule' | 'ai';
}

const OP_BY_ID = new Map<string, WranglerOp>(WRANGLER_OPERATIONS.map((o) => [o.op, o]));

/** pandas numeric dtype test (int8/16/32/64, float*, uint*, Int64 nullable…). */
export function isNumericDtype(dtype: string | undefined): boolean {
  return /^u?int|^float|^number|^Int\d|^Float\d/i.test((dtype || '').trim());
}

/** Read one column's values out of the sample rows (undefined-safe). */
export function columnValues(rows: Record<string, unknown>[], col: string): unknown[] {
  return rows.map((r) => r?.[col]);
}

/** Does the column's sample carry leading/trailing whitespace on any string? */
export function hasLeadingTrailingWhitespace(values: unknown[]): boolean {
  return values.some((v) => typeof v === 'string' && v.length > 0 && v !== v.trim());
}

/**
 * Do the non-null string values in the sample all parse as numbers? (A column
 * the host typed as `object` that is really numeric — a cast candidate.) Returns
 * false when there are no string values to judge.
 */
export function looksNumeric(values: unknown[]): boolean {
  let sawString = false;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'number') continue;
    if (typeof v !== 'string') return false;
    sawString = true;
    if (!/^-?\d*\.?\d+$/.test(v.trim())) return false;
  }
  return sawString;
}

/** Count duplicate rows in the sample (by JSON identity). */
export function duplicateRowCount(rows: Record<string, unknown>[]): number {
  const seen = new Set<string>();
  let dups = 0;
  for (const r of rows) {
    const key = JSON.stringify(r);
    if (seen.has(key)) dups += 1;
    else seen.add(key);
  }
  return dups;
}

/**
 * Rule-based cleaning suggestions from REAL column profiles (nulls / distinct /
 * dtype / whitespace / numeric-looking / constant / duplicates). Deterministic
 * and backend-free — this is the honest floor of value that renders even when
 * AOAI is not configured. Each suggestion carries a structured gallery step.
 */
export function buildRuleSuggestions(
  summary: ColSummary[],
  rows: Record<string, unknown>[],
  rowCount: number,
): WranglerSuggestion[] {
  const out: WranglerSuggestion[] = [];
  const total = rowCount > 0 ? rowCount : rows.length;

  for (const col of summary) {
    const values = columnValues(rows, col.name);

    // Missing values → fill (numeric: median; categorical: mode). When a large
    // share is missing, prefer dropping the affected rows instead.
    if (col.missing > 0) {
      const ratio = total > 0 ? col.missing / total : 0;
      if (ratio >= 0.4) {
        out.push({
          id: `drop_missing:${col.name}`,
          title: `Drop rows missing "${col.name}"`,
          rationale: `${col.missing} of ${total} rows (${Math.round(ratio * 100)}%) are missing "${col.name}" — too many to impute reliably.`,
          category: 'Missing',
          step: { op: 'drop_missing', columns: [col.name], how: 'any' },
          source: 'rule',
        });
      } else {
        const numeric = isNumericDtype(col.dtype);
        out.push({
          id: `fill_missing:${col.name}`,
          title: `Fill missing "${col.name}" with ${numeric ? 'median' : 'most frequent'}`,
          rationale: `${col.missing} missing value${col.missing === 1 ? '' : 's'} in "${col.name}" — impute with the column ${numeric ? 'median' : 'mode'} to keep the rows.`,
          category: 'Missing',
          step: { op: 'fill_missing', column: col.name, strategy: numeric ? 'median' : 'mode', value: '' },
          source: 'rule',
        });
      }
    }

    // object-typed but numeric-looking → cast to a numeric type.
    if (!isNumericDtype(col.dtype) && looksNumeric(values)) {
      const hasDecimal = values.some((v) => typeof v === 'string' && v.includes('.'));
      out.push({
        id: `cast_type:${col.name}`,
        title: `Convert "${col.name}" to ${hasDecimal ? 'float' : 'int'}`,
        rationale: `"${col.name}" is stored as text but every value is a number — cast it so numeric operations work.`,
        category: 'Schema',
        step: { op: 'cast_type', column: col.name, dtype: hasDecimal ? 'float' : 'int' },
        source: 'rule',
      });
    }

    // Leading/trailing whitespace → trim.
    if (hasLeadingTrailingWhitespace(values)) {
      out.push({
        id: `strip_whitespace:${col.name}`,
        title: `Trim whitespace in "${col.name}"`,
        rationale: `Some "${col.name}" values have leading or trailing spaces — trim them so joins and grouping match.`,
        category: 'Text',
        step: { op: 'strip_whitespace', column: col.name },
        source: 'rule',
      });
    }

    // Constant column (single distinct value) → drop.
    if (col.unique <= 1 && total > 1) {
      out.push({
        id: `drop_columns:${col.name}`,
        title: `Drop constant column "${col.name}"`,
        rationale: `"${col.name}" holds a single distinct value across the sample — it carries no signal.`,
        category: 'Schema',
        step: { op: 'drop_columns', columns: [col.name] },
        source: 'rule',
      });
    }
  }

  // Whole-row duplicates → dedupe.
  const dups = duplicateRowCount(rows);
  if (dups > 0) {
    out.push({
      id: 'drop_duplicates:*',
      title: 'Drop duplicate rows',
      rationale: `${dups} duplicate row${dups === 1 ? '' : 's'} in the sample — remove exact repeats.`,
      category: 'Rows',
      step: { op: 'drop_duplicates', columns: [] },
      source: 'rule',
    });
  }

  return out;
}

/** Result of validating a batch of proposed steps against the gallery. */
export interface StepValidation {
  valid: WranglerStep[];
  rejected: Array<{ step: unknown; reason: string }>;
}

/**
 * Validate AOAI-proposed steps against the closed operation gallery: the op
 * must exist; every `column` field must reference an existing column; every
 * `columns` entry must exist; `select` fields must use a declared option. This
 * is the guard that keeps the NL-to-transform path inside the same closed set
 * the operation gallery offers (no arbitrary/unknown op ever reaches the host).
 */
export function validateWranglerSteps(steps: unknown, columns: string[]): StepValidation {
  const colSet = new Set(columns);
  const valid: WranglerStep[] = [];
  const rejected: Array<{ step: unknown; reason: string }> = [];

  const list = Array.isArray(steps) ? steps : [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') {
      rejected.push({ step: raw, reason: 'not an object' });
      continue;
    }
    const step = raw as Record<string, unknown>;
    const opId = typeof step.op === 'string' ? step.op : '';
    const op = OP_BY_ID.get(opId);
    if (!op) {
      rejected.push({ step: raw, reason: `unknown operation "${opId}"` });
      continue;
    }

    let ok = true;
    let reason = '';
    for (const f of op.fields) {
      const v = step[f.name];
      if (f.type === 'column') {
        if (typeof v === 'string' && v && !colSet.has(v)) {
          ok = false; reason = `column "${v}" does not exist`; break;
        }
      } else if (f.type === 'columns') {
        if (Array.isArray(v)) {
          const bad = (v as unknown[]).find((c) => typeof c !== 'string' || !colSet.has(c));
          if (bad !== undefined) { ok = false; reason = `column "${String(bad)}" does not exist`; break; }
        }
      } else if (f.type === 'select') {
        if (typeof v === 'string' && v && f.options && !f.options.includes(v)) {
          ok = false; reason = `"${v}" is not a valid ${f.name}`; break;
        }
      }
    }

    if (!ok) { rejected.push({ step: raw, reason }); continue; }

    // Keep only the op + its declared fields (drop any stray keys the model added).
    const clean: WranglerStep = { op: opId };
    for (const f of op.fields) {
      if (step[f.name] !== undefined) clean[f.name] = step[f.name];
    }
    valid.push(clean);
  }

  return { valid, rejected };
}

/**
 * Compact machine-readable spec of the operation gallery for the AOAI system
 * prompt — the model must map the user's request onto exactly these ops/fields.
 * Kept terse (one line per op) to hold the prompt small.
 */
export function operationCatalogSpec(): string {
  return WRANGLER_OPERATIONS.map((o) => {
    const fields = o.fields
      .map((f) => {
        const opts = f.options ? `=${f.options.join('|')}` : '';
        return `${f.name}:${f.type}${opts}`;
      })
      .join(', ');
    return `- ${o.op} (${o.label}) — fields: ${fields || 'none'}`;
  }).join('\n');
}

/**
 * De-duplicate suggestions by id, keeping the first occurrence. Used to merge
 * rule suggestions with AOAI-proposed ones without showing the same op twice.
 */
export function dedupeSuggestions(list: WranglerSuggestion[]): WranglerSuggestion[] {
  const seen = new Set<string>();
  const out: WranglerSuggestion[] = [];
  for (const s of list) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}
