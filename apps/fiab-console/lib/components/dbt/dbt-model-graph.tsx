/**
 * CSA Loom — dbt visual model/project builder.
 *
 * A WYSIWYG canvas (ReactFlow) mirroring the dbt Cloud IDE / Fabric dbt graph:
 * source nodes feed model nodes (colored by medallion layer), edges are
 * ref()/source() lineage. Selecting a node opens an inline Fluent inspector
 * that edits real config — schema/table for sources; layer, materialization,
 * tests, refs, and the SQL body (the 1:1 dbt-IDE editor exception per
 * no-freeform-config.md) for models. A target panel selects the Azure-native
 * adapter (Databricks default, Synapse, or opt-in Fabric).
 *
 * The whole graph serializes to the DbtProjectGraph shape persisted to Cosmos
 * (state.project) and consumed by dbt-codegen.ts — so what you draw is exactly
 * what gets generated and run. No mock data.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel, Handle, Position,
  useReactFlow, useNodesState,
  type Node, type Edge, type NodeChange, type NodeTypes, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Button, Badge, Caption1, Body1, Input, Dropdown, Option, Label, Field, SpinButton,
  Divider, Textarea, Text,
  tokens, makeStyles, shorthands,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, DatabaseRegular, TableRegular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type {
  DbtProjectGraph, DbtSource, DbtModel, DbtTest, DbtTarget, MedallionLayer, Materialization, DbtAdapter,
} from '@/lib/dbt/dbt-project-model';
import { defaultMaterializationForLayer } from '@/lib/dbt/dbt-project-model';

const LAYER_COLOR: Record<MedallionLayer, string> = {
  bronze: '#a16207',
  silver: '#64748b',
  gold: '#b45309',
};

const useStyles = makeStyles({
  designer: {
    display: 'grid',
    gridTemplateColumns: '1fr 340px',
    gap: tokens.spacingHorizontalL,
    minHeight: '520px',
  },
  canvas: {
    position: 'relative',
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    overflow: 'hidden',
    minHeight: '500px',
  },
  inspector: {
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minHeight: '500px',
    overflowY: 'auto',
    maxHeight: '640px',
  },
  inspectorEmpty: { color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
  palette: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalXS),
  },
  node: {
    minWidth: '160px',
    ...shorthands.padding('8px', '10px'),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('2px', 'solid', tokens.colorNeutralStroke2),
    boxShadow: tokens.shadow4,
  },
  nodeSelected: { ...shorthands.border('2px', 'solid', tokens.colorBrandStroke1) },
  nodeTitle: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: tokens.fontSizeBase300 },
  nodeSub: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, fontFamily: tokens.fontFamilyMonospace },
  testRow: { display: 'flex', gap: '4px', alignItems: 'center' },
  inspectorForm: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  twoCol: { display: 'flex', gap: tokens.spacingHorizontalS },
  flex1: { flex: 1 },
  testCard: {
    display: 'flex', flexDirection: 'column', gap: '4px',
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalXS),
    ...shorthands.borderRadius(tokens.borderRadiusSmall),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  testTopRow: { display: 'flex', gap: '4px', alignItems: 'center' },
  emptyHint: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none', color: tokens.colorNeutralForeground3, zIndex: 1, textAlign: 'center', padding: '24px',
  },
});

// ============================================================
// Node data + custom node components
// ============================================================

interface DbtNodeData {
  label: string;
  subtitle?: string;
  kind: 'source' | 'model';
  layer?: MedallionLayer;
  selected?: boolean;
  [k: string]: unknown;
}

function SourceFlowNode({ data, selected }: NodeProps) {
  const s = useStyles();
  const d = data as unknown as DbtNodeData;
  return (
    <div className={`${s.node} ${selected ? s.nodeSelected : ''}`} style={{ borderColor: selected ? undefined : '#0ea5e9' }}>
      <Handle type="source" position={Position.Right} />
      <div className={s.nodeTitle}><DatabaseRegular /> {d.label}</div>
      {d.subtitle && <div className={s.nodeSub}>{d.subtitle}</div>}
      <Badge size="extra-small" appearance="tint" color="informative">source</Badge>
    </div>
  );
}

function ModelFlowNode({ data, selected }: NodeProps) {
  const s = useStyles();
  const d = data as unknown as DbtNodeData;
  const color = d.layer ? LAYER_COLOR[d.layer] : tokens.colorNeutralStroke2;
  return (
    <div className={`${s.node} ${selected ? s.nodeSelected : ''}`} style={{ borderColor: selected ? undefined : color }}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className={s.nodeTitle}><TableRegular /> {d.label}</div>
      {d.subtitle && <div className={s.nodeSub}>{d.subtitle}</div>}
      <div style={{ display: 'flex', gap: 4 }}>
        <Badge size="extra-small" appearance="filled" style={{ backgroundColor: color }}>{d.layer}</Badge>
      </div>
    </div>
  );
}

const dbtNodeTypes: NodeTypes = { dbtSource: SourceFlowNode, dbtModel: ModelFlowNode };

// ============================================================
// Component
// ============================================================

export type DbtSelection =
  | { type: 'source'; idx: number }
  | { type: 'model'; idx: number }
  | { type: 'target' }
  | null;

export interface DbtModelGraphProps {
  graph: DbtProjectGraph;
  onChange: (next: DbtProjectGraph) => void;
}

export function DbtModelGraph({ graph, onChange }: DbtModelGraphProps) {
  const s = useStyles();
  const [selected, setSelected] = useState<DbtSelection>(null);

  const sources = graph.sources || [];
  const models = graph.models || [];

  const commit = useCallback((patch: Partial<DbtProjectGraph>) => {
    onChange({ ...graph, ...patch });
  }, [graph, onChange]);

  const addSource = useCallback(() => {
    const next: DbtSource = { name: 'raw', schema: 'dbo', table: `table_${sources.length + 1}` };
    commit({ sources: [...sources, next] });
    setSelected({ type: 'source', idx: sources.length });
  }, [sources, commit]);

  const addModel = useCallback((layer: MedallionLayer) => {
    const next: DbtModel = {
      name: `${layer === 'bronze' ? 'stg' : layer === 'silver' ? 'int' : 'fct'}_${models.length + 1}`,
      layer,
      materialized: defaultMaterializationForLayer(layer),
      sql: layer === 'bronze'
        ? "select * from {{ source('raw', 'table_1') }}"
        : 'select * from {{ ref(\'stg_1\') }}',
      refs: [],
      sources: layer === 'bronze' ? ['raw.table_1'] : [],
      tests: [],
    };
    commit({ models: [...models, next] });
    setSelected({ type: 'model', idx: models.length });
  }, [models, commit]);

  const updateSource = useCallback((idx: number, patch: Partial<DbtSource>) => {
    commit({ sources: sources.map((n, i) => (i === idx ? { ...n, ...patch } : n)) });
  }, [sources, commit]);

  const updateModel = useCallback((idx: number, patch: Partial<DbtModel>) => {
    commit({ models: models.map((n, i) => (i === idx ? { ...n, ...patch } : n)) });
  }, [models, commit]);

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    if (selected.type === 'source') commit({ sources: sources.filter((_, i) => i !== selected.idx) });
    else if (selected.type === 'model') commit({ models: models.filter((_, i) => i !== selected.idx) });
    setSelected(null);
  }, [selected, sources, models, commit]);

  return (
    <div className={s.designer} role="region" aria-label="dbt visual model builder">
      <DbtCanvas
        sources={sources}
        models={models}
        selected={selected}
        onSelect={setSelected}
        onAddSource={addSource}
        onAddModel={addModel}
      />
      <aside className={s.inspector} aria-label="Node properties">
        {!selected && (
          <>
            <Caption1 className={s.inspectorEmpty}>
              Select a node to edit it, or use the palette to add a source / bronze / silver / gold model.
            </Caption1>
            <Divider />
            <TargetSummary target={graph.target} onEdit={() => setSelected({ type: 'target' })} />
          </>
        )}
        {selected?.type === 'source' && sources[selected.idx] && (
          <SourceInspector value={sources[selected.idx]} onChange={(p) => updateSource(selected.idx, p)} onDelete={deleteSelected} />
        )}
        {selected?.type === 'model' && models[selected.idx] && (
          <ModelInspector value={models[selected.idx]} allModels={models} sources={sources}
            onChange={(p) => updateModel(selected.idx, p)} onDelete={deleteSelected} />
        )}
        {selected?.type === 'target' && (
          <TargetInspector value={graph.target} onChange={(p) => commit({ target: { ...graph.target, ...p } })} />
        )}
      </aside>
    </div>
  );
}

// ============================================================
// Canvas
// ============================================================

interface XY { x: number; y: number }
const COL_GAP = 240;
const ROW_GAP = 110;

function layout(nSources: number, models: DbtModel[]): Map<string, XY> {
  const pos = new Map<string, XY>();
  for (let i = 0; i < nSources; i++) pos.set(`source-${i}`, { x: 16, y: 16 + i * ROW_GAP });
  const cols: Record<MedallionLayer, number> = { bronze: 1, silver: 2, gold: 3 };
  const rowByCol: Record<number, number> = {};
  models.forEach((m, i) => {
    const col = cols[m.layer];
    const row = rowByCol[col] ?? 0;
    rowByCol[col] = row + 1;
    pos.set(`model-${i}`, { x: 16 + col * COL_GAP, y: 16 + row * ROW_GAP });
  });
  return pos;
}

interface CanvasProps {
  sources: DbtSource[];
  models: DbtModel[];
  selected: DbtSelection;
  onSelect: (s: DbtSelection) => void;
  onAddSource: () => void;
  onAddModel: (layer: MedallionLayer) => void;
}

function CanvasInner({ sources, models, selected, onSelect, onAddSource, onAddModel }: CanvasProps) {
  const s = useStyles();
  useReactFlow();
  const positionsRef = useRef<Map<string, XY>>(new Map());
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const total = sources.length + models.length;

  const syncNodes = useCallback(() => {
    const fallback = layout(sources.length, models);
    const next = new Map<string, XY>();
    const list: Node[] = [];
    const push = (id: string, type: string, data: DbtNodeData, isSel: boolean) => {
      const p = positionsRef.current.get(id) || fallback.get(id) || { x: 16, y: 16 };
      next.set(id, p);
      list.push({ id, type, position: p, data: data as unknown as Record<string, unknown>, selected: isSel });
    };
    sources.forEach((n, i) => push(`source-${i}`, 'dbtSource',
      { label: n.name, subtitle: `${n.schema}.${n.table}`, kind: 'source' },
      selected?.type === 'source' && selected.idx === i));
    models.forEach((n, i) => push(`model-${i}`, 'dbtModel',
      { label: n.name, subtitle: n.materialized, kind: 'model', layer: n.layer },
      selected?.type === 'model' && selected.idx === i));
    positionsRef.current = next;
    setNodes(list);
  }, [sources, models, selected, setNodes]);

  useEffect(() => { syncNodes(); }, [syncNodes]);

  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    const stroke = tokens.colorBrandStroke1;
    const mk = (a: string, b: string) => out.push({
      id: `${a}->${b}`, source: a, target: b, type: 'default',
      style: { stroke, strokeWidth: 1.8 },
      markerEnd: { type: 'arrowclosed' as any, color: stroke, width: 16, height: 16 },
    });
    const modelIdxByName = new Map<string, number>();
    models.forEach((m, i) => modelIdxByName.set(m.name, i));
    const sourceIdxByKey = new Map<string, number>();
    sources.forEach((sc, i) => sourceIdxByKey.set(`${sc.name}.${sc.table}`, i));
    models.forEach((m, i) => {
      for (const r of m.refs || []) {
        const ui = modelIdxByName.get(r);
        if (ui !== undefined) mk(`model-${ui}`, `model-${i}`);
      }
      for (const srcKey of m.sources || []) {
        const si = sourceIdxByKey.get(srcKey);
        if (si !== undefined) mk(`source-${si}`, `model-${i}`);
      }
    });
    return out;
  }, [sources, models]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes);
    for (const c of changes) if (c.type === 'position' && c.position) positionsRef.current.set(c.id, c.position);
  }, [onNodesChange]);

  const handleNodeClick = useCallback((_: unknown, n: Node) => {
    const [role, idx] = n.id.split('-');
    onSelect({ type: role as 'source' | 'model', idx: Number(idx) } as DbtSelection);
  }, [onSelect]);

  return (
    <div className={s.canvas} data-canvas="dbt" aria-label="dbt model canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={dbtNodeTypes}
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
          <div className={s.palette} role="toolbar" aria-label="dbt node palette">
            <Button size="small" icon={<Add20Regular />} onClick={onAddSource} data-palette-item="source">Source</Button>
            <Button size="small" icon={<Add20Regular />} onClick={() => onAddModel('bronze')} data-palette-item="bronze">Bronze</Button>
            <Button size="small" icon={<Add20Regular />} onClick={() => onAddModel('silver')} data-palette-item="silver">Silver</Button>
            <Button size="small" icon={<Add20Regular />} onClick={() => onAddModel('gold')} data-palette-item="gold">Gold</Button>
          </div>
        </Panel>
      </ReactFlow>
      {total === 0 && (
        <div className={s.emptyHint}>
          <Caption1>Add a Source, then Bronze / Silver / Gold models to build a medallion dbt project.</Caption1>
        </div>
      )}
    </div>
  );
}

function DbtCanvas(props: CanvasProps) {
  return <ReactFlowProvider><CanvasInner {...props} /></ReactFlowProvider>;
}

// ============================================================
// Inspectors
// ============================================================

function SourceInspector({ value, onChange, onDelete }: {
  value: DbtSource; onChange: (p: Partial<DbtSource>) => void; onDelete: () => void;
}) {
  const s = useStyles();
  return (
    <>
      <Label weight="semibold">Source table</Label>
      <Field label="Source name" hint="The source('<name>', …) group">
        <Input value={value.name} onChange={(_, d) => onChange({ name: d.value })} />
      </Field>
      <Field label="Schema / database">
        <Input value={value.schema} placeholder="dbo" onChange={(_, d) => onChange({ schema: d.value })} />
      </Field>
      <Field label="Table">
        <Input value={value.table} placeholder="orders" onChange={(_, d) => onChange({ table: d.value })} />
      </Field>
      <Field label="Description">
        <Input value={value.description || ''} onChange={(_, d) => onChange({ description: d.value })} />
      </Field>
      <Divider />
      <Label size="small">Freshness (optional)</Label>
      <div className={s.twoCol}>
        <Field label="Warn after (h)" className={s.flex1}>
          <SpinButton min={0} value={value.freshnessWarnHours ?? 0}
            onChange={(_, d) => onChange({ freshnessWarnHours: d.value ?? Number(d.displayValue) ?? 0 })} aria-label="Warn after hours" />
        </Field>
        <Field label="Error after (h)" className={s.flex1}>
          <SpinButton min={0} value={value.freshnessErrorHours ?? 0}
            onChange={(_, d) => onChange({ freshnessErrorHours: d.value ?? Number(d.displayValue) ?? 0 })} aria-label="Error after hours" />
        </Field>
      </div>
      <Button icon={<Delete20Regular />} appearance="subtle" onClick={onDelete} style={{ marginTop: 'auto' }}>Remove source</Button>
    </>
  );
}

const MATERIALIZATIONS: Materialization[] = ['view', 'table', 'incremental', 'ephemeral'];
const LAYERS: MedallionLayer[] = ['bronze', 'silver', 'gold'];
const TEST_TYPES: DbtTest['type'][] = ['unique', 'not_null', 'accepted_values', 'relationships'];

function ModelInspector({ value, allModels, sources, onChange, onDelete }: {
  value: DbtModel; allModels: DbtModel[]; sources: DbtSource[];
  onChange: (p: Partial<DbtModel>) => void; onDelete: () => void;
}) {
  const s = useStyles();
  const refOptions = allModels.filter((m) => m.name !== value.name).map((m) => m.name);
  const sourceOptions = sources.map((sc) => `${sc.name}.${sc.table}`);
  const tests = value.tests || [];

  const updTest = (i: number, patch: Partial<DbtTest>) =>
    onChange({ tests: tests.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const addTest = () => onChange({ tests: [...tests, { type: 'not_null', column: '' }] });
  const rmTest = (i: number) => onChange({ tests: tests.filter((_, j) => j !== i) });

  return (
    <div className={s.inspectorForm}>
      <Label weight="semibold">Model · {value.name}</Label>
      <Field label="Model name">
        <Input value={value.name} onChange={(_, d) => onChange({ name: d.value })} />
      </Field>
      <div className={s.twoCol}>
        <Field label="Layer" className={s.flex1}>
          <Dropdown value={value.layer} selectedOptions={[value.layer]}
            onOptionSelect={(_, d) => onChange({ layer: (d.optionValue as MedallionLayer) || 'bronze' })}>
            {LAYERS.map((l) => <Option key={l} value={l}>{l}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Materialization" className={s.flex1}>
          <Dropdown value={value.materialized} selectedOptions={[value.materialized]}
            onOptionSelect={(_, d) => onChange({ materialized: (d.optionValue as Materialization) || 'view' })}>
            {MATERIALIZATIONS.map((m) => <Option key={m} value={m}>{m}</Option>)}
          </Dropdown>
        </Field>
      </div>
      {value.materialized === 'incremental' && (
        <Field label="Unique key" hint="Column used for the incremental merge">
          <Input value={value.uniqueKey || ''} onChange={(_, d) => onChange({ uniqueKey: d.value })} />
        </Field>
      )}
      <Field label="Refs (upstream models)" hint="Drives ref() lineage edges">
        <Dropdown multiselect value={(value.refs || []).join(', ')} selectedOptions={value.refs || []}
          placeholder={refOptions.length ? 'Select upstream models' : 'No other models yet'}
          onOptionSelect={(_, d) => onChange({ refs: d.selectedOptions })}>
          {refOptions.map((r) => <Option key={r} value={r}>{r}</Option>)}
        </Dropdown>
      </Field>
      <Field label="Sources (upstream raw tables)" hint="Drives source() lineage edges">
        <Dropdown multiselect value={(value.sources || []).join(', ')} selectedOptions={value.sources || []}
          placeholder={sourceOptions.length ? 'Select sources' : 'Add a source first'}
          onOptionSelect={(_, d) => onChange({ sources: d.selectedOptions })}>
          {sourceOptions.map((sc) => <Option key={sc} value={sc}>{sc}</Option>)}
        </Dropdown>
      </Field>
      <Field label="SQL (dbt model body)" hint="Use {{ ref('x') }} / {{ source('s','t') }}">
        <MonacoTextarea value={value.sql} onChange={(v) => onChange({ sql: v })}
          language="sql" height={160} ariaLabel="dbt model SQL" />
      </Field>
      <Divider />
      <Label size="small">Tests</Label>
      {tests.map((t, i) => (
        <div key={i} className={s.testCard}>
          <div className={s.testTopRow}>
            <Dropdown style={{ minWidth: 130 }} value={t.type} selectedOptions={[t.type]}
              onOptionSelect={(_, d) => updTest(i, { type: (d.optionValue as DbtTest['type']) || 'not_null' })} aria-label={`Test ${i + 1} type`}>
              {TEST_TYPES.map((tt) => <Option key={tt} value={tt}>{tt}</Option>)}
            </Dropdown>
            <Input style={{ flex: 1, minWidth: 0 }} placeholder="column (blank = model-level)" value={t.column || ''}
              onChange={(_, d) => updTest(i, { column: d.value })} aria-label={`Test ${i + 1} column`} />
            <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => rmTest(i)} aria-label={`Remove test ${i + 1}`} />
          </div>
          {t.type === 'accepted_values' && (
            <Input placeholder="comma,separated,values" value={(t.values || []).join(',')}
              onChange={(_, d) => updTest(i, { values: d.value.split(',').map((v) => v.trim()).filter(Boolean) })} aria-label={`Test ${i + 1} values`} />
          )}
          {t.type === 'relationships' && (
            <div className={s.twoCol}>
              <Input className={s.flex1} placeholder="to model" value={t.to || ''} onChange={(_, d) => updTest(i, { to: d.value })} aria-label={`Test ${i + 1} to`} />
              <Input className={s.flex1} placeholder="field" value={t.field || ''} onChange={(_, d) => updTest(i, { field: d.value })} aria-label={`Test ${i + 1} field`} />
            </div>
          )}
        </div>
      ))}
      <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={addTest}>Add test</Button>
      <Button icon={<Delete20Regular />} appearance="subtle" onClick={onDelete} style={{ marginTop: 4 }}>Remove model</Button>
    </div>
  );
}

const ADAPTERS: { value: DbtAdapter; label: string }[] = [
  { value: 'databricks', label: 'Databricks (Azure-native default)' },
  { value: 'synapse', label: 'Synapse dedicated SQL pool (Azure-native)' },
  { value: 'fabric', label: 'Fabric Warehouse (opt-in)' },
];

function TargetSummary({ target, onEdit }: { target: DbtTarget; onEdit: () => void }) {
  const s = useStyles();
  return (
    <div className={s.inspectorForm}>
      <Body1>Target</Body1>
      <Caption1>Adapter: <strong>{target.adapter}</strong></Caption1>
      <Button size="small" appearance="secondary" onClick={onEdit}>Edit target</Button>
    </div>
  );
}

function TargetInspector({ value, onChange }: { value: DbtTarget; onChange: (p: Partial<DbtTarget>) => void }) {
  const s = useStyles();
  return (
    <div className={s.inspectorForm}>
      <Label weight="semibold">Run target</Label>
      <Field label="Adapter">
        <Dropdown value={ADAPTERS.find((a) => a.value === value.adapter)?.label || value.adapter} selectedOptions={[value.adapter]}
          onOptionSelect={(_, d) => onChange({ adapter: (d.optionValue as DbtAdapter) || 'databricks' })}>
          {ADAPTERS.map((a) => <Option key={a.value} value={a.value} text={a.label}>{a.label}</Option>)}
        </Dropdown>
      </Field>
      <Field label="Default schema">
        <Input value={value.schema || ''} placeholder="analytics" onChange={(_, d) => onChange({ schema: d.value })} />
      </Field>
      <Field label="Threads">
        <SpinButton min={1} max={32} value={value.threads ?? 4}
          onChange={(_, d) => onChange({ threads: d.value ?? Number(d.displayValue) ?? 4 })} aria-label="dbt threads" />
      </Field>
      {value.adapter === 'databricks' && (
        <>
          <Field label="Unity Catalog" hint="profiles.yml catalog (default main)">
            <Input value={value.catalog || ''} placeholder="main" onChange={(_, d) => onChange({ catalog: d.value })} />
          </Field>
          <Field label="HTTP path (optional)" hint="SQL warehouse http_path; blank → env DBT_DATABRICKS_HTTP_PATH">
            <Input value={value.databricksHttpPath || ''} placeholder="/sql/1.0/warehouses/abc123"
              onChange={(_, d) => onChange({ databricksHttpPath: d.value })} />
          </Field>
          <Text size={200}>Runs as a Databricks Job dbt_task — no extra infra. The generated project is pushed to a Loom workspace folder.</Text>
        </>
      )}
      {value.adapter === 'synapse' && (
        <>
          <Field label="Synapse server (FQDN)">
            <Input value={value.synapseServer || ''} placeholder="ws.sql.azuresynapse.net"
              onChange={(_, d) => onChange({ synapseServer: d.value })} />
          </Field>
          <Field label="Database">
            <Input value={value.database || ''} placeholder="pool01" onChange={(_, d) => onChange({ database: d.value })} />
          </Field>
          <Text size={200}>Synapse has no native dbt task — runs in the loom-dbt-runner Container App (dbt-synapse + ODBC 18, managed identity).</Text>
        </>
      )}
      {value.adapter === 'fabric' && (
        <>
          <Field label="Fabric SQL endpoint">
            <Input value={value.fabricEndpoint || ''} placeholder="xxx.datawarehouse.fabric.microsoft.com"
              onChange={(_, d) => onChange({ fabricEndpoint: d.value })} />
          </Field>
          <Field label="Database / warehouse">
            <Input value={value.database || ''} onChange={(_, d) => onChange({ database: d.value })} />
          </Field>
          <Text size={200}>Fabric is opt-in only. The same generated project runs here via the dbt-fabric adapter (loom-dbt-runner).</Text>
        </>
      )}
    </div>
  );
}
