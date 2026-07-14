'use client';

/**
 * DomainDesignerCanvas — the visual designer for the domain hierarchy (issue
 * #1483 Wave 3). A real, drag-to-reparent tree/graph canvas built on the shared
 * Web-5.0 canvas node-kit + @xyflow/react (the same stack the pipeline /
 * eventstream / entity-diagram canvases use), plus a dense Fluent Tree toggle
 * for keyboard-heavy editing.
 *
 * What it does, one-for-one with a real designer surface (per ux-baseline.md):
 *   • Renders the arbitrary-depth domain hierarchy (department → agency →
 *     sub-agency → office → program …) top-down, ELK-laid-out.
 *   • Drag a node onto another to REPARENT it (real PATCH /api/admin/domains
 *     parentId; server enforces cycle + depth). Client blocks dropping a node on
 *     its own descendant before the round-trip.
 *   • Right-click any node → context menu: Add child · Rename · Assign
 *     workspaces · Settings · Delete (each calls the real handler).
 *   • Undo / redo of reparent moves (Ctrl+Z / Ctrl+Y + toolbar) — replays the
 *     inverse PATCH, so structural edits are reversible.
 *   • Shared CanvasRightRail (zoom / vertical zoom slider / fit / ELK
 *     auto-layout) + a keyboard-shortcut sheet + a depth legend.
 *   • Guided EmptyState when there are no domains yet.
 *
 * The canvas is presentational over the page's real domain list + mutation
 * handlers — it holds NO domain state of its own (Cosmos stays authoritative).
 * Positions are ELK-derived and per-session; nothing here writes layout to the
 * server.
 */

import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Panel,
  Handle, Position, MarkerType, useReactFlow, useNodesState, useEdgesState, useViewport,
  type Node, type Edge, type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ELK from 'elkjs/lib/elk.bundled.js';
import {
  Badge, Button, Caption1, Subtitle2, Tooltip,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Add16Regular, Rename16Regular, Delete16Regular, Settings16Regular,
  Folder16Regular, ArrowUndo20Regular, ArrowRedo20Regular, Keyboard20Regular,
  Organization24Regular, Add24Regular, BuildingMultiple24Regular,
} from '@fluentui/react-icons';
import { DomainGlyph } from '@/lib/domains/domain-icons';
import { CanvasRightRail, portStyle } from '@/lib/components/canvas/canvas-node-kit';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { LOOM_ACCENT } from '@/lib/components/shared/accent-tokens';

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface DesignerDomain {
  id: string;
  name: string;
  parentId?: string;
  icon?: string;
  themeColor?: string;
  color?: string;
  workspaceCount?: number;
  status?: string;
  /** Depth in the tree (root = 1) — supplied by the API. */
  depth?: number;
}

export interface DomainDesignerCanvasProps {
  domains: DesignerDomain[];
  /** Reparent a domain (null → make it a root). Returns ok + optional error. */
  onReparent: (id: string, newParentId: string | null) => Promise<{ ok: boolean; error?: string }>;
  onAddChild: (parentId: string) => void;
  onAddRoot: () => void;
  onRename: (d: DesignerDomain) => void;
  onDelete: (d: DesignerDomain) => void;
  onAssign: (d: DesignerDomain) => void;
  onOpenSettings: (d: DesignerDomain) => void;
  /** Whether the caller is a tenant admin (gates reparent + delete affordances). */
  canEditTree?: boolean;
}

// ---------------------------------------------------------------------------
// Node visual
// ---------------------------------------------------------------------------

const NODE_WIDTH = 232;
const NODE_HEIGHT = 76;

/** Accent per depth band so the tree reads as levels (tokens-only). */
const DEPTH_ACCENTS = [
  'var(--loom-accent-blue)',
  'var(--loom-accent-violet)',
  'var(--loom-accent-teal)',
  'var(--loom-accent-magenta)',
  'var(--loom-accent-amber)',
];
function depthAccent(depth: number): string {
  return DEPTH_ACCENTS[(Math.max(1, depth) - 1) % DEPTH_ACCENTS.length];
}

interface DomainNodeData extends Record<string, unknown> {
  domain: DesignerDomain;
  accent: string;
  childCount: number;
  canEditTree: boolean;
  isDropTarget: boolean;
  onAddChild: (parentId: string) => void;
  onOpenSettings: (d: DesignerDomain) => void;
}

const useNodeStyles = makeStyles({
  card: {
    position: 'relative',
    width: `${NODE_WIDTH}px`,
    minHeight: `${NODE_HEIGHT}px`,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    cursor: 'grab',
    transitionProperty: 'box-shadow, transform, border-color',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-1px)' },
    '& .loom-domain-node-actions': {
      opacity: 0,
      transitionProperty: 'opacity',
      transitionDuration: tokens.durationFast,
    },
    ':hover .loom-domain-node-actions': { opacity: 1 },
    '@media (prefers-reduced-motion: reduce)': {
      transitionDuration: '0.01ms',
      ':hover': { transform: 'none' },
    },
  },
  selected: { border: `1px solid ${tokens.colorBrandStroke1}` },
  dropTarget: {
    border: `2px dashed ${tokens.colorBrandStroke1}`,
    boxShadow: tokens.shadow16,
  },
  rail: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: '5px',
    borderTopLeftRadius: tokens.borderRadiusLarge, borderBottomLeftRadius: tokens.borderRadiusLarge,
  },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: '1px' },
  name: {
    fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    color: tokens.colorNeutralForeground1,
  },
  meta: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  actions: { display: 'flex', gap: '1px', flexShrink: 0 },
});

function DomainNodeImpl({ data, selected }: NodeProps) {
  const s = useNodeStyles();
  const d = data as DomainNodeData;
  const dom = d.domain;
  return (
    <div
      className={mergeClasses(s.card, selected && s.selected, d.isDropTarget && s.dropTarget)}
      data-domain-node={dom.id}
      title={dom.name}
    >
      <span className={s.rail} style={{ background: d.accent }} aria-hidden="true" />
      {/* Target handle (top) — an edge from the parent connects here. */}
      <Handle
        type="target" position={Position.Top} id="in"
        style={{ ...portStyle('in', d.accent), top: -6 }} isConnectable={false}
      />
      <DomainGlyph icon={dom.icon} color={dom.themeColor || dom.color} size={34} />
      <span className={s.text}>
        <span className={s.name}>{dom.name}</span>
        <span className={s.meta}>
          <Badge appearance="tint" size="small" color={dom.status === 'active' ? 'success' : 'informative'}>
            L{dom.depth || 1}
          </Badge>
          {d.childCount > 0 && (
            <Badge appearance="outline" size="small">{d.childCount} sub</Badge>
          )}
          {!!dom.workspaceCount && (
            <Badge appearance="tint" size="small" color="brand">{dom.workspaceCount} ws</Badge>
          )}
        </span>
      </span>
      <span className={mergeClasses(s.actions, 'loom-domain-node-actions', 'nodrag', 'nopan')}>
        {d.canEditTree && (
          <Tooltip content="Add child domain" relationship="label">
            <Button
              size="small" appearance="subtle" icon={<Add16Regular />}
              aria-label={`Add child of ${dom.name}`}
              onClick={(e) => { e.stopPropagation(); d.onAddChild(dom.id); }}
            />
          </Tooltip>
        )}
        <Tooltip content="Settings" relationship="label">
          <Button
            size="small" appearance="subtle" icon={<Settings16Regular />}
            aria-label={`Settings for ${dom.name}`}
            onClick={(e) => { e.stopPropagation(); d.onOpenSettings(dom); }}
          />
        </Tooltip>
      </span>
      {/* Source handle (bottom) — edges to children start here. */}
      <Handle
        type="source" position={Position.Bottom} id="out"
        style={{ ...portStyle('out', d.accent), bottom: -6 }} isConnectable={false}
      />
    </div>
  );
}
const DomainNode = memo(DomainNodeImpl);
const nodeTypes: NodeTypes = { domain: DomainNode };

// ---------------------------------------------------------------------------
// ELK top-down tree layout
// ---------------------------------------------------------------------------

const elk = new ELK();

async function layoutTree(domains: DesignerDomain[]): Promise<Map<string, { x: number; y: number }>> {
  const out = new Map<string, { x: number; y: number }>();
  if (domains.length === 0) return out;
  const ids = new Set(domains.map((d) => d.id));
  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'mrtree',
      'elk.direction': 'DOWN',
      'elk.mrtree.spacing.nodeNode': '46',
      'elk.spacing.nodeNode': '46',
      'elk.padding': '[top=32,left=32,bottom=32,right=32]',
    } as Record<string, string>,
    children: domains.map((d) => ({ id: d.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: domains
      .filter((d) => d.parentId && ids.has(d.parentId))
      .map((d, i) => ({ id: `e-${i}`, sources: [d.parentId as string], targets: [d.id] })),
  };
  try {
    const res = await elk.layout(elkGraph as any);
    for (const c of res.children || []) out.set(c.id as string, { x: c.x ?? 0, y: c.y ?? 0 });
  } catch {
    // Deterministic depth-band fallback (roots row 0, children below).
    const byDepth = new Map<number, DesignerDomain[]>();
    for (const d of domains) {
      const dp = d.depth || 1;
      const arr = byDepth.get(dp) || [];
      arr.push(d);
      byDepth.set(dp, arr);
    }
    for (const [dp, arr] of byDepth) {
      arr.forEach((d, i) => out.set(d.id, { x: 40 + i * (NODE_WIDTH + 48), y: 40 + (dp - 1) * (NODE_HEIGHT + 80) }));
    }
  }
  return out;
}

/** Descendant ids of `id` (used to block dropping a node on its own subtree). */
function descendantIds(domains: DesignerDomain[], id: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const d of domains) {
    if (d.parentId) {
      const arr = childrenOf.get(d.parentId) || [];
      arr.push(d.id);
      childrenOf.set(d.parentId, arr);
    }
  }
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const k of childrenOf.get(cur) || []) {
      if (!out.has(k)) { out.add(k); stack.push(k); }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inner canvas (inside ReactFlowProvider)
// ---------------------------------------------------------------------------

const useCanvasStyles = makeStyles({
  wrap: { position: 'relative', width: '100%', height: '100%' },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow8,
  },
  legend: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow8, maxWidth: '180px',
  },
  legendRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  legendDot: { width: '10px', height: '10px', borderRadius: tokens.borderRadiusCircular, flexShrink: 0 },
  shortcutRow: { display: 'flex', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, minWidth: '200px' },
  kbd: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    padding: `1px ${tokens.spacingHorizontalXS}`, borderRadius: tokens.borderRadiusSmall,
    background: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

interface ContextMenuState { x: number; y: number; domain: DesignerDomain; }

function DesignerInner(props: DomainDesignerCanvasProps) {
  const {
    domains, onReparent, onAddChild, onAddRoot, onRename, onDelete, onAssign, onOpenSettings,
    canEditTree = true,
  } = props;
  const c = useCanvasStyles();
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<DomainNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  // Undo / redo of reparent moves. Each entry is { id, from, to }; undo replays
  // the inverse PATCH, redo re-applies. Cleared-forward on a new move.
  const undoStack = useRef<Array<{ id: string; from: string | null; to: string | null }>>([]);
  const redoStack = useRef<Array<{ id: string; from: string | null; to: string | null }>>([]);
  const [histTick, setHistTick] = useState(0); // re-render toolbar enable state

  const childCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of domains) if (d.parentId) m.set(d.parentId, (m.get(d.parentId) || 0) + 1);
    return m;
  }, [domains]);

  const maxDepth = useMemo(() => domains.reduce((mx, d) => Math.max(mx, d.depth || 1), 1), [domains]);

  // (Re)build + lay out the graph whenever the domain list changes.
  const rebuild = useCallback(async () => {
    const pos = await layoutTree(domains);
    const ids = new Set(domains.map((d) => d.id));
    const nextNodes: Node<DomainNodeData>[] = domains.map((d) => ({
      id: d.id,
      type: 'domain',
      position: pos.get(d.id) || { x: 0, y: 0 },
      data: {
        domain: d,
        accent: depthAccent(d.depth || 1),
        childCount: childCounts.get(d.id) || 0,
        canEditTree,
        isDropTarget: false,
        onAddChild,
        onOpenSettings,
      },
      draggable: canEditTree,
    }));
    const nextEdges: Edge[] = domains
      .filter((d) => d.parentId && ids.has(d.parentId))
      .map((d) => ({
        id: `edge-${d.parentId}-${d.id}`,
        source: d.parentId as string,
        target: d.id,
        sourceHandle: 'out',
        targetHandle: 'in',
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        style: { stroke: depthAccent((d.depth || 2) - 1), strokeWidth: 1.6 },
      }));
    setNodes(nextNodes);
    setEdges(nextEdges);
    window.setTimeout(() => rf.fitView({ padding: 0.2, maxZoom: 1.15, duration: 200 }), 40);
  }, [domains, childCounts, canEditTree, onAddChild, onOpenSettings, setNodes, setEdges, rf]);

  useEffect(() => { rebuild(); }, [rebuild]);

  // Reflect the live drop-target highlight into node data.
  useEffect(() => {
    setNodes((ns) => ns.map((n) => (n.data.isDropTarget === (n.id === dropTargetId)
      ? n
      : { ...n, data: { ...n.data, isDropTarget: n.id === dropTargetId } })));
  }, [dropTargetId, setNodes]);

  const applyReparent = useCallback(async (id: string, from: string | null, to: string | null, record: boolean) => {
    const res = await onReparent(id, to);
    if (!res.ok) {
      setBanner(res.error || 'Move rejected.');
      // Snap back visually by rebuilding from the (unchanged) props.
      rebuild();
      return;
    }
    if (record) {
      undoStack.current.push({ id, from, to });
      redoStack.current = [];
      setHistTick((t) => t + 1);
    }
  }, [onReparent, rebuild]);

  // Drag-to-reparent: on drop, find the node under the dragged card that is not
  // itself or one of its descendants, and reparent onto it.
  const onNodeDragStop = useCallback((_e: React.MouseEvent, node: Node) => {
    setDropTargetId(null);
    if (!canEditTree) return;
    const dragged = domains.find((d) => d.id === node.id);
    if (!dragged) return;
    const intersecting = rf.getIntersectingNodes(node).filter((n) => n.id !== node.id);
    if (intersecting.length === 0) { rebuild(); return; }
    const banned = descendantIds(domains, node.id);
    const target = intersecting.find((n) => !banned.has(n.id));
    if (!target) { setBanner('Cannot drop a domain onto one of its own subdomains.'); rebuild(); return; }
    if ((dragged.parentId || null) === target.id) { rebuild(); return; }
    setBanner(null);
    applyReparent(node.id, dragged.parentId || null, target.id, true);
  }, [canEditTree, domains, rf, applyReparent, rebuild]);

  const onNodeDrag = useCallback((_e: React.MouseEvent, node: Node) => {
    if (!canEditTree) return;
    const banned = descendantIds(domains, node.id);
    const hit = rf.getIntersectingNodes(node).find((n) => n.id !== node.id && !banned.has(n.id));
    setDropTargetId(hit?.id || null);
  }, [canEditTree, domains, rf]);

  const undo = useCallback(() => {
    const op = undoStack.current.pop();
    if (!op) return;
    redoStack.current.push(op);
    setHistTick((t) => t + 1);
    applyReparent(op.id, op.to, op.from, false);
  }, [applyReparent]);

  const redo = useCallback(() => {
    const op = redoStack.current.pop();
    if (!op) return;
    undoStack.current.push(op);
    setHistTick((t) => t + 1);
    applyReparent(op.id, op.from, op.to, false);
  }, [applyReparent]);

  // Keyboard shortcuts (History + Delete). Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    const dom = domains.find((d) => d.id === node.id);
    if (dom) setMenu({ x: e.clientX, y: e.clientY, domain: dom });
  }, [domains]);

  const canUndo = undoStack.current.length > 0;
  const canRedo = redoStack.current.length > 0;
  void histTick; // referenced to re-run enable state

  return (
    <div className={c.wrap}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={() => setMenu(null)}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        deleteKeyCode={null}
        aria-label="Domain hierarchy designer"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />

        {/* Top-left toolbar: add root + undo/redo + shortcuts. */}
        <Panel position="top-left">
          <div className={c.toolbar} role="toolbar" aria-label="Designer actions">
            {canEditTree && (
              <Button size="small" appearance="primary" icon={<Add16Regular />} onClick={onAddRoot}>
                Add domain
              </Button>
            )}
            <Tooltip content="Undo move (Ctrl+Z)" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowUndo20Regular />} aria-label="Undo" disabled={!canUndo} onClick={undo} />
            </Tooltip>
            <Tooltip content="Redo move (Ctrl+Y)" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowRedo20Regular />} aria-label="Redo" disabled={!canRedo} onClick={redo} />
            </Tooltip>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Tooltip content="Keyboard shortcuts" relationship="label">
                  <Button size="small" appearance="subtle" icon={<Keyboard20Regular />} aria-label="Keyboard shortcuts" />
                </Tooltip>
              </MenuTrigger>
              <MenuPopover>
                <div style={{ padding: tokens.spacingVerticalS }}>
                  <Subtitle2>Shortcuts</Subtitle2>
                  <div className={c.shortcutRow}><span>Undo move</span><span className={c.kbd}>Ctrl+Z</span></div>
                  <div className={c.shortcutRow}><span>Redo move</span><span className={c.kbd}>Ctrl+Y</span></div>
                  <div className={c.shortcutRow}><span>Reparent</span><span>drag onto a node</span></div>
                  <div className={c.shortcutRow}><span>Actions</span><span>right-click a node</span></div>
                </div>
              </MenuPopover>
            </Menu>
          </div>
        </Panel>

        {/* Depth legend. */}
        <Panel position="top-right">
          <div className={c.legend} aria-label="Depth legend">
            <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Hierarchy depth</Caption1>
            {Array.from({ length: maxDepth }, (_, i) => (
              <span key={i} className={c.legendRow}>
                <span className={c.legendDot} style={{ background: depthAccent(i + 1) }} aria-hidden="true" />
                <Caption1>Level {i + 1}</Caption1>
              </span>
            ))}
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Drag a node onto another to reparent.</Caption1>
          </div>
        </Panel>

        {/* Shared zoom / fit / auto-layout rail. */}
        <Panel position="bottom-right">
          <CanvasRightRail
            zoom={zoom}
            minZoom={0.25}
            maxZoom={2}
            onZoomChange={(z) => rf.setViewport({ ...rf.getViewport(), zoom: z }, { duration: 120 })}
            onZoomIn={() => rf.zoomIn({ duration: 120 })}
            onZoomOut={() => rf.zoomOut({ duration: 120 })}
            onFit={() => rf.fitView({ padding: 0.2, maxZoom: 1.15, duration: 200 })}
            onAutoLayout={rebuild}
            collapsed={railCollapsed}
            onToggleCollapse={() => setRailCollapsed((v) => !v)}
          />
        </Panel>

        {banner && (
          <Panel position="bottom-left">
            <div className={c.toolbar} role="alert">
              <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{banner}</Caption1>
              <Button size="small" appearance="subtle" onClick={() => setBanner(null)}>Dismiss</Button>
            </div>
          </Panel>
        )}
      </ReactFlow>

      {/* Right-click context menu (positioned at the cursor). */}
      {menu && (
        <div style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1000 }}>
          <Menu open onOpenChange={(_, d) => { if (!d.open) setMenu(null); }} positioning={{ position: 'below', align: 'start' }}>
            <MenuTrigger disableButtonEnhancement>
              <span />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {canEditTree && (
                  <MenuItem icon={<Add16Regular />} onClick={() => { onAddChild(menu.domain.id); setMenu(null); }}>
                    Add child domain
                  </MenuItem>
                )}
                {canEditTree && (
                  <MenuItem icon={<Rename16Regular />} onClick={() => { onRename(menu.domain); setMenu(null); }}>
                    Rename
                  </MenuItem>
                )}
                <MenuItem icon={<Folder16Regular />} onClick={() => { onAssign(menu.domain); setMenu(null); }}>
                  Assign workspaces
                </MenuItem>
                <MenuItem icon={<Settings16Regular />} onClick={() => { onOpenSettings(menu.domain); setMenu(null); }}>
                  Settings
                </MenuItem>
                {canEditTree && menu.domain.parentId && (
                  <MenuItem icon={<ArrowUndo20Regular />} onClick={() => { applyReparent(menu.domain.id, menu.domain.parentId || null, null, true); setMenu(null); }}>
                    Move to root
                  </MenuItem>
                )}
                {canEditTree && (
                  <>
                    <MenuDivider />
                    <MenuItem icon={<Delete16Regular />} onClick={() => { onDelete(menu.domain); setMenu(null); }}>
                      Delete
                    </MenuItem>
                  </>
                )}
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component — resizable region + provider + empty state
// ---------------------------------------------------------------------------

export function DomainDesignerCanvas(props: DomainDesignerCanvasProps) {
  if (props.domains.length === 0) {
    return (
      <GuidedEmptyState
        title="Design the domain hierarchy"
        intro="Build the real organization tree — department → agency → sub-agency → program — by adding domains and dragging them into place. Every node maps to a governed Loom domain."
        heroIcon={Organization24Regular}
        paths={[
          {
            key: 'add',
            title: 'Add a root domain',
            body: 'Create a top-level domain, then add children and drag to reparent.',
            icon: Add24Regular,
            accent: LOOM_ACCENT.blue,
            onClick: props.onAddRoot,
          },
          {
            key: 'library',
            title: 'Seed from a library',
            body: 'Switch to the list view and use “Create new domain” to seed a whole taxonomy from a curated library.',
            icon: BuildingMultiple24Regular,
            accent: LOOM_ACCENT.teal,
            onClick: props.onAddRoot,
          },
        ]}
      />
    );
  }
  return (
    <ResizableCanvasRegion storageKey="domain-designer" defaultPx={560} minPx={360} ariaLabel="Resize domain designer">
      <ReactFlowProvider>
        <DesignerInner {...props} />
      </ReactFlowProvider>
    </ResizableCanvasRegion>
  );
}

export default DomainDesignerCanvas;
