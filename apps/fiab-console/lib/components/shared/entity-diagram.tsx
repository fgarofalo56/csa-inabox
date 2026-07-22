'use client';

/**
 * <EntityDiagram> — SC-10, the shared schema / relationship-diagram canvas.
 *
 * THE single recurring parity gap in the Loom surface inventory: Fabric's
 * Semantic-model **Model view**, Lakehouse **Entity diagram**, and Eventhouse /
 * KQL-database **Entity diagram** all render tables as cards (column list + type
 * badges + collapse) joined by typed relationship lines with cardinality markers
 * (1 / *) and direction arrows. This one component delivers that anatomy for
 * every data item, built on the shared canvas node-kit + @xyflow/react, with ELK
 * auto-layout (the same engine the pipeline canvas uses).
 *
 * Self-contained: given a `source` ({kind, itemId}) it reads the item's REAL
 * Azure backend schema via entity-diagram-sources (no mocks, no Fabric/Power BI
 * dependency on the default path) and renders:
 *   • an **Overview ⇄ Entity-diagram toggle** (prop-driven so a host can host the
 *     switch, or internal by default);
 *   • table nodes = accent header band + scrollable column list (type-icon per
 *     column) + collapse chevron + row-count badge + selection glow;
 *   • **typed relationship edges** with 1/* cardinality markers + arrow head,
 *     inactive relationships dashed;
 *   • pan/zoom + **fit** + **100%** + auto-layout controls (shared
 *     `CanvasRightRail`);
 *   • select-to-inspect callback + honest warning MessageBar when the backing
 *     store is unreachable.
 *
 * Fluent v9 + Loom tokens only (all spacing/color via makeStyles + node-kit
 * token helpers) — no raw px in inline styles.
 */

import {
  Badge, Body1, Button, Caption1, MessageBar, MessageBarBody, MessageBarTitle,
  Spinner, Tab, TabList, Text, Tooltip, makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Table20Regular, TextQuote20Regular, NumberSymbol20Regular, Clock20Regular,
  CheckboxChecked20Regular, Globe20Regular, BracesVariable20Regular, Column20Regular,
  KeyMultiple20Regular, Tag20Regular, ChevronDown16Regular, ChevronRight16Regular,
  Key16Regular,
} from '@fluentui/react-icons';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Panel,
  Handle, Position, MarkerType, BaseEdge, EdgeLabelRenderer, getBezierPath,
  useReactFlow, useNodesState, useEdgesState,
  type Node, type Edge, type NodeProps, type EdgeProps, type NodeTypes, type EdgeTypes,
} from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  accentGradient, accentTint, CATEGORY_ACCENT, CanvasRightRail,
} from '@/lib/components/canvas/canvas-node-kit';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import {
  readEntityGraph, cardinalityMarkers,
  type EntityGraph, type EntitySource, type EntityTable, type EntityColumn,
  type EntityColumnKind, type EntityFetch,
} from './entity-diagram-sources';

// ELK — the same layered engine the pipeline canvas uses (elkjs is a dependency).
import ELK from 'elkjs/lib/elk.bundled.js';

export type EntityDiagramView = 'overview' | 'diagram';

export interface EntityDiagramProps {
  /** What to read the schema from. Ignored when `graph` is provided. */
  source: EntitySource;
  /** Controlled view. When omitted the component owns the toggle. */
  view?: EntityDiagramView;
  /** Uncontrolled initial view (default 'diagram'). */
  defaultView?: EntityDiagramView;
  onViewChange?: (v: EntityDiagramView) => void;
  /** Fired on table select (null on background click). Host inspects the table. */
  onSelectTable?: (table: EntityTable | null) => void;
  /** Pre-loaded graph — skips the fetch (tests / hosts that already hold it). */
  graph?: EntityGraph;
  /** Fetch override (tests). Defaults to clientFetch. */
  fetchImpl?: EntityFetch;
  /** Canvas height. Default 560. */
  height?: number | string;
  /**
   * Persistence key for the user-draggable canvas HEIGHT (ADF/Fabric-grade
   * resize grip). Whenever `height` is a finite number (the default, 560) the
   * diagram canvas is wrapped in the shared {@link ResizableCanvasRegion},
   * keyed under `loom.canvasHeight.<resizeStorageKey>`, so the operator can
   * drag or keyboard-resize the schema canvas and the choice persists per
   * surface. Defaults to `entity-diagram.<source.kind>` (U5: resizing is
   * always-on, per-surface-kind) — pass an explicit key only to give a caller
   * its own persisted slot. `height` becomes the initial size; a string
   * `height` keeps the fixed-height canvas unchanged.
   */
  resizeStorageKey?: string;
  /** Optional heading above the toggle. */
  title?: string;
}

// The tables get the neutral 'move' (blue) accent; the whole diagram is one kind.
const TABLE_ACCENT = CATEGORY_ACCENT.move;
const NODE_WIDTH = 248;
const HEADER_H = 42;
const ROW_H = 24;
const MAX_BODY_H = 220;

const KIND_ICON: Record<EntityColumnKind, JSX.Element> = {
  text: <TextQuote20Regular />,
  number: <NumberSymbol20Regular />,
  datetime: <Clock20Regular />,
  bool: <CheckboxChecked20Regular />,
  geo: <Globe20Regular />,
  json: <BracesVariable20Regular />,
  binary: <Column20Regular />,
  guid: <Tag20Regular />,
  key: <KeyMultiple20Regular />,
  unknown: <Column20Regular />,
};

// =============================================================================
// Styles
// =============================================================================

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    gap: tokens.spacingVerticalS,
    width: '100%',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  toolbarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  canvasWrap: {
    position: 'relative',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
    overflow: 'hidden',
    minHeight: 0,
  },
  center: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalS,
    height: '100%',
    padding: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3,
  },
  // ── table node ────────────────────────────────────────────────────────────
  node: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    cursor: 'pointer',
    userSelect: 'none',
    transitionProperty: 'box-shadow, transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16 },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  nodeSelected: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
  },
  nodeHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
  },
  nodeIconChip: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '26px',
    height: '26px',
    borderRadius: tokens.borderRadiusMedium,
  },
  nodeTitleWrap: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  nodeTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  nodeSchema: {
    color: tokens.colorNeutralForeground3,
  },
  nodeBody: {
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  colRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
  },
  colRowKey: {
    background: accentTint(TABLE_ACCENT, 6),
  },
  colIcon: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  colName: {
    flex: 1,
    minWidth: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  colType: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    fontFamily: tokens.fontFamilyMonospace,
  },
  colEmpty: {
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase200,
  },
  chevronBtn: {
    flexShrink: 0,
  },
  // ── overview list ───────────────────────────────────────────────────────────
  overview: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    overflowY: 'auto',
    alignContent: 'start',
    height: '100%',
  },
  ovCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    cursor: 'pointer',
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationFaster,
    ':hover': { boxShadow: tokens.shadow8 },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  ovCardHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  ovCardMeta: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap',
  },
  // edge cardinality marker chip
  edgeMarker: {
    position: 'absolute',
    pointerEvents: 'none',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightBold,
    color: tokens.colorNeutralForeground2,
    background: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusCircular,
    paddingLeft: tokens.spacingHorizontalXS,
    paddingRight: tokens.spacingHorizontalXS,
    lineHeight: tokens.lineHeightBase200,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

// =============================================================================
// Node data + custom table node
// =============================================================================

interface EntityNodeData extends Record<string, unknown> {
  table: EntityTable;
  collapsed: boolean;
  selected: boolean;
  onToggleCollapse: (id: string) => void;
}

/** Estimated rendered height for ELK (header + capped column body). */
function nodeHeight(table: EntityTable, collapsed: boolean): number {
  if (collapsed || table.columns.length === 0) return HEADER_H + (table.columns.length === 0 ? 28 : 0);
  return HEADER_H + Math.min(table.columns.length * ROW_H + 8, MAX_BODY_H);
}

function ColumnRow({ col }: { col: EntityColumn }) {
  const s = useStyles();
  const icon = KIND_ICON[col.kind] ?? KIND_ICON.unknown;
  return (
    <div className={mergeClasses(s.colRow, col.isKey && s.colRowKey)} data-col={col.name}>
      <span className={s.colIcon} aria-hidden="true">{col.isKey ? <Key16Regular /> : icon}</span>
      <span className={s.colName} title={col.name}>{col.name}</span>
      {col.type && <span className={s.colType}>{col.type}</span>}
    </div>
  );
}

function EntityTableNodeImpl({ data, id }: NodeProps) {
  const s = useStyles();
  const d = data as EntityNodeData;
  const { table, collapsed, selected } = d;
  const ring = selected ? { boxShadow: `0 0 0 2px ${TABLE_ACCENT}` } : undefined;
  return (
    <div
      className={mergeClasses(s.node, selected && s.nodeSelected)}
      style={{ width: NODE_WIDTH, ...ring }}
      data-entity-table={table.name}
      aria-label={`Table ${table.name}`}
    >
      <Handle id="l" type="target" position={Position.Left} style={{ background: TABLE_ACCENT, width: 9, height: 9, border: 'none' }} />
      <Handle id="r" type="source" position={Position.Right} style={{ background: TABLE_ACCENT, width: 9, height: 9, border: 'none' }} />
      <div className={s.nodeHeader} style={{ background: accentGradient(TABLE_ACCENT) }}>
        <span className={s.nodeIconChip} style={{ background: accentTint(TABLE_ACCENT, 16), color: TABLE_ACCENT }} aria-hidden="true">
          <Table20Regular />
        </span>
        <span className={s.nodeTitleWrap}>
          <span className={s.nodeTitle} title={table.name}>{table.name}</span>
          {table.schema && <Caption1 className={s.nodeSchema}>{table.schema}</Caption1>}
        </span>
        <Badge appearance="tint" size="small" style={{ backgroundColor: accentTint(TABLE_ACCENT, 14), color: TABLE_ACCENT }}>
          {table.columns.length}
        </Badge>
        <Tooltip content={collapsed ? 'Expand columns' : 'Collapse columns'} relationship="label">
          <Button
            className={mergeClasses(s.chevronBtn, 'nodrag', 'nopan')}
            size="small"
            appearance="subtle"
            aria-label={collapsed ? 'Expand columns' : 'Collapse columns'}
            icon={collapsed ? <ChevronRight16Regular /> : <ChevronDown16Regular />}
            onClick={(e) => { e.stopPropagation(); d.onToggleCollapse(id); }}
          />
        </Tooltip>
      </div>
      {!collapsed && (
        <div className={s.nodeBody} style={{ maxHeight: MAX_BODY_H }}>
          {table.columns.length === 0
            ? <div className={s.colEmpty}>No column metadata available.</div>
            : table.columns.map((c, i) => <ColumnRow key={`${c.name}-${i}`} col={c} />)}
        </div>
      )}
    </div>
  );
}
const EntityTableNode = memo(EntityTableNodeImpl);

// =============================================================================
// Custom relationship edge — bezier + 1/* markers + arrow head
// =============================================================================

interface EntityEdgeData extends Record<string, unknown> {
  fromMarker: '1' | '*';
  toMarker: '1' | '*';
  active: boolean;
}

function EntityRelationshipEdgeImpl(props: EdgeProps) {
  const s = useStyles();
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected } = props;
  const data = (props.data ?? {}) as EntityEdgeData;
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const stroke = data.active === false ? tokens.colorNeutralStroke1 : tokens.colorBrandStroke1;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth: selected ? 2.5 : 1.7,
          ...(data.active === false ? { strokeDasharray: '5 4' } : null),
        }}
      />
      <EdgeLabelRenderer>
        <div
          className={s.edgeMarker}
          style={{ transform: `translate(-50%, -50%) translate(${sourceX + 12}px, ${sourceY}px)` }}
        >
          {data.fromMarker ?? '*'}
        </div>
        <div
          className={s.edgeMarker}
          style={{ transform: `translate(-50%, -50%) translate(${targetX - 12}px, ${targetY}px)` }}
        >
          {data.toMarker ?? '1'}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
const EntityRelationshipEdge = memo(EntityRelationshipEdgeImpl);

const nodeTypes: NodeTypes = { entityTable: EntityTableNode };
const edgeTypes: EdgeTypes = { entityRel: EntityRelationshipEdge };

// =============================================================================
// ELK layout
// =============================================================================

const elk = new ELK();

async function layoutGraph(
  graph: EntityGraph,
  collapsed: Record<string, boolean>,
): Promise<Map<string, { x: number; y: number }>> {
  const out = new Map<string, { x: number; y: number }>();
  if (graph.tables.length === 0) return out;
  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '120',
      'elk.spacing.nodeNode': '48',
      'elk.edgeRouting': 'SPLINES',
      'elk.padding': '[top=32,left=32,bottom=32,right=32]',
    } as Record<string, string>,
    children: graph.tables.map((t) => ({
      id: t.id,
      width: NODE_WIDTH,
      height: nodeHeight(t, !!collapsed[t.id]),
    })),
    edges: graph.relationships
      .filter((r) => graph.tables.some((t) => t.id === r.fromTable) && graph.tables.some((t) => t.id === r.toTable))
      .map((r, i) => ({ id: `${r.id}-${i}`, sources: [r.fromTable], targets: [r.toTable] })),
  };
  try {
    const res = await elk.layout(elkGraph as any);
    for (const c of res.children || []) out.set(c.id as string, { x: c.x ?? 0, y: c.y ?? 0 });
  } catch {
    // Deterministic grid fallback.
    graph.tables.forEach((t, i) => out.set(t.id, { x: 40 + (i % 4) * (NODE_WIDTH + 60), y: 40 + Math.floor(i / 4) * 260 }));
  }
  return out;
}

// =============================================================================
// Inner canvas (inside ReactFlowProvider)
// =============================================================================

function DiagramCanvas({
  graph, onSelectTable, height,
}: { graph: EntityGraph; onSelectTable?: (t: EntityTable | null) => void; height: number | string }) {
  const rf = useReactFlow();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<EntityNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<EntityEdgeData>>([]);
  const [zoom, setZoom] = useState(1);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // (Re)build + lay out whenever the graph or collapse/selection state changes.
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pos = await layoutGraph(graph, collapsedRef.current);
      if (cancelled) return;
      const builtNodes: Node<EntityNodeData>[] = graph.tables.map((t) => ({
        id: t.id,
        type: 'entityTable',
        position: pos.get(t.id) ?? { x: 0, y: 0 },
        data: { table: t, collapsed: !!collapsedRef.current[t.id], selected: selectedId === t.id, onToggleCollapse: toggleCollapse },
      }));
      const tableIds = new Set(graph.tables.map((t) => t.id));
      const builtEdges: Edge<EntityEdgeData>[] = graph.relationships
        .filter((r) => tableIds.has(r.fromTable) && tableIds.has(r.toTable))
        .map((r, i) => {
          const m = cardinalityMarkers(r.cardinality);
          const color = r.active === false ? tokens.colorNeutralStroke1 : tokens.colorBrandStroke1;
          return {
            id: `${r.id}-${i}`,
            source: r.fromTable,
            target: r.toTable,
            sourceHandle: 'r',
            targetHandle: 'l',
            type: 'entityRel',
            markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
            data: { fromMarker: m.from, toMarker: m.to, active: r.active !== false },
          };
        });
      setNodes(builtNodes);
      setEdges(builtEdges);
      // Fit after the browser paints the new nodes.
      requestAnimationFrame(() => { try { rf.fitView({ padding: 0.2, maxZoom: 1.25, duration: 300 }); } catch { /* not mounted */ } });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, collapsed, selectedId]);

  const onNodeClick = useCallback((_: unknown, node: Node<EntityNodeData>) => {
    setSelectedId(node.id);
    onSelectTable?.(node.data.table);
  }, [onSelectTable]);

  const onPaneClick = useCallback(() => {
    setSelectedId(null);
    onSelectTable?.(null);
  }, [onSelectTable]);

  const zoomIn = useCallback(() => { rf.zoomIn(); setZoom(rf.getZoom()); }, [rf]);
  const zoomOut = useCallback(() => { rf.zoomOut(); setZoom(rf.getZoom()); }, [rf]);
  const setZoomTo = useCallback((z: number) => { rf.zoomTo(z); setZoom(z); }, [rf]);
  const fit = useCallback(() => { rf.fitView({ padding: 0.2, maxZoom: 1.25, duration: 300 }); }, [rf]);
  const autoLayout = useCallback(async () => {
    const pos = await layoutGraph(graph, collapsedRef.current);
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    requestAnimationFrame(() => rf.fitView({ padding: 0.2, maxZoom: 1.25, duration: 300 }));
  }, [graph, rf, setNodes]);

  return (
    <div style={{ height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick as any}
        onPaneClick={onPaneClick}
        onMove={(_, vp) => setZoom(vp.zoom)}
        minZoom={0.25}
        maxZoom={2}
        fitView
        // maxZoom keeps a small 3-6 node graph filling the canvas readably on open.
        fitViewOptions={{ padding: 0.2, maxZoom: 1.25 }}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1.5}
          color={accentTint('var(--loom-accent-blue)', 45)}
        />
        <Panel position="top-right">
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS }}>
            <Tooltip content="Zoom to 100%" relationship="label">
              <Button size="small" appearance="secondary" aria-label="Zoom to 100%" onClick={() => setZoomTo(1)}>100%</Button>
            </Tooltip>
          </div>
        </Panel>
        <Panel position="bottom-right">
          <CanvasRightRail
            zoom={zoom}
            onZoomChange={setZoomTo}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            onFit={fit}
            onAutoLayout={autoLayout}
          />
        </Panel>
      </ReactFlow>
    </div>
  );
}

// =============================================================================
// Overview list (Overview ⇄ Entity-diagram toggle)
// =============================================================================

function OverviewList({ graph, onSelectTable }: { graph: EntityGraph; onSelectTable?: (t: EntityTable | null) => void }) {
  const s = useStyles();
  return (
    <div className={s.overview}>
      {graph.tables.map((t) => (
        <div
          key={t.id}
          className={s.ovCard}
          role="button"
          tabIndex={0}
          onClick={() => onSelectTable?.(t)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectTable?.(t); } }}
          data-entity-overview-card={t.name}
        >
          <div className={s.ovCardHead}>
            <span style={{ color: TABLE_ACCENT, display: 'flex' }} aria-hidden="true"><Table20Regular /></span>
            <Body1 style={{ fontWeight: tokens.fontWeightSemibold }}>{t.name}</Body1>
          </div>
          <div className={s.ovCardMeta}>
            {t.schema && <Badge appearance="outline" size="small">{t.schema}</Badge>}
            <Badge appearance="tint" size="small">{t.columns.length} columns</Badge>
            {typeof t.rowCount === 'number' && <Badge appearance="tint" size="small">{t.rowCount.toLocaleString()} rows</Badge>}
          </div>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// Public component
// =============================================================================

export function EntityDiagram(props: EntityDiagramProps) {
  const s = useStyles();
  const {
    source, view, defaultView = 'diagram', onViewChange, onSelectTable,
    graph: providedGraph, fetchImpl, height = 560, title, resizeStorageKey,
  } = props;

  const [internalView, setInternalView] = useState<EntityDiagramView>(defaultView);
  const activeView = view ?? internalView;
  const setView = useCallback((v: EntityDiagramView) => {
    if (view === undefined) setInternalView(v);
    onViewChange?.(v);
  }, [view, onViewChange]);

  const [graph, setGraph] = useState<EntityGraph | null>(providedGraph ?? null);
  const [loading, setLoading] = useState(!providedGraph);
  const [error, setError] = useState<string | null>(null);

  const doFetch: EntityFetch = fetchImpl ?? ((input, init) => clientFetch(input, init));

  useEffect(() => {
    if (providedGraph) { setGraph(providedGraph); setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    readEntityGraph(source, doFetch)
      .then((g) => { if (!cancelled) setGraph(g); })
      .catch((e) => { if (!cancelled) setError(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind, source.itemId, source.workspaceId, source.containers, providedGraph]);

  const hasTables = !!graph && graph.tables.length > 0;

  // When the canvas is wrapped in a resizable region, the region owns the
  // pixel height and the inner React Flow must fill it (100%) instead of
  // re-imposing the fixed `height` — otherwise dragging the grip wouldn't move
  // the canvas. U5: the storage key is DEFAULTED per surface kind, so any
  // numeric-height host (the default) is resizable — callers may still pass an
  // explicit key for their own persisted slot. String heights stay fixed.
  const effectiveResizeKey = resizeStorageKey ?? `entity-diagram.${source.kind}`;
  const resizable = typeof height === 'number';
  const canvasHeight: number | string = resizable ? '100%' : height;

  const body = useMemo(() => {
    if (loading) {
      return <div className={s.center}><Spinner label="Reading schema…" /></div>;
    }
    if (error) {
      return (
        <div className={s.center} style={{ padding: tokens.spacingVerticalXL, width: '100%' }}>
          <MessageBar intent="error" style={{ width: '100%' }}>
            <MessageBarBody>
              <MessageBarTitle>Could not load the entity diagram</MessageBarTitle>
              {error}
            </MessageBarBody>
          </MessageBar>
        </div>
      );
    }
    if (graph?.gate) {
      return (
        <div className={s.center} style={{ padding: tokens.spacingVerticalXL, width: '100%' }}>
          <MessageBar intent="warning" style={{ width: '100%' }}>
            <MessageBarBody>
              <MessageBarTitle>Schema unavailable</MessageBarTitle>
              {graph.gate}
            </MessageBarBody>
          </MessageBar>
        </div>
      );
    }
    if (!hasTables) {
      return (
        <div className={s.center}>
          <Table20Regular />
          <Text>{graph?.notice || 'No tables to diagram yet.'}</Text>
        </div>
      );
    }
    if (activeView === 'overview') {
      return <OverviewList graph={graph!} onSelectTable={onSelectTable} />;
    }
    return (
      <ReactFlowProvider>
        <DiagramCanvas graph={graph!} onSelectTable={onSelectTable} height={canvasHeight} />
      </ReactFlowProvider>
    );
  }, [loading, error, graph, hasTables, activeView, canvasHeight, onSelectTable, s]);

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <TabList selectedValue={activeView} onTabSelect={(_, d) => setView(d.value as EntityDiagramView)}>
          <Tab value="overview">Overview</Tab>
          <Tab value="diagram">Entity diagram</Tab>
        </TabList>
        <div className={s.toolbarRight}>
          {title && <Text weight="semibold">{title}</Text>}
          {graph?.modelName && <Badge appearance="tint">{graph.modelName}</Badge>}
          {hasTables && <Caption1>{graph!.tables.length} tables · {graph!.relationships.length} relationships</Caption1>}
        </div>
      </div>
      {graph?.notice && hasTables && !graph.gate && (
        <MessageBar intent="info">
          <MessageBarBody>{graph.notice}</MessageBarBody>
        </MessageBar>
      )}
      {resizable ? (
        // Opt-in draggable/persisted canvas height (ADF/Fabric-grade). The region
        // supplies the definite pixel height React Flow needs; canvasWrap fills it.
        <ResizableCanvasRegion
          storageKey={effectiveResizeKey}
          defaultPx={height as number}
          minPx={320}
          ariaLabel="Resize entity diagram canvas height"
          className={s.canvasWrap}
        >
          <div style={{ height: '100%', minHeight: 0 }}>{body}</div>
        </ResizableCanvasRegion>
      ) : (
        <div className={s.canvasWrap} style={{ height }}>
          {body}
        </div>
      )}
    </div>
  );
}

export default EntityDiagram;
