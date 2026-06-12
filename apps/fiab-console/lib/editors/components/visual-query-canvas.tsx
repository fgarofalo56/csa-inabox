'use client';

/**
 * VisualQueryCanvas — Power-Query-style no-code query builder.
 *
 * Parity target: the Microsoft Fabric Warehouse "Visual query editor"
 * (learn.microsoft.com/fabric/data-warehouse/visual-query-editor) — a Power
 * Query diagram view where you drag tables onto a canvas, add Applied Steps
 * (Filter rows, Choose columns, Keep top rows, Group by) and Merge (JOIN) two
 * query chains, watch the generated SQL in a read-only "View SQL" pane, and Run
 * a preview. Databricks has no equivalent no-code surface, so on that path the
 * same canvas compiles to Spark SQL (per ui-parity.md).
 *
 * Real backend (no-vaporware.md): the same pure compiler the canvas previews
 * with runs server-side in /api/items/[type]/[id]/visual-query, which executes
 * the SQL against the live Synapse TDS / Databricks REST endpoint and returns
 * real rows. Column pickers are populated from a real zero-row "describe" query
 * against the table. No mock data.
 *
 * No-freeform-config.md: every transform input is a guided control (column
 * checklists, group-by pickers, aggregate dropdowns, join-kind + key pickers).
 * The ONLY freeform slot is the Filter step's single WHERE expression box.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  useReactFlow, useNodesState, useEdgesState, Handle, Position,
  type Node, type Edge, type NodeProps, type NodeTypes, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo } from 'react';
import {
  Button, Badge, Caption1, Label, Field, Input, Dropdown, Option, SpinButton,
  Checkbox, Divider, Spinner, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  MessageBar, MessageBarBody, MessageBarTitle, Tooltip,
  DataGrid, DataGridHeader, DataGridRow, DataGridHeaderCell, DataGridCell, DataGridBody,
  createTableColumn, useArrowNavigationGroup,
  type TableColumnDefinition, type TableColumnSizingOptions,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Play20Regular, Table20Regular,
  Filter20Regular, ColumnTriple20Regular, GroupList20Regular, BranchFork20Regular,
  ArrowSortDown20Regular, TextSortAscending20Regular,
  Copy20Regular, ArrowDownload20Regular,
} from '@fluentui/react-icons';
import {
  formatCell as fmtCsvCell, columnIsNumeric, toCsv, rowMatchesFilter,
} from '@/lib/editors/components/delta-preview-grid-utils';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  compileGraph,
  VQ_JOIN_KINDS,
  VQ_AGG_FUNCS,
  VQ_SORT_DIRS,
  type VqGraph,
  type VqNode,
  type VqStepKind,
  type VqJoinKind,
  type VqAggFunc,
  type VqAggSpec,
  type VqSortKey,
  type VqSortDir,
  type SqlDialect,
} from '@/lib/editors/visual-query-compiler';

// ============================================================
// Types
// ============================================================

export type VqEngine =
  | 'warehouse'
  | 'synapse-dedicated-sql-pool'
  | 'synapse-serverless-sql-pool'
  | 'databricks-sql-warehouse';

export interface VqSourceTable {
  schema?: string;
  table: string;
}

export interface VisualQueryCanvasProps {
  engine: VqEngine;
  id: string;
  dialect: SqlDialect;
  /** Synapse Serverless target database. */
  database?: string;
  /** Databricks SQL warehouse id. */
  warehouseId?: string;
  /** Databricks Unity Catalog session catalog / schema. */
  catalog?: string;
  schema?: string;
  /** Known tables from the parent editor's Explorer (for the Add-table picker). */
  sourceTables?: VqSourceTable[];
}

/** The per-node data carried on each React Flow node — a VqNode minus id/inputs (those come from the graph). */
type VqNodeData = Omit<VqNode, 'id' | 'inputs'> & { label: string };

interface RunResult {
  ok: boolean;
  generatedSql?: string;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  error?: string;
  code?: string;
  state?: string;
}

/** One result row wrapped with a stable id for the sortable/filterable DataGrid. */
interface ResultGridRow {
  __id: number;
  cells: unknown[];
}

// ============================================================
// Styles
// ============================================================

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  body: { display: 'grid', gridTemplateColumns: '1fr 320px', gap: tokens.spacingHorizontalL, minHeight: '420px' },
  canvas: {
    position: 'relative',
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    overflow: 'hidden',
    minHeight: '420px',
  },
  palette: {
    display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap',
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalXS),
  },
  inspector: {
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    minHeight: '420px', overflowY: 'auto',
  },
  empty: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none', color: tokens.colorNeutralForeground3, zIndex: 1, textAlign: 'center', padding: 24,
  },
  sqlBar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  resultBar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  resultSpacer: { flex: 1 },
  filterInput: { maxWidth: 240 },
  tableWrap: {
    overflow: 'auto', maxHeight: 320,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  resultLoading: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingHorizontalS, minHeight: 120,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3,
  },
  cell: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 12,
    whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis',
  },
  nullCell: { color: tokens.colorNeutralForeground4, fontStyle: 'italic' },
  aggRow: { display: 'flex', gap: 4, alignItems: 'center' },
  checkList: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 180, overflowY: 'auto', paddingLeft: 2 },
});

// ============================================================
// React Flow custom node
// ============================================================

const STEP_COLOR: Record<VqStepKind, string> = {
  source: '#0078d4',
  filter: '#7719aa',
  'select-columns': '#7719aa',
  'keep-top-rows': '#7719aa',
  'group-by': '#7719aa',
  sort: '#7719aa',
  join: '#107c10',
};

function stepIcon(kind: VqStepKind) {
  switch (kind) {
    case 'source': return <Table20Regular />;
    case 'filter': return <Filter20Regular />;
    case 'select-columns': return <ColumnTriple20Regular />;
    case 'keep-top-rows': return <ArrowSortDown20Regular />;
    case 'group-by': return <GroupList20Regular />;
    case 'sort': return <TextSortAscending20Regular />;
    case 'join': return <BranchFork20Regular />;
    default: return <Table20Regular />;
  }
}

const HANDLE: React.CSSProperties = { width: 11, height: 11, borderRadius: '50%', background: tokens.colorNeutralBackground1, zIndex: 3 };

function VqFlowNodeImpl({ data, selected }: NodeProps) {
  const d = data as unknown as VqNodeData;
  const color = STEP_COLOR[d.kind] || '#7719aa';
  const isJoin = d.kind === 'join';
  return (
    <div
      data-vq-kind={d.kind}
      data-vq-label={d.label}
      aria-label={`${d.kind} ${d.label}`}
      style={{
        position: 'relative', width: 186, padding: '10px 12px', borderRadius: 6,
        background: tokens.colorNeutralBackground1,
        border: `1px solid ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        boxShadow: selected ? `0 0 0 2px ${tokens.colorBrandBackground2}` : '0 1px 2px rgba(0,0,0,0.06)',
        display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', userSelect: 'none',
      }}
    >
      {d.kind !== 'source' && !isJoin && (
        <Handle id="in" type="target" position={Position.Left} style={{ ...HANDLE, left: -6, top: '50%', border: `2px solid ${tokens.colorBrandStroke1}` }} />
      )}
      {isJoin && (
        <>
          <Handle id="in-left" type="target" position={Position.Left} style={{ ...HANDLE, left: -6, top: '34%', border: `2px solid ${tokens.colorBrandStroke1}` }} />
          <Handle id="in-right" type="target" position={Position.Left} style={{ ...HANDLE, left: -6, top: '70%', border: `2px solid ${color}` }} />
        </>
      )}
      <Handle id="out" type="source" position={Position.Right} style={{ ...HANDLE, right: -6, top: '50%', border: `2px solid ${color}` }} />

      <div style={{ width: 6, alignSelf: 'stretch', borderRadius: 2, background: color }} />
      <div style={{ color, display: 'flex', alignItems: 'center', flexShrink: 0 }}>{stepIcon(d.kind)}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: tokens.colorNeutralForeground1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label}</div>
        <Badge appearance="filled" size="small" style={{ backgroundColor: color, color: '#fff', alignSelf: 'flex-start' }}>{d.kind}</Badge>
      </div>
    </div>
  );
}
const VqFlowNode = memo(VqFlowNodeImpl);
const vqNodeTypes: NodeTypes = { vq: VqFlowNode };

// ============================================================
// Graph helpers (canvas nodes/edges → VqGraph)
// ============================================================

function buildGraph(nodes: Node[], edges: Edge[], outputId?: string): VqGraph {
  const vqNodes: VqNode[] = nodes.map((n) => {
    const d = n.data as unknown as VqNodeData;
    // Inbound edges → inputs. Join orders by target handle (in-left, in-right).
    const inbound = edges.filter((e) => e.target === n.id);
    let inputs: string[];
    if (d.kind === 'join') {
      const left = inbound.find((e) => e.targetHandle === 'in-left')?.source;
      const right = inbound.find((e) => e.targetHandle === 'in-right')?.source;
      inputs = [left, right].filter(Boolean) as string[];
    } else {
      inputs = inbound.map((e) => e.source);
    }
    return {
      id: n.id,
      kind: d.kind,
      inputs,
      schema: d.schema,
      table: d.table,
      whereExpression: d.whereExpression,
      columns: d.columns,
      topN: d.topN,
      groupBy: d.groupBy,
      aggregates: d.aggregates,
      sortKeys: d.sortKeys,
      joinKind: d.joinKind,
      leftKey: d.leftKey,
      rightKey: d.rightKey,
    };
  });
  return { nodes: vqNodes, outputId };
}

/** Nodes with no outgoing edge — chain endpoints. */
function leafIds(nodes: Node[], edges: Edge[]): string[] {
  const consumed = new Set(edges.map((e) => e.source));
  return nodes.filter((n) => !consumed.has(n.id)).map((n) => n.id);
}

// ============================================================
// Component
// ============================================================

let nodeSeq = 0;
function nextId(prefix: string) {
  nodeSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${nodeSeq}`;
}

function CanvasInner(props: VisualQueryCanvasProps) {
  const { engine, id, dialect, database, warehouseId, catalog, schema, sourceTables = [] } = props;
  const s = useStyles();
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [columnsByNode, setColumnsByNode] = useState<Record<string, string[]>>({});
  const [colError, setColError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addSchema, setAddSchema] = useState(schema || '');
  const [addTable, setAddTable] = useState('');

  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [resultFilter, setResultFilter] = useState('');
  const resultArrowNav = useArrowNavigationGroup({ axis: 'grid' });

  const layoutCounter = useRef(0);

  const baseBody = useMemo(() => ({ dialect, database, warehouseId, catalog, schema }), [dialect, database, warehouseId, catalog, schema]);

  // ---- describe (column discovery) for a source table ----
  const fetchColumns = useCallback(async (nodeId: string, tblSchema: string | undefined, table: string) => {
    setColError(null);
    try {
      const r = await fetch(`/api/items/${engine}/${encodeURIComponent(id)}/visual-query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...baseBody, describe: { schema: tblSchema, table } }),
      });
      const j = await r.json();
      if (j.ok && Array.isArray(j.columns)) {
        setColumnsByNode((prev) => ({ ...prev, [nodeId]: j.columns }));
      } else {
        setColError(j.error || 'Could not resolve columns for this table.');
      }
    } catch (e: any) {
      setColError(e?.message || String(e));
    }
  }, [engine, id, baseBody]);

  // ---- add a source table node ----
  const addSource = useCallback((tblSchema: string | undefined, table: string) => {
    const nid = nextId('src');
    const idx = layoutCounter.current++;
    const node: Node = {
      id: nid, type: 'vq',
      position: { x: 24, y: 24 + idx * 120 },
      data: { kind: 'source', label: tblSchema ? `${tblSchema}.${table}` : table, schema: tblSchema, table } as unknown as Record<string, unknown>,
    };
    setNodes((ns) => [...ns, node]);
    setSelectedId(nid);
    void fetchColumns(nid, tblSchema, table);
  }, [setNodes, fetchColumns]);

  // ---- add a transform step connected to a parent ----
  const addStep = useCallback((kind: Exclude<VqStepKind, 'source' | 'join'>) => {
    // Attach to the selected node, else the single leaf.
    const leaves = leafIds(nodes, edges);
    const parent = (selectedId && nodes.some((n) => n.id === selectedId)) ? selectedId : leaves[leaves.length - 1];
    if (!parent) { setColError('Add a table first, then add steps.'); return; }
    const parentNode = nodes.find((n) => n.id === parent)!;
    const nid = nextId(kind);
    const defaults: Partial<VqNodeData> = {};
    if (kind === 'keep-top-rows') defaults.topN = 100;
    if (kind === 'group-by') { defaults.groupBy = []; defaults.aggregates = []; }
    if (kind === 'select-columns') defaults.columns = [];
    if (kind === 'sort') defaults.sortKeys = [];
    if (kind === 'filter') defaults.whereExpression = '';
    const node: Node = {
      id: nid, type: 'vq',
      position: { x: parentNode.position.x + 240, y: parentNode.position.y },
      data: { kind, label: STEP_LABEL[kind], ...defaults } as unknown as Record<string, unknown>,
    };
    const edge: Edge = { id: `${parent}->${nid}`, source: parent, target: nid, targetHandle: 'in', type: 'default', markerEnd: { type: 'arrowclosed' as any } };
    setNodes((ns) => [...ns, node]);
    setEdges((es) => [...es, edge]);
    setSelectedId(nid);
  }, [nodes, edges, selectedId, setNodes, setEdges]);

  // ---- add a join (merge) of the two latest chains ----
  const addJoin = useCallback((kind: VqJoinKind) => {
    const leaves = leafIds(nodes, edges);
    if (leaves.length < 2) { setColError('Merge needs two query chains — add a second table first.'); return; }
    const left = leaves[leaves.length - 2];
    const right = leaves[leaves.length - 1];
    const leftNode = nodes.find((n) => n.id === left)!;
    const nid = nextId('join');
    const node: Node = {
      id: nid, type: 'vq',
      position: { x: leftNode.position.x + 260, y: leftNode.position.y + 40 },
      data: { kind: 'join', label: 'Merge', joinKind: kind, leftKey: '', rightKey: '' } as unknown as Record<string, unknown>,
    };
    const e1: Edge = { id: `${left}->${nid}-l`, source: left, target: nid, targetHandle: 'in-left', type: 'default', markerEnd: { type: 'arrowclosed' as any } };
    const e2: Edge = { id: `${right}->${nid}-r`, source: right, target: nid, targetHandle: 'in-right', type: 'default', markerEnd: { type: 'arrowclosed' as any } };
    setNodes((ns) => [...ns, node]);
    setEdges((es) => [...es, e1, e2]);
    setSelectedId(nid);
  }, [nodes, edges, setNodes, setEdges]);

  // ---- manual wiring (drag a handle to another node) ----
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    const targetHandle = c.targetHandle || 'in';
    setEdges((es) => {
      // For single-input steps, replace any existing input edge.
      const filtered = es.filter((e) => !(e.target === c.target && e.targetHandle === targetHandle));
      return [...filtered, { id: `${c.source}->${c.target}-${targetHandle}`, source: c.source!, target: c.target!, targetHandle, type: 'default', markerEnd: { type: 'arrowclosed' as any } }];
    });
  }, [setEdges]);

  // ---- delete selected node + its edges ----
  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setColumnsByNode((prev) => { const next = { ...prev }; delete next[selectedId]; return next; });
    setSelectedId(null);
  }, [selectedId, setNodes, setEdges]);

  // ---- patch the selected node's data ----
  const patchSelected = useCallback((patch: Partial<VqNodeData>) => {
    if (!selectedId) return;
    setNodes((ns) => ns.map((n) => n.id === selectedId
      ? { ...n, data: { ...(n.data as object), ...patch } as Record<string, unknown> }
      : n));
  }, [selectedId, setNodes]);

  const handleNodeClick = useCallback((_: unknown, n: Node) => setSelectedId(n.id), []);

  // Reflect selection onto node objects so the selected ring renders.
  const renderNodes = useMemo(() => nodes.map((n) => ({ ...n, selected: n.id === selectedId })), [nodes, selectedId]);

  // ---- output node = single leaf (or last) ----
  const outputId = useMemo(() => {
    const leaves = leafIds(nodes, edges);
    return leaves[leaves.length - 1];
  }, [nodes, edges]);

  // ---- generated SQL (client-side, instant) ----
  const generatedSql = useMemo(() => {
    if (!nodes.length) return '-- Add a table to start building a query.';
    return compileGraph(buildGraph(nodes, edges, outputId), dialect);
  }, [nodes, edges, outputId, dialect]);

  // ---- available columns upstream of a node (for pickers) ----
  const resolveColumns = useCallback((nodeId: string): string[] => {
    const seen = new Set<string>();
    const out = new Set<string>();
    const walk = (nid: string) => {
      if (seen.has(nid)) return;
      seen.add(nid);
      const node = nodes.find((n) => n.id === nid);
      if (!node) return;
      const d = node.data as unknown as VqNodeData;
      if (d.kind === 'source') {
        (columnsByNode[nid] || []).forEach((c) => out.add(c));
        return;
      }
      if (d.kind === 'select-columns' && d.columns && d.columns.length) {
        d.columns.forEach((c) => out.add(c));
        return;
      }
      const inbound = edges.filter((e) => e.target === nid).map((e) => e.source);
      inbound.forEach(walk);
    };
    walk(nodeId);
    return Array.from(out);
  }, [nodes, edges, columnsByNode]);

  // For a node's OWN inputs (used by join key pickers — per-side columns).
  const inputColumns = useCallback((nodeId: string, handle: 'in-left' | 'in-right'): string[] => {
    const src = edges.find((e) => e.target === nodeId && e.targetHandle === handle)?.source;
    return src ? resolveColumns(src) : [];
  }, [edges, resolveColumns]);

  // ---- run ----
  const run = useCallback(async () => {
    if (!nodes.length) return;
    setRunning(true); setResult(null); setResultFilter('');
    try {
      const r = await fetch(`/api/items/${engine}/${encodeURIComponent(id)}/visual-query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...baseBody, graph: buildGraph(nodes, edges, outputId) }),
      });
      const j = (await r.json()) as RunResult;
      setResult(j);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setRunning(false);
    }
  }, [nodes, edges, outputId, engine, id, baseBody]);

  // ---- drag table from Explorer (dataTransfer) ----
  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }, []);
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/loom-vq-table') || e.dataTransfer.getData('text/plain');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as VqSourceTable;
      if (parsed?.table) addSource(parsed.schema, parsed.table);
    } catch {
      // plain table name
      addSource(undefined, raw);
    }
  }, [addSource]);

  const selectedNode = nodes.find((n) => n.id === selectedId) || null;

  // ---- result grid (sortable + client-side filter, parity with the Lakehouse preview grid) ----
  const resultCols = result?.ok ? (result.columns || []) : [];
  const resultRows = result?.ok ? (result.rows || []) : [];

  const numericResultCols = useMemo(() => {
    const set = new Set<number>();
    resultCols.forEach((_, i) => { if (columnIsNumeric(resultRows, i)) set.add(i); });
    return set;
  }, [resultCols, resultRows]);

  const filteredResultRows = useMemo<ResultGridRow[]>(() => {
    const mapped = resultRows.map((cells, idx) => ({ __id: idx, cells }));
    const needle = resultFilter.trim().toLowerCase();
    if (!needle) return mapped;
    return mapped.filter((r) => rowMatchesFilter(r.cells, needle));
  }, [resultRows, resultFilter]);

  const resultGridColumns = useMemo<TableColumnDefinition<ResultGridRow>[]>(() =>
    resultCols.map((colName, colIdx) =>
      createTableColumn<ResultGridRow>({
        columnId: `c${colIdx}`,
        compare: (a, b) => {
          const av = a.cells[colIdx];
          const bv = b.cells[colIdx];
          if (numericResultCols.has(colIdx)) return Number(av) - Number(bv);
          return fmtCsvCell(av).localeCompare(fmtCsvCell(bv));
        },
        renderHeaderCell: () => colName,
        renderCell: (row) => {
          const v = row.cells[colIdx];
          const display = formatCell(v);
          return (
            <span className={v === null || v === undefined ? `${s.cell} ${s.nullCell}` : s.cell} title={display}>
              {display}
            </span>
          );
        },
      }),
    ),
  [resultCols, numericResultCols, s]);

  const resultSizingOptions = useMemo<TableColumnSizingOptions>(() => {
    const opts: TableColumnSizingOptions = {};
    resultCols.forEach((_, colIdx) => { opts[`c${colIdx}`] = { minWidth: 80, defaultWidth: 160, idealWidth: 160 }; });
    return opts;
  }, [resultCols]);

  const downloadResultsCsv = useCallback(() => {
    const csv = toCsv(resultCols, filteredResultRows.map((r) => r.cells));
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'visual-query-results.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [resultCols, filteredResultRows]);

  const copyResultsCsv = useCallback(async () => {
    const csv = toCsv(resultCols, filteredResultRows.map((r) => r.cells));
    try {
      await navigator.clipboard.writeText(csv);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = csv; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
  }, [resultCols, filteredResultRows]);

  return (
    <div className={s.root}>
      <div className={s.body}>
        <div className={s.canvas} data-canvas="visual-query" onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={renderNodes}
            edges={edges}
            nodeTypes={vqNodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={handleNodeClick}
            onPaneClick={() => setSelectedId(null)}
            minZoom={0.3}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={null}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tokens.colorNeutralStroke2} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable style={{ backgroundColor: tokens.colorNeutralBackground1 }} />
            <Panel position="top-left">
              <div className={s.palette} role="toolbar" aria-label="Visual query steps">
                <Button size="small" icon={<Add20Regular />} appearance="primary" onClick={() => { setAddTable(''); setAddSchema(schema || ''); setAddOpen(true); }} data-vq-action="add-table">Add table</Button>
                <Button size="small" icon={<Filter20Regular />} onClick={() => addStep('filter')} data-vq-action="filter">Filter</Button>
                <Button size="small" icon={<ColumnTriple20Regular />} onClick={() => addStep('select-columns')} data-vq-action="choose-columns">Choose columns</Button>
                <Button size="small" icon={<GroupList20Regular />} onClick={() => addStep('group-by')} data-vq-action="group-by">Group by</Button>
                <Button size="small" icon={<ArrowSortDown20Regular />} onClick={() => addStep('keep-top-rows')} data-vq-action="keep-top">Keep top rows</Button>
                <Button size="small" icon={<TextSortAscending20Regular />} onClick={() => addStep('sort')} data-vq-action="sort">Sort</Button>
                <Menu>
                  <MenuTrigger disableButtonEnhancement>
                    <Button size="small" icon={<BranchFork20Regular />} data-vq-action="merge">Merge…</Button>
                  </MenuTrigger>
                  <MenuPopover>
                    <MenuList>
                      {VQ_JOIN_KINDS.map((k) => (
                        <MenuItem key={k} onClick={() => addJoin(k)}>{k} join</MenuItem>
                      ))}
                    </MenuList>
                  </MenuPopover>
                </Menu>
              </div>
            </Panel>
          </ReactFlow>
          {nodes.length === 0 && (
            <div className={s.empty}>
              <Caption1>Click <strong>Add table</strong> to drop a source onto the canvas, then add Filter / Choose columns / Group by steps and Merge two chains. The generated SQL updates live below.</Caption1>
            </div>
          )}
        </div>

        {/* Applied Steps / inspector */}
        <aside className={s.inspector} aria-label="Applied steps">
          {colError && (
            <MessageBar intent="warning"><MessageBarBody>{colError}</MessageBarBody></MessageBar>
          )}
          {!selectedNode && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Select a step on the canvas to edit it. Source tables come from the Explorer; transforms are added from the toolbar.
            </Caption1>
          )}
          {selectedNode && (
            <StepInspector
              node={selectedNode}
              dialect={dialect}
              availableColumns={resolveColumns(selectedId!)}
              leftColumns={inputColumns(selectedId!, 'in-left')}
              rightColumns={inputColumns(selectedId!, 'in-right')}
              onPatch={patchSelected}
              onDelete={deleteSelected}
            />
          )}
        </aside>
      </div>

      {/* Generated SQL (read-only) + Run */}
      <div className={s.sqlBar}>
        <Label weight="semibold">Generated {dialect === 'tsql' ? 'T-SQL' : 'Spark SQL'}</Label>
        <Badge appearance="outline">{nodes.length} step{nodes.length === 1 ? '' : 's'}</Badge>
        <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <Play20Regular />} disabled={running || !nodes.length} onClick={run} style={{ marginLeft: 'auto' }} data-vq-action="run">
          {running ? 'Running…' : 'Run'}
        </Button>
      </div>
      <MonacoTextarea value={generatedSql} onChange={() => {}} language={dialect} height={150} readOnly ariaLabel="Generated SQL preview" />

      {/* Results — loading state while the query executes against the live backend. */}
      {running && (
        <div className={s.resultLoading}>
          <Spinner size="tiny" />
          <Caption1>Running query against the live backend…</Caption1>
        </div>
      )}

      {!running && result && !result.ok && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Query failed</MessageBarTitle>
            {result.error || 'Unknown error'} {result.code && <Caption1>· {result.code}</Caption1>}
          </MessageBarBody>
        </MessageBar>
      )}

      {!running && result?.ok && (
        <>
          <div className={s.resultBar}>
            <Badge appearance="filled" color="success">{result.rowCount ?? resultRows.length} rows</Badge>
            {result.executionMs !== undefined && <Caption1>· {result.executionMs} ms</Caption1>}
            {result.truncated && <Badge appearance="outline" color="warning">truncated at 5,000</Badge>}
            {resultRows.length > 0 && (
              <Input
                className={s.filterInput}
                size="small"
                contentBefore={<Filter20Regular />}
                placeholder="Filter rows…"
                value={resultFilter}
                onChange={(_, d) => setResultFilter(d.value)}
                aria-label="Filter result rows"
              />
            )}
            {resultFilter.trim() && (
              <Caption1>{filteredResultRows.length.toLocaleString()} of {resultRows.length.toLocaleString()} shown</Caption1>
            )}
            <div className={s.resultSpacer} />
            {resultRows.length > 0 && (
              <>
                <Tooltip content="Copy shown rows as CSV" relationship="label">
                  <Button size="small" appearance="subtle" icon={<Copy20Regular />} onClick={() => void copyResultsCsv()}>Copy CSV</Button>
                </Tooltip>
                <Tooltip content="Download shown rows as CSV" relationship="label">
                  <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />} onClick={downloadResultsCsv}>Download</Button>
                </Tooltip>
              </>
            )}
          </div>
          {resultRows.length === 0 ? (
            <MessageBar intent="info"><MessageBarBody>Query returned no rows.</MessageBarBody></MessageBar>
          ) : filteredResultRows.length === 0 ? (
            <MessageBar intent="info"><MessageBarBody>No rows match “{resultFilter.trim()}”.</MessageBarBody></MessageBar>
          ) : (
            <div className={s.tableWrap} {...resultArrowNav} tabIndex={0}>
              <DataGrid
                items={filteredResultRows}
                columns={resultGridColumns}
                sortable
                resizableColumns
                columnSizingOptions={resultSizingOptions}
                getRowId={(item) => (item as ResultGridRow).__id}
                focusMode="composite"
                size="small"
                aria-label="Visual query results"
              >
                <DataGridHeader>
                  <DataGridRow>
                    {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
                  </DataGridRow>
                </DataGridHeader>
                <DataGridBody<ResultGridRow>>
                  {({ item, rowId }) => (
                    <DataGridRow<ResultGridRow> key={rowId}>
                      {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                    </DataGridRow>
                  )}
                </DataGridBody>
              </DataGrid>
            </div>
          )}
        </>
      )}

      {/* Add-table dialog */}
      <Dialog open={addOpen} onOpenChange={(_, d) => setAddOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add table to canvas</DialogTitle>
            <DialogContent>
              <Caption1>Pick a table from the Explorer, or enter a schema and table name. Its columns load automatically for the step pickers.</Caption1>
              {sourceTables.length > 0 && (
                <Field label="Table">
                  <Dropdown
                    placeholder="Select a table"
                    selectedOptions={addTable ? [`${addSchema}|${addTable}`] : []}
                    value={addTable ? (addSchema ? `${addSchema}.${addTable}` : addTable) : ''}
                    onOptionSelect={(_, d) => {
                      const [sch, tbl] = (d.optionValue || '').split('|');
                      setAddSchema(sch); setAddTable(tbl);
                    }}
                  >
                    {sourceTables.map((t) => (
                      <Option key={`${t.schema || ''}.${t.table}`} value={`${t.schema || ''}|${t.table}`} text={t.schema ? `${t.schema}.${t.table}` : t.table}>
                        {t.schema ? `${t.schema}.${t.table}` : t.table}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <Field label="Schema" style={{ flex: 1 }}>
                  <Input value={addSchema} placeholder={dialect === 'tsql' ? 'dbo' : '(optional)'} onChange={(_, d) => setAddSchema(d.value)} />
                </Field>
                <Field label="Table" style={{ flex: 1 }} required>
                  <Input value={addTable} placeholder="fact_sale" onChange={(_, d) => setAddTable(d.value)} />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button appearance="primary" disabled={!addTable.trim()} onClick={() => { addSource(addSchema.trim() || undefined, addTable.trim()); setAddOpen(false); }}>Add table</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

const STEP_LABEL: Record<Exclude<VqStepKind, 'source'>, string> = {
  filter: 'Filter rows',
  'select-columns': 'Choose columns',
  'keep-top-rows': 'Keep top rows',
  'group-by': 'Group by',
  sort: 'Sort rows',
  join: 'Merge',
};

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ============================================================
// Step inspector (Applied Steps form for the selected node)
// ============================================================

function StepInspector({
  node, dialect, availableColumns, leftColumns, rightColumns, onPatch, onDelete,
}: {
  node: Node;
  dialect: SqlDialect;
  availableColumns: string[];
  leftColumns: string[];
  rightColumns: string[];
  onPatch: (patch: Partial<VqNodeData>) => void;
  onDelete: () => void;
}) {
  const s = useStyles();
  const d = node.data as unknown as VqNodeData;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Label weight="semibold">Step · {d.kind}</Label>

      {d.kind === 'source' && (
        <>
          <Field label="Schema"><Input value={d.schema || ''} onChange={(_, v) => onPatch({ schema: v.value, label: v.value ? `${v.value}.${d.table}` : (d.table || '') })} /></Field>
          <Field label="Table"><Input value={d.table || ''} onChange={(_, v) => onPatch({ table: v.value, label: d.schema ? `${d.schema}.${v.value}` : v.value })} /></Field>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{availableColumns.length} column{availableColumns.length === 1 ? '' : 's'} resolved.</Caption1>
        </>
      )}

      {d.kind === 'filter' && (
        <Field label="WHERE condition" hint="The one freeform slot — e.g. [amount] > 1000 AND [status] = 'paid'">
          <MonacoTextarea value={d.whereExpression || ''} onChange={(v) => onPatch({ whereExpression: v })} language={dialect} height={80} lineNumbers={false} ariaLabel="WHERE condition" />
        </Field>
      )}

      {d.kind === 'select-columns' && (
        <>
          <Label size="small">Columns to keep</Label>
          {availableColumns.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No columns resolved yet — select the source table to load its columns.</Caption1>}
          <div className={s.checkList}>
            {availableColumns.map((c) => (
              <Checkbox key={c} label={c} checked={(d.columns || []).includes(c)}
                onChange={(_, data) => {
                  const set = new Set(d.columns || []);
                  if (data.checked) set.add(c); else set.delete(c);
                  onPatch({ columns: Array.from(set) });
                }} />
            ))}
          </div>
        </>
      )}

      {d.kind === 'keep-top-rows' && (
        <Field label="Number of rows">
          <SpinButton min={1} max={100000} value={d.topN ?? 100} onChange={(_, data) => onPatch({ topN: data.value ?? Number(data.displayValue) ?? 100 })} aria-label="Top N rows" />
        </Field>
      )}

      {d.kind === 'group-by' && (
        <GroupByForm d={d} availableColumns={availableColumns} onPatch={onPatch} s={s} />
      )}

      {d.kind === 'sort' && (
        <SortForm d={d} availableColumns={availableColumns} onPatch={onPatch} s={s} />
      )}

      {d.kind === 'join' && (
        <>
          <Field label="Join kind">
            <Dropdown value={d.joinKind || 'INNER'} selectedOptions={[d.joinKind || 'INNER']}
              onOptionSelect={(_, data) => onPatch({ joinKind: (data.optionValue as VqJoinKind) || 'INNER' })}>
              {VQ_JOIN_KINDS.map((k) => <Option key={k} value={k}>{k}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Left key" hint={leftColumns.length ? undefined : 'Resolve the left chain table columns first'}>
            <Dropdown value={d.leftKey || ''} selectedOptions={d.leftKey ? [d.leftKey] : []} placeholder="Left column"
              onOptionSelect={(_, data) => onPatch({ leftKey: data.optionValue })}>
              {leftColumns.map((c) => <Option key={c} value={c}>{c}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Right key" hint={rightColumns.length ? undefined : 'Resolve the right chain table columns first'}>
            <Dropdown value={d.rightKey || ''} selectedOptions={d.rightKey ? [d.rightKey] : []} placeholder="Right column"
              onOptionSelect={(_, data) => onPatch({ rightKey: data.optionValue })}>
              {rightColumns.map((c) => <Option key={c} value={c}>{c}</Option>)}
            </Dropdown>
          </Field>
        </>
      )}

      <Divider />
      <Button icon={<Delete20Regular />} appearance="subtle" onClick={onDelete}>Remove step</Button>
    </div>
  );
}

function GroupByForm({
  d, availableColumns, onPatch, s,
}: {
  d: VqNodeData;
  availableColumns: string[];
  onPatch: (patch: Partial<VqNodeData>) => void;
  s: ReturnType<typeof useStyles>;
}) {
  const aggs = d.aggregates || [];
  const updateAgg = (i: number, patch: Partial<VqAggSpec>) => onPatch({ aggregates: aggs.map((a, j) => j === i ? { ...a, ...patch } : a) });
  const addAgg = () => onPatch({ aggregates: [...aggs, { func: 'SUM', field: availableColumns[0] || '', alias: '' }] });
  const removeAgg = (i: number) => onPatch({ aggregates: aggs.filter((_, j) => j !== i) });
  return (
    <>
      <Label size="small">Group by columns</Label>
      {availableColumns.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No columns resolved yet — select the source table.</Caption1>}
      <div className={s.checkList}>
        {availableColumns.map((c) => (
          <Checkbox key={c} label={c} checked={(d.groupBy || []).includes(c)}
            onChange={(_, data) => {
              const set = new Set(d.groupBy || []);
              if (data.checked) set.add(c); else set.delete(c);
              onPatch({ groupBy: Array.from(set) });
            }} />
        ))}
      </div>
      <Divider />
      <Label size="small">Aggregations</Label>
      {aggs.map((a, i) => (
        <div key={i} className={s.aggRow}>
          <Dropdown style={{ minWidth: 96 }} value={a.func} selectedOptions={[a.func]} aria-label={`Aggregation ${i + 1} function`}
            onOptionSelect={(_, data) => updateAgg(i, { func: (data.optionValue as VqAggFunc) || 'SUM' })}>
            {VQ_AGG_FUNCS.map((f) => <Option key={f} value={f}>{f}</Option>)}
          </Dropdown>
          <Dropdown style={{ minWidth: 0, flex: 1 }} value={a.field} selectedOptions={a.field ? [a.field] : []} placeholder="column" aria-label={`Aggregation ${i + 1} column`}
            onOptionSelect={(_, data) => updateAgg(i, { field: data.optionValue || '' })}>
            <Option value="*">* (all)</Option>
            {availableColumns.map((c) => <Option key={c} value={c}>{c}</Option>)}
          </Dropdown>
          <Input style={{ minWidth: 0, flex: 1 }} placeholder="alias" value={a.alias} onChange={(_, data) => updateAgg(i, { alias: data.value })} aria-label={`Aggregation ${i + 1} alias`} />
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => removeAgg(i)} aria-label={`Remove aggregation ${i + 1}`} />
        </div>
      ))}
      <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={addAgg}>Add aggregation</Button>
    </>
  );
}

/**
 * SortForm — the "Sort rows" (ORDER BY) applied step. Every input is a guided
 * control (a column picker + an ASC/DESC dropdown per sort key) — no freeform
 * SQL, per no-freeform-config. Multiple keys compose a multi-column ORDER BY.
 */
function SortForm({
  d, availableColumns, onPatch, s,
}: {
  d: VqNodeData;
  availableColumns: string[];
  onPatch: (patch: Partial<VqNodeData>) => void;
  s: ReturnType<typeof useStyles>;
}) {
  const keys = d.sortKeys || [];
  const updateKey = (i: number, patch: Partial<VqSortKey>) =>
    onPatch({ sortKeys: keys.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const addKey = () =>
    onPatch({ sortKeys: [...keys, { field: availableColumns[0] || '', dir: 'ASC' as VqSortDir }] });
  const removeKey = (i: number) => onPatch({ sortKeys: keys.filter((_, j) => j !== i) });
  return (
    <>
      <Label size="small">Sort by</Label>
      {availableColumns.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          No columns resolved yet — select the source table.
        </Caption1>
      )}
      {keys.map((k, i) => (
        <div key={i} className={s.aggRow}>
          <Dropdown
            style={{ minWidth: 0, flex: 1 }}
            value={k.field}
            selectedOptions={k.field ? [k.field] : []}
            placeholder="column"
            aria-label={`Sort key ${i + 1} column`}
            onOptionSelect={(_, data) => updateKey(i, { field: data.optionValue || '' })}
          >
            {availableColumns.map((c) => <Option key={c} value={c}>{c}</Option>)}
          </Dropdown>
          <Dropdown
            style={{ minWidth: 96 }}
            value={k.dir}
            selectedOptions={[k.dir]}
            aria-label={`Sort key ${i + 1} direction`}
            onOptionSelect={(_, data) => updateKey(i, { dir: (data.optionValue as VqSortDir) || 'ASC' })}
          >
            {VQ_SORT_DIRS.map((dir) => <Option key={dir} value={dir}>{dir}</Option>)}
          </Dropdown>
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => removeKey(i)} aria-label={`Remove sort key ${i + 1}`} />
        </div>
      ))}
      <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={addKey}>Add sort column</Button>
    </>
  );
}

// ============================================================
// Public wrapper
// ============================================================

export function VisualQueryCanvas(props: VisualQueryCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
