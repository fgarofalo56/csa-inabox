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
 *
 * ── ONE CANVAS, TWO LAYERS (#3934) ─────────────────────────────────────────
 * The optional `overlay` prop paints the SYNAPSE layers — prune, risk, hot, new
 * — over this same graph. It is a prop rather than a second component because
 * the operator's framing for the synapse view is waste and risk "in the same
 * picture as the wiring": a sibling canvas would be a second picture, and it
 * would drift from this one in layout, zoom and interaction the first time
 * either was touched. With no overlay every line here behaves exactly as it did
 * before the layer existed.
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
import { CanvasRightRail, accentTint } from '@/lib/components/canvas/canvas-node-kit';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { readableAccent } from '@/lib/components/ui/item-type-visual';
import { useTheme } from '@/lib/theme/theme-context';
import type { WireEdge, WireNode } from '@/app/api/admin/brain/_lib/wire';
import { BrainCanvasNode, DanglingTerminus, type BrainNodeData } from './brain-canvas-node';
import {
  DANGLING_TERMINUS_INSET,
  DANGLING_TERMINUS_STEP,
  edgeVisual,
  layoutNodes,
  MIN_LEGIBLE_ZOOM,
  NODE_WIDTH,
  nodeVisual,
  PROVENANCE_COLOR,
  STATE_LABEL,
  type NodeVisualState,
} from './model';
import {
  SYNAPSE_EDGE_LABEL,
  SYNAPSE_NODE_LABEL,
  type SynapseEdgeLayer,
  type SynapseNodeLayer,
  type SynapseOverlay,
} from './synapse-model';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' },
  /** Fills the resizable region so the ResizeObserver measures the real viewport. */
  measure: { width: '100%', height: '100%', minWidth: 0, minHeight: 0 },
  /**
   * #4280 — ONE FLOW, NOT TWO OVERLAYS.
   *
   * The legend and the provenance chips used to be two separate React Flow
   * `Panel`s — `top-left` and `top-right`. A Panel is absolutely positioned and
   * width-unbounded, so the legend never wrapped: it just grew rightwards until
   * it ran underneath the chips, and `Unreachable + always-on` — the label for
   * the most destructive recommendation class on this surface — came out partly
   * illegible in BOTH themes at the default capture width.
   *
   * `flexWrap` on the legend alone could not fix that, because nothing bounded
   * the legend's width. Pinning `right: 0` alongside the inherited `left: 0`
   * turns the panel into a full-width top strip, which makes the two rows
   * SIBLINGS IN ONE WRAPPING FLEX FLOW. They cannot overlap at any width now —
   * they wrap. An offset nudge was the alternative and it fixes exactly one
   * viewport width (`ux-baseline.md`: "Overlap at any width is a defect").
   *
   * `pointerEvents: 'none'` on the strip is load-bearing: a full-width panel
   * would otherwise swallow canvas pan/zoom drags across the whole top band.
   * The two content boxes opt back in.
   */
  topStripPanel: { right: 0, pointerEvents: 'none' },
  topStrip: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
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
    pointerEvents: 'auto',
  },
  swatch: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, minWidth: 0 },
  /** Keeps a label on one line and ellipsises it rather than forcing overflow. */
  label: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dot: { width: '10px', height: '10px', borderRadius: tokens.borderRadiusCircular, flexShrink: 0 },
  dash: { width: '18px', height: 0, borderTop: '2px dashed var(--loom-accent-red)', flexShrink: 0 },
  solid: { width: '18px', height: 0, borderTop: '2px solid var(--loom-accent-blue)', flexShrink: 0 },
  colHead: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    flexWrap: 'wrap',
    alignItems: 'center',
    pointerEvents: 'auto',
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
  /**
   * The SYNAPSE overlay (#3934). When present, node and edge appearance comes
   * from the overlay's marks and the legend switches to the synapse layers.
   *
   * Optional rather than a separate canvas component on purpose. The operator's
   * framing for the synapse view is "waste and risk in the SAME PICTURE as the
   * wiring"; a second canvas would be a second picture, and it would immediately
   * start drifting from this one in layout, interaction and zoom behaviour.
   */
  readonly overlay?: SynapseOverlay;
  /** Test/observability hook so the canvas region is addressable per tab. */
  readonly testId?: string;
  /** Distinct persisted size per tab — two views of one graph size independently. */
  readonly resizeStorageKey?: string;
  /**
   * The measured canvas viewport, fed by {@link BrainCanvas}'s ResizeObserver.
   *
   * Optional so `buildFlow` stays a pure function testable without a DOM. When
   * absent the layout falls back to one column per state, which is the pre-#4251
   * behaviour and is correct at small node counts.
   */
  readonly container?: { readonly width: number; readonly height: number };
}

/**
 * WHERE EACH DANGLING TERMINUS GOES (#4251).
 *
 * ── THE DEFECT THIS REPLACES ─────────────────────────────────────────────
 *
 * One GLOBAL counter, `(src.x + 200, src.y + 34 + index * 4)`. Two problems, and
 * the second is the visible one:
 *   - the offset ignored WHICH source the edge came from, so two termini from
 *     different sources were displaced from each other for no reason;
 *   - the step was 4px against a chip ~28px tall, so every adjacent pair in one
 *     fan-out overlapped by 24px. Measured live on the default view: 6
 *     overlapping pairs. `ux-baseline.md` — "overlap at any width is a defect".
 *
 * ── WHY ALLOCATION UP FRONT, NOT A COUNTER INLINE ────────────────────────
 *
 * A per-source counter fixes the fan-out and NOT the collision between one
 * source's stack and the next row's, because a stack deeper than the row pitch
 * runs into the source below it. Allocating per LANE with a monotonic cursor
 * removes the whole class: within a column's gutter lane, consecutive termini
 * are always {@link DANGLING_TERMINUS_STEP} apart, whichever source they belong
 * to. Sources are visited in (x, y, id) order so the result is deterministic —
 * `props.edges` order is not.
 *
 * A terminus never intersects a NODE box by construction: the lanes are disjoint
 * in x. The node occupies `[x, x + NODE_WIDTH]` and the lane starts at
 * `x + NODE_WIDTH + DANGLING_TERMINUS_INSET`, ending clear of the next column.
 */
export function allocateTerminusPositions(
  edges: readonly WireEdge[],
  positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>,
): Map<string, { x: number; y: number }> {
  const bySource = new Map<string, WireEdge[]>();
  for (const e of edges) {
    if (e.resolution !== 'dangling') continue;
    const list = bySource.get(e.from);
    if (list) list.push(e);
    else bySource.set(e.from, [e]);
  }

  const sources = [...bySource.keys()].sort((a, b) => {
    const pa = positions.get(a);
    const pb = positions.get(b);
    return (
      (pa?.x ?? 0) - (pb?.x ?? 0) || (pa?.y ?? 0) - (pb?.y ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
    );
  });

  const out = new Map<string, { x: number; y: number }>();
  const laneCursor = new Map<number, number>();
  for (const src of sources) {
    const p = positions.get(src);
    const x = (p?.x ?? 0) + NODE_WIDTH + DANGLING_TERMINUS_INSET;
    // Never ABOVE its source, never on top of what the lane already holds.
    let y = Math.max(p?.y ?? 0, laneCursor.get(x) ?? Number.NEGATIVE_INFINITY);
    for (const e of bySource.get(src)!) {
      out.set(e.id, { x, y });
      y += DANGLING_TERMINUS_STEP;
    }
    laneCursor.set(x, y);
  }
  return out;
}

/**
 * EXPORTED FOR COVERAGE (#4012), not for reuse — `CanvasInner` is still its only
 * production caller.
 *
 * `synapse-canvas.test.tsx` mounts `BrainCanvasNode` DIRECTLY with a hand-built
 * `data.synapse`, so it verifies the renderer given an input and never exercises the code
 * that decides whether the overlay mark is handed to the node at all. Measured on PR
 * #3992, arm M5: sever the overlay from every node and edge inside this function and the
 * whole UI suite stays green — 193/193, RC=0 — while seven sibling mutation arms in the
 * same run were all caught. A test that constructs the thing it is meant to verify was
 * produced proves nothing about production; the hand-off path had no coverage.
 *
 * Keeping it module-private would have meant testing it through a full React Flow mount,
 * which is a heavier and much less precise instrument for a pure function. The export is
 * the cheaper honest option.
 */
export function buildFlow(props: BrainCanvasProps): { nodes: Node[]; edges: Edge[] } {
  const positions = new Map(
    layoutNodes(props.nodes, props.coverageConfigured, {
      ...(props.container ? { container: props.container } : {}),
    }).map((p) => [p.id, p]),
  );

  const flowNodes: Node[] = props.nodes.map((n) => {
    const p = positions.get(n.id);
    const synapse = props.overlay?.nodeMarks.get(n.id);
    const data: BrainNodeData = {
      node: n,
      coverageConfigured: props.coverageConfigured,
      findingCount: props.findingCountByNodeId.get(n.id) ?? 0,
      derivedCostUsd: props.costByNodeId.get(n.id) ?? null,
      ...(synapse ? { synapse } : {}),
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
  const terminusPosition = allocateTerminusPositions(props.edges, positions);

  for (const e of props.edges) {
    const v = edgeVisual(e);
    // The overlay's mark, when the synapse layer is active. It carries the same
    // four channels (`stroke`, `width`, `dash`, `animated`) plus its own label,
    // so the branch below is a substitution rather than a second code path.
    const syn = props.overlay?.edgeMarks.get(e.id);
    const stroke = syn ? syn.stroke : v.stroke;
    const strokeWidth = syn ? syn.width : v.width;
    const label = syn ? (syn.label ?? v.label) : v.label;
    const animated = syn ? syn.animated : false;

    if (e.resolution === 'dangling') {
      // Give the wire somewhere to land so it can be SEEN. One terminus per
      // dangling edge, in the gutter lane beside its source — see
      // `allocateTerminusPositions` for why the placement is allocated up front
      // rather than counted inline.
      const tid = `dangling:${e.id}`;
      const at = terminusPosition.get(e.id) ?? { x: 0, y: 0 };
      termini.push({
        id: tid,
        type: 'dangling',
        position: at,
        data: { reason: e.danglingReason, symbol: e.evidence.symbol },
        draggable: true,
        selectable: false,
      });
      flowEdges.push({
        id: e.id,
        source: e.from,
        target: tid,
        animated,
        label: label ?? undefined,
        // Tokened ramp + a neutral label plate (#4241 defect 5). The previous
        // `fontSize: 10` sat below the type ramp, and the accent-on-default-bg
        // fill washed out over the canvas dots in dark mode.
        labelStyle: { fill: stroke, fontSize: tokens.fontSizeBase200 },
        labelBgStyle: { fill: tokens.colorNeutralBackground1, fillOpacity: 0.9 },
        style: { stroke, strokeWidth, strokeDasharray: syn?.dash ?? '6 4' },
        data: {
          provenance: e.provenance,
          resolution: e.resolution,
          ...(syn ? { synapseLayer: syn.layer } : {}),
        },
      });
      continue;
    }
    if (e.to === null) continue;
    flowEdges.push({
      id: e.id,
      source: e.from,
      target: e.to,
      animated,
      ...(label
        ? {
            label,
            // Same ramp + plate as the dangling branch, so an overlay label on a
            // resolved edge is equally readable in both themes.
            labelStyle: { fill: stroke, fontSize: tokens.fontSizeBase200 },
            labelBgStyle: { fill: tokens.colorNeutralBackground1, fillOpacity: 0.9 },
          }
        : {}),
      style: {
        stroke,
        strokeWidth,
        ...(syn?.dash ? { strokeDasharray: syn.dash } : {}),
      },
      data: {
        provenance: e.provenance,
        resolution: e.resolution,
        ...(syn ? { synapseLayer: syn.layer } : {}),
      },
    });
  }

  return { nodes: [...flowNodes, ...termini], edges: flowEdges };
}

function CanvasInner(props: BrainCanvasProps) {
  const s = useStyles();
  const rf = useReactFlow();
  const { mode } = useTheme();
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

  // ── the synapse legend ───────────────────────────────────────────────────
  // Built from the marks that are ACTUALLY on screen, not from the full enum. A
  // legend listing seven layers over a canvas showing two teaches the operator
  // that five are absent, which is a claim the legend has no business making.
  const synapseNodeLegend = React.useMemo(() => {
    if (!props.overlay) return [];
    const m = new Map<SynapseNodeLayer, string>();
    for (const n of props.nodes) {
      const mark = props.overlay.nodeMarks.get(n.id);
      if (mark && !m.has(mark.layer)) m.set(mark.layer, mark.accent);
    }
    return [...m.entries()];
  }, [props.overlay, props.nodes]);

  const synapseEdgeLegend = React.useMemo(() => {
    if (!props.overlay) return [];
    const m = new Map<SynapseEdgeLayer, { stroke: string; dash: string | null }>();
    for (const e of props.edges) {
      const mark = props.overlay.edgeMarks.get(e.id);
      if (mark && !m.has(mark.layer)) m.set(mark.layer, { stroke: mark.stroke, dash: mark.dash });
    }
    return [...m.entries()];
  }, [props.overlay, props.edges]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      // The initial fit stops shrinking at the legibility floor; the manual
      // floor below stays at 0.2 so a deliberate zoom-out still works (#4251).
      fitViewOptions={{ minZoom: MIN_LEGIBLE_ZOOM }}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      onMove={(_, vp) => setZoom(vp.zoom)}
      onNodeClick={(_, n) => props.onSelect(n.type === 'dangling' ? null : n.id)}
      onPaneClick={() => props.onSelect(null)}
      aria-label={props.overlay ? 'Loom estate synapse graph' : 'Loom estate graph'}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      {/* Themed like every sibling minimap (one-canvas, lineage-canvas) — the
          React Flow default is light-theme chrome, a bright panel in dark mode
          (#4241 defect 9). Node fills carry the same accent the canvas shows. */}
      <MiniMap
        pannable
        zoomable
        ariaLabel="Graph minimap"
        nodeStrokeColor={tokens.colorNeutralStroke2}
        nodeColor={(n) => {
          if (n.type === 'dangling') return 'var(--loom-accent-red)';
          const d = n.data as unknown as BrainNodeData;
          const accent = d.synapse
            ? d.synapse.accent
            : nodeVisual(d.node, d.coverageConfigured).accent;
          return readableAccent(accent, mode === 'dark');
        }}
        maskColor={accentTint(tokens.colorNeutralBackground3, 70)}
        style={{ backgroundColor: tokens.colorNeutralBackground1 }}
      />
      <Panel position="top-left" className={s.topStripPanel}>
        {/* #4280: legend and provenance chips are SIBLINGS here, in one
            wrapping flow. They were two absolutely-positioned Panels and the
            legend ran underneath the chips. See `topStripPanel` above. */}
        <div className={s.topStrip} data-testid="brain-canvas-top-strip">
          {props.overlay ? (
            <div className={s.legend} role="group" aria-label="Synapse legend" data-testid="synapse-legend">
              {synapseNodeLegend.map(([layer, accent]) => (
                <span key={layer} className={s.swatch} data-legend-synapse-node={layer}>
                  <span className={s.dot} style={{ backgroundColor: accent }} />
                  <Caption1 className={s.label}>{SYNAPSE_NODE_LABEL[layer]}</Caption1>
                </span>
              ))}
              {synapseEdgeLegend.map(([layer, style]) => (
                <span key={layer} className={s.swatch} data-legend-synapse-edge={layer}>
                  <span
                    className={s.solid}
                    style={{
                      borderTopColor: style.stroke,
                      borderTopStyle: style.dash ? 'dashed' : 'solid',
                    }}
                  />
                  <Caption1 className={s.label}>{SYNAPSE_EDGE_LABEL[layer]}</Caption1>
                </span>
              ))}
            </div>
          ) : (
            <div className={s.legend} role="group" aria-label="Legend">
              {[...statesPresent].map((st) => (
                <span key={st} className={s.swatch} data-legend-state={st}>
                  <span
                    className={s.dot}
                    style={{ backgroundColor: stateAccent.get(st) ?? tokens.colorNeutralStroke1 }}
                  />
                  <Caption1 className={s.label}>{STATE_LABEL[st]}</Caption1>
                </span>
              ))}
              <span className={s.swatch}>
                <span className={s.solid} />
                <Caption1 className={s.label}>resolved wire</Caption1>
              </span>
              <span className={s.swatch} data-legend-edge="dangling">
                <span className={s.dash} />
                <Caption1 className={s.label}>dangling wire (points at nothing)</Caption1>
              </span>
            </div>
          )}
          <div className={s.colHead} data-testid="brain-canvas-provenance">
            {(Object.keys(PROVENANCE_COLOR) as (keyof typeof PROVENANCE_COLOR)[]).map((p) => (
              // The readable-accent pairing from the node kit's StatusChip
              // (#4241 defect 6): accent tint behind, theme-aware accent in
              // front — never an accent foreground over Fluent's default brand
              // tint, which is exactly the accent-on-tint failure
              // `loom_item_accent_readable_theme` records.
              <Badge
                key={p}
                appearance="tint"
                size="small"
                style={{
                  backgroundColor: accentTint(PROVENANCE_COLOR[p], 14),
                  color: readableAccent(PROVENANCE_COLOR[p], mode === 'dark'),
                  borderColor: accentTint(PROVENANCE_COLOR[p], 28),
                }}
              >
                {p}
              </Badge>
            ))}
          </div>
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

/**
 * How coarsely the observed viewport is quantised before it reaches the layout.
 *
 * The layout must be DETERMINISTIC — `visual-distinction.test.tsx` asserts two
 * runs place every node identically, and two screenshots of one estate have to
 * be comparable. A raw ResizeObserver reading changes by a pixel on any scroll
 * bar or zoom, which would re-flow the graph under the operator's cursor. Rounded
 * to a 32px grid, the same window produces the same layout.
 */
const VIEWPORT_QUANTUM = 32;

export function BrainCanvas(props: BrainCanvasProps) {
  const s = useStyles();
  const measureRef = React.useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = React.useState<{ width: number; height: number } | null>(null);

  React.useEffect(() => {
    const el = measureRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const quantise = (n: number) => Math.max(VIEWPORT_QUANTUM, Math.round(n / VIEWPORT_QUANTUM) * VIEWPORT_QUANTUM);
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width === 0 || box.height === 0) return;
      const next = { width: quantise(box.width), height: quantise(box.height) };
      setContainer((prev) =>
        prev && prev.width === next.width && prev.height === next.height ? prev : next,
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={s.wrap} data-testid={props.testId ?? 'brain-canvas'}>
      <ResizableCanvasRegion
        storageKey={props.resizeStorageKey ?? 'brain-visualizer'}
        defaultPx={520}
        minPx={280}
        fill
        ariaLabel="Resize the estate graph"
      >
        <div ref={measureRef} className={s.measure}>
          <ReactFlowProvider>
            <CanvasInner {...props} {...(container ? { container } : {})} />
          </ReactFlowProvider>
        </div>
      </ResizableCanvasRegion>
    </div>
  );
}
