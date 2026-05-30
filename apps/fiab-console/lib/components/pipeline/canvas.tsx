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
import { Organization20Regular, FullScreenMaximize20Regular } from '@fluentui/react-icons';
import { FlowActivityNode, FLOW_NODE_W, type ActivityNodeData } from './flow-activity-node';
import { LoomBezierEdge, type LoomEdgeData } from './loom-bezier-edge';
import { elkLayout, topoFallback, type XY } from './flow-layout';
import { CONNECTOR_COLORS, type ConnectorCondition } from './connector';
import type { PipelineActivity } from './types';

const NODE_H = 84;

const nodeTypes: NodeTypes = { activity: FlowActivityNode };
const edgeTypes: EdgeTypes = { loom: LoomBezierEdge };

const useStyles = makeStyles({
  shell: {
    position: 'relative',
    flex: 1,
    minHeight: 400,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
  },
  hint: {
    position: 'absolute',
    left: 12, bottom: 12,
    maxWidth: '55%',
    zIndex: 5,
    pointerEvents: 'none',
  },
  hintText: {
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '2px 6px',
    borderRadius: 4,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  empty: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    color: tokens.colorNeutralForeground3,
    zIndex: 1,
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
        const color = CONNECTOR_COLORS[c] || '#888888';
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
  { activities, selectedName, onSelect, onDropPaletteKey, onConnect, snapToGrid = true, showGrid = true, onZoomChange },
  ref,
) {
  const s = useStyles();
  const rf = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef<Map<string, XY>>(new Map());
  const pendingDropRef = useRef<XY | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);

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
      data: { activity: a } as ActivityNodeData,
      selected: selectedName === a.name,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    })));
  }, [activities, selectedName, setNodes]);

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

  return (
    <div
      ref={wrapRef}
      className={s.shell}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-testid="pipeline-canvas"
      data-canvas="pipeline"
      aria-label="Pipeline design canvas"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onConnect={handleConnect}
        onNodeClick={(_, n) => onSelect(n.id)}
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
      >
        {showGrid && <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tokens.colorNeutralStroke2} />}
        <Panel position="top-right">
          <div style={{ display: 'flex', gap: 4, background: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 2 }}>
            <Tooltip content="Auto-align (ELK layout)" relationship="label">
              <Button size="small" appearance="subtle" icon={<Organization20Regular />} onClick={autoAlign}>Auto-align</Button>
            </Tooltip>
            <Tooltip content="Zoom to fit" relationship="label">
              <Button size="small" appearance="subtle" icon={<FullScreenMaximize20Regular />} aria-label="Zoom to fit" onClick={fitToScreen} />
            </Tooltip>
          </div>
        </Panel>
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => (n.selected ? tokens.colorBrandBackground : tokens.colorNeutralForeground3)}
          style={{ backgroundColor: tokens.colorNeutralBackground1 }}
        />
      </ReactFlow>

      {activities.length === 0 && (
        <div className={s.empty}>
          <Caption1>Drag an activity from the left palette onto the canvas to begin.</Caption1>
        </div>
      )}
      <div className={s.hint}>
        <Caption1 className={s.hintText}>
          drag to pan · wheel to zoom · drag a coloured output port (success / failure / completion / skip) to connect
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
