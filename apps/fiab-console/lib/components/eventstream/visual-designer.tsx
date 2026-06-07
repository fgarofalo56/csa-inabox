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
  Textarea,
  Label,
  Field,
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

// ============================================================
// Types
// ============================================================

export type SourceKind = 'eventhub' | 'iothub' | 'sample' | 'cdc-mirror' | 'kafka' | 'custom-app';
export type TransformKind = 'filter' | 'aggregate' | 'group-by' | 'project' | 'union' | 'join';
export type SinkKind = 'kusto' | 'lakehouse' | 'eventhub' | 'reflex' | 'derivedStream';

/** Real ingest endpoint resolved/provisioned by the source BFF route. */
export interface ProvisionedEndpoint {
  fqdn?: string;
  entityPath?: string;
  kafkaBootstrap?: string;
  auth?: 'entra' | 'sas';
  connectionString?: string | null;
  localAuthDisabled?: boolean;
  saslConfig?: string;
}

export interface SourceNode {
  kind: SourceKind;
  name: string;
  namespace?: string;
  consumerGroup?: string;
  iotHub?: string;
  connectionString?: string;
  topic?: string;
  // Event Hubs / custom-app entity name.
  eventHubName?: string;
  // IoT Hub ARM lookup overrides.
  iotHubResourceGroup?: string;
  iotHubSubscriptionId?: string;
  // CDC (ADF) source descriptor.
  cdcDatabaseType?: 'sqlserver' | 'postgresql' | 'mysql' | 'cosmosdb';
  cdcServerHost?: string;
  cdcDatabase?: string;
  cdcTable?: string;
  cdcUsername?: string;
  cdcAdfPipelineName?: string;
  // Filled after provisioning by /api/items/eventstream/[id]/source.
  provisionedEndpoint?: ProvisionedEndpoint;
}

export interface TransformNode {
  kind: TransformKind;
  name: string;
  expression?: string;
  columns?: string[];
  groupBy?: string[];
  window?: string;
}

export interface SinkNode {
  kind: SinkKind;
  name: string;
  database?: string;
  table?: string;
  lakehouseId?: string;
  workspaceId?: string;
  reflexId?: string;
}

export interface PipelineConfig {
  sources?: SourceNode[];
  source?: SourceNode; // legacy single-source
  transforms?: TransformNode[];
  sink?: SinkNode;
  sinks?: SinkNode[];
}

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
          <TransformInspector
            value={transforms[selected.idx]}
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

function TransformInspector({
  value,
  onChange,
  onDelete,
}: {
  value: TransformNode;
  onChange: (p: Partial<TransformNode>) => void;
  onDelete: () => void;
}) {
  return (
    <>
      <Label weight="semibold">Transform</Label>
      <Field label="Name">
        <Input value={value.name} onChange={(_: unknown, d: any) => onChange({ name: d.value })} />
      </Field>
      <Field label="Kind">
        <Dropdown
          value={value.kind}
          selectedOptions={[value.kind]}
          onOptionSelect={(_: unknown, d: any) =>
            onChange({ kind: (d.optionValue as TransformKind) || 'filter' })
          }
        >
          <Option value="filter">Filter</Option>
          <Option value="aggregate">Aggregate</Option>
          <Option value="group-by">Group by</Option>
          <Option value="project">Project</Option>
          <Option value="union">Union</Option>
          <Option value="join">Join</Option>
        </Dropdown>
      </Field>
      <Field
        label={
          value.kind === 'filter'
            ? 'Filter expression (KQL where clause)'
            : value.kind === 'aggregate'
              ? 'Aggregate (KQL summarize)'
              : 'Expression'
        }
        hint={
          value.kind === 'filter'
            ? 'e.g. event_type == "click"'
            : value.kind === 'aggregate'
              ? 'e.g. count() by tenant'
              : ''
        }
      >
        <Textarea
          value={value.expression || ''}
          onChange={(_: unknown, d: any) => onChange({ expression: d.value })}
          rows={3}
        />
      </Field>
      <Button
        icon={<Delete20Regular />}
        appearance="subtle"
        onClick={onDelete}
        style={{ marginTop: 'auto' }}
      >
        Remove transform
      </Button>
    </>
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
          <Field label="Database">
            <Input
              value={value.database || ''}
              onChange={(_: unknown, d: any) => onChange({ database: d.value })}
            />
          </Field>
          <Field label="Table">
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
          <Field label="Workspace ID">
            <Input
              value={value.workspaceId || ''}
              onChange={(_: unknown, d: any) => onChange({ workspaceId: d.value })}
            />
          </Field>
          <Field label="Lakehouse ID">
            <Input
              value={value.lakehouseId || ''}
              onChange={(_: unknown, d: any) => onChange({ lakehouseId: d.value })}
            />
          </Field>
        </>
      )}
      {value.kind === 'reflex' && (
        <Field label="Reflex ID">
          <Input
            value={value.reflexId || ''}
            onChange={(_: unknown, d: any) => onChange({ reflexId: d.value })}
          />
        </Field>
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
