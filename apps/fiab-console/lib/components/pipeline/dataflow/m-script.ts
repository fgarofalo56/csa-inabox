/**
 * Power Query (M) script manipulation — pure, dependency-free helpers that
 * back the Power Query Online-parity authoring surface (PowerQueryHost).
 *
 * A Dataflow Gen2 mashup is a `section` of `shared <Name> = let … in …;`
 * query declarations. Each query body is a `let`-block of named *applied
 * steps* (`StepName = <expr>`) terminated by `in <result>`. These helpers
 * parse that structure, edit individual steps, append ribbon transforms, and
 * regenerate the M text — the M stays the single source of truth that Save
 * PUTs to Cosmos and Run compiles into an ADF WranglingDataFlow.
 *
 * No M interpreter is involved: every operation is balanced-delimiter-aware
 * string manipulation, so it round-trips authored M faithfully.
 */

// Type-only import (fully erased at compile — keeps this module pure and
// runtime-dependency-free). `SqlDialect` is the shared identifier-quoting /
// row-cap contract owned by `wells-to-sql.ts`; `foldAppliedStepsToSql` targets
// the SAME dialect set so a folded transform quotes identifiers exactly like the
// wells→SQL compiler the report `/query` route already runs.
import type { SqlDialect } from '../../../azure/wells-to-sql';

export interface AppliedStep {
  /** Step (let-binding) name, e.g. `Source`, `Filtered Rows`. */
  name: string;
  /** The M expression after `=`. */
  expr: string;
}

export interface ParsedQuery {
  name: string;
  steps: AppliedStep[];
  /** The `in <result>` identifier (usually the last step's name). */
  result: string;
}

/**
 * Parse `shared <Name> = … ;` query declarations out of an M section. Pure
 * (no client deps) so both the authoring UI and the server run route share it.
 */
export function parseSharedQueries(m: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /shared\s+([A-Za-z_#"][^\s=]*)\s*=\s*([\s\S]*?);(?=\s*(?:shared\b|section\b|$))/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m)) !== null) {
    const name = mt[1].replace(/^#?"?|"?$/g, '');
    out.push({ name, body: mt[2].trim() });
  }
  return out;
}

/**
 * Split `text` on a top-level `sep` character, ignoring separators nested
 * inside (), {}, [] or string/quoted-identifier literals.
 */
export function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let buf = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      buf += ch;
      if (ch === '"') {
        // Escaped quote inside an M string is "" — consume the next quote.
        if (text[i + 1] === '"') { buf += text[i + 1]; i += 1; }
        else inString = false;
      }
      continue;
    }
    if (ch === '"') { inString = true; buf += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth += 1; buf += ch; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth -= 1; buf += ch; continue; }
    if (ch === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function stripStepName(raw: string): string {
  // Step names can be quoted identifiers: #"My Step".
  return raw.trim().replace(/^#"/, '').replace(/"$/, '').replace(/^#/, '').trim();
}

/** Quote a step name as an M identifier when it contains non-identifier chars. */
export function quoteStepName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `#"${name.replace(/"/g, '""')}"`;
}

/**
 * Rename an identifier (query or applied-step name) everywhere in `text`,
 * handling both bare (`Foo`) and quoted (`#"Foo Bar"`) forms. Used to keep
 * downstream step/query references intact when the user renames.
 */
export function renameIdentifier(text: string, oldName: string, newName: string): string {
  if (!oldName || oldName === newName) return text;
  const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = text.replace(new RegExp(`#"${esc}"`, 'g'), quoteStepName(newName));
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(oldName)) {
    out = out.replace(new RegExp(`\\b${esc}\\b`, 'g'), () => quoteStepName(newName));
  }
  return out;
}

/** Parse a query `let … in …` body into applied steps + result. */
export function parseLetBody(body: string): { steps: AppliedStep[]; result: string } {
  const m = body.match(/^\s*let\b([\s\S]*)\bin\b([\s\S]*)$/);
  if (!m) {
    // Not a let-block — treat the whole body as a single anonymous step.
    return { steps: [{ name: 'Source', expr: body.trim() }], result: 'Source' };
  }
  const bindings = splitTopLevel(m[1], ',');
  const steps: AppliedStep[] = [];
  for (const b of bindings) {
    const eq = b.indexOf('=');
    if (eq < 0) continue;
    const name = stripStepName(b.slice(0, eq));
    const expr = b.slice(eq + 1).trim();
    if (name) steps.push({ name, expr });
  }
  return { steps, result: stripStepName(m[2]) };
}

/** Rebuild a `let … in …` body from applied steps + result. */
export function buildLetBody(steps: AppliedStep[], result: string): string {
  if (steps.length === 0) return `let\n    Source = #table({}, {})\nin\n    Source`;
  const lines = steps.map((s) => `    ${quoteStepName(s.name)} = ${s.expr}`).join(',\n');
  const res = result && steps.some((s) => s.name === result) ? result : steps[steps.length - 1].name;
  return `let\n${lines}\nin\n    ${quoteStepName(res)}`;
}

/**
 * Replace one query's body inside the full M section text. Falls back to
 * appending a fresh `shared <name> = <body>;` when the query is not present.
 */
export function setQueryBody(mScript: string, queryName: string, newBody: string): string {
  const re = new RegExp(
    `(shared\\s+#?"?${queryName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"?\\s*=\\s*)([\\s\\S]*?)(;)(?=\\s*(?:shared\\b|section\\b|$))`,
  );
  if (re.test(mScript)) {
    return mScript.replace(re, (_full, head: string, _old: string, tail: string) => `${head}${newBody}${tail}`);
  }
  let next = mScript;
  if (!/^\s*section\s/m.test(next)) next = `section Section1;\n${next}`;
  return `${next.replace(/\s*$/, '')}\nshared ${queryName} = ${newBody};\n`;
}

/**
 * A source column offered to the column-aware ribbon transforms (and the
 * structured dialogs). Mirrors the host's `TransformColumn` (`{name, dataType?}`)
 * so a host that knows the active query's bound schema can hand its REAL columns
 * to `appendStep`; the emitted M then binds real column names instead of the
 * `col1`/`col2` placeholders. Structurally identical to the host type, so a
 * `TransformColumn[]` from either module flows through unchanged.
 */
export interface TransformColumn {
  name: string;
  dataType?: string;
}

/** An M string literal for a column name (doubling embedded quotes): `"Name"`. */
function mStringLiteral(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * An M record field-access selector — `[Name]` for an identifier-safe column,
 * `[#"Name with space"]` otherwise. Folds via `foldOperand`/`foldScalar`, which
 * accept both forms.
 */
function mFieldAccess(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? `[${name}]`
    : `[#"${name.replace(/"/g, '""')}"]`;
}

/**
 * The REAL column name at `index`, or the placeholder `fallback` when the host
 * supplied no schema (or too few columns). This is the single seam that makes
 * every ribbon transform column-aware: with a bound schema the default-append
 * binds a real column (so the folded SQL hits an existing column instead of a
 * phantom `col1`); without one it preserves today's `col1`/`col2` placeholder so
 * the dataflow-editor mount — which never passes columns — is byte-unchanged.
 */
function colAt(columns: readonly TransformColumn[] | undefined, index: number, fallback: string): string {
  return columns?.[index]?.name ?? fallback;
}

/** A ribbon transform: appends a new applied step referencing the prior step. */
export interface RibbonTransform {
  key: string;
  label: string;
  /** Ribbon tab the button lives on. */
  tab: 'home' | 'transform' | 'addColumn';
  /** Default new step name. */
  stepName: string;
  /**
   * Build the M expression given the name of the step it chains from. When the
   * host knows the active query's schema it passes the real `columns`, so the
   * emitted M binds REAL column names (the structured dialog refines further);
   * absent ⇒ the `col1`/`col2` placeholder fallback (dataflow editor / no schema).
   */
  expr: (prevStep: string, columns?: readonly TransformColumn[]) => string;
  /**
   * Whether `foldAppliedStepsToSql` can translate this transform into a derived
   * SELECT (DirectQuery query-folding). DEFAULT `true` for the simple row/column
   * transforms. Explicitly `false` for transforms whose semantics can't be
   * expressed as static SQL over the base relation (transpose, pivot — needs the
   * runtime distinct set, windowed fill, JSON/XML parsing, examples-heuristics,
   * joins/append). A `false` step ⇒ DirectQuery surfaces an HONEST gate ("switch
   * this query to Import"); the Import path still materializes the FULL M via the
   * Spark/wrangling Delta cache, so the transform always works somewhere.
   */
  foldable?: boolean;
}

/**
 * Power Query Online ribbon transforms, grouped by tab. Each appends a real M
 * function call chaining off the previous applied step — the exact mapping the
 * ADF / Fabric PQO ribbon produces.
 */
export const RIBBON_TRANSFORMS: RibbonTransform[] = [
  // ---- Home ----
  { key: 'chooseColumns', label: 'Choose columns', tab: 'home', stepName: 'Chosen Columns',
    expr: (p, c) => `Table.SelectColumns(${quoteStepName(p)}, {${mStringLiteral(colAt(c, 0, 'col1'))}})`, foldable: true },
  { key: 'removeColumns', label: 'Remove columns', tab: 'home', stepName: 'Removed Columns',
    expr: (p, c) => `Table.RemoveColumns(${quoteStepName(p)}, {${mStringLiteral(colAt(c, 0, 'col1'))}})`, foldable: true },
  { key: 'keepRows', label: 'Keep top rows', tab: 'home', stepName: 'Kept First Rows',
    expr: (p) => `Table.FirstN(${quoteStepName(p)}, 100)`, foldable: true },
  { key: 'removeDuplicates', label: 'Remove duplicates', tab: 'home', stepName: 'Removed Duplicates',
    expr: (p) => `Table.Distinct(${quoteStepName(p)})`, foldable: true },
  { key: 'useFirstRowHeaders', label: 'Use first row as headers', tab: 'home', stepName: 'Promoted Headers',
    expr: (p) => `Table.PromoteHeaders(${quoteStepName(p)}, [PromoteAllScalars=true])`, foldable: false },
  { key: 'groupBy', label: 'Group by', tab: 'home', stepName: 'Grouped Rows',
    expr: (p, c) => `Table.Group(${quoteStepName(p)}, {${mStringLiteral(colAt(c, 0, 'col1'))}}, {{"Count", each Table.RowCount(_), Int64.Type}})`, foldable: true },
  // ---- Home (Wave 4) ----
  { key: 'removeBottomRows', label: 'Remove bottom rows', tab: 'home', stepName: 'Removed Bottom Rows',
    expr: (p) => `Table.RemoveLastN(${quoteStepName(p)}, 1)`, foldable: false },
  { key: 'keepBottomRows', label: 'Keep bottom rows', tab: 'home', stepName: 'Kept Bottom Rows',
    expr: (p) => `Table.LastN(${quoteStepName(p)}, 1)`, foldable: false },
  { key: 'removeBlankRows', label: 'Remove blank rows', tab: 'home', stepName: 'Removed Blank Rows',
    expr: (p) => `Table.SelectRows(${quoteStepName(p)}, each not List.IsEmpty(List.RemoveMatchingItems(Record.FieldValues(_), {"", null})))`, foldable: false },
  { key: 'removeAlternateRows', label: 'Remove alternate rows', tab: 'home', stepName: 'Removed Alternate Rows',
    expr: (p) => `Table.AlternateRows(${quoteStepName(p)}, 0, 1, 1)`, foldable: false },
  { key: 'groupByMulti', label: 'Group by (advanced)', tab: 'home', stepName: 'Grouped Rows',
    expr: (p, c) => `Table.Group(${quoteStepName(p)}, {${mStringLiteral(colAt(c, 0, 'col1'))}}, {{"Count", each Table.RowCount(_), Int64.Type}, {"Sum", each List.Sum(${mFieldAccess(colAt(c, 1, 'col2'))}), type nullable number}})`, foldable: true },
  // ---- Transform ----
  { key: 'filterRows', label: 'Filter rows', tab: 'transform', stepName: 'Filtered Rows',
    expr: (p, c) => `Table.SelectRows(${quoteStepName(p)}, each ${mFieldAccess(colAt(c, 0, 'col1'))} <> null)`, foldable: true },
  { key: 'sortRows', label: 'Sort', tab: 'transform', stepName: 'Sorted Rows',
    expr: (p, c) => `Table.Sort(${quoteStepName(p)}, {{${mStringLiteral(colAt(c, 0, 'col1'))}, Order.Ascending}})`, foldable: true },
  { key: 'renameColumns', label: 'Rename columns', tab: 'transform', stepName: 'Renamed Columns',
    expr: (p, c) => `Table.RenameColumns(${quoteStepName(p)}, {{${mStringLiteral(colAt(c, 0, 'col1'))}, "newName"}})`, foldable: true },
  { key: 'reorderColumns', label: 'Reorder columns', tab: 'transform', stepName: 'Reordered Columns',
    expr: (p, c) => `Table.ReorderColumns(${quoteStepName(p)}, {${mStringLiteral(colAt(c, 0, 'col1'))}})`, foldable: true },
  { key: 'changeType', label: 'Change type', tab: 'transform', stepName: 'Changed Type',
    expr: (p, c) => `Table.TransformColumnTypes(${quoteStepName(p)}, {{${mStringLiteral(colAt(c, 0, 'col1'))}, type text}})`, foldable: true },
  { key: 'mergeQueries', label: 'Merge queries', tab: 'transform', stepName: 'Merged Queries',
    expr: (p, c) => `Table.NestedJoin(${quoteStepName(p)}, {${mStringLiteral(colAt(c, 0, 'key'))}}, RightQuery, {"key"}, "joined", JoinKind.Inner)`, foldable: false },
  { key: 'appendQueries', label: 'Append queries', tab: 'transform', stepName: 'Appended Query',
    expr: (p) => `Table.Combine({${quoteStepName(p)}, SecondQuery})`, foldable: false },
  // ---- Transform (Wave 4) ----
  { key: 'splitColumn', label: 'Split column', tab: 'transform', stepName: 'Split Column by Delimiter',
    expr: (p, c) => { const c0 = colAt(c, 0, 'col1'); return `Table.SplitColumn(${quoteStepName(p)}, ${mStringLiteral(c0)}, Splitter.SplitTextByDelimiter(",", QuoteStyle.Csv), {${mStringLiteral(`${c0}.1`)}, ${mStringLiteral(`${c0}.2`)}})`; }, foldable: false },
  { key: 'mergeColumns', label: 'Merge columns', tab: 'transform', stepName: 'Merged Columns',
    expr: (p, c) => `Table.CombineColumns(${quoteStepName(p)}, {${mStringLiteral(colAt(c, 0, 'col1'))}, ${mStringLiteral(colAt(c, 1, 'col2'))}}, Combiner.CombineTextByDelimiter(",", QuoteStyle.None), "Merged")`, foldable: false },
  { key: 'replaceValues', label: 'Replace values', tab: 'transform', stepName: 'Replaced Value',
    expr: (p, c) => `Table.ReplaceValue(${quoteStepName(p)}, "old", "new", Replacer.ReplaceText, {${mStringLiteral(colAt(c, 0, 'col1'))}})`, foldable: true },
  { key: 'replaceErrors', label: 'Replace errors', tab: 'transform', stepName: 'Replaced Errors',
    expr: (p, c) => `Table.ReplaceErrorValues(${quoteStepName(p)}, {{${mStringLiteral(colAt(c, 0, 'col1'))}, null}})`, foldable: false },
  { key: 'pivotColumn', label: 'Pivot column', tab: 'transform', stepName: 'Pivoted Column',
    expr: (p, c) => { const pc = colAt(c, 1, 'col2'); const vc = colAt(c, 2, 'col3'); return `Table.Pivot(${quoteStepName(p)}, List.Distinct(${quoteStepName(p)}${mFieldAccess(pc)}), ${mStringLiteral(pc)}, ${mStringLiteral(vc)}, List.Sum)`; }, foldable: false },
  { key: 'unpivotColumns', label: 'Unpivot columns', tab: 'transform', stepName: 'Unpivoted Columns',
    expr: (p, c) => `Table.Unpivot(${quoteStepName(p)}, {${mStringLiteral(colAt(c, 0, 'col1'))}, ${mStringLiteral(colAt(c, 1, 'col2'))}}, "Attribute", "Value")`, foldable: false },
  { key: 'unpivotOtherColumns', label: 'Unpivot other columns', tab: 'transform', stepName: 'Unpivoted Other Columns',
    expr: (p, c) => `Table.UnpivotOtherColumns(${quoteStepName(p)}, {${mStringLiteral(colAt(c, 0, 'col1'))}}, "Attribute", "Value")`, foldable: false },
  { key: 'unpivotSelectedColumns', label: 'Unpivot only selected columns', tab: 'transform', stepName: 'Unpivoted Only Selected Columns',
    expr: (p, c) => `Table.Unpivot(${quoteStepName(p)}, {${mStringLiteral(colAt(c, 0, 'col1'))}}, "Attribute", "Value")`, foldable: false },
  { key: 'transpose', label: 'Transpose', tab: 'transform', stepName: 'Transposed Table',
    expr: (p) => `Table.Transpose(${quoteStepName(p)})`, foldable: false },
  { key: 'fillDown', label: 'Fill down', tab: 'transform', stepName: 'Filled Down',
    expr: (p, c) => `Table.FillDown(${quoteStepName(p)}, {${mStringLiteral(colAt(c, 0, 'col1'))}})`, foldable: false },
  { key: 'fillUp', label: 'Fill up', tab: 'transform', stepName: 'Filled Up',
    expr: (p, c) => `Table.FillUp(${quoteStepName(p)}, {${mStringLiteral(colAt(c, 0, 'col1'))}})`, foldable: false },
  { key: 'extractText', label: 'Extract', tab: 'transform', stepName: 'Extracted First Characters',
    expr: (p, c) => `Table.TransformColumns(${quoteStepName(p)}, {{${mStringLiteral(colAt(c, 0, 'col1'))}, each Text.Start(_, 1), type text}})`, foldable: true },
  { key: 'formatText', label: 'Format', tab: 'transform', stepName: 'Uppercased Text',
    expr: (p, c) => `Table.TransformColumns(${quoteStepName(p)}, {{${mStringLiteral(colAt(c, 0, 'col1'))}, Text.Upper, type text}})`, foldable: true },
  { key: 'reverseRows', label: 'Reverse rows', tab: 'transform', stepName: 'Reversed Rows',
    expr: (p) => `Table.ReverseRows(${quoteStepName(p)})`, foldable: false },
  // ---- Add column ----
  { key: 'customColumn', label: 'Custom column', tab: 'addColumn', stepName: 'Added Custom',
    expr: (p) => `Table.AddColumn(${quoteStepName(p)}, "Custom", each null)`, foldable: true },
  { key: 'indexColumn', label: 'Index column', tab: 'addColumn', stepName: 'Added Index',
    expr: (p) => `Table.AddIndexColumn(${quoteStepName(p)}, "Index", 0, 1, Int64.Type)`, foldable: false },
  { key: 'duplicateColumn', label: 'Duplicate column', tab: 'addColumn', stepName: 'Duplicated Column',
    expr: (p, c) => { const c0 = colAt(c, 0, 'col1'); return `Table.DuplicateColumn(${quoteStepName(p)}, ${mStringLiteral(c0)}, ${mStringLiteral(`${c0} - Copy`)})`; }, foldable: false },
  // ---- Add column (Wave 4) ----
  { key: 'conditionalColumn', label: 'Conditional column', tab: 'addColumn', stepName: 'Added Conditional Column',
    expr: (p, c) => { const f = mFieldAccess(colAt(c, 0, 'col1')); return `Table.AddColumn(${quoteStepName(p)}, "Custom", each if ${f} = null then "n/a" else ${f})`; }, foldable: true },
  { key: 'columnFromExamples', label: 'Column from examples', tab: 'addColumn', stepName: 'Added Column From Examples',
    expr: (p) => `Table.AddColumn(${quoteStepName(p)}, "From Examples", each null)`, foldable: false },
  { key: 'parseJson', label: 'Parse JSON', tab: 'addColumn', stepName: 'Parsed JSON',
    expr: (p, c) => `Table.TransformColumns(${quoteStepName(p)}, {{${mStringLiteral(colAt(c, 0, 'col1'))}, Json.Document}})`, foldable: false },
  { key: 'parseXml', label: 'Parse XML', tab: 'addColumn', stepName: 'Parsed XML',
    expr: (p, c) => `Table.TransformColumns(${quoteStepName(p)}, {{${mStringLiteral(colAt(c, 0, 'col1'))}, Xml.Tables}})`, foldable: false },
];

/**
 * Append a ribbon transform as a new applied step; returns the updated body.
 * When the caller knows the active query's schema it passes `columns`, so the
 * emitted M binds REAL column names (the report Transform host's column-aware
 * path); omit `columns` and the transform falls back to its `col1`/`col2`
 * placeholder (the dataflow editor / dialog-emitted specs that already baked the
 * real columns into their `expr`).
 */
export function appendStep(body: string, t: RibbonTransform, columns?: readonly TransformColumn[]): string {
  const { steps } = parseLetBody(body);
  const prev = steps.length ? steps[steps.length - 1].name : 'Source';
  // Disambiguate the step name if it already exists.
  let name = t.stepName;
  let n = 1;
  const existing = new Set(steps.map((s) => s.name));
  while (existing.has(name)) { n += 1; name = `${t.stepName} ${n}`; }
  const nextSteps = [...steps, { name, expr: t.expr(prev, columns) }];
  return buildLetBody(nextSteps, name);
}

/**
 * The persisted output destination for a Dataflow Gen2. Saved to the Cosmos
 * item's `state.sink`; the run route compiles it into an ADF dataset wired as
 * the WranglingDataFlow sink. ADLS → Parquet/CSV; Azure SQL → table sink.
 */
export interface DataflowSink {
  type: 'adls' | 'azuresql';
  /** Output query whose result is written (defaults to the last query). */
  query?: string;
  // ADLS Gen2
  container?: 'bronze' | 'silver' | 'gold' | 'landing' | string;
  path?: string;
  format?: 'parquet' | 'csv';
  // Azure SQL
  linkedService?: string;
  schema?: string;
  table?: string;
  writeMode?: 'append' | 'overwrite';
}

// ════════════════════════════════════════════════════════════════════════════
// WAVE 4 — query folding: applied-step M → nested derived SELECTs (DirectQuery)
// ════════════════════════════════════════════════════════════════════════════
//
// `foldAppliedStepsToSql` is the Azure-native equivalent of Power Query's
// "query folding": it walks the applied steps the Transform host authored (every
// one appended via `appendStep`, never raw-typed M — no-freeform-config) and
// translates the FOLDABLE subset into nested, dialect-quoted derived SELECTs over
// the resolver-supplied base relation. The report `/query`, `/fields`,
// `/native-query`, and `/profile` routes wrap the RESOLVED relation's FROM in
// this folded SELECT before introspect/compile, so a DirectQuery transform shapes
// REAL rows on Synapse / the bound connector dialect (no-vaporware,
// no-fabric-dependency — never a Fabric/Power BI host).
//
// On the FIRST step it cannot translate (parse JSON/XML, transpose, pivot —
// needs the runtime distinct set, windowed fill, examples-heuristics, joins …) it
// returns `{ ok:false, unfoldableStep }` so the route surfaces the HONEST gate
// ("this step can't fold to SQL — switch this query to Import to materialize it
// via the dataflow run") instead of a silently wrong result. The Import path
// materializes the FULL M (foldable or not) via the proven Spark/wrangling Delta
// cache, so non-foldable steps still work there.
//
// Pure + dependency-free (only the erased `SqlDialect` TYPE is imported): the same
// function runs in the server routes and in the host's View-Native-Query preview.
// Identifiers are quoted per dialect; literal values that came from the structured
// dialogs are SQL-escaped — the user never types SQL (the M was authored through
// `appendStep`).

/** True for the row-cap dialects (no `TOP`; cap with a trailing `LIMIT n`). */
function isLimitDialect(d?: SqlDialect): boolean {
  return d === 'postgres' || d === 'mysql' || d === 'databricks-sql';
}

/**
 * Dialect-aware identifier quote — a LOCAL replica of `wells-to-sql.quoteIdent`
 * (kept local so this module stays runtime-dependency-free). Bracket dialects
 * (T-SQL / Synapse / generic SQL Server / undefined) → `[id]`; PostgreSQL →
 * `"id"`; MySQL / Databricks SQL → `` `id` ``. Identifiers only ever come from
 * the structured M (column/step names), never widening the injection surface.
 */
function foldQuoteIdent(name: string, dialect?: SqlDialect): string {
  switch (dialect) {
    case 'postgres':
      return `"${name.replace(/"/g, '""')}"`;
    case 'mysql':
    case 'databricks-sql':
      return '`' + name.replace(/`/g, '``') + '`';
    default:
      return `[${name.replace(/]/g, ']]')}]`;
  }
}

/** SQL single-quoted string literal (doubling embedded quotes). */
function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Parse a non-negative-ish integer token, or null. */
function parseIntToken(tok: string | undefined): number | null {
  if (tok == null) return null;
  const t = tok.trim();
  return /^-?\d+$/.test(t) ? parseInt(t, 10) : null;
}

/** A dialect row cap: `TOP n ` prefix for the T-SQL family, else `LIMIT n` suffix. */
function foldRowCap(d: SqlDialect | undefined, n: number): { prefix: string; suffix: string } {
  return isLimitDialect(d) ? { prefix: '', suffix: `LIMIT ${n}` } : { prefix: `TOP ${n} `, suffix: '' };
}

/** Strip a single fully-wrapping `( … )` pair (paren-balanced; strings ignored). */
function stripOuterParens(e: string): string {
  let t = e.trim();
  // Repeatedly peel a matched outer pair.
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i += 1) {
      const ch = t[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0 && i < t.length - 1) { wraps = false; break; }
      }
    }
    if (wraps && depth === 0) t = t.slice(1, -1).trim();
    else break;
  }
  return t;
}

/** Parse an M function call `Ns.Fn(arg0, arg1, …)` → fn name + top-level args. */
function parseMCall(expr: string): { fn: string; args: string[] } | null {
  const m = expr.trim().match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*\(([\s\S]*)\)$/);
  if (!m) return null;
  const inner = m[2].trim();
  const args = inner === '' ? [] : splitTopLevel(inner, ',').map((a) => a.trim());
  return { fn: m[1], args };
}

/** Parse an M string literal token `"…"` → its unescaped value, or null. */
function parseMString(tok: string): string | null {
  const t = tok.trim();
  const m = t.match(/^"((?:[^"]|"")*)"$/);
  return m ? m[1].replace(/""/g, '"') : null;
}

/** Parse an M list of string literals `{"a", "b"}` → string[], or null. */
function parseMStringList(tok: string | undefined): string[] | null {
  if (tok == null) return null;
  const t = tok.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  const inner = t.slice(1, -1).trim();
  if (inner === '') return [];
  const out: string[] = [];
  for (const part of splitTopLevel(inner, ',')) {
    const s = parseMString(part);
    if (s == null) return null;
    out.push(s);
  }
  return out;
}

/** Parse an M list-of-lists `{{a, b}, {c, d}}` → string[][] (raw element tokens). */
function parseMPairList(tok: string | undefined): string[][] | null {
  if (tok == null) return null;
  const t = tok.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  const inner = t.slice(1, -1).trim();
  if (inner === '') return [];
  const out: string[][] = [];
  for (const part of splitTopLevel(inner, ',')) {
    const pt = part.trim();
    if (!pt.startsWith('{') || !pt.endsWith('}')) return null;
    out.push(splitTopLevel(pt.slice(1, -1), ',').map((x) => x.trim()));
  }
  return out;
}

/** Index of a whole-word keyword at top level (depth 0, outside strings), or -1. */
function findTopLevelWord(text: string, word: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '"') { if (text[i + 1] === '"') { i += 1; continue; } inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth += 1; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth -= 1; continue; }
    if (depth === 0 && text.substr(i, word.length).toLowerCase() === word) {
      const before = i === 0 || /\s/.test(text[i - 1]);
      const afterCh = text[i + word.length];
      const after = afterCh === undefined || /\s/.test(afterCh);
      if (before && after) return i;
    }
  }
  return -1;
}

/** Index of a literal operator at top level (outside delimiters/strings), or -1. */
function findTopLevelOp(e: string, op: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < e.length; i += 1) {
    const ch = e[i];
    if (inString) {
      if (ch === '"') { if (e[i + 1] === '"') { i += 1; continue; } inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth += 1; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth -= 1; continue; }
    if (depth === 0 && e.substr(i, op.length) === op) return i;
  }
  return -1;
}

/** Split on a top-level ` <kw> ` boolean keyword (and / or), respecting nesting. */
function splitTopLevelKeyword(text: string, kw: string): string[] {
  const out: string[] = [];
  const k = ` ${kw} `;
  let depth = 0;
  let inString = false;
  let buf = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      buf += ch;
      if (ch === '"') { if (text[i + 1] === '"') { buf += '"'; i += 1; } else inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; buf += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth += 1; buf += ch; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth -= 1; buf += ch; continue; }
    if (depth === 0 && text.substr(i, k.length).toLowerCase() === k) {
      out.push(buf); buf = ''; i += k.length - 1; continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/** Translate a single M scalar operand (column ref / string / number / bool). */
function foldOperand(tok: string, d?: SqlDialect): string | null {
  const t = stripOuterParens(tok.trim());
  const col = t.match(/^\[\s*(?:#"([^"]*)"|([A-Za-z_][A-Za-z0-9_ .]*))\s*\]$/);
  if (col) return foldQuoteIdent((col[1] ?? col[2]).trim(), d);
  const s = parseMString(t);
  if (s != null) return sqlString(s);
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (t === 'true') return '1';
  if (t === 'false') return '0';
  return null;
}

/** Translate an M boolean predicate (the `each <expr>` body) to a SQL predicate. */
function foldPredicate(mExpr: string, d?: SqlDialect): string | null {
  let e = mExpr.trim();
  if (/^each\b/.test(e)) e = e.replace(/^each\b/, '').trim();
  return foldBool(e, d);
}

function foldBool(raw: string, d?: SqlDialect): string | null {
  const e = stripOuterParens(raw.trim());
  const orParts = splitTopLevelKeyword(e, 'or');
  if (orParts.length > 1) {
    const ps = orParts.map((p) => foldBool(p, d));
    if (ps.some((p) => p == null)) return null;
    return `(${ps.join(' OR ')})`;
  }
  const andParts = splitTopLevelKeyword(e, 'and');
  if (andParts.length > 1) {
    const ps = andParts.map((p) => foldBool(p, d));
    if (ps.some((p) => p == null)) return null;
    return `(${ps.join(' AND ')})`;
  }
  if (/^not\b/.test(e)) {
    const inner = foldBool(e.replace(/^not\b/, '').trim(), d);
    return inner ? `NOT (${inner})` : null;
  }
  return foldComparison(e, d);
}

function foldComparison(raw: string, d?: SqlDialect): string | null {
  const e = stripOuterParens(raw.trim());
  const ops: Array<[string, string]> = [['<>', '<>'], ['>=', '>='], ['<=', '<='], ['=', '='], ['>', '>'], ['<', '<']];
  for (const [mop, sop] of ops) {
    const idx = findTopLevelOp(e, mop);
    if (idx < 0) continue;
    const left = foldOperand(e.slice(0, idx), d);
    if (left == null) return null;
    const rightTok = e.slice(idx + mop.length).trim();
    if (rightTok === 'null') {
      if (sop === '=') return `${left} IS NULL`;
      if (sop === '<>') return `${left} IS NOT NULL`;
      return null;
    }
    const right = foldOperand(rightTok, d);
    return right == null ? null : `${left} ${sop} ${right}`;
  }
  return null;
}

/** Translate an M scalar value/arithmetic expression (AddColumn body) to SQL. */
function foldScalar(raw: string, d?: SqlDialect): string | null {
  const t = raw.trim();
  if (/^if\b/.test(t)) return foldConditional(t, d);
  let out = '';
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === '[') {
      const end = t.indexOf(']', i);
      if (end < 0) return null;
      const name = t.slice(i + 1, end).trim().replace(/^#"/, '').replace(/"$/, '');
      out += foldQuoteIdent(name, d);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      let closed = false;
      while (j < t.length) {
        if (t[j] === '"') {
          if (t[j + 1] === '"') { s += '"'; j += 2; continue; }
          j += 1; closed = true; break;
        }
        s += t[j]; j += 1;
      }
      if (!closed) return null;
      out += sqlString(s);
      i = j;
      continue;
    }
    if ('+-*/() '.includes(ch) || /[0-9.]/.test(ch)) { out += ch; i += 1; continue; }
    // Any letter / other token (function call, identifier, `&` concat, …) is
    // outside the literal/arith subset → not statically foldable.
    return null;
  }
  const trimmed = out.trim();
  return trimmed === '' ? null : trimmed;
}

/** Translate an M `if … then … else …` chain into a SQL CASE expression. */
function foldConditional(raw: string, d?: SqlDialect): string | null {
  let t = raw.trim();
  const whens: string[] = [];
  // Bounded loop over the if/else-if chain (depth guard; far beyond any real UI).
  for (let guard = 0; guard < 64; guard += 1) {
    const mIf = t.match(/^if\b([\s\S]*)$/);
    if (!mIf) return null;
    const rest = mIf[1];
    const thenIdx = findTopLevelWord(rest, 'then');
    if (thenIdx < 0) return null;
    const cond = foldBool(rest.slice(0, thenIdx).trim(), d);
    const afterThen = rest.slice(thenIdx + 4);
    const elseIdx = findTopLevelWord(afterThen, 'else');
    if (elseIdx < 0) return null;
    const thenVal = foldScalar(afterThen.slice(0, elseIdx).trim(), d);
    const elsePart = afterThen.slice(elseIdx + 4).trim();
    if (cond == null || thenVal == null) return null;
    whens.push(`WHEN ${cond} THEN ${thenVal}`);
    if (/^if\b/.test(elsePart)) { t = elsePart; continue; }
    const elseVal = foldScalar(elsePart, d);
    if (elseVal == null) return null;
    return `CASE ${whens.join(' ')} ELSE ${elseVal} END`;
  }
  return null;
}

/** Translate a `Table.Sort` order list `{{"col", Order.Ascending}, …}` → ORDER BY. */
function foldSortOrder(tok: string | undefined, d?: SqlDialect): string | null {
  const pairs = parseMPairList(tok);
  if (!pairs || !pairs.length) return null;
  const parts: string[] = [];
  for (const p of pairs) {
    const col = parseMString(p[0]);
    if (col == null) return null;
    const dir = (p[1] || '').includes('Descending') ? 'DESC' : 'ASC';
    parts.push(`${foldQuoteIdent(col, d)} ${dir}`);
  }
  return parts.join(', ');
}

/** Translate one `Table.Group` aggregate lambda (`each <Agg>`) → a SQL aggregate. */
function foldAggregate(body: string, d?: SqlDialect): string | null {
  let b = body.trim();
  if (/^each\b/.test(b)) b = b.replace(/^each\b/, '').trim();
  if (/^Table\.RowCount\s*\(\s*_\s*\)$/.test(b)) return 'COUNT(*)';
  const m = b.match(/^List\.(Sum|Average|Min|Max|Count)\s*\(\s*\[\s*(?:#"([^"]*)"|([^\]]+))\s*\]\s*\)$/);
  if (!m) return null;
  const fnMap: Record<string, string> = { Sum: 'SUM', Average: 'AVG', Min: 'MIN', Max: 'MAX', Count: 'COUNT' };
  const fn = fnMap[m[1]];
  if (!fn) return null;
  return `${fn}(${foldQuoteIdent((m[2] ?? m[3]).trim(), d)})`;
}

/** Translate a `Table.Group` aggregations list `{{"Out", each Fn(_), type}, …}`. */
function foldGroupAggs(tok: string | undefined, d?: SqlDialect): Array<{ name: string; expr: string }> | null {
  const groups = parseMPairList(tok);
  if (!groups) return null;
  const out: Array<{ name: string; expr: string }> = [];
  for (const g of groups) {
    if (g.length < 2) return null;
    const name = parseMString(g[0]);
    if (name == null) return null;
    const expr = foldAggregate(g[1], d);
    if (expr == null) return null;
    out.push({ name, expr });
  }
  return out;
}

/** Translate one `Table.TransformColumns` text op (`Text.Upper` / `each Text.X(_,…)`). */
function foldTextTransform(fnTok: string, col: string, d?: SqlDialect): string | null {
  const ident = foldQuoteIdent(col, d);
  let f = fnTok.trim();
  const each = f.match(/^each\b([\s\S]+)$/);
  if (each) f = each[1].trim();
  // Value-form (no args): Text.Upper / Text.Lower / Text.Trim.
  if (/^Text\.Upper$/.test(f)) return `UPPER(${ident})`;
  if (/^Text\.Lower$/.test(f)) return `LOWER(${ident})`;
  if (/^Text\.Trim$/.test(f)) return `LTRIM(RTRIM(${ident}))`;
  const call = f.match(/^Text\.([A-Za-z]+)\s*\(([\s\S]*)\)$/);
  if (!call) return null;
  const rest = splitTopLevel(call[2], ',').map((x) => x.trim()).slice(1); // drop the `_`
  switch (call[1]) {
    case 'Upper': return `UPPER(${ident})`;
    case 'Lower': return `LOWER(${ident})`;
    case 'Trim': return `LTRIM(RTRIM(${ident}))`;
    default: break;
  }
  // The remaining ops use T-SQL substring/charindex grammar; gate non-T-SQL.
  if (isLimitDialect(d)) return null;
  switch (call[1]) {
    case 'Start': { const n = parseIntToken(rest[0]); return n == null ? null : `SUBSTRING(${ident}, 1, ${n})`; }
    case 'End': { const n = parseIntToken(rest[0]); return n == null ? null : `RIGHT(${ident}, ${n})`; }
    case 'Range': {
      const s = parseIntToken(rest[0]);
      if (s == null) return null;
      const len = rest[1] != null ? parseIntToken(rest[1]) : null;
      return len == null
        ? `SUBSTRING(${ident}, ${s + 1}, LEN(${ident}))`
        : `SUBSTRING(${ident}, ${s + 1}, ${len})`;
    }
    case 'BeforeDelimiter': {
      const dl = parseMString(rest[0]);
      return dl == null ? null : `SUBSTRING(${ident}, 1, CHARINDEX(${sqlString(dl)}, ${ident}) - 1)`;
    }
    case 'AfterDelimiter': {
      const dl = parseMString(rest[0]);
      return dl == null ? null : `SUBSTRING(${ident}, CHARINDEX(${sqlString(dl)}, ${ident}) + 1, LEN(${ident}))`;
    }
    default: return null;
  }
}

/** Reorder a known column list by an M reorder list (unknown names appended). */
function foldReorder(cols: string[], order: string[] | null): string[] {
  if (!order) return cols;
  const remaining = new Map(cols.map((c) => [c.toLowerCase(), c]));
  const out: string[] = [];
  for (const o of order) {
    const c = remaining.get(o.toLowerCase());
    if (c) { out.push(c); remaining.delete(o.toLowerCase()); }
  }
  for (const c of cols) if (remaining.has(c.toLowerCase())) out.push(c);
  return out;
}

/** Result of folding one applied step: the new relation SQL + tracked column set. */
interface FoldLayer { sql: string; cols: string[] | null }

/**
 * Fold ONE applied step into a derived SELECT over `from` (`(<prevSql>) AS …`).
 * `cols` is the running projection (null = unknown; column-rewriting transforms
 * need it). Returns null when the concrete step can't be translated to static SQL
 * — the caller turns that into the honest `unfoldableStep` gate.
 */
function foldStep(
  call: { fn: string; args: string[] },
  from: string,
  cols: string[] | null,
  d?: SqlDialect,
): FoldLayer | null {
  const { fn, args } = call;
  const Q = (n: string): string => foldQuoteIdent(n, d);
  switch (fn) {
    case 'Table.SelectColumns': {
      const list = parseMStringList(args[1]);
      if (!list || !list.length) return null;
      return { sql: `SELECT ${list.map(Q).join(', ')} FROM ${from}`, cols: list };
    }
    case 'Table.RemoveColumns': {
      const rem = parseMStringList(args[1]);
      if (!rem) return null;
      if (cols) {
        const lower = new Set(rem.map((r) => r.toLowerCase()));
        const keep = cols.filter((c) => !lower.has(c.toLowerCase()));
        if (!keep.length) return null;
        return { sql: `SELECT ${keep.map(Q).join(', ')} FROM ${from}`, cols: keep };
      }
      // Databricks SQL can drop by name without the full list; others can't.
      if (d === 'databricks-sql') {
        return { sql: `SELECT * EXCEPT (${rem.map(Q).join(', ')}) FROM ${from}`, cols: null };
      }
      return null;
    }
    case 'Table.RenameColumns': {
      const pairs = parseMPairList(args[1]);
      if (!pairs || !cols) return null;
      const map = new Map<string, string>();
      for (const p of pairs) {
        const o = parseMString(p[0]);
        const n = parseMString(p[1]);
        if (o == null || n == null) return null;
        map.set(o.toLowerCase(), n);
      }
      const proj = cols.map((c) => {
        const nn = map.get(c.toLowerCase());
        return nn ? `${Q(c)} AS ${Q(nn)}` : Q(c);
      });
      return { sql: `SELECT ${proj.join(', ')} FROM ${from}`, cols: cols.map((c) => map.get(c.toLowerCase()) ?? c) };
    }
    case 'Table.ReorderColumns': {
      // Column order is irrelevant to by-name downstream access → pass through.
      return { sql: `SELECT * FROM ${from}`, cols: cols ? foldReorder(cols, parseMStringList(args[1])) : null };
    }
    case 'Table.TransformColumnTypes':
      // Type coercion is informational for the read path (the relation already
      // carries SQL types) → pass through.
      return { sql: `SELECT * FROM ${from}`, cols };
    case 'Table.Distinct': {
      if (args.length > 1) return null; // distinct-by-subset isn't plain SQL DISTINCT
      return { sql: `SELECT DISTINCT * FROM ${from}`, cols };
    }
    case 'Table.FirstN': {
      const n = parseIntToken(args[1]);
      if (n == null) return null;
      const cap = foldRowCap(d, n);
      return { sql: `SELECT ${cap.prefix}* FROM ${from}${cap.suffix ? `\n${cap.suffix}` : ''}`, cols };
    }
    case 'Table.SelectRows': {
      const pred = foldPredicate(args[1] ?? '', d);
      return pred ? { sql: `SELECT * FROM ${from} WHERE ${pred}`, cols } : null;
    }
    case 'Table.Sort': {
      const orderBy = foldSortOrder(args[1], d);
      if (!orderBy) return null;
      // ORDER BY inside a derived table needs a TOP guard on the T-SQL family.
      const top = isLimitDialect(d) ? '' : 'TOP 100 PERCENT ';
      return { sql: `SELECT ${top}* FROM ${from} ORDER BY ${orderBy}`, cols };
    }
    case 'Table.Group': {
      const keys = parseMStringList(args[1]);
      const aggs = foldGroupAggs(args[2], d);
      if (!keys || !aggs) return null;
      const sel = [...keys.map(Q), ...aggs.map((a) => `${a.expr} AS ${Q(a.name)}`)];
      const groupBy = keys.length ? `\nGROUP BY ${keys.map(Q).join(', ')}` : '';
      return { sql: `SELECT ${sel.join(', ')} FROM ${from}${groupBy}`, cols: [...keys, ...aggs.map((a) => a.name)] };
    }
    case 'Table.AddColumn': {
      const name = parseMString(args[1]);
      if (name == null) return null;
      const expr = foldScalar((args[2] ?? '').replace(/^each\b/, '').trim(), d);
      if (expr == null) return null;
      return { sql: `SELECT *, ${expr} AS ${Q(name)} FROM ${from}`, cols: cols ? [...cols, name] : null };
    }
    case 'Table.TransformColumns': {
      if (!cols) return null;
      const tlist = parseMPairList(args[1]);
      if (!tlist) return null;
      const rewrites = new Map<string, string>();
      for (const t of tlist) {
        const col = parseMString(t[0]);
        if (col == null) return null;
        const sqlExpr = foldTextTransform(t[1] ?? '', col, d);
        if (sqlExpr == null) return null;
        rewrites.set(col.toLowerCase(), sqlExpr);
      }
      const proj = cols.map((c) => {
        const e = rewrites.get(c.toLowerCase());
        return e ? `${e} AS ${Q(c)}` : Q(c);
      });
      return { sql: `SELECT ${proj.join(', ')} FROM ${from}`, cols };
    }
    case 'Table.ReplaceValue': {
      if (!cols) return null;
      const oldV = parseMString(args[1]);
      const newV = parseMString(args[2]);
      const tcols = parseMStringList(args[4]);
      if (oldV == null || newV == null || !tcols) return null;
      const isText = /ReplaceText/.test((args[3] ?? '').trim());
      const target = new Set(tcols.map((c) => c.toLowerCase()));
      const proj = cols.map((c) => {
        if (!target.has(c.toLowerCase())) return Q(c);
        const ident = Q(c);
        return isText
          ? `REPLACE(${ident}, ${sqlString(oldV)}, ${sqlString(newV)}) AS ${ident}`
          : `CASE WHEN ${ident} = ${sqlString(oldV)} THEN ${sqlString(newV)} ELSE ${ident} END AS ${ident}`;
      });
      return { sql: `SELECT ${proj.join(', ')} FROM ${from}`, cols };
    }
    default:
      // Transpose / Pivot / Unpivot* / SplitColumn / CombineColumns / FillUp /
      // FillDown / ReplaceErrorValues / Json.Document / Xml.Tables / ReverseRows /
      // AlternateRows / Skip / LastN / index / joins — not statically foldable.
      return null;
  }
}

/**
 * Fold a query's applied steps onto a base SELECT, producing nested derived
 * SELECTs (DirectQuery). The FIRST step (`Source`) is the opaque base relation —
 * substituted by `baseSelect` and skipped; every later step chains as
 * `SELECT … FROM (<prev>) AS _qN`. Returns the unfoldable step name on the first
 * step it can't translate (honest gate → "switch to Import"). Pure.
 *
 * @param baseSelect  Resolver-supplied read-only SELECT for the bound source.
 * @param mLetBody    The query's `let … in …` body (as authored via appendStep).
 * @param dialect     Target SQL dialect (default = T-SQL/Synapse).
 */
export function foldAppliedStepsToSql(
  baseSelect: string,
  mLetBody: string,
  dialect?: SqlDialect,
): { ok: true; sql: string } | { ok: false; unfoldableStep: string } {
  const { steps } = parseLetBody(mLetBody);
  let current = baseSelect.trim().replace(/;+\s*$/, '');
  let cols: string[] | null = null;
  for (let i = 1; i < steps.length; i += 1) {
    const step = steps[i];
    const call = parseMCall(step.expr);
    if (!call) return { ok: false, unfoldableStep: step.name };
    const from = `(${current}) AS ${foldQuoteIdent(`_q${i - 1}`, dialect)}`;
    const layer = foldStep(call, from, cols, dialect);
    if (!layer) return { ok: false, unfoldableStep: step.name };
    current = layer.sql;
    cols = layer.cols;
  }
  return { ok: true, sql: current };
}

