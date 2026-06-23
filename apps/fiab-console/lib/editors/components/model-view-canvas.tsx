'use client';

/**
 * ModelViewCanvas + ModelViewPanel — the Loom-native parity of the Fabric /
 * Power BI "Model view": a draggable canvas of table cards joined by
 * relationship lines (with cardinality + cross-filter direction), plus a
 * measures panel with a DAX-like / T-SQL measure editor.
 *
 * NO Power BI / Fabric dependency. The model is materialized on the
 * Azure-native warehouse backends:
 *   • Warehouse / Synapse Dedicated SQL pool — relationships are Loom metadata
 *     persisted on the Cosmos item `state.model` (Synapse Dedicated has no
 *     enforced FOREIGN KEY); measures are real inline table-valued functions
 *     created with `CREATE OR ALTER FUNCTION … RETURNS TABLE`.
 *   • Databricks SQL Warehouse — relationships become real Unity Catalog
 *     informational FK constraints (`ALTER TABLE … ADD CONSTRAINT … FOREIGN
 *     KEY`), mirrored to Cosmos so cardinality/cross-filter survive; measures
 *     are Loom metadata usable as a query CTE.
 *
 * Power BI is strictly opt-in and is never read or required by this surface —
 * the Model view renders fully with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
 *
 * The canvas uses the same @xyflow/react engine as the ADX schema diagram
 * (lib/components/adx/schema-diagram-canvas.tsx); only the node visuals,
 * the column-level connect handles, and the relationship edges differ.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  Handle, Position, useReactFlow, useNodesState,
  MarkerType,
  type Node, type Edge, type NodeProps, type NodeTypes, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Badge, Button, Caption1, Text, Tooltip, Spinner, Field, Input, Dropdown, Option, Switch,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  FullScreenMaximize20Regular, Organization20Regular,
  DocumentTable16Regular, Key16Regular, Add20Regular, Delete16Regular,
  MathFormula20Regular, Play16Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

// ---------------------------------------------------------------------------
// Public model — kept in sync with the model BFF routes
// (app/api/items/<engine>/[id]/model/route.ts).
// ---------------------------------------------------------------------------

export type Cardinality = 'one-to-many' | 'many-to-one' | 'one-to-one' | 'many-to-many';
export type CrossFilter = 'single' | 'both';
export type MeasureKind = 'tvf' | 'scalar' | 'cosmos';

export interface ModelColumn { name: string; type?: string; isPk?: boolean; }

export interface ModelTable {
  /** schema-qualified id, e.g. `dbo.Sales` (Synapse) or `catalog.schema.table` (DBX). */
  id: string;
  schema: string;
  name: string;
  columns: ModelColumn[];
  rowCount?: number;
}

export interface ModelRelationship {
  id: string;
  name?: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality: Cardinality;
  crossFilter: CrossFilter;
  active: boolean;
  /** 'uc' when the FK originated from Unity Catalog INFORMATION_SCHEMA. */
  source?: 'cosmos' | 'uc';
}

export interface ModelMeasure {
  id: string;
  name: string;
  schema?: string;
  expression: string;
  kind: MeasureKind;
  createdAt?: string;
}

const CARDINALITIES: Cardinality[] = ['one-to-many', 'many-to-one', 'one-to-one', 'many-to-many'];
const CROSS_FILTERS: CrossFilter[] = ['single', 'both'];

/** The `1` / `*` end markers Fabric/Power BI draw on a relationship line. */
function cardinalityEnds(c: Cardinality): { from: string; to: string } {
  switch (c) {
    case 'one-to-many': return { from: '1', to: '*' };
    case 'many-to-one': return { from: '*', to: '1' };
    case 'one-to-one': return { from: '1', to: '1' };
    case 'many-to-many': return { from: '*', to: '*' };
  }
}

// ---------------------------------------------------------------------------
// Custom node — a table card with per-column connect handles.
// ---------------------------------------------------------------------------

const NODE_W = 240;
const MAX_COLS = 8;

export interface TableCardNodeData {
  table: ModelTable;
  [key: string]: unknown;
}

function TableCardNodeImpl({ data, selected }: NodeProps) {
  const { table } = data as TableCardNodeData;
  const cols = table.columns || [];
  const shown = cols.slice(0, MAX_COLS);

  return (
    <div
      id={`model-table-${table.id}`}
      data-model-table-id={table.id}
      aria-label={`Table ${table.id}`}
      style={{
        position: 'relative',
        width: NODE_W,
        borderRadius: tokens.borderRadiusXLarge,
        background: tokens.colorNeutralBackground1,
        border: `1px solid ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        boxShadow: selected ? `0 0 0 2px ${tokens.colorBrandBackground2}` : '0 1px 2px rgba(0,0,0,0.08)',
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
        background: tokens.colorNeutralBackground2,
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
      }}>
        <span style={{ color: 'var(--loom-accent-blue)', display: 'inline-flex' }}><DocumentTable16Regular fontSize={16} /></span>
        <Text size={200} weight="semibold" truncate wrap={false} style={{ flex: 1 }}>{table.name}</Text>
        <Badge size="extra-small" appearance="tint" color="informative">{table.schema}</Badge>
      </div>

      {/* Whole-card target/source handles (used as a fallback when a precise
          column handle isn't grabbed). */}
      <Handle type="target" position={Position.Left} id="__table" style={{ width: 8, height: 8, background: 'var(--loom-accent-blue)', border: 'none', left: -4, top: 16 }} />
      <Handle type="source" position={Position.Right} id="__table" style={{ width: 8, height: 8, background: 'var(--loom-accent-blue)', border: 'none', right: -4, top: 16 }} />

      {/* Column rows — each carries a column-level source + target handle so a
          relationship can be drawn key-to-key. `nodrag` keeps clicks from
          dragging the whole card. */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {shown.map((c) => (
          <div
            key={c.name}
            className="nodrag"
            style={{
              position: 'relative',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS,
              padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`, fontSize: tokens.fontSizeBase100, minHeight: 18,
            }}
          >
            <Handle
              type="target" position={Position.Left} id={`col:${c.name}`}
              style={{ width: 7, height: 7, background: tokens.colorNeutralStroke1, border: 'none', left: -3 }}
            />
            <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, overflow: 'hidden' }}>
              {c.isPk && <span style={{ color: 'var(--loom-accent-amber, #b8860b)', display: 'inline-flex' }}><Key16Regular fontSize={12} /></span>}
              <span style={{
                color: tokens.colorNeutralForeground1,
                fontWeight: c.isPk ? 600 : 400,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{c.name}</span>
            </span>
            <span style={{ color: tokens.colorNeutralForeground4, flexShrink: 0 }}>{c.type}</span>
            <Handle
              type="source" position={Position.Right} id={`col:${c.name}`}
              style={{ width: 7, height: 7, background: tokens.colorNeutralStroke1, border: 'none', right: -3 }}
            />
          </div>
        ))}
        {cols.length > shown.length && (
          <Caption1 style={{ color: tokens.colorNeutralForeground4, padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}` }}>
            +{cols.length - shown.length} more
          </Caption1>
        )}
        {cols.length === 0 && (
          <Caption1 style={{ color: tokens.colorNeutralForeground4, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}` }}>(no columns)</Caption1>
        )}
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = { 'model-table': TableCardNodeImpl };

// ---------------------------------------------------------------------------
// Deterministic 3-column grid layout (no async ELK).
// ---------------------------------------------------------------------------

const GRID_COLS = 3;
const COL_GAP = 360;
const ROW_GAP = 220;

function gridLayout(tables: ModelTable[]): Map<string, { x: number; y: number }> {
  const sorted = [...tables].sort((a, b) => (a.schema + a.name).localeCompare(b.schema + b.name));
  const pos = new Map<string, { x: number; y: number }>();
  sorted.forEach((t, i) => {
    const col = i % GRID_COLS;
    const row = Math.floor(i / GRID_COLS);
    pos.set(t.id, { x: col * COL_GAP, y: row * ROW_GAP });
  });
  return pos;
}

// ---------------------------------------------------------------------------
// Create-relationship dialog
// ---------------------------------------------------------------------------

interface DraftRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

function colFromHandle(handle: string | null | undefined): string | null {
  if (!handle || !handle.startsWith('col:')) return null;
  return handle.slice(4);
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  shell: {
    position: 'relative',
    width: '100%',
    height: '520px',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
  },
  toolbar: {
    display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingHorizontalXS,
  },
  empty: {
    position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: tokens.spacingVerticalS, textAlign: 'center', padding: tokens.spacingHorizontalXXL,
  },
});

export interface ModelViewCanvasProps {
  tables: ModelTable[];
  relationships: ModelRelationship[];
  onCreateRelationship: (rel: Omit<ModelRelationship, 'id'>) => Promise<void>;
  onDeleteRelationship: (rel: ModelRelationship) => Promise<void>;
  readOnly?: boolean;
  emptyMessage?: string;
}

function ModelViewCanvasInner({
  tables, relationships, onCreateRelationship, onDeleteRelationship, readOnly, emptyMessage,
}: ModelViewCanvasProps) {
  const st = useStyles();
  const rf = useReactFlow();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);

  // Create-relationship dialog state.
  const [dlgOpen, setDlgOpen] = useState(false);
  const [draft, setDraft] = useState<DraftRelationship | null>(null);
  const [cardinality, setCardinality] = useState<Cardinality>('many-to-one');
  const [crossFilter, setCrossFilter] = useState<CrossFilter>('single');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const positions = useMemo(() => gridLayout(tables), [tables]);

  useEffect(() => {
    setRfNodes(tables.map((t) => ({
      id: t.id,
      type: 'model-table',
      position: positions.get(t.id) || { x: 0, y: 0 },
      data: { table: t } as TableCardNodeData,
      selected: t.id === selectedId,
    })));
  }, [tables, positions, selectedId, setRfNodes]);

  const rfEdges: Edge[] = useMemo(() => {
    const ids = new Set(tables.map((t) => t.id));
    return relationships
      .filter((r) => ids.has(r.fromTable) && ids.has(r.toTable))
      .map((r) => {
        const ends = cardinalityEnds(r.cardinality);
        const highlight = selectedId === r.fromTable || selectedId === r.toTable;
        const color = highlight ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke1;
        return {
          id: r.id,
          source: r.fromTable,
          target: r.toTable,
          sourceHandle: `col:${r.fromColumn}`,
          targetHandle: `col:${r.toColumn}`,
          type: 'smoothstep',
          label: `${ends.from} — ${ends.to}${r.crossFilter === 'both' ? ' ⇄' : ''}`,
          labelStyle: { fontSize: tokens.fontSizeBase100, fill: tokens.colorNeutralForeground2 },
          animated: false,
          style: {
            stroke: color,
            strokeWidth: r.active ? 1.75 : 1,
            opacity: r.active ? 1 : 0.5,
            strokeDasharray: r.active ? undefined : '4 2',
          },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
          data: { rel: r },
        } as Edge;
      });
  }, [relationships, tables, selectedId]);

  const fit = useCallback(() => rf.fitView({ padding: 0.2, duration: 250 }), [rf]);

  const onConnect = useCallback((conn: Connection) => {
    if (readOnly) return;
    if (!conn.source || !conn.target) return;
    const fromColumn = colFromHandle(conn.sourceHandle);
    const toColumn = colFromHandle(conn.targetHandle);
    if (!fromColumn || !toColumn) {
      setErr('Drag from a column key on one table to a column key on another to create a relationship.');
      setDraft({ fromTable: conn.source, fromColumn: fromColumn || '', toTable: conn.target, toColumn: toColumn || '' });
      setCardinality('many-to-one');
      setCrossFilter('single');
      setActive(true);
      setDlgOpen(true);
      return;
    }
    setErr(null);
    setDraft({ fromTable: conn.source, fromColumn, toTable: conn.target, toColumn });
    setCardinality('many-to-one');
    setCrossFilter('single');
    setActive(true);
    setDlgOpen(true);
  }, [readOnly]);

  const confirmCreate = useCallback(async () => {
    if (!draft || !draft.fromColumn || !draft.toColumn) { setErr('Pick a column on both ends.'); return; }
    setBusy(true); setErr(null);
    try {
      const fromShort = draft.fromTable.split('.').pop();
      const toShort = draft.toTable.split('.').pop();
      await onCreateRelationship({
        name: `FK_${fromShort}_${toShort}_${draft.fromColumn}`.replace(/[^A-Za-z0-9_]/g, '_'),
        fromTable: draft.fromTable,
        fromColumn: draft.fromColumn,
        toTable: draft.toTable,
        toColumn: draft.toColumn,
        cardinality,
        crossFilter,
        active,
      });
      setDlgOpen(false);
      setDraft(null);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, cardinality, crossFilter, active, onCreateRelationship]);

  const onEdgeClick = useCallback(async (_: React.MouseEvent, edge: Edge) => {
    if (readOnly) return;
    const rel = (edge.data as { rel?: ModelRelationship } | undefined)?.rel;
    if (!rel) return;
    if (!window.confirm(`Delete relationship ${rel.name || rel.id}?\n${rel.fromTable}.${rel.fromColumn} → ${rel.toTable}.${rel.toColumn}`)) return;
    await onDeleteRelationship(rel);
  }, [readOnly, onDeleteRelationship]);

  const draftCols = (tableId: string): ModelColumn[] =>
    tables.find((t) => t.id === tableId)?.columns || [];

  return (
    <div className={st.shell} data-testid="model-view-canvas" aria-label="Model view relationship canvas">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onEdgeClick={onEdgeClick}
        onNodeClick={(_, n) => setSelectedId((cur) => (cur === n.id ? null : n.id))}
        onPaneClick={() => setSelectedId(null)}
        minZoom={0.2}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        nodesConnectable={!readOnly}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tokens.colorNeutralStroke2} />
        <Panel position="top-right">
          <div className={st.toolbar}>
            <Tooltip content="Auto-layout" relationship="label">
              <Button size="small" appearance="subtle" icon={<Organization20Regular />} aria-label="Auto-layout" onClick={fit} />
            </Tooltip>
            <Tooltip content="Zoom to fit" relationship="label">
              <Button size="small" appearance="subtle" icon={<FullScreenMaximize20Regular />} aria-label="Zoom to fit" onClick={fit} />
            </Tooltip>
          </div>
        </Panel>
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable style={{ backgroundColor: tokens.colorNeutralBackground1 }} />
      </ReactFlow>

      {tables.length === 0 && (
        <div className={st.empty} role="status">
          <DocumentTable16Regular fontSize={28} />
          <Text weight="semibold">No tables to model</Text>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            {emptyMessage || 'Create tables in the warehouse, then drag between column keys to define relationships.'}
          </Caption1>
        </div>
      )}

      {/* Create-relationship dialog */}
      <Dialog open={dlgOpen} onOpenChange={(_, d) => setDlgOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 560 }}>
          <DialogBody>
            <DialogTitle>Create relationship</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                {err && (
                  <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not create</MessageBarTitle>{err}</MessageBarBody></MessageBar>
                )}
                {draft && (
                  <>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
                      <Field label="From table" style={{ flex: 1 }}>
                        <Input value={draft.fromTable} readOnly aria-label="From table" />
                      </Field>
                      <Field label="From column" style={{ flex: 1 }}>
                        <Dropdown
                          value={draft.fromColumn}
                          selectedOptions={draft.fromColumn ? [draft.fromColumn] : []}
                          onOptionSelect={(_, d) => d.optionValue && setDraft({ ...draft, fromColumn: d.optionValue })}
                        >
                          {draftCols(draft.fromTable).map((c) => <Option key={c.name} value={c.name} text={c.name}>{c.name}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
                      <Field label="To table" style={{ flex: 1 }}>
                        <Input value={draft.toTable} readOnly aria-label="To table" />
                      </Field>
                      <Field label="To column" style={{ flex: 1 }}>
                        <Dropdown
                          value={draft.toColumn}
                          selectedOptions={draft.toColumn ? [draft.toColumn] : []}
                          onOptionSelect={(_, d) => d.optionValue && setDraft({ ...draft, toColumn: d.optionValue })}
                        >
                          {draftCols(draft.toTable).map((c) => <Option key={c.name} value={c.name} text={c.name}>{c.name}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
                      <Field label="Cardinality" style={{ flex: 1 }}>
                        <Dropdown
                          value={cardinality}
                          selectedOptions={[cardinality]}
                          onOptionSelect={(_, d) => d.optionValue && setCardinality(d.optionValue as Cardinality)}
                        >
                          {CARDINALITIES.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Cross-filter" style={{ flex: 1 }}>
                        <Dropdown
                          value={crossFilter}
                          selectedOptions={[crossFilter]}
                          onOptionSelect={(_, d) => d.optionValue && setCrossFilter(d.optionValue as CrossFilter)}
                        >
                          {CROSS_FILTERS.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                    <Switch checked={active} label="Active relationship" onChange={(_, d) => setActive(!!d.checked)} />
                  </>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDlgOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={confirmCreate} disabled={busy || !draft?.fromColumn || !draft?.toColumn}>
                {busy ? 'Creating…' : 'Create relationship'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

/** Public canvas component — wraps the inner canvas in a ReactFlowProvider. */
export function ModelViewCanvas(props: ModelViewCanvasProps) {
  return (
    <ReactFlowProvider>
      <ModelViewCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

// ===========================================================================
// ModelViewPanel — data-fetching wrapper used by the editors. Owns the model
// fetch, relationship create/delete, and the measures panel + editor.
// ===========================================================================

export type ModelEngine = 'warehouse' | 'synapse-dedicated-sql-pool' | 'databricks-sql-warehouse';

interface ModelResponse {
  ok: boolean;
  tables?: ModelTable[];
  relationships?: ModelRelationship[];
  measures?: ModelMeasure[];
  error?: string;
  message?: string;
  state?: string;
  /** Honest gate text surfaced when the backing compute is offline. */
  notice?: string;
}

export interface ModelViewPanelProps {
  engine: ModelEngine;
  id: string;
  /** Extra query params appended to GET/POST/DELETE (Databricks needs warehouseId/catalog/schema). */
  query?: Record<string, string | undefined>;
  /** Compute is online — relationships/measures can be written. */
  ready: boolean;
  notReadyMessage?: string;
  /** TVF for Synapse/Warehouse (real CREATE FUNCTION); cosmos for Databricks. */
  measureKind: 'tvf' | 'cosmos';
  /** Push a measure's usage SQL into the host editor's query tab. */
  onUseInQuery?: (sql: string) => void;
}

function buildUrl(engine: ModelEngine, id: string, query?: Record<string, string | undefined>, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v) params.set(k, v);
  for (const [k, v] of Object.entries(extra || {})) if (v) params.set(k, v);
  const qs = params.toString();
  return `/api/items/${engine}/${encodeURIComponent(id)}/model${qs ? `?${qs}` : ''}`;
}

const panelStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  measuresHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
});

export function ModelViewPanel({ engine, id, query, ready, notReadyMessage, measureKind, onUseInQuery }: ModelViewPanelProps) {
  const ps = panelStyles();
  const [data, setData] = useState<{ tables: ModelTable[]; relationships: ModelRelationship[]; measures: ModelMeasure[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  // Edit-ability follows the route's own compute probe (computeReady) once a
  // GET has returned; before that it falls back to the parent's hint.
  const [liveReady, setLiveReady] = useState(ready);

  // New-measure dialog.
  const [mOpen, setMOpen] = useState(false);
  const [mName, setMName] = useState('');
  const [mSchema, setMSchema] = useState('dbo');
  const [mExpr, setMExpr] = useState(
    measureKind === 'tvf'
      ? 'SELECT SUM(Amount) AS TotalSales FROM dbo.Sales'
      : 'SELECT sum(amount) AS total_sales FROM sales',
  );
  const [mBusy, setMBusy] = useState(false);
  const [mErr, setMErr] = useState<string | null>(null);

  const queryKey = JSON.stringify(query || {});

  const load = useCallback(async () => {
    if (!id || id === 'new') return;
    setLoading(true); setLoadErr(null); setGate(null);
    try {
      const r = await fetch(buildUrl(engine, id, query));
      const j = (await r.json()) as ModelResponse;
      if (!j.ok) {
        if (r.status === 409) setGate(j.message || j.error || `Compute is ${j.state || 'offline'}.`);
        else setLoadErr(j.error || j.message || `HTTP ${r.status}`);
        setData({ tables: [], relationships: [], measures: [] });
        return;
      }
      setData({ tables: j.tables ?? [], relationships: j.relationships ?? [], measures: j.measures ?? [] });
      setLiveReady(j.computeReady !== false);
      if (j.notice) setGate(j.notice);
    } catch (e: any) {
      setLoadErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, id, queryKey]);

  useEffect(() => { void load(); }, [load]);

  const createRel = useCallback(async (rel: Omit<ModelRelationship, 'id'>) => {
    const r = await fetch(buildUrl(engine, id, query), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relationship: rel }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
    await load();
  }, [engine, id, query, load]);

  const deleteRel = useCallback(async (rel: ModelRelationship) => {
    const r = await fetch(buildUrl(engine, id, query, { relId: rel.id }), { method: 'DELETE' });
    const j = await r.json().catch(() => ({ ok: r.ok }));
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    await load();
  }, [engine, id, query, load]);

  const saveMeasure = useCallback(async () => {
    if (!mName.trim()) { setMErr('Measure name is required.'); return; }
    if (!mExpr.trim()) { setMErr('Measure expression is required.'); return; }
    setMBusy(true); setMErr(null);
    try {
      const r = await fetch(buildUrl(engine, id, query, { kind: 'measure' }), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          measure: {
            name: mName.trim(),
            schema: measureKind === 'tvf' ? (mSchema.trim() || 'dbo') : undefined,
            expression: mExpr,
            kind: measureKind,
          },
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
      setMOpen(false);
      await load();
    } catch (e: any) {
      setMErr(e?.message || String(e));
    } finally {
      setMBusy(false);
    }
  }, [engine, id, query, mName, mSchema, mExpr, measureKind, load]);

  const usageSql = useCallback((m: ModelMeasure): string => {
    if (m.kind === 'tvf' || m.kind === 'scalar') {
      const sch = (m.schema || 'dbo').replace(/[[\]]/g, '');
      const nm = m.name.replace(/[[\]]/g, '');
      return `SELECT * FROM [${sch}].[${nm}]();`;
    }
    // Cosmos-stored measure — usable as a CTE.
    return `WITH ${m.name} AS (\n${m.expression}\n)\nSELECT * FROM ${m.name};`;
  }, []);

  const tables = data?.tables ?? [];
  const relationships = data?.relationships ?? [];
  const measures = data?.measures ?? [];

  return (
    <div className={ps.wrap}>
      {loading && <Spinner size="tiny" label="Loading model…" labelPosition="after" />}
      {loadErr && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Model load failed</MessageBarTitle>{loadErr}</MessageBarBody></MessageBar>
      )}
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Compute offline</MessageBarTitle>
            {gate} The Model view still renders; resume the compute to load live tables and create relationships.
          </MessageBarBody>
        </MessageBar>
      )}
      {!ready && !gate && notReadyMessage && (
        <MessageBar intent="info"><MessageBarBody>{notReadyMessage}</MessageBarBody></MessageBar>
      )}

      <ModelViewCanvas
        tables={tables}
        relationships={relationships}
        onCreateRelationship={createRel}
        onDeleteRelationship={deleteRel}
        readOnly={!liveReady}
        emptyMessage={liveReady ? undefined : (notReadyMessage || 'Resume the compute to load tables.')}
      />

      {/* Measures panel */}
      <div className={ps.measuresHead}>
        <MathFormula20Regular />
        <Text weight="semibold">Measures ({measures.length})</Text>
        <Button
          size="small" appearance="primary" icon={<Add20Regular />}
          onClick={() => { setMErr(null); setMName(''); setMOpen(true); }}
          disabled={!liveReady}
          title={!liveReady ? 'Resume the compute to add a measure' : undefined}
        >
          New measure
        </Button>
      </div>
      <div style={{ overflow: 'auto', maxHeight: 240, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
        <Table aria-label="Measures" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Kind</TableHeaderCell>
              <TableHeaderCell>Definition</TableHeaderCell>
              <TableHeaderCell>Use</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {measures.length === 0 && (
              <TableRow><TableCell colSpan={4}><Caption1>No measures yet. Click “New measure”.</Caption1></TableCell></TableRow>
            )}
            {measures.map((m) => (
              <TableRow key={m.id}>
                <TableCell>{m.schema ? `${m.schema}.${m.name}` : m.name}</TableCell>
                <TableCell><Badge appearance="outline" color={m.kind === 'cosmos' ? 'informative' : 'brand'}>{m.kind}</Badge></TableCell>
                <TableCell style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <code style={{ fontSize: tokens.fontSizeBase100 }}>{m.expression.slice(0, 160)}</code>
                </TableCell>
                <TableCell>
                  <Tooltip content="Load this measure into the Query tab" relationship="label">
                    <Button
                      size="small" appearance="subtle" icon={<Play16Regular />}
                      aria-label={`Use ${m.name} in query`}
                      onClick={() => onUseInQuery?.(usageSql(m))}
                      disabled={!onUseInQuery}
                    >
                      Use in query
                    </Button>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* New-measure dialog */}
      <Dialog open={mOpen} onOpenChange={(_, d) => setMOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 720 }}>
          <DialogBody>
            <DialogTitle>New measure</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                {mErr && (
                  <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not save measure</MessageBarTitle>{mErr}</MessageBarBody></MessageBar>
                )}
                <MessageBar intent="info">
                  <MessageBarBody>
                    {measureKind === 'tvf'
                      ? 'A warehouse measure is materialized as a real inline table-valued function (CREATE OR ALTER FUNCTION … RETURNS TABLE). It runs against the live compute and is queryable as a function.'
                      : 'A Databricks measure is stored as Loom tabular metadata and is usable as a query CTE (no Power BI / Fabric dependency).'}
                  </MessageBarBody>
                </MessageBar>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
                  {measureKind === 'tvf' && (
                    <Field label="Schema" style={{ width: 160 }}>
                      <Input value={mSchema} onChange={(_, d) => setMSchema(d.value)} placeholder="dbo" />
                    </Field>
                  )}
                  <Field label="Measure name" required style={{ flex: 1 }}>
                    <Input value={mName} onChange={(_, d) => setMName(d.value)} placeholder="fn_TotalSales" />
                  </Field>
                </div>
                <Field label="Definition (the SELECT the measure returns)" required>
                  <MonacoTextarea
                    value={mExpr}
                    onChange={setMExpr}
                    language={measureKind === 'tvf' ? 'tsql' : 'sql'}
                    height={180}
                    minHeight={140}
                    ariaLabel="Measure definition editor"
                  />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setMOpen(false)} disabled={mBusy}>Cancel</Button>
              <Button appearance="primary" onClick={saveMeasure} disabled={mBusy || !mName.trim() || !mExpr.trim()}>
                {mBusy ? 'Saving…' : 'Save measure'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
