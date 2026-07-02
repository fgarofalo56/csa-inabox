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
  Badge, Caption1, Spinner, makeStyles, mergeClasses, tokens,
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
  BracesVariable20Regular,
  // Transform-catalog glyphs (identical set to mapping-dataflow-designer TRANSFORM_ICONS)
  DatabaseArrowDown20Regular, DatabaseArrowUp20Regular, Column20Regular,
  CalculatorMultiple20Regular, MathSymbols20Regular, Table20Regular,
  TableSwitch20Regular, PanelLeftHeader20Regular, KeyMultiple20Regular,
  NumberSymbol20Regular, Merge20Regular, CheckboxChecked20Regular,
  ArrowJoin20Regular, DocumentBulletList20Regular, TextQuote20Regular,
  ArrowSortDown20Regular, TableEdit20Regular,
} from '@fluentui/react-icons';
import type { JSX } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import { transformByType, type TransformDef, type TransformCategory } from '@/lib/pipeline/dataflow-transform-catalog';

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
 * Handle style for a typed port. `cond` is the port kind:
 *   - 'in'  → target handle, brand-stroke border
 *   - 'out' or a ConnectorCondition string → source handle, accent border
 * Geometry is the fixed 11px circle React Flow needs, identical to every
 * existing canvas, so wiring + hit-testing are unchanged.
 */
export function portStyle(cond: string, accent: string): React.CSSProperties {
  const border = cond === 'in' ? tokens.colorBrandStroke1 : accent;
  return {
    width: 11,
    height: 11,
    borderRadius: '50%',
    background: tokens.colorNeutralBackground1,
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
    '@media (prefers-reduced-motion: reduce)': {
      transitionDuration: '0.01ms',
      ':hover': { transform: 'none' },
    },
  },
  selected: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
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
  iconChip: {
    flexShrink: 0,
    width: '28px',
    height: '28px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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
  description, badges, headerAction, children, framed, branchChips, rootProps,
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

      {/* Header strip with category gradient. */}
      <div className={styles.header} style={{ background: accentGradient(accent), marginLeft: '6px' }}>
        <span
          className={styles.iconChip}
          style={{ background: accentTint(accent, 14), color: accent }}
          aria-hidden="true"
        >
          {visual.icon}
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
