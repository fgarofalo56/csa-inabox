/**
 * Ontology-Over-Everything (WS-6 / BTB-1) — the binding substrate + pure
 * column→property mapping.
 *
 * This is the un-copyable differentiator: the Weave ontology is promoted to the
 * substrate every item can bind to. An `ontologyBinding` annotation on ANY
 * item's Cosmos `state` declares that the item's rows ARE typed instances of an
 * ontology object type — a lakehouse table, a KQL stream, and a semantic measure
 * can all bind to the SAME object type and resolve as instances of it.
 *
 * This module is the PURE spine (no React, no Node I/O) so the resolver service,
 * the BFF routes, and the copilot grounding path all import it, and it is fully
 * vitest-coverable:
 *   - the binding shape + normalizer,
 *   - the column→property mapping (per the object type's typed schema, coercing
 *     numeric/boolean values exactly like validateObjectInstance),
 *   - the per-source-kind query builders (SQL / KQL / DAX), each pure + injection
 *     -guarded (identifier validation, never string-concatenated user values).
 *
 * The actual backend reads (Synapse serverless/dedicated SQL over Delta/UC,
 * ADX/KQL, AAS/loom-native DAX, WS-3.2 zero-copy shortcut engineObjects) live in
 * ontology-resolver.ts, which composes these builders + this mapping.
 *
 * Azure-native + sovereign (ADLS/UC/ADX/AAS/AGE) — no Fabric, no Power BI. Per
 * .claude/rules/no-fabric-dependency.md the default resolution path never touches
 * a Fabric/OneLake REST host.
 */
import type { OntoObjectType, OntoBaseType } from '@/lib/editors/ontology-model';

// ============================================================
// Binding shape (persisted on an item's Cosmos `state.ontologyBinding`)
// ============================================================

/**
 * The source kinds a binding can resolve through. The three acceptance kinds
 * (lakehouse-table, kql, semantic-measure) resolve against real backends;
 * warehouse-table + shortcut are also wired; azure-sql is honest-gated this
 * slice (named at resolve time, per no-vaporware.md).
 */
export const ONTOLOGY_BINDING_SOURCE_KINDS = [
  'lakehouse-table',
  'warehouse-table',
  'kql',
  'semantic-measure',
  'shortcut',
  'azure-sql',
] as const;
export type OntologyBindingSourceKind = typeof ONTOLOGY_BINDING_SOURCE_KINDS[number];

/** Where a bound source's rows come from (Azure-native, no Fabric). */
export interface OntologyBindingSource {
  kind: OntologyBindingSourceKind;
  /**
   * The primary reference resolved per-kind:
   *   - lakehouse-table / warehouse-table / azure-sql → a SQL table (`schema.table`)
   *   - kql            → an ADX table / stream name
   *   - semantic-measure → a tabular table (TOPN) — or a measure via `measure`
   *   - shortcut       → the WS-3.2 engineObject (resolved from the registry when
   *                      `lakehouseId`+`shortcutId` are set, else used verbatim)
   */
  ref: string;
  /** Optional backend database override (KQL database, serverless DB, AAS db). */
  database?: string;
  /** For semantic-measure: a DAX measure name → `EVALUATE ROW("m", [m])`. */
  measure?: string;
  /** Cosmos item id of the backing source item (lakehouse/kql/semantic-model). */
  sourceItemId?: string;
  /** For kind='shortcut': resolve engineObject from the lakehouse-shortcuts registry. */
  lakehouseId?: string;
  shortcutId?: string;
}

/**
 * The binding annotation — the substrate edge. Persisted on the bound item's
 * Cosmos `state.ontologyBinding` (the item IS-A typed instance source for the
 * ontology object type).
 */
export interface OntologyBinding {
  /** Ontology item id that declares the object type. */
  ontologyId: string;
  /** Cached ontology display name (UI/provenance only). */
  ontologyName?: string;
  /** The object type (AGE label / apiName) rows resolve as typed instances of. */
  objectType: string;
  /** Source column → object property apiName. Empty ⇒ identity-by-name mapping. */
  columnMap?: Record<string, string>;
  /** The source column carrying the object's primary key (→ the instance id). */
  keyColumn?: string;
  /** The object type property that is the primary key (defaults to ot.primaryKey). */
  keyProperty?: string;
  source: OntologyBindingSource;
  /** ISO-8601 timestamp the binding was authored/last saved. */
  boundAt?: string;
}

/** A resolved typed instance — the same shape the AGE store returns, plus its
 *  provenance (the binding source kind that produced it, for lineage). */
export interface ResolvedInstance {
  id: string;
  objectType: string;
  properties: Record<string, unknown>;
  sourceKind: OntologyBindingSourceKind;
}

/** A tabular result from any backend (Synapse/Kusto/DAX all normalize to this). */
export interface SourceRows {
  columns: string[];
  rows: unknown[][];
}

// ============================================================
// Normalizer
// ============================================================

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** A safe identifier for property/column api-names (matches the ontology model). */
const IDENT_RE = /^[A-Za-z_][\w]{0,127}$/;

/** Coerce a persisted `state.ontologyBinding` value into a clean binding. */
export function normalizeOntologyBinding(raw: unknown): OntologyBinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ontologyId = str(r.ontologyId).trim();
  const objectType = str(r.objectType).trim();
  if (!ontologyId || !objectType) return null;

  const srcRaw = (r.source && typeof r.source === 'object' ? r.source : {}) as Record<string, unknown>;
  const kind = str(srcRaw.kind).trim() as OntologyBindingSourceKind;
  const ref = str(srcRaw.ref).trim();
  if (!(ONTOLOGY_BINDING_SOURCE_KINDS as readonly string[]).includes(kind)) return null;
  // A shortcut binding may resolve its ref from the registry (lakehouseId+shortcutId),
  // so ref can be empty ONLY for the shortcut kind.
  if (!ref && kind !== 'shortcut') return null;

  const source: OntologyBindingSource = {
    kind,
    ref,
    ...(str(srcRaw.database).trim() ? { database: str(srcRaw.database).trim() } : {}),
    ...(str(srcRaw.measure).trim() ? { measure: str(srcRaw.measure).trim() } : {}),
    ...(str(srcRaw.sourceItemId).trim() ? { sourceItemId: str(srcRaw.sourceItemId).trim() } : {}),
    ...(str(srcRaw.lakehouseId).trim() ? { lakehouseId: str(srcRaw.lakehouseId).trim() } : {}),
    ...(str(srcRaw.shortcutId).trim() ? { shortcutId: str(srcRaw.shortcutId).trim() } : {}),
  };
  if (kind === 'shortcut' && !ref && !(source.lakehouseId && source.shortcutId)) return null;

  const columnMap: Record<string, string> = {};
  if (r.columnMap && typeof r.columnMap === 'object') {
    for (const [k, v] of Object.entries(r.columnMap as Record<string, unknown>)) {
      const col = str(k).trim();
      const prop = str(v).trim();
      if (col && IDENT_RE.test(prop)) columnMap[col] = prop;
    }
  }

  return {
    ontologyId,
    ...(str(r.ontologyName).trim() ? { ontologyName: str(r.ontologyName).trim() } : {}),
    objectType,
    ...(Object.keys(columnMap).length ? { columnMap } : {}),
    ...(str(r.keyColumn).trim() ? { keyColumn: str(r.keyColumn).trim() } : {}),
    ...(str(r.keyProperty).trim() ? { keyProperty: str(r.keyProperty).trim() } : {}),
    source,
    ...(str(r.boundAt).trim() ? { boundAt: str(r.boundAt).trim() } : {}),
  };
}

// ============================================================
// Column → property mapping (the substrate join)
// ============================================================

const NUMERIC_BASE_TYPES: ReadonlySet<OntoBaseType> = new Set<OntoBaseType>([
  'byte', 'short', 'integer', 'long', 'float', 'double', 'decimal',
]);

/**
 * The effective source-column → property mapping for a binding, in precedence:
 *   1. the binding's explicit `columnMap`,
 *   2. the object type's datasource `columnMap` (authored in the ontology editor),
 *   3. identity-by-name — each declared property maps from a source column of the
 *      same name.
 * Returns a map keyed by SOURCE column → property apiName.
 */
export function resolveColumnMap(binding: OntologyBinding, ot: OntoObjectType | null): Record<string, string> {
  if (binding.columnMap && Object.keys(binding.columnMap).length) return { ...binding.columnMap };
  const dsMap = ot?.datasource?.columnMap;
  if (dsMap && Object.keys(dsMap).length) return { ...dsMap };
  const out: Record<string, string> = {};
  for (const p of ot?.properties || []) out[p.apiName] = p.apiName;
  return out;
}

/** Coerce a raw cell to the property's declared base type (numeric/boolean/string). */
function coerceValue(baseType: OntoBaseType | undefined, arrayOf: boolean | undefined, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (arrayOf) return raw; // arrays pass through (source already shaped)
  if (baseType && NUMERIC_BASE_TYPES.has(baseType)) {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (baseType === 'boolean') {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
  }
  return typeof raw === 'string' ? raw : String(raw);
}

/**
 * Map ONE source row to a typed instance of the object type. Only columns the
 * mapping resolves to a DECLARED property become properties (unmapped source
 * columns are dropped — the ontology object is the contract, not the raw table).
 * The instance `id` is the key column's value (`keyColumn`, else the source
 * column of `keyProperty`/`ot.primaryKey`), else a synthesized ordinal id.
 */
export function mapRowToInstance(
  binding: OntologyBinding,
  ot: OntoObjectType | null,
  colMap: Record<string, string>,
  columns: string[],
  row: unknown[],
  index: number,
): ResolvedInstance {
  const propByName = new Map((ot?.properties || []).map((p) => [p.apiName, p]));
  const colIdx = new Map(columns.map((c, i) => [c, i] as const));
  const properties: Record<string, unknown> = {};

  for (const [sourceCol, propName] of Object.entries(colMap)) {
    const i = colIdx.get(sourceCol);
    if (i === undefined) continue; // the query did not return this column
    if (ot && ot.properties.length && !propByName.has(propName)) continue; // not a declared property
    const p = propByName.get(propName);
    properties[propName] = coerceValue(p?.baseType, p?.arrayOf, row[i]);
  }

  // Resolve the instance id: keyColumn value → keyProperty's source column →
  // ot.primaryKey's source column → synthesized ordinal.
  const keyProp = binding.keyProperty || ot?.primaryKey;
  let idCol = binding.keyColumn;
  if (!idCol && keyProp) {
    // find the source column mapped to the key property
    idCol = Object.entries(colMap).find(([, prop]) => prop === keyProp)?.[0];
  }
  let id = '';
  if (idCol) {
    const i = colIdx.get(idCol);
    if (i !== undefined && row[i] !== null && row[i] !== undefined) id = String(row[i]);
  }
  if (!id && keyProp && properties[keyProp] != null) id = String(properties[keyProp]);
  if (!id) id = `${binding.objectType}#${index}`;

  return { id, objectType: binding.objectType, properties, sourceKind: binding.source.kind };
}

/** Map a full tabular result to typed instances of the binding's object type. */
export function mapRowsToInstances(
  binding: OntologyBinding,
  ot: OntoObjectType | null,
  result: SourceRows,
): ResolvedInstance[] {
  const colMap = resolveColumnMap(binding, ot);
  return (result.rows || []).map((row, i) => mapRowToInstance(binding, ot, colMap, result.columns || [], row, i));
}

// ============================================================
// Query builders (pure, injection-guarded)
// ============================================================

/** Clamp a requested row cap to [1, 1000]. */
export function clampTop(top: number | undefined, def = 100): number {
  return Math.min(Math.max(Math.trunc(Number(top) || def) || def, 1), 1000);
}

/** A SQL object reference: bracketed or bare `schema.table` / `db.schema.table`. */
const SQL_REF_RE = /^[A-Za-z0-9_.$#[\]]+$/;
/** A KQL / DAX table identifier (bare or single-token). */
const KQL_IDENT_RE = /^[A-Za-z_][\w]{0,127}$/;
/** A DAX table/measure identifier (letters, digits, spaces, underscore). */
const DAX_IDENT_RE = /^[A-Za-z_][\w ]{0,127}$/;

export class BindingQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingQueryError';
  }
}

/**
 * `SELECT TOP <n> * FROM <ref>` — the resolver maps returned columns to
 * properties, so a projection is unnecessary and `*` avoids building a fragile
 * (injectable) column list. `ref` is validated to a safe SQL object reference;
 * anything else throws (never concatenated raw).
 */
export function buildSqlSelect(ref: string, top: number): string {
  const r = (ref || '').trim();
  if (!SQL_REF_RE.test(r)) {
    throw new BindingQueryError(`Unsafe SQL source reference '${ref}' — use a bare or bracketed schema.table.`);
  }
  return `SELECT TOP ${clampTop(top)} * FROM ${r}`;
}

/** `<table> | take <n>` — validated KQL table identifier. */
export function buildKql(ref: string, top: number): string {
  const r = (ref || '').trim();
  if (!KQL_IDENT_RE.test(r)) {
    throw new BindingQueryError(`Unsafe KQL table name '${ref}'.`);
  }
  return `${r} | take ${clampTop(top)}`;
}

/**
 * A DAX EVALUATE query. A measure ref → a single-row `EVALUATE ROW("m", [m])`;
 * a table ref → `EVALUATE TOPN(<n>, '<table>')`. Both identifiers are validated.
 */
export function buildDax(ref: string, top: number, measure?: string): string {
  if (measure) {
    const m = measure.trim();
    if (!DAX_IDENT_RE.test(m)) throw new BindingQueryError(`Unsafe DAX measure '${measure}'.`);
    return `EVALUATE ROW("${m}", [${m}])`;
  }
  const r = (ref || '').trim();
  if (!DAX_IDENT_RE.test(r)) throw new BindingQueryError(`Unsafe DAX table '${ref}'.`);
  return `EVALUATE TOPN(${clampTop(top)}, '${r}')`;
}

/** Human label for a source kind (UI + gate messages). */
export function sourceKindLabel(kind: OntologyBindingSourceKind): string {
  switch (kind) {
    case 'lakehouse-table': return 'Lakehouse table (Synapse Serverless over Delta)';
    case 'warehouse-table': return 'Warehouse table (Synapse Dedicated SQL)';
    case 'kql': return 'KQL stream (Azure Data Explorer)';
    case 'semantic-measure': return 'Semantic measure (Azure-native DAX)';
    case 'shortcut': return 'Zero-copy shortcut (WS-3.2 engineObject)';
    case 'azure-sql': return 'Azure SQL Database';
    default: return kind;
  }
}
