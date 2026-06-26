'use client';

/**
 * FormatPane — the "Format" right-rail tab of the Loom-native Report Designer.
 *
 * Power BI report-authoring parity (ui-parity.md): the Format pane is the
 * contextual surface that styles the *selected* visual — title, data colors,
 * axes, legend, and number format. Loom-themed (web3-ui.md): Fluent UI v9 +
 * Loom design tokens, cards/sections, no hard-coded spacing/colors.
 *
 * no-freeform-config.md: every control here is structured — a text Input, a
 * Switch, a swatch picker, or a Dropdown of presets. The user NEVER types a
 * format string / DAX / JSON. The data-color swatches are drawn from the same
 * Loom brand palette `LoomChart` renders with, so what you pick is what the
 * chart paints.
 *
 * Persistence: this component is pure/controlled. It receives the selected
 * visual's `format` (read from `visual.config.format`) and emits the next
 * `ReportVisualFormat` via `onChange`. The host designer wires that to
 * `mutateVisual(id, v => ({ ...v, config: { ...v.config, format } }))`, which
 * round-trips through PUT /api/items/report/[id]/definition (additive — the
 * read-only viewer and PBIR provisioner ignore unknown `config.format`).
 * `VisualBody` / `LoomChart` read the same `format` to apply title text, the
 * data-color palette, axis/legend visibility, and number formatting
 * client-side. No backend call originates here (it is a formatting surface);
 * the no-vaporware backend contract lives in the /query + /definition routes.
 *
 * When no visual is selected the pane renders a graceful EmptyState rather
 * than disabled controls.
 */

import { useId } from 'react';
import type { ReactElement } from 'react';
import {
  Caption1, Divider, Dropdown, Input, Option, Switch, Text,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  TextT20Regular, ColorRegular, RulerRegular, TextBulletListSquare20Regular,
  NumberSymbol20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

// ── Format model (persisted on visual.config.format) ─────────────────────────

export type LegendPosition = 'top' | 'bottom' | 'left' | 'right';
export type NumberFormatPreset =
  | 'general' | 'whole' | 'decimal' | 'percent' | 'currency' | 'thousands';

/**
 * Structured, fully-optional visual formatting. Stored SPARSE (only the fields
 * the author touched); read through {@link normalizeFormat} to apply defaults.
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
}

/** Defaults applied for display; never persisted unless the author changes one. */
export const DEFAULT_REPORT_FORMAT: Required<
  Pick<ReportVisualFormat, 'showTitle' | 'showXAxis' | 'showYAxis' | 'showLegend' | 'legendPosition' | 'numberFormat'>
> = {
  showTitle: true,
  showXAxis: true,
  showYAxis: true,
  showLegend: true,
  legendPosition: 'bottom',
  numberFormat: 'general',
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

const CHART_TYPES = new Set(['bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter']);
const CARTESIAN_TYPES = new Set(['bar', 'column', 'line', 'area', 'scatter']);
const hasDataColors = (t?: string | null) => !!t && CHART_TYPES.has(t);
const hasAxes       = (t?: string | null) => !!t && CARTESIAN_TYPES.has(t);
const hasLegend     = (t?: string | null) => !!t && CHART_TYPES.has(t);

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
});

// ── Section header helper ─────────────────────────────────────────────────────

function SectionHead({ icon, label, styles }: { icon: ReactElement; label: string; styles: ReturnType<typeof useStyles> }) {
  return (
    <div className={styles.sectionHead}>
      {icon}
      <Caption1><strong>{label}</strong></Caption1>
    </div>
  );
}

// ── FormatPane ────────────────────────────────────────────────────────────────

export interface FormatPaneProps {
  /** Selected visual's type (bar/column/card/…). Null/undefined ⇒ no selection. */
  visualType?: string | null;
  /** Current (sparse) format read from `visual.config.format`. */
  format?: ReportVisualFormat | null;
  /** Emit the next sparse format; host wires this to `mutateVisual`. */
  onChange: (next: ReportVisualFormat) => void;
}

/**
 * The Format right-rail tab. Controlled + structured — every control maps to
 * one field of {@link ReportVisualFormat}. Renders contextually for the selected
 * visual type and degrades to an EmptyState when nothing is selected.
 */
export function FormatPane({ visualType, format, onChange }: FormatPaneProps): ReactElement {
  const styles = useStyles();
  const baseId = useId();

  // Graceful no-selection state (web3-ui: styled EmptyState, never disabled controls).
  if (!visualType) {
    return (
      <EmptyState
        icon={<ColorRegular />}
        title="No visual selected"
        body="Select a visual on the canvas to format its title, data colors, axes, legend, and number format."
      />
    );
  }

  const view = normalizeFormat(format);
  // Persist sparse: merge the patch onto the raw stored format, not the defaults.
  const set = (patch: Partial<ReportVisualFormat>) => onChange({ ...(format ?? {}), ...patch });

  const lead = view.dataColors?.[0];
  const showColors = hasDataColors(visualType);
  const showAxes = hasAxes(visualType);
  const showLeg = hasLegend(visualType);

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
    </div>
  );
}

export default FormatPane;
