'use client';

/**
 * conditional-format — the Power BI "Conditional formatting" surface for the
 * Loom-native Report Designer, plus the pure painters that apply it.
 *
 * Power BI report-authoring parity (ui-parity.md): in PBI you open Format →
 * (a field) → Conditional formatting and choose one of four modes — rules
 * (by-value color bands), color scale (gradient), data bars, or icons — bound
 * to a column/measure. This module is the one-for-one Loom build of that
 * surface: {@link ConditionalFormatEditor} authors the structured model, and
 * {@link applyConditionalFormat} / {@link cellStyleFor} are the painters the
 * report consumes.
 *
 * Rules compliance:
 *  - no-freeform-config.md: EVERY control is structured — a field Dropdown, a
 *    mode toggle, an operator Dropdown, a numeric Input (a *value*, never a DAX
 *    expression or a typed format string), a swatch radiogroup, and an icon-set
 *    Dropdown. There is no free-text color/expression entry anywhere.
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens only; no hard-coded
 *    spacing/colors. Swatches are drawn from the SAME `LOOM_DATA_PALETTE` the
 *    charts paint with, so what the author picks is what the cell/bar renders.
 *    The pane layout (per-rule cards, mode strip, live preview chip) mirrors the
 *    PBI conditional-formatting dialog.
 *  - no-vaporware.md: nothing here is a dead control. The editor is a controlled
 *    component whose output is consumed by REAL painters: `applyConditionalFormat`
 *    scans the visual's actual `/query` result rows to derive each field's domain,
 *    and `cellStyleFor` returns a concrete style/icon for a concrete value. When
 *    no fields are bound the editor shows an honest EmptyState gate (not disabled
 *    buttons). The model persists on `visual.format.conditionalFormat` and round-
 *    trips through PUT /api/items/report/[id]/definition (additive — the viewer
 *    and PBIR provisioner ignore the unknown key).
 *  - no-fabric-dependency.md: Azure-native by construction — this is pure client
 *    styling over the existing Synapse/AAS `/query` rows; nothing here references
 *    a Fabric/Power BI workspace. (PBI embed stays the opt-in publish path.)
 *
 * Consumption (host = report-designer.tsx VisualBody / LoomChart):
 *   const cf = applyConditionalFormat(rows, visual.format?.conditionalFormat);
 *   // table cell:
 *   const paint = cf.paintFor(colKey, value);
 *   <TableCell style={{ background: paint?.background, color: paint?.color }}>
 *     {paint?.icon && <span style={{ color: paint.icon.color }}>{paint.icon.glyph} </span>}
 *     {formatValue(value, nf)}
 *   </TableCell>
 *   // chart bar/column fill: paint?.fill is the saturated (un-tinted) color.
 *
 * The painters are pure (no React/fetch/Node) so the host client component can
 * import them freely; the editor is the only React surface.
 */

import { useId } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import {
  Button, Caption1, Divider, Dropdown, Input, Option, Switch, Text, ToggleButton,
  Tooltip, makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular, ColorRegular, NumberSymbol20Regular,
  DataHistogram20Regular, Apps20Regular, Options20Regular,
  PaintBucket20Regular, Link20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { LOOM_DATA_PALETTE } from './format-pane';

// ── Model (persisted on visual.config.format.conditionalFormat) ───────────────

/**
 * The PBI conditional-formatting modes.
 *  - `rules` — by-value color bands  · `colorScale` — gradient  · `dataBars`
 *  - `icons` — per-band glyphs (auto or custom numeric thresholds)
 *  - `fieldValue` — a measure/column whose VALUE is itself a color → painted
 *    directly as the cell background/font (PBI "Field value" style)
 *  - `webUrl` — a column whose value is a URL → the cell text becomes a
 *    hyperlink (`<a>`). Table/matrix only.
 */
export type CondMode = 'rules' | 'colorScale' | 'dataBars' | 'icons' | 'fieldValue' | 'webUrl';

/** Numeric comparison operators for by-value rules (structured, never typed DAX). */
export type CondOp = 'gt' | 'ge' | 'lt' | 'le' | 'eq' | 'ne' | 'between';

/** PBI icon-set families. Each maps to an ordered low→high band set below. */
export type CondIconSet = 'arrows' | 'triangles' | 'trafficLights' | 'ratings' | 'flags';

/** Icon position relative to the cell value (mode==='icons'). */
export type CondIconLayout = 'left' | 'right';
/** Vertical alignment of the icon within the cell (mode==='icons'). */
export type CondIconAlign = 'top' | 'middle' | 'bottom';

/**
 * One custom icon band: "{op} {value} → {glyph} in {token}". Present only when
 * the author opts into custom thresholds; otherwise icons auto-band low→high
 * across the field domain. Same numeric-operator shape as {@link CondThreshold}.
 */
export interface CondIconBand {
  id: string;
  op: CondOp;
  value: number;
  /** Upper bound for `op==='between'`. */
  value2?: number;
  /** The glyph painted for this band (chosen from a structured glyph palette). */
  glyph: string;
  /** A Loom-palette token for the glyph color. */
  token: string;
}

/**
 * Icon-mode configuration. `set` chooses the glyph family; `bands` (when
 * present) overrides the auto low→high banding with explicit numeric thresholds
 * evaluated top-down (first match wins). `layout`/`align` position the glyph.
 */
export interface CondIconConfig {
  set: CondIconSet;
  bands?: CondIconBand[];
  layout?: CondIconLayout;
  align?: CondIconAlign;
}

/** Whether a rules/color-scale rule paints the cell background or the font color. */
export type CondApplyTo = 'background' | 'text';

/** The column/measure a rule is bound to (mirrors the well-field / filter shape). */
export interface CondField {
  table?: string;
  column?: string;
  measure?: string;
}

/** One by-value threshold: "{op} {value} → {color}". `value2` is the upper `between` bound. */
export interface CondThreshold {
  id: string;
  op: CondOp;
  value: number;
  value2?: number;
  /** A Loom-palette token (e.g. tokens.colorPaletteGreenForeground1). */
  color: string;
}

/** Two- or three-stop gradient across the field's numeric domain. */
export interface CondColorScale {
  /** Color at the domain minimum. */
  min: string;
  /** Optional midpoint color (omit for a 2-stop scale). */
  mid?: string;
  /** Color at the domain maximum. */
  max: string;
}

/** Data-bar colors; negatives grow left of a shared center axis. */
export interface CondDataBars {
  positive: string;
  negative: string;
}

/** One conditional-format rule bound to a single field. */
export interface CondRule {
  id: string;
  field: CondField;
  mode: CondMode;
  /** mode==='rules' */
  rules?: CondThreshold[];
  /** mode==='colorScale' */
  colorScale?: CondColorScale;
  /** mode==='dataBars' */
  dataBars?: CondDataBars;
  /** mode==='icons' — glyph set + optional custom thresholds + layout/align. */
  icons?: CondIconConfig;
  /**
   * mode==='fieldValue' — the measure/column whose value is itself a color.
   * Omit to use the formatted column's own value as the color.
   */
  fieldValueField?: CondField;
  /**
   * mode==='webUrl' — the column whose value is the link URL. Omit to use the
   * formatted column's own value as the URL.
   */
  webUrlField?: CondField;
  /** rules/colorScale/fieldValue only — paint the background (default) or the font. */
  applyTo?: CondApplyTo;
}

/** The full model stored on a visual: an ordered list of rules. */
export interface ReportConditionalFormat {
  rules: CondRule[];
}

// ── Palette + semantic defaults (web3-ui: tokens only, in lock-step with charts) ──

/** Swatch choices — the SAME palette `LoomChart` / FormatPane paint with. */
const COND_SWATCHES = LOOM_DATA_PALETTE;

const RED = tokens.colorPaletteRedForeground1;
const AMBER = tokens.colorPaletteMarigoldForeground1;
const GREEN = tokens.colorPaletteGreenForeground1;
const BRAND = tokens.colorBrandForeground1;

const COND_OPS: { op: CondOp; label: string }[] = [
  { op: 'gt', label: '> greater than' },
  { op: 'ge', label: '≥ at least' },
  { op: 'lt', label: '< less than' },
  { op: 'le', label: '≤ at most' },
  { op: 'eq', label: '= equals' },
  { op: 'ne', label: '≠ not equals' },
  { op: 'between', label: 'between' },
];

const MODE_META: { mode: CondMode; label: string; icon: ReactElement; tableOnly?: boolean }[] = [
  { mode: 'rules', label: 'Rules', icon: <NumberSymbol20Regular /> },
  { mode: 'colorScale', label: 'Color scale', icon: <ColorRegular /> },
  { mode: 'dataBars', label: 'Data bars', icon: <DataHistogram20Regular /> },
  { mode: 'icons', label: 'Icons', icon: <Apps20Regular /> },
  { mode: 'fieldValue', label: 'Field value', icon: <PaintBucket20Regular /> },
  { mode: 'webUrl', label: 'Web URL', icon: <Link20Regular />, tableOnly: true },
];

/** Visuals whose host renders raw cell text (so a Web-URL hyperlink is meaningful). */
function isTableLike(visualType?: string): boolean {
  const t = (visualType || '').toLowerCase();
  return t === 'table' || t === 'matrix' || t === 'pivot' || t === 'grid';
}

/** Structured glyph palette for custom icon bands (no free-text glyph entry). */
const GLYPH_CHOICES = ['▲', '▶', '▼', '△', '◇', '▽', '●', '◐', '○', '⚑', '★', '■'];

/** Ordered low→high icon bands per set; colors are semantic Loom palette tokens. */
const ICON_SETS: Record<CondIconSet, { label: string; bands: { glyph: string; token: string }[] }> = {
  arrows: { label: 'Arrows', bands: [{ glyph: '▼', token: RED }, { glyph: '▶', token: AMBER }, { glyph: '▲', token: GREEN }] },
  triangles: { label: 'Triangles', bands: [{ glyph: '▽', token: RED }, { glyph: '◇', token: AMBER }, { glyph: '△', token: GREEN }] },
  trafficLights: { label: 'Traffic lights', bands: [{ glyph: '●', token: RED }, { glyph: '●', token: AMBER }, { glyph: '●', token: GREEN }] },
  ratings: { label: 'Ratings', bands: [{ glyph: '○', token: RED }, { glyph: '◐', token: AMBER }, { glyph: '●', token: GREEN }] },
  flags: { label: 'Flags', bands: [{ glyph: '⚑', token: RED }, { glyph: '⚑', token: AMBER }, { glyph: '⚑', token: GREEN }] },
};

const ICON_SET_IDS = Object.keys(ICON_SETS) as CondIconSet[];

// ── Defaults / sparse-model helpers (mirror reFilters / parseDataSource) ──────

let _seq = 0;
function cuid(p = 'cf'): string {
  _seq += 1;
  return `${p}-${Date.now().toString(36)}-${_seq.toString(36)}`;
}

/** A fresh, empty model (seed for a visual with no conditional formatting yet). */
export function emptyConditionalFormat(): ReportConditionalFormat {
  return { rules: [] };
}

/** A fresh rule defaulting to the most common mode (by-value rules). */
function freshRule(field: CondField): CondRule {
  return {
    id: cuid('rule'),
    field,
    mode: 'rules',
    rules: [{ id: cuid('th'), op: 'ge', value: 0, color: GREEN }],
    applyTo: 'background',
  };
}

/** True when the model has at least one rule the painters can act on. */
export function hasConditionalFormat(cfg?: ReportConditionalFormat | null): boolean {
  return !!cfg && validRules(cfg).length > 0;
}

/** A field reference from a persisted value (used for fieldValue/webUrl bound fields). */
function parseField(v: unknown): CondField | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const f = v as Record<string, unknown>;
  const field: CondField = {
    table: typeof f.table === 'string' ? f.table : undefined,
    column: typeof f.column === 'string' ? f.column : undefined,
    measure: typeof f.measure === 'string' ? f.measure : undefined,
  };
  return field.column || field.measure ? field : undefined;
}

/** Hydrate the icon config from either the new object form or the legacy bare-string set. */
function parseIcons(v: unknown): CondIconConfig {
  if (typeof v === 'string') {
    return { set: ICON_SET_IDS.includes(v as CondIconSet) ? (v as CondIconSet) : 'arrows' };
  }
  const o = (v || {}) as Record<string, unknown>;
  const set = ICON_SET_IDS.includes(o.set as CondIconSet) ? (o.set as CondIconSet) : 'arrows';
  const layout: CondIconLayout | undefined = o.layout === 'right' ? 'right' : o.layout === 'left' ? 'left' : undefined;
  const align: CondIconAlign | undefined =
    o.align === 'top' || o.align === 'middle' || o.align === 'bottom' ? o.align : undefined;
  let bands: CondIconBand[] | undefined;
  if (Array.isArray(o.bands)) {
    bands = o.bands
      .map((b): CondIconBand | null => {
        const bo = (b || {}) as Record<string, unknown>;
        if (!COND_OPS.some((x) => x.op === bo.op)) return null;
        return {
          id: cuid('band'),
          op: bo.op as CondOp,
          value: Number(bo.value) || 0,
          value2: bo.value2 == null ? undefined : Number(bo.value2) || 0,
          glyph: typeof bo.glyph === 'string' && bo.glyph ? bo.glyph : '●',
          token: typeof bo.token === 'string' ? bo.token : AMBER,
        };
      })
      .filter((x): x is CondIconBand => !!x);
    if (bands.length === 0) bands = undefined;
  }
  return { set, layout, align, bands };
}

/**
 * Defensive hydrate from a persisted/wire value (`state…config.conditionalFormat`
 * or a PUT body). Unknown shapes are dropped rather than thrown, mirroring the
 * designer's `reFilters` / `parseDataSource`. Fresh client ids are minted.
 */
export function parseConditionalFormat(value: unknown): ReportConditionalFormat {
  if (!value || typeof value !== 'object') return emptyConditionalFormat();
  const raw = (value as Record<string, unknown>).rules;
  if (!Array.isArray(raw)) return emptyConditionalFormat();
  const rules: CondRule[] = [];
  for (const r of raw) {
    const o = (r || {}) as Record<string, unknown>;
    const mode = o.mode;
    if (
      mode !== 'rules' && mode !== 'colorScale' && mode !== 'dataBars' &&
      mode !== 'icons' && mode !== 'fieldValue' && mode !== 'webUrl'
    ) continue;
    const f = (o.field || {}) as Record<string, unknown>;
    const field: CondField = {
      table: typeof f.table === 'string' ? f.table : undefined,
      column: typeof f.column === 'string' ? f.column : undefined,
      measure: typeof f.measure === 'string' ? f.measure : undefined,
    };
    const rule: CondRule = { id: cuid('rule'), field, mode };
    rule.applyTo = o.applyTo === 'text' ? 'text' : 'background';
    if (mode === 'rules') {
      rule.rules = Array.isArray(o.rules)
        ? o.rules
            .map((t): CondThreshold | null => {
              const to = (t || {}) as Record<string, unknown>;
              const op = to.op;
              if (!COND_OPS.some((x) => x.op === op)) return null;
              return {
                id: cuid('th'),
                op: op as CondOp,
                value: Number(to.value) || 0,
                value2: to.value2 == null ? undefined : Number(to.value2) || 0,
                color: typeof to.color === 'string' ? to.color : AMBER,
              };
            })
            .filter((x): x is CondThreshold => !!x)
        : [];
    } else if (mode === 'colorScale') {
      const cs = (o.colorScale || {}) as Record<string, unknown>;
      rule.colorScale = {
        min: typeof cs.min === 'string' ? cs.min : RED,
        mid: typeof cs.mid === 'string' ? cs.mid : undefined,
        max: typeof cs.max === 'string' ? cs.max : GREEN,
      };
    } else if (mode === 'dataBars') {
      const db = (o.dataBars || {}) as Record<string, unknown>;
      rule.dataBars = {
        positive: typeof db.positive === 'string' ? db.positive : BRAND,
        negative: typeof db.negative === 'string' ? db.negative : RED,
      };
    } else if (mode === 'fieldValue') {
      rule.fieldValueField = parseField(o.fieldValueField);
    } else if (mode === 'webUrl') {
      rule.webUrlField = parseField(o.webUrlField);
    } else {
      rule.icons = parseIcons(o.icons);
    }
    rules.push(rule);
  }
  return { rules };
}

/** Strip volatile client ids before persisting through /definition (keeps payload stable). */
export function wireConditionalFormat(cfg?: ReportConditionalFormat | null): { rules: Array<Omit<CondRule, 'id'>> } | undefined {
  const valid = cfg ? validRules(cfg) : [];
  if (valid.length === 0) return undefined;
  return {
    rules: valid.map(({ id: _id, rules, icons, ...rest }) => ({
      ...rest,
      ...(rules ? { rules: rules.map(({ id: _tid, ...t }) => ({ id: '', ...t })) } : {}),
      ...(icons
        ? { icons: { ...icons, ...(icons.bands ? { bands: icons.bands.map(({ id: _bid, ...b }) => ({ id: '', ...b })) } : {}) } }
        : {}),
    })),
  };
}

// ── Field ↔ result-column matching (mirrors designer matchFilterKey) ──────────

/** Stable picker key for a rule's field. */
export function condFieldKey(f: CondField): string {
  return f.measure ? `m:${f.measure}` : f.column ? `c:${f.table || ''}.${f.column}` : '';
}
/** Human label for the field Dropdown. */
export function condFieldLabel(f: CondField): string {
  if (f.measure) return f.measure;
  if (f.column) return f.table ? `${f.table} · ${f.column}` : f.column;
  return '(pick a field)';
}

/**
 * Resolve a rule's field to the result-row key that carries it. DAX/serverless
 * columns surface as `Table[Column]`, `[Measure]`, or a bare alias — match
 * tolerantly (identical to the designer's filter matcher). Returns null when the
 * visual's result doesn't carry the field (then the rule simply doesn't paint —
 * never blanks the cell).
 */
function matchCondKey(keys: string[], f: CondField): string | null {
  const name = (f.measure || f.column || '').trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl === lower) return k;
    if (kl.endsWith(`[${lower}]`)) return k;
    if (f.table && kl === `${f.table.toLowerCase()}[${lower}]`) return k;
  }
  return null;
}

// ── Numeric helpers ────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// ── Value coercion for the data-driven modes (fieldValue / webUrl) ────────────

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Interpret a field value as a CSS color (mode==='fieldValue'). Accepts hex,
 * rgb()/hsl(), and Loom `var(--…)` tokens (which is how the palette swatches
 * serialize). Returns null for anything else so the cell paints unchanged.
 */
export function asColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (HEX_RE.test(s)) return s;
  if (/^(?:rgb|hsl)a?\(/i.test(s)) return s;
  if (/^var\(--/.test(s)) return s;
  return null;
}

/**
 * Interpret a field value as a safe link URL (mode==='webUrl'). Only http(s)
 * and mailto pass — `javascript:`/`data:` and relative strings are rejected so
 * the host never renders an unsafe anchor.
 */
export function asUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^mailto:[^\s]+@[^\s]+/i.test(s)) return s;
  return null;
}

/** The numeric domain of a result column, computed once per render in the resolver. */
export interface CondDomain {
  min: number;
  max: number;
  mid: number;
  /** max(|min|,|max|) — the half-width data bars scale to. */
  maxAbs: number;
  hasNeg: boolean;
  count: number;
}

function computeDomain(rows: Array<Record<string, unknown>>, key: string): CondDomain | null {
  let min = Infinity, max = -Infinity, count = 0;
  for (const r of rows) {
    const n = toNum(r[key]);
    if (n == null) continue;
    count += 1;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  if (count === 0) return null;
  return { min, max, mid: (min + max) / 2, maxAbs: Math.max(Math.abs(min), Math.abs(max), 1e-9), hasNeg: min < 0, count };
}

// ── Color math (token-pure via CSS color-mix — interpolates at render time) ───
// The palette entries are Fluent token CSS vars (e.g. "var(--colorPalette…)"),
// so we can't blend them in JS. color-mix() accepts var() colors and resolves
// in the browser, keeping every painted color a Loom token (web3-ui).

/** A readable cell-background tint of a saturated palette color. */
function cellBg(color: string): string {
  return `color-mix(in srgb, ${color} 16%, ${tokens.colorNeutralBackground1})`;
}
/** A translucent bar fill that keeps the cell text readable over it. */
function barFill(color: string): string {
  return `color-mix(in srgb, ${color} 42%, transparent)`;
}
/** Blend a→b by p∈[0,1] (un-tinted; used for chart fills + as the gradient stop). */
function mix(a: string, b: string, p: number): string {
  return `color-mix(in srgb, ${b} ${Math.round(clamp01(p) * 100)}%, ${a})`;
}
/** The (un-tinted) color a color-scale produces at position t∈[0,1]. */
function scaleColor(sc: CondColorScale, t: number): string {
  if (sc.mid) {
    return t <= 0.5 ? mix(sc.min, sc.mid, t / 0.5) : mix(sc.mid, sc.max, (t - 0.5) / 0.5);
  }
  return mix(sc.min, sc.max, t);
}
/** CSS background for a data bar — a single-direction bar, or a centered ± bar when the domain has negatives. */
function dataBarBackground(n: number, domain: CondDomain, db: CondDataBars): string {
  const frac = clamp01(Math.abs(n) / domain.maxAbs);
  if (!domain.hasNeg) {
    const pct = (frac * 100).toFixed(1);
    return `linear-gradient(to right, ${barFill(db.positive)} ${pct}%, transparent ${pct}%)`;
  }
  if (n >= 0) {
    const end = (50 + frac * 50).toFixed(1);
    return `linear-gradient(to right, transparent 50%, ${barFill(db.positive)} 50%, ${barFill(db.positive)} ${end}%, transparent ${end}%)`;
  }
  const start = (50 - frac * 50).toFixed(1);
  return `linear-gradient(to right, transparent ${start}%, ${barFill(db.negative)} ${start}%, ${barFill(db.negative)} 50%, transparent 50%)`;
}
function bandFor(n: number, domain: CondDomain, count: number): number {
  if (domain.max === domain.min) return Math.floor((count - 1) / 2);
  const t = (n - domain.min) / (domain.max - domain.min);
  return Math.min(count - 1, Math.max(0, Math.floor(t * count)));
}
/** Evaluate a numeric threshold (shared by by-value rules and custom icon bands). */
function matchThreshold(n: number, r: { op: CondOp; value: number; value2?: number }): boolean {
  switch (r.op) {
    case 'gt': return n > r.value;
    case 'ge': return n >= r.value;
    case 'lt': return n < r.value;
    case 'le': return n <= r.value;
    case 'eq': return n === r.value;
    case 'ne': return n !== r.value;
    case 'between': return r.value2 != null && n >= Math.min(r.value, r.value2) && n <= Math.max(r.value, r.value2);
    default: return false;
  }
}

// ── Painters (the no-vaporware backend of this surface) ───────────────────────

/** An icon glyph painted before/after a cell value (mode==='icons'). */
export interface CondIconGlyph {
  glyph: string;
  color: string;
  label: string;
  /** Position relative to the value; the host may honor it (defaults to left). */
  layout?: CondIconLayout;
  /** Vertical alignment within the cell (defaults to middle). */
  align?: CondIconAlign;
}

/** What a single (column, value) should render as. Empty when no rule applies. */
export interface CondCellPaint {
  /** Table-cell background (solid tint for rules/colorScale, gradient for dataBars). */
  background?: string;
  /** Font color (rules/colorScale with applyTo:'text'). */
  color?: string;
  /** Saturated, un-tinted color for chart bar/column fills. */
  fill?: string;
  /** Leading icon (mode==='icons'). */
  icon?: CondIconGlyph;
  /** A safe hyperlink URL (mode==='webUrl'); the host renders the cell text as `<a href>`. */
  link?: string;
}

/**
 * Compute the paint for ONE rule against a raw cell value. `domain` is required
 * for colorScale/dataBars/auto-band icons (supplied by {@link applyConditionalFormat}).
 * `bound` is the value of the rule's bound secondary field for this row — used by
 * `fieldValue` (the color) and `webUrl` (the URL) when they bind a different
 * column; when the host can't supply the row, both modes fall back to the cell's
 * own value. Non-numeric / unmatched values return `{}` so the host renders the
 * cell unchanged (honest — never blanks it).
 */
export function cellStyleFor(value: unknown, rule: CondRule, domain?: CondDomain, bound?: unknown): CondCellPaint {
  const n = toNum(value);
  switch (rule.mode) {
    case 'rules': {
      if (n == null || !rule.rules?.length) return {};
      const hit = rule.rules.find((r) => matchThreshold(n, r));
      if (!hit) return {};
      return rule.applyTo === 'text'
        ? { color: hit.color, fill: hit.color }
        : { background: cellBg(hit.color), fill: hit.color };
    }
    case 'colorScale': {
      const sc = rule.colorScale;
      if (n == null || !sc) return {};
      const t = !domain || domain.max === domain.min ? 0.5 : clamp01((n - domain.min) / (domain.max - domain.min));
      const blended = scaleColor(sc, t);
      return rule.applyTo === 'text'
        ? { color: blended, fill: blended }
        : { background: cellBg(blended), fill: blended };
    }
    case 'dataBars': {
      const db = rule.dataBars;
      if (n == null || !db || !domain) return {};
      return { background: dataBarBackground(n, domain, db), fill: n >= 0 ? db.positive : db.negative };
    }
    case 'icons': {
      if (n == null) return {};
      const cfg = rule.icons;
      const layout = cfg?.layout;
      const align = cfg?.align;
      // Custom numeric thresholds (top-down, first match wins) override auto-banding.
      if (cfg?.bands?.length) {
        const hit = cfg.bands.find((b) => matchThreshold(n, b));
        if (!hit) return {};
        return { icon: { glyph: hit.glyph, color: hit.token, label: 'Icon threshold', layout, align }, fill: hit.token };
      }
      if (!domain) return {};
      const set = ICON_SETS[cfg?.set ?? 'arrows'];
      const g = set.bands[bandFor(n, domain, set.bands.length)];
      return { icon: { glyph: g.glyph, color: g.token, label: `${set.label} band`, layout, align }, fill: g.token };
    }
    case 'fieldValue': {
      // The bound measure/column returns the color directly (PBI "Field value");
      // fall back to the formatted cell's own value when no separate field is bound.
      const color = asColor(bound !== undefined ? bound : value);
      if (!color) return {};
      return rule.applyTo === 'text'
        ? { color, fill: color }
        : { background: color, fill: color };
    }
    case 'webUrl': {
      const url = asUrl(bound !== undefined ? bound : value);
      if (!url) return {};
      return { link: url };
    }
    default:
      return {};
  }
}

/** A rule is paintable once its field resolves and its mode config is present. */
function validRules(cfg: ReportConditionalFormat): CondRule[] {
  return (cfg.rules || []).filter((r) => {
    if (!r.field || (!r.field.column && !r.field.measure)) return false;
    switch (r.mode) {
      case 'rules': return !!r.rules && r.rules.length > 0;
      case 'colorScale': return !!r.colorScale;
      case 'dataBars': return !!r.dataBars;
      case 'icons': return true;
      case 'fieldValue': return true; // bound field optional (own value is the color)
      case 'webUrl': return true;     // bound field optional (own value is the URL)
      default: return false;
    }
  });
}

/** Resolver returned by {@link applyConditionalFormat}; bound to one result set. */
export interface ConditionalFormatResolver {
  /** True when ≥1 rule actually matched a result column. */
  active: boolean;
  /**
   * Paint for a result column + raw value (undefined when no rule covers the
   * column). `row` is optional and only consumed by `fieldValue`/`webUrl` rules
   * that bind a SEPARATE column (so the painter can read that column's value for
   * this row); omitting it falls back to the cell's own value.
   */
  paintFor(columnKey: string, value: unknown, row?: Record<string, unknown>): CondCellPaint | undefined;
  /** The rule (if any) bound to a result column. */
  ruleForColumn(columnKey: string): CondRule | undefined;
}

const INACTIVE: ConditionalFormatResolver = {
  active: false,
  paintFor: () => undefined,
  ruleForColumn: () => undefined,
};

/**
 * Bind a conditional-format model to a visual's actual `/query` result rows:
 * resolve each rule's field to a result column, pre-compute that column's numeric
 * domain ONCE, and return a resolver the host calls per cell. The first rule per
 * column wins (PBI allows one conditional format per field). Pure — no React.
 */
export function applyConditionalFormat(
  rows: Array<Record<string, unknown>>,
  cfg?: ReportConditionalFormat | null,
): ConditionalFormatResolver {
  const rules = cfg ? validRules(cfg) : [];
  if (rows.length === 0 || rules.length === 0) return INACTIVE;
  const keys = Object.keys(rows[0]);
  const byCol = new Map<string, { rule: CondRule; domain?: CondDomain; boundKey?: string }>();
  for (const rule of rules) {
    const key = matchCondKey(keys, rule.field);
    if (!key || byCol.has(key)) continue;
    // fieldValue/webUrl can pull their color/URL from a DIFFERENT column.
    let boundKey: string | undefined;
    if (rule.mode === 'fieldValue' && rule.fieldValueField) boundKey = matchCondKey(keys, rule.fieldValueField) ?? undefined;
    else if (rule.mode === 'webUrl' && rule.webUrlField) boundKey = matchCondKey(keys, rule.webUrlField) ?? undefined;
    byCol.set(key, { rule, domain: computeDomain(rows, key) ?? undefined, boundKey });
  }
  if (byCol.size === 0) return INACTIVE;
  return {
    active: true,
    ruleForColumn: (c) => byCol.get(c)?.rule,
    paintFor: (c, value, row) => {
      const e = byCol.get(c);
      if (!e) return undefined;
      const bound = e.boundKey && row ? row[e.boundKey] : undefined;
      return cellStyleFor(value, e.rule, e.domain, bound);
    },
  };
}

// ── styles (Fluent v9 + Loom tokens; matches format-pane.tsx) ─────────────────

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  headRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
  spacer: { flex: 1 },
  hint: { color: tokens.colorNeutralForeground3 },
  ruleCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  ruleHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  modeStrip: {
    display: 'flex', gap: '2px', padding: '2px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  modeBtn: {
    flex: 1, minWidth: 0, border: 'none', backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2, borderRadius: tokens.borderRadiusSmall,
  },
  modeBtnActive: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorBrandForeground1, boxShadow: tokens.shadow2,
  },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  label: { color: tokens.colorNeutralForeground3 },
  threshRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  opDd: { minWidth: '128px' },
  numInput: { width: '84px' },
  swatchRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXXS, alignItems: 'center' },
  swatchDot: {
    width: '20px', height: '20px', padding: 0, cursor: 'pointer',
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    transitionProperty: 'transform, box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { transform: 'scale(1.12)' },
  },
  swatchDotActive: { border: `2px solid ${tokens.colorNeutralForeground1}`, boxShadow: tokens.shadow4 },
  scaleRow: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  gradientBar: { height: '14px', borderRadius: tokens.borderRadiusSmall, border: `1px solid ${tokens.colorNeutralStroke2}` },
  previewRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  previewCell: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    minWidth: '92px', justifyContent: 'flex-end',
    paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusSmall, border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontVariantNumeric: 'tabular-nums',
  },
  iconPreview: { display: 'flex', gap: tokens.spacingHorizontalS, fontSize: '16px', alignItems: 'center' },
  removeBtn: { flexShrink: 0 },
  // icon glyph picker (custom bands)
  glyphRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXXS, alignItems: 'center' },
  glyphDot: {
    minWidth: '24px', height: '24px', padding: 0, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px',
    backgroundColor: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusSmall, border: `1px solid ${tokens.colorNeutralStroke1}`,
    transitionProperty: 'transform, box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { transform: 'scale(1.1)' },
  },
  glyphDotActive: { border: `2px solid ${tokens.colorBrandForeground1}`, boxShadow: tokens.shadow4 },
  // web-url preview anchor
  previewLink: {
    color: tokens.colorBrandForeground1, textDecorationLine: 'underline', cursor: 'pointer',
    ':hover': { color: tokens.colorBrandForeground2 },
  },
});

type Styles = ReturnType<typeof useStyles>;

// ── Field option (host passes fieldOptions(tables) results) ───────────────────

export interface CondFieldOption {
  key: string;
  label: string;
  table?: string;
  column?: string;
  measure?: string;
}

// ── swatch picker ──────────────────────────────────────────────────────────────

function SwatchPicker({ value, onChange, ariaLabel, styles }: {
  value: string; onChange: (c: string) => void; ariaLabel: string; styles: Styles;
}): ReactElement {
  return (
    <div className={styles.swatchRow} role="radiogroup" aria-label={ariaLabel}>
      {COND_SWATCHES.map((sw) => {
        const active = value === sw.token;
        return (
          <Tooltip key={sw.token} content={sw.label} relationship="label" withArrow>
            <button
              type="button" role="radio" aria-checked={active} aria-label={sw.label}
              className={mergeClasses(styles.swatchDot, active && styles.swatchDotActive)}
              style={{ backgroundColor: sw.token }}
              onClick={() => onChange(sw.token)}
            />
          </Tooltip>
        );
      })}
    </div>
  );
}

// ── live preview chip (renders the REAL painter output for a sample value) ────

const SAMPLE_DOMAIN: CondDomain = { min: 0, max: 100, mid: 50, maxAbs: 100, hasNeg: false, count: 3 };
/** A token (serializes to `var(--…)`, accepted by {@link asColor}) standing in for a field-returned color. */
const SAMPLE_FIELD_COLOR = tokens.colorBrandBackground;
const SAMPLE_URL = 'https://contoso.example/orders/SO-4711';

function PreviewChip({ rule, styles }: { rule: CondRule; styles: Styles }): ReactElement {
  // webUrl — the painter returns a real (safe) link; render it as the host will.
  if (rule.mode === 'webUrl') {
    const paint = cellStyleFor(SAMPLE_URL, rule, SAMPLE_DOMAIN, SAMPLE_URL);
    return (
      <div className={styles.previewRow}>
        <Caption1 className={styles.label}>Preview</Caption1>
        <span className={styles.previewCell} style={{ justifyContent: 'flex-start' }}>
          {paint.link ? (
            <a className={styles.previewLink} href={paint.link} target="_blank" rel="noreferrer"
               onClick={(e) => e.preventDefault()}>
              <Text size={200}>contoso.example/orders/SO-4711</Text>
            </a>
          ) : (
            <Text size={200}>—</Text>
          )}
        </span>
      </div>
    );
  }
  // fieldValue — the bound field's value IS the color; preview a representative one.
  if (rule.mode === 'fieldValue') {
    const bound = rule.applyTo === 'text' ? tokens.colorPaletteGreenForeground1 : SAMPLE_FIELD_COLOR;
    const paint = cellStyleFor(78, rule, SAMPLE_DOMAIN, bound);
    return (
      <div className={styles.previewRow}>
        <Caption1 className={styles.label}>Preview</Caption1>
        <span className={styles.previewCell} style={{ background: paint.background, color: paint.color }}>
          <Text size={200}>78</Text>
        </span>
      </div>
    );
  }
  // rules / colorScale / dataBars / icons — honor icon layout + alignment.
  const sample = 78;
  const paint = cellStyleFor(sample, rule, SAMPLE_DOMAIN);
  const ic = paint.icon;
  const flexDirection = ic?.layout === 'right' ? 'row-reverse' : 'row';
  const alignItems = ic?.align === 'top' ? 'flex-start' : ic?.align === 'bottom' ? 'flex-end' : 'center';
  return (
    <div className={styles.previewRow}>
      <Caption1 className={styles.label}>Preview</Caption1>
      <span className={styles.previewCell} style={{ background: paint.background, color: paint.color, flexDirection, alignItems }}>
        {ic && <span aria-hidden style={{ color: ic.color }}>{ic.glyph}</span>}
        <Text size={200}>{sample}</Text>
      </span>
    </div>
  );
}

// ── per-mode editors ────────────────────────────────────────────────────────────

function RulesEditor({ rule, onChange, styles }: { rule: CondRule; onChange: (r: CondRule) => void; styles: Styles }): ReactElement {
  const list = rule.rules ?? [];
  const setList = (next: CondThreshold[]) => onChange({ ...rule, rules: next });
  const patch = (id: string, p: Partial<CondThreshold>) => setList(list.map((t) => (t.id === id ? { ...t, ...p } : t)));
  return (
    <div className={styles.section}>
      {list.map((t) => (
        <div key={t.id} className={styles.threshRow}>
          <Dropdown
            size="small" className={styles.opDd} aria-label="condition"
            value={COND_OPS.find((o) => o.op === t.op)?.label ?? '> greater than'}
            selectedOptions={[t.op]}
            onOptionSelect={(_e, d) => patch(t.id, { op: (d.optionValue as CondOp) || 'gt' })}
          >
            {COND_OPS.map((o) => <Option key={o.op} value={o.op} text={o.label}>{o.label}</Option>)}
          </Dropdown>
          <Input
            size="small" type="number" className={styles.numInput} aria-label="value"
            value={String(t.value)}
            onChange={(_e, d) => patch(t.id, { value: d.value === '' ? 0 : Number(d.value) })}
          />
          {t.op === 'between' && (
            <Input
              size="small" type="number" className={styles.numInput} aria-label="upper value"
              value={String(t.value2 ?? 0)}
              onChange={(_e, d) => patch(t.id, { value2: d.value === '' ? 0 : Number(d.value) })}
            />
          )}
          <SwatchPicker value={t.color} onChange={(c) => patch(t.id, { color: c })} ariaLabel="rule color" styles={styles} />
          <Button
            size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="remove condition"
            className={styles.removeBtn} onClick={() => setList(list.filter((x) => x.id !== t.id))}
          />
        </div>
      ))}
      <div>
        <Button
          size="small" appearance="subtle" icon={<Add20Regular />}
          onClick={() => setList([...list, { id: cuid('th'), op: 'ge', value: 0, color: AMBER }])}
        >
          Add condition
        </Button>
      </div>
    </div>
  );
}

function ColorScaleEditor({ rule, onChange, styles }: { rule: CondRule; onChange: (r: CondRule) => void; styles: Styles }): ReactElement {
  const sc = rule.colorScale ?? { min: RED, max: GREEN };
  const set = (p: Partial<CondColorScale>) => onChange({ ...rule, colorScale: { ...sc, ...p } });
  const gradient = sc.mid
    ? `linear-gradient(to right, ${sc.min}, ${sc.mid}, ${sc.max})`
    : `linear-gradient(to right, ${sc.min}, ${sc.max})`;
  return (
    <div className={styles.section}>
      <Switch
        label="Add a midpoint (3-color scale)"
        checked={!!sc.mid}
        onChange={(_e, d) => set({ mid: d.checked ? AMBER : undefined })}
      />
      <div className={styles.scaleRow}>
        <Caption1 className={styles.label}>Minimum</Caption1>
        <SwatchPicker value={sc.min} onChange={(c) => set({ min: c })} ariaLabel="minimum color" styles={styles} />
      </div>
      {sc.mid && (
        <div className={styles.scaleRow}>
          <Caption1 className={styles.label}>Center</Caption1>
          <SwatchPicker value={sc.mid} onChange={(c) => set({ mid: c })} ariaLabel="center color" styles={styles} />
        </div>
      )}
      <div className={styles.scaleRow}>
        <Caption1 className={styles.label}>Maximum</Caption1>
        <SwatchPicker value={sc.max} onChange={(c) => set({ max: c })} ariaLabel="maximum color" styles={styles} />
      </div>
      <div className={styles.gradientBar} style={{ background: gradient }} aria-hidden />
    </div>
  );
}

function DataBarsEditor({ rule, onChange, styles }: { rule: CondRule; onChange: (r: CondRule) => void; styles: Styles }): ReactElement {
  const db = rule.dataBars ?? { positive: BRAND, negative: RED };
  const set = (p: Partial<CondDataBars>) => onChange({ ...rule, dataBars: { ...db, ...p } });
  return (
    <div className={styles.section}>
      <div className={styles.scaleRow}>
        <Caption1 className={styles.label}>Positive bar</Caption1>
        <SwatchPicker value={db.positive} onChange={(c) => set({ positive: c })} ariaLabel="positive bar color" styles={styles} />
      </div>
      <div className={styles.scaleRow}>
        <Caption1 className={styles.label}>Negative bar</Caption1>
        <SwatchPicker value={db.negative} onChange={(c) => set({ negative: c })} ariaLabel="negative bar color" styles={styles} />
      </div>
      <Caption1 className={styles.hint}>Negative values grow left of a shared center axis; positive grow right.</Caption1>
    </div>
  );
}

const ICON_LAYOUTS: { id: CondIconLayout; label: string }[] = [
  { id: 'left', label: 'Left of value' },
  { id: 'right', label: 'Right of value' },
];
const ICON_ALIGNS: { id: CondIconAlign; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'middle', label: 'Middle' },
  { id: 'bottom', label: 'Bottom' },
];

/** Seed three custom thresholds from the set's low→high bands (≥66 / ≥33 / ≥0). */
function defaultIconBands(set: CondIconSet): CondIconBand[] {
  const b = ICON_SETS[set].bands; // low→high == [red, amber, green]
  return [
    { id: cuid('band'), op: 'ge', value: 66, glyph: b[2].glyph, token: b[2].token },
    { id: cuid('band'), op: 'ge', value: 33, glyph: b[1].glyph, token: b[1].token },
    { id: cuid('band'), op: 'ge', value: 0, glyph: b[0].glyph, token: b[0].token },
  ];
}

/** Structured glyph radiogroup for a custom icon band (no free-text). */
function GlyphPicker({ value, onChange, styles }: { value: string; onChange: (g: string) => void; styles: Styles }): ReactElement {
  return (
    <div className={styles.glyphRow} role="radiogroup" aria-label="icon glyph">
      {GLYPH_CHOICES.map((g) => (
        <button
          key={g} type="button" role="radio" aria-checked={value === g} aria-label={`glyph ${g}`}
          className={mergeClasses(styles.glyphDot, value === g && styles.glyphDotActive)}
          onClick={() => onChange(g)}
        >
          {g}
        </button>
      ))}
    </div>
  );
}

function IconsEditor({ rule, onChange, styles }: { rule: CondRule; onChange: (r: CondRule) => void; styles: Styles }): ReactElement {
  const cfg = rule.icons ?? { set: 'arrows' as CondIconSet };
  const meta = ICON_SETS[cfg.set];
  const setCfg = (p: Partial<CondIconConfig>) => onChange({ ...rule, icons: { ...cfg, ...p } });
  const bands = cfg.bands ?? [];
  const custom = bands.length > 0;
  const setBands = (next: CondIconBand[]) => onChange({ ...rule, icons: { ...cfg, bands: next.length ? next : undefined } });
  const patchBand = (id: string, p: Partial<CondIconBand>) => setBands(bands.map((b) => (b.id === id ? { ...b, ...p } : b)));
  return (
    <div className={styles.section}>
      <Caption1 className={styles.label}>Icon set</Caption1>
      <Dropdown
        size="small" aria-label="icon set"
        value={meta.label} selectedOptions={[cfg.set]}
        onOptionSelect={(_e, d) => setCfg({ set: (d.optionValue as CondIconSet) || 'arrows' })}
      >
        {ICON_SET_IDS.map((id) => <Option key={id} value={id} text={ICON_SETS[id].label}>{ICON_SETS[id].label}</Option>)}
      </Dropdown>
      <div className={styles.iconPreview} aria-hidden>
        {meta.bands.map((b, i) => <span key={i} style={{ color: b.token }}>{b.glyph}</span>)}
      </div>

      {/* icon position relative to the value */}
      <div className={styles.threshRow}>
        <Caption1 className={styles.label}>Icon position</Caption1>
        {ICON_LAYOUTS.map((l) => (
          <ToggleButton
            key={l.id} size="small" appearance="subtle" checked={(cfg.layout ?? 'left') === l.id}
            aria-label={l.label} onClick={() => setCfg({ layout: l.id })}
          >
            {l.label}
          </ToggleButton>
        ))}
      </div>

      {/* vertical alignment within the cell */}
      <div className={styles.threshRow}>
        <Caption1 className={styles.label}>Align</Caption1>
        {ICON_ALIGNS.map((a) => (
          <ToggleButton
            key={a.id} size="small" appearance="subtle" checked={(cfg.align ?? 'middle') === a.id}
            aria-label={`align ${a.label}`} onClick={() => setCfg({ align: a.id })}
          >
            {a.label}
          </ToggleButton>
        ))}
      </div>

      {/* auto low→high banding (default) vs explicit numeric thresholds */}
      <Switch
        label="Custom value thresholds"
        checked={custom}
        onChange={(_e, d) => setBands(d.checked ? defaultIconBands(cfg.set) : [])}
      />
      {custom && bands.map((b) => (
        <div key={b.id} className={styles.threshRow}>
          <Dropdown
            size="small" className={styles.opDd} aria-label="icon condition"
            value={COND_OPS.find((o) => o.op === b.op)?.label ?? '≥ at least'} selectedOptions={[b.op]}
            onOptionSelect={(_e, d) => patchBand(b.id, { op: (d.optionValue as CondOp) || 'ge' })}
          >
            {COND_OPS.map((o) => <Option key={o.op} value={o.op} text={o.label}>{o.label}</Option>)}
          </Dropdown>
          <Input
            size="small" type="number" className={styles.numInput} aria-label="threshold value"
            value={String(b.value)} onChange={(_e, d) => patchBand(b.id, { value: d.value === '' ? 0 : Number(d.value) })}
          />
          {b.op === 'between' && (
            <Input
              size="small" type="number" className={styles.numInput} aria-label="upper threshold value"
              value={String(b.value2 ?? 0)} onChange={(_e, d) => patchBand(b.id, { value2: d.value === '' ? 0 : Number(d.value) })}
            />
          )}
          <GlyphPicker value={b.glyph} onChange={(g) => patchBand(b.id, { glyph: g })} styles={styles} />
          <SwatchPicker value={b.token} onChange={(c) => patchBand(b.id, { token: c })} ariaLabel="icon color" styles={styles} />
          <Button
            size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="remove threshold"
            className={styles.removeBtn} onClick={() => setBands(bands.filter((x) => x.id !== b.id))}
          />
        </div>
      ))}
      {custom && (
        <div>
          <Button
            size="small" appearance="subtle" icon={<Add20Regular />}
            onClick={() => setBands([{ id: cuid('band'), op: 'ge', value: 0, glyph: GLYPH_CHOICES[0], token: GREEN }, ...bands])}
          >
            Add threshold
          </Button>
        </div>
      )}
      <Caption1 className={styles.hint}>
        {custom
          ? 'Each row is evaluated top-down; the first matching threshold sets the icon.'
          : "Low → high bands are assigned across the field's value range."}
      </Caption1>
    </div>
  );
}

/** Shared bound-field picker for the data-driven modes (fieldValue / webUrl). */
function BoundFieldEditor({ current, fields, label, emptyLabel, hint, onPick, styles }: {
  current?: CondField; fields: CondFieldOption[]; label: string; emptyLabel: string; hint: string;
  onPick: (f: CondField | undefined) => void; styles: Styles;
}): ReactElement {
  const key = current ? condFieldKey(current) : '';
  const pick = (k: string) => {
    if (!k) { onPick(undefined); return; }
    const o = fields.find((x) => x.key === k);
    onPick(o ? { table: o.table, column: o.column, measure: o.measure } : undefined);
  };
  return (
    <div className={styles.section}>
      <Caption1 className={styles.label}>{label}</Caption1>
      <Dropdown
        size="small" aria-label={label}
        value={current ? condFieldLabel(current) : emptyLabel} selectedOptions={[key]}
        onOptionSelect={(_e, d) => pick(String(d.optionValue ?? ''))}
      >
        <Option value="" text={emptyLabel}>{emptyLabel}</Option>
        {fields.map((o) => <Option key={o.key} value={o.key} text={o.label}>{o.label}</Option>)}
      </Dropdown>
      <Caption1 className={styles.hint}>{hint}</Caption1>
    </div>
  );
}

function FieldValueEditor({ rule, fields, onChange, styles }: {
  rule: CondRule; fields: CondFieldOption[]; onChange: (r: CondRule) => void; styles: Styles;
}): ReactElement {
  return (
    <BoundFieldEditor
      current={rule.fieldValueField} fields={fields}
      label="Color based on field"
      emptyLabel="This column's value"
      hint="The chosen measure/column must return a color (e.g. #2E7D32, rgb(…), or a Loom token); its value paints each cell directly."
      onPick={(f) => onChange({ ...rule, fieldValueField: f })}
      styles={styles}
    />
  );
}

function WebUrlEditor({ rule, fields, onChange, styles }: {
  rule: CondRule; fields: CondFieldOption[]; onChange: (r: CondRule) => void; styles: Styles;
}): ReactElement {
  return (
    <BoundFieldEditor
      current={rule.webUrlField} fields={fields}
      label="URL based on field"
      emptyLabel="This column's value"
      hint="Cell text becomes a hyperlink to the URL value (http, https, or mailto). Table & matrix visuals only."
      onPick={(f) => onChange({ ...rule, webUrlField: f })}
      styles={styles}
    />
  );
}

// ── one rule card ───────────────────────────────────────────────────────────────

function RuleCard({ rule, fields, visualType, onChange, onRemove, styles }: {
  rule: CondRule; fields: CondFieldOption[]; visualType?: string;
  onChange: (r: CondRule) => void; onRemove: () => void; styles: Styles;
}): ReactElement {
  const pickField = (key: string) => {
    const o = fields.find((x) => x.key === key);
    onChange({ ...rule, field: { table: o?.table, column: o?.column, measure: o?.measure } });
  };
  const setMode = (mode: CondMode) => {
    if (mode === rule.mode) return;
    // Seed the chosen mode's default config so the rule is immediately paintable
    // (no-vaporware: switching mode never yields an empty/dead rule).
    const next: CondRule = { ...rule, mode };
    if (mode === 'rules' && !next.rules?.length) next.rules = [{ id: cuid('th'), op: 'ge', value: 0, color: GREEN }];
    if (mode === 'colorScale' && !next.colorScale) next.colorScale = { min: RED, max: GREEN };
    if (mode === 'dataBars' && !next.dataBars) next.dataBars = { positive: BRAND, negative: RED };
    if (mode === 'icons' && !next.icons) next.icons = { set: 'arrows' };
    onChange(next);
  };
  // Web URL only makes sense where the host renders raw cell text (table/matrix).
  // Keep the active mode visible even if the visual type wouldn't otherwise offer it.
  const modes = MODE_META.filter((m) => !m.tableOnly || isTableLike(visualType) || m.mode === rule.mode);
  const showApplyTo = rule.mode === 'rules' || rule.mode === 'colorScale' || rule.mode === 'fieldValue';
  return (
    <div className={styles.ruleCard}>
      <div className={styles.ruleHead}>
        <Options20Regular />
        <Dropdown
          size="small" style={{ flex: 1, minWidth: 0 }} placeholder="Field"
          aria-label="conditional-format field"
          value={condFieldLabel(rule.field)} selectedOptions={[condFieldKey(rule.field)]}
          onOptionSelect={(_e, d) => pickField(String(d.optionValue || ''))}
        >
          {fields.map((o) => <Option key={o.key} value={o.key} text={o.label}>{o.label}</Option>)}
        </Dropdown>
        <Button
          size="small" appearance="subtle" icon={<Dismiss16Regular />}
          aria-label="remove rule" className={styles.removeBtn} onClick={onRemove}
        />
      </div>

      <div className={styles.modeStrip} role="tablist" aria-label="format style">
        {modes.map((m) => (
          <Tooltip key={m.mode} content={m.label} relationship="label" withArrow>
            <ToggleButton
              size="small" appearance="subtle" icon={m.icon} checked={rule.mode === m.mode}
              role="tab" aria-selected={rule.mode === m.mode} aria-label={m.label}
              className={mergeClasses(styles.modeBtn, rule.mode === m.mode && styles.modeBtnActive)}
              onClick={() => setMode(m.mode)}
            />
          </Tooltip>
        ))}
      </div>

      {rule.mode === 'rules' && <RulesEditor rule={rule} onChange={onChange} styles={styles} />}
      {rule.mode === 'colorScale' && <ColorScaleEditor rule={rule} onChange={onChange} styles={styles} />}
      {rule.mode === 'dataBars' && <DataBarsEditor rule={rule} onChange={onChange} styles={styles} />}
      {rule.mode === 'icons' && <IconsEditor rule={rule} onChange={onChange} styles={styles} />}
      {rule.mode === 'fieldValue' && <FieldValueEditor rule={rule} fields={fields} onChange={onChange} styles={styles} />}
      {rule.mode === 'webUrl' && <WebUrlEditor rule={rule} fields={fields} onChange={onChange} styles={styles} />}

      {showApplyTo && (
        <div className={styles.threshRow}>
          <Caption1 className={styles.label}>Apply to</Caption1>
          <ToggleButton size="small" appearance="subtle" checked={(rule.applyTo ?? 'background') === 'background'}
            onClick={() => onChange({ ...rule, applyTo: 'background' })}>Background</ToggleButton>
          <ToggleButton size="small" appearance="subtle" checked={rule.applyTo === 'text'}
            onClick={() => onChange({ ...rule, applyTo: 'text' })}>Font color</ToggleButton>
        </div>
      )}

      <Divider />
      <PreviewChip rule={rule} styles={styles} />
    </div>
  );
}

// ── ConditionalFormatEditor (the right-rail surface) ──────────────────────────

export interface ConditionalFormatEditorProps {
  /** Current sparse model (read from `visual.format.conditionalFormat`). */
  value?: ReportConditionalFormat | null;
  /** Bindable fields — pass the designer's `fieldOptions(tables)` result. */
  fields: CondFieldOption[];
  /**
   * The host visual type (bar/column/table/matrix/…). Used to table-scope the
   * Web-URL mode (it's only meaningful where the host renders raw cell text).
   * When omitted, Web-URL is hidden unless a rule already uses it.
   */
  visualType?: string;
  /** Emit the next model; host wires to `mutateVisual` → /definition. */
  onChange: (next: ReportConditionalFormat) => void;
}

/**
 * The Conditional formatting pane. Controlled + fully structured — every control
 * maps to a field of {@link ReportConditionalFormat}. When no fields are bound it
 * shows an honest EmptyState gate (no-vaporware: not disabled controls); when
 * fields exist but no rules are authored it shows a styled hint + an Add button.
 */
export function ConditionalFormatEditor({ value, fields, visualType, onChange }: ConditionalFormatEditorProps): ReactElement {
  const styles = useStyles();
  useId();

  if (fields.length === 0) {
    return (
      <EmptyState
        icon={<ColorRegular />}
        title="No fields to format"
        body="Bind a data source and add a column or measure to the visual, then format it by rules, a color scale, data bars, or icons."
      />
    );
  }

  const model = value ?? emptyConditionalFormat();
  const rules = model.rules ?? [];
  const setRules = (next: CondRule[]) => onChange({ rules: next });
  const addRule = () => setRules([...rules, freshRule({ table: fields[0].table, column: fields[0].column, measure: fields[0].measure })]);

  return (
    <div className={styles.pane}>
      <div className={styles.headRow}>
        <NumberSymbol20Regular />
        <Caption1><strong>Conditional formatting</strong></Caption1>
        <div className={styles.spacer} />
        <Button size="small" appearance="subtle" icon={<Add20Regular />} aria-label="add conditional format" onClick={addRule}>
          Add
        </Button>
      </div>

      {rules.length === 0 && (
        <Caption1 className={styles.hint}>
          No conditional formatting yet. Add a rule to color cells and bars by their values.
        </Caption1>
      )}

      {rules.map((r) => (
        <RuleCard
          key={r.id}
          rule={r}
          fields={fields}
          visualType={visualType}
          onChange={(next) => setRules(rules.map((x) => (x.id === r.id ? next : x)))}
          onRemove={() => setRules(rules.filter((x) => x.id !== r.id))}
          styles={styles}
        />
      ))}
    </div>
  );
}

export default ConditionalFormatEditor;

/** Re-export of the field-mapping helper so the host can also resolve columns. */
export { matchCondKey as resolveConditionalColumn };

// `CSSProperties` is part of the public painter contract (host spreads paint
// fields into a React `style`); referenced here to keep the import meaningful.
export type CondStyle = Pick<CSSProperties, 'background' | 'color'>;
