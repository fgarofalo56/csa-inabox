/**
 * dacpac-model.ts — dependency-free parser for a SQL Server Data-tier
 * Application package (.dacpac).
 *
 * A .dacpac is a standard PKZIP archive (the same one `lib/azure/zip.ts`
 * already reads) containing, among other files:
 *   - model.xml        the serialized DacFx model (every object's metadata)
 *   - DacMetadata.xml  the package name + version
 *   - Origin.xml       toolchain + the source database's compatibility info
 *
 * We parse the MODERN DacFx model.xml shape (DacFx ≥ 120 / SSDT), which the
 * official "Unpack a DACPAC" doc describes:
 *   https://learn.microsoft.com/sql/tools/sql-database-projects/concepts/data-tier-applications/unpack-dacpac-file
 *
 * Shape (abridged):
 *   <DataSchemaModel ...>
 *     <Model>
 *       <Element Type="SqlSchema" Name="[Sales]" />
 *       <Element Type="SqlTable" Name="[dbo].[Customer]">
 *         <Relationship Name="Columns">
 *           <Entry>
 *             <Element Type="SqlSimpleColumn" Name="[dbo].[Customer].[Id]">
 *               <Property Name="IsNullable" Value="False" />
 *               <Relationship Name="TypeSpecifier">
 *                 <Entry><Element Type="SqlTypeSpecifier">
 *                   <Property Name="Length" Value="50" />
 *                   <Relationship Name="Type">
 *                     <Entry><References Name="[int]" /></Entry>
 *                   </Relationship>
 *                 </Element></Entry>
 *               </Relationship>
 *             </Element>
 *           </Entry>
 *         </Relationship>
 *       </Element>
 *       <Element Type="SqlPrimaryKeyConstraint" .../>
 *       <Element Type="SqlView" .../>
 *       <Element Type="SqlProcedure" .../>
 *     </Model>
 *   </DataSchemaModel>
 *
 * This is parsing, not rendering. No mocks, no sample objects — every field
 * comes out of the uploaded bytes or is reported as missing.
 */

import { readZip } from './zip';
import { parseXml, toArray, type XmlObject, type XmlValue } from './rdl-xml';

export interface DacColumn {
  name: string;
  /** Built-in type name, lower-cased, no brackets (e.g. "nvarchar", "int"). */
  dataType: string;
  nullable: boolean;
  length?: number | 'max';
  precision?: number;
  scale?: number;
  /** Set for computed columns; the T-SQL expression. */
  computedExpression?: string;
  identity?: boolean;
}

export interface DacTable {
  schema: string;
  name: string;
  columns: DacColumn[];
  /** Column names participating in the primary key (ordered). */
  primaryKey: string[];
  /** True if the source declared the table as a clustered columnstore index target. */
  hasClusteredColumnstore: boolean;
  /** True if the source declares this as MEMORY_OPTIMIZED. */
  memoryOptimized: boolean;
  /** True if the table carries a temporal (system-versioning) period. */
  temporal: boolean;
}

export interface DacObject {
  /** SqlView | SqlProcedure | SqlScalarFunction | SqlTableValuedFunction | ... */
  type: string;
  schema: string;
  name: string;
  /** The CREATE body, when the model carries the script (Property "QueryScript"/"BodyScript"). */
  script?: string;
}

export interface DacModel {
  /** Package name from DacMetadata.xml. */
  packageName?: string;
  packageVersion?: string;
  /** Source compat level (e.g. 150) from Origin.xml, if present. */
  sourceCompatLevel?: number;
  schemas: string[];
  tables: DacTable[];
  /** Views, procedures, functions, etc. — every non-table top-level Element. */
  objects: DacObject[];
}

// ── Name helpers ──────────────────────────────────────────────────────────

/** Split a bracketed multi-part name "[dbo].[Customer].[Id]" → ["dbo","Customer","Id"]. */
export function splitBracketedName(name: string): string[] {
  const out: string[] = [];
  const re = /\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(name)) !== null) out.push(m[1]);
  if (out.length === 0 && name) {
    // Unbracketed fallback (some emitters omit brackets for simple names).
    return name.split('.').map((p) => p.trim());
  }
  return out;
}

/** Strip a single set of surrounding brackets: "[int]" → "int". */
function unbracket(name: string): string {
  const m = name.match(/^\[([^\]]*)\]$/);
  return (m ? m[1] : name).toLowerCase();
}

// ── Generic Element walkers over the parseXml() output ───────────────────────

/** Read a Property "Name"="X" Value from an Element node. */
function prop(el: XmlObject, propName: string): string | undefined {
  for (const p of toArray(el.Property)) {
    if (typeof p === 'object' && (p as XmlObject)['@_Name'] === propName) {
      const v = (p as XmlObject)['@_Value'];
      if (typeof v === 'string') return v;
      // QueryScript / BodyScript can be element text rather than an attribute.
      const t = (p as XmlObject)['#text'];
      if (typeof t === 'string') return t;
      const val = (p as XmlObject).Value;
      if (typeof val === 'string') return val;
    }
  }
  return undefined;
}

/** All child <Element> nodes inside the named <Relationship>'s <Entry> list. */
function relElements(el: XmlObject, relName: string): XmlObject[] {
  const out: XmlObject[] = [];
  for (const r of toArray(el.Relationship)) {
    if (typeof r !== 'object' || (r as XmlObject)['@_Name'] !== relName) continue;
    for (const entry of toArray((r as XmlObject).Entry)) {
      if (typeof entry !== 'object') continue;
      for (const inner of toArray((entry as XmlObject).Element)) {
        if (typeof inner === 'object') out.push(inner as XmlObject);
      }
    }
  }
  return out;
}

/** First <References Name="..."> inside the named <Relationship>. */
function relReference(el: XmlObject, relName: string): string | undefined {
  for (const r of toArray(el.Relationship)) {
    if (typeof r !== 'object' || (r as XmlObject)['@_Name'] !== relName) continue;
    for (const entry of toArray((r as XmlObject).Entry)) {
      if (typeof entry !== 'object') continue;
      for (const ref of toArray((entry as XmlObject).References)) {
        if (typeof ref === 'object') {
          const n = (ref as XmlObject)['@_Name'];
          if (typeof n === 'string') return n;
        }
      }
    }
  }
  return undefined;
}

function parseIntOr(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ── Column parsing ──────────────────────────────────────────────────────────

function parseColumn(colEl: XmlObject): DacColumn | null {
  const fullName = colEl['@_Name'];
  if (typeof fullName !== 'string') return null;
  const parts = splitBracketedName(fullName);
  const name = parts[parts.length - 1] || fullName;
  const type = colEl['@_Type'];

  // Computed column: the expression is a Property, there is no TypeSpecifier.
  if (type === 'SqlComputedColumn') {
    return {
      name,
      dataType: 'computed',
      nullable: true,
      computedExpression: prop(colEl, 'ExpressionScript') || prop(colEl, 'Expression') || undefined,
    };
  }

  // Simple/identity columns carry a TypeSpecifier relationship.
  const specifiers = relElements(colEl, 'TypeSpecifier');
  const spec = specifiers[0];
  let dataType = 'unknown';
  let length: number | 'max' | undefined;
  let precision: number | undefined;
  let scale: number | undefined;
  if (spec) {
    const typeRef = relReference(spec, 'Type');
    if (typeRef) dataType = unbracket(typeRef);
    const lenStr = prop(spec, 'Length');
    if (lenStr != null) length = lenStr.toLowerCase() === 'max' ? 'max' : parseIntOr(lenStr);
    if (prop(spec, 'IsMax')?.toLowerCase() === 'true') length = 'max';
    precision = parseIntOr(prop(spec, 'Precision'));
    scale = parseIntOr(prop(spec, 'Scale'));
  }

  const nullableProp = prop(colEl, 'IsNullable');
  // DacFx default for IsNullable is True; only "False" makes it NOT NULL.
  const nullable = nullableProp ? nullableProp.toLowerCase() !== 'false' : true;
  const identity = type === 'SqlSimpleColumn' && prop(colEl, 'IsIdentity')?.toLowerCase() === 'true';

  return { name, dataType, nullable, length, precision, scale, identity };
}

// ── Table parsing ───────────────────────────────────────────────────────────

function parseTable(tableEl: XmlObject): DacTable | null {
  const fullName = tableEl['@_Name'];
  if (typeof fullName !== 'string') return null;
  const parts = splitBracketedName(fullName);
  const schema = parts[0] || 'dbo';
  const name = parts[1] || parts[parts.length - 1] || fullName;

  const columns: DacColumn[] = [];
  for (const colEl of relElements(tableEl, 'Columns')) {
    const c = parseColumn(colEl);
    if (c) columns.push(c);
  }

  return {
    schema,
    name,
    columns,
    primaryKey: [], // filled from SqlPrimaryKeyConstraint pass
    hasClusteredColumnstore: false, // filled from index pass
    memoryOptimized: prop(tableEl, 'IsMemoryOptimized')?.toLowerCase() === 'true',
    temporal: relElements(tableEl, 'TemporalSystemVersioningHistoryTable').length > 0
      || prop(tableEl, 'IsAutoGeneratedHistoryTable')?.toLowerCase() === 'true',
  };
}

// ── Top-level model walk ─────────────────────────────────────────────────────

const SCRIPT_BEARING = new Set([
  'SqlView',
  'SqlProcedure',
  'SqlScalarFunction',
  'SqlTableValuedFunction',
  'SqlInlineTableValuedFunction',
  'SqlMultiStatementTableValuedFunction',
  'SqlDmlTrigger',
]);

/** Parse the already-decompressed model.xml text into a structured DacModel. */
export function parseDacModelXml(modelXml: string): Pick<DacModel, 'schemas' | 'tables' | 'objects'> {
  const doc = parseXml(modelXml);
  // Root is usually DataSchemaModel; tolerate a direct <Model> root too.
  const rootKey = Object.keys(doc)[0];
  const root = (doc[rootKey] as XmlObject) || {};
  const model = (typeof root.Model === 'object' ? (root.Model as XmlObject) : root) as XmlObject;

  const elements = toArray(model.Element).filter((e): e is XmlObject => typeof e === 'object');

  const schemas = new Set<string>();
  const tablesByKey = new Map<string, DacTable>();
  const objects: DacObject[] = [];

  // Pass 1: schemas, tables, scriptable objects.
  for (const el of elements) {
    const type = el['@_Type'];
    if (type === 'SqlSchema') {
      const n = splitBracketedName(String(el['@_Name'] || ''))[0];
      if (n) schemas.add(n);
      continue;
    }
    if (type === 'SqlTable') {
      const t = parseTable(el);
      if (t) {
        tablesByKey.set(`${t.schema}.${t.name}`.toLowerCase(), t);
        schemas.add(t.schema);
      }
      continue;
    }
    if (typeof type === 'string' && SCRIPT_BEARING.has(type)) {
      const parts = splitBracketedName(String(el['@_Name'] || ''));
      const schema = parts[0] || 'dbo';
      const name = parts[1] || parts[parts.length - 1] || String(el['@_Name'] || '');
      schemas.add(schema);
      objects.push({
        type,
        schema,
        name,
        script: prop(el, 'QueryScript') || prop(el, 'BodyScript') || undefined,
      });
    }
  }

  // Pass 2: primary keys + columnstore indexes attach to their target table.
  for (const el of elements) {
    const type = el['@_Type'];
    if (type === 'SqlPrimaryKeyConstraint') {
      const hostRef = relReference(el, 'DefiningTable') || relReference(el, 'Host');
      if (!hostRef) continue;
      const hp = splitBracketedName(hostRef);
      const key = `${hp[0] || 'dbo'}.${hp[1] || ''}`.toLowerCase();
      const table = tablesByKey.get(key);
      if (!table) continue;
      for (const colSpec of relElements(el, 'ColumnSpecifications')) {
        const colRef = relReference(colSpec, 'Column');
        if (colRef) {
          const cp = splitBracketedName(colRef);
          table.primaryKey.push(cp[cp.length - 1]);
        }
      }
    }
    if (type === 'SqlIndex' || type === 'SqlClusteredColumnstoreIndex' || type === 'SqlColumnStoreIndex') {
      const isColumnstore = type !== 'SqlIndex'
        || prop(el, 'IsColumnStore')?.toLowerCase() === 'true';
      if (!isColumnstore) continue;
      const hostRef = relReference(el, 'IndexedObject') || relReference(el, 'DefiningTable') || relReference(el, 'Host');
      if (!hostRef) continue;
      const hp = splitBracketedName(hostRef);
      const key = `${hp[0] || 'dbo'}.${hp[1] || ''}`.toLowerCase();
      const table = tablesByKey.get(key);
      if (table) table.hasClusteredColumnstore = true;
    }
  }

  return {
    schemas: [...schemas].sort(),
    tables: [...tablesByKey.values()].sort((a, b) => (`${a.schema}.${a.name}`).localeCompare(`${b.schema}.${b.name}`)),
    objects: objects.sort((a, b) => (`${a.schema}.${a.name}`).localeCompare(`${b.schema}.${b.name}`)),
  };
}

/** Extract package name/version from DacMetadata.xml. */
function parseMetadata(xml: string | undefined): { packageName?: string; packageVersion?: string } {
  if (!xml) return {};
  const doc = parseXml(xml);
  const root = (doc.DacType as XmlObject) || (Object.values(doc)[0] as XmlObject) || {};
  const name = root.Name;
  const version = root.Version;
  return {
    packageName: typeof name === 'string' ? name : undefined,
    packageVersion: typeof version === 'string' ? version : undefined,
  };
}

/** Extract the source database compatibility level from Origin.xml, if present. */
function parseOriginCompat(xml: string | undefined): number | undefined {
  if (!xml) return undefined;
  // Origin.xml carries <ModelSchemaVersion> and sometimes a CompatibilityLevel
  // property; scan for the first CompatibilityLevel-ish numeric token.
  const m = xml.match(/CompatibilityLevel[^0-9]{0,16}(\d{2,3})/i)
    || xml.match(/<CompatibilityLevel>\s*(\d{2,3})\s*<\/CompatibilityLevel>/i);
  return m ? parseIntOr(m[1]) : undefined;
}

/**
 * Parse a full .dacpac (ZIP) buffer into a structured DacModel.
 * Throws on a missing/corrupt model.xml so the route can surface an honest 400.
 */
export function parseDacpac(bytes: Buffer): DacModel {
  const entries = readZip(bytes);
  // ZIP entry names use forward slashes; match case-insensitively + basename.
  let modelBuf: Buffer | undefined;
  let metaBuf: Buffer | undefined;
  let originBuf: Buffer | undefined;
  for (const [name, buf] of entries) {
    const base = name.split('/').pop()?.toLowerCase();
    if (base === 'model.xml') modelBuf = buf;
    else if (base === 'dacmetadata.xml') metaBuf = buf;
    else if (base === 'origin.xml') originBuf = buf;
  }
  if (!modelBuf) {
    throw new Error('Not a valid .dacpac — model.xml not found in the package.');
  }

  const modelXml = modelBuf.toString('utf-8');
  const parsed = parseDacModelXml(modelXml);
  if (parsed.tables.length === 0 && parsed.objects.length === 0) {
    throw new Error('model.xml parsed but contained no tables, views, or routines.');
  }
  const meta = parseMetadata(metaBuf?.toString('utf-8'));
  const sourceCompatLevel = parseOriginCompat(originBuf?.toString('utf-8'));

  return { ...parsed, ...meta, sourceCompatLevel };
}
