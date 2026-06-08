/**
 * Tiny, dependency-free RFC-4180 CSV parser shared by the Data product
 * "Import from CSV" flyout (client-side pre-validation) and the bulk-import
 * BFF route (server-side authoritative parse).
 *
 * Why hand-rolled instead of papaparse: it must run identically in the browser
 * AND in the Node BFF with ZERO new dependencies, across all sovereign clouds
 * (no network, no Azure dependency). It handles the cases that matter for a
 * pasted/exported data-product CSV: quoted fields, embedded commas, embedded
 * newlines inside quotes, and RFC-4180 doubled-quote escaping ("").
 *
 * It is intentionally NOT a streaming parser — bulk imports are capped at
 * MAX_IMPORT_ROWS so the whole file fits comfortably in memory on both ends.
 */

/** Hard cap on data rows (excludes the header) for a single bulk import. */
export const MAX_IMPORT_ROWS = 1000;

/** Required columns every import CSV must carry (case-insensitive headers). */
export const REQUIRED_COLUMNS = ['name', 'description', 'domain', 'owner'] as const;
/** Optional columns recognised by the importer. */
export const OPTIONAL_COLUMNS = ['tags'] as const;

export interface ParsedCsv {
  /** Normalised (lower-cased, trimmed) header names, in file order. */
  headers: string[];
  /** One object per data row, keyed by normalised header. */
  rows: Array<Record<string, string>>;
}

/**
 * Parse CSV text into { headers, rows }. The first non-empty physical record is
 * treated as the header. Header names are lower-cased + trimmed so the column
 * contract is case-insensitive. Empty trailing rows are dropped.
 */
export function parseCsv(text: string): ParsedCsv {
  const records = tokenize(text);
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0].map((h) => h.trim().toLowerCase());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < records.length; i++) {
    const cells = records[i];
    // Skip fully-empty rows (e.g. a trailing newline produced an empty record).
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (cells[idx] ?? '').trim();
    });
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Split CSV text into an array of records, each an array of raw field strings.
 * Honours RFC-4180 quoting: a field wrapped in double quotes may contain commas
 * and newlines; a literal double quote inside is written as "".
 */
function tokenize(text: string): string[][] {
  const out: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  // Strip a UTF-8 BOM if present so the first header isn't "﻿name".
  if (n > 0 && text.charCodeAt(0) === 0xfeff) i = 1;

  const endField = () => { record.push(field); field = ''; };
  const endRecord = () => { endField(); out.push(record); record = []; };

  for (; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { endField(); continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; endRecord(); continue; }
    if (ch === '\n') { endRecord(); continue; }
    field += ch;
  }
  // Flush the final field/record if the file didn't end with a newline.
  if (field.length > 0 || record.length > 0) endRecord();
  return out;
}

export interface RowError {
  /** 1-based row number AS THE USER SEES IT in a spreadsheet (header = row 1). */
  row: number;
  column: string;
  error: string;
}

export interface CsvValidation {
  parsed: ParsedCsv;
  /** Header- and row-level problems (missing required column, empty required cell). */
  errors: RowError[];
  /** Rows whose required cells are all present — the ones that WILL be imported. */
  validRowCount: number;
  /** True when row count exceeds MAX_IMPORT_ROWS. */
  tooLarge: boolean;
}

/**
 * Validate a parsed/raw CSV against the import column contract. Used client-side
 * for instant column-error highlighting AND server-side as a second fence
 * before any Cosmos write. Never throws — returns a structured report.
 */
export function validateImportCsv(textOrParsed: string | ParsedCsv): CsvValidation {
  const parsed = typeof textOrParsed === 'string' ? parseCsv(textOrParsed) : textOrParsed;
  const errors: RowError[] = [];

  // Header check — every required column must be present.
  const present = new Set(parsed.headers);
  for (const req of REQUIRED_COLUMNS) {
    if (!present.has(req)) {
      errors.push({ row: 1, column: req, error: `Missing required column "${req}"` });
    }
  }

  // Per-row required-cell check (only meaningful when the columns exist).
  let validRowCount = 0;
  parsed.rows.forEach((r, idx) => {
    const sheetRow = idx + 2; // header is row 1, first data row is row 2
    let rowOk = true;
    for (const req of REQUIRED_COLUMNS) {
      if (!present.has(req)) { rowOk = false; continue; }
      if (!r[req] || r[req].trim() === '') {
        errors.push({ row: sheetRow, column: req, error: `"${req}" is empty` });
        rowOk = false;
      }
    }
    if (rowOk) validRowCount++;
  });

  return {
    parsed,
    errors,
    validRowCount,
    tooLarge: parsed.rows.length > MAX_IMPORT_ROWS,
  };
}

/** Split a `tags` cell ("a;b ; c") into a clean string array. */
export function splitTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
}
