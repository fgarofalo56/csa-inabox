/**
 * Schema detection for the Get-Data wizard's "preview before commit" step.
 *
 * Pure, dependency-free parsers shared by the eventhouse ingest-preview BFF
 * route and its unit tests. Given a chunk of text (the first few KB of a file
 * or blob), detect the format and extract column names + a few sample rows so
 * the operator can confirm the shape before the real `.ingest` runs.
 *
 * No mocks, no network — this is the deterministic core that the route wraps
 * around real file uploads and real blob fetches.
 */

export type DetectedFormat = 'csv' | 'json' | 'multijson' | 'unknown';

export interface SchemaPreview {
  columns: string[];
  sampleRows: string[][];
  detectedFormat: DetectedFormat;
  /** rows parsed from the chunk (excludes header for CSV). */
  sampleRowCount: number;
}

/** Parse one CSV line respecting RFC-4180 double-quote escaping. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else {
        cur += c;
      }
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function toCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Heuristically detect whether `text` is JSON (array / JSONL) or CSV, and
 * extract columns + up to `maxRows` sample rows. `nameHint` (the file name or
 * blob path) breaks ties when content is ambiguous.
 */
export function detectSchema(text: string, nameHint = '', maxRows = 5): SchemaPreview {
  const trimmed = text.trim();
  const lower = nameHint.toLowerCase();
  const looksJsonByName = /\.(json|jsonl|ndjson)$/.test(lower);
  const looksJsonByContent = trimmed.startsWith('[') || trimmed.startsWith('{');

  if (looksJsonByName || looksJsonByContent) {
    try {
      return detectJson(trimmed, maxRows);
    } catch {
      // fall through to CSV if JSON parse fails on a truncated chunk
    }
  }
  return detectCsv(text, maxRows);
}

function detectJson(trimmed: string, maxRows: number): SchemaPreview {
  let rows: any[] = [];
  let format: DetectedFormat = 'json';
  if (trimmed.startsWith('[')) {
    // Array form. A truncated chunk may be invalid JSON; recover the leading
    // complete objects so a preview is still possible.
    format = 'multijson';
    const parsed = tryParseArrayPrefix(trimmed);
    rows = parsed;
  } else {
    // JSONL or a single object. Parse line-by-line, skipping the last partial.
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const l of lines) {
      try { rows.push(JSON.parse(l)); } catch { /* partial last line */ }
    }
  }
  if (!rows.length) throw new Error('no parseable JSON rows');
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r ?? {}))));
  const sampleRows = rows.slice(0, maxRows).map((r) => keys.map((k) => toCell(r?.[k])));
  return { columns: keys, sampleRows, detectedFormat: format, sampleRowCount: rows.length };
}

/** Parse the leading complete objects of a (possibly truncated) JSON array. */
function tryParseArrayPrefix(trimmed: string): any[] {
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    return [parsed];
  } catch {
    // Truncated array — scan for balanced top-level objects.
    const out: any[] = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') { if (depth === 0) start = i; depth++; }
      else if (c === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          try { out.push(JSON.parse(trimmed.slice(start, i + 1))); } catch { /* skip */ }
          start = -1;
        }
      }
    }
    return out;
  }
}

function detectCsv(text: string, maxRows: number): SchemaPreview {
  // Drop a trailing partial line (a truncated chunk rarely ends on a newline).
  const allLines = text.split(/\r?\n/);
  const lines = allLines.filter((l) => l.length > 0);
  if (lines.length > 1 && !/\n$/.test(text)) lines.pop();
  if (!lines.length) {
    return { columns: [], sampleRows: [], detectedFormat: 'unknown', sampleRowCount: 0 };
  }
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const dataLines = lines.slice(1, 1 + maxRows);
  const sampleRows = dataLines.map((l) => parseCsvLine(l));
  return {
    columns: header,
    sampleRows,
    detectedFormat: 'csv',
    sampleRowCount: Math.max(0, lines.length - 1),
  };
}

/**
 * Convert an `abfss://container@account.dfs.core.windows.net/path` URL to the
 * equivalent `https://account.dfs.core.windows.net/container/path` form used by
 * the DFS REST endpoint. Returns the input unchanged if it is already https://.
 */
export function abfssToHttps(url: string): string {
  const m = /^abfss:\/\/([^@]+)@([^/]+)\/(.*)$/i.exec(url.trim());
  if (!m) return url.trim();
  const [, container, host, path] = m;
  return `https://${host}/${container}/${path}`;
}

/** True when a URL carries a SAS token (sig=) — i.e. needs no bearer auth. */
export function isSasUrl(url: string): boolean {
  return /[?&]sig=/.test(url);
}
