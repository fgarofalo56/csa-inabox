'use client';

/**
 * canvas-node-kit — the shared Web-5.0 canvas node visual system.
 *
 * THE FOUNDATION every canvas-node / canvas-edge file imports. It owns the
 * single source of truth for:
 *   • the 5-category accent palette (move/transform/control/external/iteration)
 *     mapped to the theme-aware `--loom-accent-*` CSS vars (light + dark already
 *     defined in app/globals.css), and the section glyph per category;
 *   • the per-type Fluent glyph + category resolution for pipeline activities
 *     (`getActivityVisual`) and mapping-data-flow transforms (`getTransformVisual`);
 *   • token-only tint helpers (`accentTint` / `accentGradient` / `portStyle`) —
 *     the kit owns ALL `color-mix(...)` strings; consumers pass only the accent
 *     var through `CanvasVisual`;
 *   • the shared node chrome (`CanvasNode` + `StatusChip`) — rail + gradient
 *     header (icon chip, title, status chip) + body + framed-container variant;
 *   • the shared Bezier edge base (`CanvasEdge`).
 *
 * NO raw px (except the fixed 11px handle geometry React Flow needs) and NO raw
 * hex — every colour/space/radius/shadow is a Fluent v9 `tokens.*` value or a
 * `--loom-accent-*` var combined via `color-mix`. All motion is gated behind
 * `prefers-reduced-motion: reduce` in the `makeStyles` rules below.
 *
 * Out-classes ADF Studio / Fabric / Power BI canvases: per-type glyph,
 * per-category accent + gradient header, elevation-on-hover, accent
 * selected-ring, typed animated edges, and framed containers with branch chips
 * — all theme-aware.
 *
 * This file has NO default export.
 */

import {
  Badge, Button, Caption1, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Slider, Spinner, Text, Tooltip, makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  // Category section glyphs
  ArrowSwap20Regular, Flowchart20Regular, Branch20Regular,
  PlugConnected20Regular, ArrowRepeatAll20Regular,
  // Activity-type glyphs (identical set to activity-icons.tsx ICONS)
  DocumentArrowRight20Regular, ArrowFlowUpRight20Regular,
  SearchInfo20Regular, DocumentText20Regular, Delete20Regular, Notebook20Regular,
  Rocket20Regular, Code20Regular, Database20Regular,
  BranchFork20Regular, ArrowSync20Regular, Clock20Regular,
  Tag20Regular, AddCircle20Regular, Filter20Regular, Globe20Regular,
  ErrorCircle20Regular, CheckmarkCircle20Regular, Mail20Regular, Apps20Regular,
  DataUsage20Regular, Flash20Regular, Server20Regular, Stream20Regular,
  DocumentJava20Regular, LocalLanguage20Regular, BrainCircuit20Regular,
  Beaker20Regular, LayerDiagonal20Regular, DataFunnel20Regular,
  BracesVariable20Regular, CloudArrowUp20Regular, DatabaseArrowRight20Regular,
  // Transform-catalog glyphs (identical set to mapping-dataflow-designer TRANSFORM_ICONS)
  DatabaseArrowDown20Regular, DatabaseArrowUp20Regular, Column20Regular,
  CalculatorMultiple20Regular, MathSymbols20Regular, Table20Regular,
  TableSwitch20Regular, PanelLeftHeader20Regular, KeyMultiple20Regular,
  NumberSymbol20Regular, Merge20Regular, CheckboxChecked20Regular,
  ArrowJoin20Regular, DocumentBulletList20Regular, TextQuote20Regular,
  ArrowSortDown20Regular, TableEdit20Regular,
} from '@fluentui/react-icons';
import {
  // v2 node-action-bar + ghost + right-rail glyphs
  Delete16Regular, Code16Regular, Copy16Regular, Open16Regular,
  Add24Regular, ChevronDown16Regular, ZoomIn20Regular, ZoomOut20Regular,
  FullScreenMaximize20Regular, Organization20Regular,
  ChevronDoubleRight20Regular, ChevronDoubleLeft20Regular, Lightbulb16Regular,
  Sparkle16Filled, Checkmark16Regular, Dismiss16Regular,
} from '@fluentui/react-icons';
import type { JSX } from 'react';
import { BaseEdge, getBezierPath, Handle, Position, Panel, useReactFlow, useViewport, type EdgeProps, type NodeProps } from '@xyflow/react';
import { memo, useState } from 'react';
import { transformByType, type TransformDef, type TransformCategory } from '@/lib/pipeline/dataflow-transform-catalog';
import {
  PORT_COLOR_KEY, isConditionalPort, resolvePortShape, portGeometry, ghostAnchorPosition,
  ghostEdgeId, GHOST_NODE_ID, operatorCategory, portLabelAnchorEdge,
  type PortKind, type PortShape, type PortColorKey,
  type AnchorNode, type GhostAnchorOpts, type PortSide,
} from './canvas-anatomy';
import { itemTypeIcon } from '@/lib/catalog/item-type-icon';

// =============================================================================
// A. Visual-mapping types + exports
// =============================================================================

/** The five Web-5.0 node categories. Drives accent + gradient + section glyph. */
export type CanvasNodeCategory = 'move' | 'transform' | 'control' | 'external' | 'iteration';

/** Node run/config state surfaced in the header StatusChip. */
export type CanvasNodeStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'warning';

export interface CanvasVisual {
  /** Type-specific Fluent glyph element, e.g. <Notebook20Regular/>. */
  icon: JSX.Element;
  /** One of the 5 categories → drives accent + gradient. */
  category: CanvasNodeCategory;
  /** The resolved theme-aware accent CSS-var string, e.g. 'var(--loom-accent-blue)'. */
  accent: string;
}

/**
 * Accent var per category — the SINGLE SOURCE OF TRUTH for node tinting. Each
 * resolves to a `--loom-accent-*` defined (light + dark) in app/globals.css.
 */
export const CATEGORY_ACCENT: Record<CanvasNodeCategory, string> = {
  move: 'var(--loom-accent-blue)',
  transform: 'var(--loom-accent-violet)',
  control: 'var(--loom-accent-teal)',
  external: 'var(--loom-accent-magenta)',
  iteration: 'var(--loom-accent-amber)',
};

/** Section glyph per category (palette / legend use). */
export const CATEGORY_ICON: Record<CanvasNodeCategory, JSX.Element> = {
  move: <ArrowSwap20Regular />,
  transform: <Flowchart20Regular />,
  control: <Branch20Regular />,
  external: <PlugConnected20Regular />,
  iteration: <ArrowRepeatAll20Regular />,
};

// ── Pipeline activity wire-type → glyph + category ───────────────────────────
//
// The kit keeps its OWN inline category map (per the activity-catalog comment:
// "the kit keeps its own inline category map") so it compiles independently of
// the activity-catalog helper. Keys are ADF wire `type` strings, identical to
// activity-icons.tsx ICONS — every distinct activity type has a DISTINCT glyph,
// with a single generic fallback (<Apps20Regular/> → 'move').

const ACTIVITY_ICONS: Record<string, JSX.Element> = {
  // Move & transform
  Copy: <DocumentArrowRight20Regular />,
  RefreshDataflow: <ArrowFlowUpRight20Regular />,
  ExecuteWranglingDataflow: <ArrowFlowUpRight20Regular />,
  ExecuteDataFlow: <Flowchart20Regular />,
  Lookup: <SearchInfo20Regular />,
  GetMetadata: <DocumentText20Regular />,
  Delete: <Delete20Regular />,
  // Notebooks
  DatabricksNotebook: <Notebook20Regular />,
  Notebook: <Notebook20Regular />,
  SynapseNotebook: <Notebook20Regular />,
  // Spark jobs
  SparkJob: <Rocket20Regular />,
  SynapseSparkJobDefinitionActivity: <Rocket20Regular />,
  // Databricks Jar / Python
  DatabricksSparkJar: <DocumentJava20Regular />,
  DatabricksSparkPython: <LocalLanguage20Regular />,
  // Orchestration
  ExecutePipeline: <Flowchart20Regular />,
  Script: <Code20Regular />,
  SqlServerStoredProcedure: <Database20Regular />,
  StoredProcedure: <Database20Regular />,
  // Control flow / iteration
  ForEach: <ArrowRepeatAll20Regular />,
  IfCondition: <BranchFork20Regular />,
  Switch: <Branch20Regular />,
  Until: <ArrowSync20Regular />,
  Wait: <Clock20Regular />,
  SetVariable: <Tag20Regular />,
  AppendVariable: <AddCircle20Regular />,
  Filter: <Filter20Regular />,
  WebActivity: <Globe20Regular />,
  Web: <Globe20Regular />,
  WebHook: <PlugConnected20Regular />,
  Fail: <ErrorCircle20Regular />,
  Validation: <CheckmarkCircle20Regular />,
  // Office 365 Outlook
  Office365Outlook: <Mail20Regular />,
  Office365OutlookSendEmail: <Mail20Regular />,
  // HDInsight family
  HDInsightHive: <DataUsage20Regular />,
  HDInsightSpark: <Flash20Regular />,
  HDInsightMapReduce: <Server20Regular />,
  HDInsightStreaming: <Stream20Regular />,
  HDInsightPig: <DataFunnel20Regular />,
  // Azure Function & ML
  AzureFunctionActivity: <BracesVariable20Regular />,
  AzureMLExecutePipeline: <BrainCircuit20Regular />,
  AzureMLBatchExecution: <Beaker20Regular />,
  // U-SQL (Data Lake Analytics)
  'DataLakeAnalyticsU-SQL': <LayerDiagonal20Regular />,
};

const ACTIVITY_CATEGORY: Record<string, CanvasNodeCategory> = {
  // move
  Copy: 'move',
  RefreshDataflow: 'move',
  ExecuteWranglingDataflow: 'move',
  ExecuteDataFlow: 'move',
  Lookup: 'move',
  GetMetadata: 'move',
  Delete: 'move',
  // transform
  DatabricksNotebook: 'transform',
  Notebook: 'transform',
  SynapseNotebook: 'transform',
  SparkJob: 'transform',
  SynapseSparkJobDefinitionActivity: 'transform',
  DatabricksSparkJar: 'transform',
  DatabricksSparkPython: 'transform',
  Script: 'transform',
  SqlServerStoredProcedure: 'transform',
  StoredProcedure: 'transform',
  HDInsightHive: 'transform',
  HDInsightSpark: 'transform',
  HDInsightMapReduce: 'transform',
  HDInsightStreaming: 'transform',
  HDInsightPig: 'transform',
  AzureMLExecutePipeline: 'transform',
  AzureMLBatchExecution: 'transform',
  'DataLakeAnalyticsU-SQL': 'transform',
  // control
  WebActivity: 'control',
  Web: 'control',
  WebHook: 'control',
  Fail: 'control',
  Validation: 'control',
  SetVariable: 'control',
  AppendVariable: 'control',
  Filter: 'control',
  Wait: 'control',
  ExecutePipeline: 'control',
  // external
  Office365OutlookSendEmail: 'external',
  Office365Outlook: 'external',
  AzureFunctionActivity: 'external',
  // iteration (the containers)
  ForEach: 'iteration',
  Until: 'iteration',
  IfCondition: 'iteration',
  Switch: 'iteration',
};

/**
 * Resolve the canvas visual (glyph + category + accent) for a pipeline activity
 * wire `type`. Unmapped types fall back to a generic Apps glyph in the `move`
 * category (matching activity-icons.tsx' generic fallback).
 */
export function getActivityVisual(type?: string): CanvasVisual {
  // Migrate the Fabric-era `RefreshDataflow` token the same way findByType does.
  const t = type === 'RefreshDataflow' ? 'ExecuteWranglingDataflow' : type;
  const category: CanvasNodeCategory = (t && ACTIVITY_CATEGORY[t]) || 'move';
  const icon = (t && ACTIVITY_ICONS[t]) || <Apps20Regular />;
  return { icon, category, accent: CATEGORY_ACCENT[category] };
}

// ── Mapping-data-flow transform `type` → glyph + category ────────────────────
//
// Catalog `TransformDef.icon` string → Fluent glyph. Moved here from
// mapping-dataflow-designer.tsx so both files share one map. Identical set.

const TRANSFORM_ICONS: Record<string, JSX.Element> = {
  DatabaseArrowDown: <DatabaseArrowDown20Regular />,
  DatabaseArrowUp: <DatabaseArrowUp20Regular />,
  Column: <Column20Regular />,
  CalculatorMultiple: <CalculatorMultiple20Regular />,
  MathSymbols: <MathSymbols20Regular />,
  Table: <Table20Regular />,
  TableSwitch: <TableSwitch20Regular />,
  PanelLeftHeader: <PanelLeftHeader20Regular />,
  KeyMultiple: <KeyMultiple20Regular />,
  NumberSymbol: <NumberSymbol20Regular />,
  ArrowSwap: <ArrowSwap20Regular />,
  PlugConnected: <PlugConnected20Regular />,
  Filter: <Filter20Regular />,
  ArrowSortDown: <ArrowSortDown20Regular />,
  TableEdit: <TableEdit20Regular />,
  CheckmarkCircle: <CheckmarkCircle20Regular />,
  Merge: <Merge20Regular />,
  SearchInfo: <SearchInfo20Regular />,
  CheckboxChecked: <CheckboxChecked20Regular />,
  ArrowJoin: <ArrowJoin20Regular />,
  BranchFork: <BranchFork20Regular />,
  Branch: <Branch20Regular />,
  Flowchart: <Flowchart20Regular />,
  DocumentBulletList: <DocumentBulletList20Regular />,
  TextQuote: <TextQuote20Regular />,
};

/** Glyph for a transform def (generic fallback). Shared with the mapping designer. */
export function transformIcon(def: TransformDef | undefined): JSX.Element {
  return (def?.icon && TRANSFORM_ICONS[def.icon]) || <Apps20Regular />;
}

/** TransformCategory (Learn grouping) → the 5 canvas categories. */
const TRANSFORM_CATEGORY_MAP: Record<TransformCategory, CanvasNodeCategory> = {
  'Source & sink': 'move',
  'Schema modifier': 'transform',
  'Row modifier': 'control',
  'Multiple inputs/outputs': 'iteration',
  Formatters: 'external',
};

/**
 * Resolve the canvas visual for a mapping-data-flow transform `type` token.
 * Resolves the TransformDef from the catalog; unmapped types fall back to the
 * generic Apps glyph in the `transform` category.
 */
export function getTransformVisual(type?: string): CanvasVisual {
  const def = type ? transformByType(type) : undefined;
  const category: CanvasNodeCategory = def ? TRANSFORM_CATEGORY_MAP[def.category] : 'transform';
  return { icon: transformIcon(def), category, accent: CATEGORY_ACCENT[category] };
}

// ── v3: BRANDED item-type node glyph (reuses the W1 icon source-of-truth) ─────
//
// Canvases whose nodes ARE catalog item types (deploy-planner, domain designer,
// lineage, model-view, task-flows) get the SAME branded glyph + family accent
// the tiles/list-rows use — resolved through `itemTypeIcon()` (lib/catalog),
// which is the single source of truth over the `itemVisual()` registry. This
// keeps a node's glyph + colour in lock-step with its catalog identity instead
// of a per-canvas one-off. Unknown keys fall back to the registry's neutral
// Document glyph, so this is always safe to call.

/**
 * Resolve a BRANDED CanvasVisual for a catalog item-type identifier — a route
 * `slug`, a Fabric/ARM `restType`, or a `WorkloadCategory`. The glyph + accent
 * come from the W1 icon SoT (`itemTypeIcon`); the accent is the family brand
 * colour (a hex that reads identically light + dark and drives the header
 * gradient / rail / selection ring via the kit's token-only tint helpers).
 *
 * `category` only nominally groups the node (the kit reads `accent`/`icon`, not
 * `category`, for item-branded nodes); callers may override it when a node maps
 * cleanly onto one of the five canvas categories.
 */
export function getItemVisual(
  key: string | null | undefined,
  category: CanvasNodeCategory = 'transform',
): CanvasVisual {
  const { icon: Icon, accent } = itemTypeIcon(key);
  return { icon: <Icon />, category, accent };
}

// ── v3: generic OPERATOR node glyph (source / transform / sink / filter / …) ──
//
// Canvases whose nodes are NOT catalog item types (eventstream, mapping data
// flow, agent/task flows) use generic operator roles. Each distinct role gets a
// DISTINCT Fluent glyph + a category accent (via `operatorCategory` in
// canvas-anatomy, unit-tested there). Unknown roles fall back to a Flowchart
// glyph in the `transform` category.

const OPERATOR_ICONS: Record<string, JSX.Element> = {
  // move (sources / ingest / reads)
  source: <CloudArrowUp20Regular />,
  input: <CloudArrowUp20Regular />,
  ingest: <ArrowFlowUpRight20Regular />,
  copy: <DocumentArrowRight20Regular />,
  read: <DatabaseArrowDown20Regular />,
  lookup: <SearchInfo20Regular />,
  // transform (verbs)
  transform: <Flowchart20Regular />,
  derive: <CalculatorMultiple20Regular />,
  select: <Column20Regular />,
  aggregate: <MathSymbols20Regular />,
  join: <ArrowJoin20Regular />,
  union: <Merge20Regular />,
  pivot: <Table20Regular />,
  unpivot: <TableSwitch20Regular />,
  window: <PanelLeftHeader20Regular />,
  rank: <NumberSymbol20Regular />,
  sort: <ArrowSortDown20Regular />,
  // control (filter / branch / sinks)
  filter: <Filter20Regular />,
  conditionalsplit: <BranchFork20Regular />,
  route: <Branch20Regular />,
  branch: <BranchFork20Regular />,
  gate: <CheckmarkCircle20Regular />,
  sink: <DatabaseArrowUp20Regular />,
  destination: <DatabaseArrowRight20Regular />,
  output: <DatabaseArrowRight20Regular />,
  write: <DatabaseArrowUp20Regular />,
  // external
  external: <PlugConnected20Regular />,
  webhook: <Globe20Regular />,
  notify: <Mail20Regular />,
  // iteration
  foreach: <ArrowRepeatAll20Regular />,
  loop: <ArrowRepeatAll20Regular />,
  until: <ArrowSync20Regular />,
};

/**
 * Resolve the CanvasVisual (glyph + category + accent) for a generic operator
 * role (case-insensitive). Distinct glyph per role; the category (and thus the
 * accent) comes from `operatorCategory`. Unknown roles → Flowchart / transform.
 */
export function getOperatorVisual(role: string | undefined): CanvasVisual {
  const key = (role ?? '').toLowerCase().trim();
  const category = operatorCategory(key);
  const icon = OPERATOR_ICONS[key] ?? <Flowchart20Regular />;
  return { icon, category, accent: CATEGORY_ACCENT[category] };
}

// ── Token-only tint helpers (the kit owns ALL color-mix strings) ─────────────

/** `color-mix` of the accent toward transparent at `pct`% (theme-aware tint). */
export function accentTint(accent: string, pct: number): string {
  return `color-mix(in srgb, ${accent} ${pct}%, transparent)`;
}

/** 135deg header gradient for the given accent (16% → 4% accent over transparent). */
export function accentGradient(accent: string): string {
  return `linear-gradient(135deg, ${accentTint(accent, 16)}, ${accentTint(accent, 4)})`;
}

/**
 * Semantic port-colour KEY (from canvas-anatomy) → a theme-aware Loom token.
 * The kit owns the key→token mapping so anatomy stays colour-string-free.
 */
export const PORT_COLOR_TOKEN: Record<PortColorKey, string> = {
  green: tokens.colorPaletteGreenForeground1,
  red: tokens.colorPaletteRedForeground1,
  neutral: tokens.colorNeutralForeground3,
  brand: tokens.colorBrandForeground1,
  stroke: tokens.colorBrandStroke1,
};

export interface PortStyleOpts {
  /** Force a shape; defaults to square for typed conditions, circle otherwise. */
  shape?: PortShape;
  /**
   * When a known `PortKind` ('in'|'out'|'success'|'fail'|'skip'|'complete') is
   * passed as `cond`, the border colour is derived from the typed palette and
   * `accent` is ignored. Any other `cond` string keeps the legacy behaviour
   * (accent border, circle) so every existing call site is byte-for-byte
   * unchanged.
   */
  filled?: boolean;
}

/**
 * Handle style for a port. Back-compat: `portStyle('in', accent)` and
 * `portStyle('out', accent)` behave exactly as before (11px circle, brand /
 * accent border). NEW (v2): pass a typed condition ('success'|'fail'|'skip'|
 * 'complete') to get Fabric-style small COLORED SQUARES whose colour comes from
 * the typed palette, and/or pass `opts.shape` to force circle↔square. Geometry
 * stays raw px because React Flow hit-tests the handle DOM box.
 */
export function portStyle(cond: string, accent: string, opts: PortStyleOpts = {}): React.CSSProperties {
  const typed = isConditionalPort(cond as PortKind);
  // Only the four typed conditions route through the palette + square default.
  // 'in' → brand-stroke, 'out'/legacy strings → accent circle (byte-for-byte
  // back-compat with every pre-v2 call site).
  const border = cond === 'in'
    ? tokens.colorBrandStroke1
    : typed
      ? PORT_COLOR_TOKEN[PORT_COLOR_KEY[cond as PortKind]]
      : accent;
  const shape = typed
    ? resolvePortShape(cond as PortKind, opts.shape)
    : (opts.shape ?? 'circle');
  const geo = portGeometry(shape);
  return {
    width: geo.size,
    height: geo.size,
    borderRadius: geo.borderRadius,
    background: opts.filled ? border : tokens.colorNeutralBackground1,
    border: `2px solid ${border}`,
    zIndex: 3,
  };
}

// =============================================================================
// C. Shared edge — base Bezier edge both variants wrap.
// =============================================================================

export interface CanvasEdgeData {
  /** The edge is part of a running path → animate the dashed flow. */
  active?: boolean;
  [k: string]: unknown;
}

/**
 * Base Bezier edge. Applies stroke / width / animation / marker from props; the
 * pipeline `LoomBezierEdge` and the data-flow `DataStreamEdge` both wrap it.
 * `flowing` turns on the marching-ants dashed animation (React Flow draws the
 * `animated` dash from the edge's `animated` flag; we additionally set a token
 * dash array so the flow reads as "data/run in progress").
 */
export const CanvasEdge: React.FC<EdgeProps & { stroke: string; flowing?: boolean }> = ({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  selected, markerEnd, stroke, flowing,
}) => {
  const [path] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      className={flowing ? 'loom-canvas-edge-flowing' : undefined}
      style={{
        stroke,
        strokeWidth: selected ? 2.5 : 1.7,
        ...(flowing ? { strokeDasharray: '6 4' } : null),
      }}
    />
  );
};

// =============================================================================
// B. Shared node chrome — styles, StatusChip, CanvasNode.
// =============================================================================

const useStyles = makeStyles({
  // Outer card.
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    cursor: 'pointer',
    userSelect: 'none',
    transitionProperty: 'box-shadow, transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      boxShadow: tokens.shadow16,
      transform: 'translateY(-1px)',
    },
    // Inline node action bar reveals on node hover (Fabric shows it on
    // hover/select). Selected nodes keep it pinned — see `.selected` below.
    '& .loom-node-actionbar': {
      opacity: 0,
      pointerEvents: 'none',
      transitionProperty: 'opacity',
      transitionDuration: tokens.durationFast,
      transitionTimingFunction: tokens.curveEasyEase,
    },
    '&:hover .loom-node-actionbar': {
      opacity: 1,
      pointerEvents: 'auto',
    },
    '&:focus-within .loom-node-actionbar': {
      opacity: 1,
      pointerEvents: 'auto',
    },
    '@media (prefers-reduced-motion: reduce)': {
      transitionDuration: '0.01ms',
      ':hover': { transform: 'none' },
      '& .loom-node-actionbar': { transitionDuration: '0.01ms' },
    },
  },
  selected: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    // Pin the action bar visible while selected.
    '& .loom-node-actionbar': {
      opacity: 1,
      pointerEvents: 'auto',
    },
  },
  error: {
    border: `1px solid ${tokens.colorPaletteRedBorder2}`,
  },
  // Framed-container body tint (amber wash).
  framed: {
    border: `1.5px dashed ${CATEGORY_ACCENT.iteration}`,
    borderRadius: tokens.borderRadiusXLarge,
    background: accentTint(CATEGORY_ACCENT.iteration, 5),
  },
  // Accent rail down the left edge.
  rail: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '6px',
    borderRadius: tokens.borderRadiusSmall,
    zIndex: 1,
  },
  // Header strip (gradient).
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
    borderTopLeftRadius: tokens.borderRadiusMedium,
    borderTopRightRadius: tokens.borderRadiusMedium,
  },
  // Wrapper so the running-status pulse ring can sit BEHIND the icon chip
  // without shifting layout (same 28px footprint as the chip).
  iconChipWrap: {
    position: 'relative',
    flexShrink: 0,
    width: '28px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconChip: {
    flexShrink: 0,
    width: '28px',
    height: '28px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  // ── v3: run-status pulse ring (only mounted while status='running') ────────
  // A subtle expanding brand ring behind the icon chip that reads as "this node
  // is actively running". Motion tokens only (durationUltraSlow / curveEasyEase);
  // under prefers-reduced-motion the ring holds a single quiet static outline —
  // NO animation — so the running state is still conveyed without motion.
  pulseRing: {
    position: 'absolute',
    top: '-3px',
    left: '-3px',
    right: '-3px',
    bottom: '-3px',
    borderRadius: tokens.borderRadiusLarge,
    border: `2px solid ${tokens.colorBrandStroke1}`,
    pointerEvents: 'none',
    zIndex: 0,
    animationName: {
      '0%': { transform: 'scale(0.82)', opacity: 0.55 },
      '70%': { transform: 'scale(1.28)', opacity: 0 },
      '100%': { transform: 'scale(1.28)', opacity: 0 },
    },
    animationDuration: tokens.durationUltraSlow,
    animationIterationCount: 'infinite',
    animationTimingFunction: tokens.curveEasyEase,
    '@media (prefers-reduced-motion: reduce)': {
      animationName: 'none',
      transform: 'none',
      opacity: 0.4,
    },
  },
  // ── v3: typed port label ('rows' / 'events' / 'model') ─────────────────────
  // Small token-driven caption anchored just INSIDE the node edge at the port,
  // on a neutral chip so it stays readable over the gradient and never overlaps
  // the bezier edge. Truncates instead of pushing node width.
  portLabel: {
    position: 'absolute',
    transform: 'translateY(-50%)',
    fontSize: tokens.fontSizeBase100,
    lineHeight: tokens.lineHeightBase100,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground3,
    background: tokens.colorNeutralBackground1,
    paddingLeft: tokens.spacingHorizontalXXS,
    paddingRight: tokens.spacingHorizontalXXS,
    borderRadius: tokens.borderRadiusSmall,
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    maxWidth: '76px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    zIndex: 3,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  headerAction: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
  },
  // Body region (description + badges).
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
  },
  description: {
    color: tokens.colorNeutralForeground3,
  },
  badges: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  branchChips: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  // StatusChip dot + label.
  statusChip: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
  },
  // ── v2: inline node action bar (delete / view-JSON / clone / open) ─────────
  actionBar: {
    position: 'absolute',
    top: tokens.spacingVerticalXS,
    right: tokens.spacingHorizontalXS,
    zIndex: 4,
    display: 'flex',
    alignItems: 'center',
    gap: '1px',
    padding: '1px',
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow8,
  },
  actionDanger: {
    color: tokens.colorPaletteRedForeground1,
  },
  // ── v2: inline live-status detail row ('Loading data…') ───────────────────
  statusDetail: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
    paddingBottom: tokens.spacingVerticalXS,
    color: tokens.colorBrandForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  // ── v2: ghost next-step placeholder node ──────────────────────────────────
  ghost: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalL,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1.5px dashed ${tokens.colorNeutralStroke1}`,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    transitionProperty: 'border-color, background, color',
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      border: `1.5px dashed ${tokens.colorBrandStroke1}`,
      color: tokens.colorBrandForeground1,
      background: accentTint('var(--loom-accent-blue)', 6),
    },
    '@media (prefers-reduced-motion: reduce)': {
      transitionDuration: '0.01ms',
    },
  },
  ghostIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    borderRadius: tokens.borderRadiusCircular,
    border: `1.5px dashed currentColor`,
  },
  ghostLabel: {
    fontWeight: tokens.fontWeightSemibold,
    color: 'inherit',
    textAlign: 'center',
  },
  ghostHint: {
    color: tokens.colorNeutralForeground4,
    textAlign: 'center',
  },
  // ── W7: AOAI-driven suggestion variant of the ghost card ──────────────────
  ghostSuggest: {
    border: `1.5px solid ${tokens.colorBrandStroke1}`,
    background: accentTint('var(--loom-accent-blue)', 8),
    color: tokens.colorNeutralForeground1,
    cursor: 'default',
    ':hover': {
      border: `1.5px solid ${tokens.colorBrandStroke1}`,
      color: tokens.colorNeutralForeground1,
      background: accentTint('var(--loom-accent-blue)', 12),
    },
  },
  ghostSuggestKicker: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  ghostSuggestReason: {
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
  ghostSuggestActions: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXXS,
  },
  // ── v2: standardized canvas right rail ────────────────────────────────────
  rail2: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow8,
  },
  railZoomText: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: 'tabular-nums',
    minWidth: '34px',
    textAlign: 'center',
  },
  railSlider: {
    // Vertical Fluent slider inside the rail.
    height: '96px',
  },
  railDivider: {
    width: '60%',
    height: '1px',
    background: tokens.colorNeutralStroke2,
    marginTop: tokens.spacingVerticalXXS,
    marginBottom: tokens.spacingVerticalXXS,
  },
});

/** Per-status colour (tokens only) + visible label for the StatusChip. */
const STATUS_COLOR: Record<Exclude<CanvasNodeStatus, 'idle'>, string> = {
  running: tokens.colorBrandForeground1,
  succeeded: tokens.colorPaletteGreenForeground1,
  failed: tokens.colorPaletteRedForeground1,
  skipped: tokens.colorNeutralForeground3,
  warning: tokens.colorPaletteDarkOrangeForeground1,
};

const STATUS_LABEL: Record<Exclude<CanvasNodeStatus, 'idle'>, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
  warning: 'Warning',
};

/**
 * Right-aligned header chip reflecting node run/config state. On `idle` it
 * renders the type-label Badge (accent-tinted). Other states render a coloured
 * dot + label (running shows a tiny Spinner instead of a dot).
 */
export const StatusChip: React.FC<{ status: CanvasNodeStatus; idleLabel: string; accent: string }> = ({
  status, idleLabel, accent,
}) => {
  const styles = useStyles();
  if (status === 'idle') {
    return (
      <Badge
        appearance="tint"
        size="small"
        style={{
          flexShrink: 0,
          backgroundColor: accentTint(accent, 14),
          color: accent,
          borderColor: accentTint(accent, 28),
        }}
      >
        {idleLabel}
      </Badge>
    );
  }
  const color = STATUS_COLOR[status];
  return (
    <span className={styles.statusChip} style={{ color }} aria-label={`Status ${STATUS_LABEL[status]}`}>
      {status === 'running'
        ? <Spinner size="tiny" />
        : <span className={styles.statusDot} style={{ background: color }} aria-hidden="true" />}
      {STATUS_LABEL[status]}
    </span>
  );
};

/**
 * A single inline node action (Fabric shows delete / view-code </> / clone /
 * open on hover/select). The kit owns layout/visibility/hover; each host wires
 * its own callbacks. Use `standardNodeActions()` for the common 4-action set.
 */
export interface NodeAction {
  key: string;
  icon: JSX.Element;
  /** aria-label + tooltip text. */
  label: string;
  onClick: (e: React.MouseEvent) => void;
  /** Tint the button red (e.g. delete). */
  danger?: boolean;
  disabled?: boolean;
}

export interface CanvasNodeProps {
  width: number;                       // 200 pipeline, 210 data-flow
  title: string;
  visual: CanvasVisual;                // from getActivityVisual / getTransformVisual
  selected?: boolean;
  status?: CanvasNodeStatus;           // default 'idle'
  /** idle-state type label shown in the header chip (e.g. 'Copy data', 'Derived column'). */
  typeLabel: string;
  error?: boolean;
  description?: string;
  /**
   * Inline live-status detail shown as a row under the header (e.g.
   * 'Loading data…' with a spinner) — surfaced only when present. Pairs with
   * status='running' to bring Fabric's in-node "Loading data…" affordance.
   */
  statusDetail?: string;
  /**
   * Inline node action bar (delete / view-JSON / clone / open). Rendered
   * top-right, revealed on node hover / focus and pinned while selected. Empty
   * / undefined → no bar (every pre-v2 call site renders identically).
   */
  actionBar?: NodeAction[];
  /** Extra meta badges (Preview / Save-only / Activities(n)) rendered in the body. */
  badges?: React.ReactNode;
  /** Header trailing slot (e.g. the container pencil/drill button). */
  headerAction?: React.ReactNode;
  /** Handles + container preview etc. rendered as children (ports stay owned by the caller). */
  children?: React.ReactNode;
  /** Container framing variant (ForEach/If/Until/Switch). */
  framed?: boolean;
  /** Branch chips for framed If/Switch containers. */
  branchChips?: Array<{ label: string; count: number }>;
  /** Passthrough DOM attrs the caller needs for selectors/tests (id, data-*, aria-label). */
  rootProps?: React.HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
}

/**
 * The shared node card. Renders rail + gradient header (icon chip, title,
 * status chip, optional header action) + body (description + badges). The
 * `framed` variant draws the amber dashed container chrome + branch chips.
 * Ports / container mini-preview are passed through `children` (the caller owns
 * the React Flow <Handle>s + their ids).
 */
export const CanvasNode: React.FC<CanvasNodeProps> = ({
  width, title, visual, selected, status = 'idle', typeLabel, error,
  description, statusDetail, actionBar, badges, headerAction, children,
  framed, branchChips, rootProps,
}) => {
  const styles = useStyles();
  const { accent } = visual;

  const ring = error
    ? `0 0 0 2px ${tokens.colorPaletteRedBackground3}`
    : selected
      ? `0 0 0 2px ${accent}`
      : undefined;

  const { style: rootStyle, className: rootClassName, ...restRootProps } = rootProps ?? {};

  return (
    <div
      {...restRootProps}
      className={mergeClasses(
        styles.root,
        framed && styles.framed,
        selected && !error && styles.selected,
        error && styles.error,
        rootClassName,
      )}
      style={{
        width,
        ...(ring ? { boxShadow: ring } : null),
        ...rootStyle,
      }}
    >
      {/* Accent rail anchoring the category colour. */}
      <span className={styles.rail} style={{ background: accent }} aria-hidden="true" />

      {/* Inline node action bar — revealed on hover/focus, pinned on select.
          `nodrag`/`nopan` keep clicks off the React Flow drag+pan handlers. */}
      {actionBar && actionBar.length > 0 && (
        <div
          className={mergeClasses(styles.actionBar, 'loom-node-actionbar', 'nodrag', 'nopan')}
          role="toolbar"
          aria-label={`${title} actions`}
          data-node-actionbar={title}
        >
          {actionBar.map((a) => (
            <Tooltip key={a.key} content={a.label} relationship="label">
              <Button
                size="small"
                appearance="subtle"
                icon={a.icon}
                aria-label={a.label}
                disabled={a.disabled}
                data-node-action={a.key}
                className={a.danger ? styles.actionDanger : undefined}
                onClick={(e) => { e.stopPropagation(); a.onClick(e); }}
              />
            </Tooltip>
          ))}
        </div>
      )}

      {/* Header strip with category gradient. */}
      <div className={styles.header} style={{ background: accentGradient(accent), marginLeft: '6px' }}>
        <span className={styles.iconChipWrap} aria-hidden="true">
          {/* Run-status pulse ring — animates only while running (reduced-motion
              downgrades to a quiet static outline). */}
          {status === 'running' && <span className={styles.pulseRing} />}
          <span
            className={styles.iconChip}
            style={{ background: accentTint(accent, 14), color: accent }}
          >
            {visual.icon}
          </span>
        </span>
        <span className={styles.title} title={title}>{title}</span>
        <StatusChip status={status} idleLabel={typeLabel} accent={accent} />
        {headerAction && <span className={styles.headerAction}>{headerAction}</span>}
      </div>

      {/* Branch chips for framed If/Switch containers. */}
      {framed && branchChips && branchChips.length > 0 && (
        <div className={styles.branchChips} style={{ marginLeft: '6px' }}>
          {branchChips.map((b) => (
            <Badge
              key={b.label}
              appearance="tint"
              size="small"
              style={{
                backgroundColor: accentTint(CATEGORY_ACCENT.iteration, 14),
                color: CATEGORY_ACCENT.iteration,
              }}
            >
              {b.label} ({b.count})
            </Badge>
          ))}
        </div>
      )}

      {/* Inline live-status detail row (Fabric's in-node 'Loading data…'). */}
      {statusDetail && (
        <div className={styles.statusDetail} style={{ marginLeft: '6px' }} aria-live="polite">
          {status === 'running' && <Spinner size="extra-tiny" />}
          <span>{statusDetail}</span>
        </div>
      )}

      {/* Body — description + meta badges (only rendered when present). */}
      {(description || badges) && (
        <div className={styles.body} style={{ marginLeft: '6px' }}>
          {description && <Caption1 className={styles.description}>{description}</Caption1>}
          {badges && <div className={styles.badges}>{badges}</div>}
        </div>
      )}

      {/* Caller-owned ports + container mini-preview. */}
      {children}
    </div>
  );
};

// ── v3: typed port handle + optional label ───────────────────────────────────

export interface CanvasPortProps {
  /** Handle id (host-owned; keep stable — selectors/edges depend on it). */
  id: string;
  type: 'source' | 'target';
  position: Position;
  /** Accent CSS var/hex for the handle border (from the node's visual). */
  accent: string;
  /**
   * Port condition — 'in'|'out' or a typed condition ('success'|'fail'|'skip'|
   * 'complete'). Defaults to 'in' for targets, 'out' for sources (back-compat
   * with the raw `<Handle style={portStyle(...)}>` pattern).
   */
  cond?: string;
  opts?: PortStyleOpts;
  /**
   * Optional typed port label (e.g. 'rows', 'events', 'model'). Rendered as a
   * small token-driven caption just inside the node edge at the port — Fabric
   * shows typed ports; omit for an unlabeled handle (identical to before).
   */
  label?: string;
  /** Handle inset from the node edge in px (React Flow hit-tests the DOM box). */
  offset?: number;
  /** Vertical anchor for a left/right port (default centered). */
  top?: string | number;
}

/**
 * A single typed port: a React Flow `<Handle>` styled via `portStyle` PLUS an
 * optional typed label. Opt-in — hosts that declare port types adopt this in
 * place of a bare `<Handle style={portStyle(...)}>`; the handle geometry/ids are
 * unchanged so existing edges + selectors keep working. Token-driven and
 * positioned inside the node edge so the label never overlaps the bezier.
 */
export const CanvasPort: React.FC<CanvasPortProps> = ({
  id, type, position, accent, cond, opts, label, offset = 6, top = '50%',
}) => {
  const styles = useStyles();
  const condition = cond ?? (type === 'target' ? 'in' : 'out');
  const side: PortSide =
    position === Position.Right ? 'right'
      : position === Position.Left ? 'left'
        : position === Position.Top ? 'top' : 'bottom';

  const handleStyle: React.CSSProperties = { ...portStyle(condition, accent, opts) };
  if (side === 'left') { handleStyle.left = -offset; handleStyle.top = top; }
  else if (side === 'right') { handleStyle.right = -offset; handleStyle.top = top; }
  else if (side === 'top') { handleStyle.top = -offset; }
  else { handleStyle.bottom = -offset; }

  const edge = portLabelAnchorEdge(side);

  return (
    <>
      <Handle id={id} type={type} position={position} style={handleStyle} />
      {label && (
        <span
          className={styles.portLabel}
          style={{ [edge]: tokens.spacingHorizontalS, top }}
          data-port-label={id}
        >
          {label}
        </span>
      )}
    </>
  );
};

// =============================================================================
// D. v2 shared primitives — node action set, ghost next-step node, right rail.
// =============================================================================

/**
 * The common Fabric node action set: delete / view-JSON (</>) / clone / open.
 * Pass only the callbacks a host supports — omitted ones drop out of the bar,
 * so every host gets a consistent icon + order without re-importing glyphs.
 */
export function standardNodeActions(opts: {
  onExplain?: (e: React.MouseEvent) => void;
  onViewJson?: (e: React.MouseEvent) => void;
  onClone?: (e: React.MouseEvent) => void;
  onOpen?: (e: React.MouseEvent) => void;
  onDelete?: (e: React.MouseEvent) => void;
  labels?: Partial<Record<'viewJson' | 'clone' | 'open' | 'delete' | 'explain', string>>;
}): NodeAction[] {
  const l = opts.labels ?? {};
  const actions: NodeAction[] = [];
  if (opts.onOpen) actions.push({ key: 'open', icon: <Open16Regular />, label: l.open ?? 'Open', onClick: opts.onOpen });
  // "Explain this step" (W19) — a real AOAI summary of the single node grounded
  // on its definition + its canvas/lineage neighbors.
  if (opts.onExplain) actions.push({ key: 'explain', icon: <Lightbulb16Regular />, label: l.explain ?? 'Explain', onClick: opts.onExplain });
  if (opts.onViewJson) actions.push({ key: 'view-json', icon: <Code16Regular />, label: l.viewJson ?? 'View JSON', onClick: opts.onViewJson });
  if (opts.onClone) actions.push({ key: 'clone', icon: <Copy16Regular />, label: l.clone ?? 'Clone', onClick: opts.onClone });
  if (opts.onDelete) actions.push({ key: 'delete', icon: <Delete16Regular />, label: l.delete ?? 'Delete', onClick: opts.onDelete, danger: true });
  return actions;
}

// ── Ghost next-step node ─────────────────────────────────────────────────────

export interface GhostNextStepOption {
  key: string;
  label: string;
  icon?: JSX.Element;
  onSelect: () => void;
}

/**
 * Data carried on a ghost React Flow node (`type: 'ghost'`). Hosts compute the
 * position with `ghostAnchorPosition(...)` and register `GhostNextStepNode` in
 * their `nodeTypes`. A single-action ghost uses `onClick`; a menu ghost uses
 * `options`.
 */
export interface GhostNodeData {
  /** Primary prompt, e.g. 'Add a destination'. */
  label: string;
  /** Secondary line, e.g. 'Transform events or route to a sink'. */
  hint?: string;
  icon?: JSX.Element;
  /** Single click-to-insert action (no dropdown). */
  onClick?: () => void;
  /** Multiple next-step choices → renders a menu. */
  options?: GhostNextStepOption[];
  /** Accent CSS var (defaults to move/blue). */
  accent?: string;
  /** Render a left target handle so an edge can connect into the ghost. */
  withTarget?: boolean;
  /**
   * W7 — an AOAI-driven "next step" suggestion. When present the ghost renders
   * the branded suggestion variant (Sparkle kicker + label + reason + Accept /
   * Dismiss) INSTEAD of the static menu/single modes. `onAccept` inserts the
   * suggested node; `onDismiss` hides it (and the host suppresses re-suggesting
   * the same graph). While `suggestionLoading` the card shows a thinking state.
   */
  aiSuggestion?: { label: string; reason?: string };
  onAcceptSuggestion?: () => void;
  onDismissSuggestion?: () => void;
  suggestionLoading?: boolean;
  [k: string]: unknown;
}

const GHOST_WIDTH = 190;

/** Presentational ghost card (no React Flow dependency — unit/story friendly). */
export const GhostNextStepCard: React.FC<{ data: GhostNodeData; width?: number }> = ({ data, width = GHOST_WIDTH }) => {
  const styles = useStyles();
  const accent = data.accent ?? CATEGORY_ACCENT.move;
  const icon = data.icon ?? <Add24Regular />;

  const inner = (
    <>
      <span className={styles.ghostIcon} style={{ color: accent }} aria-hidden="true">{icon}</span>
      <Caption1 className={styles.ghostLabel}>{data.label}</Caption1>
      {data.hint && <Caption1 className={styles.ghostHint}>{data.hint}</Caption1>}
    </>
  );

  // W7 — AOAI suggestion variant. Takes precedence over the static menu/single
  // modes: the ghost shows the single best next step with Accept / Dismiss.
  if (data.aiSuggestion) {
    const sug = data.aiSuggestion;
    return (
      <div
        className={mergeClasses(styles.ghost, styles.ghostSuggest, 'nodrag', 'nopan')}
        style={{ width }}
        data-ghost-node="ai-suggestion"
        aria-label={`Suggested next step: ${sug.label}`}
      >
        <span className={styles.ghostSuggestKicker}>
          <Sparkle16Filled aria-hidden /> Suggested next step
        </span>
        <Caption1 className={styles.ghostLabel}>{sug.label}</Caption1>
        {sug.reason && <Caption1 className={styles.ghostSuggestReason}>{sug.reason}</Caption1>}
        <div className={styles.ghostSuggestActions}>
          <Button
            size="small"
            appearance="primary"
            icon={<Checkmark16Regular />}
            onClick={data.onAcceptSuggestion}
            data-ghost-accept="1"
          >
            Add
          </Button>
          <Button
            size="small"
            appearance="subtle"
            icon={<Dismiss16Regular />}
            onClick={data.onDismissSuggestion}
            data-ghost-dismiss="1"
            aria-label="Dismiss suggestion"
          />
        </div>
      </div>
    );
  }

  // W7 — while AOAI is thinking of a next step, show a quiet loading affordance
  // (the static menu still returns below once loading clears with no suggestion).
  if (data.suggestionLoading) {
    return (
      <div
        className={mergeClasses(styles.ghost, 'nodrag', 'nopan')}
        style={{ width }}
        data-ghost-node="ai-loading"
        aria-busy="true"
        aria-label="Finding a suggested next step"
      >
        <Spinner size="tiny" />
        <Caption1 className={styles.ghostHint}>Suggesting a next step…</Caption1>
      </div>
    );
  }

  if (data.options && data.options.length > 0) {
    return (
      <Menu positioning="below">
        <MenuTrigger disableButtonEnhancement>
          <div
            className={mergeClasses(styles.ghost, 'nodrag', 'nopan')}
            style={{ width }}
            role="button"
            tabIndex={0}
            aria-label={data.label}
            aria-haspopup="menu"
            data-ghost-node="menu"
          >
            {inner}
            <Badge appearance="ghost" size="small" icon={<ChevronDown16Regular />} iconPosition="after">
              Choose
            </Badge>
          </div>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {data.options.map((o) => (
              <MenuItem key={o.key} icon={o.icon} onClick={o.onSelect} data-ghost-option={o.key}>
                {o.label}
              </MenuItem>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>
    );
  }

  return (
    <div
      className={mergeClasses(styles.ghost, 'nodrag', 'nopan')}
      style={{ width }}
      role="button"
      tabIndex={0}
      aria-label={data.label}
      data-ghost-node="single"
      onClick={data.onClick}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && data.onClick) { e.preventDefault(); data.onClick(); } }}
    >
      {inner}
    </div>
  );
};

/**
 * React Flow custom node wrapping GhostNextStepCard. Register under
 * `nodeTypes.ghost` and give the ghost node id `GHOST_NODE_ID`. The optional
 * left target handle lets the trailing real node draw a dashed edge into it.
 */
function GhostNextStepNodeImpl({ data }: NodeProps) {
  const d = data as GhostNodeData;
  return (
    <>
      {d.withTarget && (
        <Handle
          id="in"
          type="target"
          position={Position.Left}
          style={{ ...portStyle('in', tokens.colorNeutralStroke1), left: -6, opacity: 0.6 }}
          isConnectable={false}
        />
      )}
      <GhostNextStepCard data={d} />
    </>
  );
}
export const GhostNextStepNode = memo(GhostNextStepNodeImpl);

// ── Standardized canvas right rail ───────────────────────────────────────────

export interface CanvasRightRailProps {
  /** Current zoom (React Flow viewport.zoom). Drives the slider + % readout. */
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  onZoomChange: (zoom: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  /** Optional ELK/auto-layout action — button hidden when omitted. */
  onAutoLayout?: () => void;
  /** Collapsed rail shows only the expand toggle. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

/**
 * The standardized canvas right rail: collapse toggle + zoom-in / vertical zoom
 * slider / zoom % / zoom-out + fit + auto-layout. Presentational — the host
 * wires callbacks to `useReactFlow()` and drops this into a
 * `<Panel position="bottom-right">` (or "top-right"). One rail for every canvas
 * so zoom/fit/auto-layout read + behave identically surface to surface.
 */
export function CanvasRightRail({
  zoom, minZoom = 0.25, maxZoom = 2, onZoomChange, onZoomIn, onZoomOut,
  onFit, onAutoLayout, collapsed, onToggleCollapse,
}: CanvasRightRailProps) {
  const styles = useStyles();
  const pct = `${Math.round(zoom * 100)}%`;

  if (collapsed) {
    return (
      <div className={styles.rail2} role="toolbar" aria-label="Canvas controls (collapsed)" data-canvas-rail="collapsed">
        <Tooltip content="Show canvas controls" relationship="label">
          <Button size="small" appearance="subtle" icon={<ChevronDoubleLeft20Regular />} aria-label="Expand canvas controls" onClick={onToggleCollapse} />
        </Tooltip>
      </div>
    );
  }

  return (
    <div className={styles.rail2} role="toolbar" aria-label="Canvas controls" data-canvas-rail="expanded">
      {onToggleCollapse && (
        <Tooltip content="Collapse controls" relationship="label">
          <Button size="small" appearance="subtle" icon={<ChevronDoubleRight20Regular />} aria-label="Collapse canvas controls" onClick={onToggleCollapse} />
        </Tooltip>
      )}
      <Tooltip content="Zoom in" relationship="label">
        <Button size="small" appearance="subtle" icon={<ZoomIn20Regular />} aria-label="Zoom in" onClick={onZoomIn} />
      </Tooltip>
      <Slider
        className={styles.railSlider}
        vertical
        min={Math.round(minZoom * 100)}
        max={Math.round(maxZoom * 100)}
        value={Math.round(zoom * 100)}
        onChange={(_, d) => onZoomChange(d.value / 100)}
        aria-label="Zoom level"
      />
      <Text className={styles.railZoomText} aria-hidden="true">{pct}</Text>
      <Tooltip content="Zoom out" relationship="label">
        <Button size="small" appearance="subtle" icon={<ZoomOut20Regular />} aria-label="Zoom out" onClick={onZoomOut} />
      </Tooltip>
      <span className={styles.railDivider} aria-hidden="true" />
      <Tooltip content="Zoom to fit" relationship="label">
        <Button size="small" appearance="subtle" icon={<FullScreenMaximize20Regular />} aria-label="Zoom to fit" onClick={onFit} />
      </Tooltip>
      {onAutoLayout && (
        <Tooltip content="Auto-layout" relationship="label">
          <Button size="small" appearance="subtle" icon={<Organization20Regular />} aria-label="Auto-layout" onClick={onAutoLayout} />
        </Tooltip>
      )}
    </div>
  );
}

export interface CanvasRailPanelProps {
  /** Optional ELK/auto-layout action — button hidden when omitted. */
  onAutoLayout?: () => void;
  /** Panel corner. Defaults to bottom-left (clear of the bottom-right MiniMap). */
  position?: 'bottom-left' | 'top-left' | 'bottom-right' | 'top-right';
}

/**
 * Self-contained canvas rail: drops straight into a `<ReactFlow>` as a child and
 * needs NO host wiring. Reads the live viewport via `useViewport()` and drives
 * zoom/fit through `useReactFlow()`, so canvases that render `<ReactFlowProvider>`
 * inline (no in-provider component holding zoom state) still carry the shared
 * rail with a single line — `<CanvasRailPanel />` in place of `<Controls />`.
 * For hosts that already track zoom + collapse state (e.g. the pipeline canvas),
 * use `<CanvasRightRail>` directly in a host `<Panel>` instead.
 */
export function CanvasRailPanel({ onAutoLayout, position = 'bottom-left' }: CanvasRailPanelProps) {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const [collapsed, setCollapsed] = useState(false);
  return (
    <Panel position={position}>
      <CanvasRightRail
        zoom={zoom}
        minZoom={0.25}
        maxZoom={2}
        onZoomChange={(z) => rf.setViewport({ ...rf.getViewport(), zoom: z }, { duration: 120 })}
        onZoomIn={() => rf.zoomIn({ duration: 120 })}
        onZoomOut={() => rf.zoomOut({ duration: 120 })}
        onFit={() => rf.fitView({ padding: 0.2, maxZoom: 1.25, duration: 200 })}
        onAutoLayout={onAutoLayout}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
      />
    </Panel>
  );
}

// ── Re-export the pure anatomy helpers so hosts import everything from the kit ─
export {
  ghostAnchorPosition, ghostEdgeId, GHOST_NODE_ID,
  resolvePortShape, portGeometry, isConditionalPort, PORT_COLOR_KEY,
  operatorCategory, portLabelAnchorEdge,
};
export type { PortKind, PortShape, PortColorKey, AnchorNode, GhostAnchorOpts, PortSide };
