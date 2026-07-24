/**
 * N4 part 3 — the model DAG as **software-defined assets**.
 *
 * This module owns the ONE emitted node/edge shape for a transformation
 * project's graph. It is deliberately UI-free (no React, no React Flow types)
 * and exported as the stable contract so the N5 asset plane can consume the
 * same nodes/edges without re-deriving them from the project model:
 *
 *   buildTransformDag(project, impact?) → { nodes, edges }
 *   layoutTransformDag(dag)            → { [nodeId]: { x, y } }
 *
 * Every node carries an `asset` descriptor (stable key, group, owners, tags,
 * materialization, freshness cadence) — that descriptor IS the software-defined
 * asset record; the canvas simply renders it.
 *
 * PURE — safe to import from the editor, the BFF, and tests alike.
 */

import type { ImpactChangeType, ImpactSeverity, PlanImpact } from './plan-impact';
import type {
  TransformBackend, TransformLayer, TransformMaterialization, TransformProject,
} from './transform-project-model';

/** What the node represents in the graph. */
export type TransformNodeKind = 'source' | 'model';

/** The software-defined-asset descriptor carried by every node (N5 contract). */
export interface TransformAsset {
  /** Stable, engine-neutral asset key: `<kind>:<schema>.<name>`. */
  key: string;
  /** Grouping used by the asset catalog — the medallion layer for models. */
  group: string;
  owners: string[];
  tags: string[];
  description?: string;
  /** Materialization for models; undefined for sources. */
  materialization?: TransformMaterialization;
  /** Declared refresh cadence, when the model states one. */
  cadence?: string;
}

export interface TransformDagNode {
  /** Node id — unique within the DAG (the model/source name). */
  id: string;
  /** Display name (compact: the canvas truncates to ~1 line). */
  name: string;
  kind: TransformNodeKind;
  layer?: TransformLayer;
  schema?: string;
  backend: TransformBackend;
  asset: TransformAsset;
  /** Plan impact for this node, when a plan has been previewed. */
  impact?: { severity: ImpactSeverity; changeType: ImpactChangeType; downstreamCount: number } | null;
  /** Count of upstream/downstream edges — used for layout + the inspector. */
  upstream: number;
  downstream: number;
}

export interface TransformDagEdge {
  id: string;
  source: string;
  target: string;
  /** `ref` = model→model; `source` = source-table→model. */
  kind: 'ref' | 'source';
  /** True when the plan marks the TARGET as impacted (the canvas highlights it). */
  impacted?: boolean;
}

export interface TransformDag {
  nodes: TransformDagNode[];
  edges: TransformDagEdge[];
}

/** `<sourceName>.<table>` is the source node id (matches `TransformModel.sources`). */
export function sourceNodeId(name: string, table: string): string {
  return `${name}.${table}`;
}

/**
 * Build the DAG from a project, optionally decorated with a plan's impact.
 * Impact lookup is name-tolerant: SQLMesh reports fully-qualified names
 * (`analytics.orders`) while the project stores bare names (`orders`), so a
 * suffix match on the last dotted segment is used.
 */
export function buildTransformDag(project: TransformProject, impact?: PlanImpact | null): TransformDag {
  const backend: TransformBackend = project.backend === 'sqlmesh' ? 'sqlmesh' : 'dbt';
  const schema = project.target?.schema || 'analytics';
  const nodes: TransformDagNode[] = [];
  const edges: TransformDagEdge[] = [];
  const upstream = new Map<string, number>();
  const downstream = new Map<string, number>();

  const impactByName = new Map<string, PlanImpact['rows'][number]>();
  for (const row of impact?.rows || []) {
    impactByName.set(row.model, row);
    const short = row.model.split('.').slice(-1)[0];
    if (short && !impactByName.has(short)) impactByName.set(short, row);
  }

  for (const s of project.sources || []) {
    const id = sourceNodeId(s.name, s.table);
    nodes.push({
      id,
      name: s.table,
      kind: 'source',
      schema: s.schema || s.name,
      backend,
      upstream: 0,
      downstream: 0,
      asset: {
        key: `source:${s.schema || s.name}.${s.table}`,
        group: 'sources',
        owners: [],
        tags: ['source'],
        description: s.description,
      },
      impact: null,
    });
  }

  for (const m of project.models || []) {
    const row = impactByName.get(m.name) || impactByName.get(`${schema}.${m.name}`) || null;
    nodes.push({
      id: m.name,
      name: m.name,
      kind: 'model',
      layer: m.layer,
      schema,
      backend,
      upstream: 0,
      downstream: 0,
      asset: {
        key: `model:${schema}.${m.name}`,
        group: m.layer,
        owners: m.owners || [],
        tags: m.tags || [],
        description: m.description,
        materialization: m.materialized,
        cadence: m.cron,
      },
      impact: row
        ? { severity: row.severity, changeType: row.changeType, downstreamCount: row.downstreamCount }
        : null,
    });
  }

  const known = new Set(nodes.map((n) => n.id));
  for (const m of project.models || []) {
    for (const r of m.refs || []) {
      if (!known.has(r)) continue; // dangling refs are surfaced by validation, not drawn
      edges.push({
        id: `ref:${r}->${m.name}`,
        source: r,
        target: m.name,
        kind: 'ref',
        impacted: !!impactByName.get(m.name) || !!impactByName.get(r),
      });
      upstream.set(m.name, (upstream.get(m.name) || 0) + 1);
      downstream.set(r, (downstream.get(r) || 0) + 1);
    }
    for (const s of m.sources || []) {
      if (!known.has(s)) continue;
      edges.push({ id: `src:${s}->${m.name}`, source: s, target: m.name, kind: 'source' });
      upstream.set(m.name, (upstream.get(m.name) || 0) + 1);
      downstream.set(s, (downstream.get(s) || 0) + 1);
    }
  }

  for (const n of nodes) {
    n.upstream = upstream.get(n.id) || 0;
    n.downstream = downstream.get(n.id) || 0;
  }

  return { nodes, edges };
}

/** Horizontal + vertical spacing for the layered layout (node-compact sizing). */
export const DAG_COLUMN_WIDTH = 260;
export const DAG_ROW_HEIGHT = 110;

/**
 * Deterministic layered (left→right) layout: sources first, then each model
 * placed one column right of its deepest upstream. Cycles (which the validator
 * rejects) are depth-capped so layout can never loop.
 */
export function layoutTransformDag(dag: TransformDag): Record<string, { x: number; y: number }> {
  const parents = new Map<string, string[]>();
  for (const n of dag.nodes) parents.set(n.id, []);
  for (const e of dag.edges) parents.get(e.target)?.push(e.source);

  const depth = new Map<string, number>();
  const maxDepth = dag.nodes.length + 1;
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id) || seen.size > maxDepth) return 0;
    seen.add(id);
    const ps = parents.get(id) || [];
    const d = ps.length === 0 ? 0 : Math.max(...ps.map((p) => resolve(p, seen))) + 1;
    seen.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const n of dag.nodes) resolve(n.id, new Set());

  const perColumn = new Map<number, number>();
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of dag.nodes) {
    const d = depth.get(n.id) || 0;
    const row = perColumn.get(d) || 0;
    perColumn.set(d, row + 1);
    out[n.id] = { x: d * DAG_COLUMN_WIDTH, y: row * DAG_ROW_HEIGHT };
  }
  return out;
}

/** The transitive downstream closure of a node — the wizard's blast radius. */
export function downstreamClosure(dag: TransformDag, nodeId: string): string[] {
  const children = new Map<string, string[]>();
  for (const e of dag.edges) {
    const list = children.get(e.source) || [];
    list.push(e.target);
    children.set(e.source, list);
  }
  const out = new Set<string>();
  const stack = [...(children.get(nodeId) || [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (out.has(next)) continue;
    out.add(next);
    for (const c of children.get(next) || []) stack.push(c);
  }
  return [...out].sort();
}
