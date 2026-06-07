/**
 * Ingestion-mapping wire-format logic — pure, dependency-free (no React / Fluent).
 *
 * Split out from `ingestion-mapping-wizard.tsx` so the schema auto-detect and
 * Kusto mapping-JSON serialization can be unit-tested under the node test
 * environment (and reused by any non-UI caller) without dragging in the
 * component's UI dependencies.
 *
 * Mapping wire format grounded in Microsoft Learn (kusto/management/mappings):
 *   - tabular (csv/tsv/psv)  → Properties: { Ordinal: <int> }, API kind = csv
 *   - json / orc / parquet   → Properties: { Path: "$.field" }
 *   - avro                   → Properties: { Field: "fieldName" }
 * Each element: { Column, datatype?, Properties }.
 */

/** Display formats the wizard exposes (Avro/Parquet/ORC are binary → no client detect). */
export type MappingFormat = 'csv' | 'tsv' | 'psv' | 'json' | 'parquet' | 'avro' | 'orc';

/** The API `kind` for each display format (TSV/PSV are ordinal-tabular → csv kind). */
export const FORMAT_TO_KIND: Record<MappingFormat, string> = {
  csv: 'csv', tsv: 'csv', psv: 'csv', json: 'json', parquet: 'parquet', avro: 'avro', orc: 'orc',
};

export const BINARY: MappingFormat[] = ['parquet', 'avro', 'orc'];
export const TABULAR: MappingFormat[] = ['csv', 'tsv', 'psv'];

export interface MappingRow {
  /** Ordinal (tabular) as a string, or $.path (json/orc/parquet), or field name (avro). */
  source: string;
  /** Target table column name. */
  column: string;
  /** KQL datatype, or '' to let Kusto derive it from the table schema. */
  datatype: string;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function inferJsonType(v: unknown): string {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'long' : 'real';
  if (v && typeof v === 'object') return 'dynamic';
  const s = String(v ?? '');
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) return 'datetime';
  if (GUID_RE.test(s)) return 'guid';
  return 'string';
}

export function inferScalarType(s: string): string {
  const v = s.trim();
  if (v === '') return 'string';
  if (/^-?\d+$/.test(v)) return 'long';
  if (/^-?\d+\.\d+$/.test(v)) return 'real';
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(v)) return 'datetime';
  if (/^(true|false)$/i.test(v)) return 'bool';
  if (GUID_RE.test(v)) return 'guid';
  return 'string';
}

/** Derive a column-map grid from a sample file. Binary formats return []. */
export async function detectSchema(file: File, format: MappingFormat): Promise<MappingRow[]> {
  if (BINARY.includes(format)) return [];
  const text = await file.text();

  if (format === 'json') {
    const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('{') || l.startsWith('['));
    if (!line) return [];
    let obj: any;
    try { obj = JSON.parse(line); } catch { return []; }
    const record = Array.isArray(obj) ? obj[0] : obj;
    if (!record || typeof record !== 'object') return [];
    return Object.entries(record).map(([k, v]) => ({
      source: `$.${k}`,
      column: k,
      datatype: inferJsonType(v),
    }));
  }

  // csv / tsv / psv — first line = header, second (if present) = sample values
  const delim = format === 'tsv' ? '\t' : format === 'psv' ? '|' : ',';
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(delim).map((h) => h.replace(/^"|"$/g, '').trim());
  const sample = lines[1] ? lines[1].split(delim) : [];
  return headers.map((h, i) => ({
    source: String(i),
    column: h || `Column${i + 1}`,
    datatype: inferScalarType(sample[i] ?? ''),
  }));
}

/** Serialize a column-map grid into the Kusto mapping JSON definition. */
export function serializeMapping(rows: MappingRow[], format: MappingFormat): string {
  return JSON.stringify(
    rows
      .filter((r) => r.column.trim())
      .map((r) => {
        let props: Record<string, unknown>;
        if (TABULAR.includes(format)) {
          const ord = parseInt(r.source, 10);
          props = { Ordinal: Number.isFinite(ord) ? ord : 0 };
        } else if (format === 'avro') {
          props = { Field: r.source.trim() };
        } else {
          // json / parquet / orc — JSONPath
          props = { Path: r.source.trim() || `$.${r.column.trim()}` };
        }
        const el: Record<string, unknown> = { Column: r.column.trim(), Properties: props };
        if (r.datatype) el.datatype = r.datatype;
        return el;
      }),
    null, 2,
  );
}

function sampleValue(datatype: string): string {
  switch (datatype) {
    case 'long': case 'int': return '1';
    case 'real': case 'decimal': return '1.5';
    case 'bool': return 'true';
    case 'datetime': return new Date().toISOString();
    case 'timespan': return '00:05:00';
    case 'guid': return '00000000-0000-0000-0000-000000000000';
    case 'dynamic': return '{}';
    default: return 'sample';
  }
}

/** Build a verify + test-ingest snippet for the editor after a mapping is created. */
export function buildSnippet(name: string, format: MappingFormat, table: string, rows: MappingRow[]): string {
  const t = `["${table}"]`;
  const show = `.show table ${t} ingestion mappings`;
  const valid = rows.filter((r) => r.column.trim());

  if (BINARY.includes(format)) {
    return [
      `// Mapping '${name}' registered. Ingest a ${format} file from blob storage using it`,
      `// (inline ingest is not supported for binary formats):`,
      `// .ingest into table ${t} from @'https://<account>.blob.core.windows.net/<container>/<file>.${format}'`,
      `//   with (format='${format}', ingestionMappingReference='${name}')`,
      ``,
      `// Verify the mapping is registered:`,
      show,
    ].join('\n');
  }

  let sample: string;
  if (format === 'json') {
    const obj: Record<string, string> = {};
    valid.forEach((r) => { obj[r.column.trim()] = sampleValue(r.datatype); });
    sample = JSON.stringify(obj);
  } else {
    const delim = format === 'tsv' ? '\t' : format === 'psv' ? '|' : ',';
    sample = valid.map((r) => sampleValue(r.datatype)).join(delim);
  }

  return [
    `// Verify the mapping '${name}' is registered:`,
    show,
    ``,
    `// Test-ingest one sample row with the mapping (edit the values, then Shift+Enter to run):`,
    `.ingest inline into table ${t} with (format='${format}', ingestionMappingReference='${name}') <|`,
    sample,
  ].join('\n');
}
