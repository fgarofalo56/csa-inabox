'use client';

/**
 * LOOM BRAIN VISUALIZER — the graph canvas.
 *
 * React Flow (`@xyflow/react` v12), already the canvas library for the network
 * topology, ADF/Synapse pipelines and the deploy planner — so this surface
 * reads and behaves like its siblings rather than introducing a second
 * interaction model (`web3-ui.md` §4).
 *
 * ── WHAT THIS CANVAS DOES THAT THE OTHERS DO NOT ───────────────────────────
 * It draws edges that GO NOWHERE, on purpose. Every other canvas in the console
 * draws connections between two things that exist; here, the wire whose target
 * is `null` is the most important object on screen. Each one is rendered to an
 * explicit "nothing" terminus in red and dashed, with its symbol as the edge
 * label — because dropping it (the obvious implementation, since React Flow
 * needs two endpoints) would delete the evidence that gives the founding
 * finding its meaning: not "the broker is idle" but "main.bicep:4730 tried to
 * wire it and shipped an empty string".
 *
 * ── LAYOUT IS DETERMINISTIC, NOT FORCE-DIRECTED ────────────────────────────
 * See `layoutNodes` in ./model. Columns keyed on visual state: stable across
 * refreshes, and every unreachable always-on node lands in one column where it
 * can be counted by eye.
 *
 * ── G3: RESIZABLE ──────────────────────────────────────────────────────────
 * Wrapped in `ResizableCanvasRegion` with a persisted `storageKey`, per
 * `ux-baseline.md` G3 — a fixed-height canvas is a listed defect.
 */

import * as React from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Badge, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { CanvasRightRail } from '@/lib/components/canvas/canvas-node-kit';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import type { WireEdge, WireNode } from '@/app/api/admin/brain/_lib/wire';
import { BrainCanvasNode, DanglingTerminus, type BrainNodeData } from './brain-canvas-node';
import {
  edgeVisual,
  layoutNodes,
  nodeVisual,
  PROVENANCE_COLOR,
  STATE_LABEL,
  type NodeVisualState,
} from './model';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' },
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    padding: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  swatch: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, minWidth: 0 },
  dot: { width: '10px', height: '10px', borderRadius: tokens.borderRadiusCircular, flexShrink: 0 },
  dash: { width: '18px', height: 0, borderTop: '2px dashed var(--loom-accent-red)', flexShrink: 0 },
  solid: { width: '18px', height: 0, borderTop: '2px solid var(--loom-accent-blue)', flexShrink: 0 },
  colHead: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    flexWrap: 'wrap',
  },
});

const nodeTypes = { brain: BrainCanvasNode, dangling: DanglingTerminus };

export interface BrainCanvasProps {
  readonly nodes: readonly WireNode[];
  readonly edges: readonly WireEdge[];
  readonly coverageConfigured: boolean;
  readonly costByNodeId: ReadonlyMap<string, number>;
  readonly findingCountByNodeId: ReadonlyMap<string, number>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
}

function buildFlow(props: BrainCanvasProps): { nodes: Node[]; edges: Edge[] } {
  const positions = new Map(
    layoutNodes(props.nodes, props.coverageConfigured).map((p) => [p.id, p]),
  );

  const flowNodes: Node[] = props.nodes.map((n) => {
    const p = positions.get(n.id);
    const data: BrainNodeData = {
      node: n,
      coverageConfigured: props.coverageConfigured,
      findingCount: props.findingCountByNodeId.get(n.id) ?? 0,
      derivedCostUsd: props.costByNodeId.get(n.id) ?? null,
    };
    return {
      id: n.id,
      type: 'brain',
      position: { x: p?.x ?? 0, y: p?.y ?? 0 },
      data: data as unknown as Record<string, unknown>,
// A node the user cannot drag would be a downgrade from every sibling canvas.
      draggable: true,
selected: props.selectedId === n.id,
    };
  });

  const flowEdges: Edge[] = [];
  const termini: Node[] = [];
  let terminusIndex = 0;

  for (const e of props.edges) {
    const v = edgeVisual(e);
    if (e.resolution === 'dangling') {
      // Give the wire somewhere to land so it can be SEEN. One terminus per
      // dangling edge, placed beside its source.
      const src = positions.get(e.from);
      const tid = `dangling:${e.id}`;
      termini.push({
        id: tid,
        type: 'dangling',
        position: { x: (src?.x ?? 0) + 200, y: (src?.y ?? 0) + 34 + terminusIndex * 4 },
        data: { reason: e.danglingReason, symbol: e.evidence.symbol },
        draggable: true,
        selectable: false,
      });
      terminusIndex += 1;
      flowEdges.push({
        id: e.id,
        source: e.from,
        target: tid,
        animated: false,
        label: v.label ?? undefined,
        labelStyle: { fill: 'var(--loom-accent-red)', fontSize: 10 },
        style: { stroke: v.stroke, strokeWidth: v.width, strokeDasharray: '6 4' },
        data: { provenance: e.provenance, resolution: e.resolution },
      });
      continue;
    }
    if (e.to === null) continue;
    flowEdges.push({
      id: e.id,
      source: e.from,
      target: e.to,
      animated: false,
      style: { stroke: v.stroke, strokeWidth: v.width },
      data: { provenance: e.provenance, resolution: e.resolution },
    });
  }

  return { nodes: [...flowNodes, ...termini], edges: flowEdges };
}

function CanvasInner(props: BrainCanvasProps) {
  const s = useStyles();
  const rf = useReactFlow();
  const [zoom, setZoom] = React.useState(1);
  const { nodes, edges } = React.useMemo(() => buildFlow(props), [props]);

  const statesPresent = React.useMemo(() => {
    const seen = new Set<NodeVisualState>();
    for (const n of props.nodes) seen.add(nodeVisual(n, props.coverageConfigured).state);
    return seen;
  }, [props.nodes, props.coverageConfigured]);

  const stateAccent = React.useMemo(() => {
    const m = new Map<NodeVisualState, string>();
    for (const n of props.nodes) {
      const v = nodeVisual(n, props.coverageConfigured);
      if (!m.has(v.state)) m.set(v.state, v.accent);
    }
    return m;
  }, [props.nodes, props.coverageConfigured]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      onMove={(_, vp) => setZoom(vp.zoom)}
      onNodeClick={(_, n) => props.onSelect(n.type === 'dangling' ? null : n.id)}
      onPaneClick={() => props.onSelect(null)}
      aria-label="Loom estate graph"
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      <MiniMap pannable zoomable ariaLabel="Graph minimap" />
      <Panel position="top-left">
        <div className={s.legend} role="group" aria-label="Legend">
          {[...statesPresent].map((st) => (
            <span key={st} className={s.swatch} data-legend-state={st}>
              <span
                className={s.dot}
                style={{ backgroundColor: stateAccent.get(st) ?? tokens.colorNeutralStroke1 }}
              />
              <Caption1>{STATE_LABEL[st]}</Caption1>
            </span>
          ))}
          <span className={s.swatch}>
            <span className={s.solid} />
            <Caption1>resolved wire</Caption1>
          </span>
          <span className={s.swatch} data-legend-edge="dangling">
            <span className={s.dash} />
            <Caption1>dangling wire (points at nothing)</Caption1>
          </span>
        </div>
      </Panel>
      <Panel position="top-right">
        <div className={s.colHead}>
          {(Object.keys(PROVENANCE_COLOR) as (keyof typeof PROVENANCE_COLOR)[]).map((p) => (
            <Badge key={p} appearance="tint" size="small" style={{ color: PROVENANCE_COLOR[p] }}>
              {p}
            </Badge>
          ))}
        </div>
      </Panel>
      <Panel position="bottom-right">
        <CanvasRightRail
          zoom={zoom}
          onZoomChange={(z) => rf.zoomTo(z)}
          onZoomIn={() => rf.zoomIn()}
          onZoomOut={() => rf.zoomOut()}
          onFit={() => rf.fitView()}
        />
      </Panel>
    </ReactFlow>
  );
}

export function BrainCanvas(props: BrainCanvasProps) {
  const s = useStyles();
  return (
    <div className={s.wrap} data-testid="brain-canvas">
      <ResizableCanvasRegion
        storageKey="brain-visualizer"
        defaultPx={520}
        minPx={280}
        fill
        ariaLabel="Resize the estate graph"
      >
        <ReactFlowProvider>
          <CanvasInner {...props} />
        </ReactFlowProvider>
      </ResizableCanvasRegion>
    </div>
  );
}
