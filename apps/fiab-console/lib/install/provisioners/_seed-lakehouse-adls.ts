/**
 * Shared lakehouse-materialization helper — turn a `LakehouseContent` bundle
 * into a real ADLS Gen2 folder tree with REAL Delta tables.
 *
 * Lifted out of `lakehouse.ts` (`provisionAzureNative`'s folder + delta-table
 * loops, plus the DDL/CSV helpers they depend on) so the INSTALL path and the
 * OPEN-time auto-bind path (`lib/azure/auto-bind-seed.seedLakehouseFromContent`)
 * materialize a lakehouse the same way. Before #3549 only install did it:
 * `auto-bind-providers.lakehouseAutoBind.create()` made the ROOT DIRECTORY and
 * stopped, so a config-gated install left a real-but-empty lakehouse whose
 * declared folders and seeded tables were nowhere on disk.
 *
 * --- #3904: this used to write a CSV and call it a Delta table ---------------
 *
 * Until 2026-08-22 the "Delta table" this module produced was a single plain
 * CSV at `Tables/<name>/<name>.csv`. Nothing anywhere in the repo wrote a
 * `_delta_log` on the Azure-native path — only readers existed. So the reader
 * was right and the writer was wrong: `scanLakehouseTables` (probeTable) sees
 * no `_delta_log` and no `.parquet`, classifies the directory `format:'unknown',
 * status:'empty'`, and `countRows`' `OPENROWSET(… FORMAT='DELTA')` throws over a
 * CSV and honestly returns null. Every seeded table in every demo app read
 * EMPTY, which is exactly what the operator reported.
 *
 * We now emit a real Delta table per seeded table:
 *
 *     Tables/<name>/part-00000-<uuid>-c000.parquet     <- PLAIN/uncompressed
 *     Tables/<name>/_delta_log/00000000000000000000.json
 *
 * The commit carries `protocol` (reader 1 / writer 2 — the most widely readable
 * pair), `metaData` (a Spark `schemaString`), and one `add` action whose
 * `stats` reports a TRUTHFUL `numRecords`. That is the field a post-deploy
 * validation pass reads to decide whether a table is loaded (#3905), so it is
 * derived from the rows actually encoded into the Parquet file, never from the
 * bundle's declared length.
 *
 * WHY WE EMIT THE PARQUET + LOG DIRECTLY rather than calling the existing
 * `buildLoadToTablePySpark` materializer:
 *   - That route reuses tested code but makes EVERY lakehouse install depend on
 *     a live Synapse Spark pool reachable over Livy, with a cold-start of
 *     minutes per table and no fallback. #3905 already records that dependency
 *     as the reason `runSuperchargeSeed` covers only 4 of the demo's apps.
 *     Installing 45 declared tables would mean 45 Livy statements at install
 *     time — a far larger failure surface than the defect being fixed, and it
 *     would violate auto-bind-by-default §5 (the platform does the work; a
 *     capability must not hard-depend on optional infra).
 *   - It also writes to `<container>/Tables/<table>`, the container ROOT, not
 *     the lakehouse item's own root — so it could not scope a per-item table
 *     without changing a module this change does not own.
 *   - The cost of doing it ourselves is that we must get the Delta + Parquet
 *     encodings right. That is bounded (PLAIN encoding, one uncompressed row
 *     group, no dictionary, no compression) and is pinned by tests that read
 *     the bytes back, including an independent third-party reader receipt in
 *     the PR body.
 *
 * The seed rows are ALSO written, unchanged, as a human-readable CSV under
 * `Files/_seed/<table>.csv` — the same convention the Fabric backend uses for
 * its Load-Table source. It is browsable, it is what a "Load to Table" run
 * would consume, and it is NOT inside the Delta table directory (a stray file
 * there would inflate the table's reported size and is not referenced by the
 * log).
 *
 * The optional Synapse serverless OPENROWSET view layer is NOT here: it needs a
 * serverless user database, the installer itself treats it as skippable, and it
 * is a queryability convenience rather than the lakehouse. `onTableSeeded` lets
 * the installer keep registering those views without this module knowing about
 * Synapse at all.
 *
 * Grounded in:
 *   - Delta transaction-log protocol (protocol / metaData / add, `stats`):
 *     https://github.com/delta-io/delta/blob/master/PROTOCOL.md
 *   - Apache Parquet file format (PLAIN encoding, RLE definition levels,
 *     Thrift-compact FileMetaData footer):
 *     https://parquet.apache.org/docs/file-format/
 *   - Synapse serverless reads Delta via OPENROWSET(BULK '<folder>',
 *     FORMAT='DELTA'):
 *     https://learn.microsoft.com/azure/synapse-analytics/sql/query-delta-lake-format
 */
import { createHash } from 'node:crypto';
import {
  createDirectory as adlsCreateDirectory,
  uploadFile as adlsUploadFile,
  type KnownContainer,
} from '@/lib/azure/adls-client';
import { safeAdlsRelPath } from '@/lib/azure/backing-name';

// ===========================================================================
// DDL parsing
// ===========================================================================

/**
 * Strip SQL comments (`-- …` to end of line, `/* … *\/` blocks) WITHOUT
 * touching string literals.
 *
 * Both halves of that sentence are load-bearing, and each one was a live
 * corruption before #3904:
 *
 *   - `-- Translated from dbt/models/gold/dim_customer.sql (SCD Type 2)` on the
 *     line ABOVE `CREATE TABLE` put the first `(` of the DDL inside a comment.
 *     `indexOf('(')` found it, nothing then split at depth 0, and the whole DDL
 *     parsed to the single phantom column `SCD`. 2 of the 45 bundled tables
 *     (app-lakehouse-inspector `dim_customer` + `dim_product`) seeded a
 *     1-column table and dropped 8 of 9 columns — while logging success.
 *   - An INLINE `-- CUI | Restricted-PII | …` after a column definition made
 *     the NEXT column's segment start with `--`, so that column failed the
 *     identifier test and was silently dropped (app-multi-agency-onboarding
 *     lost `endorsement` and `delta_share_name`).
 *   - And `COMMENT 'Medicare, Medicaid, Commercial, Uninsured, etc.'` is a
 *     STRING literal, not a comment: its commas split at depth 0 and injected
 *     `Medicaid` / `Commercial` / `Uninsured` as phantom columns
 *     (app-healthcare-popmgt `bronze.patients`). A comment stripper that is not
 *     quote-aware would ALSO eat the `--` inside such a literal.
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      out += ch;
      i++;
      while (i < n) {
        if (sql[i] === '\\' && q !== '`' && i + 1 < n) {
          out += sql[i] + sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === q) {
          // A doubled quote is an escaped quote — still inside the literal.
          if (sql[i + 1] === q) {
            out += q + q;
            i += 2;
            continue;
          }
          out += q;
          i++;
          break;
        }
        out += sql[i];
        i++;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue; // the newline itself is emitted on the next pass
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** `CREATE [OR REPLACE] [TEMP|EXTERNAL|MANAGED] TABLE [IF NOT EXISTS]` */
const CREATE_TABLE_RE =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL|TEMP|TEMPORARY|EXTERNAL|MANAGED|UNLOGGED)\s+)*TABLE\b(?:\s+IF\s+NOT\s+EXISTS\b)?/i;

/** Index of the first `(` at or after `from` that is not inside a literal. */
function firstOpenParen(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipLiteral(s, i);
      continue;
    }
    if (ch === '(') return i;
    i++;
  }
  return -1;
}

/** Index just past the literal that starts at `i`. */
function skipLiteral(s: string, i: number): number {
  const q = s[i];
  i++;
  while (i < s.length) {
    if (s[i] === '\\' && q !== '`' && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (s[i] === q) {
      if (s[i + 1] === q) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
}

/**
 * Index of the `)` that MATCHES the `(` at `open`.
 *
 * `lastIndexOf(')')` — what this used to do — is the close of whatever trails
 * the table, e.g. `TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true')`, so
 * `USING DELTA … TBLPROPERTIES (…` leaked into the column list and only failed
 * to produce phantom columns by luck of the identifier filter.
 */
function matchingClose(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipLiteral(s, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Split a column list on commas at paren-depth 0, ignoring literals. */
function splitTopLevel(inner: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipLiteral(inner, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      segments.push(inner.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  if (inner.slice(start).trim()) segments.push(inner.slice(start));
  return segments;
}

const CONSTRAINT_KEYWORDS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'FOREIGN',
  'UNIQUE',
  'CHECK',
  'KEY',
  'INDEX',
  'PERIOD',
  'EXCLUDE',
  'LIKE',
]);

/** One parsed column: its name and the raw SQL type token that followed it. */
export interface DdlColumn {
  name: string;
  /** e.g. `BIGINT`, `DECIMAL(18,2)`, `VARCHAR(64)`; '' when the DDL omits one. */
  sqlType: string;
}

/**
 * Parse `CREATE TABLE name ( col TYPE, … )` into ordered columns.
 *
 * Comments are stripped first (quote-aware), the column list is anchored on
 * `CREATE TABLE` and delimited by the MATCHING close paren, commas inside type
 * parens (`DECIMAL(18,2)`) / `CHECK (… BETWEEN x AND y)` / string literals are
 * not separators, and table-level constraint clauses are skipped so they do not
 * leak in as phantom columns and misalign the seed.
 */
export function parseDdlColumns(ddl: string): DdlColumn[] {
  const sql = stripSqlComments(String(ddl ?? ''));
  const m = CREATE_TABLE_RE.exec(sql);
  const searchFrom = m ? m.index + m[0].length : 0;
  const open = firstOpenParen(sql, searchFrom);
  if (open < 0) return [];
  const close = matchingClose(sql, open);
  if (close <= open) return [];

  const out: DdlColumn[] = [];
  const seen = new Set<string>();
  for (const seg of splitTopLevel(sql.slice(open + 1, close))) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    const name = (tokens[0] || '').replace(/^[`"[]|[`"\]]$/g, '');
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (CONSTRAINT_KEYWORDS.has(name.toUpperCase())) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue; // a duplicate would make an invalid Delta schema
    seen.add(key);
    out.push({ name, sqlType: tokens[1] || '' });
  }
  return out;
}

/**
 * Extract column NAMES from a `CREATE TABLE name ( col TYPE, … )` DDL.
 * Thin wrapper over {@link parseDdlColumns} — kept because the Fabric
 * Load-Table path and the sibling auto-bind specs call it by this name.
 */
export function columnsFromDdl(ddl: string): string[] {
  return parseDdlColumns(ddl).map((c) => c.name);
}

/** CSV-escape a single value (RFC-4180-ish: quote if it has comma/quote/newline). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build CSV text (header + rows) from column names and array-of-array rows. */
export function buildCsv(columns: string[], rows: any[][]): string {
  const header = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((_, i) => csvCell(r[i])).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

// ===========================================================================
// Column typing — Delta type per column
// ===========================================================================

/**
 * The Delta/Parquet types this writer emits.
 *
 * Deliberately four. `timestamp` / `date` columns are carried as `string` (the
 * ISO-8601 text the bundles already hold) rather than INT64-micros: that is the
 * same shape a Spark CSV read with `inferSchema` produces for these bundles, it
 * keeps the Parquet physical type and the Delta schema in exact agreement, and
 * it avoids an epoch-conversion class of bug in the one place we cannot verify
 * against live storage from here. Disclosed rather than silent.
 *
 * EVERY column is emitted `nullable: true` (Parquet OPTIONAL), including ones
 * the DDL declares `NOT NULL`. That is deliberate: 6 of the 45 bundled tables
 * ship sample rows SHORTER than their DDL, and the missing values are trailing,
 * so those columns are written as NULL. Emitting `nullable: false` over a column
 * that genuinely holds nulls would produce a Delta table whose schema lies about
 * its own contents — and fabricating a value (an epoch timestamp, an empty
 * string) to satisfy the constraint would be worse still, because a fabricated
 * value is indistinguishable from real data downstream. A NULL is legible as
 * "absent". The mismatch is reported per-table in `arityMismatches`.
 */
export type DeltaColumnType = 'string' | 'long' | 'double' | 'boolean';

const DELTA_TO_PARQUET: Record<DeltaColumnType, number> = {
  string: 6, // BYTE_ARRAY (UTF8)
  long: 2, // INT64
  double: 5, // DOUBLE
  boolean: 0, // BOOLEAN
};

/** Map a SQL type token onto a Delta type, or null when we do not recognise it. */
function deltaTypeFromSql(sqlType: string): DeltaColumnType | null {
  const t = String(sqlType || '').toUpperCase();
  if (!t) return null;
  if (/^(BIGINT|INT|INTEGER|SMALLINT|TINYINT|LONG|SERIAL|BIGSERIAL)\b/.test(t)) return 'long';
  if (/^(DECIMAL|NUMERIC|DEC|FLOAT|DOUBLE|REAL|MONEY)\b/.test(t)) return 'double';
  if (/^(BOOL|BOOLEAN|BIT)\b/.test(t)) return 'boolean';
  if (/^(STRING|VARCHAR|CHAR|TEXT|NVARCHAR|NCHAR|UUID|TIMESTAMP|DATETIME|DATE|TIME)\b/.test(t)) return 'string';
  return null;
}

/** Is `v` representable in `t` without lying about it? */
function valueFits(v: unknown, t: DeltaColumnType): boolean {
  if (v === null || v === undefined) return true;
  switch (t) {
    case 'boolean':
      return typeof v === 'boolean';
    case 'long':
      return typeof v === 'bigint' || (typeof v === 'number' && Number.isSafeInteger(v));
    case 'double':
      return typeof v === 'number' && Number.isFinite(v);
    case 'string':
      return true;
  }
}

/** Widest type the observed values actually fit, ignoring the DDL. */
function inferFromValues(rows: any[][], idx: number): DeltaColumnType {
  let sawBool = false;
  let sawInt = false;
  let sawFloat = false;
  let sawOther = false;
  for (const r of rows) {
    const v = Array.isArray(r) ? r[idx] : undefined;
    if (v === null || v === undefined) continue;
    if (typeof v === 'boolean') sawBool = true;
    else if (typeof v === 'bigint') sawInt = true;
    else if (typeof v === 'number' && Number.isFinite(v)) {
      if (Number.isSafeInteger(v)) sawInt = true;
      else sawFloat = true;
    } else sawOther = true;
  }
  if (sawOther) return 'string';
  if (sawBool) return sawInt || sawFloat ? 'string' : 'boolean';
  if (sawFloat) return 'double';
  if (sawInt) return 'long';
  return 'string';
}

/**
 * Resolve one Delta type per column.
 *
 * The DDL's declared type wins WHEN every non-null sample value fits it — that
 * is what keeps `list_price DECIMAL(18,2)` a `double` even in the rows where
 * every sampled price happens to be whole. Where the bundle's values contradict
 * the DDL we believe the VALUES, because those are what we are about to encode;
 * silently coercing them to match a declaration would be the same class of lie
 * this change exists to remove.
 */
export function resolveDeltaTypes(columns: DdlColumn[], rows: any[][]): DeltaColumnType[] {
  return columns.map((c, i) => {
    const declared = deltaTypeFromSql(c.sqlType);
    if (declared && rows.every((r) => valueFits(Array.isArray(r) ? r[i] : undefined, declared))) {
      return declared;
    }
    return inferFromValues(rows, i);
  });
}

// ===========================================================================
// Thrift compact protocol — the minimum needed for a Parquet footer
// ===========================================================================

const T_I32 = 0x05;
const T_I64 = 0x06;
const T_BINARY = 0x08;
const T_LIST = 0x09;
const T_STRUCT = 0x0c;

class ByteWriter {
  private chunks: Buffer[] = [];
  private size = 0;

  u8(n: number): void {
    this.chunks.push(Buffer.from([n & 0xff]));
    this.size += 1;
  }

  bytes(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}

/** Unsigned LEB128. Division-based so it stays correct past 2^31. */
function uvarint(w: ByteWriter, value: number): void {
  let v = Math.trunc(value);
  if (v < 0) throw new Error(`uvarint: negative value ${value}`);
  while (v >= 128) {
    w.u8((v % 128) + 128);
    v = Math.floor(v / 128);
  }
  w.u8(v);
}

function uvarintBig(w: ByteWriter, value: bigint): void {
  let v = value;
  while (v >= 128n) {
    w.u8(Number(v % 128n) + 128);
    v /= 128n;
  }
  w.u8(Number(v));
}

const zigzag32 = (n: number): number => (n << 1) ^ (n >> 31);
const zigzag64 = (n: bigint): bigint => (n << 1n) ^ (n >> 63n);

/** Minimal Thrift compact-protocol struct writer (write path only). */
class ThriftCompact {
  readonly w = new ByteWriter();
  private lastId = 0;
  private stack: number[] = [];

  structBegin(): void {
    this.stack.push(this.lastId);
    this.lastId = 0;
  }

  structEnd(): void {
    this.w.u8(0x00); // STOP
    this.lastId = this.stack.pop() ?? 0;
  }

  private header(id: number, type: number): void {
    const delta = id - this.lastId;
    if (delta > 0 && delta <= 15) {
      this.w.u8((delta << 4) | type);
    } else {
      this.w.u8(type);
      uvarint(this.w, zigzag32(id) >>> 0);
    }
    this.lastId = id;
  }

  i32(id: number, v: number): void {
    this.header(id, T_I32);
    uvarint(this.w, zigzag32(v) >>> 0);
  }

  i64(id: number, v: number | bigint): void {
    this.header(id, T_I64);
    uvarintBig(this.w, zigzag64(BigInt(v)));
  }

  str(id: number, s: string): void {
    this.header(id, T_BINARY);
    const b = Buffer.from(s, 'utf-8');
    uvarint(this.w, b.length);
    this.w.bytes(b);
  }

  /** Begin a `list<T>` field. The caller writes `size` elements. */
  listBegin(id: number, elemType: number, size: number): void {
    this.header(id, T_LIST);
    if (size <= 14) {
      this.w.u8((size << 4) | elemType);
    } else {
      this.w.u8(0xf0 | elemType);
      uvarint(this.w, size);
    }
  }

  /** A bare i32 list element (no field header). */
  listI32(v: number): void {
    uvarint(this.w, zigzag32(v) >>> 0);
  }

  /** A bare string list element (no field header). */
  listStr(s: string): void {
    const b = Buffer.from(s, 'utf-8');
    uvarint(this.w, b.length);
    this.w.bytes(b);
  }

  /** Begin a struct-typed FIELD. Caller writes fields then calls structEnd(). */
  structField(id: number): void {
    this.header(id, T_STRUCT);
    this.structBegin();
  }
}

// ===========================================================================
// Parquet
// ===========================================================================

const PARQUET_MAGIC = Buffer.from('PAR1', 'ascii');
const ENC_PLAIN = 0;
const ENC_RLE = 3;
const CODEC_UNCOMPRESSED = 0;
const REP_OPTIONAL = 1;
const CONVERTED_UTF8 = 0;
const PAGE_TYPE_DATA = 0;

/** PLAIN-encode one column's non-null values. */
function plainValues(type: DeltaColumnType, values: unknown[]): Buffer {
  if (type === 'boolean') {
    const out = Buffer.alloc(Math.ceil(values.length / 8));
    values.forEach((v, i) => {
      if (v) out[i >> 3] |= 1 << (i % 8);
    });
    return out;
  }
  if (type === 'long') {
    const out = Buffer.alloc(values.length * 8);
    values.forEach((v, i) => out.writeBigInt64LE(BigInt(typeof v === 'bigint' ? v : Math.trunc(Number(v))), i * 8));
    return out;
  }
  if (type === 'double') {
    const out = Buffer.alloc(values.length * 8);
    values.forEach((v, i) => out.writeDoubleLE(Number(v), i * 8));
    return out;
  }
  const parts: Buffer[] = [];
  for (const v of values) {
    const b = Buffer.from(String(v), 'utf-8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    parts.push(len, b);
  }
  return Buffer.concat(parts);
}

/**
 * RLE-hybrid definition levels for a max-def-level of 1 (every column
 * OPTIONAL), prefixed with the 4-byte little-endian length a Parquet v1 data
 * page requires. Repetition levels are omitted entirely because max rep level
 * is 0 for a flat schema.
 */
function rleDefinitionLevels(defs: number[]): Buffer {
  const w = new ByteWriter();
  let i = 0;
  while (i < defs.length) {
    const v = defs[i];
    let run = 1;
    while (i + run < defs.length && defs[i + run] === v) run++;
    uvarint(w, run * 2); // RLE run: (len << 1) | 0
    w.u8(v & 0xff); // bit-width 1 → one byte per run value
    i += run;
  }
  const body = w.toBuffer();
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

/** Coerce a raw sample value to the JS shape `plainValues` expects. */
function coerce(v: unknown, type: DeltaColumnType): unknown {
  switch (type) {
    case 'boolean':
      return v === true || v === 'true' || v === 1;
    case 'long':
      return typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)));
    case 'double':
      return Number(v);
    case 'string':
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

interface ColumnChunkPlan {
  name: string;
  type: DeltaColumnType;
  pageHeader: Buffer;
  pageData: Buffer;
  numValues: number;
  nullCount: number;
}

/**
 * Build a complete, single-row-group Parquet file: PLAIN encoding, no
 * dictionary, no compression, one data page per column, every column OPTIONAL.
 *
 * `rows` is array-of-arrays aligned to `columns`; a row shorter than `columns`
 * yields nulls for the missing trailing values (that is a real condition in the
 * shipped bundles — see `arityMismatches` below — and is disclosed, not hidden).
 */
export function buildParquetFile(columns: string[], types: DeltaColumnType[], rows: any[][]): Buffer {
  if (columns.length === 0) throw new Error('buildParquetFile: no columns');
  if (columns.length !== types.length) {
    throw new Error(`buildParquetFile: ${columns.length} column(s) but ${types.length} type(s)`);
  }

  const plans: ColumnChunkPlan[] = columns.map((name, i) => {
    const type = types[i];
    const defs: number[] = [];
    const present: unknown[] = [];
    for (const r of rows) {
      const v = Array.isArray(r) ? r[i] : undefined;
      if (v === null || v === undefined) {
        defs.push(0);
      } else {
        defs.push(1);
        present.push(coerce(v, type));
      }
    }
    const pageData = Buffer.concat([rleDefinitionLevels(defs), plainValues(type, present)]);

    const ph = new ThriftCompact();
    ph.structBegin();
    ph.i32(1, PAGE_TYPE_DATA);
    ph.i32(2, pageData.length); // uncompressed_page_size
    ph.i32(3, pageData.length); // compressed_page_size
    ph.structField(5); // data_page_header
    ph.i32(1, rows.length); // num_values (INCLUDING nulls)
    ph.i32(2, ENC_PLAIN);
    ph.i32(3, ENC_RLE); // definition_level_encoding
    ph.i32(4, ENC_RLE); // repetition_level_encoding
    ph.structEnd();
    ph.structEnd();

    return {
      name,
      type,
      pageHeader: ph.w.toBuffer(),
      pageData,
      numValues: rows.length,
      nullCount: defs.length - present.length,
    };
  });

  // ── Body: PAR1 then each column chunk's [page header][page data] ─────────
  const body: Buffer[] = [PARQUET_MAGIC];
  let offset = PARQUET_MAGIC.length;
  const chunkOffsets: number[] = [];
  const chunkSizes: number[] = [];
  for (const p of plans) {
    chunkOffsets.push(offset);
    body.push(p.pageHeader, p.pageData);
    const size = p.pageHeader.length + p.pageData.length;
    chunkSizes.push(size);
    offset += size;
  }

  // ── Footer: FileMetaData ────────────────────────────────────────────────
  const f = new ThriftCompact();
  f.structBegin();
  f.i32(1, 1); // version
  f.listBegin(2, T_STRUCT, plans.length + 1); // schema (root + one leaf per column)
  f.structBegin(); // root SchemaElement
  f.str(4, 'loom_schema');
  f.i32(5, plans.length); // num_children
  f.structEnd();
  for (const p of plans) {
    f.structBegin();
    f.i32(1, DELTA_TO_PARQUET[p.type]);
    f.i32(3, REP_OPTIONAL);
    f.str(4, p.name);
    if (p.type === 'string') f.i32(6, CONVERTED_UTF8);
    f.structEnd();
  }
  f.i64(3, rows.length); // num_rows
  f.listBegin(4, T_STRUCT, 1); // row_groups
  f.structBegin();
  f.listBegin(1, T_STRUCT, plans.length); // columns
  plans.forEach((p, i) => {
    f.structBegin(); // ColumnChunk
    f.i64(2, chunkOffsets[i]); // file_offset
    f.structField(3); // meta_data
    f.i32(1, DELTA_TO_PARQUET[p.type]);
    f.listBegin(2, T_I32, 2); // encodings
    f.listI32(ENC_PLAIN);
    f.listI32(ENC_RLE);
    f.listBegin(3, T_BINARY, 1); // path_in_schema
    f.listStr(p.name);
    f.i32(4, CODEC_UNCOMPRESSED);
    f.i64(5, p.numValues);
    f.i64(6, chunkSizes[i]); // total_uncompressed_size
    f.i64(7, chunkSizes[i]); // total_compressed_size
    f.i64(9, chunkOffsets[i]); // data_page_offset
    f.structEnd(); // ColumnMetaData
    f.structEnd(); // ColumnChunk
  });
  f.i64(2, chunkSizes.reduce((a, b) => a + b, 0)); // total_byte_size
  f.i64(3, rows.length); // num_rows
  f.structEnd(); // RowGroup
  f.str(6, 'CSA Loom lakehouse seeder');
  f.structEnd(); // FileMetaData

  const footer = f.w.toBuffer();
  const footerLen = Buffer.alloc(4);
  footerLen.writeUInt32LE(footer.length, 0);
  return Buffer.concat([...body, footer, footerLen, PARQUET_MAGIC]);
}

// ===========================================================================
// Delta
// ===========================================================================

/** Relative path of a Delta table's first (and, for a seed, only) commit. */
export const DELTA_FIRST_COMMIT = '_delta_log/00000000000000000000.json';

/** A deterministic RFC-4122 v4-shaped UUID derived from `seed`. */
function stableUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The bytes of a one-commit Delta table, ready to upload. */
export interface DeltaTableFiles {
  /** File name of the Parquet data file (relative to the table directory). */
  dataFileName: string;
  dataBytes: Buffer;
  /** Always {@link DELTA_FIRST_COMMIT}. */
  logFileName: string;
  /** Newline-delimited JSON actions: protocol, metaData, add. */
  logText: string;
  /** Rows encoded into the Parquet file — the same number `add.stats` reports. */
  numRecords: number;
  /** Resolved Delta type per column, in column order. */
  types: DeltaColumnType[];
}

/**
 * Build a complete, single-commit Delta table from a bundle's sample rows.
 *
 * Deterministic: the data-file name and the table id are derived from
 * `identity` (the table's ADLS path), so a re-install OVERWRITES the same two
 * objects rather than accumulating orphaned parts beside a stale log.
 */
export function buildDeltaTableFiles(opts: {
  /** Stable identity for the table — used for the file name + table id. */
  identity: string;
  /** Table name recorded in the Delta metadata. */
  tableName: string;
  columns: DdlColumn[];
  rows: any[][];
  /** Injectable clock so tests are deterministic. */
  now?: number;
}): DeltaTableFiles {
  const { identity, tableName, columns, rows } = opts;
  if (columns.length === 0) throw new Error('buildDeltaTableFiles: no columns');
  const now = opts.now ?? Date.now();
  const names = columns.map((c) => c.name);
  const types = resolveDeltaTypes(columns, rows);

  const dataBytes = buildParquetFile(names, types, rows);
  const dataFileName = `part-00000-${stableUuid(`${identity}#data`)}-c000.parquet`;

  const schemaString = JSON.stringify({
    type: 'struct',
    fields: names.map((name, i) => ({ name, type: types[i], nullable: true, metadata: {} })),
  });

  const nullCount: Record<string, number> = {};
  names.forEach((name, i) => {
    nullCount[name] = rows.reduce((acc, r) => {
      const v = Array.isArray(r) ? r[i] : undefined;
      return acc + (v === null || v === undefined ? 1 : 0);
    }, 0);
  });

  const logText =
    [
      JSON.stringify({ protocol: { minReaderVersion: 1, minWriterVersion: 2 } }),
      JSON.stringify({
        metaData: {
          id: stableUuid(`${identity}#table`),
          name: tableName,
          format: { provider: 'parquet', options: {} },
          schemaString,
          partitionColumns: [],
          configuration: {},
          createdTime: now,
        },
      }),
      JSON.stringify({
        add: {
          path: dataFileName,
          partitionValues: {},
          size: dataBytes.length,
          modificationTime: now,
          dataChange: true,
          // `numRecords` is what a post-deploy validation reads to decide the
          // table is loaded (#3905). It is the row count actually ENCODED.
          stats: JSON.stringify({ numRecords: rows.length, nullCount }),
        },
      }),
    ].join('\n') + '\n';

  return { dataFileName, dataBytes, logFileName: DELTA_FIRST_COMMIT, logText, numRecords: rows.length, types };
}

// ===========================================================================
// Materialization
// ===========================================================================

/** What the materialization achieved. The caller decides what is fatal. */
export interface LakehouseSeedResult {
  /** Bundle folder paths created under the root. */
  createdFolders: string[];
  /** Tables whose sample rows landed as a real Delta table. */
  seeded: string[];
  /** Table folders created with no rows (no sampleRows, or no derivable columns). */
  emptyTables: string[];
  /**
   * Declared folders whose directory create FAILED. Non-empty means the tree on
   * disk is not the tree the bundle declared.
   */
  failedFolders: string[];
  /**
   * Tables that were SUPPOSED to seed and did not — a failed directory create,
   * Parquet/Delta write, or an unencodable schema. Non-empty means the install
   * did not produce what it promised, and the caller must not report 'created'.
   */
  failedTables: string[];
  /**
   * Tables whose sample rows do not have one value per DDL column. The table is
   * still written (short rows pad with null, extra values are dropped) but the
   * mismatch is surfaced rather than silently absorbed — this is the shape that
   * hid the `SCD` corruption, where 9 values were written into 1 column.
   */
  arityMismatches: string[];
  /**
   * How many tables the bundle DECLARED with sample rows — i.e. how many
   * `seeded` entries a fully successful run produces. Computed here, at the
   * site that does the work, so the caller's verdict and this count can never
   * be two different methods disagreeing.
   */
  expectedSeedTables: number;
  /**
   * Set when a 401/403 aborted the work. The caller maps it to its own
   * remediation shape — no amount of retrying fixes a missing role.
   */
  authGate?: { status: number; message: string };
}

/** One seeded table, handed to `onTableSeeded` so the caller can register a view. */
export interface SeededTable {
  /** Sanitized table name (the directory leaf). */
  name: string;
  /** Schema the table belongs to when `schemasEnabled`, else ''. */
  schema: string;
  /** Container-relative path of the Delta table DIRECTORY (`…/Tables/<name>`). */
  tablePath: string;
  /** Container-relative path of the Parquet data file inside `tablePath`. */
  dataPath: string;
  /** Container-relative path of the human-readable seed CSV, or '' if it failed. */
  csvPath: string;
  /** Column names parsed from the table DDL. */
  columns: string[];
  /** Resolved Delta type per column, aligned to `columns`. */
  types: DeltaColumnType[];
  /** Rows written — the same number the Delta log's `add.stats` reports. */
  rowCount: number;
}

/**
 * Materialize a `LakehouseContent` bundle under `root` in `container`.
 *
 * The root directory itself is assumed to exist (both callers create it before
 * getting here — install as its first ADLS write, auto-bind as its `create()`).
 * Per-folder / per-table failures are logged into `steps` AND COUNTED into
 * `failedFolders` / `failedTables` rather than thrown, so one bad table cannot
 * sink a lakehouse — but the caller can still see that something failed. A
 * `steps.push('… failed …')` that does not change what the caller returns is
 * exactly the defect #3905 records; the counters are how that is avoided here.
 *
 * A 401/403 short-circuits into `authGate` because every subsequent write would
 * fail the same way.
 */
export async function seedLakehouseAdls(
  container: KnownContainer,
  root: string,
  content: any,
  steps: string[],
  onTableSeeded?: (t: SeededTable) => Promise<void>,
): Promise<LakehouseSeedResult> {
  const out: LakehouseSeedResult = {
    createdFolders: [],
    seeded: [],
    emptyTables: [],
    failedFolders: [],
    failedTables: [],
    arityMismatches: [],
    expectedSeedTables: 0,
  };

  const folders: Array<{ path: string; description?: string }> = Array.isArray(content?.folders)
    ? content.folders
    : [];
  const deltaTables: Array<{ name: string; ddl?: string; schema?: string; sampleRows?: any[][] }> =
    Array.isArray(content?.deltaTables) ? content.deltaTables : [];
  // F9 — multi-schema support. When schemasEnabled, tables live under
  // Tables/<schema>/<table>/ and register as `<schema>.<view>`; otherwise the
  // classic flat Tables/<table>/ layout is used.
  const schemasEnabled: boolean = content?.schemasEnabled === true;

  // How many tables a fully successful run seeds. Same filters the loop uses.
  out.expectedSeedTables = deltaTables.filter(
    (t) => !!safeAdlsRelPath(t?.name || '') && Array.isArray(t?.sampleRows) && t.sampleRows.length > 0,
  ).length;

  const authOf = (e: any): { status: number; message: string } | null =>
    e?.statusCode === 401 || e?.statusCode === 403
      ? { status: e.statusCode, message: e?.message || String(e) }
      : null;

  // 1. Every declared folder as a real directory.
  for (const f of folders) {
    const rel = safeAdlsRelPath(f?.path || '');
    if (!rel) continue;
    const dir = `${root}/${rel}`;
    try {
      await adlsCreateDirectory(container, dir);
      out.createdFolders.push(rel);
      steps.push(`Created folder ${container}/${dir}.`);
    } catch (e: any) {
      const auth = authOf(e);
      if (auth) { out.authGate = auth; return out; }
      out.failedFolders.push(rel);
      steps.push(`Folder ${rel}: create failed ${e?.statusCode || ''} ${e?.message || String(e)}`);
    }
  }

  // 2. Seed each deltaTable's sampleRows as a REAL Delta table under
  //    Tables/<name>/ — a Parquet data file plus a `_delta_log` commit whose
  //    `add.stats.numRecords` is the row count actually encoded. The table
  //    folder is created even when there are no sampleRows so the Tables/ tree
  //    is browsable; columns come from the DDL (array-of-array sampleRows are
  //    aligned to those columns).
  let seedDirReady = false;
  const seedDir = `${root}/Files/_seed`;

  for (const t of deltaTables) {
    const tName = safeAdlsRelPath(t?.name || '');
    if (!tName) continue;
    const tSchema = schemasEnabled ? (String(t.schema || 'dbo').replace(/[^A-Za-z0-9_]/g, '_') || 'dbo') : '';
    const tableDir = schemasEnabled ? `${root}/Tables/${tSchema}/${tName}` : `${root}/Tables/${tName}`;
    const rows = Array.isArray(t.sampleRows) ? t.sampleRows : [];
    try {
      await adlsCreateDirectory(container, tableDir);
    } catch (e: any) {
      const auth = authOf(e);
      if (auth) { out.authGate = auth; return out; }
      // Classified by what was PROMISED. A table with sample rows cannot seed
      // without its directory, so that is a failed TABLE and the caller's gate
      // must see it. A schema-only table's directory is browsability, not data
      // — it is recorded as a failed FOLDER, which keeps it out of the fatal
      // path for the same reason a declared folder's 409 is not fatal.
      if (rows.length > 0) out.failedTables.push(tName);
      else out.failedFolders.push(`Tables/${tName}`);
      steps.push(`Table ${tName}: directory create failed ${e?.message || String(e)}`);
      continue;
    }

    if (rows.length === 0) {
      out.emptyTables.push(tName);
      steps.push(`Table ${tName}: no sampleRows in bundle; created empty Tables/${tName}/.`);
      continue;
    }
    const columns = t.ddl ? parseDdlColumns(t.ddl) : [];
    if (columns.length === 0) {
      // The bundle PROMISED rows for this table, so this is a miss, not an
      // "empty" table: it counts toward `expectedSeedTables` and must therefore
      // be counted as failed rather than quietly filed under emptyTables.
      steps.push(
        `Table ${tName}: ${rows.length} sample row(s) declared but no columns could be derived from its DDL; ` +
          'nothing was written.',
      );
      out.failedTables.push(tName);
      continue;
    }

    // Arity disclosure. Short rows pad with null and extra values are dropped
    // (both happen in the shipped bundles); saying so is the point — the silent
    // version of exactly this is what wrote 9 values into a 1-column table.
    const arities = new Set(rows.map((r) => (Array.isArray(r) ? r.length : -1)));
    if (arities.size !== 1 || !arities.has(columns.length)) {
      out.arityMismatches.push(tName);
      steps.push(
        `Table ${tName}: DDL declares ${columns.length} column(s) but sample rows carry ` +
          `${Array.from(arities).sort((a, b) => a - b).join('/')} value(s); short rows are padded with NULL ` +
          'and surplus values are dropped.',
      );
    }

    // 2a. Human-readable seed CSV under Files/_seed/ — the same convention the
    //     Fabric backend uses for its Load-Table source. Deliberately NOT inside
    //     the Delta table directory: a file the log does not reference would
    //     inflate the table's reported size and confuse the catalog scanner.
    //     Best-effort — the Delta table below is the real artifact.
    let csvPath = '';
    try {
      if (!seedDirReady) {
        await adlsCreateDirectory(container, seedDir);
        seedDirReady = true;
      }
      csvPath = `${seedDir}/${tSchema ? `${tSchema}.` : ''}${tName}.csv`;
      await adlsUploadFile(container, csvPath, Buffer.from(buildCsv(columns.map((c) => c.name), rows), 'utf-8'), 'text/csv');
    } catch (e: any) {
      const auth = authOf(e);
      if (auth) { out.authGate = auth; return out; }
      csvPath = '';
      steps.push(`Table ${tName}: seed CSV write failed (non-fatal) ${e?.statusCode || ''} ${e?.message || String(e)}`);
    }

    // 2b. The Delta table itself. Parquet FIRST, then the commit that references
    //     it: an interrupted write then leaves an uncommitted data file rather
    //     than a log pointing at a file that does not exist.
    let delta: DeltaTableFiles;
    try {
      delta = buildDeltaTableFiles({ identity: `${container}/${tableDir}`, tableName: tName, columns, rows });
    } catch (e: any) {
      out.failedTables.push(tName);
      steps.push(`Table ${tName}: could not encode Delta table: ${e?.message || String(e)}`);
      continue;
    }

    const dataPath = `${tableDir}/${delta.dataFileName}`;
    const logPath = `${tableDir}/${delta.logFileName}`;
    try {
      await adlsUploadFile(container, dataPath, delta.dataBytes, 'application/octet-stream');
      await adlsCreateDirectory(container, `${tableDir}/_delta_log`);
      await adlsUploadFile(container, logPath, Buffer.from(delta.logText, 'utf-8'), 'application/json');
      out.seeded.push(tName);
      steps.push(
        `Table ${tName}: wrote Delta table to ${container}/${tableDir} — ` +
          `${delta.numRecords} row(s) in ${delta.dataFileName} (${delta.dataBytes.length} bytes) ` +
          `committed at ${delta.logFileName}.`,
      );
    } catch (e: any) {
      const auth = authOf(e);
      if (auth) { out.authGate = auth; return out; }
      out.failedTables.push(tName);
      steps.push(`Table ${tName}: Delta write failed ${e?.statusCode || ''} ${e?.message || String(e)}`);
      continue;
    }

    if (onTableSeeded) {
      // Best-effort: the view layer is a convenience over a table that is
      // already real, so its failure must never unwind a successful seed.
      try {
        await onTableSeeded({
          name: tName,
          schema: tSchema,
          tablePath: tableDir,
          dataPath,
          csvPath,
          columns: columns.map((c) => c.name),
          types: delta.types,
          rowCount: delta.numRecords,
        });
      } catch (e: any) {
        steps.push(`Table ${tName}: post-seed hook failed: ${e?.message || String(e)}`);
      }
    }
  }

  return out;
}
