'use client';

/**
 * WarpTransformCanvas — the editable visual transform builder for Warp.
 *
 * What it is (Wave-3): a drag-drop @xyflow/react canvas where a user composes a
 * transform graph — Source node(s) → Transform node(s) → Sink node — entirely
 * by hand. Add nodes from the palette, wire them with edges, move/delete them,
 * and configure each node through guided controls (no raw JSON). The graph
 * compiles LIVE to T-SQL / Spark SQL with the SAME pure compiler
 * (lib/editors/visual-query-compiler.ts:compileGraph) the engine-bound editor
 * and the run route use, so the synced "Code" tab is a faithful preview.
 *
 * What was there before: the Warp hub only rendered a read-only worked example
 * (a fixed DEMO_GRAPH) compiled to SQL. There was no canvas to edit, no node
 * palette, no wizards, and no run wiring at the hub level.
 *
 * Real backend (no-vaporware): Validate compiles server-side via the run route;
 * Preview/Run POST the graph to the EXISTING, real
 * /api/items/[engine]/[id]/visual-query route, which executes the compiled SQL
 * against the live Synapse TDS / Databricks REST endpoint and returns real
 * rows. Save persists the definition to Cosmos via
 * /api/experience/warp/transforms. If no SQL engine is configured the run route
 * returns a precise env-var gate, surfaced here as a MessageBar.
 *
 * No-fabric-dependency: every target is Azure-native (Synapse Dedicated /
 * Serverless, Databricks SQL warehouse, warehouse / lakehouse-SQL-endpoint).
 * Never Fabric / OneLake / Power BI.
 *
 * No-freeform-config: every node input is a guided control (column pickers,
 * type dropdowns, aggregate dropdowns). The only freeform slots are the
 * explicitly-allowed 1:1 expression boxes — the Filter WHERE and each Derive
 * column expression — mirroring the engine-bound canvas.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  useReactFlow, useNodesState, useEdgesState, useNodesInitialized, Handle, Position,
  type Node, type Edge, type NodeProps, type NodeTypes, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Button, Badge, Caption1, Label, Field, Input, Dropdown, Option, SpinButton,
  Checkbox, Divider, Spinner, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  MessageBar, MessageBarBody, MessageBarTitle, Switch, TabList, Tab,
  DataGrid, DataGridHeader, DataGridRow, DataGridHeaderCell, DataGridCell, DataGridBody,
  createTableColumn, type TableColumnDefinition,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Text, Body1,
  makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Play20Regular, Table20Regular,
  Filter20Regular, ColumnTriple20Regular, GroupList20Regular, BranchFork20Regular,
  ArrowSortDown20Regular, TextSortAscending20Regular,
  CalculatorMultiple20Regular, Rename20Regular, TextNumberFormat20Regular,
  Broom20Regular, Channel20Regular, TableArrowUp20Regular,
  Save20Regular, CheckmarkCircle20Regular, Sparkle20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  compileGraph,
  VQ_JOIN_KINDS, VQ_AGG_FUNCS, VQ_SORT_DIRS,
  VQ_CAST_TYPES_TSQL, VQ_CAST_TYPES_SPARK,
  type VqGraph, type VqNode, type VqStepKind, type VqJoinKind,
  type VqAggFunc, type VqAggSpec, type VqSortKey, type VqSortDir,
  type VqDeriveColumn, type VqRenameMap, type VqCastSpec, type VqCastType,
  type VqSinkConfig, type VqSinkMode, type SqlDialect,
} from '@/lib/editors/visual-query-compiler';
import { STARTER_PATTERNS, buildStarterGraph, type StarterPatternId } from './warp-transform-starters';

// ============================================================
// Types
// ============================================================

export interface WarpRunTarget {
  id: string;
  label: string;
  engine: 'warehouse' | 'synapse-dedicated-sql-pool' | 'synapse-serverless-sql-pool' | 'databricks-sql-warehouse';
  dialect: SqlDialect;
  workspaceId?: string;
}

export interface WarpWorkspaceOption { id: string; name: string }

export interface WarpTransformCanvasProps {
  targets: WarpRunTarget[];
  workspaces: WarpWorkspaceOption[];
  /** Optional initial graph (when editing a saved transform). */
  initialGraph?: VqGraph;
  initialName?: string;
  initialTransformId?: string;
  initialTarget?: WarpRunTarget | null;
}

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
  gate?: { reason?: string; remediation?: string; sql?: string };
}

interface ResultGridRow { __id: number; cells: unknown[] }

type WarpView = 'canvas' | 'code';

// ============================================================
// Styles
// ============================================================

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  toolbarSpacer: { flex: 1 },
  body: { display: 'grid', gridTemplateColumns: '1fr 340px', gap: tokens.spacingHorizontalL },
  canvas: {
    position: 'relative',
    // Definite height (NOT 100%) so React Flow measures a real container on
    // first paint and fitView frames the graph — the #1480 sizing fix.
    height: '520px', minHeight: '460px',
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    overflow: 'hidden',
  },
  palette: {
    display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap',
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalXS),
    maxWidth: '560px',
  },
  inspector: {
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    // Flex/scroll to fit: a tall node form (e.g. Group-by with many aggregates,
    // or Join with two column pickers) no longer clips. The inspector grows
    // with its content but never exceeds the canvas height, scrolling within
    // when it would, instead of hard-clipping at a fixed 520px.
    minHeight: '460px', maxHeight: '520px', overflowY: 'auto',
  },
  empty: {
    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: tokens.spacingVerticalM,
    pointerEvents: 'none', color: tokens.colorNeutralForeground3, zIndex: 1, textAlign: 'center', padding: tokens.spacingHorizontalXXL,
  },
  emptyActions: { display: 'flex', gap: tokens.spacingHorizontalS, pointerEvents: 'auto', flexWrap: 'wrap', justifyContent: 'center' },
  tableWrap: {
    overflow: 'auto', maxHeight: '300px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  cell: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap', maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis' },
  nullCell: { color: tokens.colorNeutralForeground4, fontStyle: 'italic' },
  aggRow: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' },
  checkList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, maxHeight: '170px', overflowY: 'auto', paddingLeft: '2px' },
  wizardCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground1, cursor: 'pointer', textAlign: 'left',
    ':hover': { ...shorthands.borderColor(tokens.colorBrandStroke1), boxShadow: tokens.shadow4 },
  },
  wizardGrid: { display: 'grid', gap: tokens.spacingHorizontalM, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' },
});

// ============================================================
// Node colours + icons
// ============================================================

// Node accent colours: source uses the brand blue token; transform/join/sink keep
// their vivid hex values — no Fluent v9 "solid vivid" palette tokens exist for
// purple (#7719aa), green (#107c10), or red (#c50f1f) that would preserve the
// same luminosity as the Background2 variants, so they are left as literals.
const STEP_COLOR: Record<VqStepKind, string> = {
  source: tokens.colorBrandBackground,
  filter: '#7719aa', 'select-columns': '#7719aa', 'keep-top-rows': '#7719aa',
  'group-by': '#7719aa', sort: '#7719aa', derive: '#7719aa', rename: '#7719aa',
  cast: '#7719aa', dedup: '#7719aa',
  join: '#107c10', union: '#107c10',
  sink: '#c50f1f',
};

function stepIcon(kind: VqStepKind) {
  switch (kind) {
    case 'source': return <Table20Regular />;
    case 'filter': return <Filter20Regular />;
    case 'select-columns': return <ColumnTriple20Regular />;
    case 'keep-top-rows': return <ArrowSortDown20Regular />;
    case 'group-by': return <GroupList20Regular />;
    case 'sort': return <TextSortAscending20Regular />;
    case 'derive': return <CalculatorMultiple20Regular />;
    case 'rename': return <Rename20Regular />;
    case 'cast': return <TextNumberFormat20Regular />;
    case 'dedup': return <Broom20Regular />;
    case 'join': return <BranchFork20Regular />;
    case 'union': return <Channel20Regular />;
    case 'sink': return <TableArrowUp20Regular />;
    default: return <Table20Regular />;
  }
}

const STEP_LABEL: Record<VqStepKind, string> = {
  source: 'Source',
  filter: 'Filter rows', 'select-columns': 'Select columns', 'keep-top-rows': 'Keep top rows',
  'group-by': 'Group by', sort: 'Sort rows', derive: 'Derive column', rename: 'Rename',
  cast: 'Cast type', dedup: 'Remove duplicates',
  join: 'Join', union: 'Union',
  sink: 'Sink (target)',
};

const HANDLE: React.CSSProperties = { width: 11, height: 11, borderRadius: '50%', zIndex: 3 };
const TWO_INPUT = new Set<VqStepKind>(['join', 'union']);

function WarpNodeImpl({ data, selected }: NodeProps) {
  const d = data as unknown as VqNodeData;
  const color = STEP_COLOR[d.kind] || '#7719aa';
  const twoIn = TWO_INPUT.has(d.kind);
  const isSink = d.kind === 'sink';
  return (
    <div
      data-warp-kind={d.kind}
      aria-label={`${d.kind} ${d.label}`}
      style={{
        position: 'relative', width: 190, padding: `10px ${tokens.spacingHorizontalM}`, borderRadius: 6,
        background: tokens.colorNeutralBackground1,
        border: `1px solid ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        boxShadow: selected ? `0 0 0 2px ${tokens.colorBrandBackground2}` : '0 1px 2px rgba(0,0,0,0.06)',
        display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-start', cursor: 'pointer', userSelect: 'none',
      }}
    >
      {d.kind !== 'source' && !twoIn && (
        <Handle id="in" type="target" position={Position.Left} style={{ ...HANDLE, left: -6, top: '50%', background: tokens.colorNeutralBackground1, border: `2px solid ${tokens.colorBrandStroke1}` }} />
      )}
      {twoIn && (
        <>
          <Handle id="in-left" type="target" position={Position.Left} style={{ ...HANDLE, left: -6, top: '34%', background: tokens.colorNeutralBackground1, border: `2px solid ${tokens.colorBrandStroke1}` }} />
          <Handle id="in-right" type="target" position={Position.Left} style={{ ...HANDLE, left: -6, top: '70%', background: tokens.colorNeutralBackground1, border: `2px solid ${color}` }} />
        </>
      )}
      {!isSink && (
        <Handle id="out" type="source" position={Position.Right} style={{ ...HANDLE, right: -6, top: '50%', background: tokens.colorNeutralBackground1, border: `2px solid ${color}` }} />
      )}
      <div style={{ width: 6, alignSelf: 'stretch', borderRadius: 2, background: color }} />
      <div style={{ color, display: 'flex', alignItems: 'center', flexShrink: 0 }}>{stepIcon(d.kind)}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: tokens.colorNeutralForeground1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label}</div>
        <Badge appearance="filled" size="small" style={{ backgroundColor: color, color: tokens.colorNeutralForegroundInverted, alignSelf: 'flex-start' }}>{STEP_LABEL[d.kind]}</Badge>
      </div>
    </div>
  );
}
const WarpNode = memo(WarpNodeImpl);
const warpNodeTypes: NodeTypes = { warp: WarpNode };

// ============================================================
// Graph <-> React Flow helpers
// ============================================================

function buildGraph(nodes: Node[], edges: Edge[], outputId?: string): VqGraph {
  const vqNodes: VqNode[] = nodes.map((n) => {
    const d = n.data as unknown as VqNodeData;
    const inbound = edges.filter((e) => e.target === n.id);
    let inputs: string[];
    if (TWO_INPUT.has(d.kind)) {
      const left = inbound.find((e) => e.targetHandle === 'in-left')?.source;
      const right = inbound.find((e) => e.targetHandle === 'in-right')?.source;
      inputs = [left, right].filter(Boolean) as string[];
    } else {
      inputs = inbound.map((e) => e.source);
    }
    return {
      id: n.id, kind: d.kind, inputs,
      schema: d.schema, table: d.table, whereExpression: d.whereExpression,
      columns: d.columns, topN: d.topN, groupBy: d.groupBy, aggregates: d.aggregates,
      sortKeys: d.sortKeys, joinKind: d.joinKind, leftKey: d.leftKey, rightKey: d.rightKey,
      derived: d.derived, renames: d.renames, casts: d.casts, dedupKeys: d.dedupKeys,
      unionAll: d.unionAll, sink: d.sink,
    };
  });
  return { nodes: vqNodes, outputId };
}

/** React Flow node from a VqNode (used when laying down a starter graph). */
function rfNodeFromVq(n: VqNode, x: number, y: number): Node {
  const { id, kind, inputs, ...rest } = n;
  return {
    id, type: 'warp', position: { x, y },
    data: { kind, label: rest.table ? (rest.schema ? `${rest.schema}.${rest.table}` : rest.table) : STEP_LABEL[kind], ...rest } as unknown as Record<string, unknown>,
  };
}

function leafIds(nodes: Node[], edges: Edge[]): string[] {
  const consumed = new Set(edges.map((e) => e.source));
  return nodes.filter((n) => !consumed.has(n.id)).map((n) => n.id);
}

let seq = 0;
function nextId(prefix: string) { seq += 1; return `${prefix}_${Date.now().toString(36)}_${seq}`; }

const FIT_OPTS = { padding: 0.2, minZoom: 0.2, maxZoom: 1.5 } as const;

/** Re-fit once node sizes are measured (the #1480 fitView-on-init fix). */
function FitViewOnInit({ deps }: { deps: unknown }): null {
  const inited = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!inited) return;
    const raf = requestAnimationFrame(() => { void fitView(FIT_OPTS); });
    return () => cancelAnimationFrame(raf);
  }, [inited, fitView, deps]);
  return null;
}

// ============================================================
// Component
// ============================================================

function CanvasInner(props: WarpTransformCanvasProps) {
  const { targets, workspaces } = props;
  const s = useStyles();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(
    props.initialGraph ? props.initialGraph.nodes.map((n, i) => rfNodeFromVq(n, 40 + (i % 4) * 230, 40 + Math.floor(i / 4) * 130)) : [],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    props.initialGraph ? edgesFromGraph(props.initialGraph) : [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<WarpView>('canvas');

  const [target, setTarget] = useState<WarpRunTarget | null>(props.initialTarget || targets[0] || null);
  const dialect: SqlDialect = target?.dialect || 'sparksql';

  const [columnsByNode, setColumnsByNode] = useState<Record<string, string[]>>({});
  const [colError, setColError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addSchema, setAddSchema] = useState('');
  const [addTable, setAddTable] = useState('');

  const [wizardOpen, setWizardOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState(props.initialName || '');
  const [saveWs, setSaveWs] = useState(props.initialTarget?.workspaceId || workspaces[0]?.id || '');
  const [transformId, setTransformId] = useState<string | undefined>(props.initialTransformId);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [validateMsg, setValidateMsg] = useState<string | null>(null);

  const layoutCounter = useRef(props.initialGraph?.nodes.length || 0);

  const outputId = useMemo(() => {
    const leaves = leafIds(nodes, edges);
    return leaves[leaves.length - 1];
  }, [nodes, edges]);

  const generatedSql = useMemo(() => {
    if (!nodes.length) return '-- Add a source to start building a transform.';
    return compileGraph(buildGraph(nodes, edges, outputId), dialect);
  }, [nodes, edges, outputId, dialect]);

  // ---- describe (column discovery) against the chosen target ----
  const fetchColumns = useCallback(async (nodeId: string, schema: string | undefined, table: string) => {
    if (!target) { setColError('Pick a run target to resolve table columns.'); return; }
    setColError(null);
    try {
      const r = await fetch(`/api/items/${target.engine}/${encodeURIComponent(target.id)}/visual-query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dialect: target.dialect, describe: { schema, table } }),
      });
      const j = await r.json();
      if (j.ok && Array.isArray(j.columns)) {
        setColumnsByNode((prev) => ({ ...prev, [nodeId]: j.columns }));
      } else {
        setColError(j.error || j.gate?.reason || 'Could not resolve columns for this table.');
      }
    } catch (e: any) {
      setColError(e?.message || String(e));
    }
  }, [target]);

  const addSource = useCallback((schema: string | undefined, table: string) => {
    const nid = nextId('src');
    const idx = layoutCounter.current++;
    setNodes((ns) => [...ns, {
      id: nid, type: 'warp',
      position: { x: 24, y: 24 + idx * 120 },
      data: { kind: 'source', label: schema ? `${schema}.${table}` : table, schema, table } as unknown as Record<string, unknown>,
    }]);
    setSelectedId(nid);
    void fetchColumns(nid, schema, table);
  }, [setNodes, fetchColumns]);

  const addStep = useCallback((kind: Exclude<VqStepKind, 'source' | 'join' | 'union'>) => {
    const leaves = leafIds(nodes, edges);
    const parent = (selectedId && nodes.some((n) => n.id === selectedId)) ? selectedId : leaves[leaves.length - 1];
    if (!parent) { setColError('Add a source first, then add transform steps.'); return; }
    const parentNode = nodes.find((n) => n.id === parent)!;
    const nid = nextId(kind);
    const defaults: Partial<VqNodeData> = {};
    if (kind === 'keep-top-rows') defaults.topN = 100;
    if (kind === 'group-by') { defaults.groupBy = []; defaults.aggregates = []; }
    if (kind === 'select-columns') defaults.columns = [];
    if (kind === 'sort') defaults.sortKeys = [];
    if (kind === 'filter') defaults.whereExpression = '';
    if (kind === 'derive') defaults.derived = [{ name: '', expression: '' }];
    if (kind === 'rename') defaults.renames = [{ from: '', to: '' }];
    if (kind === 'cast') defaults.casts = [];
    if (kind === 'dedup') defaults.dedupKeys = [];
    if (kind === 'sink') defaults.sink = { mode: 'table', table: '' };
    setNodes((ns) => [...ns, {
      id: nid, type: 'warp',
      position: { x: parentNode.position.x + 240, y: parentNode.position.y },
      data: { kind, label: STEP_LABEL[kind], ...defaults } as unknown as Record<string, unknown>,
    }]);
    setEdges((es) => [...es, { id: `${parent}->${nid}`, source: parent, target: nid, targetHandle: 'in', type: 'default', markerEnd: { type: 'arrowclosed' as any } }]);
    setSelectedId(nid);
  }, [nodes, edges, selectedId, setNodes, setEdges]);

  const addTwoInput = useCallback((kind: 'join' | 'union', joinKind?: VqJoinKind) => {
    const leaves = leafIds(nodes, edges);
    if (leaves.length < 2) { setColError(`${kind === 'join' ? 'Join' : 'Union'} needs two chains — add a second source first.`); return; }
    const left = leaves[leaves.length - 2];
    const right = leaves[leaves.length - 1];
    const leftNode = nodes.find((n) => n.id === left)!;
    const nid = nextId(kind);
    const data: Partial<VqNodeData> = kind === 'join'
      ? { joinKind: joinKind || 'INNER', leftKey: '', rightKey: '' }
      : { unionAll: true };
    setNodes((ns) => [...ns, {
      id: nid, type: 'warp',
      position: { x: leftNode.position.x + 260, y: leftNode.position.y + 40 },
      data: { kind, label: STEP_LABEL[kind], ...data } as unknown as Record<string, unknown>,
    }]);
    setEdges((es) => [...es,
      { id: `${left}->${nid}-l`, source: left, target: nid, targetHandle: 'in-left', type: 'default', markerEnd: { type: 'arrowclosed' as any } },
      { id: `${right}->${nid}-r`, source: right, target: nid, targetHandle: 'in-right', type: 'default', markerEnd: { type: 'arrowclosed' as any } },
    ]);
    setSelectedId(nid);
  }, [nodes, edges, setNodes, setEdges]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    const targetHandle = c.targetHandle || 'in';
    setEdges((es) => {
      const filtered = es.filter((e) => !(e.target === c.target && e.targetHandle === targetHandle));
      return [...filtered, { id: `${c.source}->${c.target}-${targetHandle}`, source: c.source!, target: c.target!, targetHandle, type: 'default', markerEnd: { type: 'arrowclosed' as any } }];
    });
  }, [setEdges]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setColumnsByNode((prev) => { const next = { ...prev }; delete next[selectedId]; return next; });
    setSelectedId(null);
  }, [selectedId, setNodes, setEdges]);

  const patchSelected = useCallback((patch: Partial<VqNodeData>) => {
    if (!selectedId) return;
    setNodes((ns) => ns.map((n) => n.id === selectedId
      ? { ...n, data: { ...(n.data as object), ...patch } as Record<string, unknown> }
      : n));
  }, [selectedId, setNodes]);

  const handleNodeClick = useCallback((_: unknown, n: Node) => setSelectedId(n.id), []);
  const renderNodes = useMemo(() => nodes.map((n) => ({ ...n, selected: n.id === selectedId })), [nodes, selectedId]);

  // ---- upstream columns available to a node (for pickers) ----
  const resolveColumns = useCallback((nodeId: string): string[] => {
    const seen = new Set<string>();
    const out = new Set<string>();
    const walk = (nid: string) => {
      if (seen.has(nid)) return;
      seen.add(nid);
      const node = nodes.find((n) => n.id === nid);
      if (!node) return;
      const d = node.data as unknown as VqNodeData;
      if (d.kind === 'source') { (columnsByNode[nid] || []).forEach((c) => out.add(c)); return; }
      if (d.kind === 'select-columns' && d.columns?.length) { d.columns.forEach((c) => out.add(c)); return; }
      if (d.kind === 'rename' && d.renames?.length) d.renames.forEach((m) => { if (m.to) out.add(m.to); });
      if (d.kind === 'derive' && d.derived?.length) d.derived.forEach((c) => { if (c.name) out.add(c.name); });
      edges.filter((e) => e.target === nid).map((e) => e.source).forEach(walk);
    };
    walk(nodeId);
    return Array.from(out);
  }, [nodes, edges, columnsByNode]);

  const inputColumns = useCallback((nodeId: string, handle: 'in-left' | 'in-right'): string[] => {
    const src = edges.find((e) => e.target === nodeId && e.targetHandle === handle)?.source;
    return src ? resolveColumns(src) : [];
  }, [edges, resolveColumns]);

  // ---- run / preview / validate (real backend) ----
  const callRun = useCallback(async (mode: 'run' | 'validate') => {
    if (!nodes.length || !target) return;
    setRunning(true); setResult(null); setValidateMsg(null);
    try {
      // For Validate, attach a top-1 cap so the engine compiles + plans cheaply.
      const r = await fetch(`/api/items/${target.engine}/${encodeURIComponent(target.id)}/visual-query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dialect: target.dialect, graph: buildGraph(nodes, edges, outputId) }),
      });
      const j = (await r.json()) as RunResult;
      if (mode === 'validate') {
        setValidateMsg(j.ok ? `Compiled + executed against ${target.label}: ${j.rowCount ?? 0} rows, ${j.executionMs ?? '?'} ms.` : (j.error || j.gate?.reason || 'Validation failed.'));
        if (!j.ok) setResult(j);
      } else {
        setResult(j);
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (mode === 'validate') setValidateMsg(msg); else setResult({ ok: false, error: msg });
    } finally {
      setRunning(false);
    }
  }, [nodes, edges, outputId, target]);

  // ---- save to Cosmos ----
  const save = useCallback(async () => {
    if (!saveName.trim() || !saveWs) { setSaveMsg('Name and workspace are required.'); return; }
    setSaving(true); setSaveMsg(null);
    try {
      const r = await fetch('/api/experience/warp/transforms', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: transformId, displayName: saveName.trim(), workspaceId: saveWs,
          graph: buildGraph(nodes, edges, outputId), target, dialect,
        }),
      });
      const j = await r.json();
      if (j.ok) { setTransformId(j.transform.id); setSaveMsg('Saved.'); setTimeout(() => setSaveOpen(false), 600); }
      else setSaveMsg(j.error || 'Save failed.');
    } catch (e: any) {
      setSaveMsg(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [saveName, saveWs, transformId, nodes, edges, outputId, target, dialect]);

  // ---- apply a starter wizard pattern ----
  const applyStarter = useCallback((id: StarterPatternId) => {
    const g = buildStarterGraph(id);
    const rfNodes = g.nodes.map((n, i) => rfNodeFromVq(n, 40 + (i % 4) * 235, 40 + Math.floor(i / 4) * 135));
    setNodes(rfNodes);
    setEdges(edgesFromGraph(g));
    setColumnsByNode({});
    setSelectedId(null);
    layoutCounter.current = g.nodes.length;
    setWizardOpen(false);
    // Resolve columns for each source.
    g.nodes.filter((n) => n.kind === 'source' && n.table).forEach((n) => void fetchColumns(n.id, n.schema, n.table!));
  }, [setNodes, setEdges, fetchColumns]);

  const selectedNode = nodes.find((n) => n.id === selectedId) || null;
  const castTypes = dialect === 'tsql' ? VQ_CAST_TYPES_TSQL : VQ_CAST_TYPES_SPARK;

  // ---- result grid ----
  const resultCols = result?.ok ? (result.columns || []) : [];
  const resultRows = result?.ok ? (result.rows || []) : [];
  const gridRows = useMemo<ResultGridRow[]>(() => resultRows.map((cells, idx) => ({ __id: idx, cells })), [resultRows]);
  const gridColumns = useMemo<TableColumnDefinition<ResultGridRow>[]>(() =>
    resultCols.map((colName, colIdx) => createTableColumn<ResultGridRow>({
      columnId: `c${colIdx}`,
      renderHeaderCell: () => colName,
      renderCell: (row) => {
        const v = row.cells[colIdx];
        const display = v === null || v === undefined ? 'NULL' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        return <span className={v === null || v === undefined ? `${s.cell} ${s.nullCell}` : s.cell} title={display}>{display}</span>;
      },
    })), [resultCols, s]);

  return (
    <div className={s.root}>
      {/* Top toolbar: target picker + view tabs + actions */}
      <div className={s.toolbar}>
        <Label weight="semibold">Run target</Label>
        <Dropdown
          style={{ minWidth: 280 }}
          value={target?.label || 'Select a target engine'}
          selectedOptions={target ? [`${target.engine}|${target.id}`] : []}
          onOptionSelect={(_, d) => {
            const [, eid] = (d.optionValue || '').split('|');
            const next = targets.find((t) => `${t.engine}|${t.id}` === d.optionValue) || null;
            void eid; setTarget(next); setColumnsByNode({});
          }}
          aria-label="Run target engine"
        >
          {targets.length === 0 && <Option value="" disabled>No SQL engine configured</Option>}
          {targets.map((t) => (
            <Option key={`${t.engine}|${t.id}`} value={`${t.engine}|${t.id}`} text={t.label}>{t.label}</Option>
          ))}
        </Dropdown>
        <Badge appearance="outline">{dialect === 'tsql' ? 'T-SQL' : 'Spark SQL'}</Badge>
        <div className={s.toolbarSpacer} />
        <Button icon={<Sparkle20Regular />} appearance="secondary" onClick={() => setWizardOpen(true)}>New from pattern</Button>
        <Button icon={<CheckmarkCircle20Regular />} appearance="secondary" disabled={!nodes.length || !target || running} onClick={() => void callRun('validate')}>Validate</Button>
        <Button icon={running ? <Spinner size="tiny" /> : <Play20Regular />} appearance="primary" disabled={!nodes.length || !target || running} onClick={() => void callRun('run')}>{running ? 'Running…' : 'Run / Preview'}</Button>
        <Button icon={<Save20Regular />} appearance="secondary" disabled={!nodes.length} onClick={() => { setSaveMsg(null); setSaveOpen(true); }}>Save</Button>
      </div>

      <TabList selectedValue={view} onTabSelect={(_, d) => setView(d.value as WarpView)}>
        <Tab value="canvas" icon={<BranchFork20Regular />}>Visual canvas</Tab>
        <Tab value="code" icon={<ColumnTriple20Regular />}>Code ({dialect === 'tsql' ? 'T-SQL' : 'Spark SQL'})</Tab>
      </TabList>

      {validateMsg && (
        <MessageBar intent={validateMsg.startsWith('Compiled') ? 'success' : 'warning'}>
          <MessageBarBody>{validateMsg}</MessageBarBody>
        </MessageBar>
      )}
      {targets.length === 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No SQL engine configured</MessageBarTitle>
            Create a warehouse or lakehouse, or set <code>LOOM_SYNAPSE_WORKSPACE</code> (Synapse) / a Databricks SQL warehouse, to run transforms against a live Azure-native backend. You can still build and save the graph.
          </MessageBarBody>
        </MessageBar>
      )}

      {view === 'canvas' ? (
        <div className={s.body}>
          <div className={s.canvas} data-canvas="warp-transform">
            <ReactFlow
              nodes={renderNodes}
              edges={edges}
              nodeTypes={warpNodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={handleNodeClick}
              onPaneClick={() => setSelectedId(null)}
              minZoom={0.2}
              maxZoom={2}
              fitView
              fitViewOptions={FIT_OPTS}
              proOptions={{ hideAttribution: true }}
              deleteKeyCode={null}
            >
              <FitViewOnInit deps={nodes.length} />
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tokens.colorNeutralStroke2} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable style={{ backgroundColor: tokens.colorNeutralBackground1 }} />
              <Panel position="top-left">
                <div className={s.palette} role="toolbar" aria-label="Transform nodes">
                  <Button size="small" icon={<Add20Regular />} appearance="primary" onClick={() => { setAddTable(''); setAddSchema(''); setAddOpen(true); }} data-warp-action="add-source">Source</Button>
                  <Button size="small" icon={<Filter20Regular />} onClick={() => addStep('filter')} data-warp-action="filter">Filter</Button>
                  <Button size="small" icon={<ColumnTriple20Regular />} onClick={() => addStep('select-columns')} data-warp-action="select">Select</Button>
                  <Button size="small" icon={<CalculatorMultiple20Regular />} onClick={() => addStep('derive')} data-warp-action="derive">Derive</Button>
                  <Button size="small" icon={<GroupList20Regular />} onClick={() => addStep('group-by')} data-warp-action="group-by">Aggregate</Button>
                  <Button size="small" icon={<Rename20Regular />} onClick={() => addStep('rename')} data-warp-action="rename">Rename</Button>
                  <Button size="small" icon={<TextNumberFormat20Regular />} onClick={() => addStep('cast')} data-warp-action="cast">Cast</Button>
                  <Button size="small" icon={<Broom20Regular />} onClick={() => addStep('dedup')} data-warp-action="dedup">Dedup</Button>
                  <Button size="small" icon={<TextSortAscending20Regular />} onClick={() => addStep('sort')} data-warp-action="sort">Sort</Button>
                  <Button size="small" icon={<ArrowSortDown20Regular />} onClick={() => addStep('keep-top-rows')} data-warp-action="top">Top N</Button>
                  <Menu>
                    <MenuTrigger disableButtonEnhancement>
                      <Button size="small" icon={<BranchFork20Regular />} data-warp-action="join">Join…</Button>
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        {VQ_JOIN_KINDS.map((k) => <MenuItem key={k} onClick={() => addTwoInput('join', k)}>{k} join</MenuItem>)}
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                  <Button size="small" icon={<Channel20Regular />} onClick={() => addTwoInput('union')} data-warp-action="union">Union</Button>
                  <Button size="small" icon={<TableArrowUp20Regular />} onClick={() => addStep('sink')} data-warp-action="sink">Sink</Button>
                </div>
              </Panel>
            </ReactFlow>
            {nodes.length === 0 && (
              <div className={s.empty}>
                <Caption1>Build a transform: add a <strong>Source</strong>, chain transform steps, finish with a <strong>Sink</strong>. The Code tab shows the generated SQL live.</Caption1>
                <div className={s.emptyActions}>
                  <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={() => { setAddTable(''); setAddSchema(''); setAddOpen(true); }}>Add a source</Button>
                  <Button size="small" appearance="secondary" icon={<Sparkle20Regular />} onClick={() => setWizardOpen(true)}>Start from a pattern</Button>
                </div>
              </div>
            )}
          </div>

          <aside className={s.inspector} aria-label="Node configuration">
            {colError && <MessageBar intent="warning"><MessageBarBody>{colError}</MessageBarBody></MessageBar>}
            {!selectedNode && (
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Select a node to configure it. Add sources from the palette; chain transforms; finish with a Sink to materialize a table or view.
              </Caption1>
            )}
            {selectedNode && (
              <NodeInspector
                node={selectedNode}
                dialect={dialect}
                castTypes={castTypes}
                availableColumns={resolveColumns(selectedId!)}
                leftColumns={inputColumns(selectedId!, 'in-left')}
                rightColumns={inputColumns(selectedId!, 'in-right')}
                onPatch={patchSelected}
                onDelete={deleteSelected}
                s={s}
              />
            )}
          </aside>
        </div>
      ) : (
        <MonacoTextarea value={generatedSql} onChange={() => {}} language={dialect} height={420} readOnly ariaLabel="Generated transform SQL" />
      )}

      {/* Result rendering */}
      {!running && result && !result.ok && result.code === 'sql_login_required' && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Grant the Console identity a SQL login</MessageBarTitle>
            {result.gate?.reason || result.error}
            {result.gate?.remediation && <div style={{ marginTop: 6 }}>{result.gate.remediation}</div>}
            {result.gate?.sql && <pre style={{ marginTop: tokens.spacingVerticalS, padding: tokens.spacingVerticalS, borderRadius: 6, overflowX: 'auto', fontSize: tokens.fontSizeBase200, fontFamily: tokens.fontFamilyMonospace, whiteSpace: 'pre' }}>{result.gate.sql}</pre>}
          </MessageBarBody>
        </MessageBar>
      )}
      {!running && result && !result.ok && result.code !== 'sql_login_required' && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Run failed</MessageBarTitle>{result.error || 'Unknown error'}</MessageBarBody></MessageBar>
      )}
      {!running && result?.ok && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge appearance="filled" color="success">{result.rowCount ?? resultRows.length} rows</Badge>
            {result.executionMs !== undefined && <Caption1>· {result.executionMs} ms</Caption1>}
            {result.truncated && <Badge appearance="outline" color="warning">truncated</Badge>}
          </div>
          {resultRows.length === 0 ? (
            <MessageBar intent="info"><MessageBarBody>Transform ran. No rows returned.</MessageBarBody></MessageBar>
          ) : (
            <div className={s.tableWrap} tabIndex={0}>
              <DataGrid items={gridRows} columns={gridColumns} getRowId={(item) => (item as ResultGridRow).__id} size="small" aria-label="Transform preview results">
                <DataGridHeader><DataGridRow>{({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}</DataGridRow></DataGridHeader>
                <DataGridBody<ResultGridRow>>{({ item, rowId }) => <DataGridRow<ResultGridRow> key={rowId}>{({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}</DataGridRow>}</DataGridBody>
              </DataGrid>
            </div>
          )}
        </>
      )}

      {/* Add-source dialog */}
      <Dialog open={addOpen} onOpenChange={(_, d) => setAddOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add a source table</DialogTitle>
            <DialogContent>
              <Caption1>Enter the schema and table/path. Its columns load from the run target for the step pickers.</Caption1>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Field label="Schema / catalog" style={{ flex: 1 }}>
                  <Input value={addSchema} placeholder={dialect === 'tsql' ? 'dbo' : '(optional)'} onChange={(_, d) => setAddSchema(d.value)} />
                </Field>
                <Field label="Table" style={{ flex: 1 }} required>
                  <Input value={addTable} placeholder="fact_sale" onChange={(_, d) => setAddTable(d.value)} />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button appearance="primary" disabled={!addTable.trim()} onClick={() => { addSource(addSchema.trim() || undefined, addTable.trim()); setAddOpen(false); }}>Add source</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Starter wizard */}
      <Dialog open={wizardOpen} onOpenChange={(_, d) => setWizardOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>New transform from a pattern</DialogTitle>
            <DialogContent>
              <Body1 style={{ display: 'block', marginBottom: 12, color: tokens.colorNeutralForeground2 }}>
                Lay down a starter graph so you don't begin on a blank canvas. Pick a pattern, then fill in the source tables and columns on the canvas.
              </Body1>
              <div className={s.wizardGrid}>
                {STARTER_PATTERNS.map((p) => (
                  <button key={p.id} type="button" className={s.wizardCard} onClick={() => applyStarter(p.id)}>
                    <span style={{ fontWeight: tokens.fontWeightSemibold }}>{p.title}</span>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{p.description}</Caption1>
                  </button>
                ))}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setWizardOpen(false)}>Cancel</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Save dialog */}
      <Dialog open={saveOpen} onOpenChange={(_, d) => setSaveOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{transformId ? 'Update transform' : 'Save transform'}</DialogTitle>
            <DialogContent>
              <Field label="Name" required>
                <Input value={saveName} onChange={(_, d) => setSaveName(d.value)} placeholder="Daily revenue by city" />
              </Field>
              <Field label="Workspace" required style={{ marginTop: 8 }}>
                <Dropdown
                  value={workspaces.find((w) => w.id === saveWs)?.name || ''}
                  selectedOptions={saveWs ? [saveWs] : []}
                  onOptionSelect={(_, d) => setSaveWs(d.optionValue || '')}
                  placeholder={workspaces.length ? 'Select a workspace' : 'No workspaces'}
                >
                  {workspaces.map((w) => <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>)}
                </Dropdown>
              </Field>
              {saveMsg && <Text style={{ display: 'block', marginTop: 8, color: saveMsg === 'Saved.' ? tokens.colorPaletteGreenForeground1 : tokens.colorPaletteRedForeground1 }}>{saveMsg}</Text>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setSaveOpen(false)}>Cancel</Button>
              <Button appearance="primary" icon={saving ? <Spinner size="tiny" /> : <Save20Regular />} disabled={saving || !saveName.trim() || !saveWs} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

/** Edges derived from a VqGraph's node.inputs (used for starters + loading). */
function edgesFromGraph(g: VqGraph): Edge[] {
  const out: Edge[] = [];
  for (const n of g.nodes) {
    n.inputs.forEach((src, i) => {
      const targetHandle = TWO_INPUT.has(n.kind) ? (i === 0 ? 'in-left' : 'in-right') : 'in';
      out.push({ id: `${src}->${n.id}-${targetHandle}`, source: src, target: n.id, targetHandle, type: 'default', markerEnd: { type: 'arrowclosed' as any } });
    });
  }
  return out;
}

// ============================================================
// Per-node inspector
// ============================================================

function NodeInspector({
  node, dialect, castTypes, availableColumns, leftColumns, rightColumns, onPatch, onDelete, s,
}: {
  node: Node;
  dialect: SqlDialect;
  castTypes: VqCastType[];
  availableColumns: string[];
  leftColumns: string[];
  rightColumns: string[];
  onPatch: (patch: Partial<VqNodeData>) => void;
  onDelete: () => void;
  s: ReturnType<typeof useStyles>;
}) {
  const d = node.data as unknown as VqNodeData;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Label weight="semibold">{STEP_LABEL[d.kind]}</Label>

      {d.kind === 'source' && (
        <>
          <Field label="Schema / catalog"><Input value={d.schema || ''} onChange={(_, v) => onPatch({ schema: v.value, label: v.value ? `${v.value}.${d.table}` : (d.table || '') })} /></Field>
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
        <ColumnChecklist label="Columns to keep" selected={d.columns || []} columns={availableColumns} onChange={(cols) => onPatch({ columns: cols })} s={s} />
      )}

      {d.kind === 'keep-top-rows' && (
        <Field label="Number of rows"><SpinButton min={1} max={100000} value={d.topN ?? 100} onChange={(_, data) => onPatch({ topN: data.value ?? Number(data.displayValue) ?? 100 })} aria-label="Top N rows" /></Field>
      )}

      {d.kind === 'group-by' && <GroupByForm d={d} availableColumns={availableColumns} onPatch={onPatch} s={s} />}
      {d.kind === 'sort' && <SortForm d={d} availableColumns={availableColumns} onPatch={onPatch} s={s} />}
      {d.kind === 'derive' && <DeriveForm d={d} dialect={dialect} onPatch={onPatch} s={s} />}
      {d.kind === 'rename' && <RenameForm d={d} availableColumns={availableColumns} onPatch={onPatch} s={s} />}
      {d.kind === 'cast' && <CastForm d={d} availableColumns={availableColumns} castTypes={castTypes} onPatch={onPatch} s={s} />}

      {d.kind === 'dedup' && (
        <>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Keep one row per selected key combination. No keys = whole-row DISTINCT.</Caption1>
          <ColumnChecklist label="De-duplicate by" selected={d.dedupKeys || []} columns={availableColumns} onChange={(cols) => onPatch({ dedupKeys: cols })} s={s} />
        </>
      )}

      {d.kind === 'join' && (
        <>
          <Field label="Join kind">
            <Dropdown value={d.joinKind || 'INNER'} selectedOptions={[d.joinKind || 'INNER']} onOptionSelect={(_, data) => onPatch({ joinKind: (data.optionValue as VqJoinKind) || 'INNER' })}>
              {VQ_JOIN_KINDS.map((k) => <Option key={k} value={k}>{k}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Left key" hint={leftColumns.length ? undefined : 'Resolve the left source columns first'}>
            <Dropdown value={d.leftKey || ''} selectedOptions={d.leftKey ? [d.leftKey] : []} placeholder="Left column" onOptionSelect={(_, data) => onPatch({ leftKey: data.optionValue })}>
              {leftColumns.map((c) => <Option key={c} value={c}>{c}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Right key" hint={rightColumns.length ? undefined : 'Resolve the right source columns first'}>
            <Dropdown value={d.rightKey || ''} selectedOptions={d.rightKey ? [d.rightKey] : []} placeholder="Right column" onOptionSelect={(_, data) => onPatch({ rightKey: data.optionValue })}>
              {rightColumns.map((c) => <Option key={c} value={c}>{c}</Option>)}
            </Dropdown>
          </Field>
        </>
      )}

      {d.kind === 'union' && (
        <Field label="Union mode" hint="UNION ALL keeps duplicates; UNION removes them.">
          <Switch checked={d.unionAll !== false} label={d.unionAll !== false ? 'UNION ALL (keep duplicates)' : 'UNION (distinct)'} onChange={(_, data) => onPatch({ unionAll: data.checked })} />
        </Field>
      )}

      {d.kind === 'sink' && (
        <>
          <Field label="Materialize as">
            <Dropdown value={(d.sink?.mode || 'table') === 'view' ? 'View' : 'Table (CTAS)'} selectedOptions={[d.sink?.mode || 'table']} onOptionSelect={(_, data) => onPatch({ sink: { ...(d.sink || {}), mode: (data.optionValue as VqSinkMode) || 'table' } })}>
              <Option value="table">Table (CTAS)</Option>
              <Option value="view">View</Option>
            </Dropdown>
          </Field>
          <Field label="Target schema"><Input value={d.sink?.schema || ''} placeholder={dialect === 'tsql' ? 'dbo' : '(optional)'} onChange={(_, v) => onPatch({ sink: { ...(d.sink || {}), schema: v.value } })} /></Field>
          <Field label="Target table / view" required><Input value={d.sink?.table || ''} placeholder="silver_sales" onChange={(_, v) => onPatch({ sink: { ...(d.sink || {}), table: v.value } })} /></Field>
        </>
      )}

      <Divider />
      <Button icon={<Delete20Regular />} appearance="subtle" onClick={onDelete}>Remove node</Button>
    </div>
  );
}

function ColumnChecklist({ label, selected, columns, onChange, s }: { label: string; selected: string[]; columns: string[]; onChange: (cols: string[]) => void; s: ReturnType<typeof useStyles> }) {
  return (
    <>
      <Label size="small">{label}</Label>
      {columns.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No columns resolved yet — select the source table.</Caption1>}
      <div className={s.checkList}>
        {columns.map((c) => (
          <Checkbox key={c} label={c} checked={selected.includes(c)} onChange={(_, data) => {
            const set = new Set(selected);
            if (data.checked) set.add(c); else set.delete(c);
            onChange(Array.from(set));
          }} />
        ))}
      </div>
    </>
  );
}

function GroupByForm({ d, availableColumns, onPatch, s }: { d: VqNodeData; availableColumns: string[]; onPatch: (p: Partial<VqNodeData>) => void; s: ReturnType<typeof useStyles> }) {
  const aggs = d.aggregates || [];
  const updateAgg = (i: number, patch: Partial<VqAggSpec>) => onPatch({ aggregates: aggs.map((a, j) => j === i ? { ...a, ...patch } : a) });
  const addAgg = () => onPatch({ aggregates: [...aggs, { func: 'SUM', field: availableColumns[0] || '', alias: '' }] });
  const removeAgg = (i: number) => onPatch({ aggregates: aggs.filter((_, j) => j !== i) });
  return (
    <>
      <ColumnChecklist label="Group by columns" selected={d.groupBy || []} columns={availableColumns} onChange={(cols) => onPatch({ groupBy: cols })} s={s} />
      <Divider />
      <Label size="small">Aggregations</Label>
      {aggs.map((a, i) => (
        <div key={i} className={s.aggRow}>
          <Dropdown style={{ minWidth: 96 }} value={a.func} selectedOptions={[a.func]} aria-label={`Aggregation ${i + 1} function`} onOptionSelect={(_, data) => updateAgg(i, { func: (data.optionValue as VqAggFunc) || 'SUM' })}>
            {VQ_AGG_FUNCS.map((f) => <Option key={f} value={f}>{f}</Option>)}
          </Dropdown>
          <Dropdown style={{ minWidth: 0, flex: 1 }} value={a.field} selectedOptions={a.field ? [a.field] : []} placeholder="column" aria-label={`Aggregation ${i + 1} column`} onOptionSelect={(_, data) => updateAgg(i, { field: data.optionValue || '' })}>
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

function SortForm({ d, availableColumns, onPatch, s }: { d: VqNodeData; availableColumns: string[]; onPatch: (p: Partial<VqNodeData>) => void; s: ReturnType<typeof useStyles> }) {
  const keys = d.sortKeys || [];
  const updateKey = (i: number, patch: Partial<VqSortKey>) => onPatch({ sortKeys: keys.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const addKey = () => onPatch({ sortKeys: [...keys, { field: availableColumns[0] || '', dir: 'ASC' as VqSortDir }] });
  const removeKey = (i: number) => onPatch({ sortKeys: keys.filter((_, j) => j !== i) });
  return (
    <>
      <Label size="small">Sort by</Label>
      {availableColumns.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No columns resolved yet — select the source table.</Caption1>}
      {keys.map((k, i) => (
        <div key={i} className={s.aggRow}>
          <Dropdown style={{ minWidth: 0, flex: 1 }} value={k.field} selectedOptions={k.field ? [k.field] : []} placeholder="column" aria-label={`Sort key ${i + 1} column`} onOptionSelect={(_, data) => updateKey(i, { field: data.optionValue || '' })}>
            {availableColumns.map((c) => <Option key={c} value={c}>{c}</Option>)}
          </Dropdown>
          <Dropdown style={{ minWidth: 96 }} value={k.dir} selectedOptions={[k.dir]} aria-label={`Sort key ${i + 1} direction`} onOptionSelect={(_, data) => updateKey(i, { dir: (data.optionValue as VqSortDir) || 'ASC' })}>
            {VQ_SORT_DIRS.map((dir) => <Option key={dir} value={dir}>{dir}</Option>)}
          </Dropdown>
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => removeKey(i)} aria-label={`Remove sort key ${i + 1}`} />
        </div>
      ))}
      <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={addKey}>Add sort column</Button>
    </>
  );
}

function DeriveForm({ d, dialect, onPatch, s }: { d: VqNodeData; dialect: SqlDialect; onPatch: (p: Partial<VqNodeData>) => void; s: ReturnType<typeof useStyles> }) {
  const cols = d.derived || [];
  const update = (i: number, patch: Partial<VqDeriveColumn>) => onPatch({ derived: cols.map((c, j) => j === i ? { ...c, ...patch } : c) });
  const add = () => onPatch({ derived: [...cols, { name: '', expression: '' }] });
  const remove = (i: number) => onPatch({ derived: cols.filter((_, j) => j !== i) });
  return (
    <>
      <Label size="small">Computed columns</Label>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Each is a column name plus a SQL expression — the allowed 1:1 builder slot.</Caption1>
      {cols.map((c, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4, borderLeft: `2px solid ${tokens.colorNeutralStroke2}`, paddingLeft: 8 }}>
          <div className={s.aggRow}>
            <Input style={{ flex: 1 }} placeholder="new_column" value={c.name} onChange={(_, data) => update(i, { name: data.value })} aria-label={`Derived column ${i + 1} name`} />
            <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => remove(i)} aria-label={`Remove derived column ${i + 1}`} />
          </div>
          <MonacoTextarea value={c.expression} onChange={(v) => update(i, { expression: v })} language={dialect} height={56} lineNumbers={false} ariaLabel={`Derived column ${i + 1} expression`} />
        </div>
      ))}
      <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={add}>Add computed column</Button>
    </>
  );
}

function RenameForm({ d, availableColumns, onPatch, s }: { d: VqNodeData; availableColumns: string[]; onPatch: (p: Partial<VqNodeData>) => void; s: ReturnType<typeof useStyles> }) {
  const maps = d.renames || [];
  const update = (i: number, patch: Partial<VqRenameMap>) => onPatch({ renames: maps.map((m, j) => j === i ? { ...m, ...patch } : m) });
  const add = () => onPatch({ renames: [...maps, { from: availableColumns[0] || '', to: '' }] });
  const remove = (i: number) => onPatch({ renames: maps.filter((_, j) => j !== i) });
  return (
    <>
      <Label size="small">Rename columns</Label>
      {maps.map((m, i) => (
        <div key={i} className={s.aggRow}>
          <Dropdown style={{ minWidth: 0, flex: 1 }} value={m.from} selectedOptions={m.from ? [m.from] : []} placeholder="from" aria-label={`Rename ${i + 1} from`} onOptionSelect={(_, data) => update(i, { from: data.optionValue || '' })}>
            {availableColumns.map((c) => <Option key={c} value={c}>{c}</Option>)}
          </Dropdown>
          <Input style={{ minWidth: 0, flex: 1 }} placeholder="to" value={m.to} onChange={(_, data) => update(i, { to: data.value })} aria-label={`Rename ${i + 1} to`} />
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => remove(i)} aria-label={`Remove rename ${i + 1}`} />
        </div>
      ))}
      <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={add}>Add rename</Button>
    </>
  );
}

function CastForm({ d, availableColumns, castTypes, onPatch, s }: { d: VqNodeData; availableColumns: string[]; castTypes: VqCastType[]; onPatch: (p: Partial<VqNodeData>) => void; s: ReturnType<typeof useStyles> }) {
  const casts = d.casts || [];
  const update = (i: number, patch: Partial<VqCastSpec>) => onPatch({ casts: casts.map((c, j) => j === i ? { ...c, ...patch } : c) });
  const add = () => onPatch({ casts: [...casts, { field: availableColumns[0] || '', to: castTypes[0] }] });
  const remove = (i: number) => onPatch({ casts: casts.filter((_, j) => j !== i) });
  return (
    <>
      <Label size="small">Cast column types</Label>
      {casts.map((c, i) => (
        <div key={i} className={s.aggRow}>
          <Dropdown style={{ minWidth: 0, flex: 1 }} value={c.field} selectedOptions={c.field ? [c.field] : []} placeholder="column" aria-label={`Cast ${i + 1} column`} onOptionSelect={(_, data) => update(i, { field: data.optionValue || '' })}>
            {availableColumns.map((col) => <Option key={col} value={col}>{col}</Option>)}
          </Dropdown>
          <Dropdown style={{ minWidth: 120 }} value={c.to} selectedOptions={[c.to]} aria-label={`Cast ${i + 1} type`} onOptionSelect={(_, data) => update(i, { to: (data.optionValue as VqCastType) || castTypes[0] })}>
            {castTypes.map((t) => <Option key={t} value={t}>{t}</Option>)}
          </Dropdown>
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => remove(i)} aria-label={`Remove cast ${i + 1}`} />
        </div>
      ))}
      <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={add}>Add cast</Button>
    </>
  );
}

// ============================================================
// Public wrapper
// ============================================================

export function WarpTransformCanvas(props: WarpTransformCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export default WarpTransformCanvas;
