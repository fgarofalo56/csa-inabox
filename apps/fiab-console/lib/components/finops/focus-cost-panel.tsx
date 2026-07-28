'use client';

/**
 * B-N19e — FOCUS cost-per-query / per-dashboard panel.
 *
 * ONE self-contained pane component mounted on BOTH cost surfaces
 * (/admin/finops and /admin/chargeback) so the same real numbers appear
 * wherever a FinOps practitioner looks. It renders the FOCUS 1.1 mart from
 * GET /api/admin/finops/focus:
 *
 *   • KPI tiles      — attributed spend, runs priced, avg cost / run,
 *                      unattributed engine spend (surfaced, never hidden).
 *   • Group-by strip — Query · Dashboard · Item · User · Engine. "Query" groups
 *                      by STATEMENT FINGERPRINT so repeated runs of the same
 *                      query roll into one cost-per-query line.
 *   • Chart + table  — real allocated dollars per group, with the derivation
 *                      (`cost-management-allocated` / `unmetered`) badged on
 *                      every row so nothing reads as metered when it is not.
 *   • Export         — the full mart as FOCUS-column-named CSV.
 *
 * HONEST GATE (no-vaporware / G2): when Cost Management can't be read the API
 * still answers with the recorded consumption and a `gate`; this renders a
 * Fluent MessageBar naming the exact remediation with an inline **Fix it**
 * button into the gate registry — the panel degrades, it never disappears.
 *
 * Fluent v9 + Loom tokens only (no raw px/hex). Azure-native, no Fabric
 * dependency — the priced engines are ADX / Synapse / Container Apps / AKS /
 * Databricks / Analysis Services.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Badge, Body1, Button, Caption1, Dropdown, MessageBar, MessageBarActions,
  MessageBarBody, MessageBarTitle, Option, Spinner, Subtitle2, TabList, Tab,
  Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular, ArrowDownload20Regular, DataUsage20Regular,
  Money20Regular, Timer20Regular, Warning20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { Section } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { LoomChart } from '@/lib/components/charts/loom-chart';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import type { FocusGroupBy, FocusRollupRow } from '@/lib/finops/focus-mart';

const GROUPS: { key: FocusGroupBy; label: string }[] = [
  { key: 'query', label: 'Query' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'item', label: 'Item' },
  { key: 'user', label: 'User' },
  { key: 'engine', label: 'Engine' },
];

const WINDOWS = [7, 14, 30, 60, 90];

interface FocusMartMeta {
  specVersion: string;
  currency: string;
  totalBilledCost: number;
  totalEffectiveCost: number;
  totalEstimatedCost: number;
  unattributedCost: number;
  unattributed: { resourceType: string; serviceName: string; cost: number }[];
  costSource: 'cost-management-allocated' | 'unmetered';
  runCount: number;
  windowDays: number;
  generatedAt: string;
}

interface FocusResponse {
  ok?: boolean;
  mart?: FocusMartMeta;
  rows?: FocusRollupRow[];
  gate?: { id?: string; message?: string; missing?: string[] };
  error?: string;
  hint?: string;
  status?: number;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap', minWidth: 0,
  },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  tileValue: {
    fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightBold,
    lineHeight: tokens.lineHeightHero700, overflowWrap: 'anywhere',
  },
  muted: { color: tokens.colorNeutralForeground2 },
  badgeRow: {
    display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap',
    minWidth: 0, alignItems: 'center',
  },
  cell: { fontVariantNumeric: 'tabular-nums', minWidth: 0 },
  mono: {
    fontFamily: tokens.fontFamilyMonospace, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block',
  },
  chartWrap: { minWidth: 0 },
});

const fmtMoney = (n: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency,
      minimumFractionDigits: Math.abs(n) < 1 ? 4 : 2,
      maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(4)}`;
  }
};

const fmtDuration = (ms: number | null) => {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
};

async function getFocus(url: string): Promise<FocusResponse> {
  const res = await clientFetch(url, { cache: 'no-store' }, 90_000);
  const json = (await res.json().catch(() => ({}))) as FocusResponse;
  return { ...json, status: res.status };
}

export interface FocusCostPanelProps {
  /** Scope the mart to one item (the editor drill-down); omit for tenant-wide. */
  itemId?: string;
  /** Scope the mart to one dashboard. */
  dashboardId?: string;
  /** Initial grouping. Defaults to per-query. */
  defaultGroupBy?: FocusGroupBy;
  /** Section heading override (the finops hub uses a shorter one). */
  title?: string;
}

export function FocusCostPanel({
  itemId, dashboardId, defaultGroupBy = 'query', title = 'Cost per query / per dashboard (FOCUS)',
}: FocusCostPanelProps) {
  const styles = useStyles();
  const [groupBy, setGroupBy] = useState<FocusGroupBy>(defaultGroupBy);
  const [days, setDays] = useState(30);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ days: String(days), groupBy });
    if (itemId) p.set('itemId', itemId);
    if (dashboardId) p.set('dashboardId', dashboardId);
    return p.toString();
  }, [days, groupBy, itemId, dashboardId]);

  const q = useQuery({
    queryKey: ['finops-focus', qs],
    queryFn: () => getFocus(`/api/admin/finops/focus?${qs}`),
  });

  const mart = q.data?.mart;
  const rows = q.data?.rows || [];
  const gate = q.data?.gate;
  const currency = mart?.currency || 'USD';
  const unmetered = mart?.costSource === 'unmetered';
  // Flag OFF / hard failure — the API answered but with no mart.
  const turnedOff = !!q.data && !mart && !!q.data.error;

  const chartRows = useMemo(
    () => rows.slice(0, 15).map((r) => ({
      key: r.label.length > 28 ? `${r.label.slice(0, 27)}…` : r.label,
      cost: Math.round((unmetered ? r.estimatedCost : r.effectiveCost) * 10000) / 10000,
    })),
    [rows, unmetered],
  );

  const columns: LoomColumn<FocusRollupRow>[] = useMemo(() => [
    {
      key: 'label',
      label: GROUPS.find((g) => g.key === groupBy)?.label || 'Group',
      width: 280,
      render: (r) => (
        <Tooltip content={r.key} relationship="label">
          <strong className={styles.mono}>{r.label}</strong>
        </Tooltip>
      ),
    },
    {
      key: 'detail', label: 'Detail', width: 150,
      render: (r) => <Caption1 className={styles.muted}>{r.detail || '—'}</Caption1>,
    },
    {
      key: 'runs', label: 'Runs', width: 90,
      getValue: (r) => r.runs,
      render: (r) => <Badge appearance="tint">{r.runs}</Badge>,
    },
    {
      key: 'effectiveCost', label: `Cost (${currency})`, width: 140,
      getValue: (r) => r.effectiveCost,
      render: (r) => (
        <span className={styles.cell}>
          {r.costSource === 'unmetered' ? '—' : fmtMoney(r.effectiveCost, currency)}
        </span>
      ),
    },
    {
      key: 'avgCostPerRun', label: 'Avg / run', width: 130,
      getValue: (r) => r.avgCostPerRun,
      render: (r) => (
        <span className={styles.cell}>
          {r.costSource === 'unmetered' ? '—' : fmtMoney(r.avgCostPerRun, currency)}
        </span>
      ),
    },
    {
      key: 'lcu', label: 'LCU', width: 110,
      getValue: (r) => r.lcu,
      render: (r) => <span className={styles.cell}>{r.lcu.toLocaleString()}</span>,
    },
    {
      key: 'durationMs', label: 'Compute time', width: 130,
      getValue: (r) => r.durationMs ?? 0,
      render: (r) => <span className={styles.cell}>{fmtDuration(r.durationMs)}</span>,
    },
    {
      key: 'costSource', label: 'Basis', width: 170,
      getValue: (r) => r.costSource,
      render: (r) => (
        <Badge appearance="outline" color={r.costSource === 'unmetered' ? 'warning' : 'success'}>
          {r.costSource === 'unmetered' ? 'LCU only' : 'metered share'}
        </Badge>
      ),
    },
  ], [groupBy, currency, styles]);

  return (
    <Section
      title={title}
      actions={
        <>
          <Dropdown
            value={`Last ${days} days`}
            selectedOptions={[String(days)]}
            aria-label="Attribution window"
            onOptionSelect={(_, d) => setDays(Number(d.optionValue) || 30)}
          >
            {WINDOWS.map((w) => <Option key={w} value={String(w)}>{`Last ${w} days`}</Option>)}
          </Dropdown>
          <Button appearance="subtle" icon={<ArrowClockwise20Regular />} onClick={() => q.refetch()}>
            Refresh
          </Button>
          <Button
            appearance="subtle"
            icon={<ArrowDownload20Regular />}
            disabled={!mart || mart.runCount === 0}
            as="a"
            href={`/api/admin/finops/focus?${qs}&format=csv`}
          >
            Export FOCUS CSV
          </Button>
        </>
      }
    >
      <div className={styles.root}>
        <Body1 className={styles.muted}>
          Every query run — SQL Lab (DuckDB), Synapse dedicated &amp; serverless, ADX/KQL, Trino,
          Databricks SQL, Analysis Services DAX and dashboard tiles — is tagged with the user, item,
          workspace and dashboard that issued it, then priced by allocating the <strong>real Azure
          Cost Management spend</strong> of that engine&apos;s resource type across the runs it
          executed. Emitted in{' '}
          <a href="https://focus.finops.org/focus-specification/" target="_blank" rel="noreferrer">
            FOCUS {mart?.specVersion || '1.1'}
          </a>{' '}
          column names so it drops straight into your existing FinOps tooling.
          <LearnPopover
            title="How cost-per-query is derived"
            content="Loom writes one attribution record per query run (who / which item / which dashboard / wall-clock duration, plus a statement FINGERPRINT — never the statement text). Azure Cost Management meters the real dollars per ARM resource type. A run's cost is that resource type's real spend times the run's share of recorded Loom Capacity Units. Rows badged 'LCU only' have no metered dollars behind them yet and show consumption only — Loom never estimates a dollar figure and presents it as metered."
            learnMoreHref="https://learn.microsoft.com/cloud-computing/finops/focus/what-is-focus"
          />
        </Body1>

        {turnedOff && (
          <MessageBar intent="info" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>FOCUS cost attribution is turned off</MessageBarTitle>
              {q.data?.error} {q.data?.hint}
            </MessageBarBody>
            <MessageBarActions>
              <Button appearance="transparent" as="a" href="/admin/runtime-flags">Runtime flags</Button>
            </MessageBarActions>
          </MessageBar>
        )}

        {gate && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Cost Management access required for dollars</MessageBarTitle>
              {gate.message}
            </MessageBarBody>
            <MessageBarActions>
              <Button appearance="primary" as="a" href={`/admin/gates?gate=${gate.id || 'svc-cost-management'}`}>
                Fix it
              </Button>
            </MessageBarActions>
          </MessageBar>
        )}

        {q.isError && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Could not load the FOCUS mart</MessageBarTitle>
              {(q.error as Error)?.message || 'The request failed.'}
            </MessageBarBody>
            <MessageBarActions>
              <Button appearance="transparent" onClick={() => q.refetch()}>Retry</Button>
            </MessageBarActions>
          </MessageBar>
        )}

        {q.isLoading && <Spinner label="Joining the attribution ledger with Cost Management…" />}

        {!q.isLoading && mart && (
          <>
            <TileGrid minTileWidth={220}>
              <div className={styles.tile}>
                <Caption1 className={styles.muted}>Attributed spend</Caption1>
                <div className={styles.tileValue}>
                  {unmetered ? '—' : fmtMoney(mart.totalEffectiveCost, currency)}
                </div>
                <div className={styles.badgeRow}>
                  <Badge appearance="tint" color={unmetered ? 'warning' : 'success'}>
                    {unmetered ? 'LCU only — no metered dollars' : 'real Cost Management dollars'}
                  </Badge>
                </div>
              </div>
              <div className={styles.tile}>
                <Caption1 className={styles.muted}>Query runs priced</Caption1>
                <div className={styles.tileValue}>{mart.runCount.toLocaleString()}</div>
                <div className={styles.badgeRow}>
                  <Badge appearance="tint" color="brand">last {mart.windowDays} days</Badge>
                </div>
              </div>
              <div className={styles.tile}>
                <Caption1 className={styles.muted}>Avg cost per run</Caption1>
                <div className={styles.tileValue}>
                  {unmetered || mart.runCount === 0
                    ? '—'
                    : fmtMoney(mart.totalEffectiveCost / mart.runCount, currency)}
                </div>
                <div className={styles.badgeRow}>
                  <Badge appearance="tint" color="brand">FOCUS {mart.specVersion}</Badge>
                </div>
              </div>
              <div className={styles.tile}>
                <Caption1 className={styles.muted}>Unattributed engine spend</Caption1>
                <div className={styles.tileValue}>{fmtMoney(mart.unattributedCost, currency)}</div>
                <div className={styles.badgeRow}>
                  <Badge appearance="tint" color={mart.unattributedCost > 0 ? 'warning' : 'success'}>
                    {mart.unattributedCost > 0 ? 'metered, no runs recorded' : 'fully attributed'}
                  </Badge>
                </div>
              </div>
            </TileGrid>

            {mart.unattributed.length > 0 && (
              <MessageBar intent="info" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Metered spend with no recorded query runs</MessageBarTitle>
                  {mart.unattributed
                    .map((u) => `${u.serviceName} (${u.resourceType}): ${fmtMoney(u.cost, currency)}`)
                    .join(' · ')}
                  {' — '}kept out of the per-query figures rather than spread across the runs that do exist.
                </MessageBarBody>
              </MessageBar>
            )}

            <div className={styles.toolbar}>
              <TabList
                selectedValue={groupBy}
                onTabSelect={(_, d) => setGroupBy(d.value as FocusGroupBy)}
                aria-label="Group cost by"
              >
                {GROUPS.map((g) => <Tab key={g.key} value={g.key}>{g.label}</Tab>)}
              </TabList>
              <Caption1 className={styles.muted}>
                {groupBy === 'query'
                  ? 'Grouped by statement fingerprint — repeated runs of the same query aggregate.'
                  : `Grouped by ${groupBy}.`}
              </Caption1>
            </div>

            {rows.length === 0 ? (
              <EmptyState
                icon={<DataUsage20Regular />}
                title="No query runs attributed yet"
                body={
                  `Nothing has been recorded in the last ${mart.windowDays} days for this scope. `
                  + 'Run a query in SQL Lab, a warehouse, a KQL database, or open a dashboard — every '
                  + 'execution is tagged and will appear here.'
                }
                primaryAction={{ label: 'Open SQL Lab', href: '/items/sql-lab' }}
              />
            ) : (
              <>
                {chartRows.length > 0 && (
                  <div className={styles.chartWrap}>
                    <LoomChart
                      type="bar"
                      rows={chartRows}
                      height={280}
                      title={
                        unmetered
                          ? `Recorded consumption estimate by ${groupBy} (${currency})`
                          : `Allocated spend by ${groupBy} (${currency})`
                      }
                    />
                  </div>
                )}
                <LoomDataTable
                  columns={columns}
                  rows={rows}
                  getRowId={(r) => r.key}
                  empty="No rows for this grouping."
                  ariaLabel={`FOCUS cost attribution by ${groupBy}`}
                />
              </>
            )}

            <Caption1 className={styles.muted}>
              <Money20Regular aria-hidden /> FOCUS {mart.specVersion} · basis {mart.costSource} ·{' '}
              <Timer20Regular aria-hidden /> generated {new Date(mart.generatedAt).toLocaleString()} ·{' '}
              <Link href="/admin/finops">FinOps cockpit</Link>
            </Caption1>
          </>
        )}

        {!q.isLoading && !mart && !turnedOff && !q.isError && (
          <EmptyState
            icon={<Warning20Regular />}
            title="FOCUS mart unavailable"
            body="The mart endpoint returned no data. Retry, or check the gate registry for an unconfigured backend."
            primaryAction={{ label: 'Retry', onClick: () => { void q.refetch(); } }}
            secondaryAction={{ label: 'Gate registry', href: '/admin/gates' }}
          />
        )}
      </div>
    </Section>
  );
}

export default FocusCostPanel;
