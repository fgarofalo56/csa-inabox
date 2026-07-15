'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Digital Twin Builder editor (FGC-12) — the Loom parity for Microsoft Fabric's
 * Real-Time-Intelligence "Digital Twin Builder" item.
 *
 * Model an ontology of ENTITY types (assets / processes) + RELATIONSHIP types on
 * a Web-5.0 canvas (canvas-node-kit + @xyflow/react, Wave-2 useCanvasHistory
 * undo/redo), MAP each type onto a real source table (lakehouse Delta / Synapse
 * warehouse / ADX), BUILD the twin graph on Azure Data Explorer (`.create-merge`
 * + `.set-or-append`), EXPLORE the instance graph with `make-graph` /
 * `graph-match`, and view entity property HISTORY as a time-series over ADX.
 *
 * Azure-native DEFAULT — NO Microsoft Fabric, NO OneLake, NO Azure Digital Twins
 * on any default path (.claude/rules/no-fabric-dependency.md). Azure Digital
 * Twins is a strictly opt-in alternate, honest-gated on LOOM_ADT_ENDPOINT.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Spinner,
  Tab, TabList, Field, Dropdown, Option, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, Delete16Regular, ArrowUndo16Regular, ArrowRedo16Regular,
  Play16Regular, BuildingFactory20Regular, Link16Regular, DataUsage20Regular,
  Cube20Regular, Pulse20Regular, BranchFork20Regular, Sparkle16Regular,
} from '@fluentui/react-icons';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, Panel,
  Handle, Position, useNodesState, useReactFlow, MarkerType,
  type Node as RfNode, type Edge as RfEdge, type NodeProps, type NodeTypes, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CanvasNode, CanvasRightRail, CANVAS_NODE_WIDTH, CATEGORY_ACCENT, accentTint, portStyle, type CanvasVisual } from '@/lib/components/canvas/canvas-node-kit';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { useCanvasHistory } from '@/lib/components/canvas/use-canvas-history';
import { ForceDirectedGraph, type GraphNode, type GraphEdge } from '@/lib/components/graph/force-directed-graph';
import { TimeSeriesChart } from '@/lib/components/adx/time-series-chart';
import { ItemEditorChrome } from './item-editor-chrome';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { useItemState, SaveBar } from './phase4/shared';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import {
  normalizeTwinModel, emptyTwinModel, starterTwinModel, validateTwinModel, isTwinIdent,
  TWIN_BASE_TYPES, TWIN_BASE_TYPE_LABELS, TWIN_COLORS, TWIN_CARDINALITIES, TWIN_CARDINALITY_LABELS,
  TWIN_SOURCE_KINDS, TWIN_SOURCE_KIND_LABELS, TWIN_TS_AGGS, TWIN_TS_BINS, TWIN_TS_LOOKBACKS,
  SAMPLE_TWIN_MATCH,
  type TwinModel, type TwinEntity, type TwinProperty, type TwinRelationship,
  type TwinBaseType, type TwinColor, type TwinCardinality, type TwinSourceKind,
} from './digital-twin-model';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  section: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  secHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  secIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderLeftWidth: '4px', borderLeftColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  grid2: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM,
    '@media (max-width: 800px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  propRow: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr) auto auto',
    gap: tokens.spacingHorizontalS, alignItems: 'flex-end',
    '@media (max-width: 640px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  mapRow: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: tokens.spacingHorizontalS, alignItems: 'flex-end',
    '@media (max-width: 640px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  dialogScroll: {
    maxHeight: '64vh', overflowY: 'auto', display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalM, paddingRight: tokens.spacingHorizontalS,
  },
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  tableWrap: { overflowX: 'auto', borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}` },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, whiteSpace: 'pre', color: tokens.colorNeutralForeground2 },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL, borderRadius: tokens.borderRadiusLarge,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3, textAlign: 'center',
  },
});

// ---------------------------------------------------------------------------
// Canvas — entity nodes + relationship edges (Web-5.0 canvas-node-kit)
// ---------------------------------------------------------------------------
interface TEntityData { name: string; propCount: number; bound: boolean; keyName: string; accent: string; [k: string]: unknown }
const COLOR_ACCENT: Record<TwinColor, string> = {
  brand: CATEGORY_ACCENT.move, informative: CATEGORY_ACCENT.control, success: CATEGORY_ACCENT.iteration,
  warning: CATEGORY_ACCENT.iteration, danger: CATEGORY_ACCENT.external, subtle: CATEGORY_ACCENT.transform,
};

function TwinEntityNode({ data, selected }: NodeProps) {
  const d = data as TEntityData;
  const visual: CanvasVisual = { icon: <Cube20Regular />, category: 'move', accent: d.accent };
  return (
    <CanvasNode
      width={CANVAS_NODE_WIDTH}
      title={d.name || '(unnamed)'}
      visual={visual}
      selected={selected}
      typeLabel="Entity"
      description={`${d.propCount} propert${d.propCount === 1 ? 'y' : 'ies'}${d.keyName ? ` · key: ${d.keyName}` : ''}${d.bound ? ' · source bound' : ''}`}
    >
      <Handle type="target" position={Position.Left} style={{ ...portStyle('in', d.accent), left: -6, top: 22 }} />
      <Handle type="source" position={Position.Right} style={{ ...portStyle('out', d.accent), right: -6, top: 22 }} />
    </CanvasNode>
  );
}
const NODE_TYPES: NodeTypes = { 'twin-entity': TwinEntityNode };

const COL_GAP = 260;
const ROW_GAP = 150;
const COLS = 3;
function gridLayout(names: string[]): Map<string, { x: number; y: number }> {
  const m = new Map<string, { x: number; y: number }>();
  names.forEach((n, i) => m.set(n, { x: (i % COLS) * COL_GAP, y: Math.floor(i / COLS) * ROW_GAP }));
  return m;
}

interface CanvasProps {
  entities: TwinEntity[];
  relationships: TwinRelationship[];
  onMoveNode: (name: string, pos: { x: number; y: number }) => void;
  onOpenNode: (name: string) => void;
  onDrawEdge: (from: string, to: string) => void;
}

function TwinCanvasInner({ entities, relationships, onMoveNode, onOpenNode, onDrawEdge }: CanvasProps) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RfNode>([]);
  const rf = useReactFlow();
  const [zoom, setZoom] = useState(1);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const grid = useMemo(() => gridLayout(entities.map((e) => e.apiName)), [entities]);

  useEffect(() => {
    setRfNodes(entities.map((e) => ({
      id: e.apiName,
      type: 'twin-entity',
      position: e.position || grid.get(e.apiName) || { x: 0, y: 0 },
      data: {
        name: e.displayName || e.apiName,
        propCount: e.properties.length,
        bound: !!e.mapping?.sourceTable,
        keyName: e.keyProperty || '',
        accent: COLOR_ACCENT[e.color || 'brand'],
      } as TEntityData,
    })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entities, grid, setRfNodes]);

  const rfEdges: RfEdge[] = useMemo(() => {
    const ids = new Set(entities.map((e) => e.apiName));
    return relationships
      .filter((r) => ids.has(r.fromEntity) && ids.has(r.toEntity))
      .map((r, i) => ({
        id: `rel-${i}-${r.apiName}`,
        source: r.fromEntity,
        target: r.toEntity,
        label: r.displayName || r.apiName,
        type: 'smoothstep',
        style: { stroke: tokens.colorBrandStroke1, strokeWidth: 1.6 },
        labelStyle: { fontSize: tokens.fontSizeBase100, fill: tokens.colorNeutralForeground2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: tokens.colorBrandStroke1, width: 16, height: 16 },
      }));
  }, [relationships, entities]);

  return (
    <ResizableCanvasRegion storageKey="digital-twin-model" defaultPx={380} minPx={260} ariaLabel="Resize twin model canvas height">
      <div
        style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', backgroundColor: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge }}
        data-testid="digital-twin-canvas"
        aria-label="Digital twin model canvas"
      >
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onNodeDragStop={(_, n) => onMoveNode(n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) })}
          onNodeDoubleClick={(_, n) => onOpenNode(n.id)}
          onConnect={(c: Connection) => { if (c.source && c.target) onDrawEdge(c.source, c.target); }}
          minZoom={0.2}
          maxZoom={2}
          fitView
          // maxZoom keeps a small 3-6 node graph filling the canvas readably on open.
          fitViewOptions={{ padding: 0.2, maxZoom: 1.25 }}
          onMove={(_, vp) => setZoom(vp.zoom)}
          nodesDraggable
          nodesConnectable
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={null}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={18}
            size={1.5}
            color={accentTint('var(--loom-accent-blue)', 45)}
          />
          <Panel position="top-left">
            <Caption1 style={{ backgroundColor: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`, color: tokens.colorNeutralForeground3 }}>
              Drag to arrange · double-click an entity to edit · drag between entities to add a relationship
            </Caption1>
          </Panel>
          <Panel position="bottom-left">
            <CanvasRightRail
              zoom={zoom}
              minZoom={0.25}
              maxZoom={2}
              onZoomChange={(z) => rf.setViewport({ ...rf.getViewport(), zoom: z }, { duration: 120 })}
              onZoomIn={() => rf.zoomIn({ duration: 120 })}
              onZoomOut={() => rf.zoomOut({ duration: 120 })}
              onFit={() => rf.fitView({ padding: 0.2, maxZoom: 1.25, duration: 200 })}
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
        </ReactFlow>
        {entities.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Add an entity to start modeling the twin.</Caption1>
          </div>
        )}
      </div>
    </ResizableCanvasRegion>
  );
}
function TwinCanvas(props: CanvasProps) {
  return <ReactFlowProvider><TwinCanvasInner {...props} /></ReactFlowProvider>;
}

// ---------------------------------------------------------------------------
// Entity property editor dialog
// ---------------------------------------------------------------------------
function EntityDialog({ entity, onSave, onClose }: { entity: TwinEntity; onSave: (e: TwinEntity) => void; onClose: () => void }) {
  const s = useStyles();
  const [draft, setDraft] = useState<TwinEntity>(() => ({ ...entity, properties: [...entity.properties] }));
  const set = (patch: Partial<TwinEntity>) => setDraft((d) => ({ ...d, ...patch }));
  const setProp = (i: number, patch: Partial<TwinProperty>) =>
    setDraft((d) => ({ ...d, properties: d.properties.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const addProp = () => setDraft((d) => ({ ...d, properties: [...d.properties, { apiName: `prop${d.properties.length + 1}`, baseType: 'string' as TwinBaseType }] }));
  const delProp = (i: number) => setDraft((d) => {
    const properties = d.properties.filter((_, j) => j !== i);
    const keyProperty = d.keyProperty && properties.some((p) => p.apiName === d.keyProperty) ? d.keyProperty : undefined;
    return { ...d, properties, keyProperty };
  });

  const nameOk = isTwinIdent(draft.apiName);
  const keyOptions = draft.properties.map((p) => p.apiName);

  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: '640px' }}>
        <DialogBody>
          <DialogTitle>Edit entity</DialogTitle>
          <DialogContent>
            <div className={s.dialogScroll}>
              <div className={s.grid2}>
                <Field label="API name" required validationMessage={nameOk ? undefined : 'Letters, digits, underscore; must start with a letter/underscore.'} validationState={nameOk ? 'none' : 'error'}>
                  <Input value={draft.apiName} onChange={(_, d) => set({ apiName: d.value })} />
                </Field>
                <Field label="Display name">
                  <Input value={draft.displayName || ''} onChange={(_, d) => set({ displayName: d.value })} />
                </Field>
              </div>
              <div className={s.grid2}>
                <Field label="Color">
                  <Dropdown value={draft.color || 'brand'} selectedOptions={[draft.color || 'brand']} onOptionSelect={(_, d) => set({ color: d.optionValue as TwinColor })}>
                    {TWIN_COLORS.map((c) => <Option key={c} value={c}>{c}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Key property" hint="Surfaced as the graph node identity (id).">
                  <Dropdown
                    aria-label="Key property"
                    value={draft.keyProperty || '(none)'}
                    selectedOptions={draft.keyProperty ? [draft.keyProperty] : []}
                    onOptionSelect={(_, d) => set({ keyProperty: d.optionValue || undefined })}
                  >
                    {keyOptions.map((k) => <Option key={k} value={k}>{k}</Option>)}
                  </Dropdown>
                </Field>
              </div>
              <Field label="Description">
                <Textarea value={draft.description || ''} onChange={(_, d) => set({ description: d.value })} rows={2} />
              </Field>

              <div className={s.secHead}>
                <Subtitle2>Properties</Subtitle2>
                <div className={s.spacer} />
                <Button size="small" icon={<Add16Regular />} onClick={addProp}>Add property</Button>
              </div>
              {draft.properties.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No properties yet.</Caption1>}
              {draft.properties.map((p, i) => (
                <div key={i} className={s.propRow}>
                  <Field label={i === 0 ? 'API name' : undefined}>
                    <Input value={p.apiName} onChange={(_, d) => setProp(i, { apiName: d.value })} />
                  </Field>
                  <Field label={i === 0 ? 'Type' : undefined}>
                    <Dropdown value={TWIN_BASE_TYPE_LABELS[p.baseType]} selectedOptions={[p.baseType]} onOptionSelect={(_, d) => setProp(i, { baseType: d.optionValue as TwinBaseType })}>
                      {TWIN_BASE_TYPES.map((t) => <Option key={t} value={t}>{TWIN_BASE_TYPE_LABELS[t]}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label={i === 0 ? 'Time series' : undefined}>
                    <Dropdown aria-label="Time series" value={p.isTimeSeries ? 'Yes' : 'No'} selectedOptions={[p.isTimeSeries ? 'yes' : 'no']} onOptionSelect={(_, d) => setProp(i, { isTimeSeries: d.optionValue === 'yes' })}>
                      <Option value="no">No</Option>
                      <Option value="yes">Yes</Option>
                    </Dropdown>
                  </Field>
                  <Button appearance="subtle" icon={<Delete16Regular />} aria-label="Remove property" onClick={() => delProp(i)} />
                </div>
              ))}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!nameOk} onClick={() => onSave(draft)}>Apply</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Source-schema picker hook (drives the mapping wizard)
// ---------------------------------------------------------------------------
interface SchemaCol { name: string; type: string }
function useSourceSchema(id: string) {
  const [databases, setDatabases] = useState<string[]>([]);
  const [gate, setGate] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tableCache, setTableCache] = useState<Record<string, string[]>>({});
  const [colCache, setColCache] = useState<Record<string, SchemaCol[]>>({});

  useEffect(() => {
    if (!id || id === 'new') return;
    setLoading(true);
    clientFetch(`/api/items/digital-twin/${id}/source-schema`)
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) setDatabases((j.databases || []).map((d: any) => d.name).filter(Boolean));
        else setGate(j?.gate?.remediation || j?.error || 'ADX not configured.');
      })
      .catch((e) => setGate(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, [id]);

  const loadTables = useCallback(async (db: string): Promise<string[]> => {
    if (!db) return [];
    if (tableCache[db]) return tableCache[db];
    const r = await clientFetch(`/api/items/digital-twin/${id}/source-schema?database=${encodeURIComponent(db)}`);
    const j = await r.json();
    const tables = j?.ok ? (j.tables || []).map((t: any) => t.name).filter(Boolean) : [];
    setTableCache((c) => ({ ...c, [db]: tables }));
    return tables;
  }, [id, tableCache]);

  const loadColumns = useCallback(async (db: string, table: string): Promise<SchemaCol[]> => {
    if (!db || !table) return [];
    const cacheKey = `${db}//${table}`;
    if (colCache[cacheKey]) return colCache[cacheKey];
    const r = await clientFetch(`/api/items/digital-twin/${id}/source-schema?database=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`);
    const j = await r.json();
    const cols = j?.ok ? (j.columns || []) : [];
    setColCache((c) => ({ ...c, [cacheKey]: cols }));
    return cols;
  }, [id, colCache]);

  return { databases, gate, loading, loadTables, loadColumns };
}

// ---------------------------------------------------------------------------
// Main editor
// ---------------------------------------------------------------------------
export function DigitalTwinBuilderEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, savedAt, error, save, dirty } = useItemState<Record<string, unknown>>('digital-twin', id, emptyTwinModel() as unknown as Record<string, unknown>);
  const model = useMemo(() => normalizeTwinModel(state), [state]);
  const history = useCanvasHistory<TwinModel>(model);
  const [tab, setTab] = useState<'model' | 'mappings' | 'explore' | 'timeseries' | 'adt'>('model');
  const [editEntity, setEditEntity] = useState<string | null>(null);
  const [addEntityOpen, setAddEntityOpen] = useState(false);
  const [addRel, setAddRel] = useState<{ from: string; to: string } | null>(null);

  // Rebase history when the persisted model loads.
  useEffect(() => { if (!loading) history.reset(model); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [loading]);

  // Commit a new model to both the item state (for save) and the undo history.
  const commitModel = useCallback((next: TwinModel, record = true) => {
    if (record) history.commit(next);
    setState(() => next as unknown as Record<string, unknown>);
  }, [history, setState]);

  const applySnapshot = useCallback((snap: TwinModel | null) => {
    if (snap) setState(() => snap as unknown as Record<string, unknown>);
  }, [setState]);

  const issues = useMemo(() => validateTwinModel(model), [model]);
  const errorIssues = issues.filter((i) => i.level === 'error');

  // ---- Model mutations ----
  const addEntity = (name: string) => {
    if (!isTwinIdent(name) || model.entities.some((e) => e.apiName === name)) return;
    commitModel({
      ...model,
      entities: [...model.entities, {
        apiName: name, displayName: name, color: 'brand',
        properties: [{ apiName: 'id', baseType: 'string' as TwinBaseType, displayName: 'ID' }],
        keyProperty: 'id',
      }],
    });
    setAddEntityOpen(false);
    setEditEntity(name);
  };
  const saveEntity = (updated: TwinEntity) => {
    const orig = editEntity!;
    commitModel({
      ...model,
      entities: model.entities.map((e) => (e.apiName === orig ? updated : e)),
      // rename cascade into relationships
      relationships: model.relationships.map((r) => ({
        ...r,
        fromEntity: r.fromEntity === orig ? updated.apiName : r.fromEntity,
        toEntity: r.toEntity === orig ? updated.apiName : r.toEntity,
      })),
    });
    setEditEntity(null);
  };
  const deleteEntity = (name: string) => {
    commitModel({
      ...model,
      entities: model.entities.filter((e) => e.apiName !== name),
      relationships: model.relationships.filter((r) => r.fromEntity !== name && r.toEntity !== name),
    });
  };
  const moveNode = (name: string, pos: { x: number; y: number }) => {
    // Position moves don't record undo history (avoids stack spam on drag).
    commitModel({ ...model, entities: model.entities.map((e) => (e.apiName === name ? { ...e, position: pos } : e)) }, false);
  };
  const addRelationship = (apiName: string, from: string, to: string, cardinality: TwinCardinality) => {
    if (!isTwinIdent(apiName) || model.relationships.some((r) => r.apiName === apiName)) return;
    commitModel({ ...model, relationships: [...model.relationships, { apiName, displayName: apiName, fromEntity: from, toEntity: to, cardinality, properties: [] }] });
    setAddRel(null);
  };
  const deleteRelationship = (apiName: string) => {
    commitModel({ ...model, relationships: model.relationships.filter((r) => r.apiName !== apiName) });
  };

  // ---- Materialize ----
  const [buildBusy, setBuildBusy] = useState(false);
  const [buildResult, setBuildResult] = useState<any>(null);
  const build = useCallback(async () => {
    setBuildBusy(true); setBuildResult(null);
    // Persist first so the route reads the current model from Cosmos.
    const ok = await save(model as unknown as Record<string, unknown>);
    if (!ok) { setBuildResult({ ok: false, error: 'Save the twin before building (see the error above).' }); setBuildBusy(false); return; }
    try {
      const r = await clientFetch(`/api/items/digital-twin/${id}/materialize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      setBuildResult(await r.json());
    } catch (e: any) { setBuildResult({ ok: false, error: e?.message || String(e) }); }
    finally { setBuildBusy(false); }
  }, [id, model, save]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Model', actions: [
        { label: 'Add entity', onClick: () => setAddEntityOpen(true) },
        { label: 'Undo', onClick: () => applySnapshot(history.undo()), disabled: !history.canUndo },
        { label: 'Redo', onClick: () => applySnapshot(history.redo()), disabled: !history.canRedo },
      ]},
      { label: 'Build', actions: [
        { label: buildBusy ? 'Building…' : 'Build twin graph', onClick: buildBusy ? undefined : build, disabled: buildBusy || errorIssues.length > 0 },
      ]},
    ]},
  ], [history, applySnapshot, build, buildBusy, errorIssues.length]);

  if (loading) {
    return <ItemEditorChrome item={item} id={id} ribbon={[]} main={<div style={{ padding: tokens.spacingVerticalXL }}><Spinner label="Loading twin…" /></div>} />;
  }

  const main = (
    <div className={s.root}>
      <TeachingBanner
        surfaceKey="digital-twin-builder-editor"
        title="Build a digital twin"
        message="Model entities and the relationships between them, map each to your operational tables and time series, then explore the connected graph and stream live state — grounded in your real Azure data."
        learnMoreHref="https://learn.microsoft.com/azure/digital-twins/concepts-twins-graph"
      />
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="model" icon={<BranchFork20Regular />}>Model</Tab>
        <Tab value="mappings" icon={<Link16Regular />}>Mappings</Tab>
        <Tab value="explore" icon={<DataUsage20Regular />}>Graph explorer</Tab>
        <Tab value="timeseries" icon={<Pulse20Regular />}>Time series</Tab>
        <Tab value="adt" icon={<Cube20Regular />}>Azure Digital Twins</Tab>
      </TabList>

      {errorIssues.length > 0 && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Model has {errorIssues.length} error{errorIssues.length === 1 ? '' : 's'}</MessageBarTitle>
            {errorIssues.slice(0, 4).map((i, k) => <div key={k}>{i.message}</div>)}
          </MessageBarBody>
        </MessageBar>
      )}

      {tab === 'model' && (
        <TwinModelTab
          model={model} s={s}
          onAddEntity={() => setAddEntityOpen(true)}
          onInsertExample={() => commitModel(starterTwinModel())}
          onMoveNode={moveNode}
          onOpenNode={(n) => setEditEntity(n)}
          onDrawEdge={(from, to) => setAddRel({ from, to })}
          onDeleteEntity={deleteEntity}
          onDeleteRel={deleteRelationship}
        />
      )}

      {tab === 'mappings' && <MappingsTab id={id} model={model} commitModel={commitModel} s={s} />}
      {tab === 'explore' && <ExploreTab id={id} s={s} hasGraph={model.entities.length > 0 && model.relationships.length > 0} lastBuilt={buildResult} />}
      {tab === 'timeseries' && <TimeSeriesTab id={id} model={model} s={s} />}
      {tab === 'adt' && <AdtTab id={id} s={s} />}

      {buildResult && tab !== 'adt' && <BuildReceipt result={buildResult} s={s} />}

      <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />

      {editEntity && (() => {
        const e = model.entities.find((x) => x.apiName === editEntity);
        return e ? <EntityDialog entity={e} onSave={saveEntity} onClose={() => setEditEntity(null)} /> : null;
      })()}
      {addEntityOpen && <AddEntityDialog existing={model.entities.map((e) => e.apiName)} onAdd={addEntity} onClose={() => setAddEntityOpen(false)} />}
      {addRel && (
        <AddRelDialog
          from={addRel.from} to={addRel.to}
          existing={model.relationships.map((r) => r.apiName)}
          onAdd={(name, card) => addRelationship(name, addRel.from, addRel.to, card)}
          onClose={() => setAddRel(null)}
        />
      )}
    </div>
  );

  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={main} dirty={dirty} />;
}

// ---------------------------------------------------------------------------
// Model tab
// ---------------------------------------------------------------------------
function TwinModelTab({ model, s, onAddEntity, onInsertExample, onMoveNode, onOpenNode, onDrawEdge, onDeleteEntity, onDeleteRel }: {
  model: TwinModel; s: ReturnType<typeof useStyles>;
  onAddEntity: () => void; onInsertExample: () => void;
  onMoveNode: (n: string, p: { x: number; y: number }) => void; onOpenNode: (n: string) => void;
  onDrawEdge: (from: string, to: string) => void; onDeleteEntity: (n: string) => void; onDeleteRel: (n: string) => void;
}) {
  return (
    <div className={s.section}>
      <div className={s.secHead}>
        <div className={s.secIcon}><BranchFork20Regular /></div>
        <Subtitle2>Twin model</Subtitle2>
        <div className={s.spacer} />
        <Button size="small" icon={<Add16Regular />} onClick={onAddEntity}>Add entity</Button>
        {model.entities.length === 0 && <Button size="small" appearance="subtle" icon={<Sparkle16Regular />} onClick={onInsertExample}>Insert example</Button>}
      </div>
      <TwinCanvas
        entities={model.entities}
        relationships={model.relationships}
        onMoveNode={onMoveNode}
        onOpenNode={onOpenNode}
        onDrawEdge={onDrawEdge}
      />
      <div className={s.grid2}>
        <div>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Entities ({model.entities.length})</Caption1>
          {model.entities.map((e) => (
            <div key={e.apiName} className={s.cardHead} style={{ padding: tokens.spacingVerticalXS }}>
              <Cube20Regular />
              <Body1>{e.displayName || e.apiName}</Body1>
              <Badge appearance="tint" color="informative">{e.properties.length} props</Badge>
              {e.mapping?.sourceTable && <Badge appearance="tint" color="success">bound</Badge>}
              <div className={s.spacer} />
              <Button size="small" appearance="subtle" onClick={() => onOpenNode(e.apiName)}>Edit</Button>
              <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={`Delete ${e.apiName}`} onClick={() => onDeleteEntity(e.apiName)} />
            </div>
          ))}
        </div>
        <div>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Relationships ({model.relationships.length})</Caption1>
          {model.relationships.map((r) => (
            <div key={r.apiName} className={s.cardHead} style={{ padding: tokens.spacingVerticalXS }}>
              <Link16Regular />
              <Body1>{r.fromEntity} → {r.toEntity}</Body1>
              <Badge appearance="tint">{TWIN_CARDINALITY_LABELS[r.cardinality]}</Badge>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{r.displayName || r.apiName}</Caption1>
              <div className={s.spacer} />
              <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={`Delete ${r.apiName}`} onClick={() => onDeleteRel(r.apiName)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-entity / add-relationship dialogs
// ---------------------------------------------------------------------------
function AddEntityDialog({ existing, onAdd, onClose }: { existing: string[]; onAdd: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const ok = isTwinIdent(name) && !existing.includes(name);
  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: '420px' }}>
        <DialogBody>
          <DialogTitle>Add entity</DialogTitle>
          <DialogContent>
            <Field label="Entity API name" required validationState={name && !ok ? 'error' : 'none'} validationMessage={name && !ok ? 'Invalid or duplicate name.' : undefined}>
              <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="Asset" />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!ok} onClick={() => onAdd(name)}>Add</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function AddRelDialog({ from, to, existing, onAdd, onClose }: { from: string; to: string; existing: string[]; onAdd: (name: string, card: TwinCardinality) => void; onClose: () => void }) {
  const [name, setName] = useState(`${from}_${to}`.slice(0, 40));
  const [card, setCard] = useState<TwinCardinality>('one-to-many');
  const ok = isTwinIdent(name) && !existing.includes(name);
  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: '460px' }}>
        <DialogBody>
          <DialogTitle>Add relationship: {from} → {to}</DialogTitle>
          <DialogContent>
            <Field label="Relationship API name" required validationState={name && !ok ? 'error' : 'none'} validationMessage={name && !ok ? 'Invalid or duplicate name.' : undefined}>
              <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="monitors" />
            </Field>
            <Field label="Cardinality" style={{ marginTop: tokens.spacingVerticalM }}>
              <Dropdown value={TWIN_CARDINALITY_LABELS[card]} selectedOptions={[card]} onOptionSelect={(_, d) => setCard(d.optionValue as TwinCardinality)}>
                {TWIN_CARDINALITIES.map((c) => <Option key={c} value={c}>{TWIN_CARDINALITY_LABELS[c]}</Option>)}
              </Dropdown>
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!ok} onClick={() => onAdd(name, card)}>Add</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Mappings tab
// ---------------------------------------------------------------------------
function MappingsTab({ id, model, commitModel, s }: { id: string; model: TwinModel; commitModel: (m: TwinModel) => void; s: ReturnType<typeof useStyles> }) {
  const schema = useSourceSchema(id);
  return (
    <div className={s.section}>
      <div className={s.secHead}>
        <div className={s.secIcon}><Link16Regular /></div>
        <Subtitle2>Source mappings</Subtitle2>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Bind each entity + relationship to a real source table (lakehouse Delta, Synapse warehouse, or ADX). Build materializes the twin graph from these bindings on Azure Data Explorer — no Microsoft Fabric.
      </Caption1>
      {schema.gate && (
        <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Azure Data Explorer required</MessageBarTitle>{schema.gate}</MessageBarBody></MessageBar>
      )}
      {model.entities.length === 0 && <div className={s.empty}><Body1>Define entities in the Model tab first.</Body1></div>}
      {model.entities.map((e) => (
        <EntityMappingCard key={e.apiName} entity={e} schema={schema} s={s}
          onChange={(mapping) => commitModel({ ...model, entities: model.entities.map((x) => (x.apiName === e.apiName ? { ...x, mapping } : x)) })}
        />
      ))}
      {model.relationships.map((r) => (
        <RelMappingCard key={r.apiName} rel={r} schema={schema} s={s}
          onChange={(mapping) => commitModel({ ...model, relationships: model.relationships.map((x) => (x.apiName === r.apiName ? { ...x, mapping } : x)) })}
        />
      ))}
    </div>
  );
}

function ColumnDropdown({ label, value, columns, onSelect, allowNone }: { label: string; value?: string; columns: SchemaCol[]; onSelect: (v: string | undefined) => void; allowNone?: boolean }) {
  return (
    <Field label={label}>
      <Dropdown
        aria-label={label}
        value={value || (allowNone ? '(none)' : '')}
        selectedOptions={value ? [value] : []}
        onOptionSelect={(_, d) => onSelect(d.optionValue === '__none' ? undefined : d.optionValue)}
      >
        {allowNone && <Option value="__none">(none)</Option>}
        {columns.map((c) => <Option key={c.name} value={c.name}>{`${c.name} : ${c.type}`}</Option>)}
      </Dropdown>
    </Field>
  );
}

function EntityMappingCard({ entity, schema, onChange, s }: { entity: TwinEntity; schema: ReturnType<typeof useSourceSchema>; onChange: (m: TwinEntity['mapping']) => void; s: ReturnType<typeof useStyles> }) {
  const m = entity.mapping || { kind: 'lakehouse' as TwinSourceKind };
  const [tables, setTables] = useState<string[]>([]);
  const [cols, setCols] = useState<SchemaCol[]>([]);

  useEffect(() => { if (m.sourceDatabase) schema.loadTables(m.sourceDatabase).then(setTables); }, [m.sourceDatabase, schema]);
  useEffect(() => { if (m.sourceDatabase && m.sourceTable) schema.loadColumns(m.sourceDatabase, m.sourceTable).then(setCols); }, [m.sourceDatabase, m.sourceTable, schema]);

  const patch = (p: Partial<NonNullable<TwinEntity['mapping']>>) => onChange({ ...m, ...p, boundAt: new Date().toISOString() });

  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <Cube20Regular />
        <Subtitle2>{entity.displayName || entity.apiName}</Subtitle2>
        {m.sourceTable && <Badge appearance="tint" color="success">{m.sourceTable}</Badge>}
      </div>
      <div className={s.mapRow}>
        <Field label="Source kind">
          <Dropdown value={TWIN_SOURCE_KIND_LABELS[m.kind]} selectedOptions={[m.kind]} onOptionSelect={(_, d) => patch({ kind: d.optionValue as TwinSourceKind })}>
            {TWIN_SOURCE_KINDS.map((k) => <Option key={k} value={k}>{TWIN_SOURCE_KIND_LABELS[k]}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Database">
          <Dropdown aria-label="Database" value={m.sourceDatabase || ''} selectedOptions={m.sourceDatabase ? [m.sourceDatabase] : []} onOptionSelect={(_, d) => patch({ sourceDatabase: d.optionValue, sourceTable: undefined })}>
            {schema.databases.map((db) => <Option key={db} value={db}>{db}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <div className={s.mapRow}>
        <Field label="Source table">
          <Dropdown aria-label="Source table" value={m.sourceTable || ''} selectedOptions={m.sourceTable ? [m.sourceTable] : []} onOptionSelect={(_, d) => patch({ sourceTable: d.optionValue })}>
            {tables.map((t) => <Option key={t} value={t}>{t}</Option>)}
          </Dropdown>
        </Field>
        <ColumnDropdown label="Key column (twin identity)" value={(m.keyColumns || [])[0]} columns={cols} onSelect={(v) => patch({ keyColumns: v ? [v] : [] })} allowNone />
      </div>
      <ColumnDropdown label="Timestamp column (for time-series)" value={m.timestampColumn} columns={cols.filter((c) => /datetime|timestamp|date/.test(c.type))} onSelect={(v) => patch({ timestampColumn: v })} allowNone />
      {cols.length > 0 && entity.properties.length > 0 && (
        <>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Property → source column</Caption1>
          {entity.properties.map((p) => (
            <div key={p.apiName} className={s.mapRow}>
              <Caption1 style={{ alignSelf: 'center' }}>{p.apiName} <Badge appearance="outline" size="small">{p.baseType}</Badge></Caption1>
              <ColumnDropdown label="" value={(m.columnMap || {})[p.apiName]} columns={cols} onSelect={(v) => patch({ columnMap: { ...(m.columnMap || {}), [p.apiName]: v || '' } })} allowNone />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function RelMappingCard({ rel, schema, onChange, s }: { rel: TwinRelationship; schema: ReturnType<typeof useSourceSchema>; onChange: (m: TwinRelationship['mapping']) => void; s: ReturnType<typeof useStyles> }) {
  const m = rel.mapping || { kind: 'adx' as TwinSourceKind };
  const [tables, setTables] = useState<string[]>([]);
  const [cols, setCols] = useState<SchemaCol[]>([]);
  useEffect(() => { if (m.sourceDatabase) schema.loadTables(m.sourceDatabase).then(setTables); }, [m.sourceDatabase, schema]);
  useEffect(() => { if (m.sourceDatabase && m.sourceTable) schema.loadColumns(m.sourceDatabase, m.sourceTable).then(setCols); }, [m.sourceDatabase, m.sourceTable, schema]);
  const patch = (p: Partial<NonNullable<TwinRelationship['mapping']>>) => onChange({ ...m, ...p, boundAt: new Date().toISOString() });

  return (
    <div className={s.card} style={{ borderLeftColor: tokens.colorPaletteBerryBorderActive }}>
      <div className={s.cardHead}>
        <Link16Regular />
        <Subtitle2>{rel.fromEntity} →[{rel.displayName || rel.apiName}]→ {rel.toEntity}</Subtitle2>
        {m.sourceTable && <Badge appearance="tint" color="success">{m.sourceTable}</Badge>}
      </div>
      <div className={s.mapRow}>
        <Field label="Database">
          <Dropdown aria-label="Rel database" value={m.sourceDatabase || ''} selectedOptions={m.sourceDatabase ? [m.sourceDatabase] : []} onOptionSelect={(_, d) => patch({ sourceDatabase: d.optionValue, sourceTable: undefined })}>
            {schema.databases.map((db) => <Option key={db} value={db}>{db}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Edge table">
          <Dropdown aria-label="Edge table" value={m.sourceTable || ''} selectedOptions={m.sourceTable ? [m.sourceTable] : []} onOptionSelect={(_, d) => patch({ sourceTable: d.optionValue })}>
            {tables.map((t) => <Option key={t} value={t}>{t}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <div className={s.mapRow}>
        <ColumnDropdown label={`Origin key (${rel.fromEntity})`} value={(m.originKeyColumns || [])[0]} columns={cols} onSelect={(v) => patch({ originKeyColumns: v ? [v] : [] })} allowNone />
        <ColumnDropdown label={`Target key (${rel.toEntity})`} value={(m.targetKeyColumns || [])[0]} columns={cols} onSelect={(v) => patch({ targetKeyColumns: v ? [v] : [] })} allowNone />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graph explorer tab
// ---------------------------------------------------------------------------
function ExploreTab({ id, s, hasGraph, lastBuilt }: { id: string; s: ReturnType<typeof useStyles>; hasGraph: boolean; lastBuilt: any }) {
  const [pattern, setPattern] = useState(SAMPLE_TWIN_MATCH);
  const [mode, setMode] = useState<'kql-graph' | 'opencypher'>('kql-graph');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const run = useCallback(async () => {
    setBusy(true); setResult(null);
    try {
      const r = await clientFetch(`/api/items/digital-twin/${id}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern, mode, backend: 'adx' }) });
      setResult(await r.json());
    } catch (e: any) { setResult({ ok: false, error: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [id, pattern, mode]);

  const graph = useMemo(() => extractGraph(result), [result]);

  return (
    <div className={s.section}>
      <div className={s.secHead}>
        <div className={s.secIcon}><DataUsage20Regular /></div>
        <Subtitle2>Twin graph explorer</Subtitle2>
        <div className={s.spacer} />
        <Field label="">
          <Dropdown value={mode === 'opencypher' ? 'openCypher' : 'KQL graph-match'} selectedOptions={[mode]} onOptionSelect={(_, d) => setMode(d.optionValue as typeof mode)}>
            <Option value="kql-graph">KQL graph-match</Option>
            <Option value="opencypher">openCypher</Option>
          </Dropdown>
        </Field>
        <Button appearance="primary" icon={<Play16Regular />} disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run'}</Button>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Runs on Azure Data Explorer via <code>make-graph</code> / <code>graph-match</code> over the materialized twin — the same Kusto graph engine "Graph in Fabric" is built on, with no Microsoft Fabric.
      </Caption1>
      {!hasGraph && <MessageBar intent="info"><MessageBarBody>Define at least one entity + relationship, bind sources, and Build the twin graph before exploring.</MessageBarBody></MessageBar>}
      <Textarea value={pattern} onChange={(_, d) => setPattern(d.value)} rows={5} style={{ fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 }} />
      {result && !result.ok && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{result.error}</MessageBarBody></MessageBar>}
      {graph && graph.nodes.length > 0 && (
        <ForceDirectedGraph nodes={graph.nodes} edges={graph.edges} width={720} height={420} />
      )}
      {result?.ok && Array.isArray(result.rows) && (
        <ResultTable columns={result.columns || []} rows={result.rows} s={s} />
      )}
    </div>
  );
}

/** Best-effort node/edge extraction from a graph-match result grid. */
function extractGraph(result: any): { nodes: GraphNode[]; edges: GraphEdge[] } | null {
  if (!result?.ok || !Array.isArray(result.rows) || !Array.isArray(result.columns)) return null;
  const cols: string[] = result.columns;
  const si = cols.findIndex((c) => /^source$/i.test(c));
  const ti = cols.findIndex((c) => /^target$/i.test(c));
  const ri = cols.findIndex((c) => /^relationship$|^rel$/i.test(c));
  if (si < 0 || ti < 0) return null;
  const nodeSet = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const row of result.rows.slice(0, 500)) {
    const source = String(row[si] ?? '');
    const target = String(row[ti] ?? '');
    if (!source || !target) continue;
    nodeSet.add(source); nodeSet.add(target);
    edges.push({ source, target, label: ri >= 0 ? String(row[ri] ?? '') : undefined });
  }
  return { nodes: Array.from(nodeSet).map((n) => ({ id: n, label: n })), edges };
}

function ResultTable({ columns, rows, s }: { columns: string[]; rows: unknown[][]; s: ReturnType<typeof useStyles> }) {
  if (!columns.length) return null;
  return (
    <div className={s.tableWrap}>
      <Table size="small">
        <TableHeader><TableRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>
          {rows.slice(0, 200).map((row, i) => (
            <TableRow key={i}>{columns.map((_, j) => <TableCell key={j}><span className={s.mono}>{String((row as unknown[])[j] ?? '')}</span></TableCell>)}</TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time-series tab
// ---------------------------------------------------------------------------
function TimeSeriesTab({ id, model, s }: { id: string; model: TwinModel; s: ReturnType<typeof useStyles> }) {
  const boundEntities = model.entities.filter((e) => e.mapping?.sourceTable && e.mapping?.timestampColumn);
  const [entityName, setEntityName] = useState<string>(boundEntities[0]?.apiName || '');
  const entity = model.entities.find((e) => e.apiName === entityName);
  const tsProps = entity ? entity.properties.filter((p) => p.isTimeSeries || /real|long|int|decimal/.test(p.baseType)) : [];
  const [property, setProperty] = useState<string>(tsProps[0]?.apiName || '');
  const [agg, setAgg] = useState<string>('avg');
  const [bin, setBin] = useState<string>('1h');
  const [lookback, setLookback] = useState<string>('1d');
  const [keyValue, setKeyValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  useEffect(() => { setProperty(tsProps[0]?.apiName || ''); /* eslint-disable-next-line */ }, [entityName]);

  const run = useCallback(async () => {
    setBusy(true); setResult(null);
    try {
      const r = await clientFetch(`/api/items/digital-twin/${id}/time-series`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity: entityName, property, agg, bin, lookback, keyValue }) });
      setResult(await r.json());
    } catch (e: any) { setResult({ ok: false, error: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [id, entityName, property, agg, bin, lookback, keyValue]);

  return (
    <div className={s.section}>
      <div className={s.secHead}>
        <div className={s.secIcon}><Pulse20Regular /></div>
        <Subtitle2>Property history</Subtitle2>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Query an entity property's history over Azure Data Explorer. Bind the entity to a source table with a timestamp column in the Mappings tab first.</Caption1>
      {boundEntities.length === 0 && <MessageBar intent="info"><MessageBarBody>No entity has both a bound source table and a timestamp column yet. Set those in Mappings.</MessageBarBody></MessageBar>}
      {boundEntities.length > 0 && (
        <>
          <div className={s.grid2}>
            <Field label="Entity">
              <Dropdown value={entity?.displayName || entityName} selectedOptions={[entityName]} onOptionSelect={(_, d) => setEntityName(d.optionValue!)}>
                {boundEntities.map((e) => <Option key={e.apiName} value={e.apiName}>{e.displayName || e.apiName}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Property (measure)">
              <Dropdown value={property} selectedOptions={[property]} onOptionSelect={(_, d) => setProperty(d.optionValue!)}>
                {tsProps.map((p) => <Option key={p.apiName} value={p.apiName}>{p.apiName}</Option>)}
              </Dropdown>
            </Field>
          </div>
          <div className={s.grid2}>
            <Field label="Aggregation">
              <Dropdown value={agg} selectedOptions={[agg]} onOptionSelect={(_, d) => setAgg(d.optionValue!)}>
                {TWIN_TS_AGGS.map((a) => <Option key={a} value={a}>{a}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Bin">
              <Dropdown value={bin} selectedOptions={[bin]} onOptionSelect={(_, d) => setBin(d.optionValue!)}>
                {TWIN_TS_BINS.map((b) => <Option key={b} value={b}>{b}</Option>)}
              </Dropdown>
            </Field>
          </div>
          <div className={s.grid2}>
            <Field label="Look-back">
              <Dropdown value={lookback} selectedOptions={[lookback]} onOptionSelect={(_, d) => setLookback(d.optionValue!)}>
                {TWIN_TS_LOOKBACKS.map((l) => <Option key={l} value={l}>{l}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Filter to twin (key value, optional)">
              <Input value={keyValue} onChange={(_, d) => setKeyValue(d.value)} placeholder="e.g. an asset id" />
            </Field>
          </div>
          <div className={s.toolbar}>
            <Button appearance="primary" icon={<Play16Regular />} disabled={busy || !property} onClick={run}>{busy ? 'Querying…' : 'Query history'}</Button>
          </div>
          {result && !result.ok && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{result.error}</MessageBarBody></MessageBar>}
          {result?.ok && Array.isArray(result.rows) && result.rows.length > 0 && (
            <TimeSeriesChart columns={result.columns || []} rows={result.rows} columnTypes={result.columnTypes} height={260} />
          )}
          {result?.ok && Array.isArray(result.rows) && result.rows.length === 0 && (
            <MessageBar intent="info"><MessageBarBody>No rows in the selected window.</MessageBarBody></MessageBar>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Azure Digital Twins (opt-in) tab
// ---------------------------------------------------------------------------
function AdtTab({ id, s }: { id: string; s: ReturnType<typeof useStyles> }) {
  const [status, setStatus] = useState<any>(null);
  useEffect(() => {
    clientFetch(`/api/items/digital-twin/${id}/event-route`).then((r) => r.json()).then(setStatus).catch((e) => setStatus({ ok: false, error: String(e?.message || e) }));
  }, [id]);
  return (
    <div className={s.section}>
      <div className={s.secHead}>
        <div className={s.secIcon}><Cube20Regular /></div>
        <Subtitle2>Azure Digital Twins (opt-in alternate)</Subtitle2>
        <Badge appearance="outline">Optional</Badge>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        The default twin graph is Azure-native on ADX and needs none of this. Azure Digital Twins (DTDL model + twin instances) is available as an opt-in alternate for teams that want it.
      </Caption1>
      {!status && <Spinner label="Checking ADT configuration…" />}
      {status && status.configured === false && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure Digital Twins is not configured</MessageBarTitle>
            {status.remediation}
          </MessageBarBody>
          <MessageBarActions><code className={s.mono}>{status.bicepModule}</code></MessageBarActions>
        </MessageBar>
      )}
      {status && status.configured === true && (
        <MessageBar intent="success"><MessageBarBody><MessageBarTitle>Azure Digital Twins configured</MessageBarTitle>Endpoint: <code className={s.mono}>{status.endpoint}</code>. ADT twin-query dispatch is a tracked FGC-12 follow-up; graph exploration currently runs on the ADX-native default.</MessageBarBody></MessageBar>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build receipt
// ---------------------------------------------------------------------------
function BuildReceipt({ result, s }: { result: any; s: ReturnType<typeof useStyles> }) {
  if (!result) return null;
  if (!result.ok) {
    const rem = result.gate?.remediation;
    return (
      <MessageBar intent={rem ? 'warning' : 'error'}>
        <MessageBarBody><MessageBarTitle>{rem ? 'Configuration required' : 'Build failed'}</MessageBarTitle>{rem || result.error}</MessageBarBody>
      </MessageBar>
    );
  }
  const created = result.created || [];
  const loaded = result.loaded || [];
  const createdOk = created.filter((c: any) => c.ok).length;
  const totalRows = loaded.reduce((n: number, l: any) => n + (Number(l.rows) || 0), 0);
  return (
    <div className={s.card} style={{ borderLeftColor: tokens.colorPaletteGreenBorderActive }}>
      <div className={s.cardHead}>
        <BuildingFactory20Regular />
        <Subtitle2>Twin graph built</Subtitle2>
        <Badge appearance="tint" color="success">{createdOk}/{created.length} tables</Badge>
        {totalRows > 0 && <Badge appearance="tint" color="informative">{totalRows} rows loaded</Badge>}
        {result.graph && <Badge appearance="tint" color="brand">{result.graph.relationships} relationships</Badge>}
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Database: <code className={s.mono}>{result.database}</code> · twinKey <code className={s.mono}>{result.twinKey}</code></Caption1>
      {created.filter((c: any) => !c.ok).slice(0, 4).map((c: any, i: number) => (
        <Caption1 key={i} style={{ color: tokens.colorPaletteRedForeground1 }}>{c.name}: {c.error}</Caption1>
      ))}
      {Object.keys(result.counts || {}).length > 0 && (
        <div className={s.chips}>
          {Object.entries(result.counts).map(([t, n]) => <Badge key={t} appearance="outline">{t}: {String(n)}</Badge>)}
        </div>
      )}
    </div>
  );
}

export default DigitalTwinBuilderEditor;
