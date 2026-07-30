'use client';

/**
 * SQL Lab (DuckDB) — the interactive query surface for the N2b serving tier.
 *
 * Three tabs, all real:
 *   • **Query** — Monaco T-SQL/DuckDB editor over the shared U6
 *     `EditorResultsSplit`, executing on the loom-duckdb Container App (embedded
 *     DuckDB reading Delta / Iceberg / Parquet in place on the deployment's own
 *     ADLS Gen2 through a managed identity). When `LOOM_DUCKDB_URL` is unset the
 *     SAME statement runs on **Synapse Serverless** — the surface is never
 *     blocked, and the status bar always names the engine that answered.
 *   • **Local analysis** — N2a: fetch the result's Arrow IPC once, then slice /
 *     filter / aggregate it in the browser on duckdb-wasm with a timing bar that
 *     proves zero network requests.
 *   • **Connect** — N3: ADBC / Flight SQL / JDBC snippets and a short-lived,
 *     Entra-scoped ticket minted through the audited BFF.
 *
 * FLAG0 `n2b-sql-lab-duckdb` (default-ON) reverts the whole surface to a guided
 * notice on the next render — the serving tier, the routes and every other
 * editor are unaffected.
 *
 * Azure-native: Container Apps + ADLS Gen2 + Synapse Serverless. No Microsoft
 * Fabric, no OneLake, no Power BI (.claude/rules/no-fabric-dependency.md).
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge, Body1, Button, Caption1, Spinner, Subtitle2, Tab, TabList,
  Dropdown, Option, Field,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Flash20Regular, PlugConnected20Regular, Database20Regular,
  DocumentTable20Regular, BranchFork20Regular,
} from '@fluentui/react-icons';
import { transpilePrqlToSql, PrqlTranspileError, type QueryLanguage } from '@/lib/query/prql-transpile';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from './item-editor-chrome';
import { EditorResultsSplit } from './components/editor-results-split';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { PreviewTable, type PreviewData } from '@/lib/components/shared/preview-table';
import { LocalAnalysisPanel, type LocalArrowSource } from '@/lib/components/shared/local-analysis-panel';
import { ConnectTab } from '@/lib/components/shared/connect-tab';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { EmptyState } from '@/lib/components/empty-state';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import type { RibbonTab } from '@/lib/components/ribbon';
// Props are declared inline (matching WarehouseEditor and every other editor)
// rather than importing EditorProps from './registry'. registry.ts lazily
// imports THIS module, so pulling a type back out of it forms a
// sql-lab-editor → registry cycle that check-circular-deps rejects.
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

/** FLAG0 runtime kill-switch id (registered in lib/admin/runtime-flags.ts). */
export const SQL_LAB_FLAG_ID = 'n2b-sql-lab-duckdb';
/** N8 lab 2 — the PRQL "modern query" toggle FLAG0 id (default-ON). */
export const MODERN_QUERY_FLAG_ID = 'n8-modern-query-prql';

/**
 * N7e FLAG0 id for the OPT-IN "Federated SQL (Trino)" engine choice. Declared as
 * a plain string here (NOT imported from lib/azure/trino-client, which is
 * server-only) so this client editor never pulls the server bundle. DEFAULT OFF
 * — the documented exception to loom_default_on_opt_out (heavy AKS carve-out);
 * DuckDB stays the default engine either way.
 */
export const TRINO_FLAG_ID = 'n7e-trino-federation';
/** The Trino gate id (mirrors svc-loom-trino in the gate registry). */
const TRINO_GATE_ID = 'svc-loom-trino';

/** Which engine the query toolbar runs against. DuckDB/Serverless is the default. */
type SqlEngine = 'default' | 'trino';

const SAMPLE_SQL = [
  '-- DuckDB reads your lake in place — no copy, no import, no Spark session.',
  "-- SELECT * FROM delta_scan('abfss://gold@<account>.dfs.core.windows.net/sales') LIMIT 100;",
  "-- SELECT * FROM read_parquet('abfss://bronze@<account>.dfs.core.windows.net/events/*.parquet');",
  '',
  'SELECT 1 AS hello',
].join('\n');

/** N8 lab 2 — a PRQL starter that transpiles to a real SELECT over the engine. */
const SAMPLE_PRQL = [
  '# PRQL (Apache-2.0) — a pipelined query language that transpiles to SQL.',
  '# Each step reads like a pipe; Loom runs the resulting SQL on the DuckDB engine.',
  '# Point `from` at a real table (or a delta_scan/read_parquet call) to query the lake.',
  '',
  'from t',
  'take 100',
].join('\n');

const useStyles = makeStyles({
  pane: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, minWidth: 0, minHeight: 0, flex: 1,
  },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
  },
  statusBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  langPicker: { minWidth: '150px' },
  genSql: {
    marginTop: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
  },
});

interface SqlLabResponse {
  ok: boolean;
  error?: string;
  engine?: 'duckdb' | 'synapse-serverless' | 'trino';
  columns?: { name: string; type: string }[];
  rows?: unknown[][];
  rowCount?: number;
  elapsedMs?: number;
  totalMs?: number;
  truncated?: boolean;
  /** N7e — distinct Trino catalogs the planner touched (federation receipt). */
  catalogs?: string[];
  note?: string;
  /** WS-D2 gate envelope when the opt-in Trino engine is not wired. */
  gated?: boolean;
  gate?: { id: string; title?: string; remediation?: string; fixItHref?: string; missing?: string[] };
}

interface CapabilitiesResponse {
  ok: boolean;
  configured?: boolean;
  engine?: 'duckdb' | 'synapse-serverless';
  capabilities?: { version?: string; extensions?: string[]; lakeAccount?: string };
  unreachable?: string;
  gate?: { id: string; title?: string; remediation?: string; fixItHref?: string; missing?: string[] };
  fallback?: { engine: string; note: string };
  flight?: { configured: boolean; exposure: string; note: string };
}

async function fetchCapabilities(): Promise<CapabilitiesResponse> {
  const res = await clientFetch('/api/duckdb/capabilities', { cache: 'no-store' });
  const json = (await res.json().catch(() => ({}))) as CapabilitiesResponse & { error?: string };
  if (!res.ok || json?.ok !== true) {
    throw new Error(json?.error || `Could not read engine capabilities (HTTP ${res.status})`);
  }
  return json;
}

export function SqlLabEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const enabled = useRuntimeFlag(SQL_LAB_FLAG_ID);
  // N7e — the opt-in Federated SQL (Trino) engine choice. DEFAULT OFF.
  const trinoEnabled = useRuntimeFlag(TRINO_FLAG_ID, false);
  // N8 lab 2 — the PRQL "modern query" toggle (default-ON, opt-out via FLAG0).
  const modernQueryEnabled = useRuntimeFlag(MODERN_QUERY_FLAG_ID);

  const [tab, setTab] = useState<'query' | 'local' | 'connect'>('query');
  const [sql, setSql] = useState(SAMPLE_SQL);
  // Separate PRQL buffer so switching languages never clobbers the SQL editor.
  const [prql, setPrql] = useState(SAMPLE_PRQL);
  const [lang, setLang] = useState<QueryLanguage>('sql');
  const [transpiledSql, setTranspiledSql] = useState<string | null>(null);
  const [transpileError, setTranspileError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SqlLabResponse | null>(null);
  // Engine picker: DuckDB/Serverless (default) or the opt-in Trino federation.
  const [engine, setEngine] = useState<SqlEngine>('default');

  // When the modern-query flag is OFF, force SQL — the toggle disappears and the
  // surface reverts to SQL-only (FLAG0 revert story).
  const activeLang: QueryLanguage = modernQueryEnabled ? lang : 'sql';

  const capsQ = useQuery({
    queryKey: ['sql-lab-capabilities'],
    queryFn: fetchCapabilities,
    staleTime: 60_000,
  });

  const run = useCallback(async () => {
    setRunning(true);
    setResult(null);
    setTranspileError(null);
    setTranspiledSql(null);

    // N8: in PRQL mode transpile FIRST. On any unsupported construct we surface
    // the honest error and refuse to run — never a fabricated query.
    let runnableSql = sql;
    if (activeLang === 'prql') {
      try {
        runnableSql = transpilePrqlToSql(prql);
        setTranspiledSql(runnableSql);
      } catch (e) {
        setTranspileError(
          e instanceof PrqlTranspileError || e instanceof Error ? e.message : String(e),
        );
        setRunning(false);
        return;
      }
    }

    // The DEFAULT engine hits the DuckDB edge (with the Synapse Serverless
    // fallback). The opt-in Trino engine hits its own audited edge, which returns
    // the honest opt-in gate envelope when LOOM_TRINO_URL is unset. A disabled
    // FLAG0 can never route to Trino — DuckDB stays the default either way.
    const useTrino = engine === 'trino' && trinoEnabled;
    const endpoint = useTrino ? '/api/sql/trino' : '/api/duckdb/query';
    try {
      const res = await clientFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: runnableSql, maxRows: 5000, itemId: id }),
      });
      const json = (await res.json().catch(() => ({}))) as SqlLabResponse;
      if (res.ok && json.ok) {
        setResult(json);
      } else if (json.gated && json.gate) {
        // Preserve the gate envelope so the surface renders the Fix-it wizard
        // (Trino discloses the AKS cost) instead of a bare error.
        setResult({ ok: false, gated: true, gate: json.gate, error: json.error });
      } else {
        setResult({ ok: false, error: json.error || `HTTP ${res.status}` });
      }
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  }, [engine, trinoEnabled, activeLang, id, prql, sql]);

  const preview: PreviewData | null = useMemo(() => {
    if (!result?.ok) return null;
    return {
      columns: (result.columns || []).map((c) => c.name),
      rows: result.rows || [],
      elapsedMs: result.elapsedMs,
      rowCount: result.rowCount,
      truncated: result.truncated,
      note: result.note,
    };
  }, [result]);

  /** N2a source: the SAME statement, asked for as an Arrow IPC stream. */
  const arrowConfigured = capsQ.data?.configured === true;
  const localSource: LocalArrowSource = useMemo(() => ({
    label: 'query result',
    ready: arrowConfigured,
    unavailableNote: arrowConfigured
      ? undefined
      : 'Local analysis reuses the Arrow stream the DuckDB serving tier returns. This deployment runs SQL '
        + 'Lab on Synapse Serverless (LOOM_DUCKDB_URL is unset), which returns JSON, so there is no Arrow '
        + 'payload to analyze in the browser yet. Your query still runs — deploying the DuckDB tier adds '
        + 'this free client-side tier on top.',
    fetchArrow: async () => {
      const started = performance.now();
      const res = await clientFetch('/api/duckdb/query?format=arrow', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql, maxRows: 200000, itemId: id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Arrow fetch failed (HTTP ${res.status})`);
      }
      const buffer = await res.arrayBuffer();
      return {
        arrow: new Uint8Array(buffer),
        fetchMs: performance.now() - started,
        rows: Number(res.headers.get('x-loom-row-count') || 0),
      };
    },
  }), [arrowConfigured, id, sql]);

  const ribbon: RibbonTab[] = useMemo(() => [
    {
      id: 'home',
      label: 'Home',
      groups: [
        { label: 'Query', actions: [
          { label: 'Run', icon: <Play20Regular />, onClick: () => void run(), disabled: running },
        ] },
        { label: 'Tiers', actions: [
          { label: 'Local analysis', icon: <Flash20Regular />, onClick: () => setTab('local'), title: 'Slice the fetched Arrow result in your browser — zero server cost' },
          { label: 'Connect', icon: <PlugConnected20Regular />, onClick: () => setTab('connect'), title: 'ADBC / Flight SQL / JDBC snippets and a short-lived access ticket' },
        ] },
      ],
    },
  ], [run, running]);

  if (!enabled) {
    return (
      <ItemEditorChrome
        item={item}
        id={id}
        ribbon={[]}
        main={
          <div className={s.pane}>
            <EmptyState
              icon={<Database20Regular />}
              title="SQL Lab is turned off for this deployment"
              body="An administrator has disabled the SQL Lab surface with the n2b-sql-lab-duckdb runtime flag. The serving tier, its API routes and every other editor keep working; turn the flag back on in Admin → Runtime flags to restore this surface."
            />
          </div>
        }
      />
    );
  }

  const caps = capsQ.data;
  const engineBadge = caps?.configured
    ? `DuckDB ${caps.capabilities?.version || ''}`.trim()
    : 'Synapse Serverless';

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      splitKeyPrefix="sql-lab"
      main={
        <div className={s.pane}>
          <div className={s.toolbar}>
            <Database20Regular />
            <Subtitle2>SQL Lab</Subtitle2>
            <Badge appearance="tint" color={caps?.configured ? 'brand' : 'informative'}>{engineBadge}</Badge>
            {caps?.capabilities?.extensions?.length ? (
              <Badge appearance="outline">{caps.capabilities.extensions.join(' · ')}</Badge>
            ) : null}
            <LearnPopover
              title="The fast path below Spark"
              content={
                'SQL Lab runs an embedded DuckDB inside your deployment. It reads Delta, Iceberg and '
                + 'Parquet in place on your own ADLS Gen2 through a managed identity that holds Storage '
                + 'Blob Data READER — so it can query everything and change nothing. A Spark session costs '
                + '1–5 minutes to start; this tier answers in under a second, which is why interactive work '
                + 'belongs here and big joins, writes and ML belong on Spark. When the tier is not deployed '
                + 'the same SQL runs on Synapse Serverless — identical results, more latency.'
              }
            />
          </div>

          {/* Capability chip / honest gate — the surface renders fully either way. */}
          {caps && !caps.configured && caps.gate && (
            <HonestGate
              gateId={caps.gate.id}
              gate={caps.gate}
              surface="SQL Lab"
              onResolved={() => void capsQ.refetch()}
            />
          )}
          {caps?.unreachable && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>The DuckDB serving tier did not answer</MessageBarTitle>
                {caps.unreachable}
              </MessageBarBody>
            </MessageBar>
          )}

          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
            <Tab value="local" icon={<Flash20Regular />}>Local analysis</Tab>
            <Tab value="connect" icon={<PlugConnected20Regular />}>Connect</Tab>
          </TabList>

          {tab === 'query' && (
            <>
              <div className={s.toolbar}>
                <Body1>
                  {activeLang === 'prql' ? 'Read-only PRQL over your lake' : 'Read-only SQL over your lake'}
                </Body1>
                {/* N8 — PRQL modern-query language toggle (Preview, default-ON). */}
                {modernQueryEnabled && (
                  <Field label="Language" orientation="horizontal">
                    <Dropdown
                      className={s.langPicker}
                      size="small"
                      selectedOptions={[lang]}
                      value={lang === 'prql' ? 'PRQL (Preview)' : 'SQL'}
                      onOptionSelect={(_, d) => {
                        setLang((d.optionValue as QueryLanguage) || 'sql');
                        setTranspileError(null);
                        setTranspiledSql(null);
                      }}
                      aria-label="Query language"
                    >
                      <Option value="sql" text="SQL">SQL</Option>
                      <Option value="prql" text="PRQL (Preview)">PRQL (Preview)</Option>
                    </Dropdown>
                  </Field>
                )}
                {/* Engine picker — DuckDB is ALWAYS the default; Trino is the
                    additive opt-in federation choice, shown only when its FLAG0
                    is on (default OFF). */}
                <Field label="Engine" orientation="horizontal">
                  <Dropdown
                    size="small"
                    value={engine === 'trino' ? 'Federated SQL (Trino)' : 'DuckDB / Serverless (default)'}
                    selectedOptions={[engine]}
                    onOptionSelect={(_, d) => setEngine((d.optionValue as SqlEngine) || 'default')}
                    aria-label="SQL Lab engine"
                    style={{ minWidth: 0 }}
                  >
                    <Option value="default" text="DuckDB / Serverless (default)">
                      DuckDB / Serverless (default)
                    </Option>
                    {trinoEnabled && (
                      <Option value="trino" text="Federated SQL (Trino)">
                        Federated SQL (Trino) — opt-in
                      </Option>
                    )}
                  </Dropdown>
                </Field>
                {engine === 'trino' && (
                  <Badge appearance="tint" color="informative" icon={<BranchFork20Regular />}>
                    cross-source join
                  </Badge>
                )}
                {activeLang === 'prql' && (
                  <Badge appearance="tint" color="warning" size="small">Preview</Badge>
                )}
                <Button
                  appearance="primary"
                  icon={running ? <Spinner size="tiny" /> : <Play20Regular />}
                  disabled={running}
                  onClick={() => void run()}
                  style={{ marginLeft: 'auto' }}
                >
                  Run
                </Button>
              </div>
              <EditorResultsSplit
                editorKey="sql-lab"
                active={running || !!result || !!transpileError}
                query={
                  <MonacoTextarea
                    value={activeLang === 'prql' ? prql : sql}
                    onChange={activeLang === 'prql' ? setPrql : setSql}
                    language="sql"
                    height={260}
                    minHeight={180}
                    sizingKey="sql-lab.query"
                    ariaLabel={activeLang === 'prql' ? 'SQL Lab PRQL editor' : 'SQL Lab query editor'}
                  />
                }
                results={
                  <>
                    {transpileError && (
                      <MessageBar intent="error" layout="multiline">
                        <MessageBarBody>
                          <MessageBarTitle>Unsupported PRQL</MessageBarTitle>
                          {transpileError} No query was run — Loom never fabricates SQL from PRQL it cannot translate.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {activeLang === 'prql' && transpiledSql && !transpileError && (
                      <div>
                        <Caption1>Generated SQL (ran on the engine):</Caption1>
                        <div className={s.genSql}>{transpiledSql}</div>
                      </div>
                    )}
                    {running && <Spinner size="small" label="Executing…" labelPosition="after" />}
                    {/* N7e opt-in gate — the Trino engine is not wired. Render the
                        shared Fix-it (discloses the AKS cost) instead of an error;
                        DuckDB stays selectable and fully functional. */}
                    {!running && result && !result.ok && result.gated && result.gate && (
                      <HonestGate
                        gateId={result.gate.id || TRINO_GATE_ID}
                        gate={result.gate}
                        surface="Federated SQL (Trino)"
                        onResolved={() => void run()}
                      />
                    )}
                    {!running && result && !result.ok && !result.gated && (
                      <MessageBar intent="error" layout="multiline">
                        <MessageBarBody>
                          <MessageBarTitle>Query failed</MessageBarTitle>
                          {result.error}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {!running && result?.ok && (
                      <>
                        <div className={s.statusBar} role="status" aria-live="polite">
                          <DocumentTable20Regular />
                          <span>
                            {`${(result.rowCount ?? 0).toLocaleString()} rows · ${result.elapsedMs ?? 0} ms engine · `
                              + `${result.totalMs ?? 0} ms round-trip · ${result.engine}`}
                          </span>
                          {result.truncated && <Badge appearance="outline" color="warning">truncated</Badge>}
                        </div>
                        {result.note && <Caption1>{result.note}</Caption1>}
                        {preview && (
                          <PreviewTable
                            sources={[{ id: 'sql-lab', label: 'Results', data: preview }]}
                            showRefresh={false}
                            ariaLabel="SQL Lab results"
                          />
                        )}
                      </>
                    )}
                    {!running && !result && !transpileError && (
                      <EmptyState
                        icon={<Play20Regular />}
                        title="Run a query to see results"
                        body={
                          activeLang === 'prql'
                            ? 'Write a PRQL pipeline (from … | filter … | derive … | group … | sort … | take …). Loom transpiles the supported subset to SQL and runs it on the same DuckDB engine — the generated SQL is shown above the results.'
                            : 'Point DuckDB at a Delta table with delta_scan(), a Parquet folder with read_parquet(), or an Iceberg table with iceberg_scan() — all read in place on your own lake.'
                        }
                        primaryAction={{ label: 'Run query', appearance: 'primary', onClick: () => void run() }}
                      />
                    )}
                  </>
                }
              />
            </>
          )}

          {tab === 'local' && (
            <LocalAnalysisPanel source={localSource} sizingKey="sql-lab.local" />
          )}

          {tab === 'connect' && (
            <ConnectTab surface="SQL Lab" sampleSql={sql} itemId={id} />
          )}
        </div>
      }
    />
  );
}

export default SqlLabEditor;
