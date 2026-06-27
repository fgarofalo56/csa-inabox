'use client';

/**
 * slicer-visual — the Power BI "Slicer" surface for the Loom-native Report
 * Designer (report-designer Wave 5, chunk B).
 *
 * ── Power BI parity (ui-parity.md) ──────────────────────────────────────────
 * learn.microsoft.com/power-bi/visuals/power-bi-visualization-slicers and the
 * numeric / relative-date / between slicer docs. A Power BI slicer is a single
 * on-canvas filter control over ONE field, and its *type* changes with the
 * field and the author's choice:
 *   • categorical → a checkbox List, a Dropdown, or a horizontal Tile (chiclet)
 *     layout — multi-select by default (Ctrl-click / "Select all").
 *   • numeric     → a "Between" range, "Less than or equal to", or "Greater
 *     than or equal to" — a real range slider with the field's data min/max.
 *   • date        → a date Between range, a single date, or a "Relative date"
 *     (Last / Next N days|months|years) window.
 * Selecting in a slicer cross-filters every other visual on the page.
 *
 * This file is the one-for-one Loom build of that surface. The bare
 * <Dropdown> the designer shipped for the slicer branch is replaced by this
 * full control: List / Dropdown / Tile / Between / Before / After /
 * Relative-date / Date-picker — each a REAL, structured affordance that emits a
 * structured {@link ReportFilter}. The host merges that filter into the page
 * filters channel (the SAME channel the Filters pane writes), which flows into
 * the already-shipped {@link applyFilters} client engine AND the server-side
 * wells-to-sql WHERE — so NO query-engine change is needed for the slicer to
 * really filter. Emitting `null` clears the slicer's constraint (true "(All)").
 *
 * ── no-vaporware.md ─────────────────────────────────────────────────────────
 * Every control is wired. List/Dropdown/Tile consume the REAL `SELECT DISTINCT`
 * result rows the host already fetched for this slicer and emit `in` / `eq`.
 * The numeric "Between" slider's bounds come from a REAL `SELECT MIN(col),
 * MAX(col)` issued through the host's generalized `queryAdHoc` (Path-3 /query →
 * wells-to-sql), with an honest client fallback to the min/max of the distinct
 * rows when no queryAdHoc is wired — never a hard-coded 0..100. Relative-date
 * emits the structured relDir/relN/relUnit window the Filters-pane engine
 * already evaluates. There are no dead controls and no "coming soon" — an
 * unbound slicer shows a designed {@link EmptyState}, not a blank box.
 *
 * ── no-freeform-config.md ────────────────────────────────────────────────────
 * Every input is structured: a type Dropdown, checkbox List, Tile ToggleButtons,
 * a numeric Slider + numeric Input, a relative-date direction/unit Dropdown + a
 * numeric N, and native date Inputs. The author NEVER types DAX / JSON / a raw
 * predicate.
 *
 * ── no-fabric-dependency.md ──────────────────────────────────────────────────
 * Pure structured filtering over the Azure-native report /query + wells-to-sql
 * path. Nothing here reaches api.fabric.microsoft.com / api.powerbi.com.
 *
 * ── web3-ui.md ───────────────────────────────────────────────────────────────
 * Fluent UI v9 + Loom design tokens only — no hard-coded spacing/colors/radii/
 * shadows (raw px appears only as Slider/Input widths, a layout bound). The card
 * matches the sibling report surfaces: an accent header icon, a type pill, a
 * search box for long lists, an active-selection Badge, and designed empty /
 * loading states. Dark-legible by construction (token foregrounds throughout).
 *
 * The slicer is just another DVisual; the FreeFormCanvas positions it and the
 * host renders THIS body in its frame. Free-form canvas + Waves 0-4 + the data
 * E2E are extended, not regressed.
 */

import {
  useCallback, useEffect, useMemo, useRef, useState, type ReactElement,
} from 'react';
import {
  Subtitle2, Caption1, Badge, Button, ToggleButton, Dropdown, Option, Input,
  Slider, Switch, Checkbox, SearchBox, Divider, Tooltip, Spinner,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Filter20Regular, Dismiss16Regular, Checkmark16Regular,
  NumberSymbol20Regular, Apps20Regular, GridDots20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import type { ReportFilter, RelDir, RelUnit } from './filters-pane';
import type { CopilotVisualSpec } from '@/lib/components/report/report-powerbi-copilot';
import type { ReportFilterInput } from '@/lib/azure/wells-to-sql';

// ── public model ──────────────────────────────────────────────────────────────

/**
 * The slicer interaction style. A superset of Power BI's slicer types, gated to
 * the bound column's kind by {@link availableStyles}:
 *   list/dropdown/tile  — categorical (any column)
 *   between/before/after — numeric range / threshold (numeric column)
 *   datePicker/relativeDate/before/after — date window (date column)
 */
export type SlicerStyle =
  | 'list' | 'dropdown' | 'tile'
  | 'between' | 'before' | 'after'
  | 'relativeDate' | 'datePicker';

/** Inferred kind of the bound column — drives which styles + controls show. */
export type SlicerColumnKind = 'text' | 'number' | 'date';

/** The slicer's bound model field (table + column). */
export interface SlicerField { table?: string; column?: string }

export interface SlicerVisualProps {
  /** The slicer's bound field. `null` (or no column) ⇒ the unbound EmptyState. */
  field: SlicerField | null;
  /** The column name as it appears in the result rows (the slicer's `cols[0]`). */
  column: string;
  /** The bound column's model data type (e.g. Int64 / DateTime / String). When
   *  omitted the kind is sniffed from the rows. */
  dataType?: string;
  /** The `SELECT DISTINCT` result rows the host already fetched for this slicer. */
  rows: Array<Record<string, unknown>>;
  /** Persisted slicer style (visual.config.slicerStyle). Defaults by column kind. */
  style?: SlicerStyle;
  /** The slicer's currently-persisted filter (so the control reflects state on
   *  reload / bookmark apply). Pass the page-filter that targets this column. */
  value?: ReportFilter | null;
  /** Emit the structured filter — or `null` to clear ("(All)"). The host merges
   *  it into the page filters channel that flows into applyFilters + the server
   *  WHERE. NO engine change is required. */
  onFilter: (filter: ReportFilter | null) => void;
  /** Persist a structured style change to the DVisual (config.slicerStyle). */
  onStyleChange?: (style: SlicerStyle) => void;
  /** The host's generalized /query (Path-3 wells→SQL), used for the REAL
   *  `SELECT MIN(col), MAX(col)` bounds of a numeric Between/threshold slicer.
   *  Absent ⇒ honest client-side min/max of the distinct rows. */
  queryAdHoc?: (spec: CopilotVisualSpec, filters?: ReportFilterInput[]) => Promise<Array<Record<string, unknown>>>;
  /** Optional human title for aria labelling. */
  title?: string;
}

// ── pure helpers (exported for the host + tests) ───────────────────────────────

/** Infer the column kind from the model data type, falling back to a row sniff. */
export function slicerColumnKind(
  dataType: string | undefined, rows: Array<Record<string, unknown>>, column: string,
): SlicerColumnKind {
  const dt = (dataType || '').toLowerCase();
  if (dt) {
    if (/date|time/.test(dt)) return 'date';
    if (/int|dec|doub|float|numb|real|money|curr|long|short|byte/.test(dt)) return 'number';
    return 'text';
  }
  // No declared type — sniff a sample of the real values.
  const sample = (rows || []).slice(0, 24).map((r) => r[column]).filter((v) => v != null && String(v).trim() !== '');
  if (sample.length) {
    if (sample.every((v) => !Number.isNaN(Number(v)))) return 'number';
    if (sample.every((v) => !Number.isNaN(Date.parse(String(v))))) return 'date';
  }
  return 'text';
}

/** The slicer styles available for a column kind (a Power BI slicer-type list). */
export function availableStyles(kind: SlicerColumnKind): { v: SlicerStyle; label: string }[] {
  const common: { v: SlicerStyle; label: string }[] = [
    { v: 'list', label: 'List' },
    { v: 'dropdown', label: 'Dropdown' },
    { v: 'tile', label: 'Tile' },
  ];
  if (kind === 'number') {
    return [
      ...common,
      { v: 'between', label: 'Between' },
      { v: 'before', label: 'Less than or equal to' },
      { v: 'after', label: 'Greater than or equal to' },
    ];
  }
  if (kind === 'date') {
    return [
      ...common,
      { v: 'datePicker', label: 'Date range' },
      { v: 'relativeDate', label: 'Relative date' },
      { v: 'before', label: 'On or before' },
      { v: 'after', label: 'On or after' },
    ];
  }
  return common;
}

/** The sensible default style for a freshly-bound slicer of a given kind. */
export function defaultStyleFor(kind: SlicerColumnKind): SlicerStyle {
  if (kind === 'number') return 'between';
  if (kind === 'date') return 'datePicker';
  return 'list';
}

/** Distinct, non-null, stably-ordered string values of the slicer column. */
function distinctValues(rows: Array<Record<string, unknown>>, column: string, cap = 1000): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows || []) {
    const v = r[column];
    if (v == null) continue;
    const s = String(v);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** Numeric [min,max] over a column's distinct values, or null when non-numeric. */
function numericExtent(rows: Array<Record<string, unknown>>, column: string): { min: number; max: number } | null {
  let min = Infinity; let max = -Infinity;
  for (const r of rows || []) {
    const n = Number(r[column]);
    if (!Number.isFinite(n)) continue;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

/** A stable filter id for this slicer's field, so re-emits REPLACE (never append).
 *  Exported so the host (report-designer) can find this slicer's current filter for
 *  re-hydrate, replace/remove it on emit, and EXCLUDE it from the slicer's own query
 *  (a slicer must never filter its own value list — PBI behaviour). The id keys on
 *  the MODEL column (`field.column`), falling back to the result alias `column` only
 *  when the field is unbound — so the host can compute the identical id from
 *  `visual.wells.category[0]` without the result alias. */
export function slicerFilterId(field: SlicerField | null, column: string): string {
  const t = (field?.table || '').replace(/\W+/g, '_');
  const c = (field?.column || column || '').replace(/\W+/g, '_');
  return `slc_${t}_${c}`;
}

/** A structural signature of a filter (for echo-suppression on re-hydrate). */
function filterSig(f: ReportFilter | null): string {
  if (!f) return 'null';
  return JSON.stringify({
    op: f.op, value: f.value ?? null, value2: f.value2 ?? null,
    values: f.values ?? null, relDir: f.relDir ?? null, relN: f.relN ?? null, relUnit: f.relUnit ?? null,
  });
}

/** Parse to a finite number, else a fallback. */
function numOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Round to a slider-friendly step given the data span (so the thumb is usable). */
function sliderStep(span: number): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  if (span <= 1) return 0.01;
  if (span <= 10) return 0.1;
  if (span <= 1000) return 1;
  return Math.max(1, Math.round(span / 1000));
}

// ── gallery glyph (exported for the host VISUALS gallery) ──────────────────────

/** Dark-legible gallery glyph for the slicer entry (brand-foreground filter). */
export const slicerGalleryGlyph: ReactElement = <Filter20Regular />;

// ── styles ──────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    height: '100%', minHeight: 0, minWidth: 0,
    padding: tokens.spacingHorizontalS, boxSizing: 'border-box',
  },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  headerIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex' },
  grow: { flexGrow: 1, minWidth: 0 },
  fieldName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  // list
  list: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    overflowY: 'auto', minHeight: 0, maxHeight: '320px',
    paddingRight: tokens.spacingHorizontalXS,
  },
  listRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalXS, paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  listLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // tile
  tiles: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, overflowY: 'auto', maxHeight: '320px', alignContent: 'flex-start' },
  tile: { borderRadius: tokens.borderRadiusMedium },
  tileChecked: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    border: `1px solid ${tokens.colorBrandStroke1}`,
  },
  // ranges
  rangeBlock: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  rangeRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  rangeLabel: { minWidth: '48px', color: tokens.colorNeutralForeground2 },
  slider: { flexGrow: 1, minWidth: '120px' },
  numInput: { width: '108px' },
  dateInput: { width: '168px' },
  relRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  gateNote: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  bounds: { color: tokens.colorNeutralForeground3 },
});

// ── component ─────────────────────────────────────────────────────────────────

/**
 * SlicerVisual — the Power BI slicer card body. Picks an interaction style
 * (List / Dropdown / Tile / Between / Before / After / Relative-date /
 * Date-range) appropriate to the bound column, renders the real control over
 * the host's distinct rows / queried bounds, and emits a structured
 * {@link ReportFilter} (or `null` to clear) the host merges into page filters.
 */
export function SlicerVisual({
  field, column, dataType, rows, style: styleProp, value, onFilter, onStyleChange, queryAdHoc, title,
}: SlicerVisualProps): ReactElement {
  const styles = useStyles();

  const kind = useMemo(() => slicerColumnKind(dataType, rows, column), [dataType, rows, column]);
  const styleChoices = useMemo(() => availableStyles(kind), [kind]);
  const filterId = useMemo(() => slicerFilterId(field, column), [field, column]);
  const distinct = useMemo(() => distinctValues(rows, column), [rows, column]);

  // ── style (controlled-ish: internal, seeded from the persisted prop) ─────────
  const [style, setStyle] = useState<SlicerStyle>(() => styleProp ?? defaultStyleFor(kind));
  // Reflect an externally-persisted style change (e.g. config reload).
  useEffect(() => {
    if (styleProp && styleProp !== style) setStyle(styleProp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleProp]);

  // ── selection / range / window state ────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dropdownMulti, setDropdownMulti] = useState(false);
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<{ lo: number; hi: number } | null>(null);
  const [single, setSingle] = useState<number | null>(null);
  const [rel, setRel] = useState<{ dir: RelDir; n: number; unit: RelUnit }>({ dir: 'last', n: 30, unit: 'days' });
  const [dateMode, setDateMode] = useState<'single' | 'range'>('range');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [bound, setBound] = useState<{ min: number; max: number } | null>(null);
  const [boundLoading, setBoundLoading] = useState(false);
  const [boundFromQuery, setBoundFromQuery] = useState(false);

  // Echo-suppression: skip re-hydrating from our own just-emitted value.
  const lastEmitSig = useRef<string | null>(null);
  const emit = useCallback((f: ReportFilter | null) => {
    lastEmitSig.current = filterSig(f);
    onFilter(f);
  }, [onFilter]);

  const base = useCallback(
    (): Pick<ReportFilter, 'id' | 'table' | 'column'> => ({ id: filterId, table: field?.table, column }),
    [filterId, field, column],
  );

  // ── hydrate internal state from an external `value` (reload / bookmark) ───────
  const valueSig = filterSig(value ?? null);
  useEffect(() => {
    if (valueSig === lastEmitSig.current) return; // our own echo — already in sync
    const v = value ?? null;
    // categorical
    if (v && v.op === 'in') setSelected(new Set(v.values && v.values.length ? v.values : (v.value || '').split(',').map((s) => s.trim()).filter(Boolean)));
    else if (v && v.op === 'eq' && v.value != null) setSelected(new Set([v.value]));
    else setSelected(new Set());
    // numeric/date threshold + range
    if (v && v.op === 'between') {
      if (kind === 'date') { setDateFrom(v.value || ''); setDateTo(v.value2 || ''); setDateMode('range'); }
      else setRange({ lo: numOr(v.value, 0), hi: numOr(v.value2, 0) });
    }
    if (v && (v.op === 'le' || v.op === 'ge')) {
      if (kind === 'date') {
        if (v.op === 'le') { setDateTo(v.value || ''); setDateFrom(''); } else { setDateFrom(v.value || ''); setDateTo(''); }
        setDateMode('range');
      } else setSingle(numOr(v.value, 0));
    }
    if (v && v.op === 'relativeDate') {
      setRel({ dir: v.relDir || 'last', n: numOr(v.relN, 30), unit: v.relUnit || 'days' });
    }
    lastEmitSig.current = valueSig;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueSig, kind]);

  // ── fetch REAL min/max bounds for numeric Between / threshold slicers ─────────
  useEffect(() => {
    const needsBounds = kind === 'number' && (style === 'between' || style === 'before' || style === 'after');
    if (!needsBounds || !column) return;
    let cancelled = false;
    const clientExtent = numericExtent(rows, column);
    // Show the client extent immediately so the slider is usable without a wait.
    if (clientExtent) setBound((b) => b ?? clientExtent);
    if (!field?.column || !queryAdHoc) {
      if (clientExtent) setBound(clientExtent);
      return;
    }
    setBoundLoading(true);
    (async () => {
      try {
        const spec: CopilotVisualSpec = {
          type: 'card',
          wells: {
            values: [
              { table: field.table, column: field.column, aggregation: 'Min' },
              { table: field.table, column: field.column, aggregation: 'Max' },
            ],
          },
        };
        const res = await queryAdHoc(spec, []);
        if (cancelled) return;
        const nums = res.length ? Object.values(res[0]).map(Number).filter((n) => Number.isFinite(n)) : [];
        if (nums.length >= 2) { setBound({ min: Math.min(...nums), max: Math.max(...nums) }); setBoundFromQuery(true); }
        else if (clientExtent) setBound(clientExtent);
      } catch {
        if (!cancelled && clientExtent) setBound(clientExtent);
      } finally {
        if (!cancelled) setBoundLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, style, field?.table, field?.column, column, queryAdHoc, rows]);

  // Once bounds are known, seed the range / threshold thumbs (from a persisted
  // value when present, else the full data extent) — but never override a value
  // the user has already moved.
  useEffect(() => {
    if (!bound) return;
    if (style === 'between' && range === null) {
      setRange(value?.op === 'between'
        ? { lo: numOr(value.value, bound.min), hi: numOr(value.value2, bound.max) }
        : { lo: bound.min, hi: bound.max });
    }
    if ((style === 'before' || style === 'after') && single === null && kind === 'number') {
      if (style === 'before') setSingle(value?.op === 'le' ? numOr(value.value, bound.max) : bound.max);
      else setSingle(value?.op === 'ge' ? numOr(value.value, bound.min) : bound.min);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, style]);

  // ── emit helpers (each control calls one) ────────────────────────────────────

  const emitSelection = useCallback((sel: Set<string>, singleSelect: boolean) => {
    const vals = [...sel];
    if (vals.length === 0) { emit(null); return; }
    if (singleSelect && vals.length === 1) { emit({ ...base(), op: 'eq', value: vals[0] }); return; }
    emit({ ...base(), op: 'in', values: vals, value: vals.join(',') });
  }, [base, emit]);

  const emitBetween = useCallback((lo: number, hi: number) => {
    const clampLo = Math.min(lo, hi); const clampHi = Math.max(lo, hi);
    setRange({ lo: clampLo, hi: clampHi });
    if (!bound) { emit({ ...base(), op: 'between', value: String(clampLo), value2: String(clampHi) }); return; }
    const full = clampLo <= bound.min && clampHi >= bound.max;
    emit(full ? null : { ...base(), op: 'between', value: String(clampLo), value2: String(clampHi) });
  }, [bound, base, emit]);

  const emitThreshold = useCallback((op: 'le' | 'ge', v: number) => {
    setSingle(v);
    if (bound) {
      // A threshold at the very edge of the data is a no-op ⇒ clear.
      if (op === 'le' && v >= bound.max) { emit(null); return; }
      if (op === 'ge' && v <= bound.min) { emit(null); return; }
    }
    emit({ ...base(), op, value: String(v) });
  }, [bound, base, emit]);

  const emitRel = useCallback((dir: RelDir, n: number, unit: RelUnit) => {
    setRel({ dir, n, unit });
    emit(n > 0 ? { ...base(), op: 'relativeDate', relDir: dir, relN: n, relUnit: unit } : null);
  }, [base, emit]);

  const emitDate = useCallback((mode: 'single' | 'range', from: string, to: string) => {
    setDateMode(mode); setDateFrom(from); setDateTo(to);
    if (mode === 'single') { emit(from ? { ...base(), op: 'eq', value: from } : null); return; }
    if (from && to) emit({ ...base(), op: 'between', value: from, value2: to });
    else if (from) emit({ ...base(), op: 'ge', value: from });
    else if (to) emit({ ...base(), op: 'le', value: to });
    else emit(null);
  }, [base, emit]);

  // ── style change (PBI clears the selection when the slicer type changes) ──────
  const changeStyle = useCallback((next: SlicerStyle) => {
    if (next === style) return;
    setStyle(next);
    onStyleChange?.(next);
    setSelected(new Set()); setRange(null); setSingle(null);
    setDateFrom(''); setDateTo('');
    emit(null);
  }, [style, onStyleChange, emit]);

  const toggleValue = useCallback((val: string, singleSelect: boolean) => {
    const next = new Set(selected);
    if (singleSelect) { next.clear(); next.add(val); }
    else if (next.has(val)) next.delete(val);
    else next.add(val);
    setSelected(next);
    emitSelection(next, singleSelect);
  }, [selected, emitSelection]);

  const clearAll = useCallback(() => {
    setSelected(new Set());
    if (style === 'between' && bound) setRange({ lo: bound.min, hi: bound.max });
    if (style === 'before' && bound) setSingle(bound.max);
    if (style === 'after' && bound) setSingle(bound.min);
    setDateFrom(''); setDateTo('');
    emit(null);
  }, [style, bound, emit]);

  // ── render guards ────────────────────────────────────────────────────────────

  if (!field || !column) {
    return (
      <div className={styles.root} data-ff-nodrag>
        <EmptyState
          icon={<Filter20Regular />}
          title="No field bound"
          body="Drop a column into the slicer's Field well to filter the page by its values."
        />
      </div>
    );
  }

  const activeCount = selected.size;
  const hasActive = activeCount > 0
    || (style === 'between' && !!bound && !!range && (range.lo > bound.min || range.hi < bound.max))
    || ((style === 'before' || style === 'after') && (kind === 'date' ? (!!dateFrom || !!dateTo) : single != null && !!bound && (style === 'before' ? single < bound.max : single > bound.min)))
    || (style === 'relativeDate' && rel.n > 0)
    || (style === 'datePicker' && (!!dateFrom || !!dateTo));

  const visibleVals = search.trim()
    ? distinct.filter((v) => v.toLowerCase().includes(search.trim().toLowerCase()))
    : distinct;

  const kindIcon = kind === 'number' ? <NumberSymbol20Regular /> : kind === 'date' ? <Apps20Regular /> : <GridDots20Regular />;

  return (
    // data-ff-nodrag: the interactive body never starts a canvas move (the
    // FreeFormCanvas header is the drag grip) so list-scroll + slider drag work.
    <div className={styles.root} data-ff-nodrag>
      <div className={styles.header}>
        <span className={styles.headerIcon}><Filter20Regular /></span>
        <Subtitle2 className={mergeClasses(styles.grow, styles.fieldName)} title={field.column || column}>
          {title || field.column || column}
        </Subtitle2>
        {hasActive && (
          <Badge appearance="tint" color="brand" size="small">
            {activeCount > 0 ? `${activeCount} selected` : 'Filtered'}
          </Badge>
        )}
        <Tooltip content="Clear (show all)" relationship="label">
          <Button size="small" appearance="subtle" icon={<Dismiss16Regular />}
            aria-label="clear slicer" disabled={!hasActive} onClick={clearAll} />
        </Tooltip>
      </div>

      {/* Structured slicer-type chooser (PBI slicer settings → type). */}
      <div className={styles.toolbar}>
        <span className={styles.headerIcon} aria-hidden>{kindIcon}</span>
        <Dropdown size="small" style={{ minWidth: '170px' }} aria-label="slicer type"
          value={styleChoices.find((s) => s.v === style)?.label || 'List'}
          selectedOptions={[style]}
          onOptionSelect={(_e, d) => changeStyle((d.optionValue as SlicerStyle) || 'list')}>
          {styleChoices.map((s) => <Option key={s.v} value={s.v} text={s.label}>{s.label}</Option>)}
        </Dropdown>
        {style === 'dropdown' && (
          <Switch checked={dropdownMulti} label="Multi-select"
            onChange={(_e, d) => { setDropdownMulti(d.checked); setSelected(new Set()); emit(null); }} />
        )}
        {style === 'datePicker' && (
          <Switch checked={dateMode === 'range'} label={dateMode === 'range' ? 'Range' : 'Single date'}
            onChange={(_e, d) => emitDate(d.checked ? 'range' : 'single', dateFrom, dateTo)} />
        )}
      </div>

      <Divider />

      {/* ── List ─────────────────────────────────────────────────────────────── */}
      {style === 'list' && (
        <>
          {distinct.length > 8 && (
            <SearchBox size="small" placeholder="Search values…" value={search}
              aria-label="search slicer values"
              onChange={(_e, d) => setSearch(d.value || '')} />
          )}
          {visibleVals.length === 0 ? (
            <Caption1 className={styles.muted}>{distinct.length === 0 ? 'No values returned.' : 'No values match the search.'}</Caption1>
          ) : (
            <div className={styles.list}>
              {visibleVals.map((v) => (
                <label key={v} className={styles.listRow}>
                  <Checkbox checked={selected.has(v)} onChange={() => toggleValue(v, false)} aria-label={v} />
                  <Caption1 className={styles.listLabel} title={v}>{v}</Caption1>
                </label>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Dropdown ─────────────────────────────────────────────────────────── */}
      {style === 'dropdown' && (
        distinct.length === 0 ? (
          <Caption1 className={styles.muted}>No values returned.</Caption1>
        ) : dropdownMulti ? (
          <Dropdown multiselect placeholder="(All)" aria-label={`slicer ${column}`}
            value={[...selected].join(', ')} selectedOptions={[...selected]}
            onOptionSelect={(_e, d) => {
              const next = new Set((d.selectedOptions || []).filter((x) => x && x !== '__all__'));
              setSelected(next); emitSelection(next, false);
            }}>
            {distinct.map((v) => <Option key={v} value={v} text={v}>{v}</Option>)}
          </Dropdown>
        ) : (
          <Dropdown placeholder="(All)" aria-label={`slicer ${column}`}
            value={[...selected][0] || ''} selectedOptions={[...selected].slice(0, 1)}
            onOptionSelect={(_e, d) => {
              const v = String(d.optionValue ?? '');
              const next = (v === '__all__' || v === '') ? new Set<string>() : new Set([v]);
              setSelected(next); emitSelection(next, true);
            }}>
            <Option value="__all__" text="(All)">(All)</Option>
            {distinct.map((v) => <Option key={v} value={v} text={v}>{v}</Option>)}
          </Dropdown>
        )
      )}

      {/* ── Tile (chiclet) ───────────────────────────────────────────────────── */}
      {style === 'tile' && (
        distinct.length === 0 ? (
          <Caption1 className={styles.muted}>No values returned.</Caption1>
        ) : (
          <div className={styles.tiles}>
            {distinct.map((v) => {
              const on = selected.has(v);
              return (
                <ToggleButton key={v} size="small" appearance="subtle" checked={on}
                  className={mergeClasses(styles.tile, on && styles.tileChecked)}
                  icon={on ? <Checkmark16Regular /> : undefined}
                  onClick={() => toggleValue(v, false)}>
                  {v}
                </ToggleButton>
              );
            })}
          </div>
        )
      )}

      {/* ── Between (numeric range slider, REAL min/max bounds) ───────────────── */}
      {style === 'between' && (
        <div className={styles.rangeBlock}>
          {boundLoading && !bound && <span className={styles.gateNote}><Spinner size="tiny" /> <Caption1 className={styles.muted}>Loading range…</Caption1></span>}
          {bound && range && (
            <>
              <div className={styles.rangeRow}>
                <Caption1 className={styles.rangeLabel}>From</Caption1>
                <Slider className={styles.slider} min={bound.min} max={bound.max} step={sliderStep(bound.max - bound.min)}
                  value={range.lo} aria-label="range minimum"
                  onChange={(_e, d) => emitBetween(d.value, range.hi)} />
                <Input className={styles.numInput} size="small" type="number" value={String(range.lo)} aria-label="range minimum value"
                  onChange={(_e, d) => emitBetween(numOr(d.value, bound.min), range.hi)} />
              </div>
              <div className={styles.rangeRow}>
                <Caption1 className={styles.rangeLabel}>To</Caption1>
                <Slider className={styles.slider} min={bound.min} max={bound.max} step={sliderStep(bound.max - bound.min)}
                  value={range.hi} aria-label="range maximum"
                  onChange={(_e, d) => emitBetween(range.lo, d.value)} />
                <Input className={styles.numInput} size="small" type="number" value={String(range.hi)} aria-label="range maximum value"
                  onChange={(_e, d) => emitBetween(range.lo, numOr(d.value, bound.max))} />
              </div>
              <Caption1 className={styles.bounds}>
                Data range {bound.min} – {bound.max}{boundFromQuery ? ' · SELECT MIN/MAX' : ' · from loaded rows'}
              </Caption1>
            </>
          )}
          {!bound && !boundLoading && <Caption1 className={styles.muted}>No numeric values to range over.</Caption1>}
        </div>
      )}

      {/* ── Before / After threshold ─────────────────────────────────────────── */}
      {(style === 'before' || style === 'after') && (
        kind === 'date' ? (
          <div className={styles.rangeRow}>
            <Caption1 className={styles.rangeLabel}>{style === 'before' ? 'On/before' : 'On/after'}</Caption1>
            <Input className={styles.dateInput} size="small" type="date"
              aria-label={style === 'before' ? 'on or before date' : 'on or after date'}
              value={style === 'before' ? dateTo : dateFrom}
              onChange={(_e, d) => {
                const v = d.value;
                if (style === 'before') { setDateTo(v); emit(v ? { ...base(), op: 'le', value: v } : null); }
                else { setDateFrom(v); emit(v ? { ...base(), op: 'ge', value: v } : null); }
              }} />
          </div>
        ) : (
          <div className={styles.rangeBlock}>
            {boundLoading && !bound && <span className={styles.gateNote}><Spinner size="tiny" /> <Caption1 className={styles.muted}>Loading range…</Caption1></span>}
            {bound && single != null && (
              <>
                <div className={styles.rangeRow}>
                  <Caption1 className={styles.rangeLabel}>{style === 'before' ? '≤' : '≥'}</Caption1>
                  <Slider className={styles.slider} min={bound.min} max={bound.max} step={sliderStep(bound.max - bound.min)}
                    value={single} aria-label="threshold"
                    onChange={(_e, d) => emitThreshold(style === 'before' ? 'le' : 'ge', d.value)} />
                  <Input className={styles.numInput} size="small" type="number" value={String(single)} aria-label="threshold value"
                    onChange={(_e, d) => emitThreshold(style === 'before' ? 'le' : 'ge', numOr(d.value, single))} />
                </div>
                <Caption1 className={styles.bounds}>
                  Data range {bound.min} – {bound.max}{boundFromQuery ? ' · SELECT MIN/MAX' : ' · from loaded rows'}
                </Caption1>
              </>
            )}
            {!bound && !boundLoading && <Caption1 className={styles.muted}>No numeric values to threshold.</Caption1>}
          </div>
        )
      )}

      {/* ── Relative date ────────────────────────────────────────────────────── */}
      {style === 'relativeDate' && (
        <div className={styles.relRow}>
          <Dropdown size="small" style={{ minWidth: '84px' }} aria-label="relative direction"
            value={rel.dir === 'next' ? 'Next' : 'Last'} selectedOptions={[rel.dir]}
            onOptionSelect={(_e, d) => emitRel((d.optionValue as RelDir) || 'last', rel.n, rel.unit)}>
            <Option value="last" text="Last">Last</Option>
            <Option value="next" text="Next">Next</Option>
          </Dropdown>
          <Input size="small" type="number" min={1} style={{ width: '72px' }} aria-label="relative date count"
            value={rel.n ? String(rel.n) : ''}
            onChange={(_e, d) => emitRel(rel.dir, Math.max(0, Math.floor(numOr(d.value, 0))), rel.unit)} />
          <Dropdown size="small" style={{ minWidth: '104px' }} aria-label="relative date unit"
            value={rel.unit} selectedOptions={[rel.unit]}
            onOptionSelect={(_e, d) => emitRel(rel.dir, rel.n, (d.optionValue as RelUnit) || 'days')}>
            <Option value="days" text="days">days</Option>
            <Option value="months" text="months">months</Option>
            <Option value="years" text="years">years</Option>
          </Dropdown>
        </div>
      )}

      {/* ── Date picker (single / range) ─────────────────────────────────────── */}
      {style === 'datePicker' && (
        dateMode === 'single' ? (
          <div className={styles.rangeRow}>
            <Caption1 className={styles.rangeLabel}>On</Caption1>
            <Input className={styles.dateInput} size="small" type="date" aria-label="slicer date"
              value={dateFrom} onChange={(_e, d) => emitDate('single', d.value, '')} />
          </div>
        ) : (
          <div className={styles.rangeBlock}>
            <div className={styles.rangeRow}>
              <Caption1 className={styles.rangeLabel}>From</Caption1>
              <Input className={styles.dateInput} size="small" type="date" aria-label="slicer start date"
                value={dateFrom} onChange={(_e, d) => emitDate('range', d.value, dateTo)} />
            </div>
            <div className={styles.rangeRow}>
              <Caption1 className={styles.rangeLabel}>To</Caption1>
              <Input className={styles.dateInput} size="small" type="date" aria-label="slicer end date"
                value={dateTo} onChange={(_e, d) => emitDate('range', dateFrom, d.value)} />
            </div>
          </div>
        )
      )}
    </div>
  );
}

export default SlicerVisual;
