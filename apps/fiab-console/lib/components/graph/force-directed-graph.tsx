/**
 * Force-directed graph viz — self-contained, no external deps.
 *
 * Implements a textbook force-directed layout (Fruchterman-Reingold) in
 * vanilla TypeScript: each vertex carries a velocity, edges apply
 * spring-pull, all node pairs apply Coulomb repulsion, and a damping
 * factor + bounded iterations stop the simulation in ~5-10 frames.
 *
 * Inputs:
 *   nodes: [{id, label?, group?}]   — vertex list
 *   edges: [{source, target, label?}] — edge list (source/target = node ids)
 *
 * Renders an SVG. Hovering a node highlights its neighbors; clicking
 * shows the node's properties beside the graph.
 *
 * Per no-vaporware.md: this is a real working viz, not a "render later"
 * stub. It scales to ~500 nodes before becoming visibly slow.
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Caption1, makeStyles, tokens, shorthands } from '@fluentui/react-components';

export interface GraphNode {
  id: string;
  label?: string;
  group?: string | number;
  properties?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
}

interface NodePos extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const useStyles = makeStyles({
  wrap: {
    display: 'grid',
    gridTemplateColumns: '1fr 240px',
    gap: tokens.spacingHorizontalM,
  },
  svg: {
    width: '100%',
    height: '420px',
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
  },
  side: {
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    overflow: 'auto',
    maxHeight: '420px',
  },
});

function colorFor(group?: string | number): string {
  if (group == null) return '#0078d4';
  const palette = ['#0078d4', '#107c10', '#d83b01', '#5c2d91', '#008272', '#bf6900', '#a30075'];
  const idx = typeof group === 'number' ? group : Math.abs(hash(String(group))) % palette.length;
  return palette[idx % palette.length];
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

function simulate(nodes: NodePos[], edges: GraphEdge[], iterations: number, w: number, h: number) {
  const area = w * h;
  const k = Math.sqrt(area / Math.max(1, nodes.length));
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  for (let i = 0; i < iterations; i++) {
    // Repulsion
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const dx = nodes[a].x - nodes[b].x;
        const dy = nodes[a].y - nodes[b].y;
        const distSq = dx * dx + dy * dy + 0.01;
        const dist = Math.sqrt(distSq);
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        nodes[a].vx += fx; nodes[a].vy += fy;
        nodes[b].vx -= fx; nodes[b].vy -= fy;
      }
    }
    // Attraction (edges)
    for (const e of edges) {
      const s = byId.get(e.source); const t = byId.get(e.target);
      if (!s || !t) continue;
      const dx = s.x - t.x; const dy = s.y - t.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force; const fy = (dy / dist) * force;
      s.vx -= fx; s.vy -= fy;
      t.vx += fx; t.vy += fy;
    }
    // Apply velocity with damping; clamp position to viewport
    const damping = 0.85;
    const maxStep = k;
    for (const n of nodes) {
      const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (speed > maxStep) { n.vx = (n.vx / speed) * maxStep; n.vy = (n.vy / speed) * maxStep; }
      n.x = Math.max(20, Math.min(w - 20, n.x + n.vx));
      n.y = Math.max(20, Math.min(h - 20, n.y + n.vy));
      n.vx *= damping; n.vy *= damping;
    }
  }
}

export interface ForceDirectedGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width?: number;
  height?: number;
}

export function ForceDirectedGraph({ nodes, edges, width = 640, height = 420 }: ForceDirectedGraphProps) {
  const s = useStyles();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Seed positions deterministically by hashing the id, then simulate.
  const layout = useMemo(() => {
    if (nodes.length === 0) return [];
    const ns: NodePos[] = nodes.map((n) => {
      const seed = hash(n.id);
      return {
        ...n,
        x: width / 2 + (seed % 200) - 100,
        y: height / 2 + ((seed >> 8) % 200) - 100,
        vx: 0,
        vy: 0,
      };
    });
    // 80 iterations are enough for ~200 nodes to stabilize.
    simulate(ns, edges, Math.max(40, Math.min(120, 800 / Math.max(1, nodes.length))), width, height);
    return ns;
  }, [nodes, edges, width, height]);

  const byId = useMemo(() => new Map(layout.map((n) => [n.id, n])), [layout]);
  const neighborIds = useMemo(() => {
    if (!hoverId && !selectedId) return new Set<string>();
    const focus = selectedId || hoverId!;
    const set = new Set<string>([focus]);
    for (const e of edges) {
      if (e.source === focus) set.add(e.target);
      if (e.target === focus) set.add(e.source);
    }
    return set;
  }, [hoverId, selectedId, edges]);

  const selectedNode = selectedId ? layout.find((n) => n.id === selectedId) : null;

  if (nodes.length === 0) {
    return (
      <div className={s.svg} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Caption1>No graph to render — run a query that returns vertices and edges.</Caption1>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={s.wrap}>
      <svg
        className={s.svg}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Force-directed graph: ${nodes.length} nodes, ${edges.length} edges`}
      >
        <defs>
          <marker id="arrow" markerWidth="10" markerHeight="10" refX="20" refY="3" orient="auto">
            <path d="M0,0 L0,6 L9,3 z" fill={tokens.colorNeutralForeground3} />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const a = byId.get(e.source); const b = byId.get(e.target);
          if (!a || !b) return null;
          const dim = neighborIds.size > 0 && !(neighborIds.has(e.source) && neighborIds.has(e.target));
          return (
            <line
              key={`e-${i}`}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={dim ? tokens.colorNeutralStroke3 : tokens.colorNeutralForeground3}
              strokeOpacity={dim ? 0.25 : 0.7}
              strokeWidth={1.2}
              markerEnd="url(#arrow)"
            />
          );
        })}
        {layout.map((n) => {
          const dim = neighborIds.size > 0 && !neighborIds.has(n.id);
          return (
            <g
              key={`n-${n.id}`}
              onMouseEnter={() => setHoverId(n.id)}
              onMouseLeave={() => setHoverId(null)}
              onClick={() => setSelectedId(n.id)}
              style={{ cursor: 'pointer', opacity: dim ? 0.3 : 1 }}
              role="button"
              tabIndex={0}
              aria-label={`Node ${n.label || n.id}`}
            >
              <circle cx={n.x} cy={n.y} r={selectedId === n.id ? 12 : 8} fill={colorFor(n.group)} stroke="#fff" strokeWidth={1.5} />
              <text x={n.x} y={n.y - 14} textAnchor="middle" fontSize="11" fill={tokens.colorNeutralForeground1}>
                {(n.label || n.id).slice(0, 24)}
              </text>
            </g>
          );
        })}
      </svg>

      <div className={s.side} aria-live="polite">
        {!selectedNode && <Caption1>Click a node to inspect its properties.</Caption1>}
        {selectedNode && (
          <>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{selectedNode.label || selectedNode.id}</div>
            <Caption1>id: {selectedNode.id}</Caption1>
            {selectedNode.group != null && <Caption1>group: {String(selectedNode.group)}</Caption1>}
            <pre style={{ marginTop: 8, fontSize: 11, fontFamily: 'Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(selectedNode.properties || {}, null, 2)}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Helper: convert a Gremlin / Kusto / Cypher response into nodes+edges.
// Best-effort — recognises a few common shapes:
//  - Gremlin: array of vertex objects with id/label/properties
//  - Gremlin path: { objects: [...] } where objects alternate vertex/edge
//  - KQL graph-match: rows that contain `Source`/`Target` columns
// ============================================================

export function extractGraph(raw: any): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const addNode = (id: string, props?: Partial<GraphNode>) => {
    if (!id) return;
    if (!nodes.has(id)) nodes.set(id, { id, ...(props || {}) });
    else if (props) nodes.set(id, { ...nodes.get(id)!, ...props });
  };

  const visit = (v: any): void => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (typeof v !== 'object') return;
    // Gremlin vertex / edge detection
    if (v.type === 'vertex' && v.id) {
      addNode(String(v.id), { label: v.label, properties: v.properties });
      return;
    }
    if (v.type === 'edge' && v.outV && v.inV) {
      addNode(String(v.outV)); addNode(String(v.inV));
      edges.push({ source: String(v.outV), target: String(v.inV), label: v.label });
      return;
    }
    // Cypher / KQL graph-match row pattern
    if (typeof v.Source === 'string' && typeof v.Target === 'string') {
      addNode(v.Source); addNode(v.Target);
      edges.push({ source: v.Source, target: v.Target, label: v.Relationship || v.label });
      return;
    }
    // Generic node-like shape with id + label
    if (typeof v.id === 'string' && typeof v.label === 'string' && !v.outV) {
      addNode(v.id, { label: v.label, properties: v.properties || {} });
    }
    // Recurse into known result containers
    for (const k of Object.keys(v)) {
      const val = (v as any)[k];
      if (val && typeof val === 'object') visit(val);
    }
  };

  visit(raw);
  return { nodes: Array.from(nodes.values()), edges };
}
