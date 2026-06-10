/**
 * dacpac-migration.ts — DACPAC schema parser, Synapse-Dedicated compatibility
 * assessor, and ordered T-SQL DDL generator. Pure, dependency-free, server-side.
 *
 * WHAT THIS IS
 * ------------
 * The Azure-native answer to Fabric's "Migration Assistant" (Build 2026 #22).
 * It lets an operator upload a SQL Server / Azure SQL `.dacpac` and:
 *   1. extract its schema model (tables, columns, indexes, views, procedures,
 *      schemas) from the embedded `model.xml`,
 *   2. assess each object against the documented Azure Synapse **Dedicated SQL
 *      pool** feature set and flag what won't import as-is,
 *   3. generate ordered, idempotent T-SQL DDL that recreates the supported
 *      schema in the target pool — which `/api/sqldb/migration/import` then
 *      executes over the real TDS connection.
 *
 * NO FABRIC DEPENDENCY: the target is the env-bound Synapse Dedicated SQL pool
 * (`LOOM_SYNAPSE_WORKSPACE` + `LOOM_SYNAPSE_DEDICATED_POOL`). Works with
 * `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
 *
 * DACPAC MODEL FORMAT
 * -------------------
 * Modern SSDT / SqlPackage DACPACs store the schema in `model.xml` as a flat
 * list of `<Element Type="Sql…" Name="[schema].[obj]">` nodes under
 * `<DataSchemaModel><Model>`. Columns/indexes hang off their table via
 * `<Relationship>` → `<Entry>` → `<Element>` / `<References>`. We parse the
 * subset needed to recreate DDL, using the repo's dependency-free
 * {@link parseXml}. Object scripts that SSDT inlines verbatim (views,
 * procedures, functions) are read from the `<Property Name="…Script">` /
 * `QueryScript` text and replayed as-is, with a compatibility pre-scan.
 *
 * COMPATIBILITY RULES — grounded in Microsoft Learn:
 *   - Unsupported table features (FK/CHECK constraints, computed columns,
 *     sequences, sparse columns, synonyms, triggers, unique indexes,
 *     user-defined types):
 *     https://learn.microsoft.com/azure/synapse-analytics/sql/develop-tables-overview#unsupported-table-features
 *   - Unsupported data types (xml, geometry, geography, hierarchyid, sql_variant,
 *     image, text, ntext, timestamp/rowversion):
 *     https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-tables-data-types
 *   - Unsupported T-SQL surface in views/procs (cursors, OPENXML, FOR XML/JSON,
 *     OFFSET/FETCH, triggers):
 *     https://learn.microsoft.com/azure/synapse-analytics/sql/overview-features
 */

import { parseXml, toArray, decodeXmlEntities, type XmlObject, type XmlValue } from './rdl-xml';
import { readZipTextEntry, ZipError } from './zip-reader';

// ---------------------------------------------------------------------------
// Parsed model shapes
// ---------------------------------------------------------------------------

export type Severity = 'blocker' | 'warning' | 'info';

export interface CompatFinding {
  /** Stable rule id (for tests / UI grouping). */
  rule: string;
  severity: Severity;
  /** Object the finding applies to (schema-qualified where known). */
  object: string;
  message: string;
  /** Microsoft Learn URL that documents the limitation. */
  doc?: string;
}

export interface DacColumn {
  name: string;
  /** e.g. "[int]", "[nvarchar](100)", "[decimal](18,2)" — raw SSDT type ref. */
  dataType: string;
  /** Base type name lowercased, no schema/brackets (e.g. "nvarchar"). */
  baseType: string;
  nullable: boolean;
  isIdentity: boolean;
  isComputed: boolean;
  computedExpr?: string;
  isSparse: boolean;
  length?: string; // "100" | "max"
  precision?: string;
  scale?: string;
}

export interface DacTable {
  schema: string;
  name: string;
  columns: DacColumn[];
}

export interface DacIndex {
  name: string;
  table: string; // schema.name
  unique: boolean;
  clustered: boolean;
  columns: string[];
}

export interface DacScripted {
  /** "view" | "procedure" | "function". */
  kind: 'view' | 'procedure' | 'function';
  schema: string;
  name: string;
  script: string;
}

export interface DacModel {
  databaseName: string;
  schemas: string[];
  tables: DacTable[];
  indexes: DacIndex[];
  scripted: DacScripted[];
  /** Object names that referenced features we don't even model (FKs etc.). */
  constraints: { name: string; table: string; kind: string }[];
  triggers: { name: string; table: string }[];
  sequences: string[];
  synonyms: string[];
  userDefinedTypes: string[];
}

export interface AssessmentResult {
  model: DacModel;
  findings: CompatFinding[];
  summary: {
    tables: number;
    views: number;
    procedures: number;
    functions: number;
    indexes: number;
    blockers: number;
    warnings: number;
  };
}

export class DacpacError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DacpacError';
  }
}

// ---------------------------------------------------------------------------
// Synapse Dedicated compatibility knowledge (grounded in Learn — see header)
// ---------------------------------------------------------------------------

const UNSUPPORTED_TYPES: Record<string, string> = {
  xml: 'XML data type is not supported in dedicated SQL pool.',
  geometry: 'Spatial type geometry is not supported in dedicated SQL pool.',
  geography: 'Spatial type geography is not supported in dedicated SQL pool.',
  hierarchyid: 'hierarchyid is not supported in dedicated SQL pool.',
  sql_variant: 'sql_variant is not supported in dedicated SQL pool.',
  image: 'image is deprecated/unsupported — use varbinary(max).',
  text: 'text is deprecated/unsupported — use varchar(max).',
  ntext: 'ntext is deprecated/unsupported — use nvarchar(max).',
  timestamp: 'timestamp/rowversion is not supported in dedicated SQL pool.',
  rowversion: 'timestamp/rowversion is not supported in dedicated SQL pool.',
};

const TYPES_DOC =
  'https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-tables-data-types#identify-unsupported-data-types';
const TABLES_DOC =
  'https://learn.microsoft.com/azure/synapse-analytics/sql/develop-tables-overview#unsupported-table-features';
const FEATURES_DOC = 'https://learn.microsoft.com/azure/synapse-analytics/sql/overview-features';

/** T-SQL constructs that fail in a dedicated-pool view/proc body. */
const SCRIPT_PATTERNS: { rule: string; severity: Severity; re: RegExp; message: string }[] = [
  { rule: 'cursor', severity: 'blocker', re: /\bDECLARE\b[^;]*\bCURSOR\b/i, message: 'Cursors are not supported in dedicated SQL pool.' },
  { rule: 'for-xml', severity: 'blocker', re: /\bFOR\s+XML\b/i, message: 'FOR XML is not supported in dedicated SQL pool.' },
  { rule: 'for-json', severity: 'warning', re: /\bFOR\s+JSON\b/i, message: 'FOR JSON may not be supported in dedicated SQL pool.' },
  { rule: 'openxml', severity: 'blocker', re: /\bOPENXML\b/i, message: 'OPENXML is not supported in dedicated SQL pool.' },
  { rule: 'openrowset', severity: 'warning', re: /\bOPENROWSET\b/i, message: 'OPENROWSET is not supported in dedicated SQL pool (supported in serverless).' },
  { rule: 'offset-fetch', severity: 'warning', re: /\bOFFSET\b[\s\S]{0,40}\bFETCH\b/i, message: 'OFFSET/FETCH is not supported in dedicated SQL pool — rewrite with TOP/ROW_NUMBER().' },
  { rule: 'merge', severity: 'info', re: /\bMERGE\b\s+(?:INTO\s+)?\[?\w/i, message: 'MERGE is in preview on dedicated SQL pool — verify after import.' },
  { rule: 'sp-prefix', severity: 'info', re: /\bCREATE\s+(?:OR\s+ALTER\s+)?PROC(?:EDURE)?\s+\[?dbo\]?\.?\[?sp_/i, message: 'Procedures named sp_* shadow system procedures — rename recommended.' },
];

// ---------------------------------------------------------------------------
// XML helpers (operate on parseXml output)
// ---------------------------------------------------------------------------

/** Read an `@_Attr` off a parsed node, tolerating string-collapsed nodes. */
function attr(node: XmlValue | undefined, key: string): string {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
  const v = (node as XmlObject)[`@_${key}`];
  return typeof v === 'string' ? v : '';
}

function childObjects(node: XmlValue | undefined, key: string): XmlObject[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  return toArray((node as XmlObject)[key]).filter(
    (v): v is XmlObject => typeof v === 'object' && v !== null && !Array.isArray(v),
  );
}

/** Split a SSDT object name "[schema].[name]" into parts (brackets stripped). */
function splitName(qualified: string): { schema: string; name: string } {
  const m = qualified.match(/\[([^\]]+)\]\.\[([^\]]+)\]/);
  if (m) return { schema: m[1], name: m[2] };
  // Fall back to dotted/unbracketed.
  const parts = qualified.replace(/[[\]]/g, '').split('.');
  if (parts.length >= 2) return { schema: parts[parts.length - 2], name: parts[parts.length - 1] };
  return { schema: 'dbo', name: parts[0] || qualified };
}

/** Find a Property value by name within an Element node. */
function propValue(el: XmlObject, name: string): string {
  for (const p of childObjects(el, 'Property')) {
    if (attr(p, 'Name') === name) {
      const v = attr(p, 'Value');
      if (v) return v;
      // Long values are stored as <Value> child text.
      const valChild = (p as XmlObject)['Value'];
      if (typeof valChild === 'string') return valChild;
      if (valChild && typeof valChild === 'object') {
        const t = (valChild as XmlObject)['#text'];
        if (typeof t === 'string') return t;
      }
    }
  }
  return '';
}

/** Resolve the referenced element name(s) for a named Relationship. */
function relationshipRefs(el: XmlObject, relName: string): string[] {
  const out: string[] = [];
  for (const rel of childObjects(el, 'Relationship')) {
    if (attr(rel, 'Name') !== relName) continue;
    for (const entry of childObjects(rel, 'Entry')) {
      for (const ref of childObjects(entry, 'References')) {
        const n = attr(ref, 'Name');
        if (n) out.push(n);
      }
      // Inline element entries (columns are nested Elements).
      for (const inner of childObjects(entry, 'Element')) {
        const n = attr(inner, 'Name');
        if (n) out.push(n);
      }
    }
  }
  return out;
}

/** Inline column/index Elements nested under a Relationship entry. */
function relationshipElements(el: XmlObject, relName: string): XmlObject[] {
  const out: XmlObject[] = [];
  for (const rel of childObjects(el, 'Relationship')) {
    if (attr(rel, 'Name') !== relName) continue;
    for (const entry of childObjects(rel, 'Entry')) {
      for (const inner of childObjects(entry, 'Element')) out.push(inner);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse a column Element (SqlSimpleColumn / SqlComputedColumn). */
function parseColumn(colEl: XmlObject): DacColumn {
  const { name } = splitName(attr(colEl, 'Name'));
  const type = attr(colEl, 'Type');
  const isComputed = type === 'SqlComputedColumn';
  // Type ref: Relationship "TypeSpecifier" → SqlTypeSpecifier element with
  // a "Type" relationship to the SqlBuiltInType, plus Length/Scale props.
  let baseType = '';
  let length: string | undefined;
  let precision: string | undefined;
  let scale: string | undefined;
  const typeSpecifiers = relationshipElements(colEl, 'TypeSpecifier');
  for (const ts of typeSpecifiers) {
    const typeRefs = relationshipRefs(ts, 'Type');
    if (typeRefs.length) baseType = splitName(typeRefs[0]).name.toLowerCase();
    const len = propValue(ts, 'Length');
    if (len) length = len;
    if (propValue(ts, 'IsMax') === 'True') length = 'max';
    const prec = propValue(ts, 'Precision');
    if (prec) precision = prec;
    const sc = propValue(ts, 'Scale');
    if (sc) scale = sc;
  }

  const nullableProp = propValue(colEl, 'IsNullable');
  const nullable = nullableProp === '' ? true : nullableProp !== 'False';
  const isIdentity = propValue(colEl, 'IsIdentity') === 'True';
  const isSparse = propValue(colEl, 'IsSparse') === 'True';
  const computedExpr = isComputed ? decodeXmlEntities(propValue(colEl, 'ExpressionScript') || propValue(colEl, 'Expression')) : undefined;

  // Build a renderable dataType string.
  let dataType = baseType ? `[${baseType}]` : '[nvarchar]';
  if (length) dataType += `(${length})`;
  else if (precision && scale) dataType += `(${precision}, ${scale})`;
  else if (precision) dataType += `(${precision})`;

  return {
    name,
    dataType,
    baseType,
    nullable,
    isIdentity,
    isComputed,
    computedExpr,
    isSparse,
    length,
    precision,
    scale,
  };
}

/**
 * Parse a DACPAC buffer into a {@link DacModel}. Throws {@link DacpacError}
 * with an honest message when the archive is not a readable DACPAC.
 */
export function parseDacpac(buf: Buffer): DacModel {
  let modelXml: string | null;
  try {
    modelXml = readZipTextEntry(buf, 'model.xml');
  } catch (e) {
    if (e instanceof ZipError) throw new DacpacError(`Could not read .dacpac archive: ${e.message}`);
    throw e;
  }
  if (!modelXml) {
    throw new DacpacError(
      'This file does not contain a model.xml part — it is not a valid .dacpac (a .dacpac is a ZIP produced by SqlPackage/SSDT).',
    );
  }

  let parsed: XmlObject;
  try {
    parsed = parseXml(modelXml);
  } catch (e: any) {
    throw new DacpacError(`Failed to parse model.xml: ${e?.message || String(e)}`);
  }

  // Root: <DataSchemaModel><Model><Element …/>…  — tolerate either nesting.
  const dataSchemaModel = (parsed['DataSchemaModel'] as XmlObject) || parsed;
  const modelNode = (dataSchemaModel['Model'] as XmlObject) || (parsed['Model'] as XmlObject) || dataSchemaModel;
  const elements = childObjects(modelNode, 'Element');

  const model: DacModel = {
    databaseName: attr(dataSchemaModel, 'Name') || 'ImportedDatabase',
    schemas: [],
    tables: [],
    indexes: [],
    scripted: [],
    constraints: [],
    triggers: [],
    sequences: [],
    synonyms: [],
    userDefinedTypes: [],
  };
  const schemaSet = new Set<string>();

  for (const el of elements) {
    const type = attr(el, 'Type');
    const qualified = attr(el, 'Name');
    switch (type) {
      case 'SqlSchema': {
        const { name } = splitName(qualified);
        if (name && name !== 'dbo') schemaSet.add(name);
        break;
      }
      case 'SqlTable': {
        const { schema, name } = splitName(qualified);
        schemaSet.add(schema);
        const colEls = relationshipElements(el, 'Columns');
        const columns = colEls
          .filter((c) => {
            const t = attr(c, 'Type');
            return t === 'SqlSimpleColumn' || t === 'SqlComputedColumn';
          })
          .map(parseColumn);
        model.tables.push({ schema, name, columns });
        break;
      }
      case 'SqlIndex':
      case 'SqlUniqueConstraint':
      case 'SqlPrimaryKeyConstraint': {
        const { name } = splitName(qualified);
        const tableRefs = relationshipRefs(el, 'IndexedObject').concat(relationshipRefs(el, 'DefiningTable'));
        const tableRef = tableRefs[0] ? (() => { const p = splitName(tableRefs[0]); return `${p.schema}.${p.name}`; })() : '';
        const colEls = relationshipRefs(el, 'ColumnSpecifications').concat(relationshipRefs(el, 'Columns'));
        const cols = colEls.map((c) => splitName(c).name).filter(Boolean);
        model.indexes.push({
          name: name || `IX_${model.indexes.length}`,
          table: tableRef,
          unique: type !== 'SqlIndex' || propValue(el, 'IsUnique') === 'True',
          clustered: propValue(el, 'IsClustered') === 'True' || type === 'SqlPrimaryKeyConstraint',
          columns: cols,
        });
        break;
      }
      case 'SqlView':
      case 'SqlProcedure':
      case 'SqlScalarFunction':
      case 'SqlInlineTableValuedFunction':
      case 'SqlMultiStatementTableValuedFunction': {
        const { schema, name } = splitName(qualified);
        schemaSet.add(schema);
        const script = decodeXmlEntities(propValue(el, 'QueryScript') || propValue(el, 'BodyScript') || propValue(el, 'Definition'));
        const kind: DacScripted['kind'] = type === 'SqlView' ? 'view' : type === 'SqlProcedure' ? 'procedure' : 'function';
        if (script) model.scripted.push({ kind, schema, name, script });
        break;
      }
      case 'SqlForeignKeyConstraint':
        model.constraints.push({ name: splitName(qualified).name, table: '', kind: 'FOREIGN KEY' });
        break;
      case 'SqlCheckConstraint':
        model.constraints.push({ name: splitName(qualified).name, table: '', kind: 'CHECK' });
        break;
      case 'SqlDmlTrigger':
      case 'SqlDdlTrigger':
        model.triggers.push({ name: splitName(qualified).name, table: '' });
        break;
      case 'SqlSequence':
        model.sequences.push(splitName(qualified).name);
        break;
      case 'SqlSynonym':
        model.synonyms.push(splitName(qualified).name);
        break;
      case 'SqlUserDefinedType':
      case 'SqlTableType':
        model.userDefinedTypes.push(splitName(qualified).name);
        break;
      default:
        break;
    }
  }

  model.schemas = Array.from(schemaSet).filter((s) => s && s !== 'dbo').sort();
  return model;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/** Run the Synapse-Dedicated compatibility assessment over a parsed model. */
export function assessModel(model: DacModel): CompatFinding[] {
  const findings: CompatFinding[] = [];

  for (const table of model.tables) {
    const fq = `${table.schema}.${table.name}`;
    for (const col of table.columns) {
      const bad = UNSUPPORTED_TYPES[col.baseType];
      if (bad) {
        findings.push({ rule: 'unsupported-type', severity: 'blocker', object: `${fq}.${col.name}`, message: bad, doc: TYPES_DOC });
      }
      if (col.isComputed) {
        findings.push({ rule: 'computed-column', severity: 'blocker', object: `${fq}.${col.name}`, message: 'Computed columns are not supported in dedicated SQL pool.', doc: TABLES_DOC });
      }
      if (col.isSparse) {
        findings.push({ rule: 'sparse-column', severity: 'warning', object: `${fq}.${col.name}`, message: 'Sparse columns are not supported — the column imports as a normal column.', doc: TABLES_DOC });
      }
    }
    if (table.columns.length === 0) {
      findings.push({ rule: 'empty-table', severity: 'warning', object: fq, message: 'No columns parsed for this table — verify the DACPAC.', doc: TABLES_DOC });
    }
  }

  for (const idx of model.indexes) {
    if (idx.unique && !idx.clustered) {
      findings.push({ rule: 'unique-index', severity: 'warning', object: `${idx.table} / ${idx.name}`, message: 'Unique nonclustered indexes are not enforced in dedicated SQL pool — created as a non-unique index.', doc: TABLES_DOC });
    }
  }

  for (const c of model.constraints) {
    findings.push({ rule: 'constraint', severity: 'warning', object: c.name, message: `${c.kind} constraints are not enforced in dedicated SQL pool — skipped during import.`, doc: TABLES_DOC });
  }
  for (const t of model.triggers) {
    findings.push({ rule: 'trigger', severity: 'blocker', object: t.name, message: 'Triggers are not supported in dedicated SQL pool — skipped during import.', doc: TABLES_DOC });
  }
  for (const s of model.sequences) {
    findings.push({ rule: 'sequence', severity: 'blocker', object: s, message: 'Sequences are not supported — use IDENTITY columns instead. Skipped during import.', doc: TABLES_DOC });
  }
  for (const s of model.synonyms) {
    findings.push({ rule: 'synonym', severity: 'blocker', object: s, message: 'Synonyms are not supported in dedicated SQL pool. Skipped during import.', doc: TABLES_DOC });
  }
  for (const u of model.userDefinedTypes) {
    findings.push({ rule: 'udt', severity: 'blocker', object: u, message: 'User-defined / table types are not supported in dedicated SQL pool. Skipped during import.', doc: TABLES_DOC });
  }

  for (const s of model.scripted) {
    for (const pat of SCRIPT_PATTERNS) {
      if (pat.re.test(s.script)) {
        findings.push({ rule: pat.rule, severity: pat.severity, object: `${s.schema}.${s.name}`, message: pat.message, doc: FEATURES_DOC });
      }
    }
  }

  return findings;
}

/** Full assessment: parse + assess + summarize. */
export function assessDacpac(buf: Buffer): AssessmentResult {
  const model = parseDacpac(buf);
  const findings = assessModel(model);
  return {
    model,
    findings,
    summary: {
      tables: model.tables.length,
      views: model.scripted.filter((s) => s.kind === 'view').length,
      procedures: model.scripted.filter((s) => s.kind === 'procedure').length,
      functions: model.scripted.filter((s) => s.kind === 'function').length,
      indexes: model.indexes.length,
      blockers: findings.filter((f) => f.severity === 'blocker').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
    },
  };
}

// ---------------------------------------------------------------------------
// DDL generation
// ---------------------------------------------------------------------------

export interface DdlPlan {
  /** Ordered, individually-runnable T-SQL batches. */
  statements: { kind: string; object: string; sql: string; skipped?: boolean; reason?: string }[];
}

/** Quote an identifier for T-SQL, escaping embedded close-brackets. */
function ident(name: string): string {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

/**
 * Build ordered, idempotent DDL for the supported subset of a model. Objects
 * that the assessment flags as blockers are emitted as commented, skipped
 * statements so the receipt is honest about what was and wasn't applied.
 *
 * Order: schemas → tables → indexes → views → functions → procedures.
 * Each statement is independently re-runnable (IF NOT EXISTS / DROP+CREATE).
 */
export function buildDdlPlan(model: DacModel, findings: CompatFinding[]): DdlPlan {
  const blockedObjects = new Set(findings.filter((f) => f.severity === 'blocker').map((f) => f.object));
  const statements: DdlPlan['statements'] = [];

  // 1. Schemas
  for (const schema of model.schemas) {
    statements.push({
      kind: 'schema',
      object: schema,
      sql: `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = '${schema.replace(/'/g, "''")}')\n  EXEC('CREATE SCHEMA ${ident(schema)}');`,
    });
  }

  // 2. Tables (CTAS-free — plain CREATE TABLE with a default ROUND_ROBIN dist).
  for (const table of model.tables) {
    const fq = `${table.schema}.${table.name}`;
    const colDefs: string[] = [];
    let skippedCols = 0;
    for (const col of table.columns) {
      // Skip unsupported-typed / computed columns — they're flagged as blockers.
      if (blockedObjects.has(`${fq}.${col.name}`)) { skippedCols++; continue; }
      let def = `  ${ident(col.name)} ${col.dataType}`;
      if (col.isIdentity) def += ' IDENTITY(1,1)';
      def += col.nullable ? ' NULL' : ' NOT NULL';
      colDefs.push(def);
    }
    if (colDefs.length === 0) {
      statements.push({ kind: 'table', object: fq, sql: `-- skipped: no supported columns`, skipped: true, reason: 'all columns unsupported' });
      continue;
    }
    const reason = skippedCols ? ` -- ${skippedCols} unsupported column(s) skipped` : '';
    const sql =
      `IF OBJECT_ID('${ident(table.schema)}.${ident(table.name)}','U') IS NULL\nCREATE TABLE ${ident(table.schema)}.${ident(table.name)} (\n${colDefs.join(',\n')}\n)\nWITH ( DISTRIBUTION = ROUND_ROBIN, CLUSTERED COLUMNSTORE INDEX );${reason}`;
    statements.push({ kind: 'table', object: fq, sql });
  }

  // 3. Indexes (supported = nonclustered, non-unique-enforced).
  for (const idx of model.indexes) {
    if (!idx.table || idx.columns.length === 0) continue;
    if (blockedObjects.has(idx.name)) continue;
    const p = idx.table.split('.');
    const schema = p.length > 1 ? p[0] : 'dbo';
    const tbl = p[p.length - 1];
    // PK/clustered → CLUSTERED COLUMNSTORE already created with the table; only
    // emit secondary nonclustered indexes here.
    if (idx.clustered) continue;
    const cols = idx.columns.map(ident).join(', ');
    const sql =
      `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${idx.name.replace(/'/g, "''")}' AND object_id = OBJECT_ID('${ident(schema)}.${ident(tbl)}'))\nCREATE INDEX ${ident(idx.name)} ON ${ident(schema)}.${ident(tbl)} (${cols});`;
    statements.push({ kind: 'index', object: `${idx.table}.${idx.name}`, sql });
  }

  // 4/5/6. Scripted objects — replay verbatim with CREATE OR ALTER, skipping
  // blocked ones. Views first, then functions, then procedures.
  const order: DacScripted['kind'][] = ['view', 'function', 'procedure'];
  for (const kind of order) {
    for (const s of model.scripted.filter((x) => x.kind === kind)) {
      const fq = `${s.schema}.${s.name}`;
      if (blockedObjects.has(fq)) {
        statements.push({ kind, object: fq, sql: `-- skipped (incompatible T-SQL): ${fq}`, skipped: true, reason: 'incompatible T-SQL' });
        continue;
      }
      const body = normalizeCreateOrAlter(s.script);
      statements.push({ kind, object: fq, sql: body });
    }
  }

  return statements.length ? { statements } : { statements };
}

/**
 * Normalize a CREATE script to CREATE OR ALTER for idempotent replay. SSDT
 * stores the original `CREATE VIEW/PROC/FUNCTION …` text; dedicated SQL pool
 * supports CREATE OR ALTER for views/procs/functions, so a single in-place
 * replay is re-runnable.
 */
function normalizeCreateOrAlter(script: string): string {
  return script.replace(/\bCREATE\s+(VIEW|PROC(?:EDURE)?|FUNCTION)\b/i, (_m, kw) => `CREATE OR ALTER ${kw}`);
}
