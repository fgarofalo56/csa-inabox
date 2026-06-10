/**
 * Fabric IQ / Microsoft IQ — unified intelligence surface for external agents.
 *
 * "Fabric IQ" (Build 2026 #1+#6) packages an organization's ONTOLOGY (the
 * conceptual entity model), its SEMANTIC layer (curated tables + measures +
 * relationships), and its LIVE operational SIGNALS (real-time telemetry) into a
 * single queryable knowledge surface that external agents — Microsoft Agent 365,
 * Azure AI Foundry agents, Copilot Studio — can ground on.
 *
 * Loom is 100% Azure-native (per .claude/rules/no-fabric-dependency.md): there is
 * NO dependency on a real Microsoft Fabric / Power BI workspace. The three IQ
 * layers map to real Azure backends:
 *
 *   Ontology  → Loom `ontology` items (Cosmos), the DSL class hierarchy + the
 *               Lakehouse/Warehouse entity bindings (ADLS Gen2 / Synapse).
 *   Semantic  → Loom `semantic-model` items (Cosmos) — tables, measures (DAX),
 *               and relationships of the Azure-native tabular layer.
 *   Signals   → Azure Data Explorer (Kusto) — the same eventhouse-equivalent
 *               cluster the kql-database / kql-dashboard items query.
 *
 * This module is the data layer behind the IQ MCP server endpoint
 * (`/api/iq/mcp`). Every function returns REAL data from the above backends or
 * an honest, structured gate — no mocks, no placeholders (no-vaporware).
 */

import {
  listOwnedItems,
  loadOwnedItem,
} from '../../app/api/items/_lib/item-crud';
import {
  parseOntologyHierarchy,
  type OntologyClass,
  type OntologyEntityBinding,
} from '../editors/_family-utils';
import {
  kustoConfigGate,
  defaultDatabase,
  executeQuery,
  listTables as listKustoTables,
  type KustoQueryResult,
} from './kusto-client';

// ----------------------------------------------------------------------------
// Shared shapes
// ----------------------------------------------------------------------------

/** A structured, machine-readable gate when a backend is not provisioned. */
export interface IqGate {
  /** The env var / role / resource the operator must supply. */
  missing: string;
  /** Human-readable remediation. */
  detail: string;
}

export interface IqOntologySummary {
  id: string;
  name: string;
  description?: string;
  entityCount: number;
  bindingCount: number;
  updatedAt?: string;
}

export interface IqOntologyDetail extends IqOntologySummary {
  /** Parsed entity types (classes) with their parent + description. */
  entities: OntologyClass[];
  /** IS_A relationships (child → parent) derived from the class hierarchy. */
  relationships: Array<{ from: string; to: string; type: 'IS_A' }>;
  /** Lakehouse / Warehouse bindings that materialize entity instances. */
  bindings: OntologyEntityBinding[];
}

export interface IqSemanticSummary {
  id: string;
  name: string;
  description?: string;
  tableCount: number;
  measureCount: number;
  relationshipCount: number;
  updatedAt?: string;
}

export interface IqSemanticTable {
  name: string;
  columns: Array<{ name: string; dataType?: string }>;
}
export interface IqSemanticMeasure {
  name: string;
  expression?: string;
  table?: string;
  description?: string;
}
export interface IqSemanticRelationship {
  fromTable?: string;
  fromColumn?: string;
  toTable?: string;
  toColumn?: string;
}

export interface IqSemanticDetail extends IqSemanticSummary {
  tables: IqSemanticTable[];
  measures: IqSemanticMeasure[];
  relationships: IqSemanticRelationship[];
}

// ----------------------------------------------------------------------------
// Ontology layer (Loom `ontology` items)
// ----------------------------------------------------------------------------

function ontologyDetailFrom(item: {
  id: string;
  displayName: string;
  description?: string;
  state?: Record<string, unknown>;
  updatedAt?: string;
}): IqOntologyDetail {
  const state = (item.state || {}) as Record<string, unknown>;
  const source = typeof state.source === 'string' ? state.source : '';
  const entities = parseOntologyHierarchy(source);
  const relationships = entities
    .filter((c) => c.parent)
    .map((c) => ({ from: c.name, to: c.parent as string, type: 'IS_A' as const }));
  const bindings = Array.isArray(state.entityBindings)
    ? (state.entityBindings as OntologyEntityBinding[])
    : [];
  return {
    id: item.id,
    name: item.displayName,
    description: item.description,
    entityCount: entities.length,
    bindingCount: bindings.length,
    updatedAt: item.updatedAt,
    entities,
    relationships,
    bindings,
  };
}

/** List every ontology the tenant owns, with entity/binding counts. */
export async function listIqOntologies(tenantId: string): Promise<IqOntologySummary[]> {
  const items = await listOwnedItems('ontology', tenantId);
  return items.map((it) => {
    const d = ontologyDetailFrom(it);
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      entityCount: d.entityCount,
      bindingCount: d.bindingCount,
      updatedAt: d.updatedAt,
    };
  });
}

/** Full ontology detail (entities + IS_A relationships + data bindings). */
export async function getIqOntology(
  tenantId: string,
  id: string,
): Promise<IqOntologyDetail | null> {
  const item = await loadOwnedItem(id, 'ontology', tenantId);
  if (!item) return null;
  return ontologyDetailFrom(item);
}

// ----------------------------------------------------------------------------
// Semantic layer (Loom `semantic-model` items)
// ----------------------------------------------------------------------------

/**
 * Semantic-model content lives either directly on `state` or under
 * `state.content` (the bundle/provisioner shape). Normalize both.
 */
function semanticContent(state: Record<string, unknown>): {
  tables: any[];
  measures: any[];
  relationships: any[];
} {
  const content =
    state.content && typeof state.content === 'object'
      ? (state.content as Record<string, unknown>)
      : state;
  return {
    tables: Array.isArray(content.tables) ? (content.tables as any[]) : [],
    measures: Array.isArray(content.measures) ? (content.measures as any[]) : [],
    relationships: Array.isArray(content.relationships)
      ? (content.relationships as any[])
      : [],
  };
}

function semanticDetailFrom(item: {
  id: string;
  displayName: string;
  description?: string;
  state?: Record<string, unknown>;
  updatedAt?: string;
}): IqSemanticDetail {
  const { tables, measures, relationships } = semanticContent(
    (item.state || {}) as Record<string, unknown>,
  );
  const normTables: IqSemanticTable[] = tables.map((t: any) => ({
    name: String(t?.name ?? ''),
    columns: Array.isArray(t?.columns)
      ? t.columns.map((c: any) => ({
          name: String(c?.name ?? ''),
          dataType: c?.dataType ?? c?.type,
        }))
      : [],
  }));
  const normMeasures: IqSemanticMeasure[] = measures.map((m: any) => ({
    name: String(m?.name ?? ''),
    expression: m?.expression ?? m?.dax,
    table: m?.table,
    description: m?.description,
  }));
  const normRels: IqSemanticRelationship[] = relationships.map((r: any) => ({
    fromTable: r?.fromTable ?? r?.from?.table,
    fromColumn: r?.fromColumn ?? r?.from?.column,
    toTable: r?.toTable ?? r?.to?.table,
    toColumn: r?.toColumn ?? r?.to?.column,
  }));
  return {
    id: item.id,
    name: item.displayName,
    description: item.description,
    tableCount: normTables.length,
    measureCount: normMeasures.length,
    relationshipCount: normRels.length,
    updatedAt: item.updatedAt,
    tables: normTables,
    measures: normMeasures,
    relationships: normRels,
  };
}

/** List every semantic model the tenant owns, with table/measure counts. */
export async function listIqSemanticModels(tenantId: string): Promise<IqSemanticSummary[]> {
  const items = await listOwnedItems('semantic-model', tenantId);
  return items.map((it) => {
    const d = semanticDetailFrom(it);
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      tableCount: d.tableCount,
      measureCount: d.measureCount,
      relationshipCount: d.relationshipCount,
      updatedAt: d.updatedAt,
    };
  });
}

/** Full semantic-model detail (tables + measures + relationships). */
export async function getIqSemanticModel(
  tenantId: string,
  id: string,
): Promise<IqSemanticDetail | null> {
  const item = await loadOwnedItem(id, 'semantic-model', tenantId);
  if (!item) return null;
  return semanticDetailFrom(item);
}

// ----------------------------------------------------------------------------
// Live-signals layer (Azure Data Explorer / Kusto)
// ----------------------------------------------------------------------------

/** A read-only KQL guard — only SELECT-style queries reach the cluster. */
const FORBIDDEN_KQL = /\.(drop|set|append|create|alter|delete|ingest|rename|purge|move)\b/i;

export interface IqSignalResult {
  database: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

/** List the live-signal tables available on the ADX cluster. */
export async function listIqSignalTables(): Promise<
  { tables: Array<{ name: string; folder?: string; description?: string }>; database: string } | { gate: IqGate }
> {
  const gate = kustoConfigGate();
  if (gate) {
    return {
      gate: {
        missing: gate.missing,
        detail:
          'Live signals require an Azure Data Explorer cluster. Set LOOM_ADX_CLUSTER_URI (and grant the Console UAMI AllDatabasesViewer) to enable the signals layer.',
      },
    };
  }
  const db = defaultDatabase();
  const tables = await listKustoTables(db);
  return {
    database: db,
    tables: tables.map((t) => ({ name: t.name, folder: t.folder, description: t.docString })),
  };
}

/**
 * Run a read-only KQL query against the live-signals (ADX) cluster.
 * Rejects any control/management or data-mutating command.
 */
export async function queryIqSignals(
  kql: string,
  database?: string,
  maxRows = 500,
): Promise<IqSignalResult | { gate: IqGate } | { error: string }> {
  const gate = kustoConfigGate();
  if (gate) {
    return {
      gate: {
        missing: gate.missing,
        detail:
          'Live signals require an Azure Data Explorer cluster. Set LOOM_ADX_CLUSTER_URI (and grant the Console UAMI AllDatabasesViewer).',
      },
    };
  }
  const q = String(kql || '').trim();
  if (!q) return { error: 'kql query is required' };
  if (q.startsWith('.') || FORBIDDEN_KQL.test(q)) {
    return { error: 'Only read-only KQL queries are permitted on the IQ signals endpoint (no control/management commands).' };
  }
  const db = (database || defaultDatabase()).trim();
  // Cap the result set with a `take` if the caller didn't bound it themselves.
  const bounded = /\btake\b|\blimit\b|\btop\b/i.test(q) ? q : `${q}\n| take ${Math.max(1, Math.min(maxRows, 5000))}`;
  const res: KustoQueryResult = await executeQuery(db, bounded);
  return {
    database: db,
    columns: Array.isArray(res.columns) ? res.columns : [],
    rows: Array.isArray(res.rows) ? res.rows : [],
    rowCount: Array.isArray(res.rows) ? res.rows.length : 0,
  };
}

// ----------------------------------------------------------------------------
// Unified IQ overview (one call → all three layers at a glance)
// ----------------------------------------------------------------------------

export interface IqOverview {
  ontologies: IqOntologySummary[];
  semanticModels: IqSemanticSummary[];
  signals: { available: boolean; database?: string; tableCount?: number; gate?: IqGate };
  generatedAt: string;
}

/** One call that an external agent uses to discover the whole IQ surface. */
export async function getIqOverview(tenantId: string): Promise<IqOverview> {
  const [ontologies, semanticModels, signalsResult] = await Promise.all([
    listIqOntologies(tenantId),
    listIqSemanticModels(tenantId),
    listIqSignalTables(),
  ]);
  const signals =
    'gate' in signalsResult
      ? { available: false, gate: signalsResult.gate }
      : { available: true, database: signalsResult.database, tableCount: signalsResult.tables.length };
  return { ontologies, semanticModels, signals, generatedAt: new Date().toISOString() };
}

// ----------------------------------------------------------------------------
// Unified search across ontology + semantic layers
// ----------------------------------------------------------------------------

export interface IqSearchHit {
  layer: 'ontology' | 'semantic';
  kind: 'entity' | 'binding' | 'table' | 'measure';
  name: string;
  description?: string;
  /** Owning item (ontology/semantic-model) id + name for deep-linking. */
  itemId: string;
  itemName: string;
}

/**
 * Search the conceptual + semantic layers for a term. Matches entity names,
 * measure names, and table names (case-insensitive substring). Signals are not
 * searched here (they are queried via queryIqSignals).
 */
export async function searchIq(tenantId: string, term: string, limit = 50): Promise<IqSearchHit[]> {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) return [];
  const hits: IqSearchHit[] = [];

  const [ontos, semantics] = await Promise.all([
    listOwnedItems('ontology', tenantId),
    listOwnedItems('semantic-model', tenantId),
  ]);

  for (const o of ontos) {
    const d = ontologyDetailFrom(o);
    for (const e of d.entities) {
      if (e.name.toLowerCase().includes(needle) || (e.description || '').toLowerCase().includes(needle)) {
        hits.push({ layer: 'ontology', kind: 'entity', name: e.name, description: e.description, itemId: d.id, itemName: d.name });
      }
    }
    for (const b of d.bindings) {
      if (b.sourceDisplayName?.toLowerCase().includes(needle)) {
        hits.push({ layer: 'ontology', kind: 'binding', name: b.sourceDisplayName, description: `${b.sourceKind} → ${(b.entityTypes || []).join(', ')}`, itemId: d.id, itemName: d.name });
      }
    }
  }

  for (const s of semantics) {
    const d = semanticDetailFrom(s);
    for (const t of d.tables) {
      if (t.name.toLowerCase().includes(needle)) {
        hits.push({ layer: 'semantic', kind: 'table', name: t.name, itemId: d.id, itemName: d.name });
      }
    }
    for (const m of d.measures) {
      if (m.name.toLowerCase().includes(needle) || (m.description || '').toLowerCase().includes(needle)) {
        hits.push({ layer: 'semantic', kind: 'measure', name: m.name, description: m.description, itemId: d.id, itemName: d.name });
      }
    }
  }

  return hits.slice(0, limit);
}
