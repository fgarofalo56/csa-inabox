'use client';

/**
 * PipelineCanvas — center pane of the Fabric / ADF / Synapse pipeline editor,
 * rebuilt on React Flow (@xyflow/react) — the same canvas engine atlas-diag
 * uses. Only the Loom Fluent-v9 theme differs from ADF Studio.
 *
 * What React Flow gives us (replacing the old hand-rolled SVG canvas):
 *   - Drag from palette → drop on canvas at the cursor (HTML5 DnD +
 *     screenToFlowPosition).
 *   - Drag a node to reposition; pan + wheel-zoom; fit-to-screen.
 *   - Bezier dependency connectors in ADF's 4 colours (success/failure/
 *     completion/skip) — see loom-bezier-edge.tsx.
 *   - Four coloured output Handles + one input Handle per node — see
 *     flow-activity-node.tsx. The source handle id IS the dependency
 *     condition, so onConnect maps straight to a dependsOn edge.
 *   - MiniMap + zoom Controls.
 *
 * Coordinates are canvas-internal (ADF/Synapse/Fabric JSON has no viewport
 * concept). New nodes are placed at the drop point; "Auto align" re-runs ELK
 * layout over the dependsOn DAG. The public contract (PipelineCanvasProps +
 * CanvasHandle) is unchanged, so PipelineDesigner / PipelineEditorCore and all
 * consumers are untouched.
 */

import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  useReactFlow, useNodesState,
  ConnectionMode, MarkerType, Position,
  type Node, type Edge, type Connection, type NodeChange, type NodeTypes, type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button, Caption1, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { Organization20Regular, FullScreenMaximize20Regular, Flowchart20Regular, Flow24Regular } from '@fluentui/react-icons';
import { FlowActivityNode, FLOW_NODE_W, type ActivityNodeData } from './flow-activity-node';
import { LoomBezierEdge, type LoomEdgeData } from './loom-bezier-edge';
import { elkLayout, topoFallback, shouldVirtualize, type XY } from './flow-layout';
import { CONNECTOR_COLORS, type ConnectorCondition } from './connector';
import { isContainerType } from './drill-path';
import { getActivityVisual, accentTint } from '@/lib/components/canvas/canvas-node-kit';
import { EmptyState } from '@/lib/components/empty-state';
import type { PipelineActivity } from './types';

const NODE_H = 84;

const nodeTypes: NodeTypes = { activity: FlowActivityNode };
const edgeTypes: EdgeTypes = { loom: LoomBezierEdge };

/** Pan a viewport by (dx, dy) screen pixels, preserving zoom. */
function shiftViewport(vp: { x: number; y: number; zoom: number }, dx: number, dy: number) {
  return { x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom };
}

const useStyles = makeStyles({
  shell: {
    position: 'relative',
    flex: 1,
    minHeight: '400px',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    // Tokenized React Flow chrome — float the zoom Controls + MiniMap as
    // elevated, rounded, theme-aware cards that match the palette tiles.
    '& .react-flow__controls': {
      boxShadow: tokens.shadow16,
      borderRadius: tokens.borderRadiusLarge,
      overflow: 'hidden',
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      backgroundColor: tokens.colorNeutralBackground1,
    },
    '& .react-flow__controls-button': {
      backgroundColor: tokens.colorNeutralBackground1,
      borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
      color: tokens.colorNeutralForeground2,
      width: '28px',
      height: '28px',
    },
    '& .react-flow__controls-button:hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    '& .react-flow__controls-button svg': {
      fill: 'currentColor',
      maxWidth: '14px',
      maxHeight: '14px',
    },
    '& .react-flow__minimap': {
      boxShadow: tokens.shadow16,
      borderRadius: tokens.borderRadiusLarge,
      overflow: 'hidden',
      border: `1px solid ${tokens.colorNeutralStroke2}`,
    },
  },
  hint: {
    position: 'absolute',
    left: tokens.spacingHorizontalM, bottom: tokens.spacingVerticalM,
    maxWidth: '55%',
    zIndex: 5,
    pointerEvents: 'none',
  },
  hintText: {
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground1,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow2,
  },
  // Centered, non-interactive empty-state overlay above the canvas surface.
  empty: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    padding: tokens.spacingHorizontalXL,
    zIndex: 1,
  },
  emptyCard: {
    maxWidth: '420px',
    width: '100%',
  },
  // Floating toolbar chrome (top-right Panel) — elevated, rounded, tokenized.
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow16,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalXXS,
    paddingRight: tokens.spacingHorizontalXXS,
  },
});

export interface CanvasHandle {
  fitToScreen: () => void;
  resetZoom: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  autoAlign: () => void;
}

export interface PipelineCanvasProps {
  activities: PipelineActivity[];
  selectedName?: string;
  onSelect: (name: string | null) => void;
  /** Fired when the user drops a palette tile on the canvas. */
  onDropPaletteKey: (key: string, atX: number, atY: number) => void;
  /**
   * Fired when the user drags a connector from one node's output port to
   * another node's input port. Parent adds a `dependsOn` edge carrying the
   * dependency condition the source port represents.
   */
  onConnect?: (fromName: string, toName: string, cond: ConnectorCondition) => void;
  /**
   * Drill into a control-flow container's inner sub-canvas. Fired by the
   * pencil button on a container node, and (for ForEach / Until) by a
   * double-click on the node — matching ADF / Synapse Studio. The designer
   * pushes a drill step and re-renders the canvas at the inner level.
   */
  onDrillInto?: (name: string) => void;
  /**
   * Pop one drill level — wired to Backspace, which Fabric's keyboard spec maps
   * to "Return to previous canvas" (Learn: data-factory/keyboard-shortcuts).
   * No-op at the top level.
   */
  onDrillBack?: () => void;
  /** Whether the snap-to-grid toggle is on. */
  snapToGrid?: boolean;
  /** Whether the dot grid is visible. */
  showGrid?: boolean;
  /** Bubble zoom changes up so a toolbar can show the % readout. */
  onZoomChange?: (zoom: number) => void;
}

// --- edge derivation: one Bezier edge per (from, condition) pair ---------
function buildEdges(activities: PipelineActivity[]): Edge[] {
  const edges: Edge[] = [];
  for (const a of activities) {
    for (const dep of a.dependsOn || []) {
      const conds = (dep.dependencyConditions || []) as ConnectorCondition[];
      const list = conds.length ? conds : (['Succeeded'] as ConnectorCondition[]);
      for (const c of list) {
        const color = CONNECTOR_COLORS[c] || tokens.colorNeutralStroke1;
        edges.push({
          id: `${dep.activity}->${a.name}:${c}`,
          source: dep.activity,
          target: a.name,
          sourceHandle: c,
          targetHandle: 'in',
          type: 'loom',
          data: { condition: c } as LoomEdgeData,
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        });
      }
    }
  }
  return edges;
}

const PipelineCanvasInner = forwardRef<CanvasHandle, PipelineCanvasProps>(function PipelineCanvasInner(
  { activities, selectedName, onSelect, onDropPaletteKey, onConnect, onDrillInto, onDrillBack, snapToGrid = true, showGrid = true, onZoomChange },
  ref,
) {
  const s = useStyles();
  const rf = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef<Map<string, XY>>(new Map());
  const pendingDropRef = useRef<XY | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  // Fabric "updated canvas experience" — when on, container nodes render an
  // inline mini-preview of their inner activities. Toggled by N / the toolbar.
  const [showNestedPreviews, setShowNestedPreviews] = useState(false);

  // Build the RF node list from activities, preserving any positions the user
  // dragged (positionsRef) and placing brand-new activities either at the drop
  // point (pendingDropRef) or via the deterministic topo fallback.
  const syncNodes = useCallback(() => {
    const fallback = topoFallback(activities, FLOW_NODE_W, NODE_H);
    const nextPos = new Map<string, XY>();
    for (const a of activities) {
      let p = positionsRef.current.get(a.name);
      if (!p) {
        if (pendingDropRef.current) { p = pendingDropRef.current; pendingDropRef.current = null; }
        else p = fallback.get(a.name) || { x: 40, y: 40 };
      }
      nextPos.set(a.name, p);
    }
    positionsRef.current = nextPos;
    setNodes(activities.map((a) => ({
      id: a.name,
      type: 'activity',
      position: nextPos.get(a.name) || { x: 40, y: 40 },
      data: {
        activity: a,
        // Only container activities get a drill handler (→ the pencil button
        // renders). Non-containers leave it undefined.
        onDrill: onDrillInto && isContainerType(a.type) ? onDrillInto : undefined,
        // Inline nested-activity preview (N toggle) — only meaningful on
        // containers, but harmless on leaf nodes (they render nothing).
        showNestedPreview: showNestedPreviews,
      } as ActivityNodeData,
      selected: selectedName === a.name,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    })));
  }, [activities, selectedName, setNodes, onDrillInto, showNestedPreviews]);

  // Re-sync when the activity set / their deps change.
  useEffect(() => { syncNodes(); }, [syncNodes]);

  const edges = useMemo(() => buildEdges(activities), [activities]);

  // onNodesChange (from useNodesState) already applies changes to node state;
  // we just additionally capture position changes so a later activities-driven
  // re-sync preserves where the user dragged each node.
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes);
    for (const c of changes) {
      if (c.type === 'position' && c.position) positionsRef.current.set(c.id, c.position);
    }
  }, [onNodesChange]);

  const handleConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return;
    const cond = (conn.sourceHandle as ConnectorCondition) || 'Succeeded';
    onConnect?.(conn.source, conn.target, cond);
  }, [onConnect]);

  // ADF/Synapse parity: ForEach and Until ALSO drill on double-click (not just
  // the pencil). If/Switch use the pencil only (they have multiple branches,
  // so the designer prompts which branch — no implicit double-click target).
  const handleNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    const a = (node.data as ActivityNodeData)?.activity;
    if (!a || !onDrillInto) return;
    if (a.type === 'ForEach' || a.type === 'Until') onDrillInto(a.name);
  }, [onDrillInto]);

  // --- palette drag-drop ----------------------------------------------------
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-fiab-activity')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const key = e.dataTransfer.getData('application/x-fiab-activity');
    if (!key) return;
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // Offset so the cursor lands roughly on the node centre.
    pendingDropRef.current = { x: pos.x - FLOW_NODE_W / 2, y: pos.y - NODE_H / 2 };
    onDropPaletteKey(key, pendingDropRef.current.x, pendingDropRef.current.y);
  }, [rf, onDropPaletteKey]);

  // --- imperative handle ----------------------------------------------------
  const fitToScreen = useCallback(() => { rf.fitView({ padding: 0.2, duration: 200 }); }, [rf]);
  const resetZoom = useCallback(() => { rf.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 200 }); }, [rf]);
  const zoomIn = useCallback(() => { rf.zoomIn({ duration: 120 }); }, [rf]);
  const zoomOut = useCallback(() => { rf.zoomOut({ duration: 120 }); }, [rf]);
  const autoAlign = useCallback(async () => {
    const laid = await elkLayout(activities, FLOW_NODE_W, NODE_H);
    if (laid.size) {
      positionsRef.current = laid;
      setNodes((prev) => prev.map((n) => ({ ...n, position: laid.get(n.id) || n.position })));
      setTimeout(() => rf.fitView({ padding: 0.2, duration: 200 }), 0);
    }
  }, [activities, rf, setNodes]);

  useImperativeHandle(ref, () => ({ fitToScreen, resetZoom, zoomIn, zoomOut, autoAlign }),
    [fitToScreen, resetZoom, zoomIn, zoomOut, autoAlign]);

  // --- keyboard map (Fabric Data Factory parity) ----------------------------
  // Learn: data-factory/keyboard-shortcuts.
  //   I / O      zoom in / out          F        zoom to fit
  //   A          auto-align (ELK)       N        toggle nested preview
  //   Shift+↑↓←→ pan the canvas         Backspace return to previous canvas
  // Keys are ignored while focus is inside a text control so typing in a node
  // label / property field is never hijacked.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' || target.isContentEditable
    ) return;
    const key = e.key;
    if (key === 'i' || key === 'I') { e.preventDefault(); rf.zoomIn({ duration: 120 }); return; }
    if (key === 'o' || key === 'O') { e.preventDefault(); rf.zoomOut({ duration: 120 }); return; }
    if (key === 'f' || key === 'F') { e.preventDefault(); rf.fitView({ padding: 0.2, duration: 200 }); return; }
    if (key === 'a' || key === 'A') { e.preventDefault(); void autoAlign(); return; }
    if (key === 'n' || key === 'N') { e.preventDefault(); setShowNestedPreviews((v) => !v); return; }
    if (key === 'Backspace') { e.preventDefault(); onDrillBack?.(); return; }
    if (e.shiftKey) {
      const PAN = 80;
      if (key === 'ArrowUp')    { e.preventDefault(); rf.setViewport(shiftViewport(rf.getViewport(), 0, PAN), { duration: 120 }); return; }
      if (key === 'ArrowDown')  { e.preventDefault(); rf.setViewport(shiftViewport(rf.getViewport(), 0, -PAN), { duration: 120 }); return; }
      if (key === 'ArrowLeft')  { e.preventDefault(); rf.setViewport(shiftViewport(rf.getViewport(), PAN, 0), { duration: 120 }); return; }
      if (key === 'ArrowRight') { e.preventDefault(); rf.setViewport(shiftViewport(rf.getViewport(), -PAN, 0), { duration: 120 }); return; }
    }
  }, [rf, autoAlign, onDrillBack]);

  return (
    <div
      ref={wrapRef}
      className={s.shell}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-testid="pipeline-canvas"
      data-canvas="pipeline"
      aria-label="Pipeline design canvas. Keyboard: I/O zoom, F fit, A align, N nested preview, Shift+arrows pan, Backspace back."
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onConnect={handleConnect}
        onNodeClick={(_, n) => onSelect(n.id)}
        onNodeDoubleClick={handleNodeDoubleClick}
        onPaneClick={() => onSelect(null)}
        onMove={(_, vp) => onZoomChange?.(vp.zoom)}
        connectionMode={ConnectionMode.Loose}
        snapToGrid={snapToGrid}
        snapGrid={[16, 16]}
        defaultEdgeOptions={{ type: 'loom' }}
        minZoom={0.25}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        onlyRenderVisibleElements={shouldVirtualize(activities.length)}
      >
        {showGrid && (
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            // Theme-aware accent-tinted grid dots (matches the .loom-app-grid-bg
            // product grid) — resolves light/dark via the --loom-accent-blue var.
            color={accentTint('var(--loom-accent-blue)', 30)}
          />
        )}
        <Panel position="top-right">
          <div className={s.toolbar}>
            <Tooltip content={`${showNestedPreviews ? 'Hide' : 'Show'} nested activity preview (N)`} relationship="label">
              <Button
                size="small"
                appearance={showNestedPreviews ? 'primary' : 'subtle'}
                icon={<Flowchart20Regular />}
                aria-label="Toggle nested activity preview"
                aria-pressed={showNestedPreviews}
                onClick={() => setShowNestedPreviews((v) => !v)}
              >
                Nested
              </Button>
            </Tooltip>
            <Tooltip content="Auto-align (ELK layout) — A" relationship="label">
              <Button size="small" appearance="subtle" icon={<Organization20Regular />} onClick={autoAlign}>Auto-align</Button>
            </Tooltip>
            <Tooltip content="Zoom to fit — F" relationship="label">
              <Button size="small" appearance="subtle" icon={<FullScreenMaximize20Regular />} aria-label="Zoom to fit" onClick={fitToScreen} />
            </Tooltip>
          </div>
        </Panel>
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          // Reuse the kit's per-category accent so the minimap reads the same
          // colour language as the canvas nodes; selected nodes get the brand
          // stroke. (SVG fill resolves the --loom-accent-* var theme-aware.)
          nodeColor={(n) => {
            if (n.selected) return tokens.colorBrandBackground;
            const a = (n.data as ActivityNodeData)?.activity;
            return getActivityVisual(a?.type).accent;
          }}
          nodeStrokeColor={tokens.colorNeutralStroke2}
          maskColor={accentTint(tokens.colorNeutralBackground3, 70)}
          style={{ backgroundColor: tokens.colorNeutralBackground1 }}
        />
      </ReactFlow>

      {activities.length === 0 && (
        <div className={s.empty}>
          <div className={s.emptyCard}>
            <EmptyState
              icon={<Flow24Regular />}
              title="Design your pipeline"
              body="Drag an activity from the left palette onto the canvas — or click a palette tile to insert it at center. Connect the four coloured output ports to set Succeeded / Failed / Completed / Skipped dependencies."
            />
          </div>
        </div>
      )}
      <div className={s.hint}>
        <Caption1 className={s.hintText}>
          drag to pan · wheel to zoom · I/O zoom · F fit · A align · N nested · Shift+Arrow pan · Backspace back
        </Caption1>
      </div>
    </div>
  );
});

/**
 * Public component — wraps the inner canvas in a ReactFlowProvider so
 * useReactFlow() works, and forwards the imperative handle through.
 */
export const PipelineCanvas = forwardRef<CanvasHandle, PipelineCanvasProps>(function PipelineCanvas(props, ref) {
  return (
    <ReactFlowProvider>
      <PipelineCanvasInner {...props} ref={ref} />
    </ReactFlowProvider>
  );
});
