'use client';

/**
 * FormatPane — the "Format" right-rail tab of the Loom-native Report Designer.
 *
 * Power BI report-authoring parity (ui-parity.md): the Format pane is the
 * contextual surface that styles the *selected* visual. Wave-1 brings it to
 * one-for-one with the PBI Format pane's sections:
 *
 *   • Title                 (text + show)
 *   • Data colors           (lead-series swatch from the Loom brand palette)
 *   • Data labels           (show + position)
 *   • Total labels          (stacked/combo/waterfall totals)
 *   • Axes                  (X / Y visibility)
 *   • Legend                (show + position)
 *   • Plot area             (transparency)
 *   • Background            (color swatch + transparency)            ← General/Effects
 *   • Border                (show + color + radius)                  ← General/Effects
 *   • Shadow                (show)                                   ← General/Effects
 *   • General               (alt text + a pointer to canvas grid sizing)
 *   • Styles                (preset)
 *   • Number format         (value preset)
 *   • Conditional formatting (delegated to conditional-format.tsx)
 *
 * Each section renders CONTEXTUALLY for the selected visual type — including the
 * 8 new wave-1 visuals (combo, waterfall, funnel, gauge, kpi, treemap,
 * multi-row card, ribbon) — so a gauge shows data colors but no axes, a combo
 * shows axes + total labels, a card shows only the general/effects sections,
 * exactly as Power BI does.
 *
 * Loom-themed (web3-ui.md): Fluent UI v9 + Loom design tokens, cards/sections,
 * no hard-coded spacing/colors/radii — `tokens.*` throughout.
 *
 * no-freeform-config.md: every control here is structured — a text Input, a
 * Switch, a swatch radiogroup, a Slider, or a Dropdown of presets. The user
 * NEVER types a format string / DAX / JSON. The data-color swatches are drawn
 * from the same Loom brand palette `LoomChart` renders with, so what you pick is
 * what the chart paints.
 *
 * no-vaporware.md: there are no dead controls. Every control writes a structured
 * field of {@link ReportVisualFormat} that round-trips through PUT
 * /api/items/report/[id]/definition and is applied client-side by
 * `VisualBody`/`LoomChart` (titles, palette, axis/legend/label visibility,
 * background/border/shadow chrome, number formatting). The Conditional
 * formatting section delegates to the real {@link ConditionalFormatEditor}
 * (conditional-format.tsx), whose painters scan the visual's actual `/query`
 * rows; it surfaces only when the host wires the field list. Capabilities not
 * yet built (maps, AI visuals, R/Python, bookmarks, themes, export) are tracked
 * as honest ⚠️/❌ rows in docs/fiab/parity/report-designer.md — never as
 * disabled "coming soon" controls here.
 *
 * no-fabric-dependency.md: Azure-native by construction — pure client styling
 * over the Synapse/AAS `/query` rows; nothing here reaches a Fabric/Power BI
 * workspace (the PBI embed stays the opt-in publish path).
 *
 * Persistence: this component is pure/controlled. It receives the selected
 * visual's `format` (read from `visual.config.format`) and emits the next sparse
 * `ReportVisualFormat` via `onChange`. The host designer wires that to
 * `mutateVisual(id, v => ({ ...v, format }))`, which round-trips through the
 * /definition route (additive — the read-only viewer and PBIR provisioner
 * ignore unknown `config.format` keys). No backend call originates here.
 *
 * When no visual is selected the pane renders a graceful EmptyState rather than
 * disabled controls.
 */

import { useId, useState, lazy, Suspense, Fragment } from 'react';
import type { ReactElement } from 'react';
import {
  Caption1, Checkbox, Divider, Dropdown, Input, Option, SearchBox, Slider, Spinner,
  Switch, Text, makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  TextT20Regular, ColorRegular, RulerRegular, TextBulletListSquare20Regular,
  NumberSymbol20Regular, TextNumberFormat20Regular, Tag20Regular, Square20Regular,
  DocumentBorder20Regular, Sparkle20Regular, DataBarVertical20Regular,
  FullScreenMaximize20Regular, PaintBrush20Regular, Color20Regular, Info16Regular,
  ArrowAutofitWidth20Regular, ArrowAutofitHeight20Regular, Gauge20Regular,
  ChartMultiple20Regular, Eye20Regular, Comment20Regular, ZoomIn20Regular, Grid20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
// Type-only import (erased at compile time — no runtime cycle with
// conditional-format.tsx, which imports LOOM_DATA_PALETTE from this module).
import type { ReportConditionalFormat, CondFieldOption, CondField } from './conditional-format';

// The Conditional-formatting editor is loaded through a dynamic import so the
// module graph stays acyclic: conditional-format.tsx statically depends on this
// file (for LOOM_DATA_PALETTE); pulling it in lazily (a separate chunk) means
// this module is always fully initialised before that one evaluates.
const LazyConditionalFormatEditor = lazy(() => import('./conditional-format'));

// ── Format model (persisted on visual.config.format) ─────────────────────────

export type LegendPosition = 'top' | 'bottom' | 'left' | 'right';
export type NumberFormatPreset =
  | 'general' | 'whole' | 'decimal' | 'percent' | 'currency' | 'thousands';
/** Data-label placement (structured; superset across chart families). */
export type DataLabelPosition = 'auto' | 'inside' | 'outside' | 'above' | 'below';
/** A named visual style preset (PBI "Style presets"). */
export type StylePreset = 'default' | 'minimal' | 'bold' | 'condensed' | 'accent';

// ── wave-6 structured Format-card types (per the W6 shared contract §A) ────────
// All additive/optional. They are authored by the new Format cards below and read
// — in preference to the legacy scalars — by the Wave-6 `loom-chart-format.ts`
// adapter (chart levers + row transforms) and the `visual-chrome.tsx` overlay
// (titles, axis titles, effects, header icons). Until the one-line Wave-5
// integration seam lands, the existing `format={fmt}` passthrough still paints
// the Wave-5-native subset, so nothing regresses.

/** Value-axis display-unit scaling (PBI "Display units"). */
export type AxisDisplayUnits = 'auto' | 'none' | 'thousands' | 'millions' | 'billions';
/** Category-label rotation (model-only: the frozen W5 chart exposes no rotation prop — honest ❌). */
export type AxisLabelRotation = 0 | 45 | -45 | 90 | -90;

/**
 * Per-axis structured format. `axisX`=category, `axisY`=primary value,
 * `axisY2`=secondary value. Read by the adapter (show→showXAxis/showYAxis,
 * max→sharedValueMax, gridlines→structural.gridline, label color/font→
 * structural.foreground/fontFamily, log/displayUnits/decimals→row transforms,
 * series→comboLineSeries, min/max/target→gauge range) and by VisualChrome
 * (title margins).
 */
export interface ReportAxisFormat {
  show?: boolean;            // supersedes showXAxis/showYAxis
  title?: string;           // axis title text (rendered by VisualChrome margins)
  showTitle?: boolean;
  gridlines?: boolean;      // value-axis gridline visibility (axisY/axisY2)
  gridlineColor?: string;   // Loom-palette token
  min?: number; max?: number;   // value-axis domain (axisY/axisY2)
  logScale?: boolean;       // log10 value axis
  displayUnits?: AxisDisplayUnits;
  decimals?: number;        // 0..4
  labelFont?: string; labelFontSize?: number; labelColor?: string;
  labelRotation?: AxisLabelRotation;  // model-only honest gap (no W5 prop yet)
  axisType?: 'categorical' | 'continuous'; // axisX only (model-only honest gap)
  series?: string[];        // axisY2 only: result-column names on the secondary axis
  target?: number;          // gauge axis only: target marker value
}

/** Data-label content composition (PBI label "Value"/"Title and value"/…). */
export type LabelContent = 'value' | 'titleValue' | 'titleValueDetail';

/** Rich title (supersedes titleText/showTitle). Rendered by VisualChrome. */
export interface ReportTitleFormat {
  show?: boolean; text?: string;
  font?: string; fontSize?: number; color?: string;
  align?: 'left' | 'center' | 'right';
  heading?: 'title' | 'subtitle';
  subtitle?: string; divider?: boolean;
  /** fx-conditional title (measure → title text); reuses conditional-format CondField. */
  conditionalField?: CondField;
}

/** Legend styling (extends showLegend/legendPosition). `title` is a model-only honest gap. */
export interface ReportLegendFormat {
  title?: string; font?: string; fontSize?: number; color?: string;
  style?: 'normal' | 'bold' | 'italic';
}

/** Unified visual effects (supersedes background/border/shadow/plotArea scalars). */
export interface ReportEffectsFormat {
  shadow?: { show?: boolean; color?: string; offsetX?: number; offsetY?: number; position?: 'outer' | 'inner' };
  border?: { show?: boolean; color?: string; width?: number; radius?: number };
  plotAreaBg?: { color?: string; transparency?: number };
}

/** Per-field "Apply settings to" number-format override (table path). */
export interface ReportNumberFormatOverride { preset?: NumberFormatPreset; decimals?: number; units?: AxisDisplayUnits }

/** Header-icon keys (visual header buttons; rendered/hidden by VisualChrome). */
export type HeaderIconKey =
  | 'visualInfo' | 'drillUp' | 'drillDown' | 'drillToggle' | 'filter' | 'focus' | 'more';

/**
 * Structured, fully-optional visual formatting. Stored SPARSE (only the fields
 * the author touched); read through {@link normalizeFormat} for the scalar
 * defaults, and via the per-section accessors for the nested effect objects.
 */
export interface ReportVisualFormat {
  /** Overrides the visual's display title. Empty → fall back to `visual.title`. */
  titleText?: string;
  /** Show the title bar. Default true. */
  showTitle?: boolean;
  /**
   * Ordered data-color palette. Element 0 is the lead/series-1 color; consumers
   * should call {@link resolveDataColors} to expand it to a full palette.
   */
  dataColors?: string[];
  /** Cartesian X axis visibility. Default true. */
  showXAxis?: boolean;
  /** Cartesian Y axis visibility. Default true. */
  showYAxis?: boolean;
  /** Legend visibility (charts with a Legend well). Default true. */
  showLegend?: boolean;
  /** Legend placement. Default 'bottom'. */
  legendPosition?: LegendPosition;
  /** Value number-format preset. Default 'general'. */
  numberFormat?: NumberFormatPreset;

  // ── wave-1 additions (all optional/sparse) ──────────────────────────────────

  /**
   * Per-point data labels (charts). Default off. Wave-6 EXTENDED with
   * font/color/units/decimals/background/content — `color`/`units`/`decimals`
   * are live adapter levers (foreground / row pre-scale); `font`/`background`/
   * `content` round-trip in the model and light up when the W5 chart reads them.
   */
  dataLabels?: {
    show?: boolean; position?: DataLabelPosition;
    font?: string; color?: string; units?: AxisDisplayUnits; decimals?: number;
    background?: string; content?: LabelContent;
  };
  /**
   * Stack/segment total labels (stacked column/bar/area, combo, waterfall).
   * Default off. Wave-6 EXTENDED with font/color/units (model round-trip).
   */
  totalLabels?: { show?: boolean; font?: string; color?: string; units?: AxisDisplayUnits };
  /** Visual background fill. `color` is a Loom-palette token; `transparency` 0–100. */
  background?: { color?: string; transparency?: number };
  /** Visual border. Default off. `color` is a Loom-palette token; `radius` in px. */
  border?: { show?: boolean; color?: string; radius?: number };
  /** Drop shadow on the visual card. Default off. */
  shadow?: { show?: boolean };
  /** Plot-area transparency (cartesian charts). 0–100. */
  plotArea?: { transparency?: number };
  /**
   * General · accessibility + (legacy) size hints. `altText` persists with the
   * visual (via /definition) for the accessible report export. `width` / `height`
   * / `lockAspect` are retained only for back-compat round-tripping of older
   * saved reports — the canvas owns visual size through the grid `w`/`h`
   * (use-canvas-layout.ts), so the Format pane no longer exposes inert px inputs
   * for them (they drove nothing; see no-vaporware.md).
   */
  general?: { width?: number; height?: number; lockAspect?: boolean; altText?: string };
  /** Named style preset. Default 'default'. */
  stylePreset?: StylePreset;
  /**
   * Structured conditional formatting (rules / color scale / data bars / icons),
   * delegated to conditional-format.tsx. Authored by {@link ConditionalFormatEditor}
   * and painted by its pure `applyConditionalFormat`/`cellStyleFor`.
   */
  conditionalFormat?: ReportConditionalFormat;

  // ── wave-6 structured Format-card objects (read in preference to the scalars) ──

  /** Category (X) axis structured format. Supersedes showXAxis. */
  axisX?: ReportAxisFormat;
  /** Primary value (Y) axis — range/log/units/decimals/gridlines/labels/title. Supersedes showYAxis. */
  axisY?: ReportAxisFormat;
  /** Secondary value (Y2) axis — `series` chooses the result columns on the right-hand line axis. */
  axisY2?: ReportAxisFormat;
  /** Rich title (supersedes titleText/showTitle for styling; text falls back to titleText). */
  title?: ReportTitleFormat;
  /** Legend styling (extends showLegend/legendPosition). */
  legend?: ReportLegendFormat;
  /** Unified effects (supersedes background/border/shadow/plotArea). */
  effects?: ReportEffectsFormat;
  /** Per-field "Apply settings to" number-format overrides (applied on the table path by VisualBody). */
  numberFormatByField?: Record<string, ReportNumberFormatOverride>;
  /** Visual-header icon visibility (rendered/hidden by VisualChrome). */
  headerIcons?: Partial<Record<HeaderIconKey, boolean>>;
  /** Per-visual Tooltips card. `fields` drives the chart hover popover (adapter → tooltips + hover). */
  tooltipOptions?: { show?: boolean; type?: 'default' | 'report'; fields?: string[] };
  /** Category-window zoom: [from..to] as 0..1 fractions; the adapter slices rows. */
  zoom?: { enabled?: boolean; from?: number; to?: number };
  /** Small-multiples grid: `facetColumn` enables faceting; columns/sharedY shape the grid. */
  smallMultiplesGrid?: { columns?: number; sharedY?: boolean; padding?: number; facetColumn?: string };
}

/** Defaults applied for display; never persisted unless the author changes one. */
export const DEFAULT_REPORT_FORMAT: Required<
  Pick<ReportVisualFormat,
    'showTitle' | 'showXAxis' | 'showYAxis' | 'showLegend' | 'legendPosition' | 'numberFormat' | 'stylePreset'>
> = {
  showTitle: true,
  showXAxis: true,
  showYAxis: true,
  showLegend: true,
  legendPosition: 'bottom',
  numberFormat: 'general',
  stylePreset: 'default',
};

/** Merge a sparse stored format with defaults for rendering the controls. */
export function normalizeFormat(f?: ReportVisualFormat | null): ReportVisualFormat & typeof DEFAULT_REPORT_FORMAT {
  return { ...DEFAULT_REPORT_FORMAT, ...(f ?? {}) };
}

// ── Loom brand palette (mirrors LoomChart PALETTE — dark-mode-safe tokens) ─────
// Keep this in lock-step with lib/components/charts/loom-chart.tsx so the swatch
// the author picks is exactly the color the chart paints.

interface Swatch { token: string; label: string }
export const LOOM_DATA_PALETTE: Swatch[] = [
  { token: tokens.colorBrandForeground1,         label: 'Brand' },
  { token: tokens.colorPaletteGreenForeground1,  label: 'Green' },
  { token: tokens.colorPalettePurpleForeground2, label: 'Purple' },
  { token: tokens.colorPaletteMarigoldForeground1, label: 'Marigold' },
  { token: tokens.colorPaletteRedForeground1,    label: 'Red' },
  { token: tokens.colorPaletteBlueForeground2,   label: 'Blue' },
  { token: tokens.colorPaletteTealForeground2,   label: 'Teal' },
  { token: tokens.colorPaletteBerryForeground1,  label: 'Berry' },
];

/**
 * Expand a stored `dataColors` (lead-color-first, possibly empty) into the full
 * ordered palette the charts cycle through: the picked lead color first, then
 * the rest of the brand palette. With no pick, returns the default palette.
 */
export function resolveDataColors(f?: ReportVisualFormat | null): string[] {
  const base = LOOM_DATA_PALETTE.map((s) => s.token);
  const lead = f?.dataColors?.[0];
  if (!lead || !base.includes(lead)) return base;
  return [lead, ...base.filter((c) => c !== lead)];
}

// ── Number-format presets (Power BI parity, structured) ───────────────────────

export const NUMBER_FORMAT_PRESETS: { id: NumberFormatPreset; label: string; example: string }[] = [
  { id: 'general',   label: 'General',           example: '1234.5' },
  { id: 'whole',     label: 'Whole · #,##0',     example: '1,235' },
  { id: 'decimal',   label: 'Decimal · #,##0.00', example: '1,234.50' },
  { id: 'percent',   label: 'Percent · 0.0%',    example: '12.3%' },
  { id: 'currency',  label: 'Currency · $',      example: '$1,234.50' },
  { id: 'thousands', label: 'Thousands · K/M/B', example: '1.2K' },
];

/** Data-label placement choices (structured — never a typed position string). */
export const DATA_LABEL_POSITIONS: { id: DataLabelPosition; label: string }[] = [
  { id: 'auto',    label: 'Auto' },
  { id: 'inside',  label: 'Inside end' },
  { id: 'outside', label: 'Outside end' },
  { id: 'above',   label: 'Above' },
  { id: 'below',   label: 'Below' },
];

/** Visual style presets (structured — applied by LoomChart / the table renderer). */
export const STYLE_PRESETS: { id: StylePreset; label: string; hint: string }[] = [
  { id: 'default',   label: 'Default',   hint: 'Loom standard styling' },
  { id: 'minimal',   label: 'Minimal',   hint: 'No gridlines, light chrome' },
  { id: 'bold',      label: 'Bold',      hint: 'Heavier type and fills' },
  { id: 'condensed', label: 'Condensed', hint: 'Tighter spacing, more density' },
  { id: 'accent',    label: 'Accent',    hint: 'Brand-accented header / bars' },
];

function formatThousands(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })}B`;
  if (abs >= 1e6) return `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`;
  if (abs >= 1e3) return `${(n / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
  return n.toLocaleString();
}

/**
 * Apply a number-format preset to a raw cell value for client-side rendering in
 * `VisualBody` / `LoomChart`. Non-numeric values pass through as-is; nullish →
 * an em-dash. `percent` treats the value as a fraction (0.123 → "12.3%").
 */
export function formatValue(value: unknown, preset?: NumberFormatPreset): string {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  switch (preset) {
    case 'whole':     return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    case 'decimal':   return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'percent':   return n.toLocaleString(undefined, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
    case 'currency':  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
    case 'thousands': return formatThousands(n);
    case 'general':
    default:          return n.toLocaleString();
  }
}

// ── wave-6 structured choice lists + pure helpers ─────────────────────────────

/** Font-family choices for the title/axis/legend font dropdowns (structured). */
export const FONT_CHOICES: string[] = [
  'Segoe UI', 'Arial', 'Calibri', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma', 'Consolas',
];

/** Value-axis / data-label display-unit choices (structured). */
export const DISPLAY_UNITS: { id: AxisDisplayUnits; label: string }[] = [
  { id: 'auto',      label: 'Auto' },
  { id: 'none',      label: 'None' },
  { id: 'thousands', label: 'Thousands (K)' },
  { id: 'millions',  label: 'Millions (M)' },
  { id: 'billions',  label: 'Billions (B)' },
];

/** Visual-header icons (PBI header buttons). */
export const HEADER_ICONS: { key: HeaderIconKey; label: string }[] = [
  { key: 'visualInfo',  label: 'Info' },
  { key: 'drillUp',     label: 'Drill up' },
  { key: 'drillDown',   label: 'Drill down' },
  { key: 'drillToggle', label: 'Drill toggle' },
  { key: 'filter',      label: 'Filters' },
  { key: 'focus',       label: 'Focus mode' },
  { key: 'more',        label: 'More options' },
];

/** Title-cased label for an enum value. */
const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Map a stored {@link CondField} back to the matching {@link CondFieldOption.key}. */
function condOptionKey(cf: CondField | undefined, fields: CondFieldOption[]): string {
  if (!cf) return '';
  const m = fields.find(
    (o) => (o.column ?? '') === (cf.column ?? '')
        && (o.measure ?? '') === (cf.measure ?? '')
        && (o.table ?? '') === (cf.table ?? ''),
  );
  return m?.key ?? '';
}
/** Resolve a {@link CondFieldOption.key} to a stored {@link CondField}. */
function condFromKey(key: string | undefined, fields: CondFieldOption[]): CondField | undefined {
  const o = fields.find((f) => f.key === key);
  return o ? { table: o.table, column: o.column, measure: o.measure } : undefined;
}
/** Display label for a stored {@link CondField} (falls back to "None"). */
function condLabel(cf: CondField | undefined, fields: CondFieldOption[]): string {
  const k = condOptionKey(cf, fields);
  return fields.find((f) => f.key === k)?.label ?? 'None';
}

// ── Which controls apply to which visual type (PBI-contextual) ────────────────
// Extended for the 8 wave-1 visuals. Each Set answers "does this visual expose
// this section in the PBI Format pane?" — a gauge has data colors but no axes,
// a combo has axes + a value legend + total labels, a card/KPI shows only the
// general/effects sections, exactly like Power BI.

/** Charts whose series are painted from the data-color palette. */
const DATA_COLOR_TYPES = new Set([
  'bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter',
  'combo', 'waterfall', 'funnel', 'gauge', 'treemap', 'ribbon',
]);
/** Cartesian charts with X/Y value axes (also gate Plot area). */
const CARTESIAN_TYPES = new Set([
  'bar', 'column', 'line', 'area', 'scatter', 'combo', 'waterfall', 'ribbon',
]);
/** Charts with a series legend. */
const LEGEND_TYPES = new Set([
  'bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter',
  'combo', 'treemap', 'ribbon',
]);
/** Charts that support per-point data labels. */
const DATA_LABEL_TYPES = new Set([
  'bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter',
  'combo', 'waterfall', 'funnel', 'treemap', 'ribbon',
]);
/** Charts that can stack and therefore show segment/stack TOTAL labels. */
const TOTAL_LABEL_TYPES = new Set(['column', 'bar', 'area', 'combo', 'waterfall', 'ribbon']);

const hasDataColors = (t?: string | null) => !!t && DATA_COLOR_TYPES.has(t);
const hasAxes       = (t?: string | null) => !!t && CARTESIAN_TYPES.has(t);
const hasLegend     = (t?: string | null) => !!t && LEGEND_TYPES.has(t);
const hasDataLabels = (t?: string | null) => !!t && DATA_LABEL_TYPES.has(t);
const hasTotalLabels = (t?: string | null) => !!t && TOTAL_LABEL_TYPES.has(t);
const hasPlotArea   = (t?: string | null) => !!t && CARTESIAN_TYPES.has(t);

// ── styles (Fluent v9 + Loom tokens; matches report-designer.tsx) ─────────────

const useStyles = makeStyles({
  pane: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    minHeight: 0,
  },
  sectionHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground2,
  },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  swatchGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalXS,
  },
  swatchBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalXS, minWidth: 0, cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'border-color, box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  swatchBtnActive: {
    border: `2px solid ${tokens.colorBrandStroke1}`,
    boxShadow: tokens.shadow4,
    backgroundColor: tokens.colorBrandBackground2,
  },
  swatchDot: {
    width: '22px', height: '22px', borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  swatchLabel: { color: tokens.colorNeutralForeground3 },
  resetRow: { display: 'flex', justifyContent: 'flex-end' },
  resetLink: {
    border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
    color: tokens.colorBrandForegroundLink, font: 'inherit',
  },
  muted: { color: tokens.colorNeutralForeground3 },
  // wave-1: compact inline swatch row (background / border colors)
  swatchRowInline: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
  },
  swatchDotSm: {
    width: '20px', height: '20px', padding: 0, cursor: 'pointer',
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    transitionProperty: 'transform, box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { transform: 'scale(1.12)' },
  },
  swatchDotSmActive: { border: `2px solid ${tokens.colorNeutralForeground1}`, boxShadow: tokens.shadow4 },
  noneBtn: {
    width: '20px', height: '20px', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200, lineHeight: 1,
  },
  noneBtnActive: { border: `2px solid ${tokens.colorNeutralForeground1}` },
  sliderRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  sliderVal: {
    minWidth: '44px', textAlign: 'right',
    color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums',
  },
  // wave-1: honest "size lives on the canvas" note (replaces inert px inputs)
  sizeNote: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  sizeNoteIcon: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  fieldLabel: { color: tokens.colorNeutralForeground3 },
  condBox: { display: 'flex', flexDirection: 'column', minHeight: 0 },
  loadRow: { display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalS },
});

type Styles = ReturnType<typeof useStyles>;

// ── Section header helper ─────────────────────────────────────────────────────

function SectionHead({ icon, label, styles }: { icon: ReactElement; label: string; styles: Styles }) {
  return (
    <div className={styles.sectionHead}>
      {icon}
      <Caption1><strong>{label}</strong></Caption1>
    </div>
  );
}

// ── Compact color-swatch row (background / border) ────────────────────────────

function ColorSwatchRow({ value, onChange, ariaLabel, allowNone, styles }: {
  value?: string;
  onChange: (color?: string) => void;
  ariaLabel: string;
  allowNone?: boolean;
  styles: Styles;
}): ReactElement {
  return (
    <div className={styles.swatchRowInline} role="radiogroup" aria-label={ariaLabel}>
      {allowNone && (
        <button
          type="button" role="radio" aria-checked={!value} aria-label="None" title="None"
          className={mergeClasses(styles.noneBtn, !value && styles.noneBtnActive)}
          onClick={() => onChange(undefined)}
        >
          ∅
        </button>
      )}
      {LOOM_DATA_PALETTE.map((sw) => {
        const active = value === sw.token;
        return (
          <button
            key={sw.token}
            type="button" role="radio" aria-checked={active} aria-label={sw.label} title={sw.label}
            className={mergeClasses(styles.swatchDotSm, active && styles.swatchDotSmActive)}
            style={{ backgroundColor: sw.token }}
            onClick={() => onChange(sw.token)}
          />
        );
      })}
    </div>
  );
}

// ── Transparency slider row (0–100) ──────────────────────────────────────────

function TransparencyRow({ value, onChange, ariaLabel, styles }: {
  value: number; onChange: (v: number) => void; ariaLabel: string; styles: Styles;
}): ReactElement {
  return (
    <div className={styles.sliderRow}>
      <Caption1 className={styles.fieldLabel}>Transparency</Caption1>
      <Slider
        size="small" min={0} max={100} step={1} value={value}
        aria-label={ariaLabel}
        onChange={(_e, d) => onChange(d.value)}
        style={{ flex: 1, minWidth: 0 }}
      />
      <Caption1 className={styles.sliderVal}>{value}%</Caption1>
    </div>
  );
}

// ── Numeric field row (axis min / max / target — structured numeric Input) ────

function NumberField({ label, value, onChange, styles }: {
  label: string; value?: number; onChange: (v?: number) => void; styles: Styles;
}): ReactElement {
  return (
    <div className={styles.sliderRow}>
      <Caption1 className={mergeClasses(styles.fieldLabel)} style={{ minWidth: '52px' }}>{label}</Caption1>
      <Input
        size="small" type="number" aria-label={label} placeholder="Auto"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(_e, d) => {
          const t = d.value.trim();
          const n = Number(t);
          onChange(t === '' || Number.isNaN(n) ? undefined : n);
        }}
        style={{ flex: 1, minWidth: 0 }}
      />
    </div>
  );
}

// ── Font-family dropdown (title / axis / legend) ──────────────────────────────

function FontDropdown({ value, onChange, ariaLabel }: {
  value?: string; onChange: (f?: string) => void; ariaLabel: string;
}): ReactElement {
  return (
    <Dropdown
      size="small" aria-label={ariaLabel}
      value={value ?? 'Theme default'} selectedOptions={[value ?? '']}
      onOptionSelect={(_e, d) => onChange((d.optionValue as string) || undefined)}
    >
      <Option value="" text="Theme default">Theme default</Option>
      {FONT_CHOICES.map((f) => <Option key={f} value={f} text={f}>{f}</Option>)}
    </Dropdown>
  );
}

// ── Display-units dropdown (value axis / data labels) ─────────────────────────

function UnitsDropdown({ value, onChange, ariaLabel }: {
  value?: AxisDisplayUnits; onChange: (u?: AxisDisplayUnits) => void; ariaLabel: string;
}): ReactElement {
  const cur = DISPLAY_UNITS.find((u) => u.id === (value ?? 'auto'));
  return (
    <Dropdown
      size="small" aria-label={ariaLabel}
      value={cur?.label ?? 'Auto'} selectedOptions={[value ?? 'auto']}
      onOptionSelect={(_e, d) => onChange((d.optionValue as AxisDisplayUnits) || 'auto')}
    >
      {DISPLAY_UNITS.map((u) => <Option key={u.id} value={u.id} text={u.label}>{u.label}</Option>)}
    </Dropdown>
  );
}

// ── FormatPane ────────────────────────────────────────────────────────────────

export interface FormatPaneProps {
  /** Selected visual's type (bar/column/combo/gauge/…). Null/undefined ⇒ no selection. */
  visualType?: string | null;
  /** Current (sparse) format read from `visual.config.format`. */
  format?: ReportVisualFormat | null;
  /** Emit the next sparse format; host wires this to `mutateVisual`. */
  onChange: (next: ReportVisualFormat) => void;
  /**
   * Bindable fields for the Conditional formatting section (the designer's
   * `fieldOptions(tables)` result). When provided, the section renders the real
   * delegated {@link ConditionalFormatEditor}; when omitted, the section is
   * hidden (the host has not wired the field list) — never shown as a dead
   * control. This is an additive, optional prop: existing callers are unaffected.
   */
  condFields?: CondFieldOption[];
  /**
   * Result column names available on the selected visual (the visual's `/query`
   * columns). Drives the structured pickers for the Secondary axis series,
   * Tooltip fields, and Small-multiples facet — never a free-text box
   * (no-freeform-config). Optional + additive: when omitted, those pickers fall
   * back to `condFields`, and degrade to an honest hint when neither is wired.
   */
  valueColumns?: string[];
}

/**
 * The Format right-rail tab. Controlled + structured — every control maps to one
 * field of {@link ReportVisualFormat}. Renders contextually for the selected
 * visual type and degrades to an EmptyState when nothing is selected.
 */
export function FormatPane({ visualType, format, onChange, condFields, valueColumns }: FormatPaneProps): ReactElement {
  const styles = useStyles();
  const baseId = useId();
  // Pane-local section filter (NOT persisted to the format model).
  const [search, setSearch] = useState('');

  // Graceful no-selection state (web3-ui: styled EmptyState, never disabled controls).
  if (!visualType) {
    return (
      <EmptyState
        icon={<ColorRegular />}
        title="No visual selected"
        body="Select a visual on the canvas to format its title, colors, labels, axes, effects, and number format."
      />
    );
  }

  const view = normalizeFormat(format);
  // Persist sparse: merge the patch onto the raw stored format, not the defaults.
  const set = (patch: Partial<ReportVisualFormat>) => onChange({ ...(format ?? {}), ...patch });
  // Nested-object setters keep the sibling keys (sparse merge per effect group).
  const dl = view.dataLabels ?? {};
  const setDataLabels = (p: Partial<NonNullable<ReportVisualFormat['dataLabels']>>) =>
    set({ dataLabels: { ...(format?.dataLabels ?? {}), ...p } });
  const tl = view.totalLabels ?? {};
  const setTotalLabels = (p: Partial<NonNullable<ReportVisualFormat['totalLabels']>>) =>
    set({ totalLabels: { ...(format?.totalLabels ?? {}), ...p } });
  // Background / Border / Shadow / Plot area write BOTH the legacy scalar (read by
  // the current report-designer chrome — no pre-seam regression) AND the unified
  // `effects.*` object (read by the new VisualChrome overlay + adapter). "supersedes"
  // is honored by readers preferring effects.*; the scalar stays a live fallback.
  const bg = view.background ?? {};
  const ef = view.effects ?? {};
  const setBackground = (p: Partial<NonNullable<ReportVisualFormat['background']>>) =>
    set({
      background: { ...(format?.background ?? {}), ...p },
      effects: { ...(format?.effects ?? {}), plotAreaBg: { ...(format?.effects?.plotAreaBg ?? {}), ...p } },
    });
  const bd = view.border ?? {};
  const setBorder = (p: Partial<NonNullable<ReportVisualFormat['border']>>) =>
    set({
      border: { ...(format?.border ?? {}), ...p },
      effects: { ...(format?.effects ?? {}), border: { ...(format?.effects?.border ?? {}), ...p } },
    });
  const setBorderFx = (p: Partial<NonNullable<NonNullable<ReportVisualFormat['effects']>['border']>>) =>
    set({ effects: { ...(format?.effects ?? {}), border: { ...(format?.effects?.border ?? {}), ...p } } });
  const sh = view.shadow ?? {};
  const setShadow = (p: Partial<NonNullable<ReportVisualFormat['shadow']>>) =>
    set({
      shadow: { ...(format?.shadow ?? {}), ...p },
      effects: { ...(format?.effects ?? {}), shadow: { ...(format?.effects?.shadow ?? {}), ...p } },
    });
  const setShadowFx = (p: Partial<NonNullable<NonNullable<ReportVisualFormat['effects']>['shadow']>>) =>
    set({ effects: { ...(format?.effects ?? {}), shadow: { ...(format?.effects?.shadow ?? {}), ...p } } });
  const pa = view.plotArea ?? {};
  const setPlotArea = (p: Partial<NonNullable<ReportVisualFormat['plotArea']>>) =>
    set({
      plotArea: { ...(format?.plotArea ?? {}), ...p },
      effects: { ...(format?.effects ?? {}), plotAreaBg: { ...(format?.effects?.plotAreaBg ?? {}), transparency: p.transparency } },
    });
  const gen = view.general ?? {};
  const setGeneral = (p: Partial<NonNullable<ReportVisualFormat['general']>>) =>
    set({ general: { ...(format?.general ?? {}), ...p } });

  // ── wave-6 structured setters (sparse merge per object) ──────────────────────
  const ax = view.axisX ?? {};
  const setAxisX = (p: Partial<ReportAxisFormat>) =>
    set({ axisX: { ...(format?.axisX ?? {}), ...p } });
  const ay = view.axisY ?? {};
  const setAxisY = (p: Partial<ReportAxisFormat>) =>
    set({ axisY: { ...(format?.axisY ?? {}), ...p } });
  const ay2 = view.axisY2 ?? {};
  const setAxisY2 = (p: Partial<ReportAxisFormat>) =>
    set({ axisY2: { ...(format?.axisY2 ?? {}), ...p } });
  const ttl = view.title ?? {};
  const setTitle = (p: Partial<ReportTitleFormat>) =>
    set({ title: { ...(format?.title ?? {}), ...p } });
  const lg = view.legend ?? {};
  const setLegend = (p: Partial<ReportLegendFormat>) =>
    set({ legend: { ...(format?.legend ?? {}), ...p } });
  const hi = view.headerIcons ?? {};
  const setHeaderIcon = (k: HeaderIconKey, v: boolean) =>
    set({ headerIcons: { ...(format?.headerIcons ?? {}), [k]: v } });
  const tip = view.tooltipOptions ?? {};
  const setTooltips = (p: Partial<NonNullable<ReportVisualFormat['tooltipOptions']>>) =>
    set({ tooltipOptions: { ...(format?.tooltipOptions ?? {}), ...p } });
  const zm = view.zoom ?? {};
  const setZoom = (p: Partial<NonNullable<ReportVisualFormat['zoom']>>) =>
    set({ zoom: { ...(format?.zoom ?? {}), ...p } });
  const smg = view.smallMultiplesGrid ?? {};
  const setSmg = (p: Partial<NonNullable<ReportVisualFormat['smallMultiplesGrid']>>) =>
    set({ smallMultiplesGrid: { ...(format?.smallMultiplesGrid ?? {}), ...p } });

  const lead = view.dataColors?.[0];
  const showColors = hasDataColors(visualType);
  const showAxes = hasAxes(visualType);
  const showLeg = hasLegend(visualType);
  const showDataLabels = hasDataLabels(visualType);
  const showTotalLabels = hasTotalLabels(visualType);
  const showPlotArea = hasPlotArea(visualType);
  const isGauge = visualType === 'gauge';
  const isCombo = visualType === 'combo';

  // Structured field choices for the Secondary-axis series, Tooltip fields, and
  // Small-multiples facet pickers — real result-column names (no free text).
  const fieldChoices: { key: string; label: string }[] = (() => {
    const out: { key: string; label: string }[] = [];
    const seen = new Set<string>();
    const push = (key?: string, label?: string) => {
      const k = (key ?? '').trim();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ key: k, label: (label && label.trim()) || k });
    };
    if (valueColumns?.length) valueColumns.forEach((c) => push(c, c));
    else (condFields ?? []).forEach((f) => push(f.column ?? f.measure ?? f.label, f.label));
    return out;
  })();


  // ── Build the contextual section list (PBI-ordered). Each entry is a card; a
  //    pane-local SearchBox filters by label, and Dividers are inserted between
  //    the surviving cards so the chrome stays consistent at any filter. ───────
  type Section = { key: string; label: string; node: ReactElement };
  const sections: Section[] = [];
  const add = (key: string, label: string, node: ReactElement) => sections.push({ key, label, node });

  // Title (rich) — scalar title/show kept for back-compat; the rich controls
  // write format.title.* (read by VisualChrome + adapter fontFamily).
  add('title', 'Title', (
    <div className={styles.section}>
      <SectionHead icon={<TextT20Regular />} label="Title" styles={styles} />
      <Input
        size="small" id={`${baseId}-title`} aria-label="Title text"
        placeholder="Use the visual name" value={view.titleText ?? ''}
        onChange={(_e, d) => set({ titleText: d.value })}
      />
      <Switch label="Show title" checked={view.showTitle}
        onChange={(_e, d) => set({ showTitle: d.checked })} />
      <Caption1 className={styles.fieldLabel}>Heading</Caption1>
      <Dropdown size="small" aria-label="Heading style"
        value={ttl.heading === 'subtitle' ? 'Subtitle' : 'Title'}
        selectedOptions={[ttl.heading ?? 'title']}
        onOptionSelect={(_e, d) => setTitle({ heading: (d.optionValue as 'title' | 'subtitle') || 'title' })}>
        <Option value="title" text="Title">Title</Option>
        <Option value="subtitle" text="Subtitle">Subtitle</Option>
      </Dropdown>
      <Caption1 className={styles.fieldLabel}>Subtitle</Caption1>
      <Input size="small" aria-label="Subtitle text" placeholder="Optional subtitle"
        value={ttl.subtitle ?? ''} onChange={(_e, d) => setTitle({ subtitle: d.value || undefined })} />
      <Caption1 className={styles.fieldLabel}>Alignment</Caption1>
      <Dropdown size="small" aria-label="Title alignment"
        value={cap(ttl.align ?? 'left')} selectedOptions={[ttl.align ?? 'left']}
        onOptionSelect={(_e, d) => setTitle({ align: (d.optionValue as 'left' | 'center' | 'right') || 'left' })}>
        {(['left', 'center', 'right'] as const).map((a) => (
          <Option key={a} value={a} text={cap(a)}>{cap(a)}</Option>
        ))}
      </Dropdown>
      <Caption1 className={styles.fieldLabel}>Font</Caption1>
      <FontDropdown value={ttl.font} onChange={(f) => setTitle({ font: f })} ariaLabel="Title font" />
      <div className={styles.sliderRow}>
        <Caption1 className={styles.fieldLabel}>Size</Caption1>
        <Slider size="small" min={8} max={32} step={1} value={ttl.fontSize ?? 14}
          aria-label="Title font size" onChange={(_e, d) => setTitle({ fontSize: d.value })}
          style={{ flex: 1, minWidth: 0 }} />
        <Caption1 className={styles.sliderVal}>{ttl.fontSize ?? 14}px</Caption1>
      </div>
      <Caption1 className={styles.fieldLabel}>Color</Caption1>
      <ColorSwatchRow value={ttl.color} allowNone onChange={(c) => setTitle({ color: c })}
        ariaLabel="Title color" styles={styles} />
      <Switch label="Divider under title" checked={ttl.divider ?? false}
        onChange={(_e, d) => setTitle({ divider: d.checked })} />
      {condFields !== undefined && condFields.length > 0 && (
        <>
          <Caption1 className={styles.fieldLabel}>Conditional title (fx)</Caption1>
          <Dropdown size="small" aria-label="Conditional title field"
            value={condLabel(ttl.conditionalField, condFields)}
            selectedOptions={[condOptionKey(ttl.conditionalField, condFields)]}
            onOptionSelect={(_e, d) => setTitle({ conditionalField: condFromKey(d.optionValue, condFields) })}>
            <Option value="" text="None">None</Option>
            {condFields.map((f) => <Option key={f.key} value={f.key} text={f.label}>{f.label}</Option>)}
          </Dropdown>
        </>
      )}
    </div>
  ));

  // Data colors (unchanged — lead-series swatch).
  if (showColors) add('dataColors', 'Data colors', (
    <div className={styles.section}>
      <SectionHead icon={<ColorRegular />} label="Data colors" styles={styles} />
      <Caption1 className={styles.muted}>Lead series color — picked from the Loom brand palette.</Caption1>
      <div className={styles.swatchGrid} role="radiogroup" aria-label="Data colors">
        {LOOM_DATA_PALETTE.map((sw) => {
          const active = lead === sw.token;
          return (
            <button key={sw.token} type="button" role="radio" aria-checked={active}
              aria-label={sw.label} title={sw.label}
              className={mergeClasses(styles.swatchBtn, active && styles.swatchBtnActive)}
              onClick={() => set({ dataColors: [sw.token] })}>
              <span className={styles.swatchDot} style={{ backgroundColor: sw.token }} aria-hidden />
              <Caption1 className={styles.swatchLabel}>{sw.label}</Caption1>
            </button>
          );
        })}
      </div>
      {lead && (
        <div className={styles.resetRow}>
          <button type="button" className={styles.resetLink} onClick={() => set({ dataColors: undefined })}>
            Reset to default palette
          </button>
        </div>
      )}
    </div>
  ));

  // X axis (category) — show writes BOTH the scalar (pre-seam passthrough) and axisX.show.
  if (showAxes) add('axisX', 'X axis', (
    <div className={styles.section}>
      <SectionHead icon={<ArrowAutofitWidth20Regular />} label="X axis" styles={styles} />
      <Switch label="Show X axis" checked={ax.show ?? view.showXAxis}
        onChange={(_e, d) => set({ showXAxis: d.checked, axisX: { ...(format?.axisX ?? {}), show: d.checked } })} />
      <Caption1 className={styles.fieldLabel}>Axis title</Caption1>
      <Input size="small" aria-label="X axis title" placeholder="Optional axis title"
        value={ax.title ?? ''} onChange={(_e, d) => setAxisX({ title: d.value || undefined })} />
      <Switch label="Show axis title" checked={ax.showTitle ?? false}
        onChange={(_e, d) => setAxisX({ showTitle: d.checked })} />
      <Caption1 className={styles.fieldLabel}>Label color</Caption1>
      <ColorSwatchRow value={ax.labelColor} allowNone onChange={(c) => setAxisX({ labelColor: c })}
        ariaLabel="X axis label color" styles={styles} />
      <Caption1 className={styles.fieldLabel}>Label font</Caption1>
      <FontDropdown value={ax.labelFont} onChange={(f) => setAxisX({ labelFont: f })} ariaLabel="X axis label font" />
    </div>
  ));

  // Y axis (primary value) — range / log / units / decimals / gridlines / labels / title.
  if (showAxes) add('axisY', 'Y axis', (
    <div className={styles.section}>
      <SectionHead icon={<ArrowAutofitHeight20Regular />} label="Y axis" styles={styles} />
      <Switch label="Show Y axis" checked={ay.show ?? view.showYAxis}
        onChange={(_e, d) => set({ showYAxis: d.checked, axisY: { ...(format?.axisY ?? {}), show: d.checked } })} />
      <Caption1 className={styles.fieldLabel}>Range</Caption1>
      <NumberField label="Min" value={ay.min} onChange={(v) => setAxisY({ min: v })} styles={styles} />
      <NumberField label="Max" value={ay.max} onChange={(v) => setAxisY({ max: v })} styles={styles} />
      <Switch label="Logarithmic scale" checked={ay.logScale ?? false}
        onChange={(_e, d) => setAxisY({ logScale: d.checked })} />
      <Caption1 className={styles.fieldLabel}>Display units</Caption1>
      <UnitsDropdown value={ay.displayUnits} onChange={(u) => setAxisY({ displayUnits: u })} ariaLabel="Y axis display units" />
      <div className={styles.sliderRow}>
        <Caption1 className={styles.fieldLabel}>Decimals</Caption1>
        <Slider size="small" min={0} max={4} step={1} value={ay.decimals ?? 0}
          aria-label="Y axis decimals" onChange={(_e, d) => setAxisY({ decimals: d.value })}
          style={{ flex: 1, minWidth: 0 }} />
        <Caption1 className={styles.sliderVal}>{ay.decimals ?? 0}</Caption1>
      </div>
      <Switch label="Gridlines" checked={ay.gridlines ?? true}
        onChange={(_e, d) => setAxisY({ gridlines: d.checked })} />
      {(ay.gridlines ?? true) && (
        <>
          <Caption1 className={styles.fieldLabel}>Gridline color</Caption1>
          <ColorSwatchRow value={ay.gridlineColor} allowNone onChange={(c) => setAxisY({ gridlineColor: c })}
            ariaLabel="Gridline color" styles={styles} />
        </>
      )}
      <Caption1 className={styles.fieldLabel}>Axis title</Caption1>
      <Input size="small" aria-label="Y axis title" placeholder="Optional axis title"
        value={ay.title ?? ''} onChange={(_e, d) => setAxisY({ title: d.value || undefined })} />
      <Switch label="Show axis title" checked={ay.showTitle ?? false}
        onChange={(_e, d) => setAxisY({ showTitle: d.checked })} />
      <Caption1 className={styles.fieldLabel}>Label color</Caption1>
      <ColorSwatchRow value={ay.labelColor} allowNone onChange={(c) => setAxisY({ labelColor: c })}
        ariaLabel="Y axis label color" styles={styles} />
      <Caption1 className={styles.fieldLabel}>Label font</Caption1>
      <FontDropdown value={ay.labelFont} onChange={(f) => setAxisY({ labelFont: f })} ariaLabel="Y axis label font" />
    </div>
  ));

  // Gauge axis — min / max / target (→ gaugeMin/gaugeMax/target).
  if (isGauge) add('gauge', 'Gauge axis', (
    <div className={styles.section}>
      <SectionHead icon={<Gauge20Regular />} label="Gauge axis" styles={styles} />
      <NumberField label="Min" value={ay.min} onChange={(v) => setAxisY({ min: v })} styles={styles} />
      <NumberField label="Max" value={ay.max} onChange={(v) => setAxisY({ max: v })} styles={styles} />
      <NumberField label="Target" value={ay.target} onChange={(v) => setAxisY({ target: v })} styles={styles} />
      <Caption1 className={styles.muted}>Sets the gauge value range and target marker.</Caption1>
    </div>
  ));

  // Secondary axis (combo) — choose result columns for the right-hand line axis.
  if (isCombo) add('axisY2', 'Secondary axis', (
    <div className={styles.section}>
      <SectionHead icon={<ChartMultiple20Regular />} label="Secondary axis" styles={styles} />
      <Caption1 className={styles.muted}>Plot selected measures on a right-hand line axis.</Caption1>
      {fieldChoices.length > 0 ? (
        fieldChoices.map((fc) => {
          const checked = (ay2.series ?? []).includes(fc.key);
          return (
            <Checkbox key={fc.key} label={fc.label} checked={checked}
              onChange={(_e, d) => {
                const cur = new Set(ay2.series ?? []);
                if (d.checked) cur.add(fc.key); else cur.delete(fc.key);
                setAxisY2({ series: cur.size ? Array.from(cur) : undefined });
              }} />
          );
        })
      ) : (
        <Caption1 className={styles.muted}>Add value fields to the visual to assign a secondary axis.</Caption1>
      )}
      <Caption1 className={styles.fieldLabel}>Axis title</Caption1>
      <Input size="small" aria-label="Secondary axis title" placeholder="Optional axis title"
        value={ay2.title ?? ''} onChange={(_e, d) => setAxisY2({ title: d.value || undefined })} />
      <Switch label="Show axis title" checked={ay2.showTitle ?? false}
        onChange={(_e, d) => setAxisY2({ showTitle: d.checked })} />
    </div>
  ));

  // Data labels (extended) — show/position kept; color/units/decimals are live adapter levers.
  if (showDataLabels) add('dataLabels', 'Data labels', (
    <div className={styles.section}>
      <SectionHead icon={<TextNumberFormat20Regular />} label="Data labels" styles={styles} />
      <Switch label="Show data labels" checked={dl.show ?? false}
        onChange={(_e, d) => setDataLabels({ show: d.checked })} />
      <Caption1 className={styles.fieldLabel}>Position</Caption1>
      <Dropdown size="small" aria-label="Data label position" disabled={!(dl.show ?? false)}
        value={DATA_LABEL_POSITIONS.find((p) => p.id === (dl.position ?? 'auto'))?.label ?? 'Auto'}
        selectedOptions={[dl.position ?? 'auto']}
        onOptionSelect={(_e, d) => setDataLabels({ position: (d.optionValue as DataLabelPosition) || 'auto' })}>
        {DATA_LABEL_POSITIONS.map((p) => <Option key={p.id} value={p.id} text={p.label}>{p.label}</Option>)}
      </Dropdown>
      <Caption1 className={styles.fieldLabel}>Display units</Caption1>
      <UnitsDropdown value={dl.units} onChange={(u) => setDataLabels({ units: u })} ariaLabel="Data label display units" />
      <div className={styles.sliderRow}>
        <Caption1 className={styles.fieldLabel}>Decimals</Caption1>
        <Slider size="small" min={0} max={4} step={1} value={dl.decimals ?? 0}
          aria-label="Data label decimals" onChange={(_e, d) => setDataLabels({ decimals: d.value })}
          style={{ flex: 1, minWidth: 0 }} />
        <Caption1 className={styles.sliderVal}>{dl.decimals ?? 0}</Caption1>
      </div>
      <Caption1 className={styles.fieldLabel}>Color</Caption1>
      <ColorSwatchRow value={dl.color} allowNone onChange={(c) => setDataLabels({ color: c })}
        ariaLabel="Data label color" styles={styles} />
    </div>
  ));

  // Total labels (show — stacked/combo totals).
  if (showTotalLabels) add('totalLabels', 'Total labels', (
    <div className={styles.section}>
      <SectionHead icon={<Tag20Regular />} label="Total labels" styles={styles} />
      <Switch label="Show total labels" checked={tl.show ?? false}
        onChange={(_e, d) => setTotalLabels({ show: d.checked })} />
      <Caption1 className={styles.muted}>Totals over each stacked category.</Caption1>
    </div>
  ));

  // Legend (extended) — show/position kept; text color → foreground, font → fontFamily.
  if (showLeg) add('legend', 'Legend', (
    <div className={styles.section}>
      <SectionHead icon={<TextBulletListSquare20Regular />} label="Legend" styles={styles} />
      <Switch label="Show legend" checked={view.showLegend}
        onChange={(_e, d) => set({ showLegend: d.checked })} />
      <Caption1 className={styles.fieldLabel}>Position</Caption1>
      <Dropdown size="small" aria-label="Legend position" disabled={!view.showLegend}
        value={cap(view.legendPosition)} selectedOptions={[view.legendPosition]}
        onOptionSelect={(_e, d) => set({ legendPosition: (d.optionValue as LegendPosition) || 'bottom' })}>
        {(['top', 'bottom', 'left', 'right'] as LegendPosition[]).map((p) => (
          <Option key={p} value={p} text={cap(p)}>{cap(p)}</Option>
        ))}
      </Dropdown>
      <Caption1 className={styles.fieldLabel}>Text color</Caption1>
      <ColorSwatchRow value={lg.color} allowNone onChange={(c) => setLegend({ color: c })}
        ariaLabel="Legend text color" styles={styles} />
      <Caption1 className={styles.fieldLabel}>Font</Caption1>
      <FontDropdown value={lg.font} onChange={(f) => setLegend({ font: f })} ariaLabel="Legend font" />
    </div>
  ));

  // Plot area — transparency (writes both scalar + effects.plotAreaBg.transparency).
  if (showPlotArea) add('plotArea', 'Plot area', (
    <div className={styles.section}>
      <SectionHead icon={<DataBarVertical20Regular />} label="Plot area" styles={styles} />
      <TransparencyRow value={pa.transparency ?? 0} onChange={(v) => setPlotArea({ transparency: v })}
        ariaLabel="Plot area transparency" styles={styles} />
    </div>
  ));

  // Small multiples — facet by a category field (→ smallMultiples).
  if (showAxes) add('smallMultiples', 'Small multiples', (
    <div className={styles.section}>
      <SectionHead icon={<Grid20Regular />} label="Small multiples" styles={styles} />
      <Caption1 className={styles.muted}>Facet the visual into a grid by a category field.</Caption1>
      <Caption1 className={styles.fieldLabel}>Facet by</Caption1>
      <Dropdown size="small" aria-label="Small-multiples facet field"
        value={fieldChoices.find((f) => f.key === smg.facetColumn)?.label ?? 'None'}
        selectedOptions={[smg.facetColumn ?? '']}
        onOptionSelect={(_e, d) => setSmg({ facetColumn: (d.optionValue as string) || undefined })}>
        <Option value="" text="None">None</Option>
        {fieldChoices.map((f) => <Option key={f.key} value={f.key} text={f.label}>{f.label}</Option>)}
      </Dropdown>
      {smg.facetColumn && (
        <>
          <div className={styles.sliderRow}>
            <Caption1 className={styles.fieldLabel}>Columns</Caption1>
            <Slider size="small" min={1} max={6} step={1} value={smg.columns ?? 2}
              aria-label="Small-multiples columns" onChange={(_e, d) => setSmg({ columns: d.value })}
              style={{ flex: 1, minWidth: 0 }} />
            <Caption1 className={styles.sliderVal}>{smg.columns ?? 2}</Caption1>
          </div>
          <Switch label="Shared Y axis" checked={smg.sharedY ?? true}
            onChange={(_e, d) => setSmg({ sharedY: d.checked })} />
        </>
      )}
    </div>
  ));

  // Zoom — category window [from..to] (→ rows slice).
  if (showAxes) add('zoom', 'Zoom', (
    <div className={styles.section}>
      <SectionHead icon={<ZoomIn20Regular />} label="Zoom" styles={styles} />
      <Switch label="Enable category window" checked={zm.enabled ?? false}
        onChange={(_e, d) => setZoom({ enabled: d.checked })} />
      {(zm.enabled ?? false) && (
        <>
          <div className={styles.sliderRow}>
            <Caption1 className={styles.fieldLabel}>From</Caption1>
            <Slider size="small" min={0} max={100} step={1} value={Math.round((zm.from ?? 0) * 100)}
              aria-label="Zoom window start" onChange={(_e, d) => setZoom({ from: d.value / 100 })}
              style={{ flex: 1, minWidth: 0 }} />
            <Caption1 className={styles.sliderVal}>{Math.round((zm.from ?? 0) * 100)}%</Caption1>
          </div>
          <div className={styles.sliderRow}>
            <Caption1 className={styles.fieldLabel}>To</Caption1>
            <Slider size="small" min={0} max={100} step={1} value={Math.round((zm.to ?? 1) * 100)}
              aria-label="Zoom window end" onChange={(_e, d) => setZoom({ to: d.value / 100 })}
              style={{ flex: 1, minWidth: 0 }} />
            <Caption1 className={styles.sliderVal}>{Math.round((zm.to ?? 1) * 100)}%</Caption1>
          </div>
        </>
      )}
    </div>
  ));

  // Tooltips — extra fields surfaced in the hover popover (→ tooltips + hover).
  if (showColors) add('tooltips', 'Tooltips', (
    <div className={styles.section}>
      <SectionHead icon={<Comment20Regular />} label="Tooltips" styles={styles} />
      <Switch label="Show tooltips" checked={tip.show ?? true}
        onChange={(_e, d) => setTooltips({ show: d.checked })} />
      <Caption1 className={styles.fieldLabel}>Extra fields</Caption1>
      {fieldChoices.length > 0 ? (
        fieldChoices.map((fc) => {
          const checked = (tip.fields ?? []).includes(fc.key);
          return (
            <Checkbox key={fc.key} label={fc.label} checked={checked}
              onChange={(_e, d) => {
                const cur = new Set(tip.fields ?? []);
                if (d.checked) cur.add(fc.key); else cur.delete(fc.key);
                setTooltips({ fields: cur.size ? Array.from(cur) : undefined });
              }} />
          );
        })
      ) : (
        <Caption1 className={styles.muted}>Add fields to the visual to surface them in tooltips.</Caption1>
      )}
    </div>
  ));

  // Header icons — show/hide the visual header buttons (→ VisualChrome).
  add('headerIcons', 'Header icons', (
    <div className={styles.section}>
      <SectionHead icon={<Eye20Regular />} label="Header icons" styles={styles} />
      <Caption1 className={styles.muted}>Show or hide the visual header buttons.</Caption1>
      {HEADER_ICONS.map((h) => (
        <Switch key={h.key} label={h.label} checked={hi[h.key] ?? true}
          onChange={(_e, d) => setHeaderIcon(h.key, d.checked)} />
      ))}
    </div>
  ));

  // Background (effects.plotAreaBg.* mirror → chart plot fill).
  add('background', 'Background', (
    <div className={styles.section}>
      <SectionHead icon={<Square20Regular />} label="Background" styles={styles} />
      <Caption1 className={styles.fieldLabel}>Color</Caption1>
      <ColorSwatchRow value={bg.color} allowNone onChange={(c) => setBackground({ color: c })}
        ariaLabel="Background color" styles={styles} />
      {bg.color && (
        <TransparencyRow value={bg.transparency ?? 0} onChange={(v) => setBackground({ transparency: v })}
          ariaLabel="Background transparency" styles={styles} />
      )}
    </div>
  ));

  // Border (effects.border.* mirror + width → VisualChrome).
  add('border', 'Border', (
    <div className={styles.section}>
      <SectionHead icon={<DocumentBorder20Regular />} label="Border" styles={styles} />
      <Switch label="Show border" checked={bd.show ?? false}
        onChange={(_e, d) => setBorder({ show: d.checked })} />
      {(bd.show ?? false) && (
        <>
          <Caption1 className={styles.fieldLabel}>Color</Caption1>
          <ColorSwatchRow value={bd.color} onChange={(c) => setBorder({ color: c })}
            ariaLabel="Border color" styles={styles} />
          <div className={styles.sliderRow}>
            <Caption1 className={styles.fieldLabel}>Width</Caption1>
            <Slider size="small" min={1} max={8} step={1} value={ef.border?.width ?? 1}
              aria-label="Border width" onChange={(_e, d) => setBorderFx({ width: d.value })}
              style={{ flex: 1, minWidth: 0 }} />
            <Caption1 className={styles.sliderVal}>{ef.border?.width ?? 1}px</Caption1>
          </div>
          <div className={styles.sliderRow}>
            <Caption1 className={styles.fieldLabel}>Radius</Caption1>
            <Slider size="small" min={0} max={24} step={1} value={bd.radius ?? 8}
              aria-label="Border radius" onChange={(_e, d) => setBorder({ radius: d.value })}
              style={{ flex: 1, minWidth: 0 }} />
            <Caption1 className={styles.sliderVal}>{bd.radius ?? 8}px</Caption1>
          </div>
        </>
      )}
    </div>
  ));

  // Shadow (effects.shadow.* mirror + color/position → VisualChrome).
  add('shadow', 'Shadow', (
    <div className={styles.section}>
      <SectionHead icon={<Sparkle20Regular />} label="Shadow" styles={styles} />
      <Switch label="Show shadow" checked={sh.show ?? false}
        onChange={(_e, d) => setShadow({ show: d.checked })} />
      {(sh.show ?? false) && (
        <>
          <Caption1 className={styles.fieldLabel}>Color</Caption1>
          <ColorSwatchRow value={ef.shadow?.color} allowNone onChange={(c) => setShadowFx({ color: c })}
            ariaLabel="Shadow color" styles={styles} />
          <Caption1 className={styles.fieldLabel}>Position</Caption1>
          <Dropdown size="small" aria-label="Shadow position"
            value={cap(ef.shadow?.position ?? 'outer')} selectedOptions={[ef.shadow?.position ?? 'outer']}
            onOptionSelect={(_e, d) => setShadowFx({ position: (d.optionValue as 'outer' | 'inner') || 'outer' })}>
            <Option value="outer" text="Outer">Outer</Option>
            <Option value="inner" text="Inner">Inner</Option>
          </Dropdown>
        </>
      )}
    </div>
  ));

  // General · sizing & accessibility (size lives on the canvas; alt text persists).
  add('general', 'General', (
    <div className={styles.section}>
      <SectionHead icon={<FullScreenMaximize20Regular />} label="General" styles={styles} />
      <Caption1 className={styles.fieldLabel}>Size</Caption1>
      <div className={styles.sizeNote}>
        <Info16Regular className={styles.sizeNoteIcon} aria-hidden />
        <Caption1 className={styles.muted}>
          Resize on the canvas — drag the visual&apos;s corner grip, focus it and
          press the arrow keys, or pick a width with the S · M · L · XL buttons.
        </Caption1>
      </div>
      <Caption1 className={styles.fieldLabel}>Alt text (accessibility)</Caption1>
      <Input size="small" aria-label="Alternative text"
        placeholder="Describe this visual for screen readers"
        value={gen.altText ?? ''} onChange={(_e, d) => setGeneral({ altText: d.value || undefined })} />
    </div>
  ));

  // Styles (preset).
  add('styles', 'Styles', (
    <div className={styles.section}>
      <SectionHead icon={<PaintBrush20Regular />} label="Styles" styles={styles} />
      <Dropdown size="small" aria-label="Style preset"
        value={STYLE_PRESETS.find((p) => p.id === view.stylePreset)?.label ?? 'Default'}
        selectedOptions={[view.stylePreset]}
        onOptionSelect={(_e, d) => set({ stylePreset: (d.optionValue as StylePreset) || 'default' })}>
        {STYLE_PRESETS.map((p) => <Option key={p.id} value={p.id} text={p.label}>{p.label}</Option>)}
      </Dropdown>
      <Caption1 className={styles.muted}>{STYLE_PRESETS.find((p) => p.id === view.stylePreset)?.hint ?? ''}</Caption1>
    </div>
  ));

  // Number format (value preset).
  add('numberFormat', 'Number format', (
    <div className={styles.section}>
      <SectionHead icon={<NumberSymbol20Regular />} label="Number format" styles={styles} />
      <Dropdown size="small" aria-label="Number format"
        value={NUMBER_FORMAT_PRESETS.find((p) => p.id === view.numberFormat)?.label ?? 'General'}
        selectedOptions={[view.numberFormat]}
        onOptionSelect={(_e, d) => set({ numberFormat: (d.optionValue as NumberFormatPreset) || 'general' })}>
        {NUMBER_FORMAT_PRESETS.map((p) => <Option key={p.id} value={p.id} text={p.label}>{p.label}</Option>)}
      </Dropdown>
      <Caption1 className={styles.muted}>
        Example: <Text font="numeric">{formatValue(1234.5, view.numberFormat)}</Text>
      </Caption1>
    </div>
  ));

  // Conditional formatting (delegated to conditional-format.tsx).
  if (condFields !== undefined) add('conditionalFormat', 'Conditional formatting', (
    <div className={mergeClasses(styles.section, styles.condBox)}>
      <SectionHead icon={<Color20Regular />} label="Conditional formatting" styles={styles} />
      <Suspense fallback={<div className={styles.loadRow}><Spinner size="tiny" label="Loading…" /></div>}>
        <LazyConditionalFormatEditor
          fields={condFields}
          value={format?.conditionalFormat}
          onChange={(cf) => set({ conditionalFormat: cf })}
        />
      </Suspense>
    </div>
  ));

  const q = search.trim().toLowerCase();
  const shown = q ? sections.filter((s) => s.label.toLowerCase().includes(q)) : sections;

  return (
    <div className={styles.pane}>
      <SearchBox
        size="small" placeholder="Search formatting options"
        value={search} aria-label="Search formatting options"
        onChange={(_e, d) => setSearch(d.value)}
        style={{ width: '100%' }}
      />
      {shown.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 && <Divider />}
          {s.node}
        </Fragment>
      ))}
      {shown.length === 0 && (
        <Caption1 className={styles.muted}>No formatting options match “{search}”.</Caption1>
      )}
    </div>
  );
}

export default FormatPane;
