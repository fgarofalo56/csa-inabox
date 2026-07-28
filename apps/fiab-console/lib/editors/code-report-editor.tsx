'use client';

/**
 * CodeReportEditor — the N16 `code-report` item type ("Code report").
 *
 * BI-as-code (Evidence.dev / Rill / Observable class), built Loom-native: the
 * report IS a Markdown document with fenced `sql` / `sql loom` query blocks and
 * inline `{visual}` directives. A two-pane surface (draggable SplitPane, G3):
 *   • left  — the source editor (Markdown + SQL), an engine binding, syntax help.
 *   • right — a LIVE preview: prose (CopilotMarkdown), per-query timing/status,
 *             and each `{visual}` rendered as a real table / chart / KPI from the
 *             REAL backend response (POST …/render → Synapse serverless / ADX;
 *             metric blocks via the N15 governed layer). No mock data.
 *
 * ux-baseline: guided (never-red) first-open empty state, honest per-query gates,
 * type-badged status with timing, resizable panes (SplitPane + storageKey). Web3:
 * Fluent v9 + Loom tokens only. Azure-native (no Fabric/Power BI on this path).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Caption1, Card, Dropdown, Field, MessageBar, MessageBarBody,
  MessageBarTitle, Option, Spinner, Subtitle2, Textarea, Text,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Save20Regular, Code24Regular, DocumentText20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from './item-editor-chrome';
import type { RibbonTab } from '@/lib/components/ribbon';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { CopilotMarkdown } from '@/lib/components/copilot/markdown';
import { LoomChart, type LoomChartType } from '@/lib/components/charts/loom-chart';
import {
  CODE_REPORT_ENGINES,
  type CodeReportEngine,
  type CodeReportNode,
  type VisualDirective,
} from '@/lib/code-report/parse';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

// Props declared INLINE (not imported from ./registry) so the editor does not
// form an import cycle with the registry that lazily imports it (the documented
// editor convention). Structurally identical to the registry's EditorProps.
interface CodeReportEditorProps {
  item: FabricItemType;
  id: string;
}

// ── Server response shapes (mirror app/api/items/code-report/[id]/render) ─────

interface QueryResultOk {
  ok: true;
  name: string;
  kind: 'raw' | 'metric';
  engine: CodeReportEngine;
  dialect: 'synapse' | 'kql';
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionMs: number;
  cached: boolean;
  sql: string;
}
interface QueryResultErr {
  ok: false;
  name: string;
  kind: 'raw' | 'metric';
  status: number;
  code?: string;
  missing?: string;
  error: string;
}
type QueryResult = QueryResultOk | QueryResultErr;

interface RenderResponse {
  ok: boolean;
  nodes: CodeReportNode[];
  results: Record<string, QueryResult>;
  engine: CodeReportEngine;
  empty?: boolean;
  error?: string;
  code?: string;
}

const STARTER = `# Revenue overview

A code report is Markdown plus fenced query blocks and visual directives.
Edit this source, pick an engine, then **Run** to render live data.

## Governed metric (resolves through the metrics layer)

\`\`\`sql loom revenue_by_month
metric: revenue
dimensions: order_month
grain: month
\`\`\`

{line query=revenue_by_month x=order_month y=revenue title="Revenue by month"}

## Raw query (runs read-only on the bound engine)

\`\`\`sql top_products
SELECT product_name, SUM(amount) AS revenue
FROM analytics.sales
GROUP BY product_name
ORDER BY revenue DESC
\`\`\`

{table query=top_products}
`;

const ENGINE_LABELS: Record<CodeReportEngine, string> = {
  synapse: 'Synapse serverless (T-SQL)',
  lakehouse: 'Lakehouse (serverless T-SQL over Delta)',
  adx: 'Azure Data Explorer (KQL)',
};

const useStyles = makeStyles({
  leftPane: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
  },
  leftHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    minWidth: 0,
  },
  engineField: { minWidth: '220px', flex: 1 },
  editor: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  textarea: {
    flex: 1,
    minHeight: 0,
    // A code surface: monospace + no wrap so SQL lines read like an editor.
    '& textarea': {
      fontFamily: tokens.fontFamilyMonospace,
      fontSize: tokens.fontSizeBase200,
      lineHeight: tokens.lineHeightBase300,
      whiteSpace: 'pre',
      overflowWrap: 'normal',
    },
  },
  preview: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalL,
    padding: tokens.spacingVerticalM,
    minHeight: 0,
    height: '100%',
    overflowY: 'auto',
  },
  statusStrip: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
    marginBottom: tokens.spacingVerticalS,
  },
  visualCard: {
    padding: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    minWidth: 0,
  },
  visualTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  kpiValue: { color: tokens.colorBrandForeground1 },
  tableWrap: { overflowX: 'auto', minWidth: 0 },
  dim: { color: tokens.colorNeutralForeground3 },
  errorMd: { color: tokens.colorNeutralForeground2 },
});

/** Map a directive visual type to the LoomChart geometry type. */
function chartType(type: VisualDirective['type']): LoomChartType {
  switch (type) {
    case 'bar': return 'column';
    case 'line': return 'line';
    case 'area': return 'area';
    case 'scatter': return 'scatter';
    default: return 'column';
  }
}

/** Reshape a query's rows for a chart: [x, y] pairs, or a series pivot. */
function chartRows(res: QueryResultOk, v: VisualDirective): Array<Record<string, unknown>> {
  const x = v.x!;
  const y = v.y!;
  if (v.series) {
    const byX = new Map<string, Record<string, unknown>>();
    for (const r of res.rows) {
      const xv = String(r[x]);
      const sv = String(r[v.series]);
      if (!byX.has(xv)) byX.set(xv, { [x]: r[x] });
      const yn = Number(r[y]);
      byX.get(xv)![sv] = Number.isFinite(yn) ? yn : r[y];
    }
    return [...byX.values()];
  }
  return res.rows.map((r) => {
    const yn = Number(r[y]);
    return { [x]: r[x], [y]: Number.isFinite(yn) ? yn : r[y] };
  });
}

export function CodeReportEditor({ item, id }: CodeReportEditorProps) {
  const styles = useStyles();
  const isNew = id === 'new';

  const [source, setSource] = useState('');
  const [savedSource, setSavedSource] = useState('');
  const [engine, setEngine] = useState<CodeReportEngine>('synapse');
  const [savedEngine, setSavedEngine] = useState<CodeReportEngine>('synapse');
  const [displayName, setDisplayName] = useState<string | undefined>();
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [rendered, setRendered] = useState<RenderResponse | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const autoRan = useRef(false);

  const dirty = source !== savedSource || engine !== savedEngine;

  // Load stored source + engine.
  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    setLoading(true);
    clientFetch(`/api/items/code-report/${id}/content`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j && j.ok !== false) {
          const src = typeof j.source === 'string' ? j.source : '';
          const eng = (CODE_REPORT_ENGINES as readonly string[]).includes(j.engine) ? (j.engine as CodeReportEngine) : 'synapse';
          setSource(src);
          setSavedSource(src);
          setEngine(eng);
          setSavedEngine(eng);
          setDisplayName(typeof j.displayName === 'string' ? j.displayName : undefined);
        }
      })
      .catch(() => { /* leave empty — guided state renders */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, isNew]);

  const runRender = useCallback(async () => {
    if (isNew) return;
    setRunning(true);
    setRenderError(null);
    try {
      const r = await clientFetch(`/api/items/code-report/${id}/render`, { method: 'POST' });
      const j = (await r.json()) as RenderResponse;
      if (!r.ok || j.ok === false) {
        setRenderError(j.error || `Render failed (HTTP ${r.status})`);
        setRendered(null);
      } else {
        setRendered(j);
      }
    } catch (e) {
      setRenderError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [id, isNew]);

  const save = useCallback(async (opts?: { thenRun?: boolean }) => {
    if (isNew) return;
    setSaving(true);
    try {
      const r = await clientFetch(`/api/items/code-report/${id}/content`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, engine }),
      });
      const j = await r.json();
      if (r.ok && j.ok !== false) {
        setSavedSource(source);
        setSavedEngine(engine);
        if (opts?.thenRun) await runRender();
      } else {
        setRenderError(j.error || `Save failed (HTTP ${r.status})`);
      }
    } catch (e) {
      setRenderError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [id, isNew, source, engine, runRender]);

  // Auto-render once after the first load of a non-empty report.
  useEffect(() => {
    if (isNew || loading || autoRan.current) return;
    if (savedSource.trim() !== '') {
      autoRan.current = true;
      void runRender();
    }
  }, [isNew, loading, savedSource, runRender]);

  const ribbon: RibbonTab[] = useMemo(() => [
    {
      id: 'home',
      label: 'Home',
      groups: [
        {
          label: 'File',
          actions: [
            { label: saving ? 'Saving…' : 'Save', icon: <Save20Regular />, appearance: 'primary',
              onClick: () => void save(), disabled: saving || !dirty || isNew },
          ],
        },
        {
          label: 'Run',
          actions: [
            { label: running ? 'Running…' : 'Run', icon: <Play20Regular />,
              onClick: () => void save({ thenRun: true }), disabled: running || saving || isNew,
              title: 'Save and execute every query block against the real backend' },
          ],
        },
      ],
    },
  ], [saving, dirty, isNew, running, save]);

  // ── Guided (never-red) empty state for a brand-new / untouched report ──
  const showGuided = !isNew && !loading && source.trim() === '' && !touched;

  const leftPanel = (
    <div className={styles.leftPane}>
      <div className={styles.leftHeader}>
        <Field label="Engine (raw sql blocks)" className={styles.engineField}>
          <Dropdown
            aria-label="Bound engine for raw sql blocks"
            value={ENGINE_LABELS[engine]}
            selectedOptions={[engine]}
            onOptionSelect={(_, d) => { if (d.optionValue) { setEngine(d.optionValue as CodeReportEngine); setTouched(true); } }}
          >
            {CODE_REPORT_ENGINES.map((e) => (
              <Option key={e} value={e} text={ENGINE_LABELS[e]}>{ENGINE_LABELS[e]}</Option>
            ))}
          </Dropdown>
        </Field>
        <LearnPopover
          title="Code report syntax"
          content="Markdown, plus fenced query blocks and visual directives:"
          tips={[
            '```sql name … ``` — a raw read-only query on the bound engine',
            '```sql loom name → metric: <id> — a governed metric (one number everywhere)',
            '{table query=name} — render a query as a table',
            '{bar|line|area query=name x=col y=col} — render a chart',
            '{bignumber query=name value=col} — a KPI',
          ]}
          learnMoreHref="https://docs.evidence.dev/core-concepts/queries/"
        />
      </div>
      <div className={styles.editor}>
        <Textarea
          className={styles.textarea}
          aria-label="Code report source — Markdown with SQL query blocks and visual directives"
          resize="none"
          value={source}
          placeholder="# My report&#10;&#10;Write Markdown, then add ```sql name``` blocks and {visual …} directives."
          onChange={(_, d) => { setSource(d.value); setTouched(true); }}
        />
      </div>
    </div>
  );

  const main = (
    <div className={styles.preview}>
      {loading ? (
        <Spinner label="Loading report…" />
      ) : isNew ? (
        <GuidedEmptyState
          title="Create a Code report"
          intro="Open a workspace and use + New item → Code report to create one, then author it here."
          heroIcon={Code24Regular}
          paths={[]}
          learnMoreHref="https://docs.evidence.dev/"
        />
      ) : showGuided ? (
        <GuidedEmptyState
          title="Author your report as code"
          intro="A code report is one versionable Markdown + SQL document — PR-reviewed, CI-tested, diff-able. Start from an example or write your own, then Run to render live data."
          heroIcon={DocumentText20Regular}
          paths={[
            {
              key: 'starter',
              title: 'Start from an example',
              body: 'Insert a starter report with a governed metric chart and a raw-SQL table.',
              icon: Code24Regular,
              onClick: () => { setSource(STARTER); setTouched(true); },
            },
            {
              key: 'blank',
              title: 'Start blank',
              body: 'Begin with an empty document and build it up block by block.',
              icon: DocumentText20Regular,
              onClick: () => { setSource('# New report\n\n'); setTouched(true); },
            },
          ]}
          learnMoreHref="https://docs.evidence.dev/core-concepts/queries/"
        />
      ) : (
        <Preview rendered={rendered} renderError={renderError} running={running} dirty={dirty} styles={styles} />
      )}
    </div>
  );

  // The whole editor body is ONE horizontal SplitPane (source ↔ preview),
  // rendered as the chrome's full-width `main` (no left/right rail) so the
  // divider spans the entire body. G3: draggable + persisted via storageKey.
  const body = (
    <SplitPane
      direction="horizontal"
      primary="first"
      storageKey="code-report.source"
      defaultSize="46%"
      minSize={280}
      dividerLabel="Resize the source and preview panes"
    >
      {leftPanel}
      {main}
    </SplitPane>
  );

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      displayName={displayName}
      dirty={dirty}
      main={body}
    />
  );
}

// ── Preview ──────────────────────────────────────────────────────────────────

function Preview({
  rendered, renderError, running, dirty, styles,
}: {
  rendered: RenderResponse | null;
  renderError: string | null;
  running: boolean;
  dirty: boolean;
  styles: ReturnType<typeof useStyles>;
}) {
  if (running && !rendered) return <Spinner label="Running queries…" />;
  if (renderError) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>Could not render</MessageBarTitle>
          {renderError}
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (!rendered) {
    return <Caption1 className={styles.dim}>Press Run to execute the report against live data.</Caption1>;
  }
  if (rendered.empty || rendered.nodes.length === 0) {
    return <Caption1 className={styles.dim}>Nothing to render yet — add Markdown, query blocks, and {'{visual}'} directives.</Caption1>;
  }

  const results = rendered.results || {};
  const queryNames = Object.keys(results);

  return (
    <>
      {dirty && (
        <MessageBar intent="info">
          <MessageBarBody>Unsaved edits — press Run to re-execute with your latest changes.</MessageBarBody>
        </MessageBar>
      )}
      {queryNames.length > 0 && (
        <div className={styles.statusStrip} aria-label="Query status">
          {queryNames.map((n) => {
            const r = results[n];
            return r.ok ? (
              <Badge key={n} appearance="tint" color="success">
                {n}: {r.rowCount} rows · {r.executionMs}ms{r.cached ? ' · cached' : ''}
              </Badge>
            ) : (
              <Badge key={n} appearance="tint" color={r.code === 'not_configured' ? 'warning' : 'danger'}>
                {n}: {r.code === 'not_configured' ? 'not configured' : 'error'}
              </Badge>
            );
          })}
        </div>
      )}
      {rendered.nodes.map((node, i) => (
        <PreviewNode key={i} node={node} results={results} styles={styles} />
      ))}
    </>
  );
}

function PreviewNode({
  node, results, styles,
}: {
  node: CodeReportNode;
  results: Record<string, QueryResult>;
  styles: ReturnType<typeof useStyles>;
}) {
  if (node.kind === 'markdown') {
    return <CopilotMarkdown source={node.text} />;
  }
  if (node.kind === 'query') {
    // Query blocks are invisible in the rendered report (their status shows in
    // the strip above) — Evidence-parity.
    return null;
  }
  // Visual.
  const v = node.visual;
  const res = results[v.query];
  if (!res) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>Visual references an unknown query “{v.query}”.</MessageBarBody>
      </MessageBar>
    );
  }
  if (!res.ok) {
    const isGate = res.code === 'not_configured' || res.code === 'code_report_off' || res.code === 'no_metrics_spec';
    return (
      <MessageBar intent={isGate ? 'warning' : 'error'}>
        <MessageBarBody>
          <MessageBarTitle>{v.title || v.query}</MessageBarTitle>
          {res.error}{res.missing ? ` (set ${res.missing})` : ''}
        </MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <Card className={styles.visualCard}>
      {v.title && (
        <div className={styles.visualTitle}>
          <Subtitle2>{v.title}</Subtitle2>
          <Badge appearance="outline" color={res.kind === 'metric' ? 'brand' : 'informative'}>
            {res.kind === 'metric' ? 'governed metric' : res.dialect === 'kql' ? 'KQL' : 'SQL'}
          </Badge>
        </div>
      )}
      <VisualBody v={v} res={res} styles={styles} />
    </Card>
  );
}

function VisualBody({
  v, res, styles,
}: {
  v: VisualDirective;
  res: QueryResultOk;
  styles: ReturnType<typeof useStyles>;
}) {
  if (res.rowCount === 0) {
    return <Caption1 className={styles.dim}>No rows returned.</Caption1>;
  }

  if (v.type === 'table') {
    const rows = res.rows.slice(0, 200);
    return (
      <div className={styles.tableWrap}>
        <Table aria-label={v.title || `${v.query} table`} size="small">
          <TableHeader>
            <TableRow>
              {res.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, ri) => (
              <TableRow key={ri}>
                {res.columns.map((c) => <TableCell key={c}>{formatCell(r[c])}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {res.rowCount > rows.length && (
          <Caption1 className={styles.dim}>Showing {rows.length} of {res.rowCount} rows.</Caption1>
        )}
      </div>
    );
  }

  if (v.type === 'bignumber') {
    const col = v.value!;
    const raw = res.rows[0]?.[col];
    return (
      <div>
        <Text size={900} weight="bold" className={styles.kpiValue} block>{formatCell(raw)}</Text>
        <Caption1 className={styles.dim}>{v.label || col}</Caption1>
      </div>
    );
  }

  // Cartesian chart (bar → column, line, area, scatter).
  const rows = chartRows(res, v);
  return <LoomChart type={chartType(v.type)} rows={rows} title={v.title} height={280} />;
}

/** Render a cell value for the preview table (compact, locale-formatted numbers). */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return String(v);
}
