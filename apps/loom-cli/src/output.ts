/**
 * Output formatting: json | yaml | table. Zero external deps so the published
 * binary has no supply-chain footprint (matters for sovereign-cloud installs).
 */
import type { OutputFormat } from './config.js';

type Row = Record<string, unknown>;

function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function renderTable(rows: Row[], columns?: string[]): string {
  if (rows.length === 0) return '(no results)';
  const cols = columns && columns.length ? columns : Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => stringifyCell(r[c]).length)),
  );
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const header = cols.map((c, i) => pad(c.toUpperCase(), widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const body = rows
    .map((r) => cols.map((c, i) => pad(stringifyCell(r[c]), widths[i])).join('  '))
    .join('\n');
  return `${header}\n${sep}\n${body}`;
}

/** Minimal, dependency-free YAML emitter for JSON-shaped values. */
export function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    // Quote when the string could be misread as another YAML scalar.
    return /[:#\-?{}\[\],&*!|>'"%@`]|^\s|\s$|^$/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const nested = toYaml(item, indent + 1);
          // Inline the first key on the dash line for compactness.
          return `${pad}-\n${nested}`;
        }
        return `${pad}- ${toYaml(item, indent + 1)}`;
      })
      .join('\n');
  }
  const entries = Object.entries(value as Row);
  if (entries.length === 0) return '{}';
  return entries
    .map(([k, v]) => {
      if (v !== null && typeof v === 'object') {
        const nested = toYaml(v, indent + 1);
        return `${pad}${k}:\n${nested}`;
      }
      return `${pad}${k}: ${toYaml(v, indent + 1)}`;
    })
    .join('\n');
}

/** Print a list/record result honoring the chosen format. */
export function printResult(
  data: unknown,
  format: OutputFormat,
  tableColumns?: string[],
): void {
  if (format === 'json') {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (format === 'yaml') {
    process.stdout.write(toYaml(data) + '\n');
    return;
  }
  // table
  if (Array.isArray(data)) {
    process.stdout.write(renderTable(data as Row[], tableColumns) + '\n');
  } else if (data && typeof data === 'object') {
    // single object -> key/value table
    const rows = Object.entries(data as Row).map(([key, value]) => ({
      field: key,
      value: stringifyCell(value),
    }));
    process.stdout.write(renderTable(rows, ['field', 'value']) + '\n');
  } else {
    process.stdout.write(stringifyCell(data) + '\n');
  }
}
