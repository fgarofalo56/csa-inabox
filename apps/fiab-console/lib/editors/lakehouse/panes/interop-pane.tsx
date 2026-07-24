'use client';

/**
 * N1 — Lakehouse → INTEROP tab. The zero-copy bridge between Loom's Delta
 * tables and every external engine.
 *
 * What it does (all real, per no-vaporware.md):
 *   • Lists the container's REAL Delta tables (the live catalog the Tables tab
 *     reads) and, for each, a "Expose as Iceberg / Delta" switch. Flipping it
 *     PUTs /api/lakehouse/interop, which submits a REAL Synapse Spark job that
 *     writes Apache Iceberg V2 metadata beside the Delta log in the customer's
 *     OWN ADLS Gen2 (Delta UniForm first, Apache XTable fallback) and registers
 *     the table in the Iceberg REST Catalog. Data files are never copied and
 *     the Delta log is never touched — Delta stays ✓ forever.
 *   • Shows the Iceberg REST Catalog connection string external engines point
 *     at (the audited Loom proxy, never the internal container).
 *   • Renders copy-paste connect snippets for Spark / Trino / DuckDB /
 *     Snowflake / Databricks, built from the live catalog + table values.
 *   • When LOOM_ICEBERG_CATALOG_URL is unset the FULL surface still renders:
 *     an inline HonestGate with Fix-it plus the direct metadata-folder path,
 *     because dual metadata works without the catalog — the catalog only adds
 *     discovery. No red on first open, no empty tab.
 *
 * Azure-native: Synapse Spark + ADLS Gen2 + the self-hosted Unity Catalog OSS
 * container. No Microsoft Fabric / OneLake / Power BI, and no Databricks.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge, Button, Caption1, Spinner, Subtitle2, Switch, Tab, TabList, Tooltip,
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Copy20Regular, DatabaseLink20Regular, Layer20Regular,
  CheckmarkCircle20Filled, PlugConnected20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { buildConnectSnippets, type ConnectSnippet } from '@/lib/azure/iceberg-metadata';
import { useLakehouseCtx } from '../lakehouse-editor-context';
import type { InteropTableRow, InteropResponse } from '../types';

const useLocalStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL,
    flex: 1, minHeight: 0, minWidth: 0,
  },
  head: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  kv: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
  },
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0,
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    overflowX: 'auto',
    whiteSpace: 'pre',
    minWidth: 0,
  },
  badges: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap', minWidth: 0,
  },
  tableWrap: { overflowX: 'auto', minWidth: 0 },
});

async function fetchInterop(container: string): Promise<InteropResponse> {
  const res = await clientFetch(`/api/lakehouse/interop?container=${encodeURIComponent(container)}`, {
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as InteropResponse;
  if (!res.ok || json?.ok !== true) {
    throw new Error(json?.error || `Could not load interop state (HTTP ${res.status})`);
  }
  return json;
}

export function InteropPane() {
  const s = useLocalStyles();
  const ctx = useLakehouseCtx();
  const { activeContainer, liveTables, liveTablesLoading, liveTablesGate, setActionError, setActionStatus } = ctx;
  const container = activeContainer || '';

  const [engine, setEngine] = useState<ConnectSnippet['id']>('spark');
  const [busyTable, setBusyTable] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  const interopQ = useQuery({
    queryKey: ['lakehouse-interop', container],
    queryFn: () => fetchInterop(container),
    enabled: !!container,
    staleTime: 15_000,
  });

  const stateByTable = useMemo(() => {
    const m = new Map<string, InteropTableRow>();
    for (const t of interopQ.data?.tables || []) m.set(t.table.toLowerCase(), t);
    return m;
  }, [interopQ.data]);

  /**
   * The rows to render: every REAL Delta table in the container (live catalog),
   * unioned with any table interop state already knows about (so a table that
   * moved out of the live listing still shows its Iceberg exposure honestly).
   */
  const rows = useMemo(() => {
    const names = new Set<string>();
    for (const t of liveTables || []) names.add(t.name);
    for (const t of interopQ.data?.tables || []) names.add(t.table);
    return [...names].sort().map((name) => ({
      name,
      state: stateByTable.get(name.toLowerCase()) || null,
    }));
  }, [liveTables, interopQ.data, stateByTable]);

  const catalog = interopQ.data?.catalog;
  const snippets = useMemo(() => {
    const sel = selectedTable ? stateByTable.get(selectedTable.toLowerCase()) : null;
    return buildConnectSnippets({
      catalogUri: catalog?.uri || '',
      warehouse: catalog?.warehouse || 'loom',
      namespace: sel?.namespace || container || 'default',
      table: sel?.icebergTableName || (selectedTable ?? undefined),
      catalogAlias: 'loom',
    });
  }, [catalog, container, selectedTable, stateByTable]);

  const active = snippets.find((x) => x.id === engine) || snippets[0];

  const toggle = useCallback(async (table: string, next: boolean) => {
    setBusyTable(table);
    setActionError(null);
    try {
      const res = await clientFetch('/api/lakehouse/interop', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ container, tableName: table, iceberg: next }),
      });
      const json = (await res.json().catch(() => ({}))) as InteropResponse & { catalogNote?: string };
      if (!res.ok || json?.ok !== true) {
        throw new Error(json?.error || `Could not update interop for ${table} (HTTP ${res.status})`);
      }
      setActionStatus(
        next
          ? `Iceberg metadata job submitted for ${table} on pool ${json.pool || 'default'} — the table stays Delta ✓ and becomes Iceberg ✓ once the job completes.`
          : `Iceberg metadata generation disabled for ${table}. Delta readability is unchanged.`,
      );
      if (json.catalogNote) setActionStatus(json.catalogNote);
      setSelectedTable(table);
      await interopQ.refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyTable(null);
    }
  }, [container, interopQ, setActionError, setActionStatus]);

  const copy = useCallback((text: string) => {
    try { void navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
  }, []);

  if (!container) {
    return (
      <EmptyState
        icon={<Layer20Regular />}
        title="Pick a lakehouse container"
        body="Interop exposes the Delta tables in one container to external Iceberg readers. Choose a container in the explorer to get started."
      />
    );
  }

  return (
    <div className={s.root}>
      <div className={s.head}>
        <DatabaseLink20Regular />
        <Subtitle2>Interop — read Loom tables from any engine, zero copy</Subtitle2>
        <LearnPopover
          title="Delta ↔ Iceberg dual metadata"
          content={
            'Loom writes Delta. Turning a table on here ALSO writes Apache Iceberg V2 metadata next to the Delta '
            + 'log in your own ADLS Gen2 (Delta UniForm, with Apache XTable as the fallback) and registers it in '
            + 'the Iceberg REST Catalog. The Parquet data files are never copied and the Delta log is never '
            + 'touched, so the table stays readable as BOTH formats — Trino, Spark, DuckDB, Snowflake and '
            + 'Databricks all read the same bytes in place. Runs on Synapse Spark; no Microsoft Fabric and no '
            + 'Databricks workspace required.'
          }
        />
        <Button
          appearance="subtle"
          icon={<ArrowSync20Regular />}
          onClick={() => void interopQ.refetch()}
          disabled={interopQ.isFetching}
        >
          Refresh
        </Button>
      </div>

      {/* Honest gate — the catalog is optional; dual metadata works without it. */}
      {catalog && !catalog.configured && (
        <HonestGate
          gateId="svc-iceberg-catalog"
          surface="Lakehouse Interop"
          gate={catalog.gate}
          onResolved={() => void interopQ.refetch()}
        />
      )}

      {interopQ.data?.accountGate && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Lake storage not configured</MessageBarTitle>
            {interopQ.data.accountGate}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Catalog connection card */}
      <div className={s.card}>
        <div className={s.kv}>
          <PlugConnected20Regular />
          <Subtitle2>Iceberg REST Catalog endpoint</Subtitle2>
          {catalog?.configured ? (
            <Badge appearance="filled" color="success" icon={<CheckmarkCircle20Filled />}>Live</Badge>
          ) : (
            <Badge appearance="tint" color="informative">Direct-metadata mode</Badge>
          )}
        </div>
        <div className={s.kv}>
          <span className={s.mono}>{catalog?.uri || '—'}</span>
          <Tooltip content="Copy catalog URI" relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<Copy20Regular />}
              aria-label="Copy catalog URI"
              onClick={() => copy(catalog?.uri || '')}
            />
          </Tooltip>
          <Badge appearance="outline">warehouse: {catalog?.warehouse || 'loom'}</Badge>
        </div>
        <Caption1>
          External engines authenticate with a scoped Loom API token (Settings → Developer → API tokens). The
          catalog container itself is never exposed — every request is proxied, authorized and audited.
        </Caption1>
      </div>

      {/* Per-table toggles */}
      <div className={s.card}>
        <div className={s.kv}>
          <Layer20Regular />
          <Subtitle2>Tables in {container}</Subtitle2>
          {interopQ.isFetching && <Spinner size="tiny" />}
        </div>
        {liveTablesGate && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Table listing unavailable</MessageBarTitle>
              {liveTablesGate}
            </MessageBarBody>
          </MessageBar>
        )}
        {interopQ.error && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>{(interopQ.error as Error).message}</MessageBarBody>
          </MessageBar>
        )}
        {liveTablesLoading && rows.length === 0 ? (
          <Spinner size="tiny" label="Loading tables…" labelPosition="after" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Layer20Regular />}
            title="No Delta tables in this container yet"
            body="Create or load a Delta table (Tables tab → Load to table) and it will appear here, ready to be exposed to external Iceberg readers."
          />
        ) : (
          <div className={s.tableWrap}>
            <Table size="small" aria-label="Table interop formats">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Table</TableHeaderCell>
                  <TableHeaderCell>Formats</TableHeaderCell>
                  <TableHeaderCell>Iceberg namespace</TableHeaderCell>
                  <TableHeaderCell>Expose as Iceberg</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ name, state }) => (
                  <TableRow
                    key={name}
                    appearance={selectedTable === name ? 'brand' : 'none'}
                    onClick={() => setSelectedTable(name)}
                  >
                    <TableCell><span className={s.mono}>{name}</span></TableCell>
                    <TableCell>
                      <div className={s.badges}>
                        <Badge appearance="filled" color="brand">Delta ✓</Badge>
                        {state?.iceberg ? (
                          <Tooltip
                            relationship="description"
                            content={
                              `${state.metadataLocation || 'metadata pending'}`
                              + (state.via && state.via !== 'none' ? ` — via ${state.via}` : '')
                              + (state.lastDetail ? ` — ${state.lastDetail}` : '')
                            }
                          >
                            <Badge appearance="filled" color="success">Iceberg ✓</Badge>
                          </Tooltip>
                        ) : (
                          <Badge appearance="outline" color="informative">Iceberg —</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={s.mono}>{state?.namespace || `${container} (default)`}</span>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={!!state?.iceberg}
                        disabled={busyTable === name}
                        aria-label={`Expose ${name} as Iceberg`}
                        onChange={(_, d) => { void toggle(name, !!d.checked); }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Connect snippets */}
      <div className={s.card}>
        <div className={s.kv}>
          <PlugConnected20Regular />
          <Subtitle2>Connect an external engine</Subtitle2>
          {selectedTable && <Badge appearance="tint">{selectedTable}</Badge>}
        </div>
        <TabList selectedValue={engine} onTabSelect={(_, d) => setEngine(d.value as ConnectSnippet['id'])}>
          {snippets.map((sn) => <Tab key={sn.id} value={sn.id}>{sn.label}</Tab>)}
        </TabList>
        {active && (
          <>
            <div className={s.kv}>
              <Caption1>{active.note}</Caption1>
              <Tooltip content="Copy snippet" relationship="label">
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<Copy20Regular />}
                  aria-label={`Copy ${active.label} snippet`}
                  onClick={() => copy(active.code)}
                >
                  Copy
                </Button>
              </Tooltip>
            </div>
            <pre className={s.code}>{active.code}</pre>
          </>
        )}
      </div>
    </div>
  );
}
