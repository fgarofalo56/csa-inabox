'use client';

/**
 * SLO tab (SLO1) — the unified SLO / error-budget surface of the Health &
 * Reliability hub. Per-SLI objective vs 28-day attainment vs error-budget
 * burn, an availability burn-down sparkline, and honest "no data" rows when a
 * feed is unwired.
 *
 * REAL data only (no-vaporware.md): reads GET /api/admin/slo, which rolls up
 * the V1 synthetic-journey verdicts + the Copilot latency SLOs + the
 * result-cache hit-rate (lib/admin/slo-rollup). This is the in-product SURFACE
 * for the enterprise-hardening §1 SLO program, not a second program.
 */

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Body1, Body1Strong, Button, Caption1, Divider, MessageBar,
  MessageBarBody, MessageBarTitle, ProgressBar, Spinner, Subtitle2, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync24Regular, ArrowTrendingLines24Regular, CheckmarkCircle24Filled,
  ErrorCircle24Filled, Open16Regular, Warning24Filled, Info16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

// Mirror of lib/admin/slo-rollup types (client-safe shapes).
interface SloDayBucket { day: string; sampled: number; good: number; attainment: number; burnedFraction: number }
interface SloRow {
  id: string; label: string; category: 'availability' | 'latency' | 'efficiency';
  objective: number; attainment: number; met: boolean; burn: number; budgetRemaining: number;
  sampled: number; good: number; dataAvailable: boolean; unavailableReason?: string;
  unit: string; learnUrl?: string; description: string; series: SloDayBucket[];
}
interface SloBurnAlert { sliId: string; label: string; burn: number; attainment: number; objective: number }
interface SloPayload {
  generatedAt: string; windowDays: number; rows: SloRow[]; alerts: SloBurnAlert[]; anyData: boolean;
  journeysConfigured: boolean; journeysMissing?: string;
}

const RUNBOOK_URL = 'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/runbooks/slo-error-budget.md';

const useStyles = makeStyles({
  section: {
    padding: tokens.spacingVerticalXL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    marginBottom: tokens.spacingVerticalXL,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  head: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalMNudge,
    marginBottom: tokens.spacingVerticalL, flexWrap: 'wrap', minWidth: 0,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  cardHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
  },
  metricRow: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalL,
    marginTop: tokens.spacingVerticalXS, minWidth: 0,
  },
  metric: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  metricValue: { fontSize: tokens.fontSizeBase500, fontWeight: 700, lineHeight: 1.1 },
  badgeRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, minWidth: 0, alignItems: 'center' },
});

function pct(n: number, digits = 2): string {
  return `${(n * 100).toFixed(digits)}%`;
}

function StatusIcon({ row }: { row: SloRow }) {
  if (!row.dataAvailable) return <Info16Regular style={{ color: tokens.colorNeutralForeground3 }} />;
  if (row.category !== 'efficiency' && row.burn >= 2) return <ErrorCircle24Filled style={{ color: tokens.colorPaletteRedForeground1 }} />;
  if (!row.met) return <Warning24Filled style={{ color: tokens.colorPaletteYellowForeground1 }} />;
  return <CheckmarkCircle24Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />;
}

function burnColor(row: SloRow): 'success' | 'warning' | 'danger' | 'informative' {
  if (!row.dataAvailable) return 'informative';
  if (row.category === 'efficiency') return row.met ? 'success' : 'warning';
  if (row.burn >= 2) return 'danger';
  if (row.burn >= 1 || !row.met) return 'warning';
  return 'success';
}

/**
 * Error-budget burn-down sparkline (availability SLI). Draws budget-remaining
 * (1 - cumulative burned fraction) across the window's day buckets — a
 * declining line means the budget is being spent. Token-driven, theme-aware,
 * no external chart lib (dataviz-consistent with the repo's inline SVG charts).
 */
function BurnDownSpark({ series }: { series: SloDayBucket[] }) {
  const W = 260;
  const H = 44;
  const pad = 3;
  if (series.length === 0) return null;
  const remain = series.map((b) => Math.max(0, Math.min(1, 1 - b.burnedFraction)));
  const n = remain.length;
  const x = (i: number) => (n === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (n - 1));
  const y = (v: number) => pad + (1 - v) * (H - 2 * pad);
  const line = remain.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${(H - pad).toFixed(1)} L${x(0).toFixed(1)},${(H - pad).toFixed(1)} Z`;
  const last = remain[n - 1];
  const stroke = last <= 0 ? tokens.colorPaletteRedForeground1 : last < 0.34 ? tokens.colorPaletteYellowForeground1 : tokens.colorPaletteGreenForeground1;
  return (
    <svg
      width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      role="img" aria-label={`Error-budget remaining trend; ${pct(last, 0)} of the budget is left`}
      style={{ display: 'block', maxWidth: '100%', height: `${H}px`, marginTop: tokens.spacingVerticalXS }}
    >
      <line x1={pad} y1={y(0)} x2={W - pad} y2={y(0)} stroke={tokens.colorNeutralStroke2} strokeWidth={1} strokeDasharray="3 3" />
      <path d={area} fill={stroke} fillOpacity={0.12} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(n - 1)} cy={y(last)} r={2.5} fill={stroke} />
    </svg>
  );
}

function SloCard({ row }: { row: SloRow }) {
  const styles = useStyles();
  return (
    <div className={styles.card} role="listitem">
      <div className={styles.cardHead}>
        <StatusIcon row={row} />
        <Body1Strong style={{ minWidth: 0 }}>{row.label}</Body1Strong>
        <span style={{ flex: 1 }} />
        <div className={styles.badgeRow}>
          <Badge appearance="tint" color={row.category === 'availability' ? 'brand' : row.category === 'latency' ? 'informative' : 'subtle'}>
            {row.category}
          </Badge>
          {row.dataAvailable && row.category !== 'efficiency' && (
            <Tooltip relationship="description" content="Error-budget burn: the multiple of the allowed failure rate currently being consumed. Above 1 spends the budget faster than it refills; 2 or more pages the on-call.">
              <Badge appearance="filled" color={burnColor(row)}>{row.burn.toFixed(1)}× burn</Badge>
            </Tooltip>
          )}
        </div>
      </div>

      {row.dataAvailable ? (
        <>
          <div className={styles.metricRow}>
            <div className={styles.metric}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Objective</Caption1>
              <span className={styles.metricValue}>{pct(row.objective, row.objective >= 0.999 ? 2 : 0)}</span>
            </div>
            <div className={styles.metric}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                {row.category === 'efficiency' ? 'Hit-rate' : `${row.category === 'availability' ? '28-day' : ''} attainment`.trim()}
              </Caption1>
              <span className={styles.metricValue} style={{ color: row.met ? tokens.colorPaletteGreenForeground1 : tokens.colorPaletteRedForeground1 }}>
                {pct(row.attainment)}
              </span>
            </div>
            {row.category !== 'efficiency' && (
              <div className={styles.metric}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Budget left</Caption1>
                <span className={styles.metricValue}>{pct(row.budgetRemaining, 0)}</span>
              </div>
            )}
            <div className={styles.metric}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Samples</Caption1>
              <span className={styles.metricValue}>{row.good}/{row.sampled}</span>
            </div>
          </div>

          {row.category !== 'efficiency' && (
            <ProgressBar
              thickness="large"
              value={Math.max(0, Math.min(1, row.budgetRemaining))}
              color={burnColor(row) === 'danger' ? 'error' : burnColor(row) === 'warning' ? 'warning' : 'success'}
              aria-label={`${row.label} error budget remaining`}
            />
          )}

          {row.series.length > 1 && <BurnDownSpark series={row.series} />}

          <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS }}>
            {row.description}
          </Caption1>
          {row.learnUrl && (
            <Button appearance="transparent" size="small" icon={<Open16Regular />} as="a"
              href={row.learnUrl} target="_blank" rel="noreferrer"
              style={{ alignSelf: 'flex-start', paddingLeft: tokens.spacingHorizontalNone }}>
              Learn
            </Button>
          )}
        </>
      ) : (
        <MessageBar intent="info" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>No data yet</MessageBarTitle>
            {row.unavailableReason}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

export function SloPane() {
  const styles = useStyles();
  const [data, setData] = useState<SloPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch(`/api/admin/slo${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) { setError(j?.error || `slo rollup failed (${r.status})`); return; }
      setData(j.slo as SloPayload);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <section className={styles.section} aria-label="SLO error budgets">
      <div className={styles.head}>
        <ArrowTrendingLines24Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>SLO &amp; error budgets</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 0 }}>
          Objective vs 28-day attainment vs error-budget burn across the SLIs this program ships —
          journey availability, Copilot latency, and cache efficiency. Fast-burn availability/latency
          breaches page a P2 through the shared alert dispatch.
        </Caption1>
        <span style={{ flex: 1 }} />
        <Button appearance="subtle" icon={<Open16Regular />} as="a" href={RUNBOOK_URL} target="_blank" rel="noreferrer">
          Runbook
        </Button>
        <Button appearance="secondary" icon={loading ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
          onClick={() => load(true)} disabled={loading}>
          Refresh
        </Button>
      </div>

      {error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Could not load SLOs</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !data && !error && <Spinner label="Computing SLO rollup…" />}

      {data && data.alerts.length > 0 && (
        <MessageBar intent="warning" layout="multiline" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>
            <MessageBarTitle>{data.alerts.length} SLI{data.alerts.length > 1 ? 's' : ''} in fast-burn breach</MessageBarTitle>
            {data.alerts.map((a) => `${a.label} (${a.burn.toFixed(1)}× burn)`).join('; ')} — a P2 was dispatched
            through the shared on-call bridge (deduped). Follow the runbook.
          </MessageBarBody>
        </MessageBar>
      )}

      {data && !data.journeysConfigured && (
        <MessageBar intent="info" layout="multiline" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>
            <MessageBarTitle>Synthetic-runs store not wired</MessageBarTitle>
            The availability SLI needs the loom-synthetic-monitor results store
            {data.journeysMissing ? ` (set ${data.journeysMissing})` : ''}. The Copilot latency and cache SLIs
            below still reflect live data.
          </MessageBarBody>
        </MessageBar>
      )}

      {data && !data.anyData && data.journeysConfigured && (
        <EmptyState
          title="No SLI samples yet"
          body="Nothing has been measured on this replica yet — run a Copilot turn, let the synthetic monitor complete a cycle, or issue a cached query, then refresh."
          primaryAction={{ label: 'Open the runbook', href: RUNBOOK_URL }}
        />
      )}

      {data && data.rows.length > 0 && (
        <>
          <div className={styles.grid} role="list" aria-label="SLO rows">
            {data.rows.map((row) => <SloCard key={row.id} row={row} />)}
          </div>
          <Divider style={{ marginTop: tokens.spacingVerticalL, marginBottom: tokens.spacingVerticalS }} />
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Window: {data.windowDays} days · generated {new Date(data.generatedAt).toLocaleString()} · the SLO
            program (RED catalog, multi-window burn-rate alerting) lives in enterprise-hardening §1 — this is its
            in-product surface.
          </Caption1>
        </>
      )}
    </section>
  );
}
