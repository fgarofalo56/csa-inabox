'use client';

/**
 * CostChargebackSection — per-domain + per-subscription cost rollup (D4).
 *
 * Backed by GET /api/admin/usage/cost (real Microsoft.CostManagement query,
 * grouped by the `csa-loom-domain` tag dlz-attach stamps on every DLZ resource).
 * Used on /admin/usage (full view: per-domain AND per-subscription bars +
 * budget burn + CSV export) and in the domain-settings drawer (domain-scoped:
 * that domain's MTD / forecast + its budget burn).
 *
 * Honest gates per no-vaporware: a missing config / role surfaces a Fluent
 * MessageBar naming the exact env var / role — never an empty state. The
 * "tags apply forward only" caveat is surfaced so $0 right after a tagging
 * redeploy reads as expected, not broken.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Caption1, Subtitle2, Button, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import { ArrowDownload16Regular, ArrowSync16Regular } from '@fluentui/react-icons';

export type CostTimeframe = 'MonthToDate' | 'BillingMonthToDate' | 'TheLastMonth' | 'Last7Days' | 'Last30Days';

interface CostBreakdownRow { key: string; cost: number; }
interface CostBudget {
  name: string; subscription: string; amount: number; currentSpend: number;
  percentUsed: number; timeGrain: string; scope: string;
}
interface CostSummary {
  currency: string;
  timeframe: CostTimeframe;
  monthToDate: number;
  previousPeriod: number | null;
  trendPct: number | null;
  forecast: number;
  byDomain: CostBreakdownRow[];
  bySubscription: CostBreakdownRow[];
  budgets: CostBudget[];
  subscriptionErrors: { subscription: string; error: string }[];
}
interface CostResponse {
  ok: boolean;
  data?: CostSummary;
  gate?: { missing?: string[]; message?: string };
  error?: string;
}

const TIMEFRAMES: { key: CostTimeframe; label: string }[] = [
  { key: 'MonthToDate', label: 'Month to date' },
  { key: 'TheLastMonth', label: 'Last month' },
  { key: 'Last30Days', label: 'Last 30 days' },
  { key: 'Last7Days', label: 'Last 7 days' },
];

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center',
    gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalM,
  },
  spacer: { flex: 1 },
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL,
  },
  statCard: {
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
  },
  statVal: { fontSize: '24px', fontWeight: tokens.fontWeightSemibold, color: tokens.colorBrandForeground1 },
  statLabel: { fontSize: '11px', color: tokens.colorNeutralForeground3, textTransform: 'uppercase', letterSpacing: '0.04em' },
  twoCol: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: tokens.spacingHorizontalL },
  panel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  bar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS },
  barLabel: { fontSize: '13px', minWidth: '150px', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  barTrack: { flex: 1, height: '8px', backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusSmall, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: tokens.colorBrandBackground, borderRadius: tokens.borderRadiusSmall },
  barFillSub: { height: '100%', backgroundColor: tokens.colorPaletteBlueBackground2, borderRadius: tokens.borderRadiusSmall },
  barFillOver: { height: '100%', backgroundColor: tokens.colorPaletteRedBackground3, borderRadius: tokens.borderRadiusSmall },
  barFillWarn: { height: '100%', backgroundColor: tokens.colorPaletteYellowBackground3, borderRadius: tokens.borderRadiusSmall },
  barCount: { fontSize: '12px', color: tokens.colorNeutralForeground2, minWidth: '88px', textAlign: 'right' },
  muted: { color: tokens.colorNeutralForeground3 },
  budgetRow: { display: 'flex', flexDirection: 'column', gap: '2px', paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS },
  budgetHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalS },
});

function fmtMoney(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${Math.round(n).toLocaleString()}`;
  }
}

interface Props {
  /** When set, the rollup is scoped to a single domain (drawer drill-down). */
  domain?: string;
}

export function CostChargebackSection({ domain }: Props) {
  const s = useStyles();
  const [data, setData] = useState<CostSummary | null>(null);
  const [gate, setGate] = useState<{ missing?: string[]; message?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeframe, setTimeframe] = useState<CostTimeframe>('MonthToDate');

  const qs = useCallback((tf: CostTimeframe, format?: string) => {
    const p = new URLSearchParams({ timeframe: tf });
    if (domain) p.set('domain', domain);
    if (format) p.set('format', format);
    return p.toString();
  }, [domain]);

  const load = useCallback(async (tf: CostTimeframe) => {
    setLoading(true); setError(null); setGate(null);
    try {
      const r = await clientFetch(`/api/admin/usage/cost?${qs(tf)}`);
      const j: CostResponse = await r.json();
      if (j.ok && j.data) { setData(j.data); }
      else if (j.gate) { setGate(j.gate); setData(null); }
      else { setError(j.error || 'Failed to load cost'); setData(null); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [qs]);

  useEffect(() => { load(timeframe); }, [load, timeframe]);

  const exportCsv = useCallback(() => {
    window.open(`/api/admin/usage/cost?${qs(timeframe, 'csv')}`, '_blank');
  }, [qs, timeframe]);

  const maxDomain = Math.max(1, ...((data?.byDomain || []).map((x) => x.cost)));
  const maxSub = Math.max(1, ...((data?.bySubscription || []).map((x) => x.cost)));
  // In domain-scoped mode, only this domain's budget(s) are relevant.
  const budgets = (data?.budgets || []).filter((b) =>
    !domain || b.name.toLowerCase().includes(domain.toLowerCase()));

  return (
    <div className={s.panel}>
      <div className={s.toolbar}>
        {TIMEFRAMES.map((t) => (
          <Button
            key={t.key}
            size="small"
            appearance={timeframe === t.key ? 'primary' : 'secondary'}
            onClick={() => setTimeframe(t.key)}
            disabled={loading}
          >
            {t.label}
          </Button>
        ))}
        <div className={s.spacer} />
        <Button size="small" icon={<ArrowSync16Regular />} onClick={() => load(timeframe)} disabled={loading}>
          Refresh
        </Button>
        <Button
          size="small"
          icon={<ArrowDownload16Regular />}
          onClick={exportCsv}
          disabled={loading || !data}
        >
          Export CSV
        </Button>
        {loading && <Spinner size="tiny" />}
      </div>

      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Per-domain cost accrues from attach time forward</MessageBarTitle>
          Cost Management applies tags to usage reported <strong>after</strong> the tag was set, not retroactively.
          A domain shows $0 until ~24&nbsp;h after the dlz-attach redeploy that stamps{' '}
          <code>csa-loom-domain</code> on its resources. CSP-billed subscriptions return empty cost.
        </MessageBarBody>
      </MessageBar>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load cost</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Cost Management not connected</MessageBarTitle>
            {gate.message || `Missing: ${(gate.missing || []).join(', ')}`}
          </MessageBarBody>
        </MessageBar>
      )}

      {data && (
        <>
          <div className={s.statsRow}>
            <div className={s.statCard}>
              <div className={s.statVal}>{fmtMoney(data.monthToDate, data.currency)}</div>
              <div className={s.statLabel}>{domain ? `${domain} — actual` : 'actual'}</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{fmtMoney(data.forecast, data.currency)}</div>
              <div className={s.statLabel}>forecast</div>
            </div>
            {data.trendPct != null && (
              <div className={s.statCard}>
                <div className={s.statVal}>{data.trendPct > 0 ? '+' : ''}{data.trendPct}%</div>
                <div className={s.statLabel}>vs previous period</div>
              </div>
            )}
          </div>

          {!domain && (
            <div className={s.twoCol}>
              <div className={s.panel}>
                <Subtitle2>Cost by domain</Subtitle2>
                {data.byDomain.length === 0 ? (
                  <Caption1 className={s.muted}>
                    No domain-tagged cost yet. Resources accrue per-domain cost after a dlz-attach redeploy stamps the <code>csa-loom-domain</code> tag.
                  </Caption1>
                ) : data.byDomain.map((row) => (
                  <div key={row.key} className={s.bar}>
                    <span className={s.barLabel}>{row.key}</span>
                    <div className={s.barTrack}>
                      {/* dynamic: fill width scales with the domain cost */}
                      <div className={s.barFill} style={{ width: `${(row.cost / maxDomain) * 100}%` }} />
                    </div>
                    <span className={s.barCount}>{fmtMoney(row.cost, data.currency)}</span>
                  </div>
                ))}
              </div>

              <div className={s.panel}>
                <Subtitle2>Cost by subscription</Subtitle2>
                {data.bySubscription.length === 0 ? (
                  <Caption1 className={s.muted}>No subscription cost in this window.</Caption1>
                ) : data.bySubscription.map((row) => (
                  <div key={row.key} className={s.bar}>
                    <span className={s.barLabel} title={row.key}>{row.key}</span>
                    <div className={s.barTrack}>
                      {/* dynamic: fill width scales with the subscription cost */}
                      <div className={s.barFillSub} style={{ width: `${(row.cost / maxSub) * 100}%` }} />
                    </div>
                    <span className={s.barCount}>{fmtMoney(row.cost, data.currency)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={s.panel}>
            <Subtitle2>{domain ? 'Budget burn' : 'Budgets & alert rules'}</Subtitle2>
            {budgets.length === 0 ? (
              <Caption1 className={s.muted}>
                {domain
                  ? 'No budget deployed for this domain. Set domainBudgetContactEmails at attach time (budgets.bicep) to deploy a per-domain Consumption budget with threshold alerts.'
                  : 'No Consumption budgets found. Per-domain budgets deploy via budgets.bicep when budget contacts are supplied at dlz-attach.'}
              </Caption1>
            ) : budgets.map((b) => {
              const fill = b.percentUsed >= 100 ? s.barFillOver : b.percentUsed >= 80 ? s.barFillWarn : s.barFill;
              return (
                <div key={`${b.subscription}-${b.name}`} className={s.budgetRow}>
                  <div className={s.budgetHead}>
                    <span>{b.name} <Badge appearance="outline" size="small">{b.timeGrain}</Badge></span>
                    <span className={s.barCount}>
                      {fmtMoney(b.currentSpend, data.currency)} / {fmtMoney(b.amount, data.currency)} · {b.percentUsed}%
                    </span>
                  </div>
                  <div className={s.barTrack}>
                    {/* dynamic: fill width scales with budget burn % */}
                    <div className={mergeClasses(fill)} style={{ width: `${Math.min(100, b.percentUsed)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>

          {data.subscriptionErrors.length > 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Some subscriptions could not be queried</MessageBarTitle>
                {data.subscriptionErrors.map((e) => `${e.subscription}: ${e.error}`).join(' · ')}
              </MessageBarBody>
            </MessageBar>
          )}
        </>
      )}

      {loading && !data && !gate && !error && (
        <Spinner size="tiny" label="Loading cost…" />
      )}
    </div>
  );
}

export default CostChargebackSection;
