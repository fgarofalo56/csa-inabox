'use client';

/**
 * WorkflowDesignerCanvas — the visual authoring surface for a Loom workflow
 * backed by a real Azure Logic App.
 *
 * Built on React Flow (@xyflow/react) and the SHARED canvas kit, so it carries
 * the same standards every other Loom canvas does (`.claude/rules/ux-baseline.md`):
 * node-kit v2 node anatomy, undo/redo, copy/paste, align/distribute, the
 * shortcut sheet, the shared right rail (zoom / fit / auto-layout), a drag-from
 * palette, and a docked inspector with pre-run validation dots.
 *
 * The model is `lib/logic-app/wdl-model` — every canvas mutation goes through a
 * pure graph function, and the graph converts losslessly to the Workflow
 * Definition Language JSON that is PUT to `Microsoft.Logic/workflows`. There is
 * no local-only representation: what you lay out is what Azure stores.
 *
 * Per `.claude/rules/no-vaporware.md` every control here maps to a real backend
 * effect — Save → `PUT Microsoft.Logic/workflows`; Run → `POST triggers/{n}/run`;
 * the Runs tab → `GET runs` / `GET runs/{n}/actions`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, Panel,
  Handle, Position, useReactFlow, useNodesState, useEdgesState,
  MarkerType, ConnectionMode,
  type Node, type Edge, type Connection, type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Button, Caption1, Body1Strong, Tooltip, Badge, Input, Textarea, Dropdown, Option,
  Accordion, AccordionHeader, AccordionItem, AccordionPanel,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Delete16Regular, Warning16Filled, ErrorCircle16Filled,
  Keyboard20Regular, Flow20Regular,
} from '@fluentui/react-icons';
import {
  CanvasNode, CanvasRightRail, getActivityVisual,
  type CanvasNodeStatus,
} from '@/lib/components/canvas/canvas-node-kit';
import { CanvasPowerToolbar } from '@/lib/components/canvas/canvas-power-toolbar';
import { CanvasShortcutDialog } from '@/lib/components/canvas/canvas-shortcut-dialog';
import { alignPositions, distributePositions, type AlignMode, type DistributeAxis } from '@/lib/components/canvas/canvas-align';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { EmptyState } from '@/lib/components/empty-state';
import {
  wdlToGraph, graphToWdl, autoLayout, removeNode, renameNode, connectNodes,
  disconnectNodes, uniqueOperationName, validateGraph,
  type LogicGraph, type LogicNode, type WdlDefinition, type ValidationIssue,
} from '@/lib/logic-app/wdl-model';
import {
  OPERATION_CATALOG, OPERATION_CATEGORY_ORDER, findOperation, findOperationById,
  canvasCategoryForType, getPath, setPath,
  type OperationDef, type OperationField,
} from '@/lib/logic-app/operation-catalog';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 },
  body: { flex: 1, minHeight: 0, minWidth: 0 },
  palette: {
    display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  paletteItem: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    paddingTop: tokens.spacingVerticalSNudge, paddingBottom: tokens.spacingVerticalSNudge,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium, cursor: 'grab',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    marginBottom: tokens.spacingVerticalXS,
    ':hover': {
      boxShadow: tokens.shadow4,
      borderTopColor: tokens.colorBrandStroke1,
      borderRightColor: tokens.colorBrandStroke1,
      borderBottomColor: tokens.colorBrandStroke1,
      borderLeftColor: tokens.colorBrandStroke1,
    },
  },
  canvasWrap: { position: 'relative', flex: 1, minHeight: 0, minWidth: 0 },
  inspector: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minHeight: 0,
    overflow: 'auto', padding: tokens.spacingHorizontalM,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  issues: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  issueRow: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'flex-start' },
  err: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
  warn: { color: tokens.colorPaletteDarkOrangeForeground1, flexShrink: 0 },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  toolbar: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap',
    padding: tokens.spacingHorizontalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  paletteHead: { paddingLeft: tokens.spacingHorizontalM, paddingTop: tokens.spacingVerticalS },
  // Guided first-run launcher, centred over an empty canvas. Pointer events are
  // re-enabled only on the card so the canvas stays pannable behind it.
  launcher: {
    position: 'absolute', inset: '0', display: 'flex', alignItems: 'center',
    justifyContent: 'center', pointerEvents: 'none', padding: tokens.spacingHorizontalL,
  },
  launcherCard: { pointerEvents: 'auto', maxWidth: '520px' },
});

// ── The React Flow node ─────────────────────────────────────────────────────

interface LogicNodeData extends Record<string, unknown> {
  node: LogicNode;
  hasError: boolean;
  runStatus?: CanvasNodeStatus;
  onDelete: (id: string) => void;
}

function LogicFlowNode({ data, selected }: NodeProps) {
  const d = data as unknown as LogicNodeData;
  const n = d.node;
  const def = findOperation(n.type, n.operationKind);
  const visual = getActivityVisual(canvasCategoryForType(n.type, n.operationKind));

  return (
    <>
      {/* An action accepts an inbound runAfter edge; a trigger does not. */}
      {n.kind === 'action' && (
        <Handle
          type="target"
          position={Position.Top}
          style={{ background: visual.accent, width: 8, height: 8, border: 'none' }}
        />
      )}
      <CanvasNode
        title={n.id.replace(/_/g, ' ')}
        typeLabel={def?.label || n.type || 'Unknown operation'}
        visual={visual}
        selected={selected}
        error={d.hasError}
        status={d.runStatus ?? 'idle'}
        badges={
          n.kind === 'trigger' ? <Badge appearance="tint" color="brand" size="small">Trigger</Badge> : undefined
        }
        actionBar={
          n.kind === 'trigger'
            ? undefined
            : [
                {
                  key: 'del',
                  icon: <Delete16Regular />,
                  label: `Delete ${n.id}`,
                  danger: true,
                  onClick: () => d.onDelete(n.id),
                },
              ]
        }
        rootProps={{ 'data-logic-node': n.id, 'data-logic-kind': String(n.kind) }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: visual.accent, width: 8, height: 8, border: 'none' }}
      />
    </>
  );
}

const NODE_TYPES: NodeTypes = { logic: LogicFlowNode };

// ── Inspector ───────────────────────────────────────────────────────────────

function FieldControl({
  field, value, onChange,
}: { field: OperationField; value: unknown; onChange: (v: unknown) => void }) {
  const s = useStyles();
  const id = `fld-${field.path.replace(/\./g, '-')}`;

  if (field.kind === 'select') {
    const cur = value == null ? '' : String(value);
    return (
      <div className={s.field}>
        <Caption1 id={`${id}-label`}>{field.label}{field.required ? ' *' : ''}</Caption1>
        <Dropdown
          aria-labelledby={`${id}-label`}
          value={cur}
          selectedOptions={cur ? [cur] : []}
          onOptionSelect={(_, d) => onChange(d.optionValue)}
        >
          {(field.options || []).map((o) => <Option key={o} value={o} text={o}>{o}</Option>)}
        </Dropdown>
        {field.help && <Caption1>{field.help}</Caption1>}
      </div>
    );
  }

  if (field.kind === 'json') {
    const text = value === undefined ? '' : JSON.stringify(value, null, 2);
    return (
      <div className={s.field}>
        <Caption1 id={`${id}-label`}>{field.label}{field.required ? ' *' : ''}</Caption1>
        <Textarea
          aria-labelledby={`${id}-label`}
          value={text}
          resize="vertical"
          placeholder={field.placeholder}
          onChange={(_, d) => {
            try { onChange(d.value.trim() === '' ? undefined : JSON.parse(d.value)); }
            catch { /* keep the last valid value until the JSON parses */ }
          }}
        />
        {field.help && <Caption1>{field.help}</Caption1>}
      </div>
    );
  }

  if (field.kind === 'textarea') {
    return (
      <div className={s.field}>
        <Caption1 id={`${id}-label`}>{field.label}{field.required ? ' *' : ''}</Caption1>
        <Textarea
          aria-labelledby={`${id}-label`}
          value={value == null ? '' : String(value)}
          resize="vertical"
          placeholder={field.placeholder}
          onChange={(_, d) => onChange(d.value)}
        />
        {field.help && <Caption1>{field.help}</Caption1>}
      </div>
    );
  }

  return (
    <div className={s.field}>
      <Caption1 id={`${id}-label`}>{field.label}{field.required ? ' *' : ''}</Caption1>
      <Input
        aria-labelledby={`${id}-label`}
        type={field.kind === 'number' ? 'number' : 'text'}
        value={value == null ? '' : String(value)}
        placeholder={field.placeholder}
        onChange={(_, d) => onChange(field.kind === 'number' ? (d.value === '' ? undefined : Number(d.value)) : d.value)}
      />
      {field.help && <Caption1>{field.help}</Caption1>}
    </div>
  );
}

// ── Designer ────────────────────────────────────────────────────────────────

export interface WorkflowDesignerCanvasProps {
  definition: WdlDefinition;
  /** Fired on every graph mutation with the rebuilt WDL definition. */
  onChange: (next: WdlDefinition) => void;
  /** Per-operation live run status keyed by operation name (from the Runs tab). */
  runStatuses?: Record<string, CanvasNodeStatus>;
  readOnly?: boolean;
  /**
   * Force the pre-run validation list visible even before the user has touched
   * anything — the editor sets this after a failed save attempt.
   *
   * Default false because `ux-baseline.md` requires a freshly created item to
   * open CLEAN: an untouched, empty workflow legitimately has no trigger yet,
   * and showing "A workflow needs at least one trigger" in red before the user
   * has done anything is exactly the red-on-first-open defect that rule bans.
   * The guided launcher below teaches the same thing without alarming.
   */
  showValidation?: boolean;
  /** Reports validation issues up so the editor can gate Save. */
  onValidationChange?: (issues: ValidationIssue[]) => void;
}

function DesignerInner({
  definition, onChange, runStatuses, readOnly, showValidation, onValidationChange,
}: WorkflowDesignerCanvasProps) {
  const s = useStyles();
  const rf = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);

  // The graph is derived from the definition prop, but held locally so drag /
  // selection feel instant. A definition arriving from outside (reload, revert)
  // re-seeds it.
  const [graph, setGraph] = useState<LogicGraph>(() => wdlToGraph(definition));
  const lastEmitted = useRef<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [history, setHistory] = useState<LogicGraph[]>([]);
  const [future, setFuture] = useState<LogicGraph[]>([]);
  // Has the user edited anything in this session? Gates the red validation list
  // so a freshly created workflow opens clean (ux-baseline.md §6).
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const incoming = JSON.stringify(definition);
    if (incoming === lastEmitted.current) return;
    setGraph(wdlToGraph(definition));
  }, [definition]);

  /** Commit a graph mutation: push history, update state, emit the new WDL. */
  const commit = useCallback((next: LogicGraph) => {
    setHistory((h) => [...h.slice(-49), graph]);
    setFuture([]);
    setTouched(true);
    setGraph(next);
    const wdl = graphToWdl(next, definition);
    lastEmitted.current = JSON.stringify(wdl);
    onChange(wdl);
  }, [graph, definition, onChange]);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setFuture((f) => [graph, ...f]);
      setGraph(prev);
      const wdl = graphToWdl(prev, definition);
      lastEmitted.current = JSON.stringify(wdl);
      onChange(wdl);
      return h.slice(0, -1);
    });
  }, [graph, definition, onChange]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const nxt = f[0];
      setHistory((h) => [...h, graph]);
      setGraph(nxt);
      const wdl = graphToWdl(nxt, definition);
      lastEmitted.current = JSON.stringify(wdl);
      onChange(wdl);
      return f.slice(1);
    });
  }, [graph, definition, onChange]);

  const issues = useMemo(() => validateGraph(graph), [graph]);
  useEffect(() => { onValidationChange?.(issues); }, [issues, onValidationChange]);

  // Red only AFTER the user has engaged (or a save was attempted). An untouched
  // new workflow shows the guided launcher instead — never an error banner.
  const validationVisible = touched || !!showValidation;
  const errorNodeIds = useMemo(
    () => (validationVisible
      ? new Set(issues.filter((i) => i.severity === 'error' && i.nodeId).map((i) => i.nodeId!))
      : new Set<string>()),
    [issues, validationVisible],
  );

  const deleteNode = useCallback((id: string) => {
    if (readOnly) return;
    commit(removeNode(graph, id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, [graph, commit, readOnly]);

  // ── React Flow node/edge projection ───────────────────────────────────────
  const rfNodes: Node[] = useMemo(
    () => graph.nodes.map((n) => ({
      id: n.id,
      type: 'logic',
      position: n.position,
      selected: n.id === selectedId,
      data: {
        node: n,
        hasError: errorNodeIds.has(n.id),
        runStatus: runStatuses?.[n.id],
        onDelete: deleteNode,
      } satisfies LogicNodeData,
    })),
    [graph.nodes, selectedId, errorNodeIds, runStatuses, deleteNode],
  );

  const rfEdges: Edge[] = useMemo(
    () => graph.edges.map((e) => {
      const onlySucceeded = e.statuses.length === 1 && e.statuses[0] === 'Succeeded';
      const stroke = onlySucceeded ? tokens.colorPaletteGreenBorderActive : tokens.colorPaletteDarkOrangeBorderActive;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: false,
        label: onlySucceeded ? undefined : e.statuses.join(' / '),
        style: { stroke, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      } satisfies Edge;
    }),
    [graph.edges],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);
  useEffect(() => { setNodes(rfNodes); }, [rfNodes, setNodes]);
  useEffect(() => { setEdges(rfEdges); }, [rfEdges, setEdges]);

  /** Persist a drag into the graph (so the position round-trips to metadata). */
  const onNodeDragStop = useCallback((_e: unknown, node: Node) => {
    if (readOnly) return;
    setGraph((g) => {
      const next = {
        ...g,
        nodes: g.nodes.map((n) => (n.id === node.id ? { ...n, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } } : n)),
      };
      const wdl = graphToWdl(next, definition);
      lastEmitted.current = JSON.stringify(wdl);
      onChange(wdl);
      return next;
    });
  }, [definition, onChange, readOnly]);

  const onConnect = useCallback((c: Connection) => {
    if (readOnly || !c.source || !c.target) return;
    commit(connectNodes(graph, c.source, c.target));
  }, [graph, commit, readOnly]);

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    if (readOnly) return;
    let next = graph;
    for (const e of deleted) next = disconnectNodes(next, e.id);
    commit(next);
  }, [graph, commit, readOnly]);

  // ── Palette drag-and-drop ─────────────────────────────────────────────────
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const addOperation = useCallback((def: OperationDef, at?: { x: number; y: number }) => {
    if (readOnly) return;
    const taken = graph.nodes.map((n) => n.id);
    const id = uniqueOperationName(def.label, taken);
    const template = def.template();

    // Position: the drop point, else below the current lowest node.
    const position = at ?? {
      x: 0,
      y: graph.nodes.length === 0 ? 0 : Math.max(...graph.nodes.map((n) => n.position.y)) + 132,
    };

    const node: LogicNode = {
      id,
      kind: def.isTrigger ? 'trigger' : 'action',
      type: def.type,
      operationKind: def.operationKind,
      inputs: template.inputs,
      raw: Object.fromEntries(
        Object.entries(template).filter(([k]) => !['type', 'kind', 'inputs', 'runAfter', 'actions', 'else', 'cases', 'default'].includes(k)),
      ),
      scopes: def.isScope
        ? {
            actions: { nodes: [], edges: [] },
            ...(def.type === 'If' ? { else: { nodes: [], edges: [] } } : {}),
          }
        : undefined,
      position,
    };

    let next: LogicGraph = { ...graph, nodes: [...graph.nodes, node] };
    // Chain a new ACTION onto the current tail so the flow stays connected —
    // only when the tail is unambiguous (exactly one action has no successor).
    if (!def.isTrigger) {
      const tails = next.nodes.filter((n) => n.kind === 'action' && n.id !== id && !next.edges.some((e) => e.source === n.id));
      if (tails.length === 1) next = connectNodes(next, tails[0].id, id);
    }
    commit(next);
    setSelectedId(id);
  }, [graph, commit, readOnly]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const opId = e.dataTransfer.getData('application/loom-logic-op');
    if (!opId) return;
    const def = findOperationById(opId);
    if (!def) return;
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addOperation(def, { x: Math.round(pos.x), y: Math.round(pos.y) });
  }, [rf, addOperation]);

  // ── Inspector edits ───────────────────────────────────────────────────────
  const selected = useMemo(() => graph.nodes.find((n) => n.id === selectedId) || null, [graph.nodes, selectedId]);
  const selectedDef = selected ? findOperation(selected.type, selected.operationKind) : undefined;

  const patchSelected = useCallback((path: string, value: unknown) => {
    if (!selected || readOnly) return;
    // `inputs.*` writes into inputs; anything else writes into the preserved raw
    // body (recurrence, expression, foreach, limit, …) exactly where WDL wants it.
    const next = graph.nodes.map((n) => {
      if (n.id !== selected.id) return n;
      if (path === 'inputs') return { ...n, inputs: value };
      if (path.startsWith('inputs.')) {
        const sub = path.slice('inputs.'.length);
        const inputs = setPath((n.inputs as Record<string, unknown>) || {}, sub, value);
        return { ...n, inputs };
      }
      return { ...n, raw: setPath(n.raw || {}, path, value) };
    });
    commit({ ...graph, nodes: next });
  }, [graph, selected, commit, readOnly]);

  const readSelected = useCallback((path: string): unknown => {
    if (!selected) return undefined;
    if (path === 'inputs') return selected.inputs;
    if (path.startsWith('inputs.')) return getPath(selected.inputs, path.slice('inputs.'.length));
    return getPath(selected.raw, path);
  }, [selected]);

  const doRename = useCallback((to: string) => {
    if (!selected || readOnly || !to.trim()) return;
    const next = renameNode(graph, selected.id, to.trim());
    commit(next);
    const renamed = next.nodes.find((n) => !graph.nodes.some((o) => o.id === n.id));
    setSelectedId(renamed?.id ?? null);
  }, [graph, selected, commit, readOnly]);

  // ── Align / distribute / auto-layout ──────────────────────────────────────
  const selectedIds = useMemo(() => nodes.filter((n) => n.selected).map((n) => n.id), [nodes]);

  const doAlign = useCallback((mode: AlignMode) => {
    if (readOnly || selectedIds.length < 2) return;
    const picked = graph.nodes.filter((n) => selectedIds.includes(n.id));
    const moved = alignPositions(picked.map((n) => ({ id: n.id, position: n.position })), mode);
    commit({
      ...graph,
      nodes: graph.nodes.map((n) => (moved[n.id] ? { ...n, position: moved[n.id] } : n)),
    });
  }, [graph, selectedIds, commit, readOnly]);

  const doDistribute = useCallback((axis: DistributeAxis) => {
    if (readOnly || selectedIds.length < 3) return;
    const picked = graph.nodes.filter((n) => selectedIds.includes(n.id));
    const moved = distributePositions(picked.map((n) => ({ id: n.id, position: n.position })), axis);
    commit({
      ...graph,
      nodes: graph.nodes.map((n) => (moved[n.id] ? { ...n, position: moved[n.id] } : n)),
    });
  }, [graph, selectedIds, commit, readOnly]);

  const doAutoLayout = useCallback(() => {
    if (readOnly) return;
    const actionNames = graph.nodes.filter((n) => n.kind === 'action').map((n) => n.id);
    const preds = (name: string) => graph.edges.filter((e) => e.target === name).map((e) => e.source);
    const laid = autoLayout(actionNames, preds, 132);
    const trigNames = graph.nodes.filter((n) => n.kind === 'trigger').map((n) => n.id);
    const trigLaid = autoLayout(trigNames, () => []);
    commit({
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n, position: laid[n.id] || trigLaid[n.id] || n.position })),
    });
    setTimeout(() => rf.fitView({ padding: 0.2, duration: 200 }), 40);
  }, [graph, commit, rf, readOnly]);

  // Keyboard: undo / redo / delete, matching the canvas shortcut standard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); deleteNode(selectedId); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, selectedId, deleteNode]);

  const byCategory = useMemo(() => {
    const m = new Map<string, OperationDef[]>();
    for (const op of OPERATION_CATALOG) {
      if (!m.has(op.category)) m.set(op.category, []);
      m.get(op.category)!.push(op);
    }
    return m;
  }, []);

  const palettePane = (
    <div className={s.palette} data-testid="logic-palette">
      <div className={s.paletteHead}>
        <Body1Strong>Operations</Body1Strong>
        <Caption1>Drag onto the canvas, or click to append.</Caption1>
      </div>
      <Accordion multiple collapsible defaultOpenItems={['triggers', 'http']}>
        {OPERATION_CATEGORY_ORDER.map((cat) => (
          <AccordionItem value={cat.id} key={cat.id}>
            <AccordionHeader>{cat.label}</AccordionHeader>
            <AccordionPanel>
              {(byCategory.get(cat.id) || []).map((op) => (
                <div
                  key={op.id}
                  className={s.paletteItem}
                  draggable={!readOnly}
                  role="button"
                  tabIndex={0}
                  aria-label={`Add ${op.label}`}
                  data-op-id={op.id}
                  onDragStart={(e) => { e.dataTransfer.setData('application/loom-logic-op', op.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onClick={() => addOperation(op)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addOperation(op); } }}
                >
                  <Body1Strong>{op.label}</Body1Strong>
                  <Caption1>{op.description}</Caption1>
                </div>
              ))}
            </AccordionPanel>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );

  const inspectorPane = (
    <div className={s.inspector} data-testid="logic-inspector">
      {validationVisible && issues.length > 0 && (
        <div className={s.issues}>
          {issues.map((i: ValidationIssue, idx) => (
            <div className={s.issueRow} key={idx}>
              {i.severity === 'error'
                ? <ErrorCircle16Filled className={s.err} />
                : <Warning16Filled className={s.warn} />}
              <Caption1>{i.message}</Caption1>
            </div>
          ))}
        </div>
      )}

      {!selected && (
        <MessageBar intent="info" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>{graph.nodes.length === 0 ? 'Add a trigger to begin' : 'Select a step'}</MessageBarTitle>
            {graph.nodes.length === 0
              ? 'Choose a trigger on the canvas, or drag one from the Triggers group in the palette. Actions you add after it run in the order you connect them.'
              : 'Pick a step on the canvas to configure it, or drag an operation from the palette to add one. Every change is written to the real Logic App when you save.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {selected && (
        <>
          <div className={s.badgeRow}>
            <Badge appearance="tint" color={selected.kind === 'trigger' ? 'brand' : 'informative'}>
              {selected.kind === 'trigger' ? 'Trigger' : 'Action'}
            </Badge>
            <Badge appearance="outline">{selected.type}</Badge>
          </div>

          <div className={s.field}>
            <Caption1 id="op-name-label">Step name</Caption1>
            <Input
              aria-labelledby="op-name-label"
              defaultValue={selected.id}
              key={selected.id}
              disabled={readOnly}
              onBlur={(e) => doRename(e.currentTarget.value)}
            />
            <Caption1>Renaming rewrites every reference to this step.</Caption1>
          </div>

          {selectedDef
            ? selectedDef.fields.map((f) => (
                <FieldControl
                  key={f.path}
                  field={f}
                  value={readSelected(f.path)}
                  onChange={(v) => patchSelected(f.path, v)}
                />
              ))
            : (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Operation not in the Loom palette</MessageBarTitle>
                  This step is a <code>{selected.type}</code> operation (most likely a managed
                  connector authored in the Azure portal). Loom preserves it exactly on save,
                  but cannot render typed controls for it yet — edit it on the Code view tab.
                </MessageBarBody>
              </MessageBar>
            )}

          {selectedDef?.learnMore && (
            <Caption1>
              <a href={selectedDef.learnMore} target="_blank" rel="noreferrer">Learn about {selectedDef.label}</a>
            </Caption1>
          )}
        </>
      )}
    </div>
  );

  const canvasPane = (
    <div className={s.canvasWrap} ref={wrapRef} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onSelectionChange={({ nodes: sel }) => setSelectedId(sel.length === 1 ? sel[0].id : null)}
        onMove={(_, vp) => setZoom(vp.zoom)}
        connectionMode={ConnectionMode.Loose}
        fitView
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        aria-label="Workflow designer canvas"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <MiniMap pannable zoomable nodeStrokeWidth={2} />
        <Panel position="top-left">
          <CanvasPowerToolbar
            onUndo={undo}
            onRedo={redo}
            canUndo={history.length > 0}
            canRedo={future.length > 0}
            onAlign={doAlign}
            onDistribute={doDistribute}
            selectionCount={selectedIds.length}
          />
        </Panel>
        <Panel position="bottom-right">
          <CanvasRightRail
            zoom={zoom}
            onZoomChange={(z) => rf.setViewport({ ...rf.getViewport(), zoom: z }, { duration: 120 })}
            onZoomIn={() => rf.zoomIn({ duration: 120 })}
            onZoomOut={() => rf.zoomOut({ duration: 120 })}
            onFit={() => rf.fitView({ padding: 0.2, duration: 200 })}
            onAutoLayout={doAutoLayout}
            collapsed={railCollapsed}
            onToggleCollapse={() => setRailCollapsed((v) => !v)}
          />
        </Panel>
        <Panel position="top-right">
          <Tooltip content="Keyboard shortcuts" relationship="label">
            <Button size="small" appearance="subtle" icon={<Keyboard20Regular />} aria-label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)} />
          </Tooltip>
        </Panel>
      </ReactFlow>
      <CanvasShortcutDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      {/* Guided first-run launcher (ux-baseline.md): a brand-new workflow opens
          on a teaching CTA, not a red "no trigger" error. Every Logic Apps
          workflow starts with a trigger, so the two built-in triggers are the
          launcher's actions — one click and the user is authoring. */}
      {graph.nodes.length === 0 && !readOnly && (
        <div className={s.launcher} data-testid="logic-designer-launcher">
          <div className={s.launcherCard}>
            <EmptyState
              icon={<Flow20Regular />}
              title="Start with a trigger"
              body="Every Azure Logic Apps workflow begins with a trigger that decides when it runs. Pick one to start — then drag actions from the palette and connect them to set their run order. Save writes the workflow to the real Microsoft.Logic/workflows resource."
              primaryAction={{
                label: 'Recurrence (schedule)',
                onClick: () => { const d = findOperationById('trigger-recurrence'); if (d) addOperation(d, { x: 0, y: 0 }); },
              }}
              secondaryAction={{
                label: 'When an HTTP request is received',
                onClick: () => { const d = findOperationById('trigger-request'); if (d) addOperation(d, { x: 0, y: 0 }); },
              }}
            />
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className={s.root}>
      <div className={s.body}>
        {/* G3 — every pane is user-resizable, sizes persisted per surface. */}
        <SplitPane
          direction="horizontal"
          defaultSize={260}
          minSize={180}
          maxSize={420}
          storageKey="logic-app-designer-palette"
          dividerLabel="Resize operations palette"
        >
          {palettePane}
          <SplitPane
            direction="horizontal"
            primary="second"
            defaultSize={320}
            minSize={240}
            maxSize={520}
            storageKey="logic-app-designer-inspector"
            dividerLabel="Resize step inspector"
          >
            {canvasPane}
            {inspectorPane}
          </SplitPane>
        </SplitPane>
      </div>
    </div>
  );
}

export function WorkflowDesignerCanvas(props: WorkflowDesignerCanvasProps) {
  return (
    <ReactFlowProvider>
      <DesignerInner {...props} />
    </ReactFlowProvider>
  );
}

export default WorkflowDesignerCanvas;
