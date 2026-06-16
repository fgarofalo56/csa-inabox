/**
 * TMDL sample-data parser for the CoE template viewer.
 *
 * Each CoE template's semantic model ships with REAL, clearly-labelled SAMPLE
 * data embedded in the Power Query (M) partition of every table:
 *
 *   partition 'Cost' = m
 *       source =
 *           let
 *               Source = #table(
 *                   type table [#"UsageDate"=type datetime, #"PreTaxCost"=type number, ...],
 *                   { {#datetime(2026,3,1,0,0,0), 12450.32, ...}, { ... } }
 *               )
 *           in
 *               Source
 *
 * `parseSampleData` reads every `*.SemanticModel/definition/tables/<Entity>.tmdl`
 * file, finds the `#table(type table [...], { ... })` literal (also tolerates
 * the `Table.FromRows` shape), and returns the column names + parsed row objects
 * keyed by the real table name (the `table '<Name>'` declaration — which is what
 * the report's projections reference via SourceRef.Entity).
 *
 * Pure + dependency-free. Robust to whitespace / newlines / tabs. No Microsoft
 * Fabric / Power BI service is contacted — the bytes are bundled with the app.
 */

import type { TemplateFile } from './pbir-parse';

export interface SampleTable {
  columns: string[];
  rows: Record<string, unknown>[];
}

export type SampleData = Record<string, SampleTable>;

const TABLE_FILE_RE = /SemanticModel\/definition\/tables\/[^/]+\.tmdl$/;

/** Extract the declared table name from a TMDL table file. */
function tableName(content: string): string | null {
  const m = content.match(/^\s*table\s+(?:'([^']+)'|"([^"]+)"|(\S+))/m);
  if (!m) return null;
  return (m[1] || m[2] || m[3] || '').trim() || null;
}

/**
 * Scan forward from `open` (index of an opening bracket char) and return the
 * index of its matching close, honoring quotes. Returns -1 if unbalanced.
 */
function matchBracket(s: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a top-level comma-separated list, ignoring commas inside (), {}, [], "". */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** Parse a column name from a `type table [ ... ]` entry like `#"Name"=type text`. */
function parseColumnName(entry: string): string | null {
  const eq = entry.indexOf('=');
  const left = (eq >= 0 ? entry.slice(0, eq) : entry).trim();
  // #"Quoted Name"
  const quoted = left.match(/^#"([^"]+)"$/);
  if (quoted) return quoted[1];
  const dq = left.match(/^"([^"]+)"$/);
  if (dq) return dq[1];
  return left || null;
}

/** Parse a single M scalar literal into a JS value. */
function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === '' ) return null;
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;

  // "string"  (handles doubled "" escapes)
  if (v.startsWith('"')) {
    const inner = v.replace(/^"|"$/g, '');
    return inner.replace(/""/g, '"');
  }

  // #datetime(y,m,d,h,mi,s) / #date(y,m,d) / #datetimezone(...)
  const dt = v.match(/^#datetime(?:zone)?\(([^)]*)\)$/);
  if (dt) {
    const p = dt[1].split(',').map((n) => parseInt(n.trim(), 10));
    const [y, mo, d, h = 0, mi = 0, s = 0] = p;
    const pad = (n: number) => String(n).padStart(2, '0');
    if ([y, mo, d].every((n) => Number.isFinite(n))) {
      return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
    }
  }
  const dOnly = v.match(/^#date\(([^)]*)\)$/);
  if (dOnly) {
    const p = dOnly[1].split(',').map((n) => parseInt(n.trim(), 10));
    const [y, mo, d] = p;
    const pad = (n: number) => String(n).padStart(2, '0');
    if ([y, mo, d].every((n) => Number.isFinite(n))) return `${y}-${pad(mo)}-${pad(d)}`;
  }

  // number
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);

  return v; // unknown literal → keep raw text (never invent)
}

/** Parse the `#table(type table [...], { {..}, {..} })` body into columns + rows. */
function parseTableLiteral(content: string): SampleTable | null {
  // Prefer #table(...); fall back to Table.FromRows(...) if a template uses it.
  let idx = content.indexOf('#table(');
  let mode: 'sharp' | 'fromrows' = 'sharp';
  if (idx < 0) {
    idx = content.indexOf('Table.FromRows(');
    if (idx < 0) return null;
    mode = 'fromrows';
  }

  // 1. Column names from the `type table [ ... ]` block.
  const ttIdx = content.indexOf('type table', idx);
  let columns: string[] = [];
  let typeBlockEnd = idx;
  if (ttIdx >= 0) {
    const lb = content.indexOf('[', ttIdx);
    const rb = lb >= 0 ? matchBracket(content, lb, '[', ']') : -1;
    if (lb >= 0 && rb > lb) {
      const inner = content.slice(lb + 1, rb);
      columns = splitTopLevel(inner)
        .map(parseColumnName)
        .filter((c): c is string => !!c);
      typeBlockEnd = rb;
    }
  }

  // 2. Row list — the first `{` after the type block is the outer list.
  const listOpen = content.indexOf('{', typeBlockEnd);
  if (listOpen < 0) return null;
  const listClose = matchBracket(content, listOpen, '{', '}');
  if (listClose < 0) return null;
  const listBody = content.slice(listOpen + 1, listClose);

  // Each top-level entry of the outer list is a row `{...}`.
  const rowEntries = splitTopLevel(listBody)
    .map((e) => e.trim())
    .filter((e) => e.startsWith('{'));

  const rows: Record<string, unknown>[] = [];
  for (const entry of rowEntries) {
    const close = matchBracket(entry, 0, '{', '}');
    const inner = close > 0 ? entry.slice(1, close) : entry.replace(/^\{|\}$/g, '');
    const values = splitTopLevel(inner).map(parseScalar);
    const row: Record<string, unknown> = {};
    if (columns.length) {
      columns.forEach((col, i) => { row[col] = i < values.length ? values[i] : null; });
    } else {
      // No type-table header (rare) → synthesize positional column names.
      values.forEach((val, i) => { row[`Column${i + 1}`] = val; });
    }
    rows.push(row);
  }

  if (!columns.length && rows.length) columns = Object.keys(rows[0]);
  // `mode` retained for clarity / future Table.FromRows column-list handling.
  void mode;
  return { columns, rows };
}

/**
 * Parse every table .tmdl in `files` into sample tables keyed by table name.
 * Tables without an embedded literal are skipped (never throws).
 */
export function parseSampleData(files: TemplateFile[]): SampleData {
  const out: SampleData = {};
  for (const f of files || []) {
    if (!f || typeof f.path !== 'string' || !TABLE_FILE_RE.test(f.path)) continue;
    const name = tableName(f.content);
    if (!name) continue;
    const table = parseTableLiteral(f.content);
    if (table) out[name] = table;
  }
  return out;
}
