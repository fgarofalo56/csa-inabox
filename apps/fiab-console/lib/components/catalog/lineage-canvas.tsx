'use client';

/**
 * LineageCanvas — the interactive @xyflow/react (React Flow) canvas that draws
 * a federated data-lineage graph for the Unified Catalog → Lineage tab.
 *
 * This is the same canvas engine the pipeline / eventstream / dataflow editors
 * use (lib/components/pipeline/canvas.tsx); only the node visuals + layout
 * differ. Like that canvas, the Loom Fluent-v9 theme is the only thing that
 * separates this from the lineage views in the real source UIs:
 *
 *   • Microsoft Purview portal lineage tab — Atlas v2 lineage subgraph
 *     (GET /datamap/api/atlas/v2/lineage/{guid}?direction=BOTH&depth=N).
 *     https://learn.microsoft.com/purview/data-gov-api-create-lineage-relationships
 *   • Databricks Catalog Explorer lineage graph — Unity Catalog table lineage
 *     (POST /api/2.0/lineage-tracking/table-lineage), nodes = tables / views /
 *     notebooks / jobs / dashboards down to the column level.
 *     https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-lineage
 *   • Microsoft Fabric / OneLake lineage view — workspace item relationships
 *     (dataflow → semantic model → report; lakehouse → report) from the admin
 *     scan. https://learn.microsoft.com/fabric/governance/lineage
 *
 * The graph is purely presentational: it receives already-fetched nodes/edges
 * from LineageGraph (which calls /api/catalog/lineage). No fabricated data — an
 * empty graph renders the honest empty-state; a configuration gap renders the
 * MessageBar gate. Both of those states live in the parent.
 *
 * Features mirrored from the source lineage UIs:
 *   - left→right layered (Sugiyama-ish longest-path) layout: upstream on the
 *     left, downstream on the right, exactly like Purview / Databricks read.
 *   - pan / wheel-zoom / fit-view / minimap / dot grid.
 *   - click a node → detail side panel (source, type, columns, open-item link)
 *     + upstream/downstream highlight (everything else dims) — the
 *     "focus on asset" interaction the Databricks lineage graph uses.
 *   - type/source legend, free-text search filter, and a focus toggle.
 */

import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, Panel,
  Handle, Position, useReactFlow, useNodesState,
  MarkerType,
  type Node, type Edge, type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Badge, Button, Caption1, Input, Text, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import {
  FullScreenMaximize20Regular, Organization20Regular, TargetRegular,
  Table16Regular, Document16Regular, Notebook16Regular, Flow16Regular,
  ChartMultiple16Regular, Database16Regular, Box16Regular, BranchFork16Regular,
  Search16Regular, Dismiss16Regular,
  ChevronDown12Regular, ChevronUp12Regular, Column16Regular,
  ColumnTriple20Regular, TargetArrow20Regular,
} from '@fluentui/react-icons';
import { portStyle, accentTint, CanvasRightRail } from '@/lib/components/canvas/canvas-node-kit';
import { itemVisual, isKnownItemType, readableAccent } from '@/lib/components/ui/item-type-visual';
import { useTheme } from '@/lib/theme/theme-context';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import {
  isColumnNode, groupColumnsByTable, visibleLineageGraph, columnAdjacency,
  walkColumns, columnImpact, layoutLineage, type ColumnImpactEntry,
} from './lineage-column-model';

// ---------------------------------------------------------------------------
// Public model — kept in sync with the LineageNode / LineageEdge the BFF
// returns (app/api/catalog/lineage/route.ts).
// ---------------------------------------------------------------------------

export type LineageSource = 'purview' | 'unity-catalog' | 'onelake' | 'loom' | 'weave';

export interface CanvasLineageNode {
  id: string;
  label: string;
  type?: string;
  source: LineageSource;
  /** Asset is the focus the user resolved on (drawn larger + brand-coloured). */
  focus?: boolean;
  /** Column names, when the back-end resolved them (Atlas attrs / UC schema). */
  columns?: string[];
  /** Deep-link into the matching Loom catalog item, when derivable. */
  openHref?: string;
  /** Set when the same asset was matched in >1 source during a merge. */
  multiSource?: string[];
  /**
   * Canonical cross-source identity (qualifiedName / storage path / UC
   * full_name / Loom item id) the unified-lineage merge collapsed this node
   * on. Carried purely as metadata for the detail panel — the canvas does not
   * read it for layout. See lib/azure/unified-lineage.ts.
   */
  identity?: string;
  /**
   * Optional status pip drawn in the node's top-right corner (e.g. the
   * Governed-scope label-propagation state). `color` is any CSS color; `title`
   * is the hover tooltip. Purely presentational — the canvas ignores it for
   * layout. Surfaces that don't track a per-node status omit it.
   */
  statusDot?: { color: string; title: string };
  /**
   * Set by the deleted-node guard (LIN-GC-3): the node's backing Loom item was
   * deleted but a metadata-plane entity (a Purview Atlas asset that hasn't GC'd
   * yet) still returns it. Rendered as a dashed, muted "ghost" with a Deleted
   * badge — and its open-item link is suppressed — so the graph never presents a
   * dead asset as live while GC propagates.
   */
  deleted?: boolean;
  /**
   * Column-grain nodes only (L1 column facet): the node id of the table/asset
   * this column belongs to, so a renderer can group/fan-out columns under their
   * owning table. Absent on table-grain nodes (non-breaking).
   */
  parentTableId?: string;
  /**
   * Column-grain nodes only: the human-readable owning table/asset name (raw,
   * pre-merge — `parentTableId` is the canonical post-merge node id).
   */
  columnOf?: string;
}

export interface CanvasLineageEdge {
  from: string;
  to: string;
  type?: string;
  /**
   * Edge grain (L1 column facet): 'column' marks a column→column edge between
   * synthetic `col:<table>::<column>` nodes; 'table' (or absent — the
   * pre-existing shape) is an item/table-grain edge. Optional, non-breaking.
   */
  kind?: 'table' | 'column';
  /**
   * Column edges only (L5): the transform expression the source declared for
   * this column mapping (e.g. "UPPER(x)", "CAST(... AS INT)"). Shown in the
   * column detail / impact panel. Optional, non-breaking.
   */
  transform?: string;
}

// ---------------------------------------------------------------------------
// Type → colour / icon. Grounded in what each source UI actually draws:
// tables, views, notebooks, jobs/pipelines, dataflows, semantic models,
// reports, lakehouses. Unknown types fall back to a neutral dataset chip.
// ---------------------------------------------------------------------------

interface TypeStyle { color: string; Icon: React.FC<{ fontSize?: number | string }>; kind: string; }

const TYPE_STYLES: Record<string, TypeStyle> = {
  table: { color: 'var(--loom-accent-blue)', Icon: Table16Regular, kind: 'Table' },
  view: { color: 'var(--loom-accent-blue)', Icon: Table16Regular, kind: 'View' },
  dataset: { color: 'var(--loom-accent-blue)', Icon: Document16Regular, kind: 'Dataset' },
  notebook: { color: 'var(--loom-accent-orange)', Icon: Notebook16Regular, kind: 'Notebook' },
  job: { color: 'var(--loom-accent-violet)', Icon: Flow16Regular, kind: 'Job' },
  pipeline: { color: 'var(--loom-accent-violet)', Icon: Flow16Regular, kind: 'Pipeline' },
  dataflow: { color: 'var(--loom-accent-teal)', Icon: Flow16Regular, kind: 'Dataflow' },
  semanticmodel: { color: 'var(--loom-accent-magenta)', Icon: BranchFork16Regular, kind: 'Semantic model' },
  report: { color: 'var(--loom-accent-magenta)', Icon: ChartMultiple16Regular, kind: 'Report' },
  dashboard: { color: 'var(--loom-accent-magenta)', Icon: ChartMultiple16Regular, kind: 'Dashboard' },
  lakehouse: { color: 'var(--loom-accent-emerald)', Icon: Database16Regular, kind: 'Lakehouse' },
  process: { color: tokens.colorNeutralForeground3, Icon: Box16Regular, kind: 'Process' },
  // Weave (Loom Thread) edge endpoints — the integration mesh recorded in the
  // thread-edges Cosmos container (notebook attach, data-agent source, Power BI
  // model, API publish). These are Loom items, not Azure/Fabric assets.
  'powerbi-model': { color: 'var(--loom-accent-magenta)', Icon: ChartMultiple16Regular, kind: 'Power BI model' },
  'data-agent': { color: 'var(--loom-accent-emerald)', Icon: BranchFork16Regular, kind: 'Data agent' },
  'data-api-builder': { color: 'var(--loom-accent-teal)', Icon: Flow16Regular, kind: 'Data API' },
};

const FALLBACK_STYLE: TypeStyle = { color: tokens.colorNeutralForeground3, Icon: Box16Regular, kind: 'Asset' };

/** Normalize the heterogeneous type strings each source returns to a style key. */
function styleForType(type?: string): TypeStyle {
  if (!type) return FALLBACK_STYLE;
  const t = type.toLowerCase();
  if (TYPE_STYLES[t]) return TYPE_STYLES[t];
  // Loom item slugs (data-product, mirrored-database, kql-database, eventhouse,
  // activator, semantic-model, warehouse, …) resolve through the shared
  // item-type-visual registry so a Governed / Mesh lineage node draws the SAME
  // brand icon + colour the rest of the console uses for that item type.
  if (isKnownItemType(t)) {
    const iv = itemVisual(t);
    return { color: iv.color, Icon: iv.icon as unknown as TypeStyle['Icon'], kind: iv.label };
  }
  // Atlas type names like "azure_sql_table", "powerbi_report", "databricks_table".
  if (t.includes('column')) return { color: 'var(--loom-accent-emerald)', Icon: BranchFork16Regular, kind: 'Column' };
  if (t.includes('powerbi') || t.includes('power-bi') || t.includes('semantic')) return TYPE_STYLES['powerbi-model'];
  if (t.includes('agent')) return TYPE_STYLES['data-agent'];
  if (t.includes('api')) return TYPE_STYLES['data-api-builder'];
  if (t.includes('notebook')) return TYPE_STYLES.notebook;
  if (t.includes('report')) return TYPE_STYLES.report;
  if (t.includes('dashboard')) return TYPE_STYLES.dashboard;
  if (t.includes('dataset') || t.includes('semanticmodel') || t.includes('semantic_model')) return TYPE_STYLES.semanticmodel;
  if (t.includes('dataflow')) return TYPE_STYLES.dataflow;
  if (t.includes('pipeline') || t.includes('job') || t.includes('process')) return TYPE_STYLES.process;
  if (t.includes('lakehouse') || t.includes('warehouse') || t.includes('database')) return TYPE_STYLES.lakehouse;
  if (t.includes('view')) return TYPE_STYLES.view;
  if (t.includes('table')) return TYPE_STYLES.table;
  return FALLBACK_STYLE;
}

const SOURCE_LABEL: Record<LineageSource, string> = {
  purview: 'Purview',
  'unity-catalog': 'Unity Catalog',
  onelake: 'OneLake / Fabric',
  loom: 'Loom Thread',
  weave: 'Weave',
};

// ---------------------------------------------------------------------------
// Custom node
// ---------------------------------------------------------------------------

const NODE_W = 210;
const NODE_H = 64;
// Column-grain fan-out nodes (L5): compact 1-row chips per ux-baseline node
// compactness (160–190px, no permanent actions, ONE accent).
const COL_NODE_W = 176;
const COL_NODE_H = 30;

// Zero-padding text buttons (the node chevron + panel jump links) — a griffel
// class, not inline px (web3-ui token rule; zero has no spacing token).
const useNodeStyles = makeStyles({
  inlineTextButton: {
    justifyContent: 'flex-start',
    minWidth: 0,
    height: 'auto',
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    paddingRight: 0,
  },
  colToggle: {
    justifyContent: 'flex-start',
    minWidth: 0,
    height: 'auto',
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    paddingRight: 0,
    color: tokens.colorNeutralForeground3,
    transitionProperty: 'opacity',
    transitionDuration: '120ms',
    transitionTimingFunction: 'ease',
  },
});

export interface LineageNodeData {
  node: CanvasLineageNode;
  /** dimmed when a focus/search filter excludes it. */
  dimmed?: boolean;
  /** Table nodes: number of column-grain children available to fan out (L5). */
  columnCount?: number;
  /** Table nodes: whether the column fan-out is currently expanded (L5). */
  expanded?: boolean;
  /** Table nodes: toggle the column fan-out (L5). */
  onToggleExpand?: (tableId: string) => void;
  [key: string]: unknown;
}

function LineageNodeImpl({ data, selected }: NodeProps) {
  const { node, dimmed, columnCount, expanded, onToggleExpand } = data as LineageNodeData;
  const { mode } = useTheme();
  const ns = useNodeStyles();
  const [hovered, setHovered] = useState(false);
  const style = styleForType(node.type);
  const Icon = style.Icon;
  const deleted = !!node.deleted;
  // A deleted-in-Loom asset that a metadata-plane entity still reports: mute the
  // accent, dash the border, and drop the opacity so it reads as a tombstone.
  // readableAccent lifts the dark item-type hexes to a legible foreground on the
  // dark theme (and is a no-op on the built-in `var(--loom-accent-*)` values).
  const accent = deleted ? tokens.colorNeutralForeground4 : readableAccent(style.color, mode === 'dark');
  // Expand affordance is hover/selection-revealed (node compactness) — but
  // always visible while expanded so collapse is one click. It stays in the
  // DOM either way so keyboard users can Tab to it.
  const showToggle = !!columnCount && (hovered || !!selected || !!expanded);
  return (
    <div
      data-lineage-node-id={node.id}
      data-lineage-source={node.source}
      data-lineage-deleted={deleted ? 'true' : undefined}
      aria-label={`${deleted ? 'Deleted ' : ''}${style.kind} ${node.label} from ${SOURCE_LABEL[node.source]}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        width: NODE_W,
        minHeight: NODE_H,
        paddingTop: tokens.spacingVerticalS,
        paddingBottom: tokens.spacingVerticalS,
        paddingLeft: tokens.spacingHorizontalSNudge,
        paddingRight: tokens.spacingHorizontalSNudge,
        borderRadius: tokens.borderRadiusMedium,
        background: deleted ? tokens.colorNeutralBackground3 : tokens.colorNeutralBackground1,
        borderLeft: `4px solid ${accent}`,
        border: `1px ${deleted ? 'dashed' : 'solid'} ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        borderLeftWidth: 4,
        borderLeftStyle: deleted ? 'dashed' : 'solid',
        borderLeftColor: accent,
        boxShadow: node.focus
          ? `0 0 0 2px ${accent}, ${tokens.shadow8}`
          : selected
            ? `0 0 0 2px ${tokens.colorBrandBackground2}, ${tokens.shadow8}`
            : tokens.shadow4,
        opacity: deleted ? (dimmed ? 0.2 : 0.55) : (dimmed ? 0.25 : 1),
        transition: 'opacity 120ms ease',
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <Handle type="target" position={Position.Left} style={portStyle('in', accent)} />
      {node.statusDot && (
        <span
          aria-hidden
          title={node.statusDot.title}
          style={{
            position: 'absolute',
            top: tokens.spacingVerticalXS,
            right: tokens.spacingHorizontalXS,
            width: '10px',
            height: '10px',
            borderRadius: tokens.borderRadiusCircular,
            background: node.statusDot.color,
            border: `1px solid ${tokens.colorNeutralBackground1}`,
            boxShadow: tokens.shadow2,
          }}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge }}>
        <span style={{ color: accent, display: 'inline-flex' }}><Icon fontSize={tokens.fontSizeBase400} /></span>
        <Text
          size={200}
          weight={node.focus ? 'semibold' : 'medium'}
          truncate
          wrap={false}
          style={{ flex: 1, textDecoration: deleted ? 'line-through' : undefined }}
        >
          {node.label}
        </Text>
        {deleted && (
          <Badge size="extra-small" appearance="tint" color="danger">Deleted</Badge>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{style.kind}</Caption1>
        <span style={{ color: tokens.colorNeutralForeground4 }}>·</span>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{SOURCE_LABEL[node.source]}</Caption1>
        {node.multiSource && node.multiSource.length > 1 && (
          <Badge size="extra-small" appearance="tint" color="informative" style={{ marginLeft: 'auto' }}>merged</Badge>
        )}
      </div>
      {!!columnCount && (
        <Button
          size="small"
          appearance="transparent"
          className={ns.colToggle}
          icon={expanded ? <ChevronUp12Regular /> : <ChevronDown12Regular />}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${columnCount} column${columnCount === 1 ? '' : 's'} of ${node.label}`}
          aria-expanded={!!expanded}
          data-testid={`lineage-col-toggle-${node.id}`}
          onClick={(e) => { e.stopPropagation(); onToggleExpand?.(node.id); }}
          style={{ opacity: showToggle ? 1 : 0 }}
        >
          <Caption1>{expanded ? 'Hide columns' : `${columnCount} column${columnCount === 1 ? '' : 's'}`}</Caption1>
        </Button>
      )}
      <Handle type="source" position={Position.Right} style={portStyle('out', accent)} />
    </div>
  );
}

/**
 * Column-grain node (L5) — a compact 1-row chip fanned out beneath its owning
 * table, matching the column rows in the Databricks Catalog Explorer /
 * Purview column-lineage views: column icon + truncated name, an emerald
 * accent bar, and typed ports so column→column edges attach.
 */
function LineageColumnNodeImpl({ data, selected }: NodeProps) {
  const { node, dimmed } = data as LineageNodeData;
  const { mode } = useTheme();
  const accent = readableAccent('var(--loom-accent-emerald)', mode === 'dark');
  return (
    <div
      data-lineage-node-id={node.id}
      data-lineage-column="true"
      aria-label={`Column ${node.label}${node.columnOf ? ` of ${node.columnOf}` : ''} from ${SOURCE_LABEL[node.source]}`}
      style={{
        position: 'relative',
        width: COL_NODE_W,
        minHeight: COL_NODE_H,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        paddingLeft: tokens.spacingHorizontalSNudge,
        paddingRight: tokens.spacingHorizontalSNudge,
        borderRadius: tokens.borderRadiusMedium,
        background: tokens.colorNeutralBackground1,
        borderTop: `1px solid ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        borderRight: `1px solid ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        borderBottom: `1px solid ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        borderLeft: `3px solid ${accent}`,
        boxShadow: selected ? `0 0 0 2px ${tokens.colorBrandBackground2}, ${tokens.shadow4}` : tokens.shadow2,
        opacity: dimmed ? 0.25 : 1,
        transition: 'opacity 120ms ease',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <Handle type="target" position={Position.Left} style={portStyle('in', accent)} />
      <span style={{ color: accent, display: 'inline-flex', flexShrink: 0 }}>
        <Column16Regular fontSize={tokens.fontSizeBase300} />
      </span>
      <Text size={200} truncate wrap={false} style={{ flex: 1, minWidth: 0 }}>{node.label}</Text>
      <Handle type="source" position={Position.Right} style={portStyle('out', accent)} />
    </div>
  );
}

const nodeTypes: NodeTypes = { lineage: LineageNodeImpl, lineageColumn: LineageColumnNodeImpl };

// ---------------------------------------------------------------------------
// Layout — deterministic left→right layered layout (longest-path layering)
// with L5 column fan-out, shared with the unit tests via lineage-column-model.
// Upstream sources land in the leftmost columns, the focus/sinks on the right —
// the read order Purview and Databricks lineage graphs use.
// ---------------------------------------------------------------------------

const COL_GAP = 280;
const ROW_GAP = 112; // table node (max ~84px with the column-toggle row) + air
const COLUMN_ROW_GAP = 40; // column chip (30px) + air
const COLUMN_INDENT = 28;

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  shell: {
    position: 'relative',
    width: '100%',
    // Fills the user-resizable ResizableCanvasRegion (default 560px, persisted
    // per-surface, bounded 320px–80vh). React Flow needs this definite height.
    height: '100%',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
  },
  toolbar: {
    display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center',
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingHorizontalXS,
  },
  search: { width: '184px' },
  legend: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, maxWidth: '340px',
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
  },
  legendItem: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  // A fixed small square colour chip (NOT spacing tokens used as size).
  legendSwatch: {
    width: tokens.fontSizeBase200,
    height: tokens.fontSizeBase200,
    borderRadius: tokens.borderRadiusSmall,
    display: 'inline-block',
    flexShrink: 0,
  },
  detail: {
    position: 'absolute', top: tokens.spacingVerticalM, right: tokens.spacingHorizontalM,
    // Responsive: cap to the available canvas width so the panel never bleeds
    // off-screen on a narrow viewport. 300px on wide canvases, otherwise the
    // canvas width minus both gutters.
    width: '300px', maxWidth: 'calc(100% - 24px)',
    maxHeight: 'calc(100% - 24px)',
    overflowY: 'auto', zIndex: 10,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusXLarge,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    boxShadow: tokens.shadow16,
    // Keyboard/scroll affordance: the panel is focusable and outlined when
    // focused so keyboard users land here after selecting a node.
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-2px' },
  },
  detailRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXXS, marginBottom: tokens.spacingVerticalMNudge },
  // L5 — upstream/downstream column chain rows in the column detail panel.
  columnList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    marginTop: tokens.spacingVerticalXXS,
    minWidth: 0,
  },
  columnRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  columnRowMain: { display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
});

export interface LineageCanvasHandle {
  fitToScreen: () => void;
  focusOn: (id: string) => void;
}

/**
 * One upstream/downstream column entry in the column detail panel (L5):
 * direct/transitive severity badge, column + owning-table labels, and the
 * declared transform expression on direct hops. Badge row wraps
 * (flexWrap+minWidth:0) so nothing overlaps at narrow width.
 */
function ColumnChainRow({ entry, onJump, canJump }: {
  entry: ColumnImpactEntry;
  onJump: (id: string) => void;
  canJump: boolean;
}) {
  const s = useStyles();
  const ns = useNodeStyles();
  return (
    <div className={s.columnRow} data-testid={`column-chain-${entry.id}`}>
      {entry.distance === 1
        ? <Badge appearance="tint" color="danger" size="extra-small">Direct</Badge>
        : <Badge appearance="tint" color="warning" size="extra-small">{entry.distance} hops</Badge>}
      <div className={s.columnRowMain}>
        {canJump ? (
          <Button
            size="small"
            appearance="transparent"
            className={ns.inlineTextButton}
            onClick={() => onJump(entry.id)}
          >
            <Text size={200} truncate wrap={false}>{entry.label}</Text>
          </Button>
        ) : (
          <Text size={200} truncate wrap={false}>{entry.label}</Text>
        )}
        {entry.tableLabel && (
          <Caption1 truncate wrap={false} style={{ color: tokens.colorNeutralForeground3 }}>{entry.tableLabel}</Caption1>
        )}
        {entry.transform && (
          <Caption1 truncate wrap={false} style={{ color: tokens.colorNeutralForeground3, fontFamily: tokens.fontFamilyMonospace }}>
            {entry.transform}
          </Caption1>
        )}
      </div>
    </div>
  );
}

export interface LineageCanvasProps {
  nodes: CanvasLineageNode[];
  edges: CanvasLineageEdge[];
  /** id of the asset the user resolved on (gets focus styling + initial focus). */
  focusId?: string;
}

const LineageCanvasInner = forwardRef<LineageCanvasHandle, LineageCanvasProps>(function LineageCanvasInner(
  { nodes: srcNodes, edges: srcEdges, focusId },
  ref,
) {
  const s = useStyles();
  const ns = useNodeStyles();
  const { mode } = useTheme();
  const rf = useReactFlow();
  const detailRef = useRef<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  // L5 impact-analysis mode: a selected COLUMN highlights only its DOWNSTREAM
  // column chain — "what breaks if this column changes".
  const [impactMode, setImpactMode] = useState(false);
  const [search, setSearch] = useState('');
  const [zoom, setZoom] = useState(1);
  const [railCollapsed, setRailCollapsed] = useState(false);
  // Tables whose column fan-out is currently expanded (L5). Collapsed by
  // default: the table-grain graph stays primary, exactly like the Databricks
  // Catalog Explorer lineage graph before "See column lineage".
  const [expandedTables, setExpandedTables] = useState<ReadonlySet<string>>(() => new Set());
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);

  // L5 kill-switch (l5-column-lineage-ui, default-ON fail-open): OFF filters
  // the column grain out client-side — the pre-L5 table-grain canvas.
  const columnsUiOn = useRuntimeFlag('l5-column-lineage-ui');
  const { nodes: allNodes, edges: allEdges } = useMemo(() => {
    if (columnsUiOn) return { nodes: srcNodes, edges: srcEdges };
    return {
      nodes: srcNodes.filter((n) => !isColumnNode(n)),
      edges: srcEdges.filter((e) => e.kind !== 'column'),
    };
  }, [srcNodes, srcEdges, columnsUiOn]);

  const columnsByTable = useMemo(() => groupColumnsByTable(allNodes), [allNodes]);
  const columnsPresent = useMemo(() => allNodes.some((n) => isColumnNode(n)), [allNodes]);
  const nodeById = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);

  // Visible subgraph given the current fan-out state (collapsed columns hide,
  // along with any edge touching them).
  const { nodes: visNodes, edges: visEdges } = useMemo(
    () => visibleLineageGraph(allNodes, allEdges, expandedTables),
    [allNodes, allEdges, expandedTables],
  );

  const positions = useMemo(
    () => layoutLineage(visNodes, visEdges, {
      colGap: COL_GAP, rowGap: ROW_GAP, columnRowGap: COLUMN_ROW_GAP, columnIndent: COLUMN_INDENT,
    }),
    [visNodes, visEdges],
  );

  // adjacency for highlight + focus-mode reachability (visible graph)
  const adjacency = useMemo(() => {
    const up = new Map<string, Set<string>>();
    const down = new Map<string, Set<string>>();
    for (const n of visNodes) { up.set(n.id, new Set()); down.set(n.id, new Set()); }
    for (const e of visEdges) {
      down.get(e.from)?.add(e.to);
      up.get(e.to)?.add(e.from);
    }
    return { up, down };
  }, [visNodes, visEdges]);

  // Column-grain adjacency over the FULL graph — impact analysis must count
  // downstream columns even while their table's fan-out is collapsed.
  const colAdj = useMemo(() => columnAdjacency(allEdges), [allEdges]);

  // Transitively connected set (both directions) from a node — the
  // upstream+downstream chain Databricks highlights when you click a node.
  const connectedTo = useCallback((id: string): Set<string> => {
    const seen = new Set<string>([id]);
    const walk = (start: string, map: Map<string, Set<string>>) => {
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const nxt of map.get(cur) || []) {
          if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt); }
        }
      }
    };
    walk(id, adjacency.up);
    walk(id, adjacency.down);
    return seen;
  }, [adjacency]);

  // Chain for the current selection. A COLUMN selection walks `kind:'column'`
  // edges ONLY (impact mode → downstream only), then re-adds the owning table
  // of every active column so the fan-out context never dims away (L5).
  const chainFor = useCallback((id: string): Set<string> => {
    const n = nodeById.get(id);
    if (n && isColumnNode(n)) {
      const set = new Set<string>([id]);
      for (const k of walkColumns(colAdj.down, id).keys()) set.add(k);
      if (!impactMode) for (const k of walkColumns(colAdj.up, id).keys()) set.add(k);
      for (const cid of [...set]) {
        const p = nodeById.get(cid)?.parentTableId;
        if (p) set.add(p);
      }
      return set;
    }
    return connectedTo(id);
  }, [nodeById, colAdj, impactMode, connectedTo]);

  // Which node ids are "active" (not dimmed) given the current search/focus.
  const activeIds = useMemo(() => {
    const all = new Set(visNodes.map((n) => n.id));
    let set = all;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      set = new Set(visNodes.filter((n) => n.label.toLowerCase().includes(q) || (n.type || '').toLowerCase().includes(q)).map((n) => n.id));
    }
    if (focusMode && (selectedId || focusId)) {
      const chain = chainFor(selectedId || focusId!);
      set = new Set([...set].filter((id) => chain.has(id)));
    } else if (selectedId) {
      // not focus-mode but a selection → highlight its chain (others dim).
      const chain = chainFor(selectedId);
      set = new Set([...set].filter((id) => chain.has(id)));
    }
    return set;
  }, [visNodes, search, focusMode, selectedId, focusId, chainFor]);

  const dimAny = activeIds.size !== visNodes.length;

  // L5 fan-out state changes.
  const toggleTable = useCallback((tableId: string) => {
    setExpandedTables((cur) => {
      const next = new Set(cur);
      if (next.has(tableId)) next.delete(tableId);
      else next.add(tableId);
      return next;
    });
    // Collapsing the table that owns the selected column drops the selection —
    // a hidden node must never keep the whole graph dimmed.
    setSelectedId((sel) => {
      if (!sel) return sel;
      const n = nodeById.get(sel);
      return n && isColumnNode(n) && n.parentTableId === tableId ? null : sel;
    });
  }, [nodeById]);

  const anyExpanded = expandedTables.size > 0;
  const toggleAllColumns = useCallback(() => {
    setExpandedTables((cur) => (cur.size > 0 ? new Set() : new Set(columnsByTable.keys())));
    setSelectedId((sel) => {
      if (!sel) return sel;
      const n = nodeById.get(sel);
      return n && isColumnNode(n) && anyExpanded ? null : sel;
    });
  }, [columnsByTable, nodeById, anyExpanded]);

  useEffect(() => {
    setRfNodes(visNodes.map((n) => {
      const isCol = isColumnNode(n);
      return {
        id: n.id,
        type: isCol ? 'lineageColumn' : 'lineage',
        position: positions.get(n.id) || { x: 0, y: 0 },
        data: {
          node: { ...n, focus: n.id === focusId },
          dimmed: dimAny && !activeIds.has(n.id),
          ...(isCol ? {} : {
            columnCount: columnsByTable.get(n.id)?.length || 0,
            expanded: expandedTables.has(n.id),
            onToggleExpand: toggleTable,
          }),
        } as LineageNodeData,
        selected: n.id === selectedId,
      };
    }));
  }, [visNodes, positions, focusId, selectedId, activeIds, dimAny, setRfNodes, columnsByTable, expandedTables, toggleTable]);

  // Column edges draw thinner in a distinct emerald tint so the column grain
  // reads apart from the table-grain brand-blue edges (L5).
  const columnEdgeColor = readableAccent('var(--loom-accent-emerald)', mode === 'dark');
  const rfEdges: Edge[] = useMemo(() => {
    const ids = new Set(visNodes.map((n) => n.id));
    return visEdges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e, i) => {
        const active = activeIds.has(e.from) && activeIds.has(e.to);
        const isCol = e.kind === 'column';
        const color = active
          ? (isCol ? columnEdgeColor : tokens.colorBrandStroke1)
          : tokens.colorNeutralStroke2;
        return {
          id: `${e.from}->${e.to}:${i}`,
          source: e.from,
          target: e.to,
          type: 'smoothstep',
          animated: active && dimAny,
          style: {
            stroke: color,
            strokeWidth: isCol ? (active ? 1.25 : 0.75) : (active ? 1.75 : 1),
            opacity: active ? 1 : 0.4,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed, color,
            width: isCol ? 12 : 16, height: isCol ? 12 : 16,
          },
        } as Edge;
      });
  }, [visEdges, visNodes, activeIds, dimAny, columnEdgeColor]);

  const fitToScreen = useCallback(() => rf.fitView({ padding: 0.2, maxZoom: 1.25, duration: 250 }), [rf]);
  const focusOn = useCallback((id: string) => {
    setSelectedId(id);
    const p = positions.get(id);
    if (p) rf.setCenter(p.x + NODE_W / 2, p.y + NODE_H / 2, { zoom: 1.1, duration: 300 });
  }, [rf, positions]);
  useImperativeHandle(ref, () => ({ fitToScreen, focusOn }), [fitToScreen, focusOn]);

  // Legend: only the types actually present (visible) in this graph.
  const presentTypes = useMemo(() => {
    const seen = new Map<string, TypeStyle>();
    for (const n of visNodes) {
      const st = styleForType(n.type);
      if (!seen.has(st.kind)) seen.set(st.kind, st);
    }
    return [...seen.values()];
  }, [visNodes]);

  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;
  const selectedIsColumn = !!selected && isColumnNode(selected);
  // Column impact analysis over the FULL (flag-filtered) graph, so collapsed
  // downstream columns still count (L5 — "what breaks if this column changes").
  const selectedImpact = useMemo(
    () => (selected && selectedIsColumn ? columnImpact(allNodes, allEdges, selected.id) : null),
    [selected, selectedIsColumn, allNodes, allEdges],
  );
  const selectedParent = selected?.parentTableId ? nodeById.get(selected.parentTableId) : undefined;

  // Move keyboard focus onto the detail panel when a node is selected so
  // keyboard users are taken to its actions (and Esc/Tab return them out).
  useEffect(() => {
    if (selectedId && detailRef.current) detailRef.current.focus();
  }, [selectedId]);

  return (
    <ResizableCanvasRegion
      storageKey="catalog-lineage"
      defaultPx={560}
      minPx={320}
      ariaLabel="Resize lineage canvas height"
    >
    <div className={s.shell} data-testid="lineage-canvas" aria-label="Data lineage canvas">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => setSelectedId((cur) => (cur === n.id ? null : n.id))}
        onPaneClick={() => setSelectedId(null)}
        onMove={(_, vp) => setZoom(vp.zoom)}
        minZoom={0.2}
        maxZoom={2}
        fitView
        // maxZoom keeps a small 3-6 node graph filling the canvas readably on open.
        fitViewOptions={{ padding: 0.2, maxZoom: 1.25 }}
        nodesDraggable
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
          <div className={s.toolbar}>
            <Input
              size="small"
              className={s.search}
              appearance="filled-lighter"
              contentBefore={<Search16Regular />}
              contentAfter={
                search
                  ? (
                    <Button
                      size="small"
                      appearance="transparent"
                      icon={<Dismiss16Regular />}
                      aria-label="Clear filter"
                      onClick={() => setSearch('')}
                    />
                  )
                  : undefined
              }
              placeholder="Filter assets…"
              value={search}
              onChange={(_, d) => setSearch(d.value)}
              aria-label="Filter lineage assets by name or type"
            />
            <Tooltip content={focusMode ? 'Focus mode on — showing only the selected asset’s chain' : 'Focus on asset — isolate the upstream+downstream chain of the selected node'} relationship="label">
              <Button
                size="small"
                appearance={focusMode ? 'primary' : 'subtle'}
                icon={<TargetRegular />}
                onClick={() => setFocusMode((v) => !v)}
              >
                Focus
              </Button>
            </Tooltip>
            {columnsPresent && (
              <Tooltip
                content={anyExpanded
                  ? 'Collapse every table’s column fan-out back to the table-grain graph'
                  : 'Expand every table into its columns (column-level lineage)'}
                relationship="label"
              >
                <Button
                  size="small"
                  appearance={anyExpanded ? 'primary' : 'subtle'}
                  icon={<ColumnTriple20Regular />}
                  onClick={toggleAllColumns}
                  data-testid="lineage-columns-toggle"
                >
                  Columns
                </Button>
              </Tooltip>
            )}
            {columnsPresent && (
              <Tooltip
                content={impactMode
                  ? 'Impact analysis on — a selected column highlights ONLY its downstream column chain (what breaks if it changes)'
                  : 'Impact analysis — select a column to highlight only its downstream column chain'}
                relationship="label"
              >
                <Button
                  size="small"
                  appearance={impactMode ? 'primary' : 'subtle'}
                  icon={<TargetArrow20Regular />}
                  onClick={() => setImpactMode((v) => !v)}
                  data-testid="lineage-impact-toggle"
                >
                  Impact
                </Button>
              </Tooltip>
            )}
            <Tooltip content="Auto-layout (left→right by lineage depth)" relationship="label">
              <Button size="small" appearance="subtle" icon={<Organization20Regular />} aria-label="Auto-layout" onClick={fitToScreen} />
            </Tooltip>
            <Tooltip content="Zoom to fit" relationship="label">
              <Button size="small" appearance="subtle" icon={<FullScreenMaximize20Regular />} aria-label="Zoom to fit" onClick={fitToScreen} />
            </Tooltip>
          </div>
        </Panel>

        <Panel position="bottom-left">
          <div className={s.legend} aria-label="Lineage legend">
            {presentTypes.map((t) => (
              <span key={t.kind} className={s.legendItem}>
                <span className={s.legendSwatch} style={{ background: readableAccent(t.color, mode === 'dark') }} />
                <Caption1>{t.kind}</Caption1>
              </span>
            ))}
          </div>
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
          nodeColor={(n) => readableAccent(styleForType((n.data as LineageNodeData)?.node?.type).color, mode === 'dark')}
          nodeStrokeColor={tokens.colorNeutralStroke2}
          maskColor={accentTint(tokens.colorNeutralBackground3, 70)}
          style={{ backgroundColor: tokens.colorNeutralBackground1 }}
        />
      </ReactFlow>

      {selected && (
        <div
          ref={detailRef}
          className={s.detail}
          role="complementary"
          aria-label={selectedIsColumn ? 'Column detail and impact analysis' : 'Asset detail'}
          tabIndex={-1}
          onKeyDown={(e) => { if (e.key === 'Escape') setSelectedId(null); }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalM }}>
            <span style={{ color: selected.deleted ? tokens.colorNeutralForeground4 : styleForType(selected.type).color, display: 'inline-flex' }}>
              {(() => { const I = styleForType(selected.type).Icon; return <I fontSize={tokens.fontSizeBase400} />; })()}
            </span>
            <Text weight="semibold" size={300} style={{ wordBreak: 'break-all', textDecoration: selected.deleted ? 'line-through' : undefined }}>{selected.label}</Text>
            {selected.deleted && <Badge size="small" appearance="tint" color="danger">Deleted</Badge>}
          </div>
          {selected.deleted && (
            <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM }}>
              This asset was deleted in Loom. It still appears here from a metadata-plane
              entity (e.g. a Purview catalog asset) that hasn&rsquo;t been garbage-collected
              yet. Run Reconcile lineage on the Lineage admin surface to purge it.
            </Caption1>
          )}

          <div className={s.detailRow}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Source</Caption1>
            <Badge appearance="tint" color="brand">{SOURCE_LABEL[selected.source]}</Badge>
          </div>
          {selectedIsColumn ? (
            <>
              <div className={s.detailRow}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Column of</Caption1>
                {selectedParent ? (
                  <Button
                    size="small"
                    appearance="transparent"
                    className={ns.inlineTextButton}
                    onClick={() => focusOn(selectedParent.id)}
                  >
                    <Text size={200} truncate wrap={false}>{selectedParent.label}</Text>
                  </Button>
                ) : (
                  <Text size={200} style={{ wordBreak: 'break-all' }}>{selected.columnOf || selected.parentTableId || '—'}</Text>
                )}
              </div>

              {/* Impact summary — what breaks if this column changes (L5). */}
              <div className={s.detailRow} data-testid="column-impact-summary">
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Impact if this column changes</Caption1>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 }}>
                  <Badge
                    appearance={selectedImpact && selectedImpact.downstream.length > 0 ? 'filled' : 'tint'}
                    color={selectedImpact && selectedImpact.downstream.length > 0 ? 'danger' : 'success'}
                    size="small"
                  >
                    {selectedImpact?.downstream.length || 0} downstream column{(selectedImpact?.downstream.length || 0) === 1 ? '' : 's'}
                  </Badge>
                  {!!selectedImpact?.directDownstream && (
                    <Badge appearance="tint" color="danger" size="small">{selectedImpact.directDownstream} direct</Badge>
                  )}
                  {!!selectedImpact?.transitiveDownstream && (
                    <Badge appearance="tint" color="warning" size="small">{selectedImpact.transitiveDownstream} transitive</Badge>
                  )}
                </div>
                {(selectedImpact?.downstream.length || 0) === 0 && (
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    No recorded downstream column depends on this column — a change here is
                    isolated as far as captured lineage knows.
                  </Caption1>
                )}
              </div>

              {!!selectedImpact?.downstream.length && (
                <div className={s.detailRow} data-testid="column-impact-downstream">
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Downstream columns</Caption1>
                  <div className={s.columnList}>
                    {selectedImpact.downstream.slice(0, 24).map((c) => (
                      <ColumnChainRow key={c.id} entry={c} onJump={focusOn} canJump={visNodes.some((n) => n.id === c.id)} />
                    ))}
                    {selectedImpact.downstream.length > 24 && <Caption1>+{selectedImpact.downstream.length - 24} more</Caption1>}
                  </div>
                </div>
              )}

              <div className={s.detailRow} data-testid="column-impact-upstream">
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Upstream columns</Caption1>
                {selectedImpact?.upstream.length ? (
                  <div className={s.columnList}>
                    {selectedImpact.upstream.slice(0, 24).map((c) => (
                      <ColumnChainRow key={c.id} entry={c} onJump={focusOn} canJump={visNodes.some((n) => n.id === c.id)} />
                    ))}
                    {selectedImpact.upstream.length > 24 && <Caption1>+{selectedImpact.upstream.length - 24} more</Caption1>}
                  </div>
                ) : (
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    No recorded upstream column feeds this column.
                  </Caption1>
                )}
              </div>

              <div className={s.detailRow}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Identifier</Caption1>
                <Text size={100} font="monospace" style={{ wordBreak: 'break-all' }}>{selected.id}</Text>
              </div>

              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                <Button
                  size="small"
                  appearance="primary"
                  icon={<TargetArrow20Regular />}
                  data-testid="column-analyze-impact"
                  onClick={() => { setImpactMode(true); setFocusMode(true); focusOn(selected.id); }}
                >
                  Analyze impact
                </Button>
                <Button size="small" appearance="secondary" icon={<TargetRegular />} onClick={() => { setImpactMode(false); setFocusMode(true); focusOn(selected.id); }}>
                  Focus chain
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className={s.detailRow}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Type</Caption1>
                <Text size={200}>{selected.type || styleForType(selected.type).kind}</Text>
              </div>
              {selected.multiSource && selected.multiSource.length > 1 && (
                <div className={s.detailRow}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Matched in</Caption1>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
                    {selected.multiSource.map((src) => (
                      <Badge key={src} size="small" appearance="outline">{SOURCE_LABEL[src as LineageSource] || src}</Badge>
                    ))}
                  </div>
                </div>
              )}
              <div className={s.detailRow}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Identifier</Caption1>
                <Text size={100} font="monospace" style={{ wordBreak: 'break-all' }}>{selected.id}</Text>
              </div>
              {selected.columns && selected.columns.length > 0 && (
                <div className={s.detailRow}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Columns ({selected.columns.length})</Caption1>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXXS, minWidth: 0 }}>
                    {selected.columns.slice(0, 24).map((c) => (
                      <Badge key={c} size="small" appearance="outline" color="subtle" style={{ maxWidth: '100%' }}>{c}</Badge>
                    ))}
                    {selected.columns.length > 24 && <Caption1>+{selected.columns.length - 24} more</Caption1>}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                <Button size="small" appearance="primary" icon={<TargetRegular />} onClick={() => { setFocusMode(true); focusOn(selected.id); }}>
                  Focus chain
                </Button>
                {!!(columnsByTable.get(selected.id)?.length) && (
                  <Button
                    size="small"
                    appearance="secondary"
                    icon={expandedTables.has(selected.id) ? <ChevronUp12Regular /> : <ChevronDown12Regular />}
                    onClick={() => toggleTable(selected.id)}
                  >
                    {expandedTables.has(selected.id) ? 'Hide columns' : `Show ${columnsByTable.get(selected.id)!.length} columns`}
                  </Button>
                )}
                {selected.openHref && !selected.deleted && (
                  <Button size="small" appearance="secondary" as="a" href={selected.openHref}>
                    Open item
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
    </ResizableCanvasRegion>
  );
});

/** Public component — wraps the inner canvas in a ReactFlowProvider. */
export const LineageCanvas = forwardRef<LineageCanvasHandle, LineageCanvasProps>(function LineageCanvas(props, ref) {
  return (
    <ReactFlowProvider>
      <LineageCanvasInner {...props} ref={ref} />
    </ReactFlowProvider>
  );
});
