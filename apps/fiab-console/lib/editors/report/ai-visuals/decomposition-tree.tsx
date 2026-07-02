'use client';

/**
 * decomposition-tree — the Power BI "Decomposition tree" AI visual for the
 * Loom-native Report Designer (report-designer wave 3, the "AI" gallery section).
 *
 * Power BI parity (ui-parity.md):
 * learn.microsoft.com/power-bi/visuals/power-bi-visualization-decomposition-tree —
 * the decomposition tree visualizes one MEASURE ("Analyze") and lets the user
 * break it down across multiple dimensions ("Explain by") in any order. Each level
 * expands into the values of the chosen dimension, sorted high→low, and the user
 * selects a value to drill the next level (path constraint). Two AI splits —
 * "High value" and "Low value" — pick, for the current path, the dimension whose
 * breakdown contains the highest / lowest measure value, with an Absolute/Relative
 * analysis-formatting toggle and an "AI splits off" switch. This file is the
 * one-for-one Loom build, Azure-native BY CONSTRUCTION:
 *
 *   • EVERY expansion is a REAL `GROUP BY` over the bound Loom semantic model —
 *     the host's shared {@link DecompositionTreeProps.queryAdHoc} runs the SAME
 *     Path-3 wells→SQL `/query` the designer uses for every visual. A level for
 *     dimension D under the ancestor path issues
 *     `{ category:[D], values:[Analyze] }` constrained by the path's selected
 *     values folded as `op:'eq'` {@link ReportFilterInput}s. No fabricated
 *     aggregation, ever (no-vaporware.md).
 *   • The root node is the Analyze measure aggregated overall (a values-only
 *     `card` query — one real number).
 *   • The AI split is a HEURISTIC over REAL query results: for each remaining
 *     Explain-by dimension it runs the same `/query` under the current path, then
 *     ranks by max value (Absolute) or relative lift vs an even split (Relative),
 *     picks the winning dimension, auto-selects its high/low child, and marks it
 *     with a light-bulb. The optional one-line "why" comes from the host's
 *     {@link DecompositionTreeProps.aiSplit} (a REAL Azure OpenAI gloss via the
 *     `/ai-visual` route) — but the split itself is real SQL, so a missing /
 *     gated AOAI deployment never blocks it; it just omits the gloss.
 *   • Selecting a node sets the path constraint for deeper levels; selecting an
 *     EARLIER level's node changes the path (deeper levels are dropped). The 'x'
 *     on a level header removes that level and everything below it.
 *
 * Rules compliance:
 *  - no-vaporware.md: every control is wired to a real backend or honestly gated.
 *    There are NO dead buttons — '+' issues a real GROUP BY, the AI splits rank
 *    real query results, 'x' truncates the path. When Analyze + Explain-by span
 *    more than one model table the `/query` route returns its honest
 *    `code:'multi-table'` 400, which this surface displays VERBATIM in a Fluent
 *    MessageBar. The UI copy states honestly that the AI splits rank real SQL
 *    aggregation (correlation/extremes), not a trained ML model.
 *  - no-freeform-config.md: the only inputs are structured — the Analyze/Explain-by
 *    wells are picker output (host-supplied), and every drill choice is a menu of
 *    real model dimensions. There is no raw-SQL / DAX / JSON box anywhere.
 *  - no-fabric-dependency.md: Azure-native by construction — Synapse `/query`
 *    (+ optional AOAI for the "why"). Nothing here reaches api.fabric.microsoft.com
 *    / api.powerbi.com.
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens only (no hard-coded spacing /
 *    color / radius / shadow values); a card with elevation + a DataTreemap accent
 *    header, matching the sibling smart-narrative / qa AI visuals.
 *
 * The component self-queries (it owns its drill state), so the report-designer host
 * mounts it like the other AI visuals but must SKIP the per-visual `runVisual`
 * effect for this type — there is no single static `/query` for a decomposition
 * tree. The spec contract ({@link CopilotVisualSpec}) and the field shape
 * ({@link WellField}) are imported from the modules that OWN them so the host wires
 * `queryAdHoc` / `aiSplit` straight through with zero adapters.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import {
  Title3, Subtitle2, Body1, Caption1, Spinner, Button, Tooltip, Switch, Badge,
  ToggleButton, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  MenuGroupHeader, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DataTreemap20Regular, Add16Regular, Dismiss16Regular, Lightbulb16Filled,
  Lightbulb16Regular, ChevronRight16Regular, DataBarHorizontal20Regular,
} from '@fluentui/react-icons';
import type { CopilotVisualSpec, CopilotWellField } from '@/lib/components/report/report-powerbi-copilot';
import type { ReportFilterInput } from '@/lib/azure/wells-to-sql';
import type { WellField } from '../personalize';

// ── Props ─────────────────────────────────────────────────────────────────────

/** A single ancestor selection on the current drill path (handed to `aiSplit`). */
export interface DecompPathStep {
  /** The dimension (Explain-by column) selected at this level. */
  field: string;
  /** The display value chosen at this level (the path constraint). */
  value: string;
}

export interface DecompositionTreeProps {
  /**
   * The structured wells (host-supplied picker output): one Analyze measure and N
   * Explain-by dimensions. Exactly the same `WellField` the designer binds in its
   * field wells — no DAX, no free text (no-freeform-config.md).
   */
  wells: { analyze: WellField[]; explainBy: WellField[] };
  /**
   * Run a structured visual spec against the REAL `/query` backend (Path-3
   * wells→SQL over the bound Loom semantic model) and return its aggregated rows —
   * the host's shared helper, with the ancestor path folded in as `op:'eq'`
   * filters. May reject with the route's honest error (e.g. `code:'multi-table'`),
   * which this surface surfaces VERBATIM.
   */
  queryAdHoc: (spec: CopilotVisualSpec, filters?: ReportFilterInput[]) => Promise<Array<Record<string, unknown>>>;
  /**
   * Optional REAL Azure OpenAI gloss for an AI split — given the current path and
   * the candidate dimensions it returns the model's chosen field + a one-line
   * "why". The drill itself is real SQL, so this is purely additive: when it is
   * absent / errors / is AOAI-gated, the split still happens (heuristic over real
   * query results) and just omits the gloss.
   */
  aiSplit?: (path: DecompPathStep[], candidates: string[]) => Promise<{ field: string; why?: string } | null>;
}

// ── drill model ───────────────────────────────────────────────────────────────

/** One child node in a level — a real dimension value + its aggregated measure. */
interface DNode {
  /** Raw value (stringified) used as the `eq` filter constraint for deeper levels. */
  key: string;
  /** Display label (`(blank)` for empty). */
  label: string;
  /** The Analyze measure aggregated for this node (real `/query` output). */
  value: number;
}

/** One expanded level of the tree: a chosen dimension + its sorted child nodes. */
interface Level {
  /** The Explain-by field this level breaks down by. */
  dim: WellField;
  /** Display name of the dimension column. */
  dimName: string;
  /** Child nodes, sorted high→low by value (Learn parity). */
  nodes: DNode[];
  /** The selected child index (path constraint for deeper levels), or null. */
  selectedIndex: number | null;
  /** Present when this level was produced by an AI split (light-bulb + optional why). */
  ai?: { mode: 'high' | 'low'; why?: string };
}

type AnalysisMode = 'absolute' | 'relative';

// ── well/alias/row helpers ────────────────────────────────────────────────────

const AGGS = ['Sum', 'Avg', 'Count', 'Min', 'Max'] as const;
type Agg = (typeof AGGS)[number];

/** Project a designer `WellField` onto the Copilot spec well shape (`/query` input). */
function toCopilotWell(f: WellField): CopilotWellField {
  const agg = AGGS.find((a) => a === f.aggregation);
  return {
    ...(f.table ? { table: f.table } : {}),
    ...(f.column ? { column: f.column } : {}),
    ...(f.measure ? { measure: f.measure } : {}),
    ...(agg ? { aggregation: agg as Agg } : {}),
  };
}

/**
 * The result-column alias the `/query` route assigns to the Analyze value well —
 * mirrors `aggProjection` (`<Measure>` for a measure, `<Agg> of <Column>` /
 * `Sum of <Column>` for a column). Used to find the value column in the rows.
 */
function analyzeAlias(a: WellField): string {
  if (a.measure) return a.measure;
  const agg = AGGS.find((x) => x === a.aggregation);
  return `${agg || 'Sum'} of ${a.column || 'value'}`;
}

/** Coerce a cell to a number (the `/query` value column may arrive as a string). */
function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

/** True when a column reads as numeric across the returned rows. */
function isNumericColumn(rows: Array<Record<string, unknown>>, key: string): boolean {
  let sawNumber = false;
  for (const r of rows) {
    const v = r[key];
    if (v == null || v === '') continue;
    if (typeof v === 'number') { sawNumber = true; continue; }
    if (typeof v === 'string' && !Number.isNaN(Number(v))) { sawNumber = true; continue; }
    return false;
  }
  return sawNumber;
}

/**
 * Resolve which result key is the dimension and which is the aggregated value.
 * Prefers an exact (case-insensitive) match on the requested dim column / value
 * alias, then falls back to "the numeric column is the value, the other is the
 * dimension" so a resolver case/whitespace difference never mis-binds.
 */
function resolveKeys(
  rows: Array<Record<string, unknown>>,
  dimName: string,
  valAlias: string,
): { dimKey: string; valueKey: string } {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  let valueKey = keys.find((k) => ci(k, valAlias));
  let dimKey = keys.find((k) => ci(k, dimName));
  if (!valueKey) valueKey = keys.find((k) => k !== dimKey && isNumericColumn(rows, k));
  if (!dimKey) dimKey = keys.find((k) => k !== valueKey) ?? keys[0] ?? '';
  if (!valueKey) valueKey = keys.find((k) => k !== dimKey) ?? keys[0] ?? '';
  return { dimKey, valueKey };
}

/** Build sorted (high→low) child nodes from a level's REAL `/query` rows. */
function nodesFromRows(
  rows: Array<Record<string, unknown>>,
  dimName: string,
  valAlias: string,
): DNode[] {
  if (!rows.length) return [];
  const { dimKey, valueKey } = resolveKeys(rows, dimName, valAlias);
  return rows
    .map((r) => {
      const raw = r[dimKey];
      const blank = raw == null || raw === '';
      return { key: blank ? '' : String(raw), label: blank ? '(blank)' : String(raw), value: toNum(r[valueKey]) };
    })
    .sort((a, b) => b.value - a.value);
}

/** Fold the path's selected values (levels [0..k)) into `op:'eq'` query filters. */
function pathFiltersUpto(levels: Level[], k: number): ReportFilterInput[] {
  const out: ReportFilterInput[] = [];
  for (let i = 0; i < k && i < levels.length; i += 1) {
    const lv = levels[i];
    if (lv.selectedIndex == null) break;
    const node = lv.nodes[lv.selectedIndex];
    if (!node || !lv.dim.column) continue;
    out.push({ ...(lv.dim.table ? { table: lv.dim.table } : {}), column: lv.dim.column, op: 'eq', value: node.key });
  }
  return out;
}

/** Stable identity for an Explain-by dimension (for "already used on the path"). */
function dimKeyId(d: WellField): string { return `${d.table || ''}.${d.column || ''}`; }

/** Number formatting for node values (compact for large magnitudes). */
function fmtVal(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`;
  if (abs >= 1_000) return `${(v / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : (typeof e === 'string' ? e : 'Query failed.');
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
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  headTitle: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexGrow: 1, minWidth: 0 },
  toolbar: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexShrink: 0 },
  seg: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  hint: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  tree: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: tokens.spacingHorizontalS,
    minHeight: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
    flexGrow: 1,
    paddingBottom: tokens.spacingVerticalXS,
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    minWidth: '208px',
    maxWidth: '240px',
    flexShrink: 0,
  },
  colHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    minHeight: '24px',
  },
  colHeadLabel: { flexGrow: 1, minWidth: 0, color: tokens.colorNeutralForeground2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  nodes: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: tokens.spacingHorizontalXXS,
  },
  node: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    textAlign: 'left',
    width: '100%',
    boxSizing: 'border-box',
    padding: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    transitionProperty: 'box-shadow, border-color, background-color',
    transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow4, border: `1px solid ${tokens.colorNeutralStroke1Hover}` },
  },
  nodeStatic: { cursor: 'default' },
  nodeSelected: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
    boxShadow: tokens.shadow4,
  },
  nodeTopRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  nodeLabel: { flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: tokens.colorNeutralForeground1 },
  nodeValue: { color: tokens.colorNeutralForeground1, fontWeight: tokens.fontWeightSemibold, flexShrink: 0 },
  bar: {
    position: 'relative',
    height: '4px',
    width: '100%',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground4,
    overflow: 'hidden',
  },
  barFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorBrandBackground,
  },
  nodeActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, marginTop: tokens.spacingVerticalXXS },
  bulb: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  connector: { display: 'flex', alignItems: 'center', color: tokens.colorNeutralForeground4, flexShrink: 0 },
  loadingCol: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalXS,
    minWidth: '160px',
    color: tokens.colorNeutralForeground3,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalXS,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    flexGrow: 1,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalL,
  },
  emptyIcon: { color: tokens.colorBrandForeground2 },
  foot: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
});

type Styles = ReturnType<typeof useStyles>;

// ── node card ─────────────────────────────────────────────────────────────────

function NodeCard(props: {
  styles: Styles;
  label: string;
  value: number;
  /** Max |value| in the level (bar scale); 0 for the root total (full bar). */
  max: number;
  selected: boolean;
  picked?: boolean;
  loading?: boolean;
  onClick?: () => void;
  plus?: ReactNode;
}): ReactElement {
  const { styles, label, value, max, selected, picked, loading, onClick, plus } = props;
  const pct = max > 0 ? Math.max(2, Math.min(100, Math.round((Math.abs(value) / max) * 100))) : 100;
  const cls = [styles.node, selected ? styles.nodeSelected : '', onClick ? '' : styles.nodeStatic].filter(Boolean).join(' ');
  const Tag: 'button' | 'div' = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={cls}
      onClick={onClick}
      aria-pressed={onClick ? selected : undefined}
      aria-label={`${label}: ${fmtVal(value)}`}
    >
      <div className={styles.nodeTopRow}>
        {picked && (
          <Tooltip content="AI-selected split" relationship="label">
            <Lightbulb16Filled className={styles.bulb} aria-hidden />
          </Tooltip>
        )}
        <Caption1 className={styles.nodeLabel}>{label}</Caption1>
        {loading
          ? <Spinner size="extra-tiny" aria-label="Loading total" />
          : <Caption1 className={styles.nodeValue}>{fmtVal(value)}</Caption1>}
      </div>
      <div className={styles.bar}>
        <span className={styles.barFill} style={{ width: `${pct}%` }} />
      </div>
      {plus && <div className={styles.nodeActions}>{plus}</div>}
    </Tag>
  );
}

// ── component ─────────────────────────────────────────────────────────────────

/**
 * Decomposition tree — interactive hierarchical breakdown of one measure over many
 * dimensions, every level a REAL `GROUP BY`. Manual drill + High/Low AI splits with
 * an Absolute/Relative analysis toggle. Surfaces the `/query` route's honest
 * `multi-table` error verbatim. Self-querying — the host skips its `runVisual`.
 */
export function DecompositionTree(props: DecompositionTreeProps): ReactElement {
  const { wells, queryAdHoc, aiSplit } = props;
  const styles = useStyles();

  const analyze = wells.analyze?.[0];
  const explainBy = useMemo(
    () => (wells.explainBy || []).filter((d) => !!d.column),
    [wells.explainBy],
  );
  const hasAnalyze = !!analyze && (!!analyze.column || !!analyze.measure);
  const hasSetup = hasAnalyze && explainBy.length > 0;

  const analyzeLabel = useMemo(() => (analyze ? analyzeAlias(analyze) : ''), [analyze]);
  // Signatures drive resets: change Analyze/Explain-by → the drill is invalid.
  const analyzeSig = useMemo(() => JSON.stringify(analyze || null), [analyze]);
  const explainSig = useMemo(() => JSON.stringify(explainBy.map(dimKeyId)), [explainBy]);

  const [mode, setMode] = useState<AnalysisMode>('absolute');
  const [aiOn, setAiOn] = useState(true);
  const [rootTotal, setRootTotal] = useState<number | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [levels, setLevels] = useState<Level[]>([]);
  const [busyLevel, setBusyLevel] = useState<number | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cancels stale async drills (a newer interaction wins).
  const opRef = useRef(0);

  // Reset the drill whenever the wells change identity.
  useEffect(() => { setLevels([]); setError(null); opRef.current += 1; }, [analyzeSig, explainSig]);

  // Root total — the Analyze measure aggregated overall (REAL values-only query).
  useEffect(() => {
    if (!hasAnalyze || !analyze) { setRootTotal(null); return; }
    let alive = true;
    setRootLoading(true);
    setError(null);
    (async () => {
      try {
        const rows = await queryAdHoc(
          { type: 'card', title: analyzeAlias(analyze), wells: { values: [toCopilotWell(analyze)] } },
          [],
        );
        if (!alive) return;
        const keys = rows.length ? Object.keys(rows[0]) : [];
        setRootTotal(rows.length && keys.length ? toNum(rows[0][keys[0]]) : 0);
      } catch (e) {
        if (!alive) return;
        setError(errMsg(e)); // multi-table / unbound surfaced verbatim
        setRootTotal(null);
      } finally {
        if (alive) setRootLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [analyzeSig, hasAnalyze]); // eslint-disable-line react-hooks/exhaustive-deps

  const usedKeys = useMemo(() => new Set(levels.map((l) => dimKeyId(l.dim))), [levels]);
  const remainingDims = useMemo(
    () => explainBy.filter((d) => !usedKeys.has(dimKeyId(d))),
    [explainBy, usedKeys],
  );

  /** The structured spec for a level: break Analyze down by one dimension. */
  const levelSpec = (dim: WellField): CopilotVisualSpec => ({
    type: 'bar',
    title: `${analyzeLabel} by ${dim.column || 'field'}`,
    wells: {
      category: [{ ...(dim.table ? { table: dim.table } : {}), ...(dim.column ? { column: dim.column } : {}) }],
      values: [toCopilotWell(analyze as WellField)],
    },
  });

  /** Manual expand: append a level breaking the tail by `dim` (REAL GROUP BY). */
  const expand = async (dim: WellField) => {
    if (!analyze) return;
    const op = (opRef.current += 1);
    const k = levels.length;
    setBusyLevel(k);
    setError(null);
    try {
      const rows = await queryAdHoc(levelSpec(dim), pathFiltersUpto(levels, k));
      if (opRef.current !== op) return;
      const nodes = nodesFromRows(rows, dim.column || '', analyzeLabel);
      setLevels((prev) => [...prev, { dim, dimName: dim.column || 'field', nodes, selectedIndex: null }]);
    } catch (e) {
      if (opRef.current !== op) return;
      setError(errMsg(e)); // multi-table 400 etc. — verbatim
    } finally {
      if (opRef.current === op) setBusyLevel(null);
    }
  };

  /**
   * AI split: query every remaining dimension under the current path, rank by max
   * value (Absolute) / relative lift (Relative), pick the winner, auto-select its
   * high/low child, and attach an optional AOAI "why". All ranking is over REAL
   * query results — the AOAI call only supplies the gloss.
   */
  const aiSplitExpand = async (split: 'high' | 'low') => {
    if (!analyze || remainingDims.length === 0) return;
    const op = (opRef.current += 1);
    const k = levels.length;
    setBusyLevel(k);
    setAiBusy(true);
    setError(null);
    try {
      const filters = pathFiltersUpto(levels, k);
      const scored: Array<{ dim: WellField; nodes: DNode[]; metric: number; pickIndex: number }> = [];
      for (const dim of remainingDims) {
        const rows = await queryAdHoc(levelSpec(dim), filters); // real SQL; rejects surfaced below
        if (opRef.current !== op) return;
        const nodes = nodesFromRows(rows, dim.column || '', analyzeLabel);
        if (!nodes.length) continue;
        const sum = nodes.reduce((s, n) => s + n.value, 0);
        const even = nodes.length ? sum / nodes.length : 0;
        let metric: number;
        let pickIndex: number;
        if (split === 'high') {
          if (mode === 'absolute') { metric = nodes[0].value; pickIndex = 0; } // sorted desc → max first
          else {
            let best = -Infinity; let bi = 0;
            nodes.forEach((nd, i) => { const lift = even !== 0 ? (nd.value - even) / Math.abs(even) : 0; if (lift > best) { best = lift; bi = i; } });
            metric = best; pickIndex = bi;
          }
        } else { // low
          if (mode === 'absolute') { metric = nodes[nodes.length - 1].value; pickIndex = nodes.length - 1; }
          else {
            let best = Infinity; let bi = 0;
            nodes.forEach((nd, i) => { const lift = even !== 0 ? (nd.value - even) / Math.abs(even) : 0; if (lift < best) { best = lift; bi = i; } });
            metric = best; pickIndex = bi;
          }
        }
        scored.push({ dim, nodes, metric, pickIndex });
      }
      if (!scored.length) { setError('No breakdown was returned for the remaining fields under this path.'); return; }
      const winner = split === 'high'
        ? scored.reduce((a, b) => (b.metric > a.metric ? b : a))
        : scored.reduce((a, b) => (b.metric < a.metric ? b : a));

      // Optional AOAI "why" — additive only; never blocks the real split.
      let why: string | undefined;
      if (aiSplit) {
        try {
          const steps: DecompPathStep[] = levels
            .filter((l) => l.selectedIndex != null)
            .map((l) => ({ field: l.dimName, value: l.nodes[l.selectedIndex as number]?.label ?? '' }));
          const r = await aiSplit(steps, remainingDims.map((d) => d.column || 'field'));
          if (opRef.current !== op) return;
          if (r && typeof r.why === 'string' && r.why.trim()) why = r.why.trim();
        } catch { /* AOAI gated/offline — keep the heuristic split, omit the gloss */ }
      }

      setLevels((prev) => [...prev, {
        dim: winner.dim,
        dimName: winner.dim.column || 'field',
        nodes: winner.nodes,
        selectedIndex: winner.pickIndex,
        ai: { mode: split, ...(why ? { why } : {}) },
      }]);
    } catch (e) {
      if (opRef.current !== op) return;
      setError(errMsg(e)); // multi-table 400 etc. — verbatim
    } finally {
      if (opRef.current === op) { setBusyLevel(null); setAiBusy(false); }
    }
  };

  /** Select a node: set the path constraint, dropping any deeper (now-stale) levels. */
  const selectNode = (li: number, ni: number) => {
    opRef.current += 1; // cancel pending deeper drills (path changing)
    setBusyLevel(null);
    setError(null);
    setLevels((prev) => prev.slice(0, li + 1).map((lv, i) => (i === li ? { ...lv, selectedIndex: ni } : lv)));
  };

  /** Remove a level and everything below it. */
  const removeLevel = (li: number) => {
    opRef.current += 1;
    setBusyLevel(null);
    setError(null);
    setLevels((prev) => prev.slice(0, li));
  };

  // The '+' menu (offered on the root when empty, and on the tail's selected node).
  const expandMenu = (): ReactElement => (
    <Menu positioning="below-start">
      <MenuTrigger disableButtonEnhancement>
        <Tooltip content="Break down further" relationship="label">
          <Button
            size="small"
            appearance="primary"
            shape="circular"
            icon={<Add16Regular />}
            aria-label="Break down further"
            disabled={busyLevel != null}
          />
        </Tooltip>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuGroupHeader>Break down by</MenuGroupHeader>
          {remainingDims.length === 0
            ? <MenuItem disabled>All fields used</MenuItem>
            : remainingDims.map((d) => (
              <MenuItem key={dimKeyId(d)} onClick={() => void expand(d)}>{d.column}</MenuItem>
            ))}
          {aiOn && remainingDims.length > 0 && (
            <>
              <MenuDivider />
              <MenuGroupHeader>AI split ({mode === 'absolute' ? 'absolute' : 'relative'})</MenuGroupHeader>
              <MenuItem icon={<Lightbulb16Filled />} onClick={() => void aiSplitExpand('high')}>High value</MenuItem>
              <MenuItem icon={<Lightbulb16Regular />} onClick={() => void aiSplitExpand('low')}>Low value</MenuItem>
            </>
          )}
        </MenuList>
      </MenuPopover>
    </Menu>
  );

  const lastIndex = levels.length - 1;
  const rootHasPlus = levels.length === 0;
  const busy = rootLoading || busyLevel != null || aiBusy;

  return (
    <section className={styles.card} aria-label="Decomposition tree">
      <div className={styles.head}>
        <div className={styles.headTitle}>
          <DataTreemap20Regular style={{ color: tokens.colorBrandForeground1 }} aria-hidden />
          <Subtitle2>Decomposition tree</Subtitle2>
          {analyzeLabel && <Badge appearance="tint" color="brand" size="small">{analyzeLabel}</Badge>}
          {busy && <Spinner size="tiny" aria-label="Querying your model" />}
        </div>
        {hasSetup && (
          <div className={styles.toolbar}>
            <div className={styles.seg} role="group" aria-label="Analysis mode">
              <ToggleButton
                size="small"
                checked={mode === 'absolute'}
                appearance={mode === 'absolute' ? 'primary' : 'subtle'}
                onClick={() => setMode('absolute')}
              >
                Absolute
              </ToggleButton>
              <ToggleButton
                size="small"
                checked={mode === 'relative'}
                appearance={mode === 'relative' ? 'primary' : 'subtle'}
                onClick={() => setMode('relative')}
              >
                Relative
              </ToggleButton>
            </div>
            <Switch
              checked={aiOn}
              onChange={(_e, d) => setAiOn(d.checked)}
              label="AI splits"
              aria-label="Toggle AI high/low value splits"
            />
          </div>
        )}
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Couldn’t break this down</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {!hasSetup ? (
        <div className={styles.empty}>
          <DataBarHorizontal20Regular className={styles.emptyIcon} aria-hidden />
          <Body1>Set up the decomposition tree</Body1>
          <Caption1>
            Add one measure to <strong>Analyze</strong> and one or more dimensions to{' '}
            <strong>Explain by</strong>. Each level then drills with a real GROUP BY over your
            model — no DAX required.
          </Caption1>
        </div>
      ) : (
        <div className={styles.tree} role="tree" aria-label="Decomposition levels">
          {/* Root — the Analyze measure aggregated overall (REAL values-only query). */}
          <div className={styles.column} role="treeitem" aria-label="Total">
            <div className={styles.colHead}>
              <Title3 as="h4" className={styles.colHeadLabel} title={analyzeLabel}>{analyzeLabel}</Title3>
            </div>
            <div className={styles.nodes}>
              <NodeCard
                styles={styles}
                label="Total"
                value={rootTotal ?? 0}
                max={0}
                selected
                loading={rootLoading}
                plus={rootHasPlus ? expandMenu() : undefined}
              />
            </div>
          </div>

          {levels.map((lv, li) => {
            const max = lv.nodes.reduce((m, n) => Math.max(m, Math.abs(n.value)), 0);
            return (
              <div key={`${dimKeyId(lv.dim)}-${li}`} style={{ display: 'flex', alignItems: 'stretch', gap: tokens.spacingHorizontalS }}>
                <div className={styles.connector} aria-hidden><ChevronRight16Regular /></div>
                <div className={styles.column} role="treeitem" aria-label={lv.dimName}>
                  <div className={styles.colHead}>
                    {lv.ai && (
                      <Tooltip content={lv.ai.why || `AI ${lv.ai.mode === 'high' ? 'high' : 'low'}-value split (ranked over real query results)`} relationship="label">
                        <Lightbulb16Filled className={styles.bulb} aria-hidden />
                      </Tooltip>
                    )}
                    <Caption1 className={styles.colHeadLabel} title={lv.dimName}>{lv.dimName}</Caption1>
                    <Tooltip content="Remove this level" relationship="label">
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<Dismiss16Regular />}
                        aria-label={`Remove the ${lv.dimName} level`}
                        onClick={() => removeLevel(li)}
                      />
                    </Tooltip>
                  </div>
                  <div className={styles.nodes}>
                    {lv.nodes.length === 0 && <Caption1 className={styles.hint}>No rows under this path.</Caption1>}
                    {lv.nodes.map((nd, ni) => {
                      const isSelected = lv.selectedIndex === ni;
                      const isTailSelected = li === lastIndex && isSelected;
                      return (
                        <NodeCard
                          key={`${nd.key}-${ni}`}
                          styles={styles}
                          label={nd.label}
                          value={nd.value}
                          max={max}
                          selected={isSelected}
                          picked={!!lv.ai && isSelected}
                          onClick={() => selectNode(li, ni)}
                          plus={isTailSelected ? expandMenu() : undefined}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}

          {busyLevel != null && (
            <div className={styles.loadingCol} aria-live="polite">
              <Spinner size="small" />
              <Caption1>{aiBusy ? 'Ranking dimensions over live data…' : 'Running GROUP BY…'}</Caption1>
            </div>
          )}
        </div>
      )}

      {hasSetup && (
        <Caption1 className={styles.foot}>
          Every level is a live GROUP BY over your model, sorted high→low. AI splits rank real query
          results ({mode === 'absolute' ? 'highest/lowest value' : 'relative lift vs an even split'}) —
          not a trained model.
        </Caption1>
      )}
    </section>
  );
}

export default DecompositionTree;
