'use client';

/**
 * PSR-1 — per-metric benchmark trend card.
 *
 * Presentational (props-only, no fetch) so it renders identically in the
 * /admin/performance page and in unit tests. Shows one metric's p50/p95 trend
 * as a LoomChart line with a dashed **Fabric-bar reference line** (the
 * outcome-equivalence target), the current p50/p95/p99 stat tiles, and an
 * honest Fluent MessageBar when the metric's backend is unconfigured in this
 * deployment (naming the exact env var to set).
 *
 * Fluent v9 + Loom tokens only — no raw px/hex (web3-ui.md).
 */
import { useMemo } from 'react';
import {
  Badge,
  Caption1,
  Text,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { LoomChart, type ChartReferenceLine } from '@/lib/components/charts/loom-chart';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { metricDef, type PerfMetricDef } from '@/lib/perf/perf-metrics';
import type { MetricTrend, TrendPoint } from '@/lib/perf/perf-store';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
    transition: 'box-shadow 0.15s ease',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  head: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  headText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  title: { fontWeight: tokens.fontWeightSemibold, display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  stat: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  statLabel: {
    fontSize: tokens.fontSizeBase100,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  statValue: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightBold,
    lineHeight: 1.1,
    fontVariantNumeric: 'tabular-nums',
  },
  overBar: { color: tokens.colorPaletteRedForeground1 },
  underBar: { color: tokens.colorPaletteGreenForeground1 },
  muted: { color: tokens.colorNeutralForeground3 },
  barRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

/** Format a millisecond value for a stat tile. */
function fmtMs(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 2)} s`;
  return `${Math.round(n)} ms`;
}

/** A short axis label for a run point. */
function pointLabel(p: TrendPoint): string {
  const d = new Date(p.ts);
  if (Number.isNaN(d.getTime())) return p.rev || p.runId.slice(0, 6);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
    d.getHours(),
  ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface PerfMetricCardProps {
  trend: MetricTrend;
  /** Override the resolved def (tests). */
  def?: PerfMetricDef;
}

export function PerfMetricCard({ trend, def }: PerfMetricCardProps) {
  const styles = useStyles();
  const resolved = def ?? metricDef(trend.metric);
  const label = resolved?.label ?? trend.metric;
  const fabricBarMs = resolved?.fabricBarMs ?? 0;
  const fabricBarLabel = resolved?.fabricBarLabel ?? '';
  const learnUrl = resolved?.learnUrl ?? '';
  const latest = trend.latest;

  const chartRows = useMemo(
    () =>
      trend.points
        .filter((p) => !p.gated && (p.p50 !== null || p.p95 !== null))
        .map((p) => ({
          Run: pointLabel(p),
          p50: p.p50 ?? 0,
          p95: p.p95 ?? 0,
        })),
    [trend.points],
  );

  const refLines: ChartReferenceLine[] = useMemo(
    () =>
      fabricBarMs > 0
        ? [
            {
              id: 'fabric-bar',
              y: fabricBarMs,
              color: tokens.colorPaletteYellowForeground1,
              style: 'dashed',
              label: fabricBarLabel,
            },
          ]
        : [],
    [fabricBarMs, fabricBarLabel],
  );

  const latestGated = !latest || latest.gated;
  const p95 = latest?.p95 ?? null;
  const overBar = p95 !== null && fabricBarMs > 0 && p95 > fabricBarMs;

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <Text className={styles.title}>
            {label}
            {learnUrl && (
              <LearnPopover
                title={label}
                content={resolved?.description ?? ''}
                learnMoreHref={learnUrl}
              />
            )}
          </Text>
          <Caption1 className={styles.muted}>{resolved?.backend ?? trend.backend}</Caption1>
        </div>
        {!latestGated && (
          <Badge appearance="tint" color={overBar ? 'danger' : 'success'}>
            {overBar ? 'over bar' : 'at/under bar'}
          </Badge>
        )}
      </div>

      {latestGated ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Backend not configured</MessageBarTitle>
            {latest?.gateEnv
              ? `This benchmark is not running because ${latest.gateEnv} is not set in this deployment. `
              : 'This benchmark has not run against a configured backend yet. '}
            Once configured, "Run benchmark now" will record a real p50/p95 here.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <>
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>p50</span>
              <span className={styles.statValue}>{fmtMs(latest?.p50)}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>p95</span>
              <span className={`${styles.statValue} ${overBar ? styles.overBar : styles.underBar}`}>
                {fmtMs(latest?.p95)}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>p99</span>
              <span className={styles.statValue}>{fmtMs(latest?.p99)}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>cold</span>
              <span className={styles.statValue}>{fmtMs(latest?.coldMs)}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>warm</span>
              <span className={styles.statValue}>{fmtMs(latest?.warmMs)}</span>
            </div>
          </div>

          {chartRows.length > 0 ? (
            <LoomChart
              type="line"
              rows={chartRows}
              height={200}
              refLines={refLines}
              palette={[tokens.colorBrandForeground1, tokens.colorPaletteBerryForeground1]}
            />
          ) : (
            <Caption1 className={styles.muted}>
              One run recorded — run the benchmark again to see a trend line.
            </Caption1>
          )}

          <div className={styles.barRow}>
            <Caption1 className={styles.muted}>Fabric bar:</Caption1>
            <Badge appearance="outline" color="warning">
              {fabricBarLabel} ({fmtMs(fabricBarMs)})
            </Badge>
          </div>
        </>
      )}
    </div>
  );
}
