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
 *
 * ── RENDERER FREEZE (#3197) ────────────────────────────────────────────────
 * Both grids below MUST stay windowed. They previously rendered every row of
 * an UNBOUNDED collection into a hand-rolled Fluent `<Table>` — one `Tooltip`
 * and 3–4 `Badge`s per row — with no virtualization and no cap. The row count
 * is unbounded by construction on the BFF side: /api/catalog/iceberg/overview
 * caps CATALOG namespaces at 40 but appends one lake-sourced row per
 * interop-tracked Iceberg table across every lakehouse in the tenant, with no
 * limit. Measured in real Chromium against this component (temp harness, dev
 * build, 1440x900):
 *
 *     rows     settle    LONGEST single main-thread task   total blocking
 *       200     1.6 s      764 ms                            1.2 s
 *     3,000     3.7 s    1,465 ms                            3.3 s
 *     8,000     9.8 s    5,648 ms                            9.6 s
 *    20,000    22.5 s   13,845 ms                           23.1 s
 *
 * A single task over ~5 s is exactly what a DevTools/extension script
 * injection with a 5,000 ms ceiling reports as "the page is busy", repeatedly,
 * across a 20+ s window — the #3197 signature. Navigating away recovers the
 * tab because the blocking task belongs to this page's render, not the
 * browser. The namespace `Dropdown` was measured at 5,000 options and is NOT
 * a contributor (803 ms — Fluent mounts the listbox lazily).
 *
 * The fix is the repo's own answer to this class (the /browse 1,437-item
 * renderer freeze): `LoomDataTable` + `virtualizeRows`, which materializes
 * only the rows near the viewport above the shared `VIRTUALIZATION_CUTOFF`.
 * Do not swap either grid back to a plain `<Table>` that maps every row.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge, Button, Caption1, Dropdown, Input, Option, Spinner, Subtitle2, Tab, TabList, Tooltip,
  MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Copy20Regular, DatabaseLink20Regular, Layer20Regular,
  CheckmarkCircle20Filled, ErrorCircle20Filled, PlugConnected20Regular, ShieldKeyhole20Regular, Search20Regular,
} from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
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

/** One flattened (namespace, principal) grant — the windowed grid's row type. */
interface GrantRow {
  id: string;
  namespace: string;
  /** null when the namespace has no direct grants; `note` explains why. */
  principal: string | null;
  privileges: string[];
  note: string | null;
}

/** Tooltip copy for the table `source` badge — hoisted so it is not rebuilt per row. */
const SOURCE_HELP: Record<CatalogTableRow['source'], string> = {
  catalog: 'Listed by the REST catalog.',
  lake: 'Iceberg metadata exists in your lake; the catalog has not listed it (yet). Engines can read it via the metadata folder.',
  both: 'Listed by the REST catalog AND tracked by Loom interop state.',
};

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

  /**
   * Grants flattened to ONE row per (namespace, principal) so the grid can be
   * windowed the same way the tables grid is. A namespace the catalog served
   * with no direct grants keeps its honest note as a single row rather than
   * disappearing.
   */
  const grantRows = useMemo<GrantRow[]>(() => {
    const out: GrantRow[] = [];
    for (const g of q.data?.grants || []) {
      if (g.assignments.length === 0) {
        out.push({
          id: `${g.namespace}::none`,
          namespace: g.namespace,
          principal: null,
          privileges: [],
          note: g.note || 'No direct grants on this namespace.',
        });
        continue;
      }
      for (const a of g.assignments) {
        out.push({
          id: `${g.namespace}::${a.principal}`,
          namespace: g.namespace,
          principal: a.principal,
          privileges: a.privileges,
          note: null,
        });
      }
    }
    return out;
  }, [q.data]);

  const tableColumns = useMemo<LoomColumn<CatalogTableRow>[]>(() => [
    {
      key: 'namespace',
      label: 'Namespace',
      width: 180,
      render: (t) => <span className={s.mono}>{t.namespace}</span>,
    },
    {
      key: 'name',
      label: 'Table',
      width: 220,
      render: (t) => <span className={s.mono}>{t.name}</span>,
    },
    {
      key: 'formats',
      label: 'Formats',
      width: 240,
      // Sort/filter on the plain-text meaning, not the badge markup.
      getValue: (t) => `Delta${t.iceberg ? ' Iceberg' : ''}${t.via && t.via !== 'none' ? ` ${t.via}` : ''}`,
      render: (t) => (
        <div className={s.badges}>
          <Badge appearance="filled" color="brand">Delta ✓</Badge>
          {t.iceberg
            ? <Badge appearance="filled" color="success">Iceberg ✓</Badge>
            : <Badge appearance="outline" color="informative">Iceberg —</Badge>}
          {t.via && t.via !== 'none' && <Badge appearance="outline">{t.via}</Badge>}
        </div>
      ),
    },
    {
      key: 'source',
      label: 'Source',
      width: 120,
      filterType: 'select',
      render: (t) => (
        <Tooltip relationship="description" content={SOURCE_HELP[t.source]}>
          <Badge appearance="tint">{t.source}</Badge>
        </Tooltip>
      ),
    },
    {
      key: 'metadataLocation',
      label: 'Metadata location',
      width: 420,
      getValue: (t) => t.metadataLocation || '',
      render: (t) => <span className={s.mono}>{t.metadataLocation || '—'}</span>,
    },
  ], [s.mono, s.badges]);

  const grantColumns = useMemo<LoomColumn<GrantRow>[]>(() => [
    {
      key: 'namespace',
      label: 'Namespace',
      width: 200,
      render: (g) => <span className={s.mono}>{g.namespace}</span>,
    },
    {
      key: 'principal',
      label: 'Principal',
      width: 260,
      getValue: (g) => g.principal || '',
      render: (g) => (g.principal
        ? <span className={s.mono}>{g.principal}</span>
        : <Caption1>{g.note}</Caption1>),
    },
    {
      key: 'privileges',
      label: 'Privileges',
      width: 320,
      getValue: (g) => g.privileges.join(' '),
      render: (g) => (
        <div className={s.badges}>
          {g.privileges.map((p) => <Badge key={p} appearance="outline">{p}</Badge>)}
        </div>
      ),
    },
  ], [s.mono, s.badges]);

  const snippets = q.data?.snippets || [];
  const active = snippets.find((x) => x.id === engine) || snippets[0];

  const copy = useCallback((text: string) => {
    try { void navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
  }, []);

  return (
    <AdminShell
      sectionTitle="External-engine federation (Iceberg)"
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
            surface="External-engine federation (Iceberg)"
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
            {/* #3673/#3746 — this badge used to read ONLY `catalog.configured`,
                so a catalog that is CONFIGURED but UNREACHABLE rendered a green
                ✓ Live directly above the red "Catalog unreachable — HTTP 403"
                MessageBar. `configured` means "a URL is set", which is a fact
                about config, not about reachability; the badge claimed the
                latter. Federation/security triage reads this badge first, so the
                contradiction pointed investigations away from the real 403. */}
            {q.data?.catalog.configured ? (
              q.data.catalog.error ? (
                <Badge appearance="filled" color="danger" icon={<ErrorCircle20Filled />}>Unreachable</Badge>
              ) : (
                <Badge appearance="filled" color="success" icon={<CheckmarkCircle20Filled />}>Live</Badge>
              )
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
          ) : q.isError ? (
            /* C20 (apex-A3 class): `fetchOverview` THROWS on !res.ok /
               ok!==true / transport failure, and this branch used to fall
               straight through to the EmptyState below — so a 500/403/network
               failure rendered "No tables published to the catalog yet". That
               is a FALSE CLAIM about the customer's catalog (deploy-integrity
               R7: an error must not assert something it did not establish),
               and it reads as "your publishing is broken" when the truth is
               "I could not ask". */
            <MessageBar intent="error" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Could not read the catalog</MessageBarTitle>
                {(q.error as Error)?.message
                  || 'The request failed before /api/catalog/iceberg/overview answered (network or timeout).'}{' '}
                This says nothing about whether tables are published — the read did not complete.
              </MessageBarBody>
              <MessageBarActions>
                <Button size="small" onClick={() => void q.refetch()}>Retry</Button>
              </MessageBarActions>
            </MessageBar>
          ) : tables.length === 0 ? (
            <EmptyState
              icon={<Layer20Regular />}
              title="No tables published to the catalog yet"
              body="Open a lakehouse, go to the Interop tab, and switch a Delta table on. Loom writes Iceberg metadata beside the Delta log in your own lake and publishes the table here — no data is copied."
              primaryAction={{ label: 'Browse lakehouses', href: '/browse?type=lakehouse' }}
            />
          ) : (
            <div className={s.tableWrap}>
              {/* WINDOWED (#3197). `virtualizeRows` materializes only the rows
                  near the viewport once the collection passes the shared
                  VIRTUALIZATION_CUTOFF — the row count here is unbounded. */}
              <LoomDataTable<CatalogTableRow>
                columns={tableColumns}
                rows={tables}
                getRowId={(t) => `${t.namespace}.${t.name}`}
                density="compact"
                virtualizeRows
                ariaLabel="Published catalog tables"
              />
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
          {grantRows.length === 0 ? (
            <Caption1>
              No namespace grants to show yet. Grants appear once the catalog serves at least one namespace.
            </Caption1>
          ) : (
            <div className={s.tableWrap}>
              {/* WINDOWED (#3197) — assignments per namespace are unbounded. */}
              <LoomDataTable<GrantRow>
                columns={grantColumns}
                rows={grantRows}
                getRowId={(g) => g.id}
                density="compact"
                virtualizeRows
                ariaLabel="Namespace grants"
              />
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
