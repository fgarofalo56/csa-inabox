'use client';

/**
 * qa — the Power BI "Q&A" AI visual for the Loom-native Report Designer
 * (report-designer wave 3, the "AI" gallery section).
 *
 * Power BI parity (ui-parity.md):
 * learn.microsoft.com/power-bi/natural-language/q-and-a-intro — Q&A lets a user
 * type a natural-language question ("total sales by region", "top 5 products by
 * revenue") and turns it into a visual, with example-question suggestions and a
 * "turn this Q&A result into a standard visual" action. This file is the
 * one-for-one Loom build of that surface, Azure-native by construction:
 *
 *   • {@link ReportQA} takes a question, POSTs it (with the bound model's field
 *     list for grounding) to the wave-3 `/ai-visual` route (`mode:'qa'`), which
 *     calls the shared `copilot-orchestrator` `aoaiCompleteJson` and returns a
 *     STRUCTURED {@link CopilotVisualSpec} (`{ type, title, wells }`) — the SAME
 *     spec shape the report Copilot emits — server-validated by
 *     `report-designer-tools` sanitize against the real model fields. The user
 *     never types DAX (no-freeform-config.md); the model emits structured wells.
 *   • The returned spec is rendered INLINE by running the host's shared
 *     `queryAdHoc(spec)` (the Path-3 wells→SQL `/query` over the bound Loom
 *     semantic model) and drawing the REAL aggregated rows with {@link LoomChart}
 *     (charts) / a Fluent table / a big-number card / a slicer dropdown.
 *   • "Turn into a standard visual" calls {@link ReportQAProps.onApplyVisual}
 *     with the spec — the EXACT canvas-apply path the report Copilot uses
 *     (report-designer `applyCopilotVisual`) — so the Q&A answer becomes a real,
 *     persisted page visual.
 *
 * Rules compliance:
 *  - no-vaporware.md: every control is wired to a real backend. The question box
 *    hits REAL Azure OpenAI through the orchestrator; the inline preview runs the
 *    REAL `/query` SQL via `queryAdHoc`; "Turn into a standard visual" really
 *    applies the spec to the canvas. No dead buttons, no mock answers. When no
 *    AOAI chat model is deployed the route returns 503 (NoAoaiDeploymentError)
 *    and this visual shows the SAME honest Fluent warning MessageBar the report
 *    Copilot + Smart narrative use, naming the exact remediation. A loom-native
 *    cross-table answer surfaces the route's honest `code:'multi-table'` message.
 *  - no-freeform-config.md: the only free text is the natural-language QUESTION
 *    (parity with Power BI Q&A) — the model returns a STRUCTURED spec, not raw
 *    DAX/SQL, and the user edits nothing by hand. Example questions are chips.
 *  - no-fabric-dependency.md: Azure-native by construction — AOAI + Synapse
 *    `/query`. Nothing here reaches api.fabric.microsoft.com / api.powerbi.com.
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens only (no hard-coded px/hex); a
 *    card with elevation + a Sparkle accent header, matching the sibling
 *    smart-narrative / report-powerbi-copilot surfaces.
 *
 * The spec contract ({@link CopilotVisualSpec}) is imported from the Copilot pane
 * (which OWNS it and the designer already imports it), so `onApplyVisual` and
 * `queryAdHoc` wire straight to the host's existing handlers with zero adapters.
 * The model schema reuses the canonical {@link FieldTable} from ./filters-pane.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import {
  Subtitle2, Body1, Caption1, Spinner, Button, Tooltip, Input, Badge, Divider,
  Dropdown, Option,
  Table, TableHeader, TableHeaderCell, TableRow, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Sparkle20Regular, Send20Regular, Lightbulb16Regular, ArrowClockwise16Regular,
  DataBarHorizontal20Regular, Question20Regular, Dismiss16Regular, CheckmarkCircle16Regular,
} from '@fluentui/react-icons';
import { LoomChart, type LoomChartType } from '@/lib/components/charts/loom-chart';
import type { CopilotVisualSpec, CopilotWellField } from '@/lib/components/report/report-powerbi-copilot';
import type { FieldTable } from '../filters-pane';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ReportQAProps {
  /** The report's Loom item id (the `/ai-visual` route shares it on the path). */
  reportId: string;
  /** The bound Loom semantic model's tables (host already loaded from …/fields). */
  tables: FieldTable[];
  /**
   * Run a structured visual spec against the REAL `/query` backend and return its
   * aggregated rows — the host's shared Path-3 wells→SQL helper (the same one the
   * designer uses to render every visual). May reject with the route's honest
   * error (e.g. `code:'multi-table'`), which this surface displays verbatim.
   */
  queryAdHoc: (spec: CopilotVisualSpec) => Promise<Array<Record<string, unknown>>>;
  /**
   * Apply the Q&A spec to the designer's canvas — the EXACT path the report
   * Copilot's Apply card uses (report-designer `applyCopilotVisual`). Turns the
   * answer into a real, persisted page visual.
   */
  onApplyVisual: (spec: CopilotVisualSpec) => void;
}

// ── spec helpers (client-side guard + render mapping) ─────────────────────────

/** The visual types Q&A may return (mirrors {@link CopilotVisualSpec.type}). */
const QA_TYPES = new Set<CopilotVisualSpec['type']>([
  'table', 'matrix', 'card', 'bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter', 'slicer',
]);

/** Chart-family types LoomChart draws directly (table/matrix/card/slicer render locally). */
const CHART_RENDER: Partial<Record<CopilotVisualSpec['type'], LoomChartType>> = {
  bar: 'bar', column: 'column', line: 'line', area: 'area', pie: 'pie', donut: 'donut', scatter: 'scatter',
};

/** A bound well field (column-with-aggregation or measure) — defensive read. */
function sanitizeWellList(raw: unknown): CopilotWellField[] {
  if (!Array.isArray(raw)) return [];
  const out: CopilotWellField[] = [];
  for (const r of raw) {
    const f = (r || {}) as Record<string, unknown>;
    const table = typeof f.table === 'string' ? f.table : undefined;
    const column = typeof f.column === 'string' ? f.column : undefined;
    const measure = typeof f.measure === 'string' ? f.measure : undefined;
    if (!column && !measure) continue;
    const aggRaw = typeof f.aggregation === 'string' ? f.aggregation : undefined;
    const aggregation = (['Sum', 'Avg', 'Count', 'Min', 'Max'] as const).find((a) => a === aggRaw);
    out.push({
      ...(table ? { table } : {}),
      ...(column ? { column } : {}),
      ...(measure ? { measure } : {}),
      ...(aggregation ? { aggregation } : {}),
    });
  }
  return out;
}

/**
 * Client guard over the route's spec — the server already validated wells against
 * the real model (report-designer-tools sanitize); this only rejects a shape the
 * route couldn't produce so the inline render never crashes. Returns null when the
 * spec is unusable (the caller shows an honest error).
 */
function coerceSpec(raw: unknown): CopilotVisualSpec | null {
  const o = (raw || {}) as Record<string, unknown>;
  const type = o.type as CopilotVisualSpec['type'];
  if (!QA_TYPES.has(type)) return null;
  const w = (o.wells || {}) as Record<string, unknown>;
  const wells = {
    category: sanitizeWellList(w.category),
    values: sanitizeWellList(w.values),
    legend: sanitizeWellList(w.legend),
  };
  if (wells.category.length + wells.values.length + wells.legend.length === 0) return null;
  return {
    type,
    title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : type,
    wells,
  };
}

/** One-line summary of a spec's wells (parity with the Copilot Apply card). */
function describeSpec(spec: CopilotVisualSpec): string {
  const fmt = (f: { column?: string; measure?: string; aggregation?: string }) =>
    f.measure || (f.aggregation ? `${f.aggregation} of ${f.column}` : f.column) || 'field';
  const parts: string[] = [];
  if (spec.wells?.values?.length) parts.push(`Values: ${spec.wells.values.map(fmt).join(', ')}`);
  if (spec.wells?.category?.length) parts.push(`Axis: ${spec.wells.category.map(fmt).join(', ')}`);
  if (spec.wells?.legend?.length) parts.push(`Legend: ${spec.wells.legend.map(fmt).join(', ')}`);
  return parts.join(' · ') || 'no fields';
}

/** Format a result cell for the table / card preview (number-aware). */
function formatCell(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === 'string') {
    const n = Number(v);
    if (v.trim() !== '' && !Number.isNaN(n)) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(v);
}

/**
 * Build grounded example questions from the REAL bound model (parity with PBI Q&A
 * suggestions). References actual measures/columns so a chip always asks something
 * the model can answer — never a canned placeholder (no-vaporware).
 */
function buildExamples(tables: FieldTable[]): string[] {
  const measures: string[] = [];
  const columns: string[] = [];
  let dateCol: string | undefined;
  for (const t of tables || []) {
    for (const m of t.measures || []) if (!m.isHidden) measures.push(m.name);
    for (const c of t.columns || []) {
      if (c.isHidden) continue;
      columns.push(c.name);
      if (!dateCol && /date|time|year|month|day/i.test(`${c.name} ${c.dataType || ''}`)) dateCol = c.name;
    }
  }
  const m = measures[0];
  const c = columns.find((x) => x !== dateCol) || columns[0];
  const out: string[] = [];
  if (m && c) out.push(`${m} by ${c}`);
  if (m && c) out.push(`Top 5 ${c} by ${m}`);
  if (m && dateCol) out.push(`${m} over ${dateCol}`);
  else if (m) out.push(`Total ${m}`);
  if (c) out.push(`Count of ${c}`);
  return Array.from(new Set(out)).slice(0, 4);
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
    gap: tokens.spacingHorizontalXS,
    flexShrink: 0,
  },
  headTitle: { flexGrow: 1, minWidth: 0 },
  ask: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    flexShrink: 0,
  },
  askInput: { flexGrow: 1, minWidth: 0 },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    alignItems: 'center',
    flexShrink: 0,
  },
  chipsLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground3,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minHeight: 0,
    overflow: 'auto',
    flexGrow: 1,
  },
  resultHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  resultTitle: { flexGrow: 1, minWidth: 0 },
  wellsHint: { color: tokens.colorNeutralForeground3 },
  preview: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    minHeight: 0,
  },
  kpi: {
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    lineHeight: tokens.lineHeightHero700,
    textAlign: 'center',
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
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
  applied: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorPaletteGreenForeground1,
  },
  muted: { color: tokens.colorNeutralForeground3 },
  foot: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
});

type Styles = ReturnType<typeof useStyles>;

// ── inline visual preview (REAL /query rows → LoomChart / table / card / slicer) ──

/**
 * Render the Q&A spec's REAL aggregated rows inline. Charts go through LoomChart
 * (the same renderer the designer uses); table/matrix render a Fluent table; card
 * shows the single big value; slicer shows a (preview) dropdown over the distinct
 * values. Never fabricates data — `rows` are the route's `/query` output.
 */
function QAVisualPreview({ spec, rows, styles }: {
  spec: CopilotVisualSpec; rows: Array<Record<string, unknown>>; styles: Styles;
}): ReactElement {
  if (!rows.length) {
    return <Caption1 className={styles.muted}>No rows returned for this question.</Caption1>;
  }
  const cols = Object.keys(rows[0]);
  const chartType = CHART_RENDER[spec.type];

  if (chartType) {
    const hasNumeric = spec.type === 'scatter'
      || rows.some((r) => Object.values(r).some((v) => v != null && v !== '' && !Number.isNaN(Number(v))));
    if (hasNumeric) {
      return <LoomChart type={chartType} rows={rows} height={220} />;
    }
    // No numeric column for a chart — fall through to the table rather than draw nothing.
  }

  if (spec.type === 'card') {
    const valKey = cols[0];
    return <div className={styles.kpi}>{formatCell(rows[0][valKey])}</div>;
  }

  if (spec.type === 'slicer') {
    const col = cols[0];
    return (
      <Dropdown placeholder={`Filter by ${col}`} aria-label={`Q&A slicer ${col}`}>
        {rows.slice(0, 200).map((r, i) => {
          const txt = formatCell(r[col]);
          return <Option key={i} value={txt} text={txt}>{txt}</Option>;
        })}
      </Dropdown>
    );
  }

  // table / matrix / non-numeric fallback
  return (
    <Table size="small" aria-label={spec.title || 'Q&A result'}>
      <TableHeader><TableRow>{cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
      <TableBody>
        {rows.slice(0, 100).map((row, ri) => (
          <TableRow key={ri}>
            {cols.map((c) => <TableCell key={c}>{formatCell(row[c])}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── component ─────────────────────────────────────────────────────────────────

interface QAResult { spec: CopilotVisualSpec; rows: Array<Record<string, unknown>> }

/**
 * Q&A — type a natural-language question, get a real visual. The question hits
 * Azure OpenAI (via the `/ai-visual` route → orchestrator), which returns a
 * STRUCTURED visual spec validated against the bound model; the spec renders
 * inline over REAL `/query` rows and can be turned into a standard page visual.
 * Honest 503 gate when no AOAI chat model is deployed.
 */
export function ReportQA(props: ReportQAProps): ReactElement {
  const { reportId, tables, queryAdHoc, onApplyVisual } = props;
  const styles = useStyles();

  const examples = useMemo(() => buildExamples(tables), [tables]);
  const fieldsPayload = useMemo(() => ({
    tables: (tables || []).map((t) => ({
      name: t.name,
      columns: (t.columns || []).map((c) => ({ name: c.name, dataType: c.dataType })),
      measures: (t.measures || []).map((m) => ({ name: m.name })),
    })),
  }), [tables]);
  const hasModel = (tables || []).some((t) => (t.columns?.length || 0) + (t.measures?.length || 0) > 0);

  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QAResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  // Guards a stale async response from overwriting a newer ask.
  const runRef = useRef(0);

  const ask = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text || !reportId) return;
    const run = runRef.current + 1;
    runRef.current = run;
    setLoading(true);
    setError(null);
    setGate(null);
    setApplied(false);
    setResult(null);
    try {
      // 1) NL question → STRUCTURED spec (REAL Azure OpenAI, grounded in the model).
      const res = await fetch(`/api/items/report/${encodeURIComponent(reportId)}/ai-visual`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'qa', question: text, fields: fieldsPayload }),
      });
      if (runRef.current !== run) return;

      // Honest gate — no AOAI chat model deployed (NoAoaiDeploymentError → 503).
      if (res.status === 503) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        setGate(j?.error || 'AOAI deployment not wired');
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        setError(j?.error || `Couldn’t answer that question (HTTP ${res.status}).`);
        return;
      }

      // BFF envelope is `{ ok, data:{ spec } }` / `{ ok, spec }`; accept a flat spec too.
      const j = await res.json().catch(() => ({} as Record<string, unknown>));
      const data = (j && typeof j === 'object' && 'data' in j && j.data && typeof j.data === 'object')
        ? (j.data as Record<string, unknown>)
        : (j as Record<string, unknown>);
      const rawSpec = (data && typeof data === 'object' && 'spec' in data) ? (data as { spec: unknown }).spec : data;
      const spec = coerceSpec(rawSpec);
      if (!spec) {
        setError('The model couldn’t map that question to a visual. Try rephrasing with a measure and a category.');
        return;
      }

      // 2) Render the spec INLINE over REAL `/query` rows (shared host helper).
      const rows = await queryAdHoc(spec);
      if (runRef.current !== run) return;
      setResult({ spec, rows });
    } catch (e: unknown) {
      if (runRef.current !== run) return;
      const msg = e instanceof Error ? e.message : String(e);
      // Surface the route's honest errors (e.g. code:'multi-table') verbatim.
      setError(msg || 'Something went wrong answering that question.');
    } finally {
      if (runRef.current === run) setLoading(false);
    }
  }, [reportId, fieldsPayload, queryAdHoc]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(question); }
  }, [ask, question]);

  const apply = useCallback(() => {
    if (!result) return;
    onApplyVisual(result.spec);
    setApplied(true);
  }, [result, onApplyVisual]);

  const clear = useCallback(() => {
    runRef.current += 1;
    setResult(null);
    setError(null);
    setGate(null);
    setApplied(false);
    setLoading(false);
  }, []);

  return (
    <section className={styles.card} aria-label="Q&A">
      <div className={styles.head}>
        <Sparkle20Regular style={{ color: tokens.colorBrandForeground1 }} aria-hidden />
        <Subtitle2 className={styles.headTitle}>Q&amp;A</Subtitle2>
        {loading && <Spinner size="tiny" aria-label="Answering question" />}
        {(result || error || gate) && (
          <Tooltip content="Clear" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Dismiss16Regular />}
              onClick={clear}
              aria-label="Clear the Q&A result"
            />
          </Tooltip>
        )}
      </div>

      {/* Ask box — the only free text is the natural-language question (PBI Q&A). */}
      <div className={styles.ask}>
        <Input
          className={styles.askInput}
          value={question}
          placeholder="Ask a question about your data…"
          aria-label="Ask a question about your data"
          contentBefore={<Question20Regular />}
          disabled={!hasModel || loading}
          onChange={(_e, d) => setQuestion(d.value)}
          onKeyDown={onKeyDown}
        />
        <Button
          appearance="primary"
          icon={<Send20Regular />}
          disabled={!hasModel || loading || !question.trim()}
          onClick={() => void ask(question)}
        >
          Ask
        </Button>
      </div>

      {/* Grounded example-question chips (real model fields). */}
      {hasModel && examples.length > 0 && (
        <div className={styles.chips}>
          <Caption1 className={styles.chipsLabel}>
            <Lightbulb16Regular aria-hidden /> Try:
          </Caption1>
          {examples.map((ex) => (
            <Button
              key={ex}
              size="small"
              appearance="subtle"
              shape="circular"
              disabled={loading}
              onClick={() => { setQuestion(ex); void ask(ex); }}
            >
              {ex}
            </Button>
          ))}
        </div>
      )}

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>AOAI deployment not wired</MessageBarTitle>
            {gate} — open the AI Foundry editor and deploy a gpt-4o / gpt-4.1-class chat model.
          </MessageBarBody>
        </MessageBar>
      )}

      {!gate && error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Couldn’t answer that</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Body: empty hint, loading, or the inline rendered answer. */}
      {!hasModel ? (
        <div className={styles.empty}>
          <DataBarHorizontal20Regular className={styles.emptyIcon} aria-hidden />
          <Body1>Bind a semantic model to ask questions</Body1>
          <Caption1>
            Connect this report to a Loom semantic model (warehouse / lakehouse). Q&amp;A turns your
            questions into real visuals over its fields — no DAX required.
          </Caption1>
        </div>
      ) : (
        <div className={styles.body} aria-live="polite">
          {loading && !result && (
            <div className={styles.loading}>
              <Spinner size="tiny" />
              <Caption1>Asking Azure OpenAI and querying your model…</Caption1>
            </div>
          )}

          {result && (
            <>
              <div className={styles.resultHead}>
                <div className={styles.resultTitle}>
                  <Body1>{result.spec.title}</Body1>
                  <Caption1 className={styles.wellsHint}>{describeSpec(result.spec)}</Caption1>
                </div>
                <Badge appearance="tint" color="brand" size="small">{result.spec.type}</Badge>
                {applied ? (
                  <Caption1 className={styles.applied}>
                    <CheckmarkCircle16Regular aria-hidden /> Added to the page
                  </Caption1>
                ) : (
                  <Tooltip content="Add this answer to the report page as a standard visual" relationship="label">
                    <Button
                      size="small"
                      appearance="secondary"
                      icon={<DataBarHorizontal20Regular />}
                      onClick={apply}
                    >
                      Turn into a standard visual
                    </Button>
                  </Tooltip>
                )}
              </div>
              <Divider />
              <div className={styles.preview}>
                <QAVisualPreview spec={result.spec} rows={result.rows} styles={styles} />
              </div>
            </>
          )}

          {!loading && !result && !error && !gate && (
            <div className={styles.empty}>
              <Question20Regular className={styles.emptyIcon} aria-hidden />
              <Body1>Ask a question to build a visual</Body1>
              <Caption1>
                e.g. “total sales by region”, “top 5 products by revenue”. Azure OpenAI maps it to a
                visual over your model’s fields — then you can add it to the page.
              </Caption1>
            </div>
          )}
        </div>
      )}

      {hasModel && (
        <Caption1 className={styles.foot}>
          Powered by Azure OpenAI over your model’s live query results.
        </Caption1>
      )}
    </section>
  );
}

export default ReportQA;
