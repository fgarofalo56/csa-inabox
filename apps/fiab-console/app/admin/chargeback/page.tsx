'use client';

/**
 * FGC-28 — Chargeback report (/admin/chargeback).
 *
 * Attributes real Azure Cost Management spend to Loom governance domains via the
 * `loom-domain` resource tag — the Azure-native 1:1 of the Fabric Chargeback
 * app. A real report (Fluent table + stacked bar chart + CSV export) over real
 * dollars; an honest MessageBar when the Console UAMI lacks Cost Management
 * Reader, and a warning when per-domain tagging is off (per no-vaporware).
 */
import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminShell } from '@/lib/components/admin-shell';
import {
  Body1, Caption1, Badge, Spinner, Dropdown, Option, Text, Button,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowDownload20Regular, Money20Regular, Organization20Regular, Person20Regular, Building20Regular } from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { useAdminTabStyles } from '@/lib/components/ui/admin-tab-styles';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';
import { LoomChart } from '@/lib/components/charts/loom-chart';
import { StaleDataBadge } from '@/lib/components/ui/stale-data-badge';

interface DomainCostRow { domainId: string; name: string; cost: number; pctOfTotal: number }
interface ChargebackModel {
  currency: string;
  timeframe: string;
  rows: DomainCostRow[];
  untaggedCost: number;
  totalCost: number;
  tagKey: string;
  subscriptions: string[];
  subscriptionErrors: { subscription: string; error: string }[];
  generatedAt: string;
}
interface Gate { missing: string[]; message: string }

// BR-COSTATTR — per-user attribution drill-down.
interface RollupRow { key: string; displayName?: string; lcu: number; estCostUsd: number; executions: number }
interface AttributionRollup {
  byUser: RollupRow[];
  byEngine: RollupRow[];
  totalLcu: number;
  totalEstCostUsd: number;
  totalExecutions: number;
  windowDays: number;
}

// WS-CHGBK — per-workspace allocation.
type AllocationBasis = 'usage' | 'items' | 'even';
interface WorkspaceCostRow {
  workspaceId: string; name: string; domainId: string; domainName: string;
  cost: number; pctOfDomain: number; basis: AllocationBasis;
}
interface WorkspaceChargebackModel {
  currency: string; timeframe: string; rows: WorkspaceCostRow[];
  totalCost: number; unallocatedCost: number; usageWindowDays: number; generatedAt: string;
}

const BASIS_META: Record<AllocationBasis, { label: string; color: 'brand' | 'informative' | 'subtle' }> = {
  usage: { label: 'usage-weighted', color: 'brand' },
  items: { label: 'item-weighted', color: 'informative' },
  even: { label: 'even split', color: 'subtle' },
};

const TIMEFRAMES: { key: string; label: string }[] = [
  { key: 'MonthToDate', label: 'Month to date' },
  { key: 'BillingMonthToDate', label: 'Billing month to date' },
  { key: 'TheLastMonth', label: 'Last month' },
  { key: 'Last7Days', label: 'Last 7 days' },
  { key: 'Last30Days', label: 'Last 30 days' },
];

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground2, lineHeight: 1.55, marginBottom: tokens.spacingVerticalL },
  explainer: { marginBottom: tokens.spacingVerticalL },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: tokens.spacingHorizontalL, marginBottom: tokens.spacingVerticalL },
  stat: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  statIcon: {
    flexShrink: 0, width: '40px', height: '40px', borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  statBody: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  statLabel: { fontSize: tokens.fontSizeBase100, textTransform: 'uppercase', letterSpacing: '0.06em', color: tokens.colorNeutralForeground3, fontWeight: 600 },
  statValue: { fontSize: tokens.fontSizeBase600, fontWeight: 700, marginTop: tokens.spacingVerticalXXS, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
  chartWrap: { marginBottom: tokens.spacingVerticalL },
  costCell: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
  domainName: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
});

function fmtCurrency(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency || '$'} ${n.toFixed(2)}`;
  }
}

function downloadCsv(model: ChargebackModel) {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Domain', 'Domain id', `Cost (${model.currency})`, '% of total'];
  const lines = [header.join(',')];
  for (const r of model.rows) lines.push([r.name, r.domainId, r.cost, r.pctOfTotal].map(esc).join(','));
  if (model.untaggedCost > 0) lines.push(['(untagged)', '', model.untaggedCost, ''].map(esc).join(','));
  lines.push(['Total', '', model.totalCost, ''].map(esc).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `loom-chargeback-${model.timeframe}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadWorkspaceCsv(model: WorkspaceChargebackModel) {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Workspace', 'Workspace id', 'Domain', 'Domain id', `Allocated cost (${model.currency})`, '% of domain', 'Basis'];
  const lines = [header.join(',')];
  for (const r of model.rows) {
    lines.push([r.name, r.workspaceId, r.domainName, r.domainId, r.cost, r.pctOfDomain, BASIS_META[r.basis]?.label || r.basis].map(esc).join(','));
  }
  lines.push(['Total allocated', '', '', '', model.totalCost, '', ''].map(esc).join(','));
  if (model.unallocatedCost > 0) lines.push(['Unallocated (no workspaces)', '', '', '', model.unallocatedCost, '', ''].map(esc).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `loom-chargeback-workspaces-${model.timeframe}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function ChargebackPage() {
  const styles = useStyles();
  const a = useAdminTabStyles();
  const [timeframe, setTimeframe] = useState('MonthToDate');
  const [model, setModel] = useState<ChargebackModel | null>(null);
  const [meta, setMeta] = useState<{ cachedAt?: number; stale?: boolean } | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [taggingEnabled, setTaggingEnabled] = useState<boolean | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  // BR-COSTATTR per-user drill-down state.
  const [drill, setDrill] = useState<{ domainId: string | null; name: string } | null>(null);
  const [rollup, setRollup] = useState<AttributionRollup | null>(null);
  const [rollupLoading, setRollupLoading] = useState(false);
  // WS-CHGBK per-workspace allocation state.
  const [wsModel, setWsModel] = useState<WorkspaceChargebackModel | null>(null);
  const [wsMeta, setWsMeta] = useState<{ cachedAt?: number; stale?: boolean } | null>(null);
  const [wsLoading, setWsLoading] = useState(true);
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsQ, setWsQ] = useState('');

  const loadRollup = useCallback((domainId: string | null, name: string) => {
    setDrill({ domainId, name });
    setRollup(null); setRollupLoading(true);
    const qs = domainId ? `?days=30&domainId=${encodeURIComponent(domainId)}` : '?days=30';
    clientFetch(`/api/admin/chargeback/attribution${qs}`, { cache: 'no-store' }, 30_000)
      .then((r) => r.json())
      .then((j: any) => { if (j?.ok) setRollup(j.rollup); })
      .catch(() => { /* drill is best-effort */ })
      .finally(() => setRollupLoading(false));
  }, []);

  const load = useCallback((tf: string) => {
    setLoading(true); setError(null); setGate(null);
    clientFetch(`/api/admin/chargeback?timeframe=${encodeURIComponent(tf)}`, { cache: 'no-store' }, 90_000)
      .then(async (r) => {
        if (r.status === 401) { setUnauth(true); return null; }
        return r.json();
      })
      .then((j: any) => {
        if (!j) return;
        if (j.ok) { setModel(j.data ?? null); setTaggingEnabled(!!j?.taggingEnabled); setMeta(j.meta ?? null); }
        else if (j.gate) setGate(j.gate);
        else setError(j.error || 'Failed to load chargeback report');
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const loadWs = useCallback((tf: string) => {
    setWsLoading(true); setWsError(null);
    clientFetch(`/api/admin/chargeback/workspaces?timeframe=${encodeURIComponent(tf)}`, { cache: 'no-store' }, 90_000)
      .then(async (r) => (r.status === 401 ? null : r.json()))
      .then((j: any) => {
        if (!j) return;
        if (j.ok) { setWsModel(j as WorkspaceChargebackModel); setWsMeta(j.meta ?? null); }
        else if (j.gate) { setWsModel(null); /* domain gate already shown above */ }
        else setWsError(j.error || 'Failed to load per-workspace breakdown');
      })
      .catch((e) => setWsError(String(e)))
      .finally(() => setWsLoading(false));
  }, []);

  useEffect(() => { load(timeframe); loadWs(timeframe); }, [timeframe, load, loadWs]);

  const visibleRows = useMemo(() => {
    const rows = model?.rows || [];
    const f = q.toLowerCase().trim();
    return f ? rows.filter((r) => r.name.toLowerCase().includes(f) || r.domainId.toLowerCase().includes(f)) : rows;
  }, [model, q]);

  const chartRows = useMemo(
    () => (model?.rows || []).slice(0, 12).map((r) => ({ Domain: r.name, Cost: r.cost })),
    [model],
  );

  const columns: LoomColumn<DomainCostRow>[] = useMemo(() => [
    {
      key: 'name', label: 'Domain', width: 260,
      render: (r) => (
        <span className={styles.domainName}>
          <Organization20Regular />
          <strong title={r.name} className={a.ellipsis}>{r.name}</strong>
        </span>
      ),
    },
    { key: 'domainId', label: 'Domain id', width: 200, render: (r) => <Caption1 className={styles.muted}>{r.domainId}</Caption1> },
    {
      key: 'cost', label: `Cost`, width: 140,
      getValue: (r) => r.cost,
      render: (r) => <span className={styles.costCell}>{fmtCurrency(r.cost, model?.currency || 'USD')}</span>,
    },
    {
      key: 'pctOfTotal', label: '% of total', width: 120,
      getValue: (r) => r.pctOfTotal,
      render: (r) => <Badge appearance="tint" color="brand">{r.pctOfTotal}%</Badge>,
    },
  ], [styles, a, model]);

  const wsVisibleRows = useMemo(() => {
    const rows = wsModel?.rows || [];
    const f = wsQ.toLowerCase().trim();
    return f
      ? rows.filter((r) => r.name.toLowerCase().includes(f) || r.domainName.toLowerCase().includes(f) || r.workspaceId.toLowerCase().includes(f))
      : rows;
  }, [wsModel, wsQ]);

  const wsColumns: LoomColumn<WorkspaceCostRow>[] = useMemo(() => [
    {
      key: 'name', label: 'Workspace', width: 240,
      render: (r) => (
        <span className={styles.domainName}>
          <Building20Regular />
          <strong title={r.name} className={a.ellipsis}>{r.name}</strong>
        </span>
      ),
    },
    { key: 'domainName', label: 'Domain', width: 180, render: (r) => <Caption1 className={styles.muted}>{r.domainName}</Caption1> },
    {
      key: 'cost', label: 'Allocated cost', width: 150,
      getValue: (r) => r.cost,
      render: (r) => <span className={styles.costCell}>{fmtCurrency(r.cost, wsModel?.currency || 'USD')}</span>,
    },
    {
      key: 'pctOfDomain', label: '% of domain', width: 120,
      getValue: (r) => r.pctOfDomain,
      render: (r) => <Badge appearance="tint" color="brand">{r.pctOfDomain}%</Badge>,
    },
    {
      key: 'basis', label: 'Basis', width: 150,
      getValue: (r) => r.basis,
      render: (r) => <Badge appearance="outline" color={BASIS_META[r.basis]?.color || 'subtle'}>{BASIS_META[r.basis]?.label || r.basis}</Badge>,
    },
  ], [styles, a, wsModel]);

  return (
    <AdminShell
      sectionTitle="Chargeback"
      learn={{
        title: 'Chargeback report',
        content:
          'Attributes real Azure Cost Management spend to governance domains via the loom-domain tag — the Azure-native 1:1 of the Fabric Chargeback app. Stacked bar chart, CSV export, and per-user drill-down.',
        tips: [
          'Spend joins to domains through the loom-domain resource tag',
          'Per-execution costs come from the cost-attribution ledger (TTL 90d)',
          'Needs Cost Management Reader on the billing scope',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/cost-management-billing/costs/overview-cost-management',
      }}
    >
      <Body1 className={styles.intro}>
        Attribute real Azure spend to your governance domains. Spend is grouped by the
        <code> loom-domain</code> tag that Loom stamps on each domain&apos;s Data Landing Zone resources,
        summed live from Azure Cost Management, and joined to your domain names. The Azure-native 1:1 of the
        Microsoft Fabric Chargeback app — real dollars, exportable to CSV, never estimated.
      </Body1>

      <div className={styles.explainer}>
        <SectionExplainer>
          Chargeback answers &ldquo;which department/domain is driving cost?&rdquo; using the same real Cost
          Management data as the Capacity page, grouped by the domain tag instead of by resource.
          <LearnPopover
            title="Per-domain chargeback"
            content="Loom tags every DLZ resource with loom-domain:<id> (dlz-attach stamps it; the Tenant settings → Billing → Per-domain chargeback tagging toggle stamps new items). Cost Management groups actual spend by that tag value, and this report joins it to your domain display names. Enable tagging so newly created items are attributed too."
            learnMoreHref="https://learn.microsoft.com/fabric/enterprise/chargeback-app"
          />
        </SectionExplainer>
      </div>

      {unauth && <SignInRequired subject="chargeback report" />}

      {!unauth && taggingEnabled === false && (
        <MessageBar intent="warning" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Per-domain tagging is off</MessageBarTitle>
            Newly created items are not being tagged with their domain, so their spend rolls into
            &ldquo;(untagged)&rdquo; below. Existing DLZ resources still report (dlz-attach stamps the tag).
            Turn on Tenant settings → Billing → &ldquo;Per-domain chargeback tagging&rdquo; to attribute new items.
          </MessageBarBody>
        </MessageBar>
      )}

      {!unauth && gate && (
        <MessageBar intent="warning" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Cost Management access required</MessageBarTitle>
            {gate.message}
          </MessageBarBody>
        </MessageBar>
      )}

      {!unauth && error && (
        <MessageBar intent="error" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Could not load chargeback report</MessageBarTitle>
            {error}
          </MessageBarBody>
          <MessageBarActions>
            <Button appearance="transparent" onClick={() => load(timeframe)}>Retry</Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {!unauth && (
        <Section
          title="Spend by domain"
          actions={
            <>
              <Dropdown
                value={TIMEFRAMES.find((t) => t.key === timeframe)?.label || timeframe}
                selectedOptions={[timeframe]}
                onOptionSelect={(_, d) => setTimeframe(d.optionValue ?? 'MonthToDate')}
                className={a.filterControl}
              >
                {TIMEFRAMES.map((t) => <Option key={t.key} value={t.key}>{t.label}</Option>)}
              </Dropdown>
              <Button
                appearance="subtle"
                icon={<ArrowDownload20Regular />}
                disabled={!model || model.rows.length === 0}
                onClick={() => model && downloadCsv(model)}
              >
                Export CSV
              </Button>
            </>
          }
        >
          {loading && <Spinner label="Querying Cost Management…" />}

          {!loading && model && (
            <>
              {meta?.stale && (
                <div className={styles.chartWrap}><StaleDataBadge cachedAt={meta.cachedAt} /></div>
              )}
              <div className={styles.stats}>
                <div className={styles.stat}>
                  <span className={styles.statIcon} aria-hidden><Money20Regular /></span>
                  <div className={styles.statBody}>
                    <div className={styles.statLabel}>Total attributed</div>
                    <div className={styles.statValue}>{fmtCurrency(model.totalCost, model.currency)}</div>
                  </div>
                </div>
                <div className={styles.stat}>
                  <span className={styles.statIcon} aria-hidden><Organization20Regular /></span>
                  <div className={styles.statBody}>
                    <div className={styles.statLabel}>Domains with spend</div>
                    <div className={styles.statValue}>{model.rows.length}</div>
                  </div>
                </div>
                {model.untaggedCost > 0 && (
                  <div className={styles.stat}>
                    <span className={styles.statIcon} aria-hidden><Money20Regular /></span>
                    <div className={styles.statBody}>
                      <div className={styles.statLabel}>Untagged</div>
                      <div className={styles.statValue}>{fmtCurrency(model.untaggedCost, model.currency)}</div>
                    </div>
                  </div>
                )}
              </div>

              {chartRows.length > 0 && (
                <div className={styles.chartWrap}>
                  <LoomChart type="bar" rows={chartRows} title="Cost by domain" height={280} />
                </div>
              )}

              <Toolbar search={q} onSearch={setQ} searchPlaceholder="Filter by domain name or id…" />
              <LoomDataTable
                columns={columns}
                rows={visibleRows}
                getRowId={(r) => r.domainId}
                onRowClick={(r) => loadRollup(r.domainId, r.name)}
                empty={
                  model.rows.length === 0
                    ? 'No per-domain spend yet — either no resources carry the loom-domain tag, or spend has not accrued in this window.'
                    : 'No domains match the current filter.'
                }
                ariaLabel="Per-domain chargeback"
              />

              {model.subscriptionErrors.length > 0 && (
                <MessageBar intent="warning" className={a.messageBar}>
                  <MessageBarBody>
                    Partial result — some subscriptions could not be queried:{' '}
                    {model.subscriptionErrors.map((e) => `${e.subscription}: ${e.error}`).join(' · ')}
                  </MessageBarBody>
                </MessageBar>
              )}

              <Text className={styles.muted}>
                {model.subscriptions.length} subscription{model.subscriptions.length === 1 ? '' : 's'} ·
                grouped by tag <code>{model.tagKey}</code> · generated {new Date(model.generatedAt).toLocaleString()}
              </Text>
            </>
          )}
        </Section>
      )}

      {!unauth && !gate && (
        <Section
          title="Spend by workspace"
          actions={
            <Button
              appearance="subtle"
              icon={<ArrowDownload20Regular />}
              disabled={!wsModel || wsModel.rows.length === 0}
              onClick={() => wsModel && downloadWorkspaceCsv(wsModel)}
            >
              Export CSV
            </Button>
          }
        >
          <Caption1 className={styles.muted}>
            Workspaces carry no direct Azure cost tag, so these figures are <strong>allocated</strong> from
            each domain&apos;s real Cost Management spend — never directly metered. Each domain&apos;s dollars are
            split across its workspaces by recorded compute usage (<em>usage-weighted</em>, last{' '}
            {wsModel?.usageWindowDays ?? 30} days); when no usage is recorded yet, by catalog item count
            (<em>item-weighted</em>); otherwise evenly. The per-domain totals above stay the real dollars.
          </Caption1>

          {wsLoading && <Spinner label="Allocating spend across workspaces…" />}

          {!wsLoading && wsError && (
            <MessageBar intent="error" className={a.messageBar}>
              <MessageBarBody>
                <MessageBarTitle>Could not load per-workspace breakdown</MessageBarTitle>
                {wsError}
              </MessageBarBody>
              <MessageBarActions>
                <Button appearance="transparent" onClick={() => loadWs(timeframe)}>Retry</Button>
              </MessageBarActions>
            </MessageBar>
          )}

          {!wsLoading && !wsError && wsModel && (
            <>
              {wsMeta?.stale && (
                <div className={styles.chartWrap}><StaleDataBadge cachedAt={wsMeta.cachedAt} /></div>
              )}
              <div className={styles.stats}>
                <div className={styles.stat}>
                  <span className={styles.statIcon} aria-hidden><Building20Regular /></span>
                  <div className={styles.statBody}>
                    <div className={styles.statLabel}>Total allocated</div>
                    <div className={styles.statValue}>{fmtCurrency(wsModel.totalCost, wsModel.currency)}</div>
                  </div>
                </div>
                <div className={styles.stat}>
                  <span className={styles.statIcon} aria-hidden><Building20Regular /></span>
                  <div className={styles.statBody}>
                    <div className={styles.statLabel}>Workspaces with spend</div>
                    <div className={styles.statValue}>{wsModel.rows.length}</div>
                  </div>
                </div>
                {wsModel.unallocatedCost > 0 && (
                  <div className={styles.stat}>
                    <span className={styles.statIcon} aria-hidden><Money20Regular /></span>
                    <div className={styles.statBody}>
                      <div className={styles.statLabel}>Unallocated (no workspaces)</div>
                      <div className={styles.statValue}>{fmtCurrency(wsModel.unallocatedCost, wsModel.currency)}</div>
                    </div>
                  </div>
                )}
              </div>

              <Toolbar search={wsQ} onSearch={setWsQ} searchPlaceholder="Filter by workspace or domain…" />
              <LoomDataTable
                columns={wsColumns}
                rows={wsVisibleRows}
                getRowId={(r) => r.workspaceId}
                empty={
                  wsModel.rows.length === 0
                    ? 'No per-workspace allocation yet — either no domain spend has accrued, or no workspaces are mapped to a domain with spend.'
                    : 'No workspaces match the current filter.'
                }
                ariaLabel="Per-workspace chargeback allocation"
              />
            </>
          )}
        </Section>
      )}

      {!unauth && model && (
        <Section
          title="Per-user consumption (drill-down)"
          actions={
            <>
              <Caption1 className={a.muted}>
                {drill ? (drill.domainId ? `Scoped to ${drill.name}` : 'Tenant-wide') : 'Select a domain above, or view tenant-wide'}
              </Caption1>
              <Button appearance="subtle" icon={<Person20Regular />} onClick={() => loadRollup(null, 'Tenant-wide')}>
                View tenant-wide
              </Button>
            </>
          }
        >
          <Caption1 className={styles.muted}>
            Per-execution attribution from real Spark / Databricks / ADX submits, normalized to Loom Capacity
            Units. Cost here is a transparent estimate from recorded consumption; the per-domain totals above
            are actual Cost Management dollars. Click a domain row to scope this to that domain.
          </Caption1>
          {rollupLoading && <Spinner label="Loading attribution…" />}
          {!rollupLoading && rollup && rollup.byUser.length === 0 && (
            <MessageBar intent="info" className={a.messageBar}>
              <MessageBarBody>
                No per-execution attribution recorded {drill?.domainId ? `for ${drill.name} ` : ''}in the last 30 days yet.
                Run a Spark, Databricks, or KQL job and it will be attributed here.
              </MessageBarBody>
            </MessageBar>
          )}
          {!rollupLoading && rollup && rollup.byUser.length > 0 && (
            <LoomDataTable
              columns={[
                { key: 'displayName', label: 'User', width: 260, render: (r: RollupRow) => (
                  <span className={styles.domainName}><Person20Regular /><strong className={a.ellipsis}>{r.displayName || r.key}</strong></span>
                ) },
                { key: 'lcu', label: 'LCU', width: 120, getValue: (r: RollupRow) => r.lcu, render: (r: RollupRow) => <span className={styles.costCell}>{r.lcu.toLocaleString()}</span> },
                { key: 'estCostUsd', label: 'Est. cost', width: 140, getValue: (r: RollupRow) => r.estCostUsd, render: (r: RollupRow) => <span className={styles.costCell}>{fmtCurrency(r.estCostUsd, 'USD')}</span> },
                { key: 'executions', label: 'Executions', width: 120, getValue: (r: RollupRow) => r.executions, render: (r: RollupRow) => <Badge appearance="tint">{r.executions}</Badge> },
              ]}
              rows={rollup.byUser}
              getRowId={(r: RollupRow) => r.key}
              empty="No per-user attribution."
              ariaLabel="Per-user consumption"
            />
          )}
        </Section>
      )}
    </AdminShell>
  );
}
