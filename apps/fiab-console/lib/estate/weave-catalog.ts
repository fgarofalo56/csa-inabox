/**
 * WS-8 — Cross-workload node registry (the "13 Weave bridges" as a typed graph).
 *
 * This module is the SINGLE typed catalog that both the NL-to-Full-Estate
 * planner (8.1) and the One-Canvas authoring surface (8.2) build on. It layers
 * two facts over the existing `THREAD_ACTIONS` (the Weave bridge registry in
 * `lib/thread/thread-actions.ts`) without duplicating any of it:
 *
 *   1. `ACTION_PRODUCES` — the item TYPE each Weave bridge creates. A
 *      `ThreadAction` declares its SOURCE types (`fromTypes`) + the BFF route it
 *      POSTs to, but not the target item type (the route decides). The planner
 *      and canvas need the target to chain bridges (lakehouse → report → API →
 *      data-agent → …), so we record it here, grounded in each route's real
 *      `createOwnedItem(session, '<type>', …)` call.
 *
 *   2. `ESTATE_NODE_KINDS` — the typed cross-workload node palette
 *      (table/notebook/KQL/measure/ontology-object/model/agent/report + the
 *      data stores that root a topology). Each maps to a real Loom item type.
 *
 * Nothing here calls Azure or mutates state — pure data + lookups, so the plan
 * DAG math is unit-testable without React or a backend (no-vaporware: the REAL
 * bridge calls happen in `estate-executor` via the actual thread routes).
 *
 * Grounding: every `producesType` below is the literal `createOwnedItem` /
 * item-type argument in the matching `app/api/thread/<route>/route.ts` handler.
 */

import { THREAD_ACTIONS, type ThreadAction } from '@/lib/thread/thread-actions';

/**
 * The item TYPE each Weave bridge (ThreadAction id) creates — grounded in the
 * `createOwnedItem` call inside the action's BFF route. Bridges that mutate an
 * existing target instead of creating a new item (e.g. `mirror-to-lakehouse`
 * adds shortcuts to a chosen lakehouse; `materialize-to-kql` binds an ADX
 * external table into a chosen kql-database; `bind-to-ontology` binds rows onto
 * a chosen ontology) record the type they PRODUCE/attach into, so the DAG still
 * types the downstream node correctly.
 */
export const ACTION_PRODUCES: Record<string, string> = {
  'analyze-in-notebook': 'notebook',
  'bind-to-ontology': 'ontology',
  'add-data-agent-source': 'data-agent',
  'build-report-from-model': 'report',
  'build-loom-report': 'report',
  'analyze-in-powerbi': 'report',
  'build-powerbi-model': 'semantic-model',
  'publish-as-api': 'data-api-builder',
  'mirror-explore-notebook': 'notebook',
  'mirror-to-lakehouse': 'lakehouse',
  'analyze-with-dax': 'semantic-model',
  'materialize-to-kql': 'kql-database',
  'create-dashboard-tile-from-query': 'kql-dashboard',
  'promote-medallion': 'notebook',
};

/** A Weave bridge as the planner/canvas consume it (source → produced type). */
export interface WeaveBridge {
  /** ThreadAction id. */
  id: string;
  label: string;
  /** Source item-type slugs the bridge can run FROM ('*' = any). */
  fromTypes: string[] | '*';
  /** Item type the bridge creates / attaches into. */
  producesType: string;
  /** The BFF route the executor POSTs `{ from, values }` to (the REAL bridge). */
  route: string;
  /** The action's guided field names (for planner value validation). */
  fieldNames: string[];
}

/** Build the typed bridge list from the live THREAD_ACTIONS registry. */
export const WEAVE_BRIDGES: WeaveBridge[] = THREAD_ACTIONS.map((a: ThreadAction) => ({
  id: a.id,
  label: a.label,
  fromTypes: a.fromTypes,
  producesType: ACTION_PRODUCES[a.id] || 'item',
  route: a.route,
  fieldNames: a.fields.map((f) => f.name),
}));

const BRIDGE_BY_ID = new Map(WEAVE_BRIDGES.map((b) => [b.id, b]));

/** Look up a Weave bridge by ThreadAction id. */
export function bridgeById(id: string): WeaveBridge | undefined {
  return BRIDGE_BY_ID.get(id);
}

/** True when a bridge can run from a source of `sourceType`. */
export function bridgeAcceptsSource(bridge: WeaveBridge, sourceType: string): boolean {
  return bridge.fromTypes === '*' || bridge.fromTypes.includes(sourceType);
}

/** Every bridge that can run FROM an item of `sourceType` (the canvas menu). */
export function bridgesFrom(sourceType: string): WeaveBridge[] {
  return WEAVE_BRIDGES.filter((b) => bridgeAcceptsSource(b, sourceType));
}

/**
 * A typed node kind on the One-Canvas palette. Each maps to a real Loom item
 * type. `root` kinds can start a topology (created directly); non-root kinds are
 * normally produced by a Weave bridge from an upstream node, but may also be
 * dropped as a root when the user wants to attach an existing item.
 */
export interface EstateNodeKind {
  /** The Loom item-type slug this node creates. */
  itemType: string;
  /** Palette label. */
  label: string;
  /** A one-line description for the palette + inspector. */
  hint: string;
  /** True when this kind can be the ROOT of a topology (created directly, no
   *  upstream bridge required — a data store or ontology). */
  root: boolean;
}

/**
 * The cross-workload node palette (8.2). Ordered ingest → transform → serve →
 * visualize → publish so the palette reads as the medallion+serving spine —
 * table / notebook / KQL / measure / ontology-object / model / agent / report.
 */
export const ESTATE_NODE_KINDS: EstateNodeKind[] = [
  { itemType: 'lakehouse', label: 'Lakehouse (table)', hint: 'ADLS Gen2 + Delta table — the ingest root.', root: true },
  { itemType: 'warehouse', label: 'Warehouse', hint: 'Synapse dedicated SQL — a serving warehouse.', root: true },
  { itemType: 'kql-database', label: 'KQL database', hint: 'Azure Data Explorer — real-time / KQL store.', root: true },
  { itemType: 'notebook', label: 'Notebook', hint: 'Spark/SQL transform — reads an attached source.', root: false },
  { itemType: 'semantic-model', label: 'Semantic model (measure)', hint: 'Loom-native tabular layer + DAX measures.', root: false },
  { itemType: 'ontology', label: 'Ontology object', hint: 'Weave ontology object type — the semantic substrate.', root: true },
  { itemType: 'ml-model', label: 'Model', hint: 'A registered ML model over the estate.', root: true },
  { itemType: 'data-agent', label: 'Data agent', hint: 'Grounded NL agent over the estate.', root: false },
  { itemType: 'report', label: 'Report', hint: 'Loom-native report over a semantic model.', root: false },
  { itemType: 'data-api-builder', label: 'API', hint: 'REST + GraphQL over a warehouse table.', root: false },
  { itemType: 'kql-dashboard', label: 'KQL dashboard', hint: 'Real-Time Dashboard tiles over ADX.', root: false },
];

const NODE_KIND_BY_TYPE = new Map(ESTATE_NODE_KINDS.map((k) => [k.itemType, k]));

/** Look up a node kind by item type. */
export function nodeKind(itemType: string): EstateNodeKind | undefined {
  return NODE_KIND_BY_TYPE.get(itemType);
}
