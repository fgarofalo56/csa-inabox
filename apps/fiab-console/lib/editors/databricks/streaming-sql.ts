/**
 * streaming-sql.ts — typed builders for Databricks streaming tables +
 * materialized views authored in the SQL editor (Wave 10, DBX-7).
 *
 * The SQL Warehouse editor gains "New streaming table" / "New materialized
 * view" typed builders (dropdowns + inputs, no freeform JSON per
 * loom_no_freeform_config) plus refresh scheduling. This PURE, unit-tested
 * module compiles those typed inputs to the real Databricks SQL DDL executed
 * over the Statement Execution API:
 *
 *   - `buildCreateStreamingTable(spec)` → `CREATE OR REFRESH STREAMING TABLE …
 *      [(CONSTRAINT … EXPECT …)] [SCHEDULE …] AS SELECT … FROM STREAM
 *      read_files('<path>', format => '<fmt>')`  (or a table stream).
 *   - `buildCreateMaterializedView(spec)` → `CREATE OR REPLACE MATERIALIZED
 *      VIEW … [(constraints)] [SCHEDULE …] AS <query>`.
 *   - `buildRefreshStatement(objectKind, fullName, full)` → `REFRESH …`.
 *   - `buildAlterSchedule(objectKind, fullName, schedule)` → `ALTER … ADD
 *      SCHEDULE …` (or `DROP SCHEDULE`).
 *   - `formatSchedule(schedule)` → the shared `SCHEDULE EVERY|CRON …` clause.
 *
 * Grounded in Databricks SQL reference (CREATE STREAMING TABLE / CREATE
 * MATERIALIZED VIEW / ALTER … / REFRESH). Streaming tables + MVs are DLT-backed:
 * creating either auto-provisions a serverless Lakeflow pipeline (and a
 * scheduled refresh auto-creates a backing Databricks job), so this shares
 * DBX-3's DLT backing exactly as the PRP specifies.
 *
 * SQL-injection posture: identifiers are back-tick quoted via
 * `quoteIdent(name,'databricks-sql')`; string literals (ADLS paths, timezone,
 * cron) are escaped via `escapeSqlLiteral`. `query` / `condition` are
 * analyst-authored SQL fragments (same trust model as the SQL editor) emitted
 * verbatim.
 */

import { escapeSqlLiteral, quoteIdent } from '@/lib/sql/quoting';
import {
  DLT_FILE_FORMATS,
  DLT_EXPECTATION_ACTIONS,
  type DltFileFormat,
  type DltExpectationAction,
} from './dlt-spec';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** The two DLT-backed SQL object kinds this module authors. */
export type StreamingObjectKind = 'streaming_table' | 'materialized_view';

/** A three-part `catalog.schema.name` target (each part optional except name). */
export interface QualifiedName {
  catalog?: string;
  schema?: string;
  name: string;
}

/** A refresh schedule — EVERY interval OR a quartz CRON string. */
export type RefreshScheduleKind = 'manual' | 'every' | 'cron';

export type EveryUnit = 'HOUR' | 'HOURS' | 'DAY' | 'DAYS' | 'WEEK' | 'WEEKS';
export const EVERY_UNITS: readonly EveryUnit[] = ['HOUR', 'HOURS', 'DAY', 'DAYS', 'WEEK', 'WEEKS'];

export interface RefreshSchedule {
  kind: RefreshScheduleKind;
  /** EVERY: interval count (validated per-unit at build time). */
  everyNumber?: number;
  everyUnit?: EveryUnit;
  /** CRON: a 6-field quartz cron string. */
  cron?: string;
  /** CRON: optional IANA/Databricks timezone id (e.g. 'UTC'). */
  timezone?: string;
}

/** An inline expectation (constraint) on the created object. */
export interface StreamingExpectation {
  name: string;
  condition: string;
  action: DltExpectationAction;
}

/** A streaming-table source: Auto Loader files OR an upstream table stream. */
export interface StreamingSource {
  kind: 'files' | 'table';
  path?: string;          // files
  fileFormat?: DltFileFormat;
  tableName?: string;     // table (catalog.schema.table)
}

export interface CreateStreamingTableSpec {
  target: QualifiedName;
  source: StreamingSource;
  /** Optional explicit SELECT body — overrides the auto-generated one. */
  query?: string;
  comment?: string;
  expectations?: StreamingExpectation[];
  schedule?: RefreshSchedule;
}

export interface CreateMaterializedViewSpec {
  target: QualifiedName;
  /** The MV query body (required — an MV is defined by its SELECT). */
  query: string;
  comment?: string;
  expectations?: StreamingExpectation[];
  schedule?: RefreshSchedule;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sqlString(value: string): string {
  return `'${escapeSqlLiteral(value)}'`;
}

/** Back-tick quote a `catalog.schema.name`, dropping empty parts. */
export function quoteQualified(q: QualifiedName): string {
  return [q.catalog, q.schema, q.name]
    .filter((p): p is string => !!p && !!p.trim())
    .map((p) => quoteIdent(p.trim(), 'databricks-sql'))
    .join('.');
}

/** Quote an already-joined `a.b.c` full name part-by-part. */
export function quoteFullName(fullName: string): string {
  return fullName
    .split('.')
    .map((p) => quoteIdent(p.trim(), 'databricks-sql'))
    .join('.');
}

/** Validate a create spec's structural fields; returns problems (empty = OK). */
export function validateStreamingObject(
  kind: StreamingObjectKind,
  spec: CreateStreamingTableSpec | CreateMaterializedViewSpec,
): string[] {
  const problems: string[] = [];
  const nm = spec.target?.name?.trim();
  if (!nm) problems.push('Name is required.');
  else if (!IDENT_RE.test(nm)) problems.push(`"${nm}" is not a valid name (letters, digits, underscore).`);

  if (kind === 'streaming_table') {
    const st = spec as CreateStreamingTableSpec;
    const hasQuery = !!st.query?.trim();
    if (!hasQuery) {
      if (st.source?.kind === 'files' && !st.source.path?.trim()) problems.push('File source needs a path.');
      if (st.source?.kind === 'table' && !st.source.tableName?.trim()) problems.push('Table source needs a table name.');
      if (!st.source) problems.push('A source or an explicit query is required.');
    }
  } else {
    const mv = spec as CreateMaterializedViewSpec;
    if (!mv.query?.trim()) problems.push('A materialized view requires a query.');
  }

  for (const x of spec.expectations ?? []) {
    if (!x.name?.trim() || !IDENT_RE.test(x.name.trim())) problems.push(`Expectation "${x.name || '(unnamed)'}" needs a valid name.`);
    if (!x.condition?.trim()) problems.push(`Expectation "${x.name || '(unnamed)'}" needs a condition.`);
  }

  problems.push(...validateSchedule(spec.schedule));
  return problems;
}

/** Validate a schedule; returns problems (empty = OK / manual). */
export function validateSchedule(schedule?: RefreshSchedule): string[] {
  if (!schedule || schedule.kind === 'manual') return [];
  const problems: string[] = [];
  if (schedule.kind === 'every') {
    const n = schedule.everyNumber;
    const unit = schedule.everyUnit;
    if (!unit || !EVERY_UNITS.includes(unit)) {
      problems.push('Pick an interval unit.');
    } else if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      problems.push('Interval count must be a positive integer.');
    } else {
      // Databricks bounds: 1–72 HOUR(S), 1–31 DAY(S), 1–8 WEEK(S).
      const max = unit.startsWith('HOUR') ? 72 : unit.startsWith('DAY') ? 31 : 8;
      if (n > max) problems.push(`${unit} interval must be between 1 and ${max}.`);
    }
  } else if (schedule.kind === 'cron') {
    const cron = schedule.cron?.trim();
    if (!cron) problems.push('CRON expression is required.');
    else if (cron.split(/\s+/).length !== 6) {
      problems.push('Quartz CRON must have 6 fields: seconds minutes hours day-of-month month day-of-week.');
    }
  }
  return problems;
}

/**
 * The `SCHEDULE …` clause for a create/alter statement, or '' for manual.
 *   EVERY: `SCHEDULE EVERY <n> <UNIT>`
 *   CRON : `SCHEDULE CRON '<cron>' [AT TIME ZONE '<tz>']`
 */
export function formatSchedule(schedule?: RefreshSchedule): string {
  if (!schedule || schedule.kind === 'manual') return '';
  if (schedule.kind === 'every') {
    const unit = EVERY_UNITS.includes(schedule.everyUnit as EveryUnit) ? schedule.everyUnit : 'HOUR';
    const n = Number.isInteger(schedule.everyNumber) && (schedule.everyNumber as number) >= 1
      ? (schedule.everyNumber as number)
      : 1;
    return `SCHEDULE EVERY ${n} ${unit}`;
  }
  // cron
  const cron = (schedule.cron || '').trim();
  const tz = schedule.timezone?.trim();
  return `SCHEDULE CRON ${sqlString(cron)}${tz ? ` AT TIME ZONE ${sqlString(tz)}` : ''}`;
}

function sourceRelation(source: StreamingSource): string {
  if (source.kind === 'files') {
    const fmt = DLT_FILE_FORMATS.includes(source.fileFormat as DltFileFormat)
      ? (source.fileFormat as DltFileFormat)
      : 'json';
    return `STREAM read_files(${sqlString(source.path || '')}, format => ${sqlString(fmt)})`;
  }
  return `STREAM ${quoteFullName(source.tableName || '')}`;
}

function constraintBlock(expectations?: StreamingExpectation[]): string[] {
  const list = (expectations ?? []).filter((x) => x.name?.trim() && x.condition?.trim());
  if (list.length === 0) return [];
  const clauses = list.map((x) => {
    const base = `CONSTRAINT ${quoteIdent(x.name.trim(), 'databricks-sql')} EXPECT (${x.condition.trim()})`;
    const action: DltExpectationAction = DLT_EXPECTATION_ACTIONS.includes(x.action) ? x.action : 'warn';
    if (action === 'drop') return `  ${base} ON VIOLATION DROP ROW`;
    if (action === 'fail') return `  ${base} ON VIOLATION FAIL UPDATE`;
    return `  ${base}`;
  });
  return ['(', clauses.join(',\n'), ')'];
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** `CREATE OR REFRESH STREAMING TABLE …`. */
export function buildCreateStreamingTable(spec: CreateStreamingTableSpec): string {
  const lines: string[] = [`CREATE OR REFRESH STREAMING TABLE ${quoteQualified(spec.target)}`];
  lines.push(...constraintBlock(spec.expectations));
  const sched = formatSchedule(spec.schedule);
  if (sched) lines.push(sched);
  if (spec.comment?.trim()) lines.push(`COMMENT ${sqlString(spec.comment.trim())}`);
  const query = spec.query?.trim()
    ? spec.query.trim().replace(/;\s*$/, '')
    : `SELECT * FROM ${sourceRelation(spec.source)}`;
  lines.push(`AS ${query}`);
  return lines.join('\n') + ';';
}

/** `CREATE OR REPLACE MATERIALIZED VIEW …`. */
export function buildCreateMaterializedView(spec: CreateMaterializedViewSpec): string {
  const lines: string[] = [`CREATE OR REPLACE MATERIALIZED VIEW ${quoteQualified(spec.target)}`];
  lines.push(...constraintBlock(spec.expectations));
  const sched = formatSchedule(spec.schedule);
  if (sched) lines.push(sched);
  if (spec.comment?.trim()) lines.push(`COMMENT ${sqlString(spec.comment.trim())}`);
  lines.push(`AS ${spec.query.trim().replace(/;\s*$/, '')}`);
  return lines.join('\n') + ';';
}

/**
 * `REFRESH [MATERIALIZED VIEW|STREAMING TABLE] <name> [FULL]` — a manual
 * refresh that triggers the backing DLT pipeline update. `fullName` is the
 * object's `catalog.schema.name`.
 */
export function buildRefreshStatement(
  kind: StreamingObjectKind,
  fullName: string,
  full = false,
): string {
  const keyword = kind === 'streaming_table' ? 'STREAMING TABLE' : 'MATERIALIZED VIEW';
  return `REFRESH ${keyword} ${quoteFullName(fullName)}${full ? ' FULL' : ''};`;
}

/**
 * `ALTER [MATERIALIZED VIEW|STREAMING TABLE] <name> ADD SCHEDULE …` — set (or,
 * when `schedule.kind === 'manual'`, DROP) the refresh schedule of an existing
 * object. Setting a schedule auto-creates a backing Databricks job.
 */
export function buildAlterSchedule(
  kind: StreamingObjectKind,
  fullName: string,
  schedule: RefreshSchedule,
): string {
  const keyword = kind === 'streaming_table' ? 'STREAMING TABLE' : 'MATERIALIZED VIEW';
  const target = `ALTER ${keyword} ${quoteFullName(fullName)}`;
  if (!schedule || schedule.kind === 'manual') return `${target} DROP SCHEDULE;`;
  return `${target} ADD ${formatSchedule(schedule)};`;
}
