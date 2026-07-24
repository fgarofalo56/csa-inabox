'use client';

/**
 * /admin/catalog — N1 CATALOG FEDERATION.
 *
 * The tenant-wide view of what external engines can see: every Iceberg
 * namespace the REST catalog serves, every table inside it with its FORMAT
 * BADGES (Delta ✓ / Iceberg ✓ — joined from the real catalog listing and the
 * real loom-lakehouse-interop state, never assumed), the Unity Catalog grant
 * mapping per namespace, and the connection strings a Trino / Spark / DuckDB /
 * Snowflake / Databricks operator pastes to read Loom tables in place.
 *
 * Honest-gate behaviour (G2 + ux-baseline): when LOOM_ICEBERG_CATALOG_URL is
 * unset the FULL page still renders — an inline HonestGate with a Fix-it, plus
 * the tables Loom has ALREADY emitted Iceberg metadata for (those are genuinely
 * readable by pointing an engine at the metadata folder). Never an empty page,
 * never red on first open.
 *
 * Azure-native: the catalog is a self-hosted Unity Catalog OSS container on
 * this deployment's Container Apps environment reading this deployment's own
 * ADLS Gen2. No Microsoft Fabric / Power BI, no SaaS catalog — so the whole
 * surface works disconnected in an IL5 enclave.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge, Button, Caption1, Dropdown, Input, Option, Spinner, Subtitle2, Tab, TabList, Tooltip,
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Copy20Regular, DatabaseLink20Regular, Layer20Regular,
  CheckmarkCircle20Filled, PlugConnected20Regular, ShieldKeyhole20Regular, Search20Regular,
} from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { clientFetch } from '@/lib/client-fetch';
import type { ConnectSnippet } from '@/lib/azure/iceberg-metadata';

interface GateBlock {
  id: string; title?: string; remediation?: string; fixItHref?: string; missing?: string[];
  state?: 'blocked' | 'cloud-unavailable'; fallbackNote?: string;
}

interface CatalogTableRow {
  namespace: string;
  name: string;
  delta: boolean;
  iceberg: boolean;
  source: 'catalog' | 'lake' | 'both';
  metadataLocation: string | null;
  via: string | null;
  container: string | null;
}

interface NamespaceGrants {
  namespace: string;
  supported: boolean;
  assignments: Array<{ principal: string; privileges: string[] }>;
  note?: string;
}

interface OverviewResponse {
  ok: boolean;
  error?: string;
  catalog: { configured: boolean; uri: string; warehouse: string; gate?: GateBlock; error?: string };
  namespaces: string[];
  tables: CatalogTableRow[];
  grants: NamespaceGrants[];
  snippets: ConnectSnippet[];
  interopError?: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap', minWidth: 0,
  },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0,
    paddingTop: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalL,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  tileLabel: { color: tokens.colorNeutralForeground3 },
  tileValue: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: 1.1 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  head: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
  },
  badges: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap', minWidth: 0,
  },
  mono: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0,
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    overflowX: 'auto', whiteSpace: 'pre', minWidth: 0,
  },
  tableWrap: { overflowX: 'auto', minWidth: 0 },
});

async function fetchOverview(): Promise<OverviewResponse> {
  const res = await clientFetch('/api/catalog/iceberg/overview', { cache: 'no-store' });
  const json = (await res.json().catch(() => ({}))) as OverviewResponse;
  if (!res.ok || json?.ok !== true) {
    throw new Error(json?.error || `Could not load the catalog federation view (HTTP ${res.status})`);
  }
  return json;
}

export default function AdminCatalogPage() {
  const s = useStyles();
  const [filter, setFilter] = useState('');
  const [namespace, setNamespace] = useState('all');
  const [engine, setEngine] = useState<ConnectSnippet['id']>('spark');

  const q = useQuery({ queryKey: ['admin-iceberg-catalog'], queryFn: fetchOverview, staleTime: 30_000 });

  const tables = useMemo(() => {
    const all = q.data?.tables || [];
    const needle = filter.trim().toLowerCase();
    return all.filter((t) =>
      (namespace === 'all' || t.namespace === namespace)
      && (!needle || `${t.namespace}.${t.name}`.toLowerCase().includes(needle)));
  }, [q.data, filter, namespace]);

  const stats = useMemo(() => {
    const all = q.data?.tables || [];
    return {
      namespaces: (q.data?.namespaces || []).length,
      tables: all.length,
      iceberg: all.filter((t) => t.iceberg).length,
      grants: (q.data?.grants || []).reduce((n, g) => n + g.assignments.length, 0),
    };
  }, [q.data]);

  const snippets = q.data?.snippets || [];
  const active = snippets.find((x) => x.id === engine) || snippets[0];

  const copy = useCallback((text: string) => {
    try { void navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
  }, []);

  return (
    <AdminShell
      sectionTitle="Catalog federation"
      learn={{
        title: 'Iceberg REST Catalog',
        content:
          'Loom writes Delta into your own ADLS Gen2. This page is what EXTERNAL engines see: the Apache Iceberg '
          + 'REST Catalog (served by a self-hosted Unity Catalog OSS container inside your VNet) that lets Trino, '
          + 'Spark, DuckDB, Snowflake and Databricks read those same Parquet files in place — zero copy, no '
          + 'export, no Microsoft Fabric and no SaaS catalog. Every request is proxied through Loom, authorized '
          + 'as a real principal, and written to the audit trail.',
      }}
    >
      <div className={s.root}>
        <div className={s.toolbar}>
          <DatabaseLink20Regular />
          <Input
            value={filter}
            onChange={(_, d) => setFilter(d.value)}
            placeholder="Filter namespace.table"
            contentBefore={<Search20Regular />}
            aria-label="Filter tables"
          />
          <Dropdown
            value={namespace === 'all' ? 'All namespaces' : namespace}
            selectedOptions={[namespace]}
            aria-label="Namespace"
            onOptionSelect={(_, d) => setNamespace(String(d.optionValue || 'all'))}
          >
            <Option value="all">All namespaces</Option>
            {(q.data?.namespaces || []).map((ns) => <Option key={ns} value={ns}>{ns}</Option>)}
          </Dropdown>
          <Button
            appearance="subtle"
            icon={<ArrowSync20Regular />}
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
          >
            Refresh
          </Button>
          {q.isFetching && <Spinner size="tiny" />}
        </div>

        {/* Honest gate — the catalog service is optional; the page still works. */}
        {q.data && !q.data.catalog.configured && (
          <HonestGate
            gateId="svc-iceberg-catalog"
            surface="Catalog federation"
            gate={q.data.catalog.gate}
            onResolved={() => void q.refetch()}
          />
        )}

        {q.data?.catalog.error && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Catalog unreachable</MessageBarTitle>
              {q.data.catalog.error}
            </MessageBarBody>
          </MessageBar>
        )}
        {q.data?.interopError && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Interop state unavailable</MessageBarTitle>
              {q.data.interopError}
            </MessageBarBody>
          </MessageBar>
        )}
        {q.error && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>{(q.error as Error).message}</MessageBarBody>
          </MessageBar>
        )}

        {/* KPI tiles */}
        <TileGrid minTileWidth={220}>
          <div className={s.tile}>
            <Caption1 className={s.tileLabel}>Namespaces</Caption1>
            <span className={s.tileValue}>{stats.namespaces}</span>
          </div>
          <div className={s.tile}>
            <Caption1 className={s.tileLabel}>Tables published</Caption1>
            <span className={s.tileValue}>{stats.tables}</span>
          </div>
          <div className={s.tile}>
            <Caption1 className={s.tileLabel}>Iceberg-readable</Caption1>
            <span className={s.tileValue}>{stats.iceberg}</span>
          </div>
          <div className={s.tile}>
            <Caption1 className={s.tileLabel}>Grant assignments</Caption1>
            <span className={s.tileValue}>{stats.grants}</span>
          </div>
        </TileGrid>

        {/* Endpoint card */}
        <div className={s.card}>
          <div className={s.head}>
            <PlugConnected20Regular />
            <Subtitle2>Iceberg REST Catalog endpoint</Subtitle2>
            {q.data?.catalog.configured ? (
              <Badge appearance="filled" color="success" icon={<CheckmarkCircle20Filled />}>Live</Badge>
            ) : (
              <Badge appearance="tint" color="informative">Direct-metadata mode</Badge>
            )}
          </div>
          <div className={s.head}>
            <span className={s.mono}>{q.data?.catalog.uri || '—'}</span>
            <Tooltip content="Copy catalog URI" relationship="label">
              <Button
                appearance="subtle"
                size="small"
                icon={<Copy20Regular />}
                aria-label="Copy catalog URI"
                onClick={() => copy(q.data?.catalog.uri || '')}
              />
            </Tooltip>
            <Badge appearance="outline">warehouse: {q.data?.catalog.warehouse || 'loom'}</Badge>
          </div>
          <Caption1>
            External engines authenticate with a scoped Loom API token. The catalog container has internal
            ingress only — it is never reachable from outside the VNet.
          </Caption1>
        </div>

        {/* Tables + format badges */}
        <div className={s.card}>
          <div className={s.head}>
            <Layer20Regular />
            <Subtitle2>Published tables</Subtitle2>
          </div>
          {q.isLoading ? (
            <Spinner size="tiny" label="Loading catalog…" labelPosition="after" />
          ) : tables.length === 0 ? (
            <EmptyState
              icon={<Layer20Regular />}
              title="No tables published to the catalog yet"
              body="Open a lakehouse, go to the Interop tab, and switch a Delta table on. Loom writes Iceberg metadata beside the Delta log in your own lake and publishes the table here — no data is copied."
              primaryAction={{ label: 'Browse lakehouses', href: '/browse?type=lakehouse' }}
            />
          ) : (
            <div className={s.tableWrap}>
              <Table size="small" aria-label="Published catalog tables">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Namespace</TableHeaderCell>
                    <TableHeaderCell>Table</TableHeaderCell>
                    <TableHeaderCell>Formats</TableHeaderCell>
                    <TableHeaderCell>Source</TableHeaderCell>
                    <TableHeaderCell>Metadata location</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tables.map((t) => (
                    <TableRow key={`${t.namespace}.${t.name}`}>
                      <TableCell><span className={s.mono}>{t.namespace}</span></TableCell>
                      <TableCell><span className={s.mono}>{t.name}</span></TableCell>
                      <TableCell>
                        <div className={s.badges}>
                          <Badge appearance="filled" color="brand">Delta ✓</Badge>
                          {t.iceberg
                            ? <Badge appearance="filled" color="success">Iceberg ✓</Badge>
                            : <Badge appearance="outline" color="informative">Iceberg —</Badge>}
                          {t.via && t.via !== 'none' && <Badge appearance="outline">{t.via}</Badge>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Tooltip
                          relationship="description"
                          content={
                            t.source === 'catalog'
                              ? 'Listed by the REST catalog.'
                              : t.source === 'lake'
                                ? 'Iceberg metadata exists in your lake; the catalog has not listed it (yet). Engines can read it via the metadata folder.'
                                : 'Listed by the REST catalog AND tracked by Loom interop state.'
                          }
                        >
                          <Badge appearance="tint">{t.source}</Badge>
                        </Tooltip>
                      </TableCell>
                      <TableCell><span className={s.mono}>{t.metadataLocation || '—'}</span></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* Grant mapping */}
        <div className={s.card}>
          <div className={s.head}>
            <ShieldKeyhole20Regular />
            <Subtitle2>Grant mapping</Subtitle2>
            <Caption1>Unity Catalog privileges an external engine is subject to, per namespace.</Caption1>
          </div>
          {(q.data?.grants || []).length === 0 ? (
            <Caption1>
              No namespace grants to show yet. Grants appear once the catalog serves at least one namespace.
            </Caption1>
          ) : (
            <div className={s.tableWrap}>
              <Table size="small" aria-label="Namespace grants">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Namespace</TableHeaderCell>
                    <TableHeaderCell>Principal</TableHeaderCell>
                    <TableHeaderCell>Privileges</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(q.data?.grants || []).flatMap((g) =>
                    g.assignments.length === 0
                      ? [(
                        <TableRow key={`${g.namespace}-none`}>
                          <TableCell><span className={s.mono}>{g.namespace}</span></TableCell>
                          <TableCell colSpan={2}>
                            <Caption1>{g.note || 'No direct grants on this namespace.'}</Caption1>
                          </TableCell>
                        </TableRow>
                      )]
                      : g.assignments.map((a) => (
                        <TableRow key={`${g.namespace}-${a.principal}`}>
                          <TableCell><span className={s.mono}>{g.namespace}</span></TableCell>
                          <TableCell><span className={s.mono}>{a.principal}</span></TableCell>
                          <TableCell>
                            <div className={s.badges}>
                              {a.privileges.map((p) => <Badge key={p} appearance="outline">{p}</Badge>)}
                            </div>
                          </TableCell>
                        </TableRow>
                      )),
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* Connect snippets */}
        {snippets.length > 0 && (
          <div className={s.card}>
            <div className={s.head}>
              <PlugConnected20Regular />
              <Subtitle2>Connect an external engine</Subtitle2>
            </div>
            <TabList selectedValue={engine} onTabSelect={(_, d) => setEngine(d.value as ConnectSnippet['id'])}>
              {snippets.map((sn) => <Tab key={sn.id} value={sn.id}>{sn.label}</Tab>)}
            </TabList>
            {active && (
              <>
                <div className={s.head}>
                  <Caption1>{active.note}</Caption1>
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<Copy20Regular />}
                    aria-label={`Copy ${active.label} snippet`}
                    onClick={() => copy(active.code)}
                  >
                    Copy
                  </Button>
                </div>
                <pre className={s.code}>{active.code}</pre>
              </>
            )}
          </div>
        )}
      </div>
    </AdminShell>
  );
}
