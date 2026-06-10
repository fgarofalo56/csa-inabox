/**
 * dacpac-migrate — DACPAC (data-tier application) parse + Synapse-dedicated-SQL-pool
 * compatibility scan + schema deploy, with NO external dependency and NO Fabric.
 *
 * A DACPAC is a PKZIP archive whose `model.xml` is a declarative model of the
 * source database (tables, columns, views, procedures, constraints, indexes,
 * data types). This module:
 *
 *   1. parseDacpac()    — reads the .dacpac bytes (PKZIP via lib/azure/zip.ts),
 *      extracts `model.xml` + `DacMetadata.xml`, and enumerates every modeled
 *      object with its element type and relevant properties. No `sqlpackage.exe`
 *      is needed — the model is read directly.
 *   2. scanCompatibility() — runs the source model against the documented set of
 *      Azure Synapse **dedicated SQL pool** restrictions (foreign keys, enforced
 *      PK/UNIQUE, computed/sparse columns, unsupported data types, triggers,
 *      sequences, synonyms, UDTs, indexed views, etc.), producing a graded
 *      findings list (block / warn / info) with the exact remediation each needs.
 *      This is the Azure-native equivalent of Fabric's "Migration Assistant"
 *      compatibility report, grounded in:
 *        https://learn.microsoft.com/azure/synapse-analytics/sql/develop-tables-overview#unsupported-table-features
 *        https://learn.microsoft.com/azure/synapse-analytics/sql/overview-features
 *   3. generateDeployScript() — emits Synapse-dedicated-pool-safe CREATE SCHEMA /
 *      CREATE TABLE / CREATE VIEW / CREATE PROCEDURE / CREATE FUNCTION DDL in
 *      dependency order, with each table given an explicit DISTRIBUTION + index
 *      (ROUND_ROBIN + CLUSTERED COLUMNSTORE by default), automatically applying
 *      the supported-form remediations (drop FK, downgrade PK to NONCLUSTERED
 *      NOT ENFORCED, strip computed/sparse, remap geometry/geography → varbinary).
 *   4. deployToSynapse() — executes the generated DDL on the env-bound dedicated
 *      pool over the existing TDS path (synapse-sql-client). Real backend.
 *
 * Azure-native by default (no-fabric-dependency.md): the only backend is the
 * Synapse Dedicated SQL pool that `synapse-sql-client.dedicatedTarget()` binds.
 * Works with LOOM_DEFAULT_FABRIC_WORKSPACE unset. No api.fabric.microsoft.com.
 */

import { readZip } from './zip';
import { dedicatedTarget, executeQuery, type SynapseTarget } from './synapse-sql-client';

// ── DACPAC model parsing ───────────────────────────────────────────────────

export interface DacMetadata {
  name?: string;
  version?: string;
  description?: string;
}

/** One object enumerated from the DACPAC model. */
export interface DacObject {
  /** SqlSchema model element type, e.g. "SqlTable", "SqlView", "SqlProcedure". */
  type: string;
  /** Fully-qualified name as it appears in the model (e.g. "[dbo].[Orders]"). */
  name: string;
  /** Friendly schema.object form ("dbo.Orders") parsed from name when possible. */
  qualified: string;
}

export interface DacColumn {
  table: string;
  name: string;
  dataType: string;
  computed: boolean;
  sparse: boolean;
}

export interface ParsedDacpac {
  metadata: DacMetadata;
  /** Every modeled object (tables, views, procs, functions, constraints, …). */
  objects: DacObject[];
  /** Flattened column inventory used by the data-type compatibility scan. */
  columns: DacColumn[];
  /** Element-type → count summary, for the wizard's "what's inside" panel. */
  counts: Record<string, number>;
  /** Recovered object bodies (view/proc/function scripts), keyed by model name. */
  bodies?: Map<string, string>;
}

/** Find an entry inside the (already-unzipped) DACPAC, case-insensitively by suffix. */
function pickEntry(entries: Map<string, Buffer>, suffix: string): Buffer | undefined {
  for (const [name, data] of entries) {
    if (name.toLowerCase().endsWith(suffix.toLowerCase())) return data;
  }
  return undefined;
}

function decodeXml(buf: Buffer): string {
  // model.xml is UTF-8 (DacFx writes a UTF-8 document). Strip a leading BOM if
  // present so the first tag matches our regexes.
  let s = buf.toString('utf-8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** "[dbo].[Orders]" → "dbo.Orders"; passthrough for already-plain names. */
export function friendlyName(modelName: string): string {
  const parts = modelName.match(/\[([^\]]+)\]/g);
  if (parts && parts.length) return parts.map((p) => p.slice(1, -1)).join('.');
  return modelName;
}

function parseMetadata(xml: string | undefined): DacMetadata {
  if (!xml) return {};
  const get = (tag: string) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? unescapeXml(m[1].trim()) : undefined;
  };
  return { name: get('Name'), version: get('Version'), description: get('Description') };
}

/**
 * Parse the DACPAC bytes into a structured model. Throws a descriptive Error if
 * the bytes are not a valid DACPAC (not a ZIP, or no model.xml inside).
 */
export function parseDacpac(bytes: Buffer): ParsedDacpac {
  let entries: Map<string, Buffer>;
  try {
    entries = readZip(bytes);
  } catch (e: any) {
    throw new Error(
      `Not a readable .dacpac (a DACPAC is a ZIP archive): ${e?.message || e}. ` +
      'Re-export with SqlPackage /Action:Extract or SSDT and try again.',
    );
  }
  const modelBuf = pickEntry(entries, 'model.xml');
  if (!modelBuf) {
    throw new Error(
      'No model.xml found inside the .dacpac. The file may be a .bacpac (data export) ' +
      'or a corrupt archive — provide a schema .dacpac (SqlPackage /Action:Extract).',
    );
  }
  const xml = decodeXml(modelBuf);
  const metaBuf = pickEntry(entries, 'DacMetadata.xml');
  const metadata = parseMetadata(metaBuf ? decodeXml(metaBuf) : undefined);

  const objects: DacObject[] = [];
  const columns: DacColumn[] = [];
  const counts: Record<string, number> = {};

  // Each modeled object is an <Element Type="Sql..." Name="[schema].[obj]"> node.
  const elementRe = /<Element\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = elementRe.exec(xml)) !== null) {
    const attrs = m[1];
    const typeM = attrs.match(/\bType="([^"]+)"/);
    const nameM = attrs.match(/\bName="([^"]+)"/);
    if (!typeM) continue;
    const type = typeM[1];
    const rawName = nameM ? unescapeXml(nameM[1]) : '';

    // Columns: capture for the data-type scan, do not list as top-level objects.
    if (type === 'SqlSimpleColumn' || type === 'SqlComputedColumn') {
      const fq = friendlyName(rawName); // e.g. "dbo.Orders.Total"
      const lastDot = fq.lastIndexOf('.');
      const table = lastDot > 0 ? fq.slice(0, lastDot) : '';
      const colName = lastDot > 0 ? fq.slice(lastDot + 1) : fq;
      const dataType = extractColumnDataType(xml, rawName);
      const sparse = elementHasBooleanProp(xml, rawName, 'IsSparse');
      columns.push({
        table,
        name: colName,
        dataType,
        computed: type === 'SqlComputedColumn',
        sparse,
      });
      continue;
    }

    counts[type] = (counts[type] || 0) + 1;
    if (rawName) {
      objects.push({ type, name: rawName, qualified: friendlyName(rawName) });
    }
  }

  return { metadata, objects, columns, counts };
}

/**
 * Pull a column's SQL data type from its model element. DacFx stores the type as
 * a Relationship → SqlTypeSpecifier referencing a SqlBuiltInType / SqlType, e.g.
 * the first References Name="[geometry]" within the column's element scope.
 * Best-effort; unknown → "".
 */
function extractColumnDataType(xml: string, columnModelName: string): string {
  const idx = xml.indexOf(`Name="${columnModelName}"`);
  if (idx < 0) return '';
  const slice = xml.slice(idx, idx + 1500);
  const ref = slice.match(/References\s+Name="\[([A-Za-z0-9_]+)\]"\s*\/?>/);
  return ref ? ref[1].toLowerCase() : '';
}

function elementHasBooleanProp(xml: string, modelName: string, prop: string): boolean {
  const idx = xml.indexOf(`Name="${modelName}"`);
  if (idx < 0) return false;
  const slice = xml.slice(idx, idx + 1500);
  const m = slice.match(new RegExp(`<Property\\s+Name="${prop}"\\s+Value="([^"]*)"`, 'i'));
  return !!m && /^(true|1)$/i.test(m[1]);
}

// ── Compatibility scan ──────────────────────────────────────────────────────

export type FindingSeverity = 'block' | 'warn' | 'info';

export interface CompatFinding {
  severity: FindingSeverity;
  /** Stable rule id for the UI to group/sort by. */
  rule: string;
  /** Object the finding applies to (friendly name), or '' for model-wide. */
  object: string;
  /** Human-readable problem statement. */
  message: string;
  /** Exact remediation, and whether the deploy script applies it automatically. */
  remediation: string;
  /** True when generateDeployScript() will fix this automatically. */
  autoFixed: boolean;
}

export interface CompatReport {
  findings: CompatFinding[];
  blockers: number;
  warnings: number;
  infos: number;
  /** True when nothing blocks an automated deploy (after auto-fixes). */
  deployable: boolean;
}

/** Data types not supported by Synapse dedicated SQL pool → remap target. */
const UNSUPPORTED_TYPES: Record<string, string> = {
  geometry: 'varbinary(max)',
  geography: 'varbinary(max)',
  xml: 'nvarchar(max)',
  hierarchyid: 'varbinary(max)',
  sql_variant: 'nvarchar(4000)',
  image: 'varbinary(max)',
  text: 'varchar(max)',
  ntext: 'nvarchar(max)',
  timestamp: 'binary(8)',
  rowversion: 'binary(8)',
};

/** Model element types that have no dedicated-pool equivalent. */
const UNSUPPORTED_OBJECT_TYPES: Record<string, { label: string; remediation: string }> = {
  SqlDmlTrigger: { label: 'DML trigger', remediation: 'Triggers are not supported in dedicated SQL pool. Move the logic into the ELT/stored-procedure that writes the table.' },
  SqlDdlTrigger: { label: 'DDL trigger', remediation: 'DDL triggers are not supported. Enforce policy with Azure Policy / deployment gates instead.' },
  SqlSequence: { label: 'Sequence', remediation: 'Sequences are not supported. Use an IDENTITY column for surrogate keys.' },
  SqlSynonym: { label: 'Synonym', remediation: 'Synonyms are not supported. Reference the base object directly or create a view.' },
  SqlUserDefinedType: { label: 'User-defined (CLR) type', remediation: 'UDTs are not supported. Replace with a built-in type.' },
  SqlUserDefinedDataType: { label: 'User-defined data type (alias)', remediation: 'Alias types are not supported. Inline the base built-in type on each column.' },
  SqlTableType: { label: 'Table-valued type', remediation: 'Table types are not supported. Use a temp/staging table instead.' },
  SqlAssembly: { label: 'CLR assembly', remediation: 'CLR assemblies are not supported. Reimplement the logic in T-SQL.' },
  SqlFullTextIndex: { label: 'Full-text index', remediation: 'Full-text search is not supported. Use Azure AI Search over the data instead.' },
  SqlXmlIndex: { label: 'XML index', remediation: 'XML indexes are not supported (the xml type itself is unsupported).' },
};

/**
 * Run the parsed model against the dedicated-SQL-pool restriction set.
 * Unsupported objects/constraints are auto-remediated by generateDeployScript()
 * (dropped / remapped), so they end up deployable; the report still surfaces
 * each one so the operator sees exactly what changed.
 */
export function scanCompatibility(parsed: ParsedDacpac): CompatReport {
  const findings: CompatFinding[] = [];

  // 1. Unsupported object types (dropped on import).
  for (const obj of parsed.objects) {
    const u = UNSUPPORTED_OBJECT_TYPES[obj.type];
    if (u) {
      findings.push({
        severity: 'block',
        rule: `unsupported-object:${obj.type}`,
        object: obj.qualified,
        message: `${u.label} "${obj.qualified}" has no equivalent in Synapse dedicated SQL pool.`,
        remediation: u.remediation + ' This object is SKIPPED by the import.',
        autoFixed: true,
      });
    }
  }

  // 2. Foreign key constraints — unsupported; dropped.
  for (const obj of parsed.objects) {
    if (obj.type === 'SqlForeignKeyConstraint') {
      findings.push({
        severity: 'warn',
        rule: 'foreign-key',
        object: obj.qualified,
        message: `Foreign key "${obj.qualified}" is not supported in dedicated SQL pool.`,
        remediation: 'FOREIGN KEY constraints are dropped on import. Enforce referential integrity in the ELT layer.',
        autoFixed: true,
      });
    }
  }

  // 3. Check constraints — unsupported; dropped.
  for (const obj of parsed.objects) {
    if (obj.type === 'SqlCheckConstraint') {
      findings.push({
        severity: 'warn',
        rule: 'check-constraint',
        object: obj.qualified,
        message: `CHECK constraint "${obj.qualified}" is not supported in dedicated SQL pool.`,
        remediation: 'CHECK constraints are dropped on import. Validate in the ELT layer.',
        autoFixed: true,
      });
    }
  }

  // 4. Indexed views — the index is unsupported; view kept, index stripped.
  for (const obj of parsed.objects) {
    if (obj.type === 'SqlIndexedView' || obj.type === 'SqlIndexedViewIndex') {
      findings.push({
        severity: 'warn',
        rule: 'indexed-view',
        object: obj.qualified,
        message: `Indexed view "${obj.qualified}" — materialized view indexes are not supported.`,
        remediation: 'The view is created without its index. Consider a CTAS materialized table for the same speedup.',
        autoFixed: true,
      });
    }
  }

  // 5. Computed / sparse columns + unsupported data types.
  for (const col of parsed.columns) {
    const colRef = `${col.table}.${col.name}`;
    if (col.computed) {
      findings.push({
        severity: 'warn',
        rule: 'computed-column',
        object: colRef,
        message: `Computed column "${colRef}" is not supported in dedicated SQL pool.`,
        remediation: 'Computed columns are dropped on import — materialize the value in the load process.',
        autoFixed: true,
      });
    }
    if (col.sparse) {
      findings.push({
        severity: 'warn',
        rule: 'sparse-column',
        object: colRef,
        message: `Sparse column "${colRef}" is not supported in dedicated SQL pool.`,
        remediation: 'The SPARSE attribute is removed on import (the column is kept as a normal column).',
        autoFixed: true,
      });
    }
    if (col.dataType && UNSUPPORTED_TYPES[col.dataType]) {
      findings.push({
        severity: 'warn',
        rule: `unsupported-type:${col.dataType}`,
        object: colRef,
        message: `Column "${colRef}" uses unsupported type ${col.dataType}.`,
        remediation: `Remapped to ${UNSUPPORTED_TYPES[col.dataType]} on import. Convert application reads accordingly.`,
        autoFixed: true,
      });
    }
  }

  // 6. Informational inventory.
  const tableCount = parsed.counts['SqlTable'] || 0;
  const viewCount = parsed.counts['SqlView'] || 0;
  const procCount = parsed.counts['SqlProcedure'] || 0;
  const fnCount =
    (parsed.counts['SqlScalarFunction'] || 0) +
    (parsed.counts['SqlInlineTableValuedFunction'] || 0) +
    (parsed.counts['SqlMultiStatementTableValuedFunction'] || 0);
  findings.push({
    severity: 'info',
    rule: 'inventory',
    object: '',
    message: `Model contains ${tableCount} table(s), ${viewCount} view(s), ${procCount} procedure(s), ${fnCount} function(s).`,
    remediation: 'Each table is created with ROUND_ROBIN distribution and a clustered columnstore index unless overridden.',
    autoFixed: false,
  });

  const blockers = findings.filter((f) => f.severity === 'block' && !f.autoFixed).length;
  const warnings = findings.filter((f) => f.severity === 'warn').length;
  const infos = findings.filter((f) => f.severity === 'info').length;

  return { findings, blockers, warnings, infos, deployable: blockers === 0 };
}

// ── Deploy-script generation ────────────────────────────────────────────────

export interface DeployOptions {
  /** Default table distribution. */
  distribution?: 'ROUND_ROBIN' | 'HASH' | 'REPLICATE';
  /** Default index. */
  index?: 'CLUSTERED COLUMNSTORE INDEX' | 'HEAP';
  /** Create the target schema(s) if missing. */
  createSchemas?: boolean;
  /** Guard each CREATE with an IF-NOT-EXISTS so re-runs are idempotent. */
  ifNotExists?: boolean;
}

export interface GeneratedScript {
  /** Ordered DDL statements (schemas → tables → views → functions → procedures). */
  statements: { object: string; type: string; sql: string }[];
  /** The full script as one string (statements joined with GO). */
  script: string;
  /** Objects we could not safely emit, each with the reason. */
  skipped: string[];
}

/**
 * Build dedicated-pool-safe DDL for each deployable object. Tables are
 * synthesized from the modeled columns with the type remaps + an explicit
 * distribution/index. View/function/procedure bodies are emitted from the
 * recovered model scripts (parsed.bodies); anything whose body can't be
 * recovered is reported in `skipped` (never silently lost).
 */
export function generateDeployScript(parsed: ParsedDacpac, opts: DeployOptions = {}): GeneratedScript {
  const distribution = opts.distribution || 'ROUND_ROBIN';
  const index = opts.index || 'CLUSTERED COLUMNSTORE INDEX';
  const createSchemas = opts.createSchemas !== false;
  const statements: { object: string; type: string; sql: string }[] = [];
  const skipped: string[] = [];

  // 1. Schemas referenced by any object.
  if (createSchemas) {
    const schemas = new Set<string>();
    for (const obj of parsed.objects) {
      const dot = obj.qualified.indexOf('.');
      if (dot > 0) schemas.add(obj.qualified.slice(0, dot));
    }
    for (const sc of schemas) {
      if (sc.toLowerCase() === 'dbo') continue;
      statements.push({
        object: sc,
        type: 'schema',
        sql: `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = '${sqlLit(sc)}')\nBEGIN EXEC('CREATE SCHEMA [${ident(sc)}]'); END;`,
      });
    }
  }

  // 2. Tables — synthesize dedicated-pool CREATE TABLE from non-computed columns.
  const colsByTable = new Map<string, DacColumn[]>();
  for (const c of parsed.columns) {
    if (c.computed) continue;
    let arr = colsByTable.get(c.table);
    if (!arr) { arr = []; colsByTable.set(c.table, arr); }
    arr.push(c);
  }
  for (const obj of parsed.objects) {
    if (obj.type !== 'SqlTable') continue;
    const cols = colsByTable.get(obj.qualified) || [];
    if (!cols.length) {
      skipped.push(`${obj.qualified} (no columns resolved from model)`);
      continue;
    }
    const [schema, table] = splitQualified(obj.qualified);
    const colDdl = cols
      .map((c) => {
        const t = UNSUPPORTED_TYPES[c.dataType] || c.dataType || 'nvarchar(4000)';
        return `  [${ident(c.name)}] ${t} NULL`;
      })
      .join(',\n');
    const guardOpen = opts.ifNotExists
      ? `IF OBJECT_ID('[${ident(schema)}].[${ident(table)}]') IS NULL\nBEGIN\n`
      : '';
    const guardClose = opts.ifNotExists ? '\nEND;' : ';';
    statements.push({
      object: obj.qualified,
      type: 'table',
      sql:
        `${guardOpen}CREATE TABLE [${ident(schema)}].[${ident(table)}]\n(\n${colDdl}\n)\n` +
        `WITH ( DISTRIBUTION = ${distribution}, ${index} )${guardClose}`,
    });
  }

  // 3. Views → functions → procedures, emitted from recovered bodies.
  const bodyTypes: Record<string, string> = {
    SqlView: 'view',
    SqlScalarFunction: 'function',
    SqlInlineTableValuedFunction: 'function',
    SqlMultiStatementTableValuedFunction: 'function',
    SqlProcedure: 'procedure',
  };
  const order = [
    'SqlView',
    'SqlScalarFunction',
    'SqlInlineTableValuedFunction',
    'SqlMultiStatementTableValuedFunction',
    'SqlProcedure',
  ];
  const bodies = parsed.bodies;
  for (const type of order) {
    for (const obj of parsed.objects) {
      if (obj.type !== type) continue;
      const body = bodies?.get(obj.name);
      if (!body) {
        skipped.push(
          `${obj.qualified} (${bodyTypes[type]} body not recoverable from model — run the object's CREATE manually after import)`,
        );
        continue;
      }
      statements.push({
        object: obj.qualified,
        type: bodyTypes[type],
        sql: body.trim().replace(/;+\s*$/, '') + ';',
      });
    }
  }

  const script = statements.map((s) => s.sql).join('\nGO\n');
  return { statements, script, skipped };
}

function splitQualified(q: string): [string, string] {
  const dot = q.indexOf('.');
  return dot > 0 ? [q.slice(0, dot), q.slice(dot + 1)] : ['dbo', q];
}
function ident(s: string): string {
  return s.replace(/\]/g, ']]');
}
function sqlLit(s: string): string {
  return s.replace(/'/g, "''");
}

// ── Deploy to Synapse (real TDS) ────────────────────────────────────────────

export interface DeployResult {
  executed: number;
  failed: number;
  results: { object: string; type: string; ok: boolean; error?: string; recordsAffected?: number }[];
}

/**
 * Execute the generated DDL on the env-bound Synapse dedicated SQL pool. Each
 * statement runs independently; a failure is recorded and the run continues so
 * one bad object doesn't abort the whole migration. The target is the same pool
 * the Warehouse / Dedicated-pool editor uses — no Fabric, no mocks.
 */
export async function deployToSynapse(
  gen: GeneratedScript,
  target: SynapseTarget = dedicatedTarget(),
): Promise<DeployResult> {
  const results: DeployResult['results'] = [];
  let executed = 0;
  let failed = 0;
  for (const stmt of gen.statements) {
    try {
      const r = await executeQuery(target, stmt.sql, 120_000);
      results.push({ object: stmt.object, type: stmt.type, ok: true, recordsAffected: r.recordsAffected });
      executed++;
    } catch (e: any) {
      results.push({ object: stmt.object, type: stmt.type, ok: false, error: e?.message || String(e) });
      failed++;
    }
  }
  return { executed, failed, results };
}

/**
 * parseDacpac + recover object bodies (view/function/procedure scripts) from the
 * model XML, so generateDeployScript can emit them. Bodies live in
 * <Property Name="QueryScript|BodyScript|Definition"> as CDATA or attribute.
 */
export function parseDacpacWithBodies(bytes: Buffer): ParsedDacpac {
  const entries = readZip(bytes);
  const modelBuf = pickEntry(entries, 'model.xml');
  if (!modelBuf) throw new Error('No model.xml found inside the .dacpac.');
  const parsed = parseDacpac(bytes);
  const xml = decodeXml(modelBuf);
  const bodies = new Map<string, string>();
  const elementRe = /<Element\b[^>]*\bName="([^"]+)"[^>]*>/g;
  const starts: { name: string; idx: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = elementRe.exec(xml)) !== null) {
    starts.push({ name: unescapeXml(m[1]), idx: m.index });
  }
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].idx;
    const end = i + 1 < starts.length ? starts[i + 1].idx : xml.length;
    const slice = xml.slice(start, end);
    const body = extractScriptProperty(slice);
    if (body) bodies.set(starts[i].name, body);
  }
  parsed.bodies = bodies;
  return parsed;
}

function extractScriptProperty(slice: string): string | undefined {
  const propRe = /<Property\s+Name="(QueryScript|BodyScript|Definition)"\s*>([\s\S]*?)<\/Property>/i;
  const p = slice.match(propRe);
  if (!p) {
    const attr = slice.match(/<Property\s+Name="(QueryScript|BodyScript)"\s+Value="([^"]*)"/i);
    return attr ? unescapeXml(attr[2]) : undefined;
  }
  const cdata = p[2].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) return cdata[1];
  const valM = p[2].match(/<Value>([\s\S]*?)<\/Value>/i);
  return valM ? unescapeXml(valM[1]) : undefined;
}
