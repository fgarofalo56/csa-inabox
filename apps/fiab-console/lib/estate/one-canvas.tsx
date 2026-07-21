'use client';

/**
 * WS-8.2 — One-Canvas cross-workload authoring surface.
 *
 * A single canvas where typed cross-workload nodes (table / notebook / KQL /
 * measure / ontology-object / model / agent / report) are dropped from a
 * palette, connected by ThreadAction (Weave) edges, and PUBLISHED as an estate
 * {@link EstatePlan} — the exact same plan-model the NL planner (8.1) emits, so
 * both run the identical executor over the 13 real Weave bridges
 * (no-vaporware.md). Built on the mandatory canvas standard:
 *   • `canvas-node-kit` nodes (compact, typed ports, status) + React Flow;
 *   • undo/redo via `useCanvasHistory`;
 *   • the shared `CanvasRightRail` zoom controls + `MiniMap`;
 *   • a `ResizableCanvasRegion` (G3) height-resizable shell.
 *
 * Edges are Weave bridges: connecting node A → node B picks the ThreadAction
 * whose source accepts A's type and whose produced type is B's type. A node with
 * an incoming edge compiles to a `weave` node; a root node compiles to `create`.
 */

import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, Panel,
  Position, useNodesState, useEdgesState, useReactFlow, ConnectionMode,
  type Node, type Edge, type Connection, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Button, Subtitle2, Caption1, Body1, Badge, Field, Input, Textarea, Switch,
  Select, MessageBar, MessageBarBody, MessageBarTitle, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowUndo16Regular, ArrowRedo16Regular, Delete16Regular, Rocket20Regular,
  Add16Regular,
} from '@fluentui/react-icons';
import {
  CanvasNode, CanvasRightRail, CANVAS_NODE_WIDTH, getItemVisual, CanvasPort,
  accentTint,
} from '@/lib/components/canvas/canvas-node-kit';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { useCanvasHistory } from '@/lib/components/canvas/use-canvas-history';
import {
  ESTATE_NODE_KINDS, nodeKind, bridgesFrom, bridgeById,
} from '@/lib/estate/weave-catalog';
import {
  compilePlanFromCanvas, type CanvasEstateNode, type CanvasEstateEdge,
  type EstatePlan,
} from '@/lib/estate/estate-plan-model';
import { THREAD_ACTIONS, type ThreadField } from '@/lib/thread/thread-actions';
import { clientFetch } from '@/lib/client-fetch';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  body: { display: 'flex', gap: tokens.spacingHorizontalM, minHeight: 0, alignItems: 'stretch' },
  canvasWrap: { flex: 1, minWidth: 0, borderRadius: tokens.borderRadiusLarge, overflow: 'hidden', border: `1px solid ${tokens.colorNeutralStroke2}` },
  palette: {
    width: '210px', flexShrink: 0, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2, overflowY: 'auto',
  },
  paletteItem: {
    display: 'flex', flexDirection: 'column', gap: '2px', textAlign: 'left',
    padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1,
    cursor: 'pointer', width: '100%',
  },
  inspector: {
    width: '300px', flexShrink: 0, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2, overflowY: 'auto',
  },
});

/** RF node data payload for a typed estate node. */
interface EstateNodeData extends Record<string, unknown> {
  itemType: string;
  title: string;
  values: Record<string, unknown>;
}

/** RF edge data — the Weave bridge (ThreadAction) on the edge. */
interface EstateEdgeData extends Record<string, unknown> {
  action: string;
}

/** A canvas-node-kit-compliant node for a typed estate item. */
function EstateFlowNode({ data, selected }: NodeProps) {
  const d = data as EstateNodeData;
  const visual = getItemVisual(d.itemType);
  const kind = nodeKind(d.itemType);
  return (
    <CanvasNode
      title={d.title || kind?.label || d.itemType}
      typeLabel={kind?.label || d.itemType}
      visual={visual}
      selected={selected}
      rootProps={{ 'data-estate-node': d.itemType }}
    >
      <CanvasPort id="in" type="target" position={Position.Left} accent={visual.accent} />
      <CanvasPort id="out" type="source" position={Position.Right} accent={visual.accent} />
    </CanvasNode>
  );
}

const nodeTypes = { estate: EstateFlowNode };

interface Snapshot { nodes: Node<EstateNodeData>[]; edges: Edge<EstateEdgeData>[] }

export interface OneCanvasProps {
  /** Called with the compiled plan-model when the user clicks Publish. */
  onPublish: (plan: EstatePlan) => void;
  /** Disabled while a publish/execute is in flight. */
  busy?: boolean;
}

function InnerCanvas({ onPublish, busy }: OneCanvasProps) {
  const s = useStyles();
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<EstateNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<EstateEdgeData>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const idSeq = useRef(0);

  const history = useCanvasHistory<Snapshot>({ nodes: [], edges: [] });

  const snapshot = useCallback((): Snapshot => ({ nodes, edges }), [nodes, edges]);

  const commit = useCallback((next: Snapshot) => {
    setNodes(next.nodes);
    setEdges(next.edges);
    history.commit(next);
  }, [setNodes, setEdges, history]);

  const addNode = useCallback((itemType: string) => {
    const kind = nodeKind(itemType);
    idSeq.current += 1;
    const id = `en_${Date.now().toString(36)}_${idSeq.current}`;
    const count = nodes.length;
    const node: Node<EstateNodeData> = {
      id,
      type: 'estate',
      position: { x: 60 + (count % 4) * (CANVAS_NODE_WIDTH + 60), y: 60 + Math.floor(count / 4) * 140 },
      data: { itemType, title: `New ${kind?.label || itemType}`, values: {} },
    };
    commit({ nodes: [...nodes, node], edges });
    setSelectedId(id);
  }, [nodes, edges, commit]);

  const onConnect = useCallback((conn: Connection) => {
    setConnectError(null);
    const src = nodes.find((n) => n.id === conn.source);
    const tgt = nodes.find((n) => n.id === conn.target);
    if (!src || !tgt || src.id === tgt.id) return;
    // Pick the Weave bridge whose source accepts A's type and produces B's type.
    const candidates = bridgesFrom(src.data.itemType).filter((b) => b.producesType === tgt.data.itemType);
    if (candidates.length === 0) {
      setConnectError(`No Weave bridge connects a ${src.data.itemType} to a ${tgt.data.itemType}.`);
      return;
    }
    // A node may only be produced by ONE bridge — replace any existing incoming edge.
    const action = candidates[0].id;
    const edge: Edge<EstateEdgeData> = {
      id: `ee_${conn.source}_${conn.target}`,
      source: conn.source!,
      target: conn.target!,
      sourceHandle: 'out',
      targetHandle: 'in',
      type: 'default',
      label: candidates[0].label,
      data: { action },
    };
    const nextEdges = [...edges.filter((e) => e.target !== conn.target), edge];
    commit({ nodes, edges: nextEdges });
  }, [nodes, edges, commit]);

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    commit({
      nodes: nodes.filter((n) => n.id !== selectedId),
      edges: edges.filter((e) => e.source !== selectedId && e.target !== selectedId),
    });
    setSelectedId(null);
  }, [selectedId, nodes, edges, commit]);

  const doUndo = useCallback(() => {
    const snap = history.undo();
    if (snap) { setNodes(snap.nodes); setEdges(snap.edges); }
  }, [history, setNodes, setEdges]);
  const doRedo = useCallback(() => {
    const snap = history.redo();
    if (snap) { setNodes(snap.nodes); setEdges(snap.edges); }
  }, [history, setNodes, setEdges]);

  // Keyboard: Ctrl+Z / Ctrl+Y / Delete.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
        e.preventDefault(); removeSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo, removeSelected, selectedId]);

  const updateSelectedValues = useCallback((patch: Record<string, unknown>, title?: string) => {
    const next = nodes.map((n) =>
      n.id === selectedId
        ? { ...n, data: { ...n.data, values: { ...n.data.values, ...patch }, ...(title !== undefined ? { title } : {}) } }
        : n);
    commit({ nodes: next, edges });
  }, [nodes, edges, selectedId, commit]);

  const publish = useCallback(() => {
    const canvasNodes: CanvasEstateNode[] = nodes.map((n) => ({
      id: n.id, itemType: n.data.itemType, title: n.data.title, values: n.data.values,
    }));
    const canvasEdges: CanvasEstateEdge[] = edges
      .filter((e) => e.data?.action)
      .map((e) => ({ from: e.source, to: e.target, action: e.data!.action }));
    onPublish(compilePlanFromCanvas(canvasNodes, canvasEdges, { title: 'One-Canvas estate' }));
  }, [nodes, edges, onPublish]);

  const selected = nodes.find((n) => n.id === selectedId) || null;
  const incoming = selected ? edges.find((e) => e.target === selected.id) : undefined;
  const incomingAction = incoming?.data?.action ? bridgeById(incoming.data.action) : undefined;
  const actionFields: ThreadField[] = incoming?.data?.action
    ? (THREAD_ACTIONS.find((a) => a.id === incoming.data!.action)?.fields ?? [])
    : [];

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Subtitle2>One-Canvas authoring</Subtitle2>
        <Badge appearance="tint" color="brand">{nodes.length} node{nodes.length === 1 ? '' : 's'}</Badge>
        <div style={{ flex: 1 }} />
        <Button size="small" appearance="subtle" icon={<ArrowUndo16Regular />} onClick={doUndo} disabled={!history.canUndo}>Undo</Button>
        <Button size="small" appearance="subtle" icon={<ArrowRedo16Regular />} onClick={doRedo} disabled={!history.canRedo}>Redo</Button>
        <Button
          appearance="primary"
          icon={<Rocket20Regular />}
          onClick={publish}
          disabled={busy || nodes.length === 0}
        >
          Publish as a plan
        </Button>
      </div>

      {connectError && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody><MessageBarTitle>Can't connect those nodes</MessageBarTitle>{connectError}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.body}>
        {/* Palette */}
        <div className={s.palette} aria-label="Node palette">
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Drag the estate: add nodes, connect them into ingest → transform → serve → visualize → publish.</Caption1>
          {ESTATE_NODE_KINDS.map((k) => (
            <button key={k.itemType} className={s.paletteItem} onClick={() => addNode(k.itemType)}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Add16Regular /><strong style={{ fontSize: tokens.fontSizeBase200 }}>{k.label}</strong>
              </span>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{k.hint}</Caption1>
            </button>
          ))}
        </div>

        {/* Canvas */}
        <div className={s.canvasWrap}>
          <ResizableCanvasRegion storageKey="estate-one-canvas" defaultPx={520} minPx={340} ariaLabel="Resize the estate canvas height">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, n) => setSelectedId(n.id)}
              onPaneClick={() => setSelectedId(null)}
              onMove={(_, vp) => setZoom(vp.zoom)}
              connectionMode={ConnectionMode.Loose}
              connectionRadius={34}
              fitView
              minZoom={0.25}
              maxZoom={2}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1.5} color={accentTint('var(--loom-accent-blue)', 45)} />
              <Panel position="bottom-left">
                <CanvasRightRail
                  zoom={zoom}
                  minZoom={0.25}
                  maxZoom={2}
                  onZoomChange={(z) => rf.setViewport({ ...rf.getViewport(), zoom: z }, { duration: 120 })}
                  onZoomIn={() => rf.zoomIn({ duration: 120 })}
                  onZoomOut={() => rf.zoomOut({ duration: 120 })}
                  onFit={() => rf.fitView({ padding: 0.2, duration: 200 })}
                  collapsed={railCollapsed}
                  onToggleCollapse={() => setRailCollapsed((v) => !v)}
                />
              </Panel>
              <MiniMap
                pannable
                zoomable
                nodeStrokeColor={tokens.colorNeutralStroke2}
                maskColor={accentTint(tokens.colorNeutralBackground3, 70)}
                style={{ backgroundColor: tokens.colorNeutralBackground1 }}
              />
              <Panel position="top-left">
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Click a node to configure it →</Caption1>
              </Panel>
            </ReactFlow>
          </ResizableCanvasRegion>
        </div>

        {/* Inspector */}
        <div className={s.inspector} aria-label="Node inspector">
          {!selected && (
            <>
              <Subtitle2>Inspector</Subtitle2>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Add nodes from the palette, then drag from a node's right port to another node's left port to weave them. Select a node to name it and configure the bridge, then Publish.
              </Caption1>
            </>
          )}
          {selected && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                <Subtitle2>{nodeKind(selected.data.itemType)?.label || selected.data.itemType}</Subtitle2>
                <div style={{ flex: 1 }} />
                <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={removeSelected}>Remove</Button>
              </div>
              <Field label="Name">
                <Input value={selected.data.title} onChange={(_, d) => updateSelectedValues({}, d.value)} />
              </Field>
              {incomingAction ? (
                <>
                  <Body1><strong>Weave:</strong> {incomingAction.label}</Body1>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Produced by running “{incomingAction.label}” from the connected upstream node. Configure the bridge:
                  </Caption1>
                  {actionFields.map((f) => (
                    <InspectorField
                      key={f.name}
                      field={f}
                      value={selected.data.values[f.name]}
                      onChange={(v) => updateSelectedValues({ [f.name]: v })}
                    />
                  ))}
                </>
              ) : (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Root node — created directly as the start of the topology. Connect it to a downstream node to weave the chain.
                </Caption1>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A single guided inspector field — dropdown/text/textarea/toggle only. */
function InspectorField({ field, value, onChange }: { field: ThreadField; value: unknown; onChange: (v: unknown) => void }) {
  const [items, setItems] = useState<Array<{ id: string; displayName: string }>>([]);
  useEffect(() => {
    if (field.kind !== 'loom-item' || !field.itemTypes?.length) return;
    let cancelled = false;
    (async () => {
      try {
        const type = field.itemTypes![0];
        const r = await clientFetch(`/api/items?type=${encodeURIComponent(type)}`);
        const j = await r.json();
        if (!cancelled && j?.ok) setItems((j.items || []).map((it: any) => ({ id: it.id, displayName: it.displayName })));
      } catch { /* leave empty — create-new still available */ }
    })();
    return () => { cancelled = true; };
  }, [field]);

  if (field.kind === 'toggle') {
    return (
      <Field label={field.label} hint={field.hint}>
        <Switch checked={value === undefined ? field.default === true : !!value} onChange={(_, d) => onChange(d.checked)} />
      </Field>
    );
  }
  if (field.kind === 'textarea') {
    return (
      <Field label={field.label} hint={field.hint}>
        <Textarea value={typeof value === 'string' ? value : ''} onChange={(_, d) => onChange(d.value)} rows={3} resize="vertical" />
      </Field>
    );
  }
  if (field.kind === 'select' || field.kind === 'loom-item') {
    const opts = field.kind === 'select'
      ? (field.options || [])
      : items.map((it) => ({ value: it.id, label: it.displayName }));
    return (
      <Field label={field.label} hint={field.hint}>
        <Select value={typeof value === 'string' ? value : (field.default as string) || ''} onChange={(_, d) => onChange(d.value)}>
          <option value="">Choose…</option>
          {field.kind === 'loom-item' && field.allowCreate && <option value="__new__">{field.createLabel || '+ Create new'}</option>}
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </Field>
    );
  }
  // text
  return (
    <Field label={field.label} hint={field.hint}>
      <Input value={typeof value === 'string' ? value : ''} onChange={(_, d) => onChange(d.value)} />
    </Field>
  );
}

export function OneCanvas(props: OneCanvasProps) {
  return (
    <ReactFlowProvider>
      <InnerCanvas {...props} />
    </ReactFlowProvider>
  );
}
