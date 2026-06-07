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

/** A ribbon transform: appends a new applied step referencing the prior step. */
export interface RibbonTransform {
  key: string;
  label: string;
  /** Ribbon tab the button lives on. */
  tab: 'home' | 'transform' | 'addColumn';
  /** Default new step name. */
  stepName: string;
  /** Build the M expression given the name of the step it chains from. */
  expr: (prevStep: string) => string;
}

/**
 * Power Query Online ribbon transforms, grouped by tab. Each appends a real M
 * function call chaining off the previous applied step — the exact mapping the
 * ADF / Fabric PQO ribbon produces.
 */
export const RIBBON_TRANSFORMS: RibbonTransform[] = [
  // ---- Home ----
  { key: 'chooseColumns', label: 'Choose columns', tab: 'home', stepName: 'Chosen Columns',
    expr: (p) => `Table.SelectColumns(${quoteStepName(p)}, {"col1"})` },
  { key: 'removeColumns', label: 'Remove columns', tab: 'home', stepName: 'Removed Columns',
    expr: (p) => `Table.RemoveColumns(${quoteStepName(p)}, {"col1"})` },
  { key: 'keepRows', label: 'Keep top rows', tab: 'home', stepName: 'Kept First Rows',
    expr: (p) => `Table.FirstN(${quoteStepName(p)}, 100)` },
  { key: 'removeDuplicates', label: 'Remove duplicates', tab: 'home', stepName: 'Removed Duplicates',
    expr: (p) => `Table.Distinct(${quoteStepName(p)})` },
  { key: 'useFirstRowHeaders', label: 'Use first row as headers', tab: 'home', stepName: 'Promoted Headers',
    expr: (p) => `Table.PromoteHeaders(${quoteStepName(p)}, [PromoteAllScalars=true])` },
  { key: 'groupBy', label: 'Group by', tab: 'home', stepName: 'Grouped Rows',
    expr: (p) => `Table.Group(${quoteStepName(p)}, {"col1"}, {{"Count", each Table.RowCount(_), Int64.Type}})` },
  // ---- Transform ----
  { key: 'filterRows', label: 'Filter rows', tab: 'transform', stepName: 'Filtered Rows',
    expr: (p) => `Table.SelectRows(${quoteStepName(p)}, each [col1] <> null)` },
  { key: 'sortRows', label: 'Sort', tab: 'transform', stepName: 'Sorted Rows',
    expr: (p) => `Table.Sort(${quoteStepName(p)}, {{"col1", Order.Ascending}})` },
  { key: 'renameColumns', label: 'Rename columns', tab: 'transform', stepName: 'Renamed Columns',
    expr: (p) => `Table.RenameColumns(${quoteStepName(p)}, {{"col1", "newName"}})` },
  { key: 'reorderColumns', label: 'Reorder columns', tab: 'transform', stepName: 'Reordered Columns',
    expr: (p) => `Table.ReorderColumns(${quoteStepName(p)}, {"col1"})` },
  { key: 'changeType', label: 'Change type', tab: 'transform', stepName: 'Changed Type',
    expr: (p) => `Table.TransformColumnTypes(${quoteStepName(p)}, {{"col1", type text}})` },
  { key: 'mergeQueries', label: 'Merge queries', tab: 'transform', stepName: 'Merged Queries',
    expr: (p) => `Table.NestedJoin(${quoteStepName(p)}, {"key"}, RightQuery, {"key"}, "joined", JoinKind.Inner)` },
  { key: 'appendQueries', label: 'Append queries', tab: 'transform', stepName: 'Appended Query',
    expr: (p) => `Table.Combine({${quoteStepName(p)}, SecondQuery})` },
  // ---- Add column ----
  { key: 'customColumn', label: 'Custom column', tab: 'addColumn', stepName: 'Added Custom',
    expr: (p) => `Table.AddColumn(${quoteStepName(p)}, "Custom", each null)` },
  { key: 'indexColumn', label: 'Index column', tab: 'addColumn', stepName: 'Added Index',
    expr: (p) => `Table.AddIndexColumn(${quoteStepName(p)}, "Index", 0, 1, Int64.Type)` },
  { key: 'duplicateColumn', label: 'Duplicate column', tab: 'addColumn', stepName: 'Duplicated Column',
    expr: (p) => `Table.DuplicateColumn(${quoteStepName(p)}, "col1", "col1 - Copy")` },
];

/** Append a ribbon transform as a new applied step; returns the updated body. */
export function appendStep(body: string, t: RibbonTransform): string {
  const { steps } = parseLetBody(body);
  const prev = steps.length ? steps[steps.length - 1].name : 'Source';
  // Disambiguate the step name if it already exists.
  let name = t.stepName;
  let n = 1;
  const existing = new Set(steps.map((s) => s.name));
  while (existing.has(name)) { n += 1; name = `${t.stepName} ${n}`; }
  const nextSteps = [...steps, { name, expr: t.expr(prev) }];
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

