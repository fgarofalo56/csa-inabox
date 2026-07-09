/**
 * Digital Twin Builder — structured model + KQL generation (pure logic).
 *
 * The Loom parity for Microsoft Fabric's Real-Time-Intelligence "Digital Twin
 * Builder" item (Public Preview). A low-code ontology of ENTITY types (assets /
 * processes) and RELATIONSHIP types, with each type MAPPED onto a real source
 * table (lakehouse Delta / Synapse warehouse / ADX). The twin graph is
 * materialized on the shared Azure Data Explorer cluster as per-item
 * `DT_<key>_E_<entity>` (id, props) + `DT_<key>_R_<rel>` (src, dst, props)
 * tables, then explored with the Kusto graph engine (`make-graph` /
 * `graph-match`) — exactly the Azure-native default the gql-graph editor uses.
 * NO Microsoft Fabric, NO OneLake, NO Azure Digital Twins on the default path
 * (per .claude/rules/no-fabric-dependency.md). Azure Digital Twins is a strict
 * opt-in alternate gated on LOOM_ADT_ENDPOINT.
 *
 * This module is React-free / Node-free so BOTH the editor and the BFF routes
 * import the SAME normalizers + KQL builders, and every builder is vitest
 * covered (see `__tests__/digital-twin-model.test.ts`). The KQL-generation
 * helpers are byte-identical in spirit to the graph-model materialize route so
 * a twin materializes with the same proven `.create-merge` + `.set-or-append`
 * + `make-graph` pipeline.
 */

// ============================================================
// Property base-type system (maps 1:1 to a Kusto scalar type)
// ============================================================

/** Twin property base types (a curated 1:1 of Kusto scalar types). */
export const TWIN_BASE_TYPES = [
  'string', 'long', 'int', 'real', 'decimal', 'bool', 'datetime', 'dynamic', 'guid', 'timespan',
] as const;
export type TwinBaseType = typeof TWIN_BASE_TYPES[number];

export const TWIN_BASE_TYPE_LABELS: Record<TwinBaseType, string> = {
  string: 'String', long: 'Long', int: 'Int', real: 'Real (double)', decimal: 'Decimal',
  bool: 'Boolean', datetime: 'Datetime', dynamic: 'Dynamic (JSON)', guid: 'GUID', timespan: 'Timespan',
};

/** Numeric base types eligible as a time-series measure value. */
export const TWIN_NUMERIC_TYPES: ReadonlySet<TwinBaseType> = new Set<TwinBaseType>([
  'long', 'int', 'real', 'decimal',
]);

export type TwinColor = 'brand' | 'success' | 'warning' | 'danger' | 'informative' | 'subtle';
export const TWIN_COLORS: readonly TwinColor[] = ['brand', 'success', 'warning', 'danger', 'informative', 'subtle'];

export type TwinCardinality = 'one-to-one' | 'one-to-many' | 'many-to-many';
export const TWIN_CARDINALITIES: readonly TwinCardinality[] = ['one-to-one', 'one-to-many', 'many-to-many'];
export const TWIN_CARDINALITY_LABELS: Record<TwinCardinality, string> = {
  'one-to-one': 'One-to-one', 'one-to-many': 'One-to-many', 'many-to-many': 'Many-to-many',
};

/** Where a source table lives — the mapping backend for materialize. */
export type TwinSourceKind = 'lakehouse' | 'warehouse' | 'adx' | 'eventhouse';
export const TWIN_SOURCE_KINDS: readonly TwinSourceKind[] = ['lakehouse', 'warehouse', 'adx', 'eventhouse'];
export const TWIN_SOURCE_KIND_LABELS: Record<TwinSourceKind, string> = {
  lakehouse: 'Lakehouse (ADLS Delta)', warehouse: 'Warehouse (Synapse SQL)',
  adx: 'ADX / KQL database', eventhouse: 'Eventhouse (ADX)',
};

// ============================================================
// Interfaces
// ============================================================

/** A typed property on an entity or relationship. */
export interface TwinProperty {
  apiName: string;
  displayName?: string;
  baseType: TwinBaseType;
  description?: string;
  /** When true, this property is a time-series measure (time-series pane). */
  isTimeSeries?: boolean;
}

/** Binds an entity to a real source table (materialize `.set-or-append`). */
export interface TwinEntityMapping {
  kind: TwinSourceKind;
  /** Cosmos item id of the backing lakehouse/warehouse (optional descriptor). */
  sourceItemId?: string;
  sourceDisplayName?: string;
  /** ADX database the source table lives in (materialize reads from here). */
  sourceDatabase?: string;
  /** The source table (e.g. `dbo.Asset` or a Delta table name). */
  sourceTable?: string;
  /** Columns that form the entity identity (compound keys allowed). */
  keyColumns?: string[];
  /** propertyApiName → sourceColumn. */
  columnMap?: Record<string, string>;
  /** Source datetime column for time-series (property history). */
  timestampColumn?: string;
  boundAt?: string;
}

/** Binds a relationship to a real source table (edge rows). */
export interface TwinRelMapping {
  kind: TwinSourceKind;
  sourceItemId?: string;
  sourceDisplayName?: string;
  sourceDatabase?: string;
  sourceTable?: string;
  /** Source columns forming the origin (src) entity key. */
  originKeyColumns?: string[];
  /** Source columns forming the target (dst) entity key. */
  targetKeyColumns?: string[];
  columnMap?: Record<string, string>;
  boundAt?: string;
}

/** A typed entity (asset / process) in the twin ontology. */
export interface TwinEntity {
  apiName: string;
  displayName?: string;
  description?: string;
  icon?: string;
  color?: TwinColor;
  properties: TwinProperty[];
  /** apiName of the identity property (surfaced as the graph node `id`). */
  keyProperty?: string;
  mapping?: TwinEntityMapping;
  /** Canvas position (model designer). */
  position?: { x: number; y: number };
}

/** A typed relationship between two entities. */
export interface TwinRelationship {
  apiName: string;
  displayName?: string;
  fromEntity: string;
  toEntity: string;
  cardinality: TwinCardinality;
  properties: TwinProperty[];
  mapping?: TwinRelMapping;
}

/** The full twin model persisted to Cosmos item state. */
export interface TwinModel {
  entities: TwinEntity[];
  relationships: TwinRelationship[];
  /** Target ADX database for materialize (default resolved from env). */
  database?: string;
  lastMaterializedAt?: string;
}

// ============================================================
// Identifiers + KQL-safe helpers (shared with the BFF routes)
// ============================================================

/** A safe API-name identifier: leading letter/underscore, ≤62 word chars. */
export function isTwinIdent(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_][\w]{0,62}$/.test(name);
}

/** Reduce an arbitrary string to a KQL-safe bare identifier. */
export function safeIdent(s: string): string {
  return String(s).replace(/[^A-Za-z0-9_]/g, '_');
}

/** Bracket-quote an arbitrary ADX identifier (tolerates spaces/hyphens). */
export function bq(name: string): string {
  return `['${String(name).replace(/'/g, "\\'")}']`;
}

/** Map a loose type name to a concrete Kusto scalar type. */
export function kustoType(t?: string): string {
  const v = (t || 'string').toLowerCase();
  if (['int', 'long', 'real', 'bool', 'datetime', 'dynamic', 'guid', 'decimal', 'timespan', 'string'].includes(v)) return v;
  if (v === 'number' || v === 'float' || v === 'double') return 'real';
  if (v === 'boolean') return 'bool';
  if (v === 'timestamp') return 'datetime';
  if (v === 'integer') return 'int';
  return 'string';
}

/** KQL scalar cast function for a target column type. */
export function castFn(t: string): string {
  switch (kustoType(t)) {
    case 'int': return 'toint';
    case 'long': return 'tolong';
    case 'real': return 'toreal';
    case 'decimal': return 'todecimal';
    case 'datetime': return 'todatetime';
    case 'timespan': return 'totimespan';
    case 'bool': return 'tobool';
    case 'guid': return 'toguid';
    case 'dynamic': return 'todynamic';
    default: return 'tostring';
  }
}

/** A composite-key expression: strcat(tostring(['k1']),'|',tostring(['k2'])). */
export function keyExpr(cols: string[]): string {
  const parts = cols.filter(Boolean).map((c) => `tostring(${bq(c)})`);
  if (parts.length === 0) return "''";
  if (parts.length === 1) return parts[0];
  const woven: string[] = [];
  parts.forEach((p, i) => { if (i) woven.push("'|'"); woven.push(p); });
  return `strcat(${woven.join(', ')})`;
}

/** Source ref `database('db').['table']` (db omitted → current database). */
export function sourceRef(db: string | undefined, table: string): string {
  return db ? `database('${db.replace(/'/g, "\\'")}').${bq(table)}` : bq(table);
}

/** A short, per-item, KQL-safe table-name key (isolates twins on the shared cluster). */
export function twinKey(itemId: string): string {
  return safeIdent(String(itemId || 'x')) || 'x';
}

/** The materialized ADX table name for an entity. */
export function entityTable(key: string, entityApiName: string): string {
  return `DT_${key}_E_${safeIdent(entityApiName)}`;
}

/** The materialized ADX table name for a relationship. */
export function relTable(key: string, relApiName: string): string {
  return `DT_${key}_R_${safeIdent(relApiName)}`;
}

// ============================================================
// Normalizers (coerce persisted Cosmos shapes → clean typed model)
// ============================================================

function str(v: unknown): string { return typeof v === 'string' ? v : v == null ? '' : String(v); }
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : [];
}

export function normalizeTwinProperty(raw: unknown): TwinProperty | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const apiName = str(r.apiName).trim();
  if (!isTwinIdent(apiName)) return null;
  const baseType = (TWIN_BASE_TYPES as readonly string[]).includes(str(r.baseType))
    ? (str(r.baseType) as TwinBaseType) : 'string';
  return {
    apiName,
    ...(r.displayName ? { displayName: str(r.displayName) } : {}),
    baseType,
    ...(r.description ? { description: str(r.description) } : {}),
    ...(r.isTimeSeries ? { isTimeSeries: true } : {}),
  };
}

function normalizeColumnMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (isTwinIdent(k) && str(val).trim()) out[k] = str(val).trim();
    }
  }
  return out;
}

function normalizeSourceKind(v: unknown): TwinSourceKind {
  return (TWIN_SOURCE_KINDS as readonly string[]).includes(str(v)) ? (str(v) as TwinSourceKind) : 'lakehouse';
}

export function normalizeEntityMapping(raw: unknown): TwinEntityMapping | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const columnMap = normalizeColumnMap(r.columnMap);
  const keyColumns = strArr(r.keyColumns);
  return {
    kind: normalizeSourceKind(r.kind),
    ...(r.sourceItemId ? { sourceItemId: str(r.sourceItemId).trim() } : {}),
    ...(r.sourceDisplayName ? { sourceDisplayName: str(r.sourceDisplayName) } : {}),
    ...(r.sourceDatabase ? { sourceDatabase: str(r.sourceDatabase).trim() } : {}),
    ...(r.sourceTable ? { sourceTable: str(r.sourceTable).trim() } : {}),
    ...(keyColumns.length ? { keyColumns } : {}),
    ...(Object.keys(columnMap).length ? { columnMap } : {}),
    ...(r.timestampColumn ? { timestampColumn: str(r.timestampColumn).trim() } : {}),
    ...(r.boundAt ? { boundAt: str(r.boundAt) } : {}),
  };
}

export function normalizeRelMapping(raw: unknown): TwinRelMapping | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const columnMap = normalizeColumnMap(r.columnMap);
  const originKeyColumns = strArr(r.originKeyColumns);
  const targetKeyColumns = strArr(r.targetKeyColumns);
  return {
    kind: normalizeSourceKind(r.kind),
    ...(r.sourceItemId ? { sourceItemId: str(r.sourceItemId).trim() } : {}),
    ...(r.sourceDisplayName ? { sourceDisplayName: str(r.sourceDisplayName) } : {}),
    ...(r.sourceDatabase ? { sourceDatabase: str(r.sourceDatabase).trim() } : {}),
    ...(r.sourceTable ? { sourceTable: str(r.sourceTable).trim() } : {}),
    ...(originKeyColumns.length ? { originKeyColumns } : {}),
    ...(targetKeyColumns.length ? { targetKeyColumns } : {}),
    ...(Object.keys(columnMap).length ? { columnMap } : {}),
    ...(r.boundAt ? { boundAt: str(r.boundAt) } : {}),
  };
}

function normalizeProperties(v: unknown): TwinProperty[] {
  return Array.isArray(v)
    ? v.map(normalizeTwinProperty).filter((p): p is TwinProperty => p !== null)
    : [];
}

export function normalizeTwinEntity(raw: unknown): TwinEntity | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const apiName = str(r.apiName).trim();
  if (!isTwinIdent(apiName)) return null;
  const properties = normalizeProperties(r.properties);
  const propNames = new Set(properties.map((p) => p.apiName));
  const color = (TWIN_COLORS as readonly string[]).includes(str(r.color)) ? (str(r.color) as TwinColor) : undefined;
  const keyProperty = propNames.has(str(r.keyProperty)) ? str(r.keyProperty) : undefined;
  const pos = r.position && typeof r.position === 'object'
    ? { x: Number((r.position as any).x) || 0, y: Number((r.position as any).y) || 0 } : undefined;
  return {
    apiName,
    ...(r.displayName ? { displayName: str(r.displayName) } : {}),
    ...(r.description ? { description: str(r.description) } : {}),
    ...(r.icon ? { icon: str(r.icon) } : {}),
    ...(color ? { color } : {}),
    properties,
    ...(keyProperty ? { keyProperty } : {}),
    ...(normalizeEntityMapping(r.mapping) ? { mapping: normalizeEntityMapping(r.mapping) } : {}),
    ...(pos ? { position: pos } : {}),
  };
}

export function normalizeTwinRelationship(raw: unknown): TwinRelationship | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const apiName = str(r.apiName).trim();
  const fromEntity = str(r.fromEntity).trim();
  const toEntity = str(r.toEntity).trim();
  if (!isTwinIdent(apiName) || !isTwinIdent(fromEntity) || !isTwinIdent(toEntity)) return null;
  const cardinality = (TWIN_CARDINALITIES as readonly string[]).includes(str(r.cardinality))
    ? (str(r.cardinality) as TwinCardinality) : 'one-to-many';
  return {
    apiName,
    ...(r.displayName ? { displayName: str(r.displayName) } : {}),
    fromEntity,
    toEntity,
    cardinality,
    properties: normalizeProperties(r.properties),
    ...(normalizeRelMapping(r.mapping) ? { mapping: normalizeRelMapping(r.mapping) } : {}),
  };
}

/** Normalize persisted Cosmos state into a clean twin model. Relationships that
 *  reference an entity that no longer exists are dropped. */
export function normalizeTwinModel(state: Record<string, unknown> | undefined | null): TwinModel {
  const s = state || {};
  const entities = Array.isArray(s.entities)
    ? s.entities.map(normalizeTwinEntity).filter((e): e is TwinEntity => e !== null)
    : [];
  const names = new Set(entities.map((e) => e.apiName));
  const relationships = (Array.isArray(s.relationships)
    ? s.relationships.map(normalizeTwinRelationship).filter((l): l is TwinRelationship => l !== null)
    : []
  ).filter((l) => names.has(l.fromEntity) && names.has(l.toEntity));
  return {
    entities,
    relationships,
    ...(str(s.database).trim() ? { database: str(s.database).trim() } : {}),
    ...(str(s.lastMaterializedAt) ? { lastMaterializedAt: str(s.lastMaterializedAt) } : {}),
  };
}

/** An empty starter model. */
export function emptyTwinModel(): TwinModel {
  return { entities: [], relationships: [] };
}

/** A 2-entity example model (Asset —monitors→ Sensor) the user can materialize. */
export function starterTwinModel(): TwinModel {
  return {
    entities: [
      {
        apiName: 'Asset', displayName: 'Asset', color: 'brand',
        keyProperty: 'assetId',
        position: { x: 80, y: 120 },
        properties: [
          { apiName: 'assetId', baseType: 'string', displayName: 'Asset ID' },
          { apiName: 'name', baseType: 'string', displayName: 'Name' },
          { apiName: 'status', baseType: 'string', displayName: 'Status' },
        ],
      },
      {
        apiName: 'Sensor', displayName: 'Sensor', color: 'informative',
        keyProperty: 'sensorId',
        position: { x: 460, y: 120 },
        properties: [
          { apiName: 'sensorId', baseType: 'string', displayName: 'Sensor ID' },
          { apiName: 'reading', baseType: 'real', displayName: 'Reading', isTimeSeries: true },
          { apiName: 'ts', baseType: 'datetime', displayName: 'Timestamp' },
        ],
      },
    ],
    relationships: [
      {
        apiName: 'monitors', displayName: 'monitors',
        fromEntity: 'Asset', toEntity: 'Sensor', cardinality: 'one-to-many',
        properties: [],
      },
    ],
  };
}

// ============================================================
// Validation
// ============================================================

export interface TwinIssue { level: 'error' | 'warning'; message: string }

/** Structural + materialize-readiness validation of a twin model. */
export function validateTwinModel(model: TwinModel): TwinIssue[] {
  const issues: TwinIssue[] = [];
  const seen = new Set<string>();
  for (const e of model.entities) {
    if (!isTwinIdent(e.apiName)) { issues.push({ level: 'error', message: `Entity "${e.apiName}" has an invalid API name.` }); continue; }
    if (seen.has(e.apiName)) issues.push({ level: 'error', message: `Duplicate entity "${e.apiName}".` });
    seen.add(e.apiName);
    if (!e.keyProperty) issues.push({ level: 'warning', message: `Entity "${e.apiName}" has no key property — set one to identify its twins.` });
    else if (!e.properties.some((p) => p.apiName === e.keyProperty)) {
      issues.push({ level: 'error', message: `Entity "${e.apiName}" key "${e.keyProperty}" is not one of its properties.` });
    }
    if (e.mapping && e.mapping.sourceTable && !(e.mapping.keyColumns && e.mapping.keyColumns.length)) {
      issues.push({ level: 'warning', message: `Entity "${e.apiName}" is bound to ${e.mapping.sourceTable} but has no key column(s) — its twins won't load.` });
    }
  }
  const relSeen = new Set<string>();
  for (const r of model.relationships) {
    if (!isTwinIdent(r.apiName)) { issues.push({ level: 'error', message: `Relationship "${r.apiName}" has an invalid API name.` }); continue; }
    if (relSeen.has(r.apiName)) issues.push({ level: 'error', message: `Duplicate relationship "${r.apiName}".` });
    relSeen.add(r.apiName);
    if (!seen.has(r.fromEntity)) issues.push({ level: 'error', message: `Relationship "${r.apiName}" origin "${r.fromEntity}" is not a defined entity.` });
    if (!seen.has(r.toEntity)) issues.push({ level: 'error', message: `Relationship "${r.apiName}" target "${r.toEntity}" is not a defined entity.` });
    if (r.mapping && r.mapping.sourceTable) {
      if (!(r.mapping.originKeyColumns && r.mapping.originKeyColumns.length)) {
        issues.push({ level: 'warning', message: `Relationship "${r.apiName}" is bound to ${r.mapping.sourceTable} but has no origin key column(s).` });
      }
      if (!(r.mapping.targetKeyColumns && r.mapping.targetKeyColumns.length)) {
        issues.push({ level: 'warning', message: `Relationship "${r.apiName}" is bound to ${r.mapping.sourceTable} but has no target key column(s).` });
      }
    }
  }
  return issues;
}

// ============================================================
// KQL generation — materialize (create + load)
// ============================================================

export interface TwinCommand {
  kind: 'entity' | 'relationship';
  op: 'create' | 'load';
  name: string;
  table: string;
  command: string;
}

export interface TwinMaterializePlan {
  creates: TwinCommand[];
  loads: TwinCommand[];
  nodeTables: string[];
  edgeTables: string[];
}

function buildCreate(table: string, columns: { name: string; type: string }[]): string {
  const cols = columns.map((c) => `${safeIdent(c.name)}:${c.type}`).join(', ');
  return `.create-merge table ${safeIdent(table)} (${cols})`;
}

/**
 * Build the ordered `.create-merge` + `.set-or-append` plan that materializes a
 * twin model on ADX. Each entity → a `DT_<key>_E_<entity>` table with an `id`
 * key column + its typed properties; when the entity is mapped to a source
 * table, an append projects the cast rows from that table. Each relationship →
 * a `DT_<key>_R_<rel>` table with `src`/`dst` + props; a mapped relationship
 * appends origin/target keys from its source table.
 */
export function buildTwinMaterialize(model: TwinModel, key: string): TwinMaterializePlan {
  const creates: TwinCommand[] = [];
  const loads: TwinCommand[] = [];
  const nodeTables: string[] = [];
  const edgeTables: string[] = [];

  for (const e of model.entities) {
    if (!isTwinIdent(e.apiName)) continue;
    const table = entityTable(key, e.apiName);
    nodeTables.push(table);
    creates.push({
      kind: 'entity', op: 'create', name: e.apiName, table,
      command: buildCreate(table, [
        { name: 'id', type: 'string' },
        ...e.properties.map((p) => ({ name: p.apiName, type: kustoType(p.baseType) })),
      ]),
    });
    const m = e.mapping;
    if (m?.sourceTable && m.keyColumns && m.keyColumns.length) {
      const proj = [`id = ${keyExpr(m.keyColumns)}`];
      for (const p of e.properties) {
        const col = (m.columnMap && m.columnMap[p.apiName]) || p.apiName;
        proj.push(`${safeIdent(p.apiName)} = ${castFn(p.baseType)}(${bq(col)})`);
      }
      loads.push({
        kind: 'entity', op: 'load', name: e.apiName, table,
        command: `.set-or-append ${table} <| ${sourceRef(m.sourceDatabase, m.sourceTable)}\n| project ${proj.join(', ')}`,
      });
    }
  }

  for (const r of model.relationships) {
    if (!isTwinIdent(r.apiName)) continue;
    const table = relTable(key, r.apiName);
    edgeTables.push(table);
    creates.push({
      kind: 'relationship', op: 'create', name: r.apiName, table,
      command: buildCreate(table, [
        { name: 'src', type: 'string' },
        { name: 'dst', type: 'string' },
        { name: 'rel', type: 'string' },
        ...r.properties.map((p) => ({ name: p.apiName, type: kustoType(p.baseType) })),
      ]),
    });
    const m = r.mapping;
    if (m?.sourceTable && m.originKeyColumns && m.originKeyColumns.length && m.targetKeyColumns && m.targetKeyColumns.length) {
      const proj = [
        `src = ${keyExpr(m.originKeyColumns)}`,
        `dst = ${keyExpr(m.targetKeyColumns)}`,
        `rel = '${r.apiName.replace(/'/g, "\\'")}'`,
      ];
      for (const p of r.properties) {
        const col = (m.columnMap && m.columnMap[p.apiName]) || p.apiName;
        proj.push(`${safeIdent(p.apiName)} = ${castFn(p.baseType)}(${bq(col)})`);
      }
      loads.push({
        kind: 'relationship', op: 'load', name: r.apiName, table,
        command: `.set-or-append ${table} <| ${sourceRef(m.sourceDatabase, m.sourceTable)}\n| project ${proj.join(', ')}`,
      });
    }
  }

  return { creates, loads, nodeTables, edgeTables };
}

// ============================================================
// KQL generation — graph explorer (make-graph / graph-match)
// ============================================================

/** Build the `make-graph` prelude (`G`) from the twin's node + edge tables. */
export function buildTwinGraphPrelude(nodeTables: string[], edgeTables: string[]): string {
  if (!nodeTables.length || !edgeTables.length) return '';
  const nodeUnion = nodeTables.map((t) => `(${t})`).join(', ');
  const edgeUnion = edgeTables.map((t) => `(${t})`).join(', ');
  return [
    `let TwinNodes = union ${nodeUnion};`,
    `let TwinEdges = union ${edgeUnion};`,
    `let G = TwinEdges | make-graph src --> dst with TwinNodes on id;`,
  ].join('\n');
}

/** Compose the full graph query: prelude + the caller's `G | graph-match …`. */
export function composeTwinGraphQuery(prelude: string, pattern: string): string {
  return `${prelude}\n${pattern}`.trim();
}

/** The default graph-match pattern shown in the explorer. */
export const SAMPLE_TWIN_MATCH = [
  'G',
  '| graph-match (a)-[e]->(b)',
  '  project source = a.id, relationship = e.rel, target = b.id',
  '| take 100',
].join('\n');

/** A relationship-count receipt query used by materialize verification. */
export function buildTwinRelationshipCount(nodeTables: string[], edgeTables: string[]): string | null {
  if (!nodeTables.length || !edgeTables.length) return null;
  return (
    `union withsource=__t ${edgeTables.join(', ')}\n` +
    `| make-graph src --> dst with (union withsource=__t ${nodeTables.join(', ')}) on id\n` +
    `| graph-match (a)-[e]->(b) project a, e, b\n| count`
  );
}

// ============================================================
// KQL generation — time-series (entity property history)
// ============================================================

export type TwinTsAgg = 'avg' | 'min' | 'max' | 'sum' | 'count';
export const TWIN_TS_AGGS: readonly TwinTsAgg[] = ['avg', 'min', 'max', 'sum', 'count'];

/** Curated bin sizes (no freeform interval input). */
export const TWIN_TS_BINS = ['1m', '5m', '15m', '1h', '6h', '1d'] as const;
export type TwinTsBin = typeof TWIN_TS_BINS[number];

/** Curated look-back windows. */
export const TWIN_TS_LOOKBACKS = ['1h', '6h', '1d', '7d', '30d', '90d'] as const;
export type TwinTsLookback = typeof TWIN_TS_LOOKBACKS[number];

export interface TwinTimeSeriesSpec {
  sourceDatabase?: string;
  sourceTable: string;
  timestampColumn: string;
  valueColumn: string;
  agg: TwinTsAgg;
  bin: TwinTsBin;
  lookback: TwinTsLookback;
  /** Optional per-twin filter column (e.g. the entity key). */
  keyColumn?: string;
  /** The value to filter the key column to (a DATA value, not config). */
  keyValue?: string;
  /** Row cap. */
  limit?: number;
}

const BIN_RE = /^\d+[mhd]$/;

/**
 * Build a KQL time-series query for an entity property's history over ADX.
 * All structural inputs (agg / bin / lookback) are validated against the
 * curated allow-lists; only `keyValue` is a free DATA value and it is
 * single-quote-escaped, never interpolated as an identifier.
 */
export function buildTwinTimeSeriesQuery(spec: TwinTimeSeriesSpec): string {
  const agg = (TWIN_TS_AGGS as readonly string[]).includes(spec.agg) ? spec.agg : 'avg';
  const bin = BIN_RE.test(String(spec.bin)) ? spec.bin : '1h';
  const lookback = BIN_RE.test(String(spec.lookback)) ? spec.lookback : '1d';
  const ts = bq(spec.timestampColumn);
  const limit = Math.min(Math.max(Number(spec.limit) || 5000, 1), 50000);
  const lines = [sourceRef(spec.sourceDatabase, spec.sourceTable)];
  lines.push(`| where ${ts} > ago(${lookback})`);
  if (spec.keyColumn && spec.keyValue != null && spec.keyValue !== '') {
    lines.push(`| where ${bq(spec.keyColumn)} == '${String(spec.keyValue).replace(/'/g, "\\'")}'`);
  }
  const measure = agg === 'count' ? 'count()' : `${agg}(${castFn('real')}(${bq(spec.valueColumn)}))`;
  lines.push(`| summarize value = ${measure} by bin(${ts}, ${bin})`);
  lines.push(`| order by ${ts} asc`);
  lines.push(`| take ${limit}`);
  return lines.join('\n');
}
