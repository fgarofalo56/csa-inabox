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

import { useId, lazy, Suspense } from 'react';
import type { ReactElement } from 'react';
import {
  Caption1, Divider, Dropdown, Input, Option, Slider, Spinner, Switch, Text,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  TextT20Regular, ColorRegular, RulerRegular, TextBulletListSquare20Regular,
  NumberSymbol20Regular, TextNumberFormat20Regular, Tag20Regular, Square20Regular,
  DocumentBorder20Regular, Sparkle20Regular, DataBarVertical20Regular,
  FullScreenMaximize20Regular, PaintBrush20Regular, Color20Regular, Info16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
// Type-only import (erased at compile time — no runtime cycle with
// conditional-format.tsx, which imports LOOM_DATA_PALETTE from this module).
import type { ReportConditionalFormat, CondFieldOption } from './conditional-format';

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

  /** Per-point data labels (charts). Default off. */
  dataLabels?: { show?: boolean; position?: DataLabelPosition };
  /** Stack/segment total labels (stacked column/bar/area, combo, waterfall). Default off. */
  totalLabels?: { show?: boolean };
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
}

/**
 * The Format right-rail tab. Controlled + structured — every control maps to one
 * field of {@link ReportVisualFormat}. Renders contextually for the selected
 * visual type and degrades to an EmptyState when nothing is selected.
 */
export function FormatPane({ visualType, format, onChange, condFields }: FormatPaneProps): ReactElement {
  const styles = useStyles();
  const baseId = useId();

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
  const bg = view.background ?? {};
  const setBackground = (p: Partial<NonNullable<ReportVisualFormat['background']>>) =>
    set({ background: { ...(format?.background ?? {}), ...p } });
  const bd = view.border ?? {};
  const setBorder = (p: Partial<NonNullable<ReportVisualFormat['border']>>) =>
    set({ border: { ...(format?.border ?? {}), ...p } });
  const sh = view.shadow ?? {};
  const setShadow = (p: Partial<NonNullable<ReportVisualFormat['shadow']>>) =>
    set({ shadow: { ...(format?.shadow ?? {}), ...p } });
  const pa = view.plotArea ?? {};
  const setPlotArea = (p: Partial<NonNullable<ReportVisualFormat['plotArea']>>) =>
    set({ plotArea: { ...(format?.plotArea ?? {}), ...p } });
  const gen = view.general ?? {};
  const setGeneral = (p: Partial<NonNullable<ReportVisualFormat['general']>>) =>
    set({ general: { ...(format?.general ?? {}), ...p } });

  const lead = view.dataColors?.[0];
  const showColors = hasDataColors(visualType);
  const showAxes = hasAxes(visualType);
  const showLeg = hasLegend(visualType);
  const showDataLabels = hasDataLabels(visualType);
  const showTotalLabels = hasTotalLabels(visualType);
  const showPlotArea = hasPlotArea(visualType);

  return (
    <div className={styles.pane}>
      {/* ── Title ─────────────────────────────────────────────────────────── */}
      <div className={styles.section}>
        <SectionHead icon={<TextT20Regular />} label="Title" styles={styles} />
        <Input
          size="small"
          id={`${baseId}-title`}
          aria-label="Title text"
          placeholder="Use the visual name"
          value={view.titleText ?? ''}
          onChange={(_e, d) => set({ titleText: d.value })}
        />
        <Switch
          label="Show title"
          checked={view.showTitle}
          onChange={(_e, d) => set({ showTitle: d.checked })}
        />
      </div>

      {/* ── Data colors ───────────────────────────────────────────────────── */}
      {showColors && (
        <>
          <Divider />
          <div className={styles.section}>
            <SectionHead icon={<ColorRegular />} label="Data colors" styles={styles} />
            <Caption1 className={styles.muted}>Lead series color — picked from the Loom brand palette.</Caption1>
            <div className={styles.swatchGrid} role="radiogroup" aria-label="Data colors">
              {LOOM_DATA_PALETTE.map((sw) => {
                const active = lead === sw.token;
                return (
                  <button
                    key={sw.token}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={sw.label}
                    title={sw.label}
                    className={mergeClasses(styles.swatchBtn, active && styles.swatchBtnActive)}
                    onClick={() => set({ dataColors: [sw.token] })}
                  >
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
        </>
      )}

      {/* ── Data labels ───────────────────────────────────────────────────── */}
      {showDataLabels && (
        <>
          <Divider />
          <div className={styles.section}>
            <SectionHead icon={<TextNumberFormat20Regular />} label="Data labels" styles={styles} />
            <Switch
              label="Show data labels"
              checked={dl.show ?? false}
              onChange={(_e, d) => setDataLabels({ show: d.checked })}
            />
            <Caption1 className={styles.fieldLabel}>Position</Caption1>
            <Dropdown
              size="small"
              aria-label="Data label position"
              disabled={!(dl.show ?? false)}
              value={DATA_LABEL_POSITIONS.find((p) => p.id === (dl.position ?? 'auto'))?.label ?? 'Auto'}
              selectedOptions={[dl.position ?? 'auto']}
              onOptionSelect={(_e, d) => setDataLabels({ position: (d.optionValue as DataLabelPosition) || 'auto' })}
            >
              {DATA_LABEL_POSITIONS.map((p) => (
                <Option key={p.id} value={p.id} text={p.label}>{p.label}</Option>
              ))}
            </Dropdown>
          </div>
        </>
      )}

      {/* ── Total labels ──────────────────────────────────────────────────── */}
      {showTotalLabels && (
        <>
          <Divider />
          <div className={styles.section}>
            <SectionHead icon={<Tag20Regular />} label="Total labels" styles={styles} />
            <Switch
              label="Show total labels"
              checked={tl.show ?? false}
              onChange={(_e, d) => setTotalLabels({ show: d.checked })}
            />
            <Caption1 className={styles.muted}>Totals over each stacked category.</Caption1>
          </div>
        </>
      )}

      {/* ── Axes ──────────────────────────────────────────────────────────── */}
      {showAxes && (
        <>
          <Divider />
          <div className={styles.section}>
            <SectionHead icon={<RulerRegular />} label="Axes" styles={styles} />
            <Switch
              label="Show X axis"
              checked={view.showXAxis}
              onChange={(_e, d) => set({ showXAxis: d.checked })}
            />
            <Switch
              label="Show Y axis"
              checked={view.showYAxis}
              onChange={(_e, d) => set({ showYAxis: d.checked })}
            />
          </div>
        </>
      )}

      {/* ── Legend ────────────────────────────────────────────────────────── */}
      {showLeg && (
        <>
          <Divider />
          <div className={styles.section}>
            <SectionHead icon={<TextBulletListSquare20Regular />} label="Legend" styles={styles} />
            <Switch
              label="Show legend"
              checked={view.showLegend}
              onChange={(_e, d) => set({ showLegend: d.checked })}
            />
            <Caption1 className={styles.muted}>Position</Caption1>
            <Dropdown
              size="small"
              aria-label="Legend position"
              disabled={!view.showLegend}
              value={view.legendPosition.charAt(0).toUpperCase() + view.legendPosition.slice(1)}
              selectedOptions={[view.legendPosition]}
              onOptionSelect={(_e, d) => set({ legendPosition: (d.optionValue as LegendPosition) || 'bottom' })}
            >
              {(['top', 'bottom', 'left', 'right'] as LegendPosition[]).map((p) => (
                <Option key={p} value={p} text={p.charAt(0).toUpperCase() + p.slice(1)}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </Option>
              ))}
            </Dropdown>
          </div>
        </>
      )}

      {/* ── Plot area ─────────────────────────────────────────────────────── */}
      {showPlotArea && (
        <>
          <Divider />
          <div className={styles.section}>
            <SectionHead icon={<DataBarVertical20Regular />} label="Plot area" styles={styles} />
            <TransparencyRow
              value={pa.transparency ?? 0}
              onChange={(v) => setPlotArea({ transparency: v })}
              ariaLabel="Plot area transparency"
              styles={styles}
            />
          </div>
        </>
      )}

      {/* ── Background ─────────────────────────────────────────────────────── */}
      <Divider />
      <div className={styles.section}>
        <SectionHead icon={<Square20Regular />} label="Background" styles={styles} />
        <Caption1 className={styles.fieldLabel}>Color</Caption1>
        <ColorSwatchRow
          value={bg.color}
          allowNone
          onChange={(c) => setBackground({ color: c })}
          ariaLabel="Background color"
          styles={styles}
        />
        {bg.color && (
          <TransparencyRow
            value={bg.transparency ?? 0}
            onChange={(v) => setBackground({ transparency: v })}
            ariaLabel="Background transparency"
            styles={styles}
          />
        )}
      </div>

      {/* ── Border ────────────────────────────────────────────────────────── */}
      <Divider />
      <div className={styles.section}>
        <SectionHead icon={<DocumentBorder20Regular />} label="Border" styles={styles} />
        <Switch
          label="Show border"
          checked={bd.show ?? false}
          onChange={(_e, d) => setBorder({ show: d.checked })}
        />
        {(bd.show ?? false) && (
          <>
            <Caption1 className={styles.fieldLabel}>Color</Caption1>
            <ColorSwatchRow
              value={bd.color}
              onChange={(c) => setBorder({ color: c })}
              ariaLabel="Border color"
              styles={styles}
            />
            <div className={styles.sliderRow}>
              <Caption1 className={styles.fieldLabel}>Radius</Caption1>
              <Slider
                size="small" min={0} max={24} step={1} value={bd.radius ?? 8}
                aria-label="Border radius"
                onChange={(_e, d) => setBorder({ radius: d.value })}
                style={{ flex: 1, minWidth: 0 }}
              />
              <Caption1 className={styles.sliderVal}>{bd.radius ?? 8}px</Caption1>
            </div>
          </>
        )}
      </div>

      {/* ── Shadow ────────────────────────────────────────────────────────── */}
      <Divider />
      <div className={styles.section}>
        <SectionHead icon={<Sparkle20Regular />} label="Shadow" styles={styles} />
        <Switch
          label="Show shadow"
          checked={sh.show ?? false}
          onChange={(_e, d) => setShadow({ show: d.checked })}
        />
      </div>

      {/* ── General · sizing & accessibility ──────────────────────────────── */}
      {/* Loom sizes visuals on the responsive 12-column canvas grid (column
          span `w` + row-height `h`) — those are the fields the canvas actually
          reads (report-designer cardStyle: `gridColumn: span w` / `minHeight:
          h*40`). Sizing therefore lives where you can see it: the corner resize
          grip (pointer-drag or arrow-keys) and the S · M · L · XL width buttons,
          all wired in use-canvas-layout.ts. The previous px Width/Height inputs
          wrote `format.general.width/height` — a field NOTHING read, so they
          sized nothing: a no-vaporware.md dead control, removed here. Alt text
          stays: it persists with the visual via /definition for the accessible
          report export. */}
      <Divider />
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
        <Input
          size="small" aria-label="Alternative text"
          placeholder="Describe this visual for screen readers"
          value={gen.altText ?? ''}
          onChange={(_e, d) => setGeneral({ altText: d.value || undefined })}
        />
      </div>

      {/* ── Styles ────────────────────────────────────────────────────────── */}
      <Divider />
      <div className={styles.section}>
        <SectionHead icon={<PaintBrush20Regular />} label="Styles" styles={styles} />
        <Dropdown
          size="small"
          aria-label="Style preset"
          value={STYLE_PRESETS.find((p) => p.id === view.stylePreset)?.label ?? 'Default'}
          selectedOptions={[view.stylePreset]}
          onOptionSelect={(_e, d) => set({ stylePreset: (d.optionValue as StylePreset) || 'default' })}
        >
          {STYLE_PRESETS.map((p) => (
            <Option key={p.id} value={p.id} text={p.label}>{p.label}</Option>
          ))}
        </Dropdown>
        <Caption1 className={styles.muted}>
          {STYLE_PRESETS.find((p) => p.id === view.stylePreset)?.hint ?? ''}
        </Caption1>
      </div>

      {/* ── Number format ─────────────────────────────────────────────────── */}
      <Divider />
      <div className={styles.section}>
        <SectionHead icon={<NumberSymbol20Regular />} label="Number format" styles={styles} />
        <Dropdown
          size="small"
          aria-label="Number format"
          value={NUMBER_FORMAT_PRESETS.find((p) => p.id === view.numberFormat)?.label ?? 'General'}
          selectedOptions={[view.numberFormat]}
          onOptionSelect={(_e, d) => set({ numberFormat: (d.optionValue as NumberFormatPreset) || 'general' })}
        >
          {NUMBER_FORMAT_PRESETS.map((p) => (
            <Option key={p.id} value={p.id} text={p.label}>
              {p.label}
            </Option>
          ))}
        </Dropdown>
        <Caption1 className={styles.muted}>
          Example: <Text font="numeric">{formatValue(1234.5, view.numberFormat)}</Text>
        </Caption1>
      </div>

      {/* ── Conditional formatting (delegated to conditional-format.tsx) ───── */}
      {condFields !== undefined && (
        <>
          <Divider />
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
        </>
      )}
    </div>
  );
}

export default FormatPane;
