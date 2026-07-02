'use client';

/**
 * key-influencers — the Power BI "Key influencers" AI visual for the Loom-native
 * Report Designer (report-designer wave 3, the "AI" gallery section).
 *
 * Power BI parity (ui-parity.md):
 * learn.microsoft.com/power-bi/visuals/power-bi-visualization-influencers — the
 * Key influencers visual ranks the factors that most affect a chosen metric. The
 * left pane is a ranked list of influencers ("When <field> is <value>, <metric>
 * is N× more likely / N× higher"); selecting one shows, on the right, the
 * distribution of that field's categories with the selected category highlighted
 * and an AVERAGE reference line. A "Top segments" tab summarizes the highest-value
 * category combinations. This file is the one-for-one Loom build of that surface,
 * Azure-native by construction:
 *
 *   • {@link KeyInfluencers} takes structured wells — **Analyze** (one measure /
 *     category) + **Explain by** (N fields). For EACH explain-by field it issues a
 *     REAL `queryAdHoc({ category:[field], values:[analyze] })` — the host's shared
 *     Path-3 wells→SQL `/query` helper over the bound Loom semantic model (the SAME
 *     helper the designer + Q&A use). No new backend route, no mock aggregation.
 *   • From the REAL per-category aggregates it client-computes each category's value,
 *     the overall average (mean across that field's categories), and the relative
 *     lift `value / overall-average` (Learn "relative contribution" semantics),
 *     flattens those to influencer factors, and ranks them descending.
 *   • The left pane is the ranked, selectable influencer list; the right pane draws
 *     the selected field's category distribution with {@link LoomChart} (a real
 *     column chart over the real aggregates) + a dashed AVERAGE reference line, the
 *     selected category called out + highlighted. A "Top segments" tab ranks the
 *     highest-lift category COMBINATIONS, estimated from the same real aggregates.
 *   • An optional one-line Azure OpenAI "why" per selected factor via the host's
 *     {@link KeyInfluencersProps.aiWhy} (the report Copilot's orchestrator) — when
 *     absent the surface is fully functional without it (no dead UI).
 *
 * Rules compliance:
 *  - no-vaporware.md: every ranked number is a REAL `/query` SQL aggregate — never a
 *    mock. The UI copy states HONESTLY that this is a correlation / contribution
 *    ranking over real SQL aggregation (relative lift per category), NOT a fitted
 *    machine-learning model. When Analyze + Explain-by span more than one table the
 *    loom-native `/query` returns its honest `code:'multi-table'` 400 — surfaced
 *    here verbatim in a Fluent warning gate. Refresh re-issues real queries; no dead
 *    buttons.
 *  - no-freeform-config.md: the wells are STRUCTURED (host-built field pickers); the
 *    only inputs here are selecting a factor / category — no raw JSON or DAX box.
 *  - no-fabric-dependency.md: Azure-native by construction — Synapse `/query`
 *    (+ optional AOAI for the one-line "why"). Nothing reaches api.fabric.microsoft.com
 *    / api.powerbi.com; the visual self-queries the bound Loom model.
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens only (no hard-coded px/hex); a
 *    card with elevation + a Sparkle/DataTrending accent header + a Fluent TabList,
 *    matching the sibling smart-narrative / qa / report-powerbi-copilot surfaces.
 *
 * The well shape reuses the canonical designer {@link WellField} (from ../personalize)
 * and the visual spec contract ({@link CopilotVisualSpec}) the Copilot pane OWNS, so
 * the host wires its existing shared `queryAdHoc` straight in with zero adapters.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Subtitle2, Body1, Caption1, Spinner, Button, Tooltip, Badge, Divider,
  TabList, Tab,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Sparkle20Regular, DataTrending20Regular, Filter20Regular, ArrowClockwise16Regular,
  Lightbulb16Regular, DataBarVertical20Regular, Star16Filled,
} from '@fluentui/react-icons';
import { LoomChart } from '@/lib/components/charts/loom-chart';
import type { ChartReferenceLine } from '@/lib/components/charts/loom-chart';
import type { CopilotVisualSpec, CopilotWellField } from '@/lib/components/report/report-powerbi-copilot';
import type { WellField } from '../personalize';

// ── Props ─────────────────────────────────────────────────────────────────────

/**
 * One ranked influencer factor — a single category of one Explain-by field, with
 * its REAL aggregated `value`, the field's overall average, and the relative
 * `lift` (`value / overallAverage`). Exposed so the host's `aiWhy` can phrase a
 * one-line explanation from the same numbers the list shows.
 */
export interface KeyInfluencerFactor {
  /** Stable key — `${fieldKey}::${category}`. */
  key: string;
  /** Display label of the Explain-by field (its column name). */
  field: string;
  /** `${table}.${column}` identity of the Explain-by field. */
  fieldKey: string;
  /** The category value this factor describes. */
  category: string;
  /** The Analyze measure's REAL aggregate for this category. */
  value: number;
  /** The field's overall average (mean across its categories). */
  overallAverage: number;
  /** `value / overallAverage` — the relative contribution / lift. */
  lift: number;
}

export interface KeyInfluencersProps {
  /**
   * Structured wells — {@link KeyInfluencersProps.wells.analyze} is the measure /
   * category being analyzed (the host passes a single-field array), and
   * {@link KeyInfluencersProps.wells.explainBy} is the list of fields to test as
   * influencers. Built by the designer's field pickers (no-freeform-config.md).
   */
  wells: { analyze: WellField[]; explainBy: WellField[] };
  /**
   * Run a structured visual spec against the REAL `/query` backend and return its
   * aggregated rows — the host's shared Path-3 wells→SQL helper (the same one the
   * designer + Q&A use). May reject with the route's honest error (e.g.
   * `code:'multi-table'`), which this surface displays verbatim.
   */
  queryAdHoc: (spec: CopilotVisualSpec) => Promise<Array<Record<string, unknown>>>;
  /**
   * Optional — ask Azure OpenAI for a one-line, plain-language "why" for a top
   * factor (the report Copilot orchestrator). Omitted ⇒ the visual is fully
   * functional without it. Rejecting / returning empty simply hides the line.
   */
  aiWhy?: (factor: KeyInfluencerFactor) => Promise<string>;
}

// ── well coercion (designer WellField → Copilot spec wells) ───────────────────

/** Narrow a free-form aggregation string to the spec's union (undefined if unknown). */
function coerceAgg(a?: string): CopilotWellField['aggregation'] | undefined {
  return (['Sum', 'Avg', 'Count', 'Min', 'Max'] as const)
    .find((x) => x.toLowerCase() === String(a || '').toLowerCase());
}

/** `${table}.${column|measure}` identity for a field (dedupe + selection keys). */
function fieldIdentity(f: WellField): string {
  return `${f.table || ''}.${f.column || f.measure || ''}`;
}

/** Human label for the Analyze field (measure name, or "Agg of Column"). */
function analyzeLabel(a: WellField): string {
  if (a.measure) return a.measure;
  if (a.column) return a.aggregation ? `${a.aggregation} of ${a.column}` : a.column;
  return 'value';
}

/** The Analyze field as a spec VALUE well (measure, or aggregated column → Count). */
function analyzeValueWell(a: WellField): CopilotWellField | null {
  if (a.measure) return { ...(a.table ? { table: a.table } : {}), measure: a.measure };
  if (a.column) {
    return {
      ...(a.table ? { table: a.table } : {}),
      column: a.column,
      // A bare category column is analyzed as a frequency ("N× more likely").
      aggregation: coerceAgg(a.aggregation) ?? 'Count',
    };
  }
  return null;
}

/** The Explain-by field as a spec CATEGORY well (must be a column to GROUP BY). */
function categoryWell(f: WellField): CopilotWellField | null {
  if (!f.column) return null;
  return { ...(f.table ? { table: f.table } : {}), column: f.column };
}

// ── parsing the REAL `/query` rows ────────────────────────────────────────────

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return NaN;
}

/** Pick the category (first non-numeric) + value (first numeric) keys from rows. */
function pickKeys(rows: Array<Record<string, unknown>>): { catKey: string; valKey: string } | null {
  if (!rows.length || !rows[0] || typeof rows[0] !== 'object') return null;
  const keys = Object.keys(rows[0]);
  if (keys.length === 0) return null;
  const valKey = keys.find((k) => rows.some((r) => Number.isFinite(toNum(r[k])))) ?? keys[keys.length - 1];
  const catKey = keys.find((k) => k !== valKey) ?? keys[0];
  return { catKey, valKey };
}

interface CategoryAgg { category: string; value: number }
interface FieldResult {
  field: WellField;
  fieldKey: string;
  label: string;
  /** Per-category aggregates, sorted by value descending. */
  cats: CategoryAgg[];
  overallAverage: number;
  /** Honest backend error for this field (e.g. multi-table), if any. */
  error?: string;
  /** True when the field's query gated on the loom-native single-table limit. */
  gated?: boolean;
}

const MULTI_TABLE_RE = /multi-?table|multiple tables|single (model )?table|one table/i;

// ── number / lift formatting ──────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Compact lift badge, e.g. 2.4× / 12× / 0.3×. */
function liftLabel(lift: number): string {
  if (!Number.isFinite(lift)) return '—';
  return `${lift >= 10 ? Math.round(lift) : Number(lift.toFixed(1))}×`;
}

/** Signed "% vs average" for a factor caption, e.g. +140% / −35%. */
function deltaLabel(lift: number): string {
  if (!Number.isFinite(lift)) return '';
  const pct = Math.round((lift - 1) * 100);
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct)}% vs average`;
}

// ── styles (Loom tokens only) ─────────────────────────────────────────────────

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    height: '100%',
    minHeight: 0,
    boxSizing: 'border-box',
    padding: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexShrink: 0 },
  headTitle: { flexGrow: 1, minWidth: 0 },
  tabs: { flexShrink: 0 },
  body: { display: 'flex', flexDirection: 'column', minHeight: 0, flexGrow: 1, gap: tokens.spacingVerticalS },
  // influencers tab: left ranked list | right distribution
  split: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 5fr) minmax(0, 7fr)',
    gap: tokens.spacingHorizontalM,
    minHeight: 0,
    flexGrow: 1,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: tokens.spacingHorizontalXXS,
  },
  factor: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    width: '100%',
    textAlign: 'left',
    padding: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    minWidth: 0,
  },
  factorSel: {
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke1}`,
  },
  factorText: { flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' },
  factorTitle: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  factorSub: { color: tokens.colorNeutralForeground3 },
  rank: {
    flexShrink: 0,
    minWidth: '20px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: 'tabular-nums',
  },
  detail: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    minHeight: 0,
    minWidth: 0,
    overflow: 'auto',
  },
  detailHead: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  detailTitle: { flexGrow: 1, minWidth: 0 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, alignItems: 'center' },
  chip: {
    cursor: 'pointer',
    maxWidth: '160px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  why: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
  },
  whyIcon: { color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: '2px' },
  // segments tab
  segments: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minHeight: 0, overflowY: 'auto' },
  segment: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  segText: { flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' },
  star: { color: tokens.colorPaletteMarigoldForeground1, flexShrink: 0 },
  loading: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
    paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS,
  },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingVerticalXS, textAlign: 'center', color: tokens.colorNeutralForeground3,
    flexGrow: 1, paddingTop: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalL,
  },
  emptyIcon: { color: tokens.colorBrandForeground2 },
  foot: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
});

type Styles = ReturnType<typeof useStyles>;

// ── derive ranked factors + segments from the field results ───────────────────

function buildFactors(results: FieldResult[]): KeyInfluencerFactor[] {
  const out: KeyInfluencerFactor[] = [];
  for (const fr of results) {
    if (fr.error || !(fr.overallAverage > 0)) continue;
    for (const c of fr.cats) {
      const lift = c.value / fr.overallAverage;
      if (!Number.isFinite(lift)) continue;
      out.push({
        key: `${fr.fieldKey}::${c.category}`,
        field: fr.label,
        fieldKey: fr.fieldKey,
        category: c.category,
        value: c.value,
        overallAverage: fr.overallAverage,
        lift,
      });
    }
  }
  out.sort((a, b) => b.lift - a.lift);
  return out.slice(0, 60);
}

interface Segment { conditions: Array<{ field: string; category: string }>; lift: number }

/**
 * "Top segments" — the highest-value category COMBINATIONS, estimated from the
 * same REAL per-field aggregates. With a single field these are single-condition
 * segments (its top categories). With several fields we combine each field's
 * top-2 categories and estimate the combined lift as the PRODUCT of the per-field
 * lifts (an explicit independent-contribution assumption, surfaced honestly in
 * the footnote — derived from real SQL aggregates, not a fitted model).
 */
function buildSegments(results: FieldResult[]): Segment[] {
  const usable = results
    .filter((fr) => !fr.error && fr.overallAverage > 0 && fr.cats.length > 0)
    .slice(0, 3);
  if (usable.length === 0) return [];

  // Top-2 categories per field, as single-field conditions with their lift.
  const perField = usable.map((fr) => fr.cats.slice(0, 2).map((c) => ({
    field: fr.label,
    category: c.category,
    lift: c.value / fr.overallAverage,
  })));

  if (perField.length === 1) {
    return perField[0]
      .map((c) => ({ conditions: [{ field: c.field, category: c.category }], lift: c.lift }))
      .sort((a, b) => b.lift - a.lift)
      .slice(0, 6);
  }

  // Cartesian product across fields → combined segments (bounded ≤ 2^3 = 8).
  let combos: Array<Array<{ field: string; category: string; lift: number }>> = [[]];
  for (const opts of perField) {
    const next: typeof combos = [];
    for (const combo of combos) for (const o of opts) next.push([...combo, o]);
    combos = next;
  }
  return combos
    .map((combo) => ({
      conditions: combo.map((c) => ({ field: c.field, category: c.category })),
      lift: combo.reduce((p, c) => p * c.lift, 1),
    }))
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 6);
}

// ── distribution detail (right pane) ──────────────────────────────────────────

/**
 * The selected factor's field distribution: a REAL LoomChart column chart over the
 * field's per-category aggregates + a dashed AVERAGE reference line, with the
 * selected category highlighted (callout + clickable chip strip to reselect).
 */
function FactorDetail({ result, selectedCategory, analyzeName, onPickCategory, why, whyLoading, styles }: {
  result: FieldResult;
  selectedCategory: string;
  analyzeName: string;
  onPickCategory: (category: string) => void;
  why?: string;
  whyLoading?: boolean;
  styles: Styles;
}): ReactElement {
  // Keep the chart readable: top categories by value, but always include the
  // selected one so its highlight is visible.
  const shown = useMemo(() => {
    const top = result.cats.slice(0, 24);
    if (!top.some((c) => c.category === selectedCategory)) {
      const sel = result.cats.find((c) => c.category === selectedCategory);
      if (sel) return [sel, ...top].slice(0, 25);
    }
    return top;
  }, [result.cats, selectedCategory]);

  const labelCol = result.label;
  const valueCol = labelCol === analyzeName ? `${analyzeName} ` : analyzeName;
  const chartRows = useMemo(
    () => shown.map((c) => ({ [labelCol]: c.category, [valueCol]: c.value })),
    [shown, labelCol, valueCol],
  );

  const refLines: ChartReferenceLine[] = Number.isFinite(result.overallAverage)
    ? [{
        id: 'avg',
        y: result.overallAverage,
        color: tokens.colorPaletteMarigoldForeground1,
        style: 'dashed',
        label: `Avg ${fmtNum(result.overallAverage)}`,
      }]
    : [];

  const sel = result.cats.find((c) => c.category === selectedCategory);
  const selLift = sel && result.overallAverage > 0 ? sel.value / result.overallAverage : NaN;

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <Subtitle2 className={styles.detailTitle}>{result.label}</Subtitle2>
        {sel && (
          <Badge appearance="tint" color="brand" size="small">
            {selectedCategory}: {fmtNum(sel.value)} · {liftLabel(selLift)}
          </Badge>
        )}
      </div>

      {sel && (
        <Caption1>
          When <strong>{result.label}</strong> is <strong>“{selectedCategory}”</strong>, {analyzeName} is{' '}
          <strong>{liftLabel(selLift)}</strong> the average ({deltaLabel(selLift)}).
        </Caption1>
      )}

      <LoomChart type="column" rows={chartRows} height={200} refLines={refLines} />

      {/* Clickable category strip — the highlighted (selected) chip is brand-filled. */}
      <div className={styles.chips} role="listbox" aria-label={`${result.label} categories`}>
        {shown.map((c) => {
          const isSel = c.category === selectedCategory;
          return (
            <Badge
              key={c.category}
              className={styles.chip}
              appearance={isSel ? 'filled' : 'outline'}
              color={isSel ? 'brand' : 'informative'}
              role="option"
              aria-selected={isSel}
              onClick={() => onPickCategory(c.category)}
              title={`${c.category}: ${fmtNum(c.value)}`}
            >
              {c.category}
            </Badge>
          );
        })}
      </div>

      {(why || whyLoading) && (
        <div className={styles.why}>
          <Lightbulb16Regular className={styles.whyIcon} aria-hidden />
          {whyLoading ? <Caption1>Asking Azure OpenAI for context…</Caption1> : <Caption1>{why}</Caption1>}
        </div>
      )}
    </div>
  );
}

// ── component ─────────────────────────────────────────────────────────────────

/**
 * Key influencers — ranks the Explain-by factors that most move the Analyze
 * metric, computed as each category's relative lift over REAL `/query` SQL
 * aggregates. Honest correlation/contribution ranking (not ML). Honest
 * multi-table gate when Analyze + Explain-by span more than one model table.
 */
export function KeyInfluencers(props: KeyInfluencersProps): ReactElement {
  const { wells, queryAdHoc, aiWhy } = props;
  const styles = useStyles();

  const analyze = wells?.analyze?.[0];
  const explainBy = useMemo(
    () => (wells?.explainBy || []).filter((f) => !!f.column),
    [wells?.explainBy],
  );
  const analyzeName = useMemo(() => (analyze ? analyzeLabel(analyze) : 'value'), [analyze]);

  // A signature of the wells — re-run only when the actual fields change.
  const signature = useMemo(() => JSON.stringify({
    a: analyze ? fieldIdentity(analyze) + '|' + (analyze.aggregation || '') : '',
    e: explainBy.map(fieldIdentity),
  }), [analyze, explainBy]);

  const hasWells = !!analyze && explainBy.length > 0;

  const [results, setResults] = useState<FieldResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'influencers' | 'segments'>('influencers');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0); // manual Refresh

  const runRef = useRef(0);

  // Run one REAL `/query` GROUP-BY per Explain-by field and aggregate the results.
  useEffect(() => {
    if (!hasWells) {
      setResults([]); setGate(null); setError(null); setLoading(false);
      return;
    }
    const valueWell = analyze ? analyzeValueWell(analyze) : null;
    if (!valueWell) {
      setResults([]); setError('The Analyze field must be a measure or an aggregatable column.');
      return;
    }
    const run = runRef.current + 1;
    runRef.current = run;
    setLoading(true);
    setGate(null);
    setError(null);

    (async () => {
      const settled = await Promise.all(explainBy.map(async (field): Promise<FieldResult> => {
        const fieldKey = fieldIdentity(field);
        const label = field.column || field.measure || 'Field';
        const catWell = categoryWell(field);
        if (!catWell) return { field, fieldKey, label, cats: [], overallAverage: NaN, error: 'Not a groupable column.' };
        const spec: CopilotVisualSpec = {
          type: 'bar',
          title: `${analyzeName} by ${label}`,
          wells: { category: [catWell], values: [valueWell] },
        };
        try {
          const rows = await queryAdHoc(spec);
          const keys = pickKeys(rows);
          if (!keys) return { field, fieldKey, label, cats: [], overallAverage: NaN };
          const cats: CategoryAgg[] = rows
            .map((r) => ({ category: String(r[keys.catKey] ?? '—'), value: toNum(r[keys.valKey]) }))
            .filter((c) => Number.isFinite(c.value));
          cats.sort((a, b) => b.value - a.value);
          const overallAverage = cats.length
            ? cats.reduce((s, c) => s + c.value, 0) / cats.length
            : NaN;
          return { field, fieldKey, label, cats, overallAverage };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { field, fieldKey, label, cats: [], overallAverage: NaN, error: msg, gated: MULTI_TABLE_RE.test(msg) };
        }
      }));
      if (runRef.current !== run) return;

      setResults(settled);
      const ok = settled.filter((r) => !r.error && r.cats.length > 0);
      if (ok.length === 0) {
        const gatedOne = settled.find((r) => r.gated);
        if (gatedOne) {
          setGate(gatedOne.error || 'Analyze and Explain by must come from the same model table.');
        } else {
          const errOne = settled.find((r) => r.error);
          setError(errOne?.error || 'No data returned for the selected fields.');
        }
      }
      setLoading(false);
    })();

    return () => { runRef.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, nonce, hasWells]);

  const factors = useMemo(() => buildFactors(results), [results]);
  const segments = useMemo(() => buildSegments(results), [results]);
  const resultByKey = useMemo(() => {
    const m = new Map<string, FieldResult>();
    for (const r of results) m.set(r.fieldKey, r);
    return m;
  }, [results]);

  // Keep a valid selection: default to the top factor when the list changes.
  useEffect(() => {
    if (factors.length === 0) { setSelectedKey(null); return; }
    if (!selectedKey || !factors.some((f) => f.key === selectedKey)) {
      setSelectedKey(factors[0].key);
    }
  }, [factors, selectedKey]);

  const selectedFactor = useMemo(
    () => factors.find((f) => f.key === selectedKey) || null,
    [factors, selectedKey],
  );
  const selectedResult = selectedFactor ? resultByKey.get(selectedFactor.fieldKey) || null : null;

  // Optional one-line AOAI "why" for the selected factor (cached by factor key).
  const [whyCache, setWhyCache] = useState<Record<string, string>>({});
  const [whyLoading, setWhyLoading] = useState(false);
  const whyRunRef = useRef(0);
  useEffect(() => {
    if (!aiWhy || !selectedFactor) return;
    if (whyCache[selectedFactor.key] !== undefined) return;
    const run = whyRunRef.current + 1;
    whyRunRef.current = run;
    setWhyLoading(true);
    (async () => {
      try {
        const text = await aiWhy(selectedFactor);
        if (whyRunRef.current !== run) return;
        if (text && text.trim()) setWhyCache((c) => ({ ...c, [selectedFactor.key]: text.trim() }));
      } catch {
        /* a missing "why" is non-fatal — the ranking stands on its own. */
      } finally {
        if (whyRunRef.current === run) setWhyLoading(false);
      }
    })();
  }, [aiWhy, selectedFactor, whyCache]);

  const pickCategory = useCallback((fieldKey: string, category: string) => {
    setSelectedKey(`${fieldKey}::${category}`);
  }, []);

  return (
    <section className={styles.card} aria-label="Key influencers">
      <div className={styles.head}>
        <DataTrending20Regular style={{ color: tokens.colorBrandForeground1 }} aria-hidden />
        <Subtitle2 className={styles.headTitle}>Key influencers</Subtitle2>
        {loading && <Spinner size="tiny" aria-label="Computing influencers" />}
        <Tooltip content="Recompute from the latest data" relationship="label">
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowClockwise16Regular />}
            disabled={loading || !hasWells}
            onClick={() => setNonce((n) => n + 1)}
            aria-label="Refresh key influencers"
          >
            Refresh
          </Button>
        </Tooltip>
      </div>

      {hasWells && (
        <TabList
          className={styles.tabs}
          selectedValue={tab}
          onTabSelect={(_e, d) => setTab(d.value === 'segments' ? 'segments' : 'influencers')}
          size="small"
        >
          <Tab value="influencers" icon={<DataTrending20Regular />}>Key influencers</Tab>
          <Tab value="segments" icon={<Filter20Regular />}>Top segments</Tab>
        </TabList>
      )}

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Single-table analysis only</MessageBarTitle>
            {gate} — Key influencers runs over one Loom semantic-model table; pick an Analyze
            measure and Explain-by fields from the same table.
          </MessageBarBody>
        </MessageBar>
      )}

      {!gate && error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Couldn’t compute influencers</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {!hasWells ? (
        <div className={styles.empty}>
          <DataBarVertical20Regular className={styles.emptyIcon} aria-hidden />
          <Body1>Pick what to analyze and explain by</Body1>
          <Caption1>
            Add a measure to <strong>Analyze</strong> and one or more fields to{' '}
            <strong>Explain by</strong>. Key influencers ranks each field’s categories by their
            relative contribution to the metric, computed over your model’s real query results.
          </Caption1>
        </div>
      ) : (
        <div className={styles.body}>
          {loading && factors.length === 0 && (
            <div className={styles.loading}>
              <Spinner size="tiny" />
              <Caption1>Querying your model and ranking contributions…</Caption1>
            </div>
          )}

          {!loading && !gate && !error && factors.length === 0 && (
            <div className={styles.empty}>
              <DataBarVertical20Regular className={styles.emptyIcon} aria-hidden />
              <Body1>No influencers to rank yet</Body1>
              <Caption1>The selected fields returned no comparable categories.</Caption1>
            </div>
          )}

          {factors.length > 0 && tab === 'influencers' && (
            <div className={styles.split}>
              {/* Left — ranked, selectable influencer list. */}
              <div className={styles.list} role="listbox" aria-label="Ranked influencers">
                {factors.slice(0, 40).map((f, i) => {
                  const isSel = f.key === selectedKey;
                  return (
                    <div
                      key={f.key}
                      className={`${styles.factor}${isSel ? ` ${styles.factorSel}` : ''}`}
                      role="option"
                      aria-selected={isSel}
                      tabIndex={0}
                      onClick={() => setSelectedKey(f.key)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedKey(f.key); } }}
                    >
                      <Caption1 className={styles.rank}>{i + 1}</Caption1>
                      <div className={styles.factorText}>
                        <Body1 className={styles.factorTitle}>
                          {f.field} is “{f.category}”
                        </Body1>
                        <Caption1 className={styles.factorSub}>
                          {fmtNum(f.value)} · {deltaLabel(f.lift)}
                        </Caption1>
                      </div>
                      <Badge appearance="tint" color={f.lift >= 1 ? 'brand' : 'informative'} size="small">
                        {liftLabel(f.lift)}
                      </Badge>
                    </div>
                  );
                })}
              </div>

              {/* Right — selected field's distribution + average line + highlight. */}
              {selectedFactor && selectedResult ? (
                <FactorDetail
                  result={selectedResult}
                  selectedCategory={selectedFactor.category}
                  analyzeName={analyzeName}
                  onPickCategory={(c) => pickCategory(selectedFactor.fieldKey, c)}
                  why={whyCache[selectedFactor.key]}
                  whyLoading={whyLoading && whyCache[selectedFactor.key] === undefined}
                  styles={styles}
                />
              ) : (
                <div className={styles.empty}>
                  <Caption1>Select an influencer to see its distribution.</Caption1>
                </div>
              )}
            </div>
          )}

          {factors.length > 0 && tab === 'segments' && (
            <div className={styles.segments} aria-label="Top segments">
              {segments.length === 0 ? (
                <Caption1 className={styles.foot}>No segments could be formed from the current fields.</Caption1>
              ) : (
                segments.map((seg, i) => (
                  <div key={i} className={styles.segment}>
                    <Star16Filled className={styles.star} aria-hidden />
                    <div className={styles.segText}>
                      <Body1>
                        {seg.conditions.map((c, j) => (
                          <span key={j}>
                            {j > 0 ? ' and ' : ''}
                            {c.field} is “{c.category}”
                          </span>
                        ))}
                      </Body1>
                      <Caption1 className={styles.factorSub}>
                        {seg.conditions.length > 1 ? 'Estimated combined ' : ''}
                        {liftLabel(seg.lift)} the average {analyzeName}
                      </Caption1>
                    </div>
                    <Badge appearance="tint" color="brand" size="small">{liftLabel(seg.lift)}</Badge>
                  </div>
                ))
              )}
              {segments.some((s) => s.conditions.length > 1) && (
                <Caption1 className={styles.foot}>
                  Combined lift is estimated from each factor’s real per-category aggregate, assuming
                  the factors contribute independently — a contribution estimate, not a fitted model.
                </Caption1>
              )}
            </div>
          )}
        </div>
      )}

      {hasWells && factors.length > 0 && (
        <Caption1 className={styles.foot}>
          Ranked by relative contribution — each category’s value vs the average category — over your
          model’s live <code>/query</code> SQL aggregates. A correlation/contribution ranking, not a
          machine-learning model.
        </Caption1>
      )}
    </section>
  );
}

export default KeyInfluencers;
