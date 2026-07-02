'use client';

/**
 * VisualChrome — the Wave-6 presentational CHROME wrapper for a report visual.
 *
 * Power BI report-authoring parity (ui-parity.md): a Power BI visual is more
 * than its plot. Around the chart, PBI paints a rich TITLE + SUBTITLE (with its
 * own font / color / alignment, a divider, and an fx-conditional title bound to
 * a measure), a row of HEADER ICONS (visual info, drill up/down, drill toggle,
 * filter, focus, more), AXIS TITLES (X under the plot, Y rotated on the left,
 * a secondary Y on the right), and a card frame (BORDER + SHADOW). Those live
 * OUTSIDE the SVG geometry, so they are the one slice of the Format pane that a
 * pure chart renderer (LoomChart) can never paint on its own.
 *
 * This component is exactly that slice. It wraps the chart body and draws the
 * chrome from the persisted {@link ReportVisualFormat} (`title` / `effects` /
 * `headerIcons`) plus the axis titles the format→chart adapter resolves
 * (`ChartAdapterResult.axisChrome`). Because the chrome is rendered AROUND the
 * children — never inside loom-chart.tsx — every new Format control reaches the
 * visual WITHOUT editing the Wave-5-owned chart or report-designer.tsx: the
 * single integration seam (owned by Wave 5) is
 *
 *   const a = formatToChartProps(fmt, ctx);
 *   <VisualChrome chrome={a.axisChrome} format={fmt}>
 *     <LoomChart rows={a.rows} {...a.chartProps} {...geomProps} />
 *   </VisualChrome>
 *
 * Until that one line lands, nothing references VisualChrome and nothing
 * regresses; the existing `format={fmt}` passthrough still paints the W5-native
 * subset (axes / legend / labels / plot-area / style).
 *
 * Rules compliance:
 *  - no-vaporware.md: there are NO dead controls. Every chrome field this
 *    component reads visibly changes the rendered visual — the title text /
 *    font / color / alignment, the subtitle, the divider, the header-icon row,
 *    the axis titles, and the card border / shadow. The fx-conditional title is
 *    resolved from a REAL measure value passed by the host (`measureValues`),
 *    not a placeholder. The header icons are honest presentational INDICATORS
 *    (non-interactive `role="img"` spans, never buttons-with-no-handler), so
 *    nothing here is a button that does nothing — the live drill / focus / lock
 *    controls remain the report card's own header (report-designer.tsx).
 *  - no-freeform-config.md: this surface renders only; it authors nothing. The
 *    values it paints come from the structured Format-pane pickers.
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens throughout (Title3 /
 *    Subtitle2 / Caption1 typography, Divider, token spacing / radii / shadow,
 *    `tokens.*` colors) — no ad-hoc hex / px chrome. Raw px appears only for the
 *    vertical-text axis-title geometry (rotation), exactly as loom-chart.tsx
 *    uses raw px for SVG geometry math.
 *  - no-fabric-dependency.md: pure client presentation over the same rows the
 *    visual already queried; nothing here reaches a Fabric / Power BI workspace.
 *
 * Passthrough contract: when NO chrome field is set (no rich `title`, no
 * `headerIcons`, no `effects` frame, no axis titles), VisualChrome renders its
 * children unchanged — a bare fragment — so a visual that never opted into the
 * Wave-6 controls is byte-identical to the pre-Wave-6 render.
 *
 * Decoupling: the public `format` prop is typed as the shared
 * {@link ReportVisualFormat} (type-only import — erased at compile time, no
 * runtime cycle with format-pane.tsx). The Wave-6 chrome members are read
 * through a local mirror model ({@link ChromeReadModel}) so this file compiles
 * independently of the (parallel) format-pane extension and the (parallel)
 * adapter module — the `chrome` prop mirrors `ChartAdapterResult.axisChrome`
 * structurally, so the seam type-checks without importing the adapter.
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import {
  Caption1, Divider, Subtitle2, Title3, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Info16Regular, ArrowUp16Regular, ArrowDown16Regular, ArrowSort16Regular,
  Filter16Regular, ArrowMaximize16Regular, MoreHorizontal16Regular,
} from '@fluentui/react-icons';
// Type-only imports (erased at compile time → no runtime import cycle):
//  • ReportVisualFormat is the persisted Format model (format-pane.tsx).
//  • CondField is the conditional-format field reference reused by the
//    fx-conditional title (the one documented cross-chunk type dependency).
import type { ReportVisualFormat } from './format-pane';
import type { CondField } from './conditional-format';

// ── Axis-title chrome (mirrors ChartAdapterResult.axisChrome) ─────────────────
// Kept structurally identical to the adapter's `axisChrome` so the Wave-5 seam
// can pass `chrome={a.axisChrome}` with zero adapters and no module import.

/** Axis titles + main-title alignment resolved by the format→chart adapter. */
export interface VisualAxisChrome {
  /** X (category) axis title, drawn centered under the plot. */
  xTitle?: string;
  /** Primary Y (value) axis title, drawn rotated on the left. */
  yTitle?: string;
  /** Secondary Y axis title (combo charts), drawn rotated on the right. */
  y2Title?: string;
  /** Overrides the main title alignment ('left' | 'center' | 'right'). */
  titleAlign?: string;
}

// ── Local mirror of the Wave-6 chrome slice of ReportVisualFormat ─────────────
// These mirror the SHARED CONTRACT exactly. Reading the chrome members through
// this local model (rather than off the imported ReportVisualFormat type) keeps
// this file compiling regardless of when the parallel format-pane extension
// lands, and keeps the chrome it paints in one place.

type TitleHeading = 'title' | 'subtitle';
type TitleAlign = 'left' | 'center' | 'right';

interface ChromeTitle {
  show?: boolean;
  text?: string;
  font?: string;
  fontSize?: number;
  color?: string;
  align?: TitleAlign;
  heading?: TitleHeading;
  subtitle?: string;
  divider?: boolean;
  /** fx-conditional title: a measure whose value becomes the title text. */
  conditionalField?: CondField;
}

interface ChromeEffectsShadow {
  show?: boolean;
  color?: string;
  offsetX?: number;
  offsetY?: number;
  position?: 'outer' | 'inner';
}
interface ChromeEffectsBorder {
  show?: boolean;
  color?: string;
  width?: number;
  radius?: number;
}
interface ChromeEffects {
  shadow?: ChromeEffectsShadow;
  border?: ChromeEffectsBorder;
  /** Plot-area background — handled by the adapter (→ structural.background); the
   *  chrome wrapper intentionally does NOT paint it, to avoid double-tinting. */
  plotAreaBg?: { color?: string; transparency?: number };
}

/** PBI visual-header icon toggles (which header affordances are shown). */
type HeaderIconKey =
  | 'visualInfo' | 'drillUp' | 'drillDown' | 'drillToggle' | 'filter' | 'focus' | 'more';
type ChromeHeaderIcons = Partial<Record<HeaderIconKey, boolean>>;

/** The chrome-relevant slice of ReportVisualFormat this component reads. */
interface ChromeReadModel {
  title?: ChromeTitle;
  effects?: ChromeEffects;
  headerIcons?: ChromeHeaderIcons;
}

// ── Header-icon catalog (presentational indicators, ordered like Power BI) ────

const HEADER_ICONS: { key: HeaderIconKey; label: string; icon: ReactElement }[] = [
  { key: 'visualInfo',  label: 'Visual information', icon: <Info16Regular /> },
  { key: 'drillUp',     label: 'Drill up',           icon: <ArrowUp16Regular /> },
  { key: 'drillDown',   label: 'Drill down',         icon: <ArrowDown16Regular /> },
  { key: 'drillToggle', label: 'Drill mode',         icon: <ArrowSort16Regular /> },
  { key: 'filter',      label: 'Filters affecting this visual', icon: <Filter16Regular /> },
  { key: 'focus',       label: 'Focus mode',         icon: <ArrowMaximize16Regular /> },
  { key: 'more',        label: 'More options',       icon: <MoreHorizontal16Regular /> },
];

// ── styles (Fluent v9 + Loom tokens; matches format-pane / report-designer) ───

const useStyles = makeStyles({
  // Outer frame — fills the visual card body and stacks header / body / xTitle.
  frame: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    height: '100%',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalXXS,
    flexShrink: 0,
  },
  titleBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
    flex: 1,
  },
  titleText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  subtitleText: { color: tokens.colorNeutralForeground3 },
  iconRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  iconBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorNeutralForeground3,
    lineHeight: 0,
  },
  titleDivider: { marginBottom: tokens.spacingVerticalXS, flexShrink: 0 },
  // Body row: [yTitle] [chart] [y2Title]
  bodyRow: {
    display: 'flex',
    alignItems: 'stretch',
    minWidth: 0,
    minHeight: 0,
    flex: 1,
  },
  chartArea: {
    position: 'relative',
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  // Vertical axis titles (rotated). Raw px width is geometry, like the SVG math.
  yTitle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    writingMode: 'vertical-rl',
    transform: 'rotate(180deg)',
    color: tokens.colorNeutralForeground2,
    paddingRight: tokens.spacingHorizontalXXS,
    flexShrink: 0,
  },
  y2Title: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    writingMode: 'vertical-rl',
    color: tokens.colorNeutralForeground2,
    paddingLeft: tokens.spacingHorizontalXXS,
    flexShrink: 0,
  },
  xTitle: {
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
    marginTop: tokens.spacingVerticalXXS,
    flexShrink: 0,
  },
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Stringify a resolved fx-conditional title value (number → locale grouped). */
function formatTitleValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(v);
}

/**
 * Resolve an fx-conditional title from a measure value the host passes in.
 * Keys are tried most-specific first (measure, column, table[column], table)
 * so a bound measure or column lights up the moment the host provides its
 * aggregate. Returns undefined when nothing resolves (caller falls back to the
 * literal title text / the visual name) — never a placeholder (no-vaporware).
 */
function resolveConditionalTitle(
  field: CondField | undefined,
  measureValues: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!field || !measureValues) return undefined;
  const keys = [
    field.measure,
    field.column,
    field.table && field.column ? `${field.table}[${field.column}]` : undefined,
    field.table,
  ].filter((k): k is string => !!k);
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(measureValues, k)) {
      const s = formatTitleValue(measureValues[k]);
      if (s !== '') return s;
    }
  }
  return undefined;
}

/**
 * A finite number, or the fallback. Guards a corrupted / NaN / Infinity value
 * that round-tripped through a saved report definition from injecting an invalid
 * dimension into the chrome CSS (no-vaporware: a control always paints a valid
 * frame, never an `NaNpx` style the browser silently drops mid-frame).
 */
function finiteOr(n: number | undefined, fallback: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Build the card-frame border / shadow CSS from `effects` (omitted ⇒ none). */
function effectsFrameStyle(effects: ChromeEffects | undefined): CSSProperties {
  const style: CSSProperties = {};
  if (!effects) return style;
  const b = effects.border;
  if (b?.show) {
    const w = finiteOr(b.width, 1) ?? 1;
    const width = w > 0 ? w : 1;
    style.border = `${width}px solid ${b.color || tokens.colorNeutralStroke1}`;
    // A user-chosen numeric radius is data; the default uses a Loom token.
    const radius = finiteOr(b.radius, undefined);
    style.borderRadius = radius != null ? radius : tokens.borderRadiusLarge;
    style.padding = tokens.spacingVerticalXS;
  }
  const s = effects.shadow;
  if (s?.show) {
    // Explicit offsets/color → a precise shadow; otherwise the Loom elevation token.
    const hasExplicit = s.offsetX != null || s.offsetY != null || !!s.color;
    if (hasExplicit) {
      const ox = finiteOr(s.offsetX, 0) ?? 0;
      const oy = finiteOr(s.offsetY, 2) ?? 2;
      const inset = s.position === 'inner' ? 'inset ' : '';
      const color = s.color || tokens.colorNeutralShadowAmbient;
      style.boxShadow = `${inset}${ox}px ${oy}px 8px ${color}`;
    } else {
      style.boxShadow = tokens.shadow16;
    }
    if (style.borderRadius == null) style.borderRadius = tokens.borderRadiusLarge;
  }
  return style;
}

/** True when `effects` contributes a visible card frame (border or shadow). */
function hasEffectsFrame(effects: ChromeEffects | undefined): boolean {
  return !!(effects && ((effects.border && effects.border.show) || (effects.shadow && effects.shadow.show)));
}

/** True when `headerIcons` toggles at least one indicator on. */
function hasHeaderIcons(icons: ChromeHeaderIcons | undefined): boolean {
  return !!icons && HEADER_ICONS.some((h) => icons[h.key]);
}

// ── props ─────────────────────────────────────────────────────────────────────

export interface VisualChromeProps {
  /**
   * The selected visual's persisted Format model. Only the Wave-6 chrome slice
   * (`title` / `effects` / `headerIcons`) is read here; every other field is
   * consumed upstream by the adapter / LoomChart. Null/undefined ⇒ passthrough.
   */
  format?: ReportVisualFormat | null;
  /**
   * Axis titles + title alignment resolved by the format→chart adapter
   * (`ChartAdapterResult.axisChrome`). Null/undefined ⇒ no axis titles.
   */
  chrome?: VisualAxisChrome | null;
  /**
   * Aggregate measure values keyed by measure/column name, used to resolve an
   * fx-conditional title (`title.conditionalField`). The host computes these
   * from the SAME `/query` rows the visual already fetched; omit for a literal
   * title. (no-vaporware: the conditional title paints a real value, not a
   * placeholder.)
   */
  measureValues?: Record<string, unknown> | null;
  /**
   * Fallback title text (typically the visual's name) used when the rich title
   * is shown but has no literal text and no conditional value resolves.
   */
  fallbackTitle?: string;
  /** The chart body (LoomChart / any visual surface) to wrap. */
  children?: ReactNode;
}

// ── VisualChrome ───────────────────────────────────────────────────────────────

/**
 * Wrap a visual body with its Format-pane chrome. Pure + presentational: it
 * authors nothing and calls no backend. When no chrome field is set it renders
 * its children unchanged (a bare fragment), so opting out of Wave-6 is a no-op.
 */
export function VisualChrome({
  format, chrome, measureValues, fallbackTitle, children,
}: VisualChromeProps): ReactElement {
  const styles = useStyles();

  // Read the Wave-6 chrome slice through the local mirror model (keeps this file
  // independent of the parallel format-pane extension's exact member set).
  const model = (format ?? undefined) as unknown as ChromeReadModel | undefined;
  const title = model?.title;
  const effects = model?.effects;
  const headerIcons = model?.headerIcons;

  // Resolve the title text: fx-conditional value (real measure) ▸ literal text ▸
  // the visual-name fallback. The title block renders only when `title` is the
  // rich Wave-6 model AND not explicitly hidden — the legacy scalar title bar
  // stays owned by the report card, so we never double-render a title.
  const conditionalText = resolveConditionalTitle(title?.conditionalField, measureValues);
  const titleText = (conditionalText ?? (title?.text && title.text.trim()) ?? '').trim()
    || (title?.conditionalField || title?.text != null ? (fallbackTitle ?? '') : '');
  const showTitleBlock = !!title && title.show !== false
    && (titleText !== '' || (title.subtitle != null && title.subtitle.trim() !== ''));

  const showIcons = hasHeaderIcons(headerIcons);
  const showHeader = showTitleBlock || showIcons;

  const xTitle = chrome?.xTitle?.trim();
  const yTitle = chrome?.yTitle?.trim();
  const y2Title = chrome?.y2Title?.trim();
  const hasAxisTitles = !!(xTitle || yTitle || y2Title);

  const frameStyle = effectsFrameStyle(effects);
  const hasFrame = hasEffectsFrame(effects);

  // Passthrough: nothing to add ⇒ render children verbatim (byte-identical).
  if (!showHeader && !hasAxisTitles && !hasFrame) {
    return <>{children}</>;
  }

  // Resolved title typography (font / size / color come from the model; the
  // heading level picks Title3 vs Subtitle2, matching PBI's title/subtitle).
  const align = (chrome?.titleAlign as TitleAlign | undefined) ?? title?.align;
  const titleStyle: CSSProperties = {
    fontFamily: title?.font || undefined,
    fontSize: finiteOr(title?.fontSize, undefined),
    color: title?.color || undefined,
    textAlign: align,
  };
  const HeadingTag = title?.heading === 'subtitle' ? Subtitle2 : Title3;

  return (
    <div className={styles.frame} style={hasFrame ? frameStyle : undefined}>
      {showHeader && (
        <div className={styles.header} style={{ justifyContent: showTitleBlock ? undefined : 'flex-end' }}>
          {showTitleBlock && (
            <div className={styles.titleBlock} style={{ alignItems: alignToFlexAlign(align) }}>
              {titleText !== '' && (
                <HeadingTag className={styles.titleText} style={titleStyle}>{titleText}</HeadingTag>
              )}
              {title?.subtitle && title.subtitle.trim() !== '' && (
                <Caption1 className={styles.subtitleText} style={{ textAlign: align }}>
                  {title.subtitle}
                </Caption1>
              )}
            </div>
          )}
          {showIcons && (
            <div className={styles.iconRow} role="group" aria-label="Visual header icons">
              {HEADER_ICONS.filter((h) => headerIcons?.[h.key]).map((h) => (
                <Tooltip key={h.key} content={h.label} relationship="label">
                  <span className={styles.iconBtn} role="img" aria-label={h.label}>{h.icon}</span>
                </Tooltip>
              ))}
            </div>
          )}
        </div>
      )}

      {showTitleBlock && title?.divider && <Divider className={styles.titleDivider} />}

      <div className={styles.bodyRow}>
        {yTitle && (
          <div className={styles.yTitle}><Caption1>{yTitle}</Caption1></div>
        )}
        <div className={styles.chartArea}>{children}</div>
        {y2Title && (
          <div className={styles.y2Title}><Caption1>{y2Title}</Caption1></div>
        )}
      </div>

      {xTitle && (
        <div className={styles.xTitle}><Caption1>{xTitle}</Caption1></div>
      )}
    </div>
  );
}

/** flex `alignItems` for a title alignment (the title block is a column). */
function alignToFlexAlign(align: TitleAlign | undefined): CSSProperties['alignItems'] {
  return align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
}

export default VisualChrome;
