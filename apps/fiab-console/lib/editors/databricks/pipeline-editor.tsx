'use client';

/**
 * DatabricksPipelineEditor — the Lakeflow Declarative Pipelines (DLT) visual
 * editor (Wave 10, DBX-3).
 *
 * A canvas-node-kit / React-Flow DAG designer for a DLT pipeline: Source →
 * Streaming table / Materialized view datasets with attached Expectation nodes.
 * The canvas compiles (via `dlt-spec.ts`) to real Databricks DLT SQL, imports it
 * as a workspace notebook, and creates + runs the pipeline through the Pipelines
 * REST (`/api/2.0/pipelines`). A run-history grid and event-log panel surface
 * the pipeline's real updates + expectation pass/fail counts.
 *
 * Every field is typed (dropdowns / inputs / toggles) — NO freeform JSON
 * (loom_no_freeform_config); only the dataset `query` and expectation
 * `condition` are SQL surfaces (an allowed 1:1 query/expression surface). The
 * compiled SQL is shown READ-ONLY on the SQL tab. Undo/redo is Wave-2's
 * useCanvasHistory.
 *
 * Backend: the bound Databricks workspace. Honest-gates when unwired. No bicep,
 * no Microsoft Fabric — Loom's Synapse/ADF Data pipeline is the Azure-native
 * default, so nothing here hard-requires Databricks.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, Panel,
  Handle, Position, useNodesState, useEdgesState, addEdge,
  type Node, type Edge, type NodeProps, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Field, Dropdown, Option,
  Switch, Spinner, TabList, Tab, Tooltip,
  Table, TableHeader, TableHeaderCell, TableRow, TableCell, TableBody,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Database20Regular, Stream20Regular, Table20Regular, CheckmarkCircle20Regular,
  Notebook20Regular, Play20Regular, Stop20Regular, Save20Regular,
  Add20Regular, Delete20Regular, ArrowClockwise20Regular,
  ArrowUndo16Regular, ArrowRedo16Regular, Dismiss16Regular, Code20Regular,
} from '@fluentui/react-icons';
import type { JSX } from 'react';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { clientFetch } from '@/lib/client-fetch';
import { safeModelJson } from '../model-fetch';
import {
  CanvasNode, CANVAS_NODE_WIDTH, CATEGORY_ACCENT, portStyle, accentTint, CanvasRailPanel,
  type CanvasVisual, type CanvasNodeCategory, type CanvasNodeStatus,
} from '@/lib/components/canvas/canvas-node-kit';
import { useCanvasHistory } from '@/lib/components/canvas/use-canvas-history';
import {
  emptyDltModel, validateDltModel, compileDltSql, isDataset, isSource, isExpectation,
  DLT_FILE_FORMATS,
  type DltPipelineModel, type DltNode, type DltNodeKind, type DltSourceNode,
  type DltDatasetNode, type DltExpectationNode, type DltEdge, type DltChannel,
  type DltFileFormat, type DltExpectationAction,
} from './dlt-spec';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { SplitPane } from '@/lib/components/shared/split-pane';

const NODE_WIDTH = CANVAS_NODE_WIDTH;

// ---------------------------------------------------------------------------
// Node visuals
// ---------------------------------------------------------------------------

const KIND_META: Record<DltNodeKind, { category: CanvasNodeCategory; icon: JSX.Element; typeLabel: string }> = {
  source: { category: 'move', icon: <Database20Regular />, typeLabel: 'Source' },
  streaming_table: { category: 'transform', icon: <Stream20Regular />, typeLabel: 'Streaming table' },
  materialized_view: { category: 'transform', icon: <Table20Regular />, typeLabel: 'Materialized view' },
  expectation: { category: 'control', icon: <CheckmarkCircle20Regular />, typeLabel: 'Expectation' },
};

function visualFor(kind: DltNodeKind): CanvasVisual {
  const m = KIND_META[kind];
  return { icon: m.icon, category: m.category, accent: CATEGORY_ACCENT[m.category] };
}

interface DltNodeData {
  kind: DltNodeKind;
  label: string;
  subtitle?: string;
  visual: CanvasVisual;
  status?: CanvasNodeStatus;
  incomplete?: boolean;
  [k: string]: unknown;
}

function DltFlowNodeImpl({ data, selected }: NodeProps) {
  const d = data as DltNodeData;
  const meta = KIND_META[d.kind];
  const hasIn = d.kind !== 'source';
  const hasOut = d.kind !== 'expectation';
  return (
    <CanvasNode
      width={NODE_WIDTH}
      title={d.label}
      visual={d.visual}
      selected={selected}
      typeLabel={meta.typeLabel}
      description={d.subtitle}
      status={d.status}
      error={d.incomplete}
      rootProps={{ 'data-node-kind': d.kind, 'aria-label': `${meta.typeLabel} ${d.label}` }}
    >
      {hasIn && (
        <Handle id="in" type="target" position={Position.Left} style={{ ...portStyle('in', d.visual.accent), left: -6 }} />
      )}
      {hasOut && (
        <Handle id="out" type="source" position={Position.Right} style={{ ...portStyle('out', d.visual.accent), right: -6 }} />
      )}
    </CanvasNode>
  );
}
const DltFlowNode = memo(DltFlowNodeImpl);
const nodeTypes = { dlt: DltFlowNode };

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  palette: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' },
  body: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.7fr) minmax(320px, 1fr)',
    gap: tokens.spacingHorizontalM,
    alignItems: 'stretch',
  },
  canvasWrap: {
    // Fills the user-resizable ResizableCanvasRegion (default 520px, persisted
    // per-surface, bounded 320px–80vh). React Flow needs this definite height.
    height: '100%', minWidth: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden', background: tokens.colorNeutralBackground2,
  },
  inspector: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalS, overflow: 'auto', maxHeight: '520px',
  },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  code: {
    fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere', background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, maxHeight: '520px', overflow: 'auto',
  },
  panelScroll: { maxHeight: '480px', overflow: 'auto' },
  problems: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  evtInfo: { color: tokens.colorNeutralForeground3 },
  evtWarn: { color: tokens.colorPaletteDarkOrangeForeground1 },
  evtError: { color: tokens.colorPaletteRedForeground1 },
});

// ---------------------------------------------------------------------------
// Model ↔ React-Flow adapters
// ---------------------------------------------------------------------------

function nodeLabel(n: DltNode): string {
  if (isSource(n)) return n.name || 'source';
  if (isExpectation(n)) return n.name || 'expectation';
  return (n as DltDatasetNode).name || n.kind;
}
function nodeSubtitle(n: DltNode): string | undefined {
  if (isSource(n)) return n.sourceKind === 'files' ? (n.path || 'no path') : (n.tableName || 'no table');
  if (isExpectation(n)) return n.condition || 'no condition';
  return undefined;
}
function nodeIncomplete(model: DltPipelineModel, n: DltNode): boolean {
  if (isSource(n)) return n.sourceKind === 'files' ? !n.path?.trim() : !n.tableName?.trim();
  if (isExpectation(n)) return !n.name?.trim() || !n.condition?.trim();
  const d = n as DltDatasetNode;
  const hasQuery = !!d.query?.trim();
  const hasUp = model.edges.some((e) => e.target === d.id);
  return !d.name?.trim() || (!hasQuery && !hasUp);
}

function toFlowNodes(model: DltPipelineModel): Node[] {
  return model.nodes.map((n, i) => ({
    id: n.id,
    type: 'dlt',
    position: n.position ?? { x: (i % 4) * 260 + 40, y: Math.floor(i / 4) * 170 + 40 },
    data: {
      kind: n.kind,
      label: nodeLabel(n),
      subtitle: nodeSubtitle(n),
      visual: visualFor(n.kind),
      incomplete: nodeIncomplete(model, n),
    } as DltNodeData,
  }));
}
function toFlowEdges(model: DltPipelineModel): Edge[] {
  return model.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: false }));
}

let idSeq = 0;
function newId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export function DatabricksPipelineEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  const [model, setModelState] = useState<DltPipelineModel>(() => emptyDltModel(item.displayName || 'New DLT pipeline'));
  const history = useCanvasHistory<DltPipelineModel>(model);
  const modelRef = useRef(model);
  modelRef.current = model;

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>(toFlowNodes(model));
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>(toFlowEdges(model));
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [tab, setTab] = useState<'design' | 'sql' | 'runs' | 'events'>('design');
  const [notConfigured, setNotConfigured] = useState<{ missing: string } | null>(null);
  const [pipelines, setPipelines] = useState<Array<{ pipeline_id: string; name?: string; state?: string }>>([]);
  const [boundPipelineId, setBoundPipelineId] = useState<string>('');
  const [updates, setUpdates] = useState<Array<{ update_id: string; state?: string; creation_time?: number; full_refresh?: boolean }>>([]);
  const [events, setEvents] = useState<Array<{ timestamp?: string; level?: string; event_type?: string; message?: string; details?: Record<string, unknown> }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ intent: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [fullRefresh, setFullRefresh] = useState(false);

  const problems = useMemo(() => validateDltModel(model), [model]);
  const compiledSql = useMemo(() => {
    try { return compileDltSql(model); } catch { return '-- (fix the model to compile)'; }
  }, [model]);

  // Re-derive the React-Flow graph from the model whenever it changes, but keep
  // live drag positions from flowNodes (so a drag isn't reverted).
  const syncFlow = useCallback((m: DltPipelineModel) => {
    setFlowNodes((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p.position]));
      return toFlowNodes(m).map((n) => ({ ...n, position: byId.get(n.id) ?? n.position }));
    });
    setFlowEdges(toFlowEdges(m));
  }, [setFlowNodes, setFlowEdges]);

  // Commit a model mutation: update state, history, and the flow graph.
  const commit = useCallback((next: DltPipelineModel) => {
    history.commit(next);
    setModelState(next);
    syncFlow(next);
  }, [history, syncFlow]);

  // -- initial load: item state (persisted canvas) + pipeline list ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Load any persisted canvas model + bound pipeline id from the item state.
      try {
        const r = await clientFetch(`/api/items/${item.slug}/${id}`);
        const j = await safeModelJson(r);
        if (!cancelled && j.ok && j.data) {
          const content = (j.data as any).state?.content ?? {};
          if (content.dltModel && typeof content.dltModel === 'object') {
            const m = content.dltModel as DltPipelineModel;
            setModelState(m); history.reset(m); syncFlow(m);
          }
          if (content.pipelineId) setBoundPipelineId(String(content.pipelineId));
        }
      } catch { /* new item — start blank */ }

      // Load the workspace's pipelines for the picker (honest-gates when unwired).
      try {
        const r = await clientFetch(`/api/items/databricks-pipeline/${id}/pipelines`);
        const j = await safeModelJson(r);
        if (cancelled) return;
        if (j.ok && Array.isArray((j.data as any)?.pipelines)) {
          setPipelines((j.data as any).pipelines);
        } else if (j.code === 'not_configured') {
          setNotConfigured({ missing: (j.data as any)?.missing || 'LOOM_DATABRICKS_HOSTNAME' });
        }
      } catch { /* leave picker empty */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, item.slug]);

  // -- selected node --------------------------------------------------------
  const selectedNode = useMemo(
    () => model.nodes.find((n) => n.id === selectedId) ?? null,
    [model.nodes, selectedId],
  );

  const patchNode = useCallback((nodeId: string, patch: Partial<DltNode>) => {
    const next: DltPipelineModel = {
      ...modelRef.current,
      nodes: modelRef.current.nodes.map((n) => (n.id === nodeId ? ({ ...n, ...patch } as DltNode) : n)),
    };
    commit(next);
  }, [commit]);

  const addNode = useCallback((kind: DltNodeKind) => {
    const base = { id: newId(kind), kind, position: { x: 60 + Math.random() * 80, y: 60 + Math.random() * 80 } };
    let node: DltNode;
    if (kind === 'source') {
      node = { ...base, kind: 'source', name: 'source', sourceKind: 'files', fileFormat: 'json', path: '' } as DltSourceNode;
    } else if (kind === 'expectation') {
      node = { ...base, kind: 'expectation', name: 'valid', condition: '', action: 'warn' } as DltExpectationNode;
    } else {
      node = { ...base, kind, name: kind === 'streaming_table' ? 'bronze' : 'gold' } as DltDatasetNode;
    }
    commit({ ...modelRef.current, nodes: [...modelRef.current.nodes, node] });
    setSelectedId(node.id);
  }, [commit]);

  const deleteNode = useCallback((nodeId: string) => {
    const next: DltPipelineModel = {
      ...modelRef.current,
      nodes: modelRef.current.nodes.filter((n) => n.id !== nodeId),
      edges: modelRef.current.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    };
    commit(next);
    setSelectedId(null);
  }, [commit]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const exists = modelRef.current.edges.some((e) => e.source === c.source && e.target === c.target);
    if (exists) return;
    const edge: DltEdge = { id: newId('e'), source: c.source, target: c.target };
    commit({ ...modelRef.current, edges: [...modelRef.current.edges, edge] });
    setFlowEdges((eds) => addEdge({ ...c, id: edge.id }, eds));
  }, [commit, setFlowEdges]);

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    patchNode(node.id, { position: node.position } as Partial<DltNode>);
  }, [patchNode]);

  const doUndo = useCallback(() => {
    const snap = history.undo();
    if (snap) { setModelState(snap); syncFlow(snap); }
  }, [history, syncFlow]);
  const doRedo = useCallback(() => {
    const snap = history.redo();
    if (snap) { setModelState(snap); syncFlow(snap); }
  }, [history, syncFlow]);

  // -- persistence + REST actions -------------------------------------------
  const persistState = useCallback(async (patch: Record<string, unknown>) => {
    try {
      const r = await clientFetch(`/api/items/${item.slug}/${id}`);
      const j = await safeModelJson(r);
      const existing = (j.data as any)?.state ?? {};
      const content = { ...(existing.content ?? {}), ...patch };
      await clientFetch(`/api/items/${item.slug}/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: { ...existing, content } }),
      });
    } catch { /* best-effort persistence */ }
  }, [id, item.slug]);

  const saveCanvas = useCallback(async () => {
    setBusy('save-canvas');
    await persistState({ dltModel: model });
    setBusy(null);
    setNotice({ intent: 'success', text: 'Canvas saved.' });
  }, [model, persistState]);

  const createPipeline = useCallback(async () => {
    if (problems.length) { setNotice({ intent: 'error', text: 'Fix the model problems before creating the pipeline.' }); return; }
    setBusy('create');
    setNotice(null);
    try {
      const r = await clientFetch(`/api/items/databricks-pipeline/${id}/spec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const j = await safeModelJson(r);
      if (j.ok && (j.data as any)?.pipeline_id) {
        const pid = String((j.data as any).pipeline_id);
        setBoundPipelineId(pid);
        await persistState({ dltModel: model, pipelineId: pid });
        setNotice({ intent: 'success', text: `Pipeline created (${pid}). Start it to run an update.` });
      } else if (j.code === 'not_configured') {
        setNotConfigured({ missing: (j.data as any)?.missing || 'LOOM_DATABRICKS_HOSTNAME' });
      } else {
        setNotice({ intent: 'error', text: j.error || 'Failed to create the pipeline.' });
      }
    } finally {
      setBusy(null);
    }
  }, [id, model, problems.length, persistState]);

  const startPipeline = useCallback(async () => {
    if (!boundPipelineId) { setNotice({ intent: 'error', text: 'Create or bind a pipeline first.' }); return; }
    setBusy('start');
    try {
      const r = await clientFetch(`/api/items/databricks-pipeline/${id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pipelineId: boundPipelineId, fullRefresh }),
      });
      const j = await safeModelJson(r);
      if (j.ok && (j.data as any)?.update_id) {
        setNotice({ intent: 'success', text: `Update started: ${(j.data as any).update_id}` });
        void loadUpdates();
      } else {
        setNotice({ intent: 'error', text: j.error || 'Failed to start the pipeline.' });
      }
    } finally { setBusy(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundPipelineId, fullRefresh, id]);

  const stopPipeline = useCallback(async () => {
    if (!boundPipelineId) return;
    setBusy('stop');
    try {
      const r = await clientFetch(`/api/items/databricks-pipeline/${id}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pipelineId: boundPipelineId }),
      });
      const j = await safeModelJson(r);
      setNotice(j.ok ? { intent: 'info', text: 'Stop requested.' } : { intent: 'error', text: j.error || 'Failed to stop.' });
    } finally { setBusy(null); }
  }, [boundPipelineId, id]);

  const loadUpdates = useCallback(async () => {
    if (!boundPipelineId) { setUpdates([]); return; }
    const r = await clientFetch(`/api/items/databricks-pipeline/${id}/updates?pipelineId=${encodeURIComponent(boundPipelineId)}`);
    const j = await safeModelJson(r);
    if (j.ok && Array.isArray((j.data as any)?.updates)) setUpdates((j.data as any).updates);
  }, [boundPipelineId, id]);

  const loadEvents = useCallback(async () => {
    if (!boundPipelineId) { setEvents([]); return; }
    const r = await clientFetch(`/api/items/databricks-pipeline/${id}/events?pipelineId=${encodeURIComponent(boundPipelineId)}`);
    const j = await safeModelJson(r);
    if (j.ok && Array.isArray((j.data as any)?.events)) setEvents((j.data as any).events);
  }, [boundPipelineId, id]);

  // Load an existing pipeline's spec into the render graph when it is bound.
  const bindExisting = useCallback(async (pid: string) => {
    setBoundPipelineId(pid);
    await persistState({ pipelineId: pid });
    void loadUpdates();
    void loadEvents();
  }, [persistState, loadUpdates, loadEvents]);

  useEffect(() => {
    if (tab === 'runs') void loadUpdates();
    if (tab === 'events') void loadEvents();
  }, [tab, loadUpdates, loadEvents]);

  // -- render ---------------------------------------------------------------
  return (
    <div className={s.root}>
      {notConfigured && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Databricks workspace not wired</MessageBarTitle>
            No Databricks workspace is configured. Set <code>{notConfigured.missing}</code> on the Loom Console to
            author and run Lakeflow Declarative Pipelines. You can still design the canvas below; the Azure-native{' '}
            <strong>Data pipeline</strong> item (Synapse/ADF) is the default pipeline surface and needs no Databricks.
          </MessageBarBody>
        </MessageBar>
      )}

      {notice && (
        <MessageBar intent={notice.intent === 'error' ? 'error' : notice.intent === 'success' ? 'success' : 'info'}>
          <MessageBarBody>{notice.text}</MessageBarBody>
          <MessageBarActions>
            <Button appearance="transparent" icon={<Dismiss16Regular />} aria-label="Dismiss" onClick={() => setNotice(null)} />
          </MessageBarActions>
        </MessageBar>
      )}

      {/* Pipeline settings + top actions */}
      <div className={s.toolbar}>
        <Field label="Pipeline name">
          <Input value={model.name} onChange={(_, d) => commit({ ...model, name: d.value })} style={{ minWidth: 220 }} />
        </Field>
        <Field label="Bind existing">
          <Dropdown
            placeholder={pipelines.length ? 'Select a pipeline' : 'No pipelines'}
            selectedOptions={boundPipelineId ? [boundPipelineId] : []}
            value={pipelines.find((p) => p.pipeline_id === boundPipelineId)?.name || boundPipelineId}
            onOptionSelect={(_, d) => d.optionValue && void bindExisting(d.optionValue)}
            style={{ minWidth: 220 }}
          >
            {pipelines.map((p) => (
              <Option key={p.pipeline_id} value={p.pipeline_id} text={p.name || p.pipeline_id}>
                {p.name || p.pipeline_id} {p.state ? `· ${p.state}` : ''}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <div className={s.spacer} />
        <Tooltip content="Undo" relationship="label">
          <Button appearance="subtle" icon={<ArrowUndo16Regular />} disabled={!history.canUndo} onClick={doUndo} aria-label="Undo" />
        </Tooltip>
        <Tooltip content="Redo" relationship="label">
          <Button appearance="subtle" icon={<ArrowRedo16Regular />} disabled={!history.canRedo} onClick={doRedo} aria-label="Redo" />
        </Tooltip>
        <Button appearance="outline" icon={<Save20Regular />} disabled={busy === 'save-canvas'} onClick={saveCanvas}>Save canvas</Button>
        <Button appearance="primary" icon={busy === 'create' ? <Spinner size="tiny" /> : <Add20Regular />}
          disabled={busy === 'create' || problems.length > 0} onClick={createPipeline}>
          Create pipeline
        </Button>
      </div>

      {/* Run controls (active once a pipeline is bound/created) */}
      <div className={s.toolbar}>
        <Badge appearance="tint" color={boundPipelineId ? 'brand' : 'informative'}>
          {boundPipelineId ? `Bound: ${boundPipelineId}` : 'Not created yet'}
        </Badge>
        <Switch checked={fullRefresh} onChange={(_, d) => setFullRefresh(d.checked)} label="Full refresh" />
        <Button icon={busy === 'start' ? <Spinner size="tiny" /> : <Play20Regular />} disabled={!boundPipelineId || busy === 'start'} onClick={startPipeline}>Start</Button>
        <Button icon={<Stop20Regular />} disabled={!boundPipelineId || busy === 'stop'} onClick={stopPipeline}>Stop</Button>
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="design" icon={<Stream20Regular />}>Design</Tab>
        <Tab value="sql" icon={<Code20Regular />}>SQL</Tab>
        <Tab value="runs" icon={<ArrowClockwise20Regular />}>Run history</Tab>
        <Tab value="events" icon={<Notebook20Regular />}>Event log</Tab>
      </TabList>

      {tab === 'design' && (
        <>
          <div className={s.palette}>
            <Caption1>Add:</Caption1>
            <Button size="small" icon={<Database20Regular />} onClick={() => addNode('source')}>Source</Button>
            <Button size="small" icon={<Stream20Regular />} onClick={() => addNode('streaming_table')}>Streaming table</Button>
            <Button size="small" icon={<Table20Regular />} onClick={() => addNode('materialized_view')}>Materialized view</Button>
            <Button size="small" icon={<CheckmarkCircle20Regular />} onClick={() => addNode('expectation')}>Expectation</Button>
          </div>
          <SplitPane
            direction="horizontal"
            primary="second"
            storageKey="databricks-pipeline.inspector"
            defaultSize={360}
            minSize={300}
            maxSize={640}
            dividerLabel="Resize inspector"
          >
            <ResizableCanvasRegion
              storageKey="databricks-dlt-pipeline"
              defaultPx={520}
              minPx={320}
              ariaLabel="Resize DLT pipeline canvas height"
              className={s.canvasWrap}
            >
              <ReactFlowProvider>
                <ReactFlow
                  nodes={flowNodes}
                  edges={flowEdges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onNodeDragStop={onNodeDragStop}
                  onNodeClick={(_, n) => setSelectedId(n.id)}
                  onPaneClick={() => setSelectedId(null)}
                  fitView
                  // maxZoom keeps a small 3-6 node graph filling the canvas readably on open.
                  fitViewOptions={{ padding: 0.2, maxZoom: 1.25 }}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background
                    variant={BackgroundVariant.Dots}
                    gap={18}
                    size={1.5}
                    color={accentTint('var(--loom-accent-blue)', 45)}
                  />
                  <CanvasRailPanel />
                  <MiniMap
                    pannable
                    zoomable
                    nodeColor={(n) => (n.data as DltNodeData)?.visual?.accent}
                    nodeStrokeColor={tokens.colorNeutralStroke2}
                    maskColor={accentTint(tokens.colorNeutralBackground3, 70)}
                    style={{ backgroundColor: tokens.colorNeutralBackground1 }}
                  />
                  {model.nodes.length === 0 && (
                    <Panel position="top-center">
                      <Caption1>Add a Source, then a Streaming table or Materialized view, and wire them together.</Caption1>
                    </Panel>
                  )}
                </ReactFlow>
              </ReactFlowProvider>
            </ResizableCanvasRegion>

            <div className={s.inspector}>
              {selectedNode
                ? <NodeInspector node={selectedNode} onPatch={(p) => patchNode(selectedNode.id, p)} onDelete={() => deleteNode(selectedNode.id)} />
                : <PipelineSettings model={model} onPatch={(p) => commit({ ...model, ...p })} problems={problems} />}
            </div>
          </SplitPane>
        </>
      )}

      {tab === 'sql' && (
        <div>
          <Body1>Compiled DLT SQL (read-only — edit on the canvas). This is imported as the pipeline&apos;s notebook library.</Body1>
          <pre className={s.code} aria-label="Compiled DLT SQL definition">{compiledSql}</pre>
        </div>
      )}

      {tab === 'runs' && (
        <div className={s.panelScroll}>
          <div className={s.row}>
            <Button size="small" icon={<ArrowClockwise20Regular />} onClick={() => void loadUpdates()}>Refresh</Button>
          </div>
          {updates.length === 0
            ? <Caption1>No updates yet. Start the pipeline to run one.</Caption1>
            : (
              <Table size="small" aria-label="Run history">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Update</TableHeaderCell>
                    <TableHeaderCell>State</TableHeaderCell>
                    <TableHeaderCell>Full refresh</TableHeaderCell>
                    <TableHeaderCell>Created</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {updates.map((u) => (
                    <TableRow key={u.update_id}>
                      <TableCell>{u.update_id}</TableCell>
                      <TableCell><Badge appearance="tint" color={/COMPLET/i.test(u.state || '') ? 'success' : /FAIL/i.test(u.state || '') ? 'danger' : 'brand'}>{u.state || '—'}</Badge></TableCell>
                      <TableCell>{u.full_refresh ? 'yes' : 'no'}</TableCell>
                      <TableCell>{u.creation_time ? new Date(u.creation_time).toLocaleString() : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </div>
      )}

      {tab === 'events' && (
        <div className={s.panelScroll}>
          <div className={s.row}>
            <Button size="small" icon={<ArrowClockwise20Regular />} onClick={() => void loadEvents()}>Refresh</Button>
          </div>
          {events.length === 0
            ? <Caption1>No events yet. Start the pipeline to populate the event log.</Caption1>
            : (
              <Table size="small" aria-label="Event log">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Level</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Message</TableHeaderCell>
                    <TableHeaderCell>Data quality</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <span className={mergeClasses(/ERROR/i.test(e.level || '') ? s.evtError : /WARN/i.test(e.level || '') ? s.evtWarn : s.evtInfo)}>
                          {e.level || 'INFO'}
                        </span>
                      </TableCell>
                      <TableCell>{e.event_type || '—'}</TableCell>
                      <TableCell>{e.message || '—'}</TableCell>
                      <TableCell>{formatDataQuality(e.details)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector panels
// ---------------------------------------------------------------------------

/** Summarise expectation pass/fail counts from a flow_progress event, if present. */
function formatDataQuality(details?: Record<string, unknown>): string {
  const fp = (details as any)?.flow_progress;
  const dq = fp?.data_quality;
  const exps = dq?.expectations as Array<{ name?: string; passed_records?: number; failed_records?: number }> | undefined;
  if (!Array.isArray(exps) || exps.length === 0) return '—';
  return exps
    .map((x) => `${x.name || 'expectation'}: ${x.passed_records ?? 0} pass / ${x.failed_records ?? 0} fail`)
    .join('; ');
}

function PipelineSettings({
  model, onPatch, problems,
}: {
  model: DltPipelineModel;
  onPatch: (p: Partial<DltPipelineModel>) => void;
  problems: string[];
}) {
  const s = useStyles();
  return (
    <>
      <Subtitle2>Pipeline settings</Subtitle2>
      <Field label="Target catalog (Unity Catalog)">
        <Input value={model.catalog ?? ''} onChange={(_, d) => onPatch({ catalog: d.value })} placeholder="main" />
      </Field>
      <Field label="Target schema">
        <Input value={model.target ?? ''} onChange={(_, d) => onPatch({ target: d.value })} placeholder="bronze" />
      </Field>
      <Field label="Runtime channel">
        <Dropdown
          selectedOptions={[model.channel]}
          value={model.channel}
          onOptionSelect={(_, d) => onPatch({ channel: (d.optionValue as DltChannel) || 'CURRENT' })}
        >
          <Option value="CURRENT">CURRENT</Option>
          <Option value="PREVIEW">PREVIEW</Option>
        </Dropdown>
      </Field>
      <Switch checked={model.continuous} onChange={(_, d) => onPatch({ continuous: d.checked })}
        label={model.continuous ? 'Continuous (streaming)' : 'Triggered'} />
      <Switch checked={model.serverless} onChange={(_, d) => onPatch({ serverless: d.checked })} label="Serverless compute" />
      <Switch checked={model.photon} onChange={(_, d) => onPatch({ photon: d.checked })} label="Photon engine" />
      <Switch checked={model.development} onChange={(_, d) => onPatch({ development: d.checked })}
        label={model.development ? 'Development mode' : 'Production mode'} />

      {problems.length > 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Fix before creating</MessageBarTitle>
            <div className={s.problems}>
              {problems.map((p, i) => <Caption1 key={i}>• {p}</Caption1>)}
            </div>
          </MessageBarBody>
        </MessageBar>
      )}
    </>
  );
}

function NodeInspector({
  node, onPatch, onDelete,
}: {
  node: DltNode;
  onPatch: (p: Partial<DltNode>) => void;
  onDelete: () => void;
}) {
  const meta = KIND_META[node.kind];
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Subtitle2>{meta.typeLabel}</Subtitle2>
        <Tooltip content="Delete node" relationship="label">
          <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Delete node" onClick={onDelete} />
        </Tooltip>
      </div>

      {isSource(node) && <SourceForm node={node} onPatch={onPatch as (p: Partial<DltSourceNode>) => void} />}
      {isDataset(node) && <DatasetForm node={node} onPatch={onPatch as (p: Partial<DltDatasetNode>) => void} />}
      {isExpectation(node) && <ExpectationForm node={node} onPatch={onPatch as (p: Partial<DltExpectationNode>) => void} />}
    </>
  );
}

function SourceForm({ node, onPatch }: { node: DltSourceNode; onPatch: (p: Partial<DltSourceNode>) => void }) {
  return (
    <>
      <Field label="Source alias">
        <Input value={node.name} onChange={(_, d) => onPatch({ name: d.value })} />
      </Field>
      <Field label="Source kind">
        <Dropdown
          selectedOptions={[node.sourceKind]}
          value={node.sourceKind === 'files' ? 'Auto Loader files' : 'Table stream'}
          onOptionSelect={(_, d) => onPatch({ sourceKind: (d.optionValue as 'files' | 'table') })}
        >
          <Option value="files" text="Auto Loader files">Auto Loader files (read_files)</Option>
          <Option value="table" text="Table stream">Unity Catalog table stream</Option>
        </Dropdown>
      </Field>
      {node.sourceKind === 'files' ? (
        <>
          <Field label="Path (abfss:// or /Volumes/...)">
            <Input value={node.path ?? ''} onChange={(_, d) => onPatch({ path: d.value })} placeholder="abfss://raw@acct.dfs.core.windows.net/events/" />
          </Field>
          <Field label="File format">
            <Dropdown
              selectedOptions={[node.fileFormat ?? 'json']}
              value={node.fileFormat ?? 'json'}
              onOptionSelect={(_, d) => onPatch({ fileFormat: (d.optionValue as DltFileFormat) })}
            >
              {DLT_FILE_FORMATS.map((f) => <Option key={f} value={f}>{f}</Option>)}
            </Dropdown>
          </Field>
        </>
      ) : (
        <Field label="Table (catalog.schema.table)">
          <Input value={node.tableName ?? ''} onChange={(_, d) => onPatch({ tableName: d.value })} placeholder="main.bronze.events" />
        </Field>
      )}
    </>
  );
}

function DatasetForm({ node, onPatch }: { node: DltDatasetNode; onPatch: (p: Partial<DltDatasetNode>) => void }) {
  return (
    <>
      <Field label="Name">
        <Input value={node.name} onChange={(_, d) => onPatch({ name: d.value })} />
      </Field>
      <Field label="Comment (optional)">
        <Input value={node.comment ?? ''} onChange={(_, d) => onPatch({ comment: d.value })} />
      </Field>
      <Field label="Query (optional — leave blank to auto-generate SELECT * from the wired source)"
        hint="A SQL SELECT body. Reference upstream datasets by name.">
        <Textarea
          value={node.query ?? ''}
          onChange={(_, d) => onPatch({ query: d.value })}
          resize="vertical"
          rows={4}
          aria-label="Dataset SELECT query"
          placeholder="SELECT id, ts, payload FROM STREAM source"
        />
      </Field>
    </>
  );
}

function ExpectationForm({ node, onPatch }: { node: DltExpectationNode; onPatch: (p: Partial<DltExpectationNode>) => void }) {
  return (
    <>
      <Field label="Constraint name">
        <Input value={node.name} onChange={(_, d) => onPatch({ name: d.value })} placeholder="valid_id" />
      </Field>
      <Field label="Condition (boolean SQL expression)">
        <Textarea
          value={node.condition}
          onChange={(_, d) => onPatch({ condition: d.value })}
          resize="vertical"
          rows={2}
          aria-label="Expectation condition expression"
          placeholder="id IS NOT NULL"
        />
      </Field>
      <Field label="On violation">
        <Dropdown
          selectedOptions={[node.action]}
          value={node.action}
          onOptionSelect={(_, d) => onPatch({ action: (d.optionValue as DltExpectationAction) })}
        >
          <Option value="warn" text="warn">warn (record + keep)</Option>
          <Option value="drop" text="drop">drop row</Option>
          <Option value="fail" text="fail">fail update</Option>
        </Dropdown>
      </Field>
    </>
  );
}
