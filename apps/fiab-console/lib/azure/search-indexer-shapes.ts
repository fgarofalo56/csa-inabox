/**
 * Server-free shaping for the AI Search indexer FIELD-MAPPINGS builder + the
 * execution-history reader (AIF-10). Kept out of the data-plane client so the
 * `'use client'` editor and the server route agree on the exact wire shape a
 * PUT /indexers/{name} field-mapping payload takes, and so the shaping is unit
 * testable without a network.
 *
 * Grounded in Microsoft Learn:
 *   - Field mappings + mapping functions:
 *     https://learn.microsoft.com/azure/search/search-indexer-field-mappings
 *   - Indexer execution status (`executionHistory[]`):
 *     https://learn.microsoft.com/rest/api/searchservice/get-indexer-status
 */

/**
 * The built-in field-mapping functions AI Search exposes. `''` = a straight
 * source→target mapping with no function. Only functions with parameters take
 * extra inputs in the builder (extractTokenAtPosition; the base64 pair's
 * optional UTF-8 flag).
 */
export const MAPPING_FUNCTIONS = [
  '',
  'base64Encode',
  'base64Decode',
  'extractTokenAtPosition',
  'jsonArrayToStringCollection',
  'urlEncode',
  'urlDecode',
  'fixedLengthEncode',
] as const;

export type MappingFunctionName = (typeof MAPPING_FUNCTIONS)[number];

/** Human labels for the mapping-function dropdown. */
export const MAPPING_FUNCTION_LABELS: Record<string, string> = {
  '': '(none — direct)',
  base64Encode: 'base64Encode',
  base64Decode: 'base64Decode',
  extractTokenAtPosition: 'extractTokenAtPosition',
  jsonArrayToStringCollection: 'jsonArrayToStringCollection',
  urlEncode: 'urlEncode',
  urlDecode: 'urlDecode',
  fixedLengthEncode: 'fixedLengthEncode',
};

/** One row in the field-mappings / output-field-mappings builder. */
export interface FieldMappingRow {
  sourceFieldName: string;
  targetFieldName: string;
  /** Mapping-function name, or '' for a direct mapping. */
  functionName: MappingFunctionName;
  // extractTokenAtPosition parameters
  delimiter?: string;
  position?: number;
  // base64Encode / base64Decode parameter
  useHttpServerUtf8Encoding?: boolean;
}

/** A blank builder row (direct mapping). */
export function emptyFieldMappingRow(): FieldMappingRow {
  return { sourceFieldName: '', targetFieldName: '', functionName: '' };
}

/** True when this function carries editable parameters. */
export function functionHasParameters(fn: MappingFunctionName): boolean {
  return fn === 'extractTokenAtPosition' || fn === 'base64Encode' || fn === 'base64Decode';
}

/** Build a single AI Search field-mapping wire object from a builder row. */
export function buildFieldMapping(row: FieldMappingRow): any | null {
  const source = (row.sourceFieldName || '').trim();
  const target = (row.targetFieldName || '').trim();
  if (!source || !target) return null;
  const out: any = { sourceFieldName: source, targetFieldName: target };
  if (row.functionName) {
    const fn: any = { name: row.functionName };
    if (row.functionName === 'extractTokenAtPosition') {
      fn.parameters = {
        delimiter: row.delimiter ?? ' ',
        position: typeof row.position === 'number' && !Number.isNaN(row.position) ? row.position : 0,
      };
    } else if (row.functionName === 'base64Encode' || row.functionName === 'base64Decode') {
      if (row.useHttpServerUtf8Encoding) fn.parameters = { useHttpServerUtf8Encoding: true };
    }
    out.mappingFunction = fn;
  }
  return out;
}

/** Build the full `fieldMappings[]` wire array from builder rows (skips incomplete rows). */
export function buildFieldMappings(rows: FieldMappingRow[]): any[] {
  return (rows || []).map(buildFieldMapping).filter((m): m is any => m != null);
}

/** Parse one AI Search field-mapping wire object into an editable builder row. */
export function parseFieldMapping(m: any): FieldMappingRow {
  const fn = m?.mappingFunction;
  const name: MappingFunctionName = (MAPPING_FUNCTIONS as readonly string[]).includes(fn?.name)
    ? (fn.name as MappingFunctionName)
    : '';
  const row: FieldMappingRow = {
    sourceFieldName: m?.sourceFieldName ?? '',
    targetFieldName: m?.targetFieldName ?? '',
    functionName: name,
  };
  if (name === 'extractTokenAtPosition') {
    row.delimiter = fn?.parameters?.delimiter ?? ' ';
    row.position = typeof fn?.parameters?.position === 'number' ? fn.parameters.position : 0;
  } else if (name === 'base64Encode' || name === 'base64Decode') {
    row.useHttpServerUtf8Encoding = !!fn?.parameters?.useHttpServerUtf8Encoding;
  }
  return row;
}

/** Parse an indexer definition's field + output-field mappings into builder rows. */
export function parseIndexerMappings(indexer: any): {
  fieldMappings: FieldMappingRow[];
  outputFieldMappings: FieldMappingRow[];
} {
  const fm = Array.isArray(indexer?.fieldMappings) ? indexer.fieldMappings.map(parseFieldMapping) : [];
  const ofm = Array.isArray(indexer?.outputFieldMappings) ? indexer.outputFieldMappings.map(parseFieldMapping) : [];
  return { fieldMappings: fm, outputFieldMappings: ofm };
}

// ----------------------------------------------------------------------------
// Execution history (GET /indexers/{name}/status → executionHistory[]).
// ----------------------------------------------------------------------------

/** One normalized indexer execution-history run. */
export interface IndexerRun {
  status: string;
  startTime?: string;
  endTime?: string;
  itemsProcessed: number;
  itemsFailed: number;
  errorMessage?: string;
  errors: Array<{ key?: string; name?: string; errorMessage: string; details?: string }>;
  warnings: Array<{ key?: string; name?: string; message: string }>;
  finalTrackingState?: string;
}

/** Normalize a raw `/status` response into `{ lastResult, executionHistory[] }`. */
export function parseExecutionHistory(status: any): {
  overallStatus?: string;
  lastResult?: IndexerRun;
  executionHistory: IndexerRun[];
} {
  const mapRun = (r: any): IndexerRun => ({
    status: r?.status ?? 'unknown',
    startTime: r?.startTime,
    endTime: r?.endTime,
    itemsProcessed: typeof r?.itemsProcessed === 'number' ? r.itemsProcessed : 0,
    itemsFailed: typeof r?.itemsFailed === 'number' ? r.itemsFailed : 0,
    errorMessage: r?.errorMessage || undefined,
    errors: Array.isArray(r?.errors)
      ? r.errors.map((e: any) => ({ key: e?.key, name: e?.name, errorMessage: e?.errorMessage ?? String(e), details: e?.details }))
      : [],
    warnings: Array.isArray(r?.warnings)
      ? r.warnings.map((w: any) => ({ key: w?.key, name: w?.name, message: w?.message ?? String(w) }))
      : [],
    finalTrackingState: r?.finalTrackingState,
  });
  const history = Array.isArray(status?.executionHistory) ? status.executionHistory.map(mapRun) : [];
  return {
    overallStatus: status?.status,
    lastResult: status?.lastResult ? mapRun(status.lastResult) : undefined,
    executionHistory: history,
  };
}

/** Format an ISO datetime range into a short "duration" string for the history grid. */
export function runDuration(run: Pick<IndexerRun, 'startTime' | 'endTime'>): string {
  if (!run.startTime) return '—';
  const start = Date.parse(run.startTime);
  const end = run.endTime ? Date.parse(run.endTime) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—';
  const ms = end - start;
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}
