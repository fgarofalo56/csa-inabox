'use client';

/**
 * LineageCanvas — the interactive @xyflow/react (React Flow) canvas that draws
 * a federated data-lineage graph for the Unified Catalog → Lineage tab.
 *
 * This is the same canvas engine the pipeline / eventstream / dataflow editors
 * use (lib/components/pipeline/canvas.tsx); only the node visuals + layout
 * differ. Like that canvas, the Loom Fluent-v9 theme is the only thing that
 * separates this from the lineage views in the real source UIs:
 *
 *   • Microsoft Purview portal lineage tab — Atlas v2 lineage subgraph
 *     (GET /datamap/api/atlas/v2/lineage/{guid}?direction=BOTH&depth=N).
 *     https://learn.microsoft.com/purview/data-gov-api-create-lineage-relationships
 *   • Databricks Catalog Explorer lineage graph — Unity Catalog table lineage
 *     (POST /api/2.0/lineage-tracking/table-lineage), nodes = tables / views /
 *     notebooks / jobs / dashboards down to the column level.
 *     https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-lineage
 *   • Microsoft Fabric / OneLake lineage view — workspace item relationships
 *     (dataflow → semantic model → report; lakehouse → report) from the admin
 *     scan. https://learn.microsoft.com/fabric/governance/lineage
 *
 * The graph is purely presentational: it receives already-fetched nodes/edges
 * from LineageGraph (which calls /api/catalog/lineage). No fabricated data — an
 * empty graph renders the honest empty-state; a configuration gap renders the
 * MessageBar gate. Both of those states live in the parent.
 *
 * Features mirrored from the source lineage UIs:
 *   - left→right layered (Sugiyama-ish longest-path) layout: upstream on the
 *     left, downstream on the right, exactly like Purview / Databricks read.
 *   - pan / wheel-zoom / fit-view / minimap / dot grid.
 *   - click a node → detail side panel (source, type, columns, open-item link)
 *     + upstream/downstream highlight (everything else dims) — the
 *     "focus on asset" interaction the Databricks lineage graph uses.
 *   - type/source legend, free-text search filter, and a focus toggle.
 */

import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  Handle, Position, useReactFlow, useNodesState,
  MarkerType,
  type Node, type Edge, type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Badge, Button, Caption1, Input, Text, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  FullScreenMaximize20Regular, Organization20Regular, TargetRegular,
  Table16Regular, Document16Regular, Notebook16Regular, Flow16Regular,
  ChartMultiple16Regular, Database16Regular, Box16Regular, BranchFork16Regular,
  Search16Regular, Dismiss16Regular,
} from '@fluentui/react-icons';

// ---------------------------------------------------------------------------
// Public model — kept in sync with the LineageNode / LineageEdge the BFF
// returns (app/api/catalog/lineage/route.ts).
// ---------------------------------------------------------------------------

export type LineageSource = 'purview' | 'unity-catalog' | 'onelake' | 'loom' | 'weave';

export interface CanvasLineageNode {
  id: string;
  label: string;
  type?: string;
  source: LineageSource;
  /** Asset is the focus the user resolved on (drawn larger + brand-coloured). */
  focus?: boolean;
  /** Column names, when the back-end resolved them (Atlas attrs / UC schema). */
  columns?: string[];
  /** Deep-link into the matching Loom catalog item, when derivable. */
  openHref?: string;
  /** Set when the same asset was matched in >1 source during a merge. */
  multiSource?: string[];
  /**
   * Canonical cross-source identity (qualifiedName / storage path / UC
   * full_name / Loom item id) the unified-lineage merge collapsed this node
   * on. Carried purely as metadata for the detail panel — the canvas does not
   * read it for layout. See lib/azure/unified-lineage.ts.
   */
  identity?: string;
}

export interface CanvasLineageEdge {
  from: string;
  to: string;
  type?: string;
}

// ---------------------------------------------------------------------------
// Type → colour / icon. Grounded in what each source UI actually draws:
// tables, views, notebooks, jobs/pipelines, dataflows, semantic models,
// reports, lakehouses. Unknown types fall back to a neutral dataset chip.
// ---------------------------------------------------------------------------

interface TypeStyle { color: string; Icon: React.FC<{ fontSize?: number }>; kind: string; }

const TYPE_STYLES: Record<string, TypeStyle> = {
  table: { color: 'var(--loom-accent-blue)', Icon: Table16Regular, kind: 'Table' },
  view: { color: 'var(--loom-accent-blue)', Icon: Table16Regular, kind: 'View' },
  dataset: { color: 'var(--loom-accent-blue)', Icon: Document16Regular, kind: 'Dataset' },
  notebook: { color: 'var(--loom-accent-orange)', Icon: Notebook16Regular, kind: 'Notebook' },
  job: { color: 'var(--loom-accent-violet)', Icon: Flow16Regular, kind: 'Job' },
  pipeline: { color: 'var(--loom-accent-violet)', Icon: Flow16Regular, kind: 'Pipeline' },
  dataflow: { color: 'var(--loom-accent-teal)', Icon: Flow16Regular, kind: 'Dataflow' },
  semanticmodel: { color: 'var(--loom-accent-magenta)', Icon: BranchFork16Regular, kind: 'Semantic model' },
  report: { color: 'var(--loom-accent-magenta)', Icon: ChartMultiple16Regular, kind: 'Report' },
  dashboard: { color: 'var(--loom-accent-magenta)', Icon: ChartMultiple16Regular, kind: 'Dashboard' },
  lakehouse: { color: 'var(--loom-accent-emerald)', Icon: Database16Regular, kind: 'Lakehouse' },
  process: { color: '#605E5C', Icon: Box16Regular, kind: 'Process' },
  // Weave (Loom Thread) edge endpoints — the integration mesh recorded in the
  // thread-edges Cosmos container (notebook attach, data-agent source, Power BI
  // model, API publish). These are Loom items, not Azure/Fabric assets.
  'powerbi-model': { color: 'var(--loom-accent-magenta)', Icon: ChartMultiple16Regular, kind: 'Power BI model' },
  'data-agent': { color: 'var(--loom-accent-emerald)', Icon: BranchFork16Regular, kind: 'Data agent' },
  'data-api-builder': { color: 'var(--loom-accent-teal)', Icon: Flow16Regular, kind: 'Data API' },
};

const FALLBACK_STYLE: TypeStyle = { color: '#605E5C', Icon: Box16Regular, kind: 'Asset' };

/** Normalize the heterogeneous type strings each source returns to a style key. */
function styleForType(type?: string): TypeStyle {
  if (!type) return FALLBACK_STYLE;
  const t = type.toLowerCase();
  if (TYPE_STYLES[t]) return TYPE_STYLES[t];
  // Atlas type names like "azure_sql_table", "powerbi_report", "databricks_table".
  if (t.includes('column')) return { color: 'var(--loom-accent-emerald)', Icon: BranchFork16Regular, kind: 'Column' };
  if (t.includes('powerbi') || t.includes('power-bi') || t.includes('semantic')) return TYPE_STYLES['powerbi-model'];
  if (t.includes('agent')) return TYPE_STYLES['data-agent'];
  if (t.includes('api')) return TYPE_STYLES['data-api-builder'];
  if (t.includes('notebook')) return TYPE_STYLES.notebook;
  if (t.includes('report')) return TYPE_STYLES.report;
  if (t.includes('dashboard')) return TYPE_STYLES.dashboard;
  if (t.includes('dataset') || t.includes('semanticmodel') || t.includes('semantic_model')) return TYPE_STYLES.semanticmodel;
  if (t.includes('dataflow')) return TYPE_STYLES.dataflow;
  if (t.includes('pipeline') || t.includes('job') || t.includes('process')) return TYPE_STYLES.process;
  if (t.includes('lakehouse') || t.includes('warehouse') || t.includes('database')) return TYPE_STYLES.lakehouse;
  if (t.includes('view')) return TYPE_STYLES.view;
  if (t.includes('table')) return TYPE_STYLES.table;
  return FALLBACK_STYLE;
}

const SOURCE_LABEL: Record<LineageSource, string> = {
  purview: 'Purview',
  'unity-catalog': 'Unity Catalog',
  onelake: 'OneLake / Fabric',
  loom: 'Loom Thread',
  weave: 'Weave',
};

// ---------------------------------------------------------------------------
// Custom node
// ---------------------------------------------------------------------------

const NODE_W = 210;
const NODE_H = 64;

export interface LineageNodeData {
  node: CanvasLineageNode;
  /** dimmed when a focus/search filter excludes it. */
  dimmed?: boolean;
  [key: string]: unknown;
}

function LineageNodeImpl({ data, selected }: NodeProps) {
  const { node, dimmed } = data as LineageNodeData;
  const style = styleForType(node.type);
  const Icon = style.Icon;
  return (
    <div
      data-lineage-node-id={node.id}
      data-lineage-source={node.source}
      aria-label={`${style.kind} ${node.label} from ${SOURCE_LABEL[node.source]}`}
      style={{
        position: 'relative',
        width: NODE_W,
        minHeight: NODE_H,
        padding: '8px 10px',
        borderRadius: 8,
        background: tokens.colorNeutralBackground1,
        borderLeft: `4px solid ${style.color}`,
        border: `1px solid ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        borderLeftWidth: 4,
        borderLeftColor: style.color,
        boxShadow: node.focus
          ? `0 0 0 2px ${style.color}`
          : selected
            ? `0 0 0 2px ${tokens.colorBrandBackground2}`
            : '0 1px 2px rgba(0,0,0,0.08)',
        opacity: dimmed ? 0.25 : 1,
        transition: 'opacity 120ms ease',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ width: 8, height: 8, background: style.color, border: 'none', left: -4 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: style.color, display: 'inline-flex' }}><Icon fontSize={16} /></span>
        <Text size={200} weight={node.focus ? 'semibold' : 'medium'} truncate wrap={false} style={{ flex: 1 }}>
          {node.label}
        </Text>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{style.kind}</Caption1>
        <span style={{ color: tokens.colorNeutralForeground4 }}>·</span>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{SOURCE_LABEL[node.source]}</Caption1>
        {node.multiSource && node.multiSource.length > 1 && (
          <Badge size="extra-small" appearance="tint" color="informative" style={{ marginLeft: 'auto' }}>merged</Badge>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ width: 8, height: 8, background: style.color, border: 'none', right: -4 }} />
    </div>
  );
}

const nodeTypes: NodeTypes = { lineage: LineageNodeImpl };

// ---------------------------------------------------------------------------
// Layered left→right layout (longest-path layering). Upstream sources land in
// the leftmost columns, the focus/sinks on the right — the read order Purview
// and Databricks lineage graphs use. Deterministic, no async ELK needed.
// ---------------------------------------------------------------------------

const COL_GAP = 280;
const ROW_GAP = 96;

function layeredLayout(
  nodes: CanvasLineageNode[],
  edges: CanvasLineageEdge[],
): Map<string, { x: number; y: number }> {
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of ids) { incoming.set(id, []); outgoing.set(id, []); }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    outgoing.get(e.from)!.push(e.to);
    incoming.get(e.to)!.push(e.from);
  }

  // Longest-path layering from roots (no incoming). Iterate to relax; cap to
  // node count to stay safe on cycles.
  const layer = new Map<string, number>();
  for (const id of ids) layer.set(id, 0);
  const order = [...ids];
  for (let pass = 0; pass < Math.min(order.length, 64); pass++) {
    let changed = false;
    for (const e of edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) continue;
      const next = layer.get(e.from)! + 1;
      if (next > layer.get(e.to)!) { layer.set(e.to, next); changed = true; }
    }
    if (!changed) break;
  }

  // Bucket by layer, then stack within a column.
  const byLayer = new Map<number, string[]>();
  for (const id of ids) {
    const l = layer.get(id)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(id);
  }
  const pos = new Map<string, { x: number; y: number }>();
  const maxRows = Math.max(...[...byLayer.values()].map((c) => c.length), 1);
  for (const [l, col] of byLayer) {
    col.sort((a, b) => a.localeCompare(b));
    const colHeight = col.length * ROW_GAP;
    const top = (maxRows * ROW_GAP - colHeight) / 2; // vertically centre the column
    col.forEach((id, i) => {
      pos.set(id, { x: l * COL_GAP, y: top + i * ROW_GAP });
    });
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  shell: {
    position: 'relative',
    width: '100%',
    height: '560px',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
  },
  toolbar: {
    display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center',
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingHorizontalXS,
  },
  search: { width: '184px' },
  legend: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, maxWidth: '340px',
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, padding: '6px 8px',
  },
  legendItem: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  legendSwatch: { width: tokens.spacingHorizontalMNudge, height: tokens.spacingVerticalMNudge, borderRadius: '2px', display: 'inline-block' },
  detail: {
    position: 'absolute', top: tokens.spacingVerticalM, right: tokens.spacingHorizontalM,
    // Responsive: cap to the available canvas width so the panel never bleeds
    // off-screen on a narrow viewport. 300px on wide canvases, otherwise the
    // canvas width minus both 12px gutters.
    width: '300px', maxWidth: 'calc(100% - 24px)',
    maxHeight: 'calc(100% - 24px)',
    overflowY: 'auto', zIndex: 10,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusXLarge, padding: '14px',
    boxShadow: tokens.shadow16,
    // Keyboard/scroll affordance: the panel is focusable and outlined when
    // focused so keyboard users land here after selecting a node.
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-2px' },
  },
  detailRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXXS, marginBottom: tokens.spacingVerticalMNudge },
});

export interface LineageCanvasHandle {
  fitToScreen: () => void;
  focusOn: (id: string) => void;
}

export interface LineageCanvasProps {
  nodes: CanvasLineageNode[];
  edges: CanvasLineageEdge[];
  /** id of the asset the user resolved on (gets focus styling + initial focus). */
  focusId?: string;
}

const LineageCanvasInner = forwardRef<LineageCanvasHandle, LineageCanvasProps>(function LineageCanvasInner(
  { nodes: srcNodes, edges: srcEdges, focusId },
  ref,
) {
  const s = useStyles();
  const rf = useReactFlow();
  const detailRef = useRef<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [search, setSearch] = useState('');
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);

  const positions = useMemo(() => layeredLayout(srcNodes, srcEdges), [srcNodes, srcEdges]);

  // adjacency for highlight + focus-mode reachability
  const adjacency = useMemo(() => {
    const up = new Map<string, Set<string>>();
    const down = new Map<string, Set<string>>();
    for (const n of srcNodes) { up.set(n.id, new Set()); down.set(n.id, new Set()); }
    for (const e of srcEdges) {
      down.get(e.from)?.add(e.to);
      up.get(e.to)?.add(e.from);
    }
    return { up, down };
  }, [srcNodes, srcEdges]);

  // Transitively connected set (both directions) from a node — the
  // upstream+downstream chain Databricks highlights when you click a node.
  const connectedTo = useCallback((id: string): Set<string> => {
    const seen = new Set<string>([id]);
    const walk = (start: string, map: Map<string, Set<string>>) => {
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const nxt of map.get(cur) || []) {
          if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt); }
        }
      }
    };
    walk(id, adjacency.up);
    walk(id, adjacency.down);
    return seen;
  }, [adjacency]);

  // Which node ids are "active" (not dimmed) given the current search/focus.
  const activeIds = useMemo(() => {
    const all = new Set(srcNodes.map((n) => n.id));
    let set = all;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      set = new Set(srcNodes.filter((n) => n.label.toLowerCase().includes(q) || (n.type || '').toLowerCase().includes(q)).map((n) => n.id));
    }
    if (focusMode && (selectedId || focusId)) {
      const chain = connectedTo(selectedId || focusId!);
      set = new Set([...set].filter((id) => chain.has(id)));
    } else if (selectedId) {
      // not focus-mode but a selection → highlight its chain (others dim).
      const chain = connectedTo(selectedId);
      set = new Set([...set].filter((id) => chain.has(id)));
    }
    return set;
  }, [srcNodes, search, focusMode, selectedId, focusId, connectedTo]);

  const dimAny = activeIds.size !== srcNodes.length;

  useEffect(() => {
    setRfNodes(srcNodes.map((n) => ({
      id: n.id,
      type: 'lineage',
      position: positions.get(n.id) || { x: 0, y: 0 },
      data: { node: { ...n, focus: n.id === focusId }, dimmed: dimAny && !activeIds.has(n.id) } as LineageNodeData,
      selected: n.id === selectedId,
    })));
  }, [srcNodes, positions, focusId, selectedId, activeIds, dimAny, setRfNodes]);

  const rfEdges: Edge[] = useMemo(() => {
    const ids = new Set(srcNodes.map((n) => n.id));
    return srcEdges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e, i) => {
        const active = activeIds.has(e.from) && activeIds.has(e.to);
        const color = active ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2;
        return {
          id: `${e.from}->${e.to}:${i}`,
          source: e.from,
          target: e.to,
          type: 'smoothstep',
          animated: active && dimAny,
          style: { stroke: color, strokeWidth: active ? 1.75 : 1, opacity: active ? 1 : 0.4 },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        } as Edge;
      });
  }, [srcEdges, srcNodes, activeIds, dimAny]);

  const fitToScreen = useCallback(() => rf.fitView({ padding: 0.2, duration: 250 }), [rf]);
  const focusOn = useCallback((id: string) => {
    setSelectedId(id);
    const p = positions.get(id);
    if (p) rf.setCenter(p.x + NODE_W / 2, p.y + NODE_H / 2, { zoom: 1.1, duration: 300 });
  }, [rf, positions]);
  useImperativeHandle(ref, () => ({ fitToScreen, focusOn }), [fitToScreen, focusOn]);

  // Legend: only the types actually present in this graph.
  const presentTypes = useMemo(() => {
    const seen = new Map<string, TypeStyle>();
    for (const n of srcNodes) {
      const st = styleForType(n.type);
      if (!seen.has(st.kind)) seen.set(st.kind, st);
    }
    return [...seen.values()];
  }, [srcNodes]);

  const selected = selectedId ? srcNodes.find((n) => n.id === selectedId) : null;

  // Move keyboard focus onto the detail panel when a node is selected so
  // keyboard users are taken to its actions (and Esc/Tab return them out).
  useEffect(() => {
    if (selectedId && detailRef.current) detailRef.current.focus();
  }, [selectedId]);

  return (
    <div className={s.shell} data-testid="lineage-canvas" aria-label="Data lineage canvas">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => setSelectedId((cur) => (cur === n.id ? null : n.id))}
        onPaneClick={() => setSelectedId(null)}
        minZoom={0.2}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tokens.colorNeutralStroke2} />

        <Panel position="top-left">
          <div className={s.toolbar}>
            <Input
              size="small"
              className={s.search}
              appearance="filled-lighter"
              contentBefore={<Search16Regular />}
              contentAfter={
                search
                  ? (
                    <Button
                      size="small"
                      appearance="transparent"
                      icon={<Dismiss16Regular />}
                      aria-label="Clear filter"
                      onClick={() => setSearch('')}
                    />
                  )
                  : undefined
              }
              placeholder="Filter assets…"
              value={search}
              onChange={(_, d) => setSearch(d.value)}
              aria-label="Filter lineage assets by name or type"
            />
            <Tooltip content={focusMode ? 'Focus mode on — showing only the selected asset’s chain' : 'Focus on asset — isolate the upstream+downstream chain of the selected node'} relationship="label">
              <Button
                size="small"
                appearance={focusMode ? 'primary' : 'subtle'}
                icon={<TargetRegular />}
                onClick={() => setFocusMode((v) => !v)}
              >
                Focus
              </Button>
            </Tooltip>
            <Tooltip content="Auto-layout (left→right by lineage depth)" relationship="label">
              <Button size="small" appearance="subtle" icon={<Organization20Regular />} aria-label="Auto-layout" onClick={fitToScreen} />
            </Tooltip>
            <Tooltip content="Zoom to fit" relationship="label">
              <Button size="small" appearance="subtle" icon={<FullScreenMaximize20Regular />} aria-label="Zoom to fit" onClick={fitToScreen} />
            </Tooltip>
          </div>
        </Panel>

        <Panel position="bottom-left">
          <div className={s.legend} aria-label="Lineage legend">
            {presentTypes.map((t) => (
              <span key={t.kind} className={s.legendItem}>
                <span className={s.legendSwatch} style={{ background: t.color }} />
                <Caption1>{t.kind}</Caption1>
              </span>
            ))}
          </div>
        </Panel>

        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => styleForType((n.data as LineageNodeData)?.node?.type).color}
          style={{ backgroundColor: tokens.colorNeutralBackground1 }}
        />
      </ReactFlow>

      {selected && (
        <div
          ref={detailRef}
          className={s.detail}
          role="complementary"
          aria-label="Asset detail"
          tabIndex={-1}
          onKeyDown={(e) => { if (e.key === 'Escape') setSelectedId(null); }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ color: styleForType(selected.type).color, display: 'inline-flex' }}>
              {(() => { const I = styleForType(selected.type).Icon; return <I fontSize={16} />; })()}
            </span>
            <Text weight="semibold" size={300} style={{ wordBreak: 'break-all' }}>{selected.label}</Text>
          </div>

          <div className={s.detailRow}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Source</Caption1>
            <Badge appearance="tint" color="brand">{SOURCE_LABEL[selected.source]}</Badge>
          </div>
          <div className={s.detailRow}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Type</Caption1>
            <Text size={200}>{selected.type || styleForType(selected.type).kind}</Text>
          </div>
          {selected.multiSource && selected.multiSource.length > 1 && (
            <div className={s.detailRow}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Matched in</Caption1>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {selected.multiSource.map((src) => (
                  <Badge key={src} size="small" appearance="outline">{SOURCE_LABEL[src as LineageSource] || src}</Badge>
                ))}
              </div>
            </div>
          )}
          <div className={s.detailRow}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Identifier</Caption1>
            <Text size={100} font="monospace" style={{ wordBreak: 'break-all' }}>{selected.id}</Text>
          </div>
          {selected.columns && selected.columns.length > 0 && (
            <div className={s.detailRow}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Columns ({selected.columns.length})</Caption1>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                {selected.columns.slice(0, 24).map((c) => (
                  <Badge key={c} size="small" appearance="outline" color="subtle">{c}</Badge>
                ))}
                {selected.columns.length > 24 && <Caption1>+{selected.columns.length - 24} more</Caption1>}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button size="small" appearance="primary" icon={<TargetRegular />} onClick={() => { setFocusMode(true); focusOn(selected.id); }}>
              Focus chain
            </Button>
            {selected.openHref && (
              <Button size="small" appearance="secondary" as="a" href={selected.openHref}>
                Open item
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

/** Public component — wraps the inner canvas in a ReactFlowProvider. */
export const LineageCanvas = forwardRef<LineageCanvasHandle, LineageCanvasProps>(function LineageCanvas(props, ref) {
  return (
    <ReactFlowProvider>
      <LineageCanvasInner {...props} ref={ref} />
    </ReactFlowProvider>
  );
});
