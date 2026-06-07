/**
 * CSA Loom — Eventstream visual designer
 *
 * Renders the Eventstream pipeline as a left→right flow of node cards:
 *   [Source 1]  ┐
 *   [Source 2]  ┼─► [Transform 1] ──► [Transform 2] ──► [Sink]
 *
 * Operators click "Add source", "Add transform", "Add destination" in the
 * editor ribbon (or in the canvas itself) to grow the graph. Selecting a
 * node opens an inline form on the right that edits real config keys
 * (eventhub namespace, kusto table, filter expression, etc.) — no JSON
 * editing required for the common path. The Save action serializes back
 * to the same { source, transforms[], sink } shape that the BFF persists
 * to Cosmos, so the visual designer is wire-compatible with the existing
 * /api/items/eventstream/[id] route.
 *
 * Per no-vaporware.md: no mock arrays. The config is real Cosmos state.
 * The runtime (Event Hubs → Kusto ingestion executor) is gated by a
 * MessageBar in the parent editor; this component does NOT pretend to
 * publish.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  useReactFlow, useNodesState,
  type Node, type Edge, type NodeChange, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Button,
  Badge,
  Caption1,
  Body1,
  Input,
  Dropdown,
  Option,
  Label,
  Field,
  SpinButton,
  Divider,
  Spinner,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  tokens,
  makeStyles,
  shorthands,
} from '@fluentui/react-components';
import {
  Add20Regular,
  Delete20Regular,
  Copy16Regular,
  Send20Regular,
  Eye20Regular,
  Settings20Regular,
} from '@fluentui/react-icons';
import { EventstreamFlowNode, type EsNodeData, type NodeRole } from './eventstream-flow-node';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  compileToSaql,
  type SourceKind,
  type TransformKind,
  type SinkKind,
  type AggregateSpec,
  type AsaAggregateFunc,
  type AsaWindowType,
  type AsaWindowUnit,
  type AsaJoinType,
  type SourceNode,
  type ProvisionedEndpoint,
  type TransformNode,
  type SinkNode,
  type PipelineConfig,
} from '@/lib/azure/asa-query-compiler';

// ============================================================
// Types — node shapes live in the SAQL compiler module (re-exported here so
// existing importers of '@/lib/components/eventstream/visual-designer' keep
// working). The compiler is the single source of truth for the transform
// model so the guided builder and the generated SAQL never drift.
// ============================================================

export type {
  SourceKind,
  TransformKind,
  SinkKind,
  AggregateSpec,
  AsaAggregateFunc,
  AsaWindowType,
  AsaWindowUnit,
  AsaJoinType,
  SourceNode,
  ProvisionedEndpoint,
  TransformNode,
  SinkNode,
  PipelineConfig,
};

export type SelectedNode =
  | { type: 'source'; idx: number }
  | { type: 'transform'; idx: number }
  | { type: 'sink'; idx: number }
  | null;

// ============================================================
// Styles
// ============================================================

const useStyles = makeStyles({
  designer: {
    display: 'grid',
    gridTemplateColumns: '1fr 320px',
    gap: tokens.spacingHorizontalL,
    minHeight: '480px',
  },
  canvas: {
    position: 'relative',
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    overflow: 'hidden',
    minHeight: '440px',
  },
  addButtonsPanel: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalXS),
  },
  emptyHint: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    color: tokens.colorNeutralForeground3,
    zIndex: 1,
  },
  inspector: {
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minHeight: '440px',
  },
  inspectorEmpty: {
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
  addButtons: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalM,
  },
  endpointCard: {
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  endpointRow: {
    display: 'grid',
    gridTemplateColumns: '92px 1fr auto',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  endpointValue: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    wordBreak: 'break-all',
    color: tokens.colorNeutralForeground1,
  },
  wizardActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  eventTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: tokens.fontSizeBase200,
  },
});

// ============================================================
// Component
// ============================================================

export interface VisualDesignerProps {
  config: PipelineConfig;
  onChange: (next: PipelineConfig) => void;
  /**
   * The Cosmos eventstream item id. Required for source-node provisioning +
   * live-event preview (the wizard POSTs to /api/items/eventstream/[itemId]/…).
   * Absent on the pre-save `/new` surface, where provisioning is hidden.
   */
  itemId?: string;
}

function normalizeSources(c: PipelineConfig): SourceNode[] {
  if (Array.isArray(c.sources) && c.sources.length) return c.sources;
  if (c.source) return [c.source];
  return [];
}

function normalizeSinks(c: PipelineConfig): SinkNode[] {
  if (Array.isArray(c.sinks) && c.sinks.length) return c.sinks;
  if (c.sink) return [c.sink];
  return [];
}

export function VisualDesigner({ config, onChange, itemId }: VisualDesignerProps) {
  const s = useStyles();
  const [selected, setSelected] = useState<SelectedNode>(null);

  const sources = useMemo(() => normalizeSources(config), [config]);
  const sinks = useMemo(() => normalizeSinks(config), [config]);
  const transforms = config.transforms || [];

  const commit = useCallback(
    (next: Partial<PipelineConfig>) => {
      onChange({
        sources,
        transforms,
        sinks,
        // legacy projection
        source: sources[0],
        sink: sinks[0],
        ...next,
      });
    },
    [onChange, sources, transforms, sinks],
  );

  // ---- Add ----
  const addSource = useCallback(() => {
    const next: SourceNode = {
      kind: 'eventhub',
      name: `source-${sources.length + 1}`,
      namespace: '',
      consumerGroup: '$Default',
    };
    const updated = [...sources, next];
    commit({ sources: updated, source: updated[0] });
    setSelected({ type: 'source', idx: updated.length - 1 });
  }, [sources, commit]);

  const addTransform = useCallback(() => {
    const next: TransformNode = {
      kind: 'filter',
      name: `transform-${transforms.length + 1}`,
      expression: '',
    };
    const updated = [...transforms, next];
    commit({ transforms: updated });
    setSelected({ type: 'transform', idx: updated.length - 1 });
  }, [transforms, commit]);

  const addSink = useCallback(() => {
    const next: SinkNode = {
      kind: 'kusto',
      name: `sink-${sinks.length + 1}`,
      database: 'loomdb-default',
      table: '',
    };
    const updated = [...sinks, next];
    commit({ sinks: updated, sink: updated[0] });
    setSelected({ type: 'sink', idx: updated.length - 1 });
  }, [sinks, commit]);

  // ---- Update node ----
  const updateSource = useCallback(
    (idx: number, patch: Partial<SourceNode>) => {
      const updated = sources.map((n, i) => (i === idx ? { ...n, ...patch } : n));
      commit({ sources: updated, source: updated[0] });
    },
    [sources, commit],
  );
  const updateTransform = useCallback(
    (idx: number, patch: Partial<TransformNode>) => {
      const updated = transforms.map((n, i) => (i === idx ? { ...n, ...patch } : n));
      commit({ transforms: updated });
    },
    [transforms, commit],
  );
  const updateSink = useCallback(
    (idx: number, patch: Partial<SinkNode>) => {
      const updated = sinks.map((n, i) => (i === idx ? { ...n, ...patch } : n));
      commit({ sinks: updated, sink: updated[0] });
    },
    [sinks, commit],
  );

  // ---- Delete ----
  const deleteSelected = useCallback(() => {
    if (!selected) return;
    if (selected.type === 'source') {
      const updated = sources.filter((_, i) => i !== selected.idx);
      commit({ sources: updated, source: updated[0] });
    } else if (selected.type === 'transform') {
      const updated = transforms.filter((_, i) => i !== selected.idx);
      commit({ transforms: updated });
    } else if (selected.type === 'sink') {
      const updated = sinks.filter((_, i) => i !== selected.idx);
      commit({ sinks: updated, sink: updated[0] });
    }
    setSelected(null);
  }, [selected, sources, transforms, sinks, commit]);

  // ============================================================
  // Render
  // ============================================================

  return (
    <div className={s.designer} role="region" aria-label="Eventstream visual designer">
      <EventstreamCanvas
        sources={sources}
        transforms={transforms}
        sinks={sinks}
        selected={selected}
        onSelect={setSelected}
        onAddSource={addSource}
        onAddTransform={addTransform}
        onAddSink={addSink}
      />

      <aside className={s.inspector} aria-label="Node properties">
        {!selected && (
          <Caption1 className={s.inspectorEmpty}>
            Select a node to edit its properties, or click Add source / Add transform / Add
            destination to grow the pipeline.
          </Caption1>
        )}

        {selected?.type === 'source' && sources[selected.idx] && (
          <SourceInspector
            value={sources[selected.idx]}
            nodeIdx={selected.idx}
            itemId={itemId}
            onChange={(patch) => updateSource(selected.idx, patch)}
            onDelete={deleteSelected}
          />
        )}

        {selected?.type === 'transform' && transforms[selected.idx] && (
          <AsaTransformInspector
            value={transforms[selected.idx]}
            sources={sources}
            onChange={(patch) => updateTransform(selected.idx, patch)}
            onDelete={deleteSelected}
          />
        )}

        {selected?.type === 'sink' && sinks[selected.idx] && (
          <SinkInspector
            value={sinks[selected.idx]}
            onChange={(patch) => updateSink(selected.idx, patch)}
            onDelete={deleteSelected}
          />
        )}
      </aside>
    </div>
  );
}

// ============================================================
// React Flow canvas — free-form, draggable, Bezier-connected, matching
// Fabric's real Eventstream editor (source → operator → destination).
// ============================================================

const esNodeTypes: NodeTypes = { es: EventstreamFlowNode };

interface XY { x: number; y: number }
const ES_NODE_W = 184;
const COL_GAP = 230;
const ROW_GAP = 96;

function esLayout(nSources: number, transforms: number, nSinks: number): Map<string, XY> {
  const pos = new Map<string, XY>();
  const sinkCol = transforms + 1;
  for (let i = 0; i < nSources; i++) pos.set(`source-${i}`, { x: 16, y: 16 + i * ROW_GAP });
  for (let i = 0; i < transforms; i++) pos.set(`transform-${i}`, { x: 16 + (i + 1) * COL_GAP, y: 16 });
  for (let i = 0; i < nSinks; i++) pos.set(`sink-${i}`, { x: 16 + sinkCol * COL_GAP, y: 16 + i * ROW_GAP });
  return pos;
}

interface EventstreamCanvasProps {
  sources: SourceNode[];
  transforms: TransformNode[];
  sinks: SinkNode[];
  selected: SelectedNode;
  onSelect: (n: SelectedNode) => void;
  onAddSource: () => void;
  onAddTransform: () => void;
  onAddSink: () => void;
}

function EventstreamCanvasInner({
  sources, transforms, sinks, selected, onSelect,
  onAddSource, onAddTransform, onAddSink,
}: EventstreamCanvasProps) {
  const s = useStyles();
  const rf = useReactFlow();
  const positionsRef = useRef<Map<string, XY>>(new Map());
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);

  const total = sources.length + transforms.length + sinks.length;

  const syncNodes = useCallback(() => {
    const fallback = esLayout(sources.length, transforms.length, sinks.length);
    const next = new Map<string, XY>();
    const list: Node[] = [];
    const push = (id: string, data: EsNodeData, isSel: boolean) => {
      const p = positionsRef.current.get(id) || fallback.get(id) || { x: 16, y: 16 };
      next.set(id, p);
      list.push({ id, type: 'es', position: p, data: data as unknown as Record<string, unknown>, selected: isSel });
    };
    sources.forEach((n, i) => push(`source-${i}`,
      { label: n.name, kind: n.kind, role: 'source' as NodeRole, subtitle: n.namespace || n.iotHub },
      selected?.type === 'source' && selected.idx === i));
    transforms.forEach((n, i) => push(`transform-${i}`,
      { label: n.name, kind: n.kind, role: 'transform' as NodeRole, subtitle: n.expression ? (n.expression.length > 28 ? n.expression.slice(0, 28) + '…' : n.expression) : undefined },
      selected?.type === 'transform' && selected.idx === i));
    sinks.forEach((n, i) => push(`sink-${i}`,
      { label: n.name, kind: n.kind, role: 'sink' as NodeRole, subtitle: n.table || n.lakehouseId },
      selected?.type === 'sink' && selected.idx === i));
    positionsRef.current = next;
    setNodes(list);
  }, [sources, transforms, sinks, selected, setNodes]);

  useEffect(() => { syncNodes(); }, [syncNodes]);

  // Derived topology edges (Bezier = React Flow default edge type). The
  // persisted model is { sources, transforms[], sink } ordered, so edges
  // reflect that flow: sources → transform chain → sinks.
  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    const stroke = tokens.colorBrandStroke1;
    const mk = (a: string, b: string) => out.push({
      id: `${a}->${b}`, source: a, target: b, type: 'default',
      style: { stroke, strokeWidth: 1.8 },
      markerEnd: { type: 'arrowclosed' as any, color: stroke, width: 16, height: 16 },
    });
    if (transforms.length) {
      sources.forEach((_, i) => mk(`source-${i}`, 'transform-0'));
      for (let i = 0; i < transforms.length - 1; i++) mk(`transform-${i}`, `transform-${i + 1}`);
      sinks.forEach((_, j) => mk(`transform-${transforms.length - 1}`, `sink-${j}`));
    } else {
      sources.forEach((_, i) => sinks.forEach((_, j) => mk(`source-${i}`, `sink-${j}`)));
    }
    return out;
  }, [sources, transforms, sinks]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes);
    for (const c of changes) if (c.type === 'position' && c.position) positionsRef.current.set(c.id, c.position);
  }, [onNodesChange]);

  const handleNodeClick = useCallback((_: unknown, n: Node) => {
    const [role, idx] = n.id.split('-');
    onSelect({ type: role as 'source' | 'transform' | 'sink', idx: Number(idx) });
  }, [onSelect]);

  return (
    <div className={s.canvas} data-canvas="eventstream" aria-label="Eventstream canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={esNodeTypes}
        onNodesChange={handleNodesChange}
        onNodeClick={handleNodeClick}
        onPaneClick={() => onSelect(null)}
        minZoom={0.3}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tokens.colorNeutralStroke2} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable style={{ backgroundColor: tokens.colorNeutralBackground1 }} />
        <Panel position="top-left">
          <div className={s.addButtonsPanel} data-palette="eventstream" role="toolbar" aria-label="Node palette">
            <Button size="small" icon={<Add20Regular />} onClick={onAddSource} data-palette-item="source">Add source</Button>
            <Button size="small" icon={<Add20Regular />} onClick={onAddTransform} data-palette-item="transform">Add transform</Button>
            <Button size="small" icon={<Add20Regular />} onClick={onAddSink} data-palette-item="destination">Add destination</Button>
          </div>
        </Panel>
      </ReactFlow>
      {total === 0 && (
        <div className={s.emptyHint}>
          <Caption1>Click “Add source”, then “Add transform” / “Add destination” to build the stream.</Caption1>
        </div>
      )}
    </div>
  );
}

function EventstreamCanvas(props: EventstreamCanvasProps) {
  return (
    <ReactFlowProvider>
      <EventstreamCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

// ============================================================
// Inspector components
// ============================================================

function SourceInspector({
  value,
  nodeIdx,
  itemId,
  onChange,
  onDelete,
}: {
  value: SourceNode;
  nodeIdx: number;
  itemId?: string;
  onChange: (p: Partial<SourceNode>) => void;
  onDelete: () => void;
}) {
  const s = useStyles();
  const endpoint = value.provisionedEndpoint;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [sendMsg, setSendMsg] = useState<string | null>(null);
  // Live preview state.
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewEvents, setPreviewEvents] = useState<ReceivedEventRow[] | null>(null);
  const [previewGate, setPreviewGate] = useState<string | null>(null);

  const noProvision = value.kind === 'sample';

  const copy = useCallback((text?: string) => {
    if (text && typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text).catch(() => { /* clipboard may be blocked */ });
    }
  }, []);

  const provision = useCallback(async () => {
    if (!itemId) { setErr('Save the eventstream first — provisioning needs a persisted item id.'); return; }
    setBusy(true); setErr(null); setHint(null);
    try {
      const r = await fetch(`/api/items/eventstream/${itemId}/source`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeIdx, kind: value.kind, config: value }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error || (j.missing ? `Not configured: ${j.missing}` : 'provision failed'));
        setHint(j.hint || null);
        return;
      }
      setHint(j.hint || null);
      onChange({ provisionedEndpoint: j.endpoint, ...(j.adf?.pipelineName ? { cdcAdfPipelineName: j.adf.pipelineName } : {}) });
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [itemId, nodeIdx, value, onChange]);

  const sendTest = useCallback(async () => {
    if (!itemId) return;
    setSendMsg('Sending test event…'); setErr(null);
    try {
      const r = await fetch(`/api/items/eventstream/${itemId}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeIdx }),
      });
      const j = await r.json();
      setSendMsg(j.ok ? `Sent ${j.sent} test event (HTTP ${j.status}).` : `Send failed: ${j.error || 'unknown'}`);
    } catch (e: any) {
      setSendMsg(`Send failed: ${e?.message || e}`);
    }
  }, [itemId, nodeIdx]);

  const previewEventsFetch = useCallback(async () => {
    if (!itemId) return;
    setPreviewBusy(true); setPreviewGate(null); setPreviewEvents(null); setErr(null);
    try {
      const r = await fetch(`/api/items/eventstream/${itemId}/events?nodeIdx=${nodeIdx}&maxEvents=20`);
      const j = await r.json();
      if (j.ok) {
        setPreviewEvents(Array.isArray(j.events) ? j.events : []);
      } else if (j.code === 'receive_unavailable') {
        setPreviewGate(j.hint || j.error || 'Live receive is not enabled in this deployment.');
      } else {
        setErr(j.error || 'preview failed');
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setPreviewBusy(false);
    }
  }, [itemId, nodeIdx]);

  return (
    <>
      <Label weight="semibold">Source</Label>
      <Field label="Name">
        <Input value={value.name} onChange={(_: unknown, d: any) => onChange({ name: d.value })} />
      </Field>
      <Field label="Kind">
        <Dropdown
          value={kindLabel(value.kind)}
          selectedOptions={[value.kind]}
          onOptionSelect={(_: unknown, d: any) => onChange({ kind: (d.optionValue as SourceKind) || 'eventhub', provisionedEndpoint: undefined })}
        >
          <Option value="eventhub">Event Hubs</Option>
          <Option value="iothub">IoT Hub</Option>
          <Option value="kafka">Kafka</Option>
          <Option value="cdc-mirror">CDC (database change feed)</Option>
          <Option value="custom-app">Custom app (provision Event Hub)</Option>
          <Option value="sample">Sample data</Option>
        </Dropdown>
      </Field>

      {/* ── kind-specific configuration ─────────────────────────────── */}
      {value.kind === 'eventhub' && (
        <>
          <Field label="Namespace" hint="Bare name or FQDN; resolves to the Event Hubs data-plane host.">
            <Input value={value.namespace || ''} placeholder="my-eventhub-ns"
              onChange={(_: unknown, d: any) => onChange({ namespace: d.value })} />
          </Field>
          <Field label="Event Hub name" required>
            <Input value={value.eventHubName || ''} placeholder="orders-hub"
              onChange={(_: unknown, d: any) => onChange({ eventHubName: d.value })} />
          </Field>
          <Field label="Consumer group">
            <Input value={value.consumerGroup || '$Default'}
              onChange={(_: unknown, d: any) => onChange({ consumerGroup: d.value })} />
          </Field>
        </>
      )}
      {value.kind === 'iothub' && (
        <>
          <Field label="IoT Hub name" required>
            <Input value={value.iotHub || ''} placeholder="my-iot-hub"
              onChange={(_: unknown, d: any) => onChange({ iotHub: d.value })} />
          </Field>
          <Field label="Resource group" hint="Optional — defaults to the Loom landing-zone RG.">
            <Input value={value.iotHubResourceGroup || ''}
              onChange={(_: unknown, d: any) => onChange({ iotHubResourceGroup: d.value })} />
          </Field>
          <Field label="Consumer group">
            <Input value={value.consumerGroup || '$Default'}
              onChange={(_: unknown, d: any) => onChange({ consumerGroup: d.value })} />
          </Field>
        </>
      )}
      {value.kind === 'kafka' && (
        <>
          <Field label="Topic" required hint="Maps to an Event Hub entity on the Kafka endpoint (port 9093).">
            <Input value={value.topic || ''} placeholder="telemetry"
              onChange={(_: unknown, d: any) => onChange({ topic: d.value })} />
          </Field>
          <Field label="Consumer group">
            <Input value={value.consumerGroup || '$Default'}
              onChange={(_: unknown, d: any) => onChange({ consumerGroup: d.value })} />
          </Field>
        </>
      )}
      {value.kind === 'cdc-mirror' && (
        <>
          <Field label="Database type">
            <Dropdown
              value={cdcLabel(value.cdcDatabaseType)}
              selectedOptions={[value.cdcDatabaseType || 'sqlserver']}
              onOptionSelect={(_: unknown, d: any) => onChange({ cdcDatabaseType: (d.optionValue as any) || 'sqlserver' })}
            >
              <Option value="sqlserver">SQL Server</Option>
              <Option value="postgresql">PostgreSQL</Option>
              <Option value="mysql">MySQL</Option>
              <Option value="cosmosdb">Cosmos DB</Option>
            </Dropdown>
          </Field>
          <Field label="Server host" required>
            <Input value={value.cdcServerHost || ''} placeholder="sql.contoso.com"
              onChange={(_: unknown, d: any) => onChange({ cdcServerHost: d.value })} />
          </Field>
          <Field label="Database" required>
            <Input value={value.cdcDatabase || ''} placeholder="sales"
              onChange={(_: unknown, d: any) => onChange({ cdcDatabase: d.value })} />
          </Field>
          <Field label="Table" required>
            <Input value={value.cdcTable || ''} placeholder="dbo.Orders"
              onChange={(_: unknown, d: any) => onChange({ cdcTable: d.value })} />
          </Field>
          <Field label="Username">
            <Input value={value.cdcUsername || ''}
              onChange={(_: unknown, d: any) => onChange({ cdcUsername: d.value })} />
          </Field>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            The source password is stored as a Key Vault secret on the ADF factory (set it once after the pipeline is created). CDC decodes change events into an Event Hub the stream reads.
          </Caption1>
        </>
      )}
      {value.kind === 'custom-app' && (
        <Field label="Event Hub name" required hint="A dedicated Event Hub is provisioned for your app to push events into.">
          <Input value={value.eventHubName || ''} placeholder={`custom-${value.name}`}
            onChange={(_: unknown, d: any) => onChange({ eventHubName: d.value })} />
        </Field>
      )}
      {value.kind === 'sample' && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Sample data needs no ingest endpoint — the stream runtime generates events for testing.
        </Caption1>
      )}

      {/* ── provision action ────────────────────────────────────────── */}
      {!noProvision && (
        <div className={s.wizardActions}>
          <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Settings20Regular />}
            disabled={busy || !itemId} onClick={provision}>
            {busy ? 'Provisioning…' : (endpoint ? 'Reconfigure' : 'Provision endpoint')}
          </Button>
        </div>
      )}
      {!itemId && !noProvision && (
        <MessageBar intent="warning">
          <MessageBarBody>Save the eventstream to enable source provisioning.</MessageBarBody>
        </MessageBar>
      )}
      {err && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not provision</MessageBarTitle>
            {err}{hint ? <><br /><Caption1>{hint}</Caption1></> : null}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* ── provisioned endpoint card ───────────────────────────────── */}
      {endpoint && (
        <div className={s.endpointCard} data-testid="source-endpoint">
          <Body1>Ingest endpoint</Body1>
          {endpoint.fqdn && (
            <div className={s.endpointRow}>
              <Caption1>FQDN</Caption1>
              <span className={s.endpointValue}>{endpoint.fqdn}</span>
              <Button size="small" appearance="subtle" icon={<Copy16Regular />} aria-label="Copy FQDN" onClick={() => copy(endpoint.fqdn)} />
            </div>
          )}
          {endpoint.entityPath && (
            <div className={s.endpointRow}>
              <Caption1>Entity</Caption1>
              <span className={s.endpointValue}>{endpoint.entityPath}</span>
              <Button size="small" appearance="subtle" icon={<Copy16Regular />} aria-label="Copy entity path" onClick={() => copy(endpoint.entityPath)} />
            </div>
          )}
          {endpoint.kafkaBootstrap && (
            <div className={s.endpointRow}>
              <Caption1>Kafka</Caption1>
              <span className={s.endpointValue}>{endpoint.kafkaBootstrap}</span>
              <Button size="small" appearance="subtle" icon={<Copy16Regular />} aria-label="Copy Kafka bootstrap" onClick={() => copy(endpoint.kafkaBootstrap)} />
            </div>
          )}
          <div className={s.endpointRow}>
            <Caption1>Auth</Caption1>
            <span className={s.endpointValue}>
              {endpoint.auth === 'sas' ? 'SAS connection string' : 'Microsoft Entra (bearer token)'}
            </span>
            <span />
          </div>
          {endpoint.connectionString && (
            <div className={s.endpointRow}>
              <Caption1>Conn string</Caption1>
              <span className={s.endpointValue}>{maskConn(endpoint.connectionString)}</span>
              <Button size="small" appearance="subtle" icon={<Copy16Regular />} aria-label="Copy connection string" onClick={() => copy(endpoint.connectionString || '')} />
            </div>
          )}
          {endpoint.localAuthDisabled && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Connection strings are disabled (disableLocalAuth: true). Push events over the HTTPS REST data plane with an Entra token, or Kafka OAUTHBEARER.
            </Caption1>
          )}

          <div className={s.wizardActions}>
            <Button size="small" appearance="outline" icon={<Send20Regular />} onClick={sendTest} disabled={!itemId}>Send test event</Button>
            <Button size="small" appearance="outline" icon={previewBusy ? <Spinner size="tiny" /> : <Eye20Regular />} onClick={previewEventsFetch} disabled={!itemId || previewBusy}>
              {previewBusy ? 'Previewing…' : 'Preview events'}
            </Button>
          </div>
          {sendMsg && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{sendMsg}</Caption1>}
          {hint && !err && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{hint}</Caption1>}

          {previewGate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Live preview not enabled</MessageBarTitle>
                {previewGate} Sending test events works today.
              </MessageBarBody>
            </MessageBar>
          )}
          {previewEvents && previewEvents.length === 0 && !previewGate && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No recent events on this partition.</Caption1>
          )}
          {previewEvents && previewEvents.length > 0 && (
            <table className={s.eventTable} aria-label="Live event preview">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Partition</th>
                  <th style={{ textAlign: 'left' }}>Enqueued</th>
                  <th style={{ textAlign: 'left' }}>Body</th>
                </tr>
              </thead>
              <tbody>
                {previewEvents.map((ev, i) => (
                  <tr key={i}>
                    <td>{ev.partitionId ?? '—'}</td>
                    <td>{ev.enqueuedTime ?? '—'}</td>
                    <td className={s.endpointValue}>{previewBody(ev.body)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <Button
        icon={<Delete20Regular />}
        appearance="subtle"
        onClick={onDelete}
        style={{ marginTop: 'auto' }}
      >
        Remove source
      </Button>
    </>
  );
}

// ---- small helpers shared by the guided transform builder ----
const TRANSFORM_KINDS: { value: TransformKind; label: string }[] = [
  { value: 'filter', label: 'Filter' },
  { value: 'aggregate', label: 'Aggregate' },
  { value: 'group-by', label: 'Group by' },
  { value: 'window', label: 'Window' },
  { value: 'project', label: 'Project' },
  { value: 'join', label: 'Join' },
  { value: 'union', label: 'Union' },
];
const AGG_FUNCS: AsaAggregateFunc[] = ['AVG', 'SUM', 'COUNT', 'MIN', 'MAX'];
const WINDOW_TYPES: AsaWindowType[] = ['Tumbling', 'Hopping', 'Sliding', 'Session', 'Snapshot'];
const WINDOW_UNITS: AsaWindowUnit[] = ['second', 'minute', 'hour', 'day'];

function csvToArr(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}
function arrToCsv(a?: string[]): string {
  return (a || []).join(', ');
}

// ---- source-inspector helpers (live event preview) ----
interface ReceivedEventRow {
  partitionId?: string;
  enqueuedTime?: string;
  body?: unknown;
}

function kindLabel(k: SourceKind): string {
  switch (k) {
    case 'eventhub': return 'Event Hubs';
    case 'iothub': return 'IoT Hub';
    case 'kafka': return 'Kafka';
    case 'cdc-mirror': return 'CDC (database change feed)';
    case 'custom-app': return 'Custom app (provision Event Hub)';
    case 'sample': return 'Sample data';
    default: return k;
  }
}

function cdcLabel(t?: string): string {
  switch (t) {
    case 'postgresql': return 'PostgreSQL';
    case 'mysql': return 'MySQL';
    case 'cosmosdb': return 'Cosmos DB';
    case 'sqlserver':
    default: return 'SQL Server';
  }
}

function maskConn(c: string): string {
  // Hide the SharedAccessKey value; show endpoint + entity only.
  return c.replace(/SharedAccessKey=[^;]+/i, 'SharedAccessKey=••••••');
}

function previewBody(b: unknown): string {
  const s = typeof b === 'string' ? b : JSON.stringify(b);
  return s && s.length > 200 ? s.slice(0, 200) + '…' : (s || '');
}

/** Repeating aggregate-spec editor (func / field / alias rows). */
function AggregateRows({
  value,
  onChange,
}: {
  value: AggregateSpec[];
  onChange: (next: AggregateSpec[]) => void;
}) {
  const rows = value || [];
  const update = (i: number, patch: Partial<AggregateSpec>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => onChange([...rows, { func: 'AVG', field: '', alias: '' }]);
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Label size="small">Aggregations</Label>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <Dropdown
            style={{ minWidth: 84 }}
            value={r.func}
            selectedOptions={[r.func]}
            onOptionSelect={(_: unknown, d: any) => update(i, { func: (d.optionValue as AsaAggregateFunc) || 'AVG' })}
            aria-label={`Aggregation ${i + 1} function`}
          >
            {AGG_FUNCS.map((f) => (
              <Option key={f} value={f}>{f}</Option>
            ))}
          </Dropdown>
          <Input
            style={{ minWidth: 0, flex: 1 }}
            placeholder={r.func === 'COUNT' ? '* (or field)' : 'field'}
            value={r.field}
            onChange={(_: unknown, d: any) => update(i, { field: d.value })}
            aria-label={`Aggregation ${i + 1} field`}
          />
          <Input
            style={{ minWidth: 0, flex: 1 }}
            placeholder="alias"
            value={r.alias}
            onChange={(_: unknown, d: any) => update(i, { alias: d.value })}
            aria-label={`Aggregation ${i + 1} alias`}
          />
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => remove(i)} aria-label={`Remove aggregation ${i + 1}`} />
        </div>
      ))}
      <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={add}>
        Add aggregation
      </Button>
    </div>
  );
}

/** Windowing sub-panel (type / size / unit / hop). */
function WindowPanel({
  value,
  onChange,
}: {
  value: TransformNode;
  onChange: (p: Partial<TransformNode>) => void;
}) {
  return (
    <>
      <Field label="Window type">
        <Dropdown
          value={value.windowType || ''}
          selectedOptions={value.windowType ? [value.windowType] : []}
          placeholder="None"
          onOptionSelect={(_: unknown, d: any) =>
            onChange({ windowType: (d.optionValue as AsaWindowType) || undefined })
          }
        >
          <Option value="">None</Option>
          {WINDOW_TYPES.map((w) => (
            <Option key={w} value={w}>{w}</Option>
          ))}
        </Dropdown>
      </Field>
      {value.windowType && value.windowType !== 'Snapshot' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Field label="Size" style={{ flex: 1 }}>
            <SpinButton
              min={1}
              value={value.windowSize ?? 30}
              onChange={(_: unknown, d: any) =>
                onChange({ windowSize: d.value ?? Number(d.displayValue) ?? 30 })
              }
              aria-label="Window size"
            />
          </Field>
          <Field label="Unit" style={{ flex: 1 }}>
            <Dropdown
              value={value.windowUnit || 'second'}
              selectedOptions={[value.windowUnit || 'second']}
              onOptionSelect={(_: unknown, d: any) =>
                onChange({ windowUnit: (d.optionValue as AsaWindowUnit) || 'second' })
              }
            >
              {WINDOW_UNITS.map((u) => (
                <Option key={u} value={u}>{u}</Option>
              ))}
            </Dropdown>
          </Field>
        </div>
      )}
      {(value.windowType === 'Hopping' || value.windowType === 'Session') && (
        <Field
          label={value.windowType === 'Hopping' ? 'Hop size' : 'Max duration'}
          hint={value.windowType === 'Hopping' ? 'How far each window advances' : 'Session max duration'}
        >
          <SpinButton
            min={1}
            value={value.hopSize ?? value.windowSize ?? 10}
            onChange={(_: unknown, d: any) => onChange({ hopSize: d.value ?? Number(d.displayValue) ?? 10 })}
            aria-label="Hop size"
          />
        </Field>
      )}
    </>
  );
}

/**
 * AsaTransformInspector — guided builder for one Eventstream transform node.
 *
 * Every operation (filter / aggregate / group-by / window / join / union) is
 * configured through dropdowns, number spinners and field lists. The ONLY
 * freeform inputs are the single-expression Monaco slots (WHERE / HAVING /
 * JOIN ON) — the allowed 1:1 builder exception per no-freeform-config.md.
 * The whole SAQL is generated by compileToSaql() and previewed live; it is
 * never hand-edited here.
 */
export function AsaTransformInspector({
  value,
  sources,
  onChange,
  onDelete,
}: {
  value: TransformNode;
  sources: SourceNode[];
  onChange: (p: Partial<TransformNode>) => void;
  onDelete: () => void;
}) {
  const previewSaql = useMemo(() => {
    const src: SourceNode = sources[0] || { kind: 'eventhub', name: 'input' };
    const allSrc = sources.length ? sources : [src];
    return compileToSaql(allSrc, [value], [{ kind: 'kusto', name: 'output' }]);
  }, [value, sources]);

  const isAgg = value.kind === 'aggregate' || value.kind === 'group-by' || value.kind === 'window';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
      <Label weight="semibold">Transform · {value.kind}</Label>
      <Field label="Name">
        <Input value={value.name} onChange={(_: unknown, d: any) => onChange({ name: d.value })} />
      </Field>
      <Field label="Operation">
        <Dropdown
          value={TRANSFORM_KINDS.find((k) => k.value === value.kind)?.label || value.kind}
          selectedOptions={[value.kind]}
          onOptionSelect={(_: unknown, d: any) => onChange({ kind: (d.optionValue as TransformKind) || 'filter' })}
        >
          {TRANSFORM_KINDS.map((k) => (
            <Option key={k.value} value={k.value}>{k.label}</Option>
          ))}
        </Dropdown>
      </Field>

      {/* ---- FILTER ---- */}
      {value.kind === 'filter' && (
        <Field label="WHERE condition" hint="e.g. temperature > 30 AND deviceId = 'sensor-A'">
          <MonacoTextarea
            value={value.expression || ''}
            onChange={(v) => onChange({ expression: v })}
            language="sql"
            height={72}
            lineNumbers={false}
            ariaLabel="WHERE condition"
          />
        </Field>
      )}

      {/* ---- AGGREGATE / GROUP-BY / WINDOW ---- */}
      {isAgg && (
        <>
          <Field label="Timestamp column (TIMESTAMP BY)" hint="Event-time column used for windowing">
            <Input
              value={value.timestampBy || ''}
              placeholder="eventTime"
              onChange={(_: unknown, d: any) => onChange({ timestampBy: d.value })}
            />
          </Field>
          <Field label="GROUP BY columns" hint="Comma-separated">
            <Input
              value={arrToCsv(value.groupBy)}
              placeholder="deviceId, region"
              onChange={(_: unknown, d: any) => onChange({ groupBy: csvToArr(d.value) })}
            />
          </Field>
          <AggregateRows value={value.aggregates || []} onChange={(next) => onChange({ aggregates: next })} />
          <Field label="Also project columns" hint="Comma-separated (optional)">
            <Input
              value={arrToCsv(value.selectFields)}
              onChange={(_: unknown, d: any) => onChange({ selectFields: csvToArr(d.value) })}
            />
          </Field>
          <Divider />
          <WindowPanel value={value} onChange={onChange} />
          <Field label="HAVING (optional)" hint="Filter on aggregates, e.g. AVG(temperature) > 30">
            <MonacoTextarea
              value={value.havingExpression || ''}
              onChange={(v) => onChange({ havingExpression: v })}
              language="sql"
              height={56}
              lineNumbers={false}
              ariaLabel="HAVING expression"
            />
          </Field>
        </>
      )}

      {/* ---- PROJECT ---- */}
      {value.kind === 'project' && (
        <Field label="Columns to keep" hint="Comma-separated; blank = all (*)">
          <Input
            value={arrToCsv(value.selectFields)}
            placeholder="deviceId, temperature, eventTime"
            onChange={(_: unknown, d: any) => onChange({ selectFields: csvToArr(d.value) })}
          />
        </Field>
      )}

      {/* ---- JOIN ---- */}
      {value.kind === 'join' && (
        <>
          <Field label="Join with stream">
            <Dropdown
              value={value.joinSource || ''}
              selectedOptions={value.joinSource ? [value.joinSource] : []}
              placeholder={sources.length > 1 ? 'Select a stream' : 'Add a second source first'}
              onOptionSelect={(_: unknown, d: any) => onChange({ joinSource: d.optionValue as string })}
            >
              {sources.map((srcOpt) => (
                <Option key={srcOpt.name} value={srcOpt.name}>{srcOpt.name}</Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Join type">
            <Dropdown
              value={value.joinType || 'INNER'}
              selectedOptions={[value.joinType || 'INNER']}
              onOptionSelect={(_: unknown, d: any) => onChange({ joinType: (d.optionValue as AsaJoinType) || 'INNER' })}
            >
              <Option value="INNER">INNER</Option>
              <Option value="LEFT OUTER">LEFT OUTER</Option>
            </Dropdown>
          </Field>
          <Field label="ON condition" hint="e.g. L.deviceId = R.deviceId (L = left, R = right)">
            <MonacoTextarea
              value={value.joinOn || ''}
              onChange={(v) => onChange({ joinOn: v })}
              language="sql"
              height={56}
              lineNumbers={false}
              ariaLabel="JOIN ON condition"
            />
          </Field>
          <Field label="Within (seconds)" hint="DATEDIFF temporal bound (max 604800 = 7 days)">
            <SpinButton
              min={0}
              max={604800}
              value={value.joinDurationSeconds ?? 60}
              onChange={(_: unknown, d: any) =>
                onChange({ joinDurationSeconds: d.value ?? Number(d.displayValue) ?? 60 })
              }
              aria-label="Join duration seconds"
            />
          </Field>
        </>
      )}

      {/* ---- UNION ---- */}
      {value.kind === 'union' && (
        <Caption1>UNION merges all upstream sources into one stream. No extra configuration is required.</Caption1>
      )}

      <Divider />
      <Label size="small">Generated SAQL (preview)</Label>
      <MonacoTextarea
        value={previewSaql}
        onChange={() => {}}
        language="sql"
        height={120}
        readOnly
        ariaLabel="Generated SAQL preview"
      />

      <Button
        icon={<Delete20Regular />}
        appearance="subtle"
        onClick={onDelete}
        style={{ marginTop: 4 }}
      >
        Remove transform
      </Button>
    </div>
  );
}

function SinkInspector({
  value,
  onChange,
  onDelete,
}: {
  value: SinkNode;
  onChange: (p: Partial<SinkNode>) => void;
  onDelete: () => void;
}) {
  return (
    <>
      <Label weight="semibold">Destination</Label>
      <Field label="Name">
        <Input value={value.name} onChange={(_: unknown, d: any) => onChange({ name: d.value })} />
      </Field>
      <Field label="Kind">
        <Dropdown
          value={value.kind}
          selectedOptions={[value.kind]}
          onOptionSelect={(_: unknown, d: any) => onChange({ kind: (d.optionValue as SinkKind) || 'kusto' })}
        >
          <Option value="kusto">KQL Database (Kusto)</Option>
          <Option value="lakehouse">Lakehouse</Option>
          <Option value="eventhub">Event Hubs</Option>
          <Option value="reflex">Reflex (Activator)</Option>
          <Option value="derivedStream">Derived Stream</Option>
        </Dropdown>
      </Field>
      {value.kind === 'kusto' && (
        <>
          <Field
            label="Cluster URL"
            hint="ADX / Eventhouse cluster query URL. Leave blank to use the deployment default (LOOM_KUSTO_CLUSTER_URI)."
          >
            <Input
              value={value.kustoClusterUrl || ''}
              placeholder="https://adx-csa-loom-shared.eastus2.kusto.windows.net"
              onChange={(_: unknown, d: any) => onChange({ kustoClusterUrl: d.value })}
            />
          </Field>
          <Field label="Database">
            <Input
              value={value.database || ''}
              placeholder="loomdb-default"
              onChange={(_: unknown, d: any) => onChange({ database: d.value })}
            />
          </Field>
          <Field label="Table" hint="Table must already exist; its schema must match the query output columns.">
            <Input
              value={value.table || ''}
              placeholder="raw_events"
              onChange={(_: unknown, d: any) => onChange({ table: d.value })}
            />
          </Field>
        </>
      )}
      {value.kind === 'lakehouse' && (
        <>
          <Field
            label="Storage account (ADLS Gen2)"
            hint="Azure-native default for a Fabric Lakehouse — ASA writes files to this ADLS Gen2 account."
          >
            <Input
              value={value.storageAccount || ''}
              placeholder="loomdatalake01"
              onChange={(_: unknown, d: any) => onChange({ storageAccount: d.value })}
            />
          </Field>
          <Field label="Container / filesystem">
            <Input
              value={value.container || ''}
              placeholder="bronze"
              onChange={(_: unknown, d: any) => onChange({ container: d.value })}
            />
          </Field>
          <Field label="Path pattern" hint="Files land under account/container/pathPattern. Use a Delta path for Lakehouse parity.">
            <Input
              value={value.pathPattern || ''}
              placeholder="events/{date}/{time}"
              onChange={(_: unknown, d: any) => onChange({ pathPattern: d.value })}
            />
          </Field>
          <Field label="Date format">
            <Input
              value={value.dateFormat || ''}
              placeholder="yyyy/MM/dd"
              onChange={(_: unknown, d: any) => onChange({ dateFormat: d.value })}
            />
          </Field>
          <Field label="Time format">
            <Input
              value={value.timeFormat || ''}
              placeholder="HH"
              onChange={(_: unknown, d: any) => onChange({ timeFormat: d.value })}
            />
          </Field>
        </>
      )}
      {(value.kind === 'eventhub' || value.kind === 'reflex') && (
        <>
          {value.kind === 'reflex' && (
            <MessageBar intent="info">
              <MessageBarBody>
                Activator reads from an Event Hub. Loom creates an Event Hub ASA output here;
                connect Activator to it from the Fabric portal (Settings &rarr; Trigger &rarr;
                Azure Event Hubs), or wire an Azure Monitor scheduled-query alert against the
                downstream KQL Database for a fully Azure-native trigger.
              </MessageBarBody>
            </MessageBar>
          )}
          <Field label="Namespace" hint="Event Hubs namespace (without the .servicebus suffix).">
            <Input
              value={value.namespace || ''}
              placeholder="loom-eventhub-ns"
              onChange={(_: unknown, d: any) => onChange({ namespace: d.value })}
            />
          </Field>
          <Field label="Event Hub name">
            <Input
              value={value.eventHubName || ''}
              placeholder="transformed-events"
              onChange={(_: unknown, d: any) => onChange({ eventHubName: d.value })}
            />
          </Field>
          <Field label="Shared access policy name" hint="Leave blank to authenticate with the ASA job's managed identity (MSI).">
            <Input
              value={value.sharedAccessPolicyName || ''}
              placeholder="RootManageSharedAccessKey"
              onChange={(_: unknown, d: any) => onChange({ sharedAccessPolicyName: d.value })}
            />
          </Field>
          <Field label="Shared access key">
            <Input
              type="password"
              value={value.sharedAccessPolicyKey || ''}
              placeholder="(blank = use managed identity)"
              onChange={(_: unknown, d: any) => onChange({ sharedAccessPolicyKey: d.value })}
            />
          </Field>
        </>
      )}
      {value.kind === 'derivedStream' && (
        <MessageBar intent="info">
          <MessageBarBody>
            A derived stream fans this stream out to another Eventstream in the same workspace.
            It has no external Azure output — add a KQL Database, Lakehouse, or Event Hub
            destination to land transformed events.
          </MessageBarBody>
        </MessageBar>
      )}
      <Button
        icon={<Delete20Regular />}
        appearance="subtle"
        onClick={onDelete}
        style={{ marginTop: 'auto' }}
      >
        Remove destination
      </Button>
    </>
  );
}
