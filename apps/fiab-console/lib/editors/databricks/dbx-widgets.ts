/**
 * Databricks input widgets (R4-DBX-2).
 *
 * Parses `dbutils.widgets.{text,dropdown,combobox,multiselect}(...)` declarations
 * out of a notebook's cells so the editor can render an interactive widgets
 * strip above the cells — the first-party Databricks notebook widgets bar — and
 * feed the chosen values back into interactive runs (a REPL preamble that sets
 * each widget's value so `dbutils.widgets.get(name)` returns it) and into job
 * runs (`notebook_params`).
 *
 * Grounded in Microsoft Learn:
 *   https://learn.microsoft.com/azure/databricks/notebooks/widgets
 *
 * Widget signatures (positional):
 *   dbutils.widgets.text(name, defaultValue, label?)
 *   dbutils.widgets.dropdown(name, defaultValue, choices, label?)
 *   dbutils.widgets.combobox(name, defaultValue, choices, label?)
 *   dbutils.widgets.multiselect(name, defaultValue, choices, label?)
 *
 * SQL/Scala variants (`CREATE WIDGET`, `dbutils.widgets` in Scala) use the same
 * value semantics; this parser covers the Python + SQL `CREATE WIDGET` forms,
 * which are what the Loom editor round-trips.
 */

export type WidgetType = 'text' | 'dropdown' | 'combobox' | 'multiselect';

export interface WidgetSpec {
  name: string;
  type: WidgetType;
  defaultValue: string;
  /** Present for dropdown / combobox / multiselect. */
  choices?: string[];
  label?: string;
}

/** Pull a JS/py string literal (single or double quoted) or a `[...]` list. */
function stripQuotes(tok: string): string {
  const t = tok.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split a call's argument list at top-level commas (respecting [] and quotes). */
function splitArgs(argStr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < argStr.length; i++) {
    const ch = argStr[i];
    if (quote) {
      cur += ch;
      if (ch === quote && argStr[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') { depth++; cur += ch; continue; }
    if (ch === ']' || ch === ')') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function parseChoices(tok: string): string[] {
  const t = tok.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return [];
  return splitArgs(t.slice(1, -1)).map(stripQuotes).filter((c) => c !== '');
}

const PY_WIDGET_RE =
  /dbutils\.widgets\.(text|dropdown|combobox|multiselect)\s*\(([\s\S]*?)\)/g;

// SQL: CREATE WIDGET TEXT name DEFAULT 'v'  |  CREATE WIDGET DROPDOWN name DEFAULT 'v' CHOICES SELECT ...
const SQL_WIDGET_RE =
  /CREATE\s+WIDGET\s+(TEXT|DROPDOWN|COMBOBOX|MULTISELECT)\s+(\w+)\s+DEFAULT\s+('[^']*'|"[^"]*")/gi;

/**
 * Extract every widget declaration from the notebook's cell sources, in order,
 * de-duplicated by name (last declaration wins, matching a real notebook run).
 */
export function parseWidgets(sources: string[]): WidgetSpec[] {
  const byName = new Map<string, WidgetSpec>();
  for (const src of sources) {
    if (!src) continue;

    PY_WIDGET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PY_WIDGET_RE.exec(src))) {
      const type = m[1] as WidgetType;
      const args = splitArgs(m[2]);
      if (args.length < 2) continue;
      const name = stripQuotes(args[0]);
      if (!name) continue;
      const defaultValue = stripQuotes(args[1]);
      const spec: WidgetSpec = { name, type, defaultValue };
      if (type !== 'text') {
        spec.choices = parseChoices(args[2] ?? '');
        if (args[3]) spec.label = stripQuotes(args[3]);
      } else if (args[2]) {
        spec.label = stripQuotes(args[2]);
      }
      byName.set(name, spec);
    }

    SQL_WIDGET_RE.lastIndex = 0;
    while ((m = SQL_WIDGET_RE.exec(src))) {
      const type = m[1].toLowerCase() as WidgetType;
      const name = m[2];
      const defaultValue = stripQuotes(m[3]);
      if (!byName.has(name)) byName.set(name, { name, type, defaultValue });
    }
  }
  return [...byName.values()];
}

/**
 * Build a Python preamble that sets each widget to the chosen value so a
 * subsequent `dbutils.widgets.get(name)` returns it in the interactive REPL.
 * Re-declares the widget (remove + add) so the value takes effect even if the
 * widget was already created with a different default.
 */
export function buildWidgetPreamble(specs: WidgetSpec[], values: Record<string, string>): string {
  const lines: string[] = [];
  for (const w of specs) {
    const v = values[w.name] ?? w.defaultValue;
    lines.push(`try:\n    dbutils.widgets.remove(${JSON.stringify(w.name)})\nexcept Exception:\n    pass`);
    if (w.type === 'text') {
      lines.push(`dbutils.widgets.text(${JSON.stringify(w.name)}, ${JSON.stringify(v)}, ${JSON.stringify(w.label ?? w.name)})`);
    } else {
      const choices = w.choices && w.choices.length ? w.choices : [v];
      // Ensure the chosen value is a member so the widget accepts it.
      const members = choices.includes(v) ? choices : [v, ...choices];
      const choicesLit = `[${members.map((c) => JSON.stringify(c)).join(', ')}]`;
      lines.push(`dbutils.widgets.${w.type}(${JSON.stringify(w.name)}, ${JSON.stringify(v)}, ${choicesLit}, ${JSON.stringify(w.label ?? w.name)})`);
    }
  }
  return lines.join('\n');
}

/** Effective values with defaults filled in — used as job `notebook_params`. */
export function effectiveWidgetValues(specs: WidgetSpec[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of specs) out[w.name] = values[w.name] ?? w.defaultValue;
  return out;
}
