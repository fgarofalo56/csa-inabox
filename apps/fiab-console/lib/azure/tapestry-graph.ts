/**
 * Tapestry investigative-graph helpers — shared by the link / geo / timeline
 * BFF routes (app/api/items/tapestry/[id]/{link,geo,timeline}).
 *
 * Tapestry is the Azure-native, Gotham-class investigation surface. Its three
 * analysis panes all run over the SAME materialized Node_<type> / Edge_<type>
 * ADX tables that the gql-graph editor already discovers — there is no second
 * graph engine and NO Microsoft Fabric dependency (per no-fabric-dependency.md):
 *
 *   - Link analysis   → KQL make-graph + graph-match / graph-shortest-paths /
 *                       graph-mark-components.
 *   - Geo analysis    → project node lat/lon properties into GeoJSON.
 *   - Timeline        → summarize count() by bin(<ts>, <window>) over Edge_*.
 *
 * The prelude builder is identical in spirit to the gql-graph route's, kept here
 * so all three Tapestry routes share one tested surface.
 *
 * Grounded in Microsoft Learn (KQL graph semantics):
 *   https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-semantics-overview
 *   https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-match-operator
 *   https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-operators
 */

import { listTables } from '@/lib/azure/kusto-client';

export interface GraphTables {
  nodeTables: string[];
  edgeTables: string[];
}

/**
 * Discover the materialized Node_* / Edge_* tables in a database. Returns the
 * two lists; callers gate on them being non-empty (honest "no graph yet" 400).
 */
export async function discoverGraphTables(db: string): Promise<GraphTables> {
  const tables = await listTables(db);
  const nodeTables = tables.map((t) => t.name).filter((n) => n.startsWith('Node_'));
  const edgeTables = tables.map((t) => t.name).filter((n) => n.startsWith('Edge_'));
  return { nodeTables, edgeTables };
}

/**
 * Build the `make-graph` prelude (a `let G = …;` expression) from the
 * materialized Node_ and Edge_ tables. Each Node_<T> carries `id`; we tag it
 * with `nodeLabel` so graph-match patterns can filter by entity type. Each
 * Edge_<T> carries src/dst; we tag with `edgeLabel`. 'Node_'/'Edge_' are both
 * 5-char prefixes — slice them off for the label.
 */
export function buildGraphPrelude(nodeTables: string[], edgeTables: string[]): string {
  const nodeUnion = nodeTables
    .map((t) => `(${t} | extend nodeLabel='${t.slice(5)}')`)
    .join(', ');
  const edgeUnion = edgeTables
    .map((t) => `(${t} | extend edgeLabel='${t.slice(5)}')`)
    .join(', ');
  return [
    // KQL reserves identifiers that start/end with a double underscore (`__`)
    // → SEM0041 "Invalid name of let expression". Use plain names instead.
    `let LoomNodes = union ${nodeUnion};`,
    `let LoomEdges = union ${edgeUnion};`,
    `let G = LoomEdges | make-graph src --> dst with LoomNodes on id;`,
  ].join('\n');
}

/** The link-analysis algorithms Tapestry exposes (typed — no freeform KQL). */
export type LinkAnalysis = 'pattern' | 'shortest-path' | 'components' | 'neighbors';

export interface LinkParams {
  analysis: LinkAnalysis;
  /** Max hop count for variable-length patterns / neighborhood expansion (1..6). */
  hops?: number;
  /** Optional source node id (shortest-path / neighbors). */
  sourceId?: string;
  /** Optional target node id (shortest-path). */
  targetId?: string;
  /** Optional node-label filter applied to both endpoints. */
  nodeLabel?: string;
  /** Result row cap. */
  limit?: number;
}

/** Clamp a number into [min,max] with a default. */
function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/**
 * KQL string-literal escaper for a value we embed inside a single-quoted KQL
 * string. The route validates ids against a strict allow-list first; this is a
 * defense-in-depth second layer.
 */
function kqlLit(v: string): string {
  return v.replace(/['\\]/g, (c) => `\\${c}`);
}

/** Reject ids with KQL-significant characters (defense in depth). */
export function isSafeId(v: string): boolean {
  return /^[A-Za-z0-9 ._:@/-]{1,256}$/.test(v);
}

/**
 * Build the full KQL for a link-analysis request. Returns the `prelude + body`
 * string ready for executeQuery. Every branch emits Source/Target columns so
 * the client's `extractGraph()` can render the force-directed canvas directly.
 */
export function buildLinkKql(prelude: string, p: LinkParams): string {
  const hops = clampInt(p.hops, 1, 6, 2);
  const limit = clampInt(p.limit, 1, 5000, 500);
  const labelWhere = p.nodeLabel && isSafeId(p.nodeLabel)
    ? ` where a.nodeLabel == '${kqlLit(p.nodeLabel)}' and b.nodeLabel == '${kqlLit(p.nodeLabel)}'`
    : '';

  switch (p.analysis) {
    case 'shortest-path': {
      // graph-shortest-paths between a named source and target (over all edge labels).
      const src = p.sourceId && isSafeId(p.sourceId) ? kqlLit(p.sourceId) : '';
      const tgt = p.targetId && isSafeId(p.targetId) ? kqlLit(p.targetId) : '';
      // graph-shortest-paths returns one row per path; project the endpoints +
      // the inner-node id list (map over the variable-length edge's inner nodes).
      const body = `G\n| graph-shortest-paths output=any (a)-[e*1..${hops}]->(b)\n  where a.id == '${src}' and b.id == '${tgt}'\n  project Source=a.id, Target=b.id, Path=map(inner_nodes(e), id)\n| limit ${limit}`;
      return `${prelude}\n${body}`;
    }
    case 'components': {
      // Connected-component clustering — graph-mark-components, then emit the
      // edges with each endpoint's component id as the `group`.
      const body = `G\n| graph-mark-components with_component_id=componentId\n| graph-match (a)-[e]->(b)\n  project Source=a.id, Target=b.id, SourceGroup=a.componentId, TargetGroup=b.componentId, Relationship=e.edgeLabel\n| limit ${limit}`;
      return `${prelude}\n${body}`;
    }
    case 'neighbors': {
      // N-hop neighborhood expansion from a single seed node.
      const src = p.sourceId && isSafeId(p.sourceId) ? kqlLit(p.sourceId) : '';
      const body = `G\n| graph-match (a)-[e*1..${hops}]->(b)\n  where a.id == '${src}'\n  project Source=a.id, Target=b.id, Relationship=map(e, edgeLabel)\n| limit ${limit}`;
      return `${prelude}\n${body}`;
    }
    case 'pattern':
    default: {
      // Generic pattern: every variable-length path up to <hops>, optionally
      // constrained to a node label. Returns the constituent edges as
      // Source/Target rows for the link canvas.
      const body = `G\n| graph-match (a)-[e*1..${hops}]->(b)${labelWhere}\n  project Source=a.id, Target=b.id, SourceGroup=a.nodeLabel, TargetGroup=b.nodeLabel, Relationship=map(e, edgeLabel)\n| limit ${limit}`;
      return `${prelude}\n${body}`;
    }
  }
}

/**
 * Build the KQL that projects every node carrying lat/lon properties into rows
 * the geo route turns into a GeoJSON FeatureCollection. We union the node
 * tables directly (no graph needed) and coalesce the common coordinate property
 * spellings. Nodes without coordinates are dropped.
 */
export function buildGeoKql(nodeTables: string[], limit = 5000): string {
  const lim = clampInt(limit, 1, 50000, 5000);
  const union = nodeTables
    .map((t) => `(${t} | extend nodeLabel='${t.slice(5)}')`)
    .join(', ');
  // Coalesce lat/lon across the property bag spellings ADX nodes commonly use.
  // (Column names avoid a `__` prefix — KQL reserves double-underscore identifiers.)
  return [
    `union ${union}`,
    `| extend geoLat = todouble(coalesce(column_ifexists('lat', real(null)), column_ifexists('latitude', real(null)), column_ifexists('Latitude', real(null))))`,
    `| extend geoLon = todouble(coalesce(column_ifexists('lon', real(null)), column_ifexists('lng', real(null)), column_ifexists('longitude', real(null)), column_ifexists('Longitude', real(null))))`,
    `| where isnotnull(geoLat) and isnotnull(geoLon)`,
    `| project Id=id, Label=nodeLabel, Name=tostring(coalesce(column_ifexists('name', ''), column_ifexists('Name', ''), id)), Latitude=geoLat, Longitude=geoLon`,
    `| limit ${lim}`,
  ].join('\n');
}

/** Timeline binning windows Tapestry exposes (typed — no freeform timespan). */
export const TIMELINE_WINDOWS = {
  hour: '1h',
  day: '1d',
  week: '7d',
} as const;
export type TimelineWindow = keyof typeof TIMELINE_WINDOWS;

/**
 * Build the KQL that bins Edge_* events over time. Each Edge_<T> is tagged with
 * its edgeLabel; we coalesce the common timestamp property spellings, bin by the
 * chosen window, and count per (bucket, edgeLabel) so the timeline shows how
 * each relationship type evolves. Rows without a timestamp are dropped.
 */
export function buildTimelineKql(edgeTables: string[], window: TimelineWindow): string {
  const span = TIMELINE_WINDOWS[window] || '1d';
  const union = edgeTables
    .map((t) => `(${t} | extend edgeLabel='${t.slice(5)}')`)
    .join(', ');
  return [
    `union ${union}`,
    `| extend evtTs = todatetime(coalesce(column_ifexists('timestamp', datetime(null)), column_ifexists('ts', datetime(null)), column_ifexists('Timestamp', datetime(null)), column_ifexists('eventTime', datetime(null)), column_ifexists('EventTime', datetime(null)), column_ifexists('since', datetime(null)), column_ifexists('Since', datetime(null))))`,
    `| where isnotnull(evtTs)`,
    `| summarize Count=count() by Bucket=bin(evtTs, ${span}), Relationship=edgeLabel`,
    `| sort by Bucket asc`,
    `| limit 5000`,
  ].join('\n');
}
