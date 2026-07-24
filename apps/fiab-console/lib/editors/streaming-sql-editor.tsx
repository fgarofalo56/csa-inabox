'use client';

/**
 * Streaming SQL (RisingWave) — the N7a stateful streaming-SQL editor.
 *
 * The STATEFUL tier above Azure Stream Analytics: author streaming MATERIALIZED
 * VIEWS in SQL over Azure Event Hubs (consumed through the namespace's Kafka
 * endpoint), maintained incrementally by an in-boundary RisingWave container and
 * sunk to Delta/Iceberg on your own ADLS Gen2 or served over the Postgres wire.
 *
 * Tabs, all real:
 *   • **Author** — a Monaco SQL editor over the shared G3-resizable
 *     `EditorResultsSplit`; Materialize runs CREATE MATERIALIZED VIEW on the
 *     RisingWave tier (`/api/streaming-sql/mv`), Preview runs a read-only SELECT
 *     (`/api/streaming-sql/query`).
 *   • **Materialized views** — the live status panel read from RisingWave's own
 *     catalog (`/api/streaming-sql/status`): each view's definition, backfill
 *     progress and current materialized row count (throughput as it fills).
 *   • **Sources & sinks** — dropdown-driven builders (no freeform config) that
 *     compile a structured spec to a CREATE SOURCE over the Event Hubs Kafka
 *     endpoint / a CREATE SINK to Delta/Iceberg.
 *
 * When `LOOM_RISINGWAVE_URL` is unset the surface renders FULLY with an honest
 * Fix-it gate — the stateful tier is an opt-in accelerator, never a blocker.
 * FLAG0 `n7a-streaming-sql` (default-ON) reverts the whole surface to a guided
 * notice; the tier, the routes and every other editor are unaffected.
 *
 * Azure-native / OSS: Container Apps + Event Hubs + ADLS Gen2. No Microsoft
 * Fabric, no OneLake, no Power BI (.claude/rules/no-fabric-dependency.md).
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge, Body1, Button, Caption1, Dropdown, Field, Input, Option, Spinner, Subtitle2,
  Tab, TabList, MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, DataLine20Regular, Table20Regular, ArrowSync20Regular,
  Flow20Regular, CloudFlow20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from './item-editor-chrome';
import { EditorResultsSplit } from './components/editor-results-split';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { PreviewTable, type PreviewData } from '@/lib/components/shared/preview-table';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { EmptyState } from '@/lib/components/empty-state';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import type { RibbonTab } from '@/lib/components/ribbon';
// Props are declared inline (matching SqlLabEditor and every other editor) rather
// than importing EditorProps from './registry' — registry.ts lazily imports THIS
// module, so pulling a type back out forms a cycle check-circular-deps rejects.
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

/** FLAG0 runtime kill-switch id (registered in lib/admin/runtime-flags.ts). */
export const STREAMING_SQL_FLAG_ID = 'n7a-streaming-sql';

const SAMPLE_MV_SQL = [
  '-- RisingWave maintains this view incrementally as new events arrive.',
  '-- A two-stream join: enrich orders with their customer in real time.',
  'CREATE MATERIALIZED VIEW orders_enriched AS',
  'SELECT o.order_id, o.amount, c.name AS customer_name',
  'FROM orders o',
  'JOIN customers c ON o.customer_id = c.customer_id;',
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
  form: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    maxWidth: '640px', minWidth: 0,
  },
  formRow: {
    display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0,
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
});

interface StreamingMvStatus {
  name: string;
  schema: string;
  definition?: string;
  progress?: string;
  rowCount?: number;
}
interface StatusResponse {
  ok: boolean;
  configured?: boolean;
  engine?: string;
  version?: string;
  materializedViews?: StreamingMvStatus[];
  sourceCount?: number;
  sinkCount?: number;
  unreachable?: string;
  kafkaBootstrap?: string | null;
  note?: string;
  gate?: { id: string; title?: string; remediation?: string; fixItHref?: string; missing?: string[] };
}
interface QueryResponse {
  ok: boolean;
  error?: string;
  columns?: { name: string }[];
  rows?: unknown[][];
  rowCount?: number;
  elapsedMs?: number;
}

async function fetchStatus(): Promise<StatusResponse> {
  const res = await clientFetch('/api/streaming-sql/status', { cache: 'no-store' });
  const json = (await res.json().catch(() => ({}))) as StatusResponse & { error?: string };
  if (!res.ok || json?.ok !== true) throw new Error(json?.error || `Could not read streaming status (HTTP ${res.status})`);
  return json;
}

export function StreamingSqlEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const enabled = useRuntimeFlag(STREAMING_SQL_FLAG_ID);

  const [tab, setTab] = useState<'author' | 'views' | 'connectors'>('author');
  const [sql, setSql] = useState(SAMPLE_MV_SQL);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [ddlMsg, setDdlMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Source builder state (Event Hubs → CREATE SOURCE).
  const [srcName, setSrcName] = useState('orders');
  const [srcHub, setSrcHub] = useState('');
  const [srcCols, setSrcCols] = useState('order_id varchar, customer_id varchar, amount double');
  const [srcFormat, setSrcFormat] = useState<'JSON' | 'AVRO' | 'CSV'>('JSON');

  // Sink builder state (CREATE SINK to the lake).
  const [sinkName, setSinkName] = useState('orders_enriched_sink');
  const [sinkFrom, setSinkFrom] = useState('orders_enriched');
  const [sinkFormat, setSinkFormat] = useState<'delta' | 'iceberg'>('delta');
  const [sinkContainer, setSinkContainer] = useState('gold');
  const [sinkPath, setSinkPath] = useState('streaming/orders_enriched');

  const statusQ = useQuery({ queryKey: ['streaming-sql-status'], queryFn: fetchStatus, staleTime: 15_000 });
  const configured = statusQ.data?.configured === true && !statusQ.data?.unreachable;

  const materialize = useCallback(async () => {
    setBusy(true); setDdlMsg(null); setResult(null);
    try {
      const res = await clientFetch('/api/streaming-sql/mv', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql, itemId: id }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; command?: string };
      setDdlMsg(res.ok && json.ok
        ? { ok: true, text: `Materialized (${json.command || 'CREATE MATERIALIZED VIEW'}). RisingWave is now maintaining it incrementally.` }
        : { ok: false, text: json.error || `HTTP ${res.status}` });
      if (res.ok && json.ok) void statusQ.refetch();
    } catch (e) {
      setDdlMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  }, [id, sql, statusQ]);

  const preview = useCallback(async (previewSql: string) => {
    setBusy(true); setDdlMsg(null); setResult(null);
    try {
      const res = await clientFetch('/api/streaming-sql/query', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: previewSql, maxRows: 5000, itemId: id }),
      });
      const json = (await res.json().catch(() => ({}))) as QueryResponse;
      setResult(res.ok && json.ok ? json : { ok: false, error: json.error || `HTTP ${res.status}` });
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  }, [id]);

  const buildConnector = useCallback(async (payload: Record<string, unknown>, label: string) => {
    setBusy(true); setDdlMsg(null);
    try {
      const res = await clientFetch('/api/streaming-sql/mv', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, itemId: id }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      setDdlMsg(res.ok && json.ok ? { ok: true, text: `${label} created.` } : { ok: false, text: json.error || `HTTP ${res.status}` });
      if (res.ok && json.ok) void statusQ.refetch();
    } catch (e) {
      setDdlMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  }, [id, statusQ]);

  const previewTable: PreviewData | null = useMemo(() => {
    if (!result?.ok) return null;
    return {
      columns: (result.columns || []).map((c) => c.name),
      rows: result.rows || [],
      elapsedMs: result.elapsedMs,
      rowCount: result.rowCount,
    };
  }, [result]);

  const ribbon: RibbonTab[] = useMemo(() => [
    {
      id: 'home', label: 'Home',
      groups: [
        { label: 'Materialized view', actions: [
          { label: 'Materialize', icon: <Play20Regular />, onClick: () => void materialize(), disabled: busy },
          { label: 'Preview', icon: <Table20Regular />, onClick: () => void preview(sql), disabled: busy, title: 'Run the SELECT body as a read-only query' },
        ] },
        { label: 'Status', actions: [
          { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: () => void statusQ.refetch(), title: 'Re-read the live materialized-view status' },
        ] },
      ],
    },
  ], [busy, materialize, preview, sql, statusQ]);

  if (!enabled) {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={[]} main={
        <div className={s.pane}>
          <EmptyState
            icon={<DataLine20Regular />}
            title="Streaming SQL is turned off for this deployment"
            body="An administrator has disabled the Streaming SQL surface with the n7a-streaming-sql runtime flag. The RisingWave tier, its API routes and every other editor keep working; turn the flag back on in Admin → Runtime flags to restore this surface."
          />
        </div>
      } />
    );
  }

  const st = statusQ.data;
  // RisingWave's version() reads "RisingWave <semver> (…)"; show just the semver.
  const versionNum = (String(st?.version || '').match(/\d+\.\d+(\.\d+)?/) || [])[0];
  const engineBadge = configured ? (versionNum ? `RisingWave ${versionNum}` : 'RisingWave') : 'Not deployed';

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} splitKeyPrefix="streaming-sql" main={
      <div className={s.pane}>
        <div className={s.toolbar}>
          <DataLine20Regular />
          <Subtitle2>Streaming SQL</Subtitle2>
          <Badge appearance="tint" color={configured ? 'brand' : 'informative'}>{engineBadge}</Badge>
          {configured && (
            <Badge appearance="outline">{st?.materializedViews?.length ?? 0} views · {st?.sourceCount ?? 0} sources · {st?.sinkCount ?? 0} sinks</Badge>
          )}
          <LearnPopover
            title="The stateful tier above Stream Analytics"
            content={
              'Streaming SQL runs an embedded RisingWave inside your deployment. It reads Azure Event Hubs '
              + 'through the namespace Kafka endpoint and maintains MATERIALIZED VIEWS incrementally as events '
              + 'arrive — multi-stream windowed joins and incremental aggregations that Azure Stream Analytics '
              + 'cannot express. Results sink to Delta/Iceberg on your own lake or serve over the Postgres wire. '
              + 'Stream Analytics stays the light default for simple pass-through jobs; this is the stateful tier.'
            }
          />
        </div>

        {/* Honest gate — the surface renders fully either way (no red on first open). */}
        {st && !configured && st.gate && (
          <HonestGate gateId={st.gate.id} gate={st.gate} surface="Streaming SQL" onResolved={() => void statusQ.refetch()} />
        )}
        {st?.unreachable && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>The RisingWave tier did not answer</MessageBarTitle>
              {st.unreachable}
            </MessageBarBody>
          </MessageBar>
        )}
        {ddlMsg && (
          <MessageBar intent={ddlMsg.ok ? 'success' : 'error'} layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>{ddlMsg.ok ? 'Done' : 'That statement failed'}</MessageBarTitle>
              {ddlMsg.text}
            </MessageBarBody>
          </MessageBar>
        )}

        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
          <Tab value="author" icon={<Play20Regular />}>Author</Tab>
          <Tab value="views" icon={<DataLine20Regular />}>Materialized views</Tab>
          <Tab value="connectors" icon={<CloudFlow20Regular />}>Sources &amp; sinks</Tab>
        </TabList>

        {tab === 'author' && (
          <>
            <div className={s.toolbar}>
              <Body1>Author a streaming materialized view</Body1>
              <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Play20Regular />} disabled={busy}
                onClick={() => void materialize()} style={{ marginLeft: 'auto' }}>Materialize</Button>
              <Button icon={<Table20Regular />} disabled={busy} onClick={() => void preview(sql)}>Preview</Button>
            </div>
            <EditorResultsSplit
              editorKey="streaming-sql"
              active={busy || !!result}
              query={
                <MonacoTextarea value={sql} onChange={setSql} language="sql" height={280} minHeight={200}
                  sizingKey="streaming-sql.author" ariaLabel="Streaming SQL editor" />
              }
              results={
                <>
                  {busy && <Spinner size="small" label="Working…" labelPosition="after" />}
                  {!busy && result && !result.ok && (
                    <MessageBar intent="error" layout="multiline">
                      <MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{result.error}</MessageBarBody>
                    </MessageBar>
                  )}
                  {!busy && result?.ok && (
                    <>
                      <div className={s.statusBar} role="status" aria-live="polite">
                        <Table20Regular />
                        <span>{`${(result.rowCount ?? 0).toLocaleString()} rows · ${result.elapsedMs ?? 0} ms · RisingWave`}</span>
                      </div>
                      {previewTable && (
                        <PreviewTable sources={[{ id: 'streaming-sql', label: 'Preview', data: previewTable }]}
                          showRefresh={false} ariaLabel="Streaming SQL preview" />
                      )}
                    </>
                  )}
                  {!busy && !result && (
                    <EmptyState
                      icon={<Flow20Regular />}
                      title="Author, then materialize"
                      body="Write a CREATE MATERIALIZED VIEW over your Event Hubs sources (multi-stream joins and windowed aggregations are maintained incrementally). Materialize runs it on the RisingWave tier; Preview runs the SELECT body once as a read-only query."
                      primaryAction={{ label: 'Materialize', appearance: 'primary', onClick: () => void materialize() }}
                    />
                  )}
                </>
              }
            />
          </>
        )}

        {tab === 'views' && (
          <div className={s.card}>
            <div className={s.toolbar}>
              <Subtitle2>Materialized views</Subtitle2>
              <Button size="small" icon={<ArrowSync20Regular />} onClick={() => void statusQ.refetch()} style={{ marginLeft: 'auto' }}>Refresh</Button>
            </div>
            {statusQ.isLoading && <Spinner size="small" label="Reading status…" labelPosition="after" />}
            {configured && (st?.materializedViews?.length ?? 0) === 0 && !statusQ.isLoading && (
              <EmptyState icon={<DataLine20Regular />} title="No materialized views yet"
                body="Author one on the Author tab and Materialize it — it will appear here with its live backfill progress and current row count." />
            )}
            {configured && (st?.materializedViews?.length ?? 0) > 0 && (
              <Table aria-label="Materialized views" size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>View</TableHeaderCell>
                    <TableHeaderCell>Materialized rows</TableHeaderCell>
                    <TableHeaderCell>Backfill</TableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(st?.materializedViews || []).map((mv) => (
                    <TableRow key={`${mv.schema}.${mv.name}`}>
                      <TableCell>{mv.schema === 'public' ? mv.name : `${mv.schema}.${mv.name}`}</TableCell>
                      <TableCell>{mv.rowCount === undefined ? '—' : mv.rowCount.toLocaleString()}</TableCell>
                      <TableCell>{mv.progress ? <Badge appearance="tint" color="warning">{mv.progress}</Badge> : <Badge appearance="tint" color="success">up to date</Badge>}</TableCell>
                      <TableCell>
                        <Button size="small" icon={<Table20Regular />} onClick={() => { setTab('author'); void preview(`SELECT * FROM ${mv.schema}.${mv.name}`); }}>Peek</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {!configured && (
              <Caption1>Deploy the RisingWave tier (Fix-it above) to see live materialized-view status here.</Caption1>
            )}
          </div>
        )}

        {tab === 'connectors' && (
          <div className={s.formRow}>
            {/* Event Hubs → CREATE SOURCE */}
            <div className={s.card}>
              <Subtitle2>Add an Event Hubs source</Subtitle2>
              <Caption1>
                {st?.kafkaBootstrap
                  ? `Kafka endpoint: ${st.kafkaBootstrap}`
                  : 'No Event Hubs namespace is configured (set LOOM_EVENTHUB_NAMESPACE). You can still author a source against an explicit hub.'}
              </Caption1>
              <div className={s.form}>
                <Field label="Source name"><Input value={srcName} onChange={(_, d) => setSrcName(d.value)} /></Field>
                <Field label="Event Hub (topic)"><Input value={srcHub} onChange={(_, d) => setSrcHub(d.value)} placeholder="orders" /></Field>
                <Field label="Columns (name type, …)"><Input value={srcCols} onChange={(_, d) => setSrcCols(d.value)} /></Field>
                <Field label="Payload format">
                  <Dropdown value={srcFormat} selectedOptions={[srcFormat]}
                    onOptionSelect={(_, d) => setSrcFormat((d.optionValue as 'JSON' | 'AVRO' | 'CSV') || 'JSON')}>
                    <Option value="JSON">JSON</Option>
                    <Option value="AVRO">AVRO</Option>
                    <Option value="CSV">CSV</Option>
                  </Dropdown>
                </Field>
                <Button appearance="primary" icon={<CloudFlow20Regular />} disabled={busy || !srcHub.trim() || !configured}
                  onClick={() => {
                    const columns = srcCols.split(',').map((c) => {
                      const [name, ...rest] = c.trim().split(/\s+/);
                      return { name, type: rest.join(' ') };
                    }).filter((c) => c.name && c.type);
                    const namespace = (st?.kafkaBootstrap || '').split('.')[0] || 'eventhub';
                    void buildConnector({ kind: 'eventhub-source', spec: { name: srcName, namespace, eventHub: srcHub, columns, format: srcFormat } }, 'Source');
                  }}>Create source</Button>
              </div>
            </div>

            {/* CREATE SINK → Delta / Iceberg on the lake */}
            <div className={s.card}>
              <Subtitle2>Add a lake sink</Subtitle2>
              <Caption1>Land the maintained view into Delta / Iceberg on your own ADLS Gen2.</Caption1>
              <div className={s.form}>
                <Field label="Sink name"><Input value={sinkName} onChange={(_, d) => setSinkName(d.value)} /></Field>
                <Field label="From (view or source)"><Input value={sinkFrom} onChange={(_, d) => setSinkFrom(d.value)} /></Field>
                <Field label="Format">
                  <Dropdown value={sinkFormat} selectedOptions={[sinkFormat]}
                    onOptionSelect={(_, d) => setSinkFormat((d.optionValue as 'delta' | 'iceberg') || 'delta')}>
                    <Option value="delta">Delta</Option>
                    <Option value="iceberg">Iceberg</Option>
                  </Dropdown>
                </Field>
                <div className={s.formRow}>
                  <Field label="Container"><Input value={sinkContainer} onChange={(_, d) => setSinkContainer(d.value)} /></Field>
                  <Field label="Path"><Input value={sinkPath} onChange={(_, d) => setSinkPath(d.value)} /></Field>
                </div>
                <Button appearance="primary" icon={<Flow20Regular />} disabled={busy || !sinkFrom.trim() || !configured}
                  onClick={() => void buildConnector({ kind: 'lake-sink', spec: { name: sinkName, from: sinkFrom, format: sinkFormat, container: sinkContainer, path: sinkPath } }, 'Sink')}>Create sink</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    } />
  );
}

export default StreamingSqlEditor;
