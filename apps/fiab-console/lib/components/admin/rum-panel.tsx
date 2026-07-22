'use client';

/**
 * RumPanel — the /admin/rum real-user-monitoring view (RUM1).
 *
 * Charts REAL browser telemetry from GET /api/admin/rum (App Insights
 * workspace tables via Log Analytics): p50/p95 page-load trend, per-surface
 * load percentiles, Web-Vitals p75 tiles, and top client errors. Capture
 * posture (env + FLAG0 kill-switch + sample rate) renders as a status strip
 * with a link to /admin/runtime-flags.
 *
 * States (ux-baseline): skeleton while loading; honest MessageBar naming
 * LOOM_LOG_ANALYTICS_WORKSPACE_ID on the 503 gate; guided EmptyState when
 * configured but no telemetry has arrived yet. Fluent v9 + Loom tokens only.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Caption1,
  Dropdown,
  Link as FluentLink,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Skeleton,
  SkeletonItem,
  Subtitle2,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ErrorCircle24Regular,
  Globe24Regular,
  PulseSquare24Regular,
} from '@fluentui/react-icons';
import NextLink from 'next/link';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { LoomChart } from '@/lib/components/charts/loom-chart';
import type { RumRollup } from '@/app/api/admin/rum/route';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
  },
  captureRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  tiles: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  tileLabel: {
    fontSize: tokens.fontSizeBase100, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold,
  },
  tileValue: {
    fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightBold, lineHeight: 1.1,
    fontVariantNumeric: 'tabular-nums',
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  twoCol: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  tableWrap: { overflowX: 'auto', minWidth: 0 },
  errMsg: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    maxWidth: '420px', display: 'inline-block', verticalAlign: 'bottom',
  },
  muted: { color: tokens.colorNeutralForeground3 },
});

const RUNBOOK_URL = 'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/runbooks/rum.md';

const WINDOW_OPTIONS = [
  { key: 'P1D', label: 'Last 24 hours' },
  { key: 'P3D', label: 'Last 3 days' },
  { key: 'P7D', label: 'Last 7 days' },
] as const;

function fmtMs(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 2)} s`;
  return `${Math.round(n)} ms`;
}

/** Web-Vitals badge color per the published good/needs-improvement/poor bands. */
function vitalBadge(value: number | null, good: number, poor: number): 'success' | 'warning' | 'danger' | 'informative' {
  if (value === null || value === undefined) return 'informative';
  if (value <= good) return 'success';
  if (value <= poor) return 'warning';
  return 'danger';
}

function vitalLabel(value: number | null, good: number, poor: number): string {
  if (value === null || value === undefined) return 'no data';
  const c = vitalBadge(value, good, poor);
  return c === 'success' ? 'good' : c === 'warning' ? 'needs work' : 'poor';
}

interface FetchState {
  rum?: RumRollup;
  gate?: string;
  error?: string;
}

async function fetchRum(window: string): Promise<FetchState> {
  const res = await clientFetch(`/api/admin/rum?window=${encodeURIComponent(window)}`);
  let body: { ok?: boolean; rum?: RumRollup; error?: string } | null = null;
  try {
    body = await res.json();
  } catch {
    return { error: `Unexpected non-JSON response (HTTP ${res.status}).` };
  }
  if (res.status === 503) return { gate: body?.error || 'Log Analytics not configured.' };
  if (!res.ok || !body?.ok || !body.rum) return { error: body?.error || `HTTP ${res.status}` };
  return { rum: body.rum };
}

export function RumPanel() {
  const styles = useStyles();
  const [window, setWindow] = useState<string>('P1D');
  const { data, isLoading } = useQuery({
    queryKey: ['admin-rum', window],
    queryFn: () => fetchRum(window),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const rum = data?.rum;
  const hasAny = !!rum && (rum.loads.views > 0 || rum.errorCount > 0 || rum.routeChanges > 0 || rum.vitals.samples > 0);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.captureRow}>
          {rum && (
            <>
              <Badge appearance="tint" color={rum.capture.envEnabled && rum.capture.flagEnabled ? 'success' : 'warning'}>
                capture {rum.capture.envEnabled && rum.capture.flagEnabled ? 'on' : 'off'}
              </Badge>
              <Badge appearance="outline">sample {rum.capture.sampleRate}%</Badge>
              <Caption1 className={styles.muted}>
                Kill-switch:{' '}
                <NextLink href="/admin/runtime-flags" legacyBehavior passHref>
                  <FluentLink>rum1-client-telemetry</FluentLink>
                </NextLink>
                {' · '}
                <FluentLink href={RUNBOOK_URL} target="_blank" rel="noreferrer">
                  Runbook →
                </FluentLink>
              </Caption1>
            </>
          )}
        </div>
        <Dropdown
          value={WINDOW_OPTIONS.find((w) => w.key === window)?.label}
          selectedOptions={[window]}
          onOptionSelect={(_, d) => d.optionValue && setWindow(d.optionValue)}
          aria-label="Lookback window"
        >
          {WINDOW_OPTIONS.map((w) => (
            <Option key={w.key} value={w.key}>{w.label}</Option>
          ))}
        </Dropdown>
      </div>

      {isLoading && (
        <Skeleton aria-label="Loading real-user telemetry">
          <div className={styles.tiles}>
            {[0, 1, 2, 3, 4].map((i) => <SkeletonItem key={i} size={64} />)}
          </div>
        </Skeleton>
      )}

      {data?.gate && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Log Analytics workspace not configured</MessageBarTitle>
            {data.gate}
          </MessageBarBody>
        </MessageBar>
      )}
      {data?.error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Could not load RUM telemetry</MessageBarTitle>
            {data.error}
          </MessageBarBody>
        </MessageBar>
      )}

      {rum && !hasAny && (
        <EmptyState
          icon={<PulseSquare24Regular />}
          title="No real-user telemetry yet"
          body={
            rum.capture.envEnabled && rum.capture.flagEnabled
              ? 'Capture is on — browser page loads, Web Vitals and client errors appear here a few minutes after real sessions hit the console. Open a few pages and refresh.'
              : 'Capture is currently off. Enable the rum1-client-telemetry runtime flag (and LOOM_RUM_ENABLED) to start collecting browser telemetry.'
          }
          primaryAction={
            rum.capture.envEnabled && rum.capture.flagEnabled
              ? undefined
              : { label: 'Open runtime flags', href: '/admin/runtime-flags', appearance: 'primary' }
          }
        />
      )}

      {rum && hasAny && (
        <>
          <div className={styles.tiles}>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Page loads</span>
              <span className={styles.tileValue}>{rum.loads.views}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Load p50</span>
              <span className={styles.tileValue}>{fmtMs(rum.loads.p50Ms)}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Load p95</span>
              <span className={styles.tileValue}>{fmtMs(rum.loads.p95Ms)}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Route changes</span>
              <span className={styles.tileValue}>{rum.routeChanges}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Client errors</span>
              <span className={styles.tileValue}>{rum.errorCount}</span>
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardHead}>
              <Globe24Regular />
              <Subtitle2>Page-load trend (p50 / p95, hourly)</Subtitle2>
            </div>
            {rum.trend.length > 1 ? (
              <LoomChart
                type="line"
                rows={rum.trend.map((p) => ({
                  Hour: p.ts.slice(5, 16).replace('T', ' '),
                  p50: p.p50Ms ?? 0,
                  p95: p.p95Ms ?? 0,
                }))}
                height={220}
              />
            ) : (
              <Caption1 className={styles.muted}>
                One data point so far — the trend line appears as more hourly buckets arrive.
              </Caption1>
            )}
          </div>

          <div className={styles.card}>
            <div className={styles.cardHead}>
              <PulseSquare24Regular />
              <Subtitle2>Web Vitals (p75)</Subtitle2>
              <Caption1 className={styles.muted}>{rum.vitals.samples} sampled page views</Caption1>
            </div>
            <div className={styles.tiles}>
              {([
                { label: 'LCP', value: rum.vitals.lcpP75Ms, display: fmtMs(rum.vitals.lcpP75Ms), good: 2500, poor: 4000 },
                { label: 'FCP', value: rum.vitals.fcpP75Ms, display: fmtMs(rum.vitals.fcpP75Ms), good: 1800, poor: 3000 },
                { label: 'TTFB', value: rum.vitals.ttfbP75Ms, display: fmtMs(rum.vitals.ttfbP75Ms), good: 800, poor: 1800 },
                { label: 'CLS', value: rum.vitals.clsP75, display: String(rum.vitals.clsP75 ?? '—'), good: 0.1, poor: 0.25 },
                { label: 'INP (approx)', value: rum.vitals.inpP75Ms, display: fmtMs(rum.vitals.inpP75Ms), good: 200, poor: 500 },
              ] as const).map((v) => (
                <div className={styles.tile} key={v.label}>
                  <span className={styles.tileLabel}>{v.label}</span>
                  <span className={styles.tileValue}>{v.display}</span>
                  <div>
                    <Badge appearance="tint" color={vitalBadge(v.value, v.good, v.poor)}>
                      {vitalLabel(v.value, v.good, v.poor)}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.twoCol}>
            <div className={styles.card}>
              <div className={styles.cardHead}>
                <Globe24Regular />
                <Subtitle2>Slowest surfaces</Subtitle2>
              </div>
              <div className={styles.tableWrap}>
                <Table size="small" aria-label="Per-surface load percentiles">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Surface</TableHeaderCell>
                      <TableHeaderCell>Views</TableHeaderCell>
                      <TableHeaderCell>p50</TableHeaderCell>
                      <TableHeaderCell>p95</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rum.surfaces.map((s) => (
                      <TableRow key={s.surface}>
                        <TableCell><Text font="monospace" size={200}>{s.surface}</Text></TableCell>
                        <TableCell>{s.views}</TableCell>
                        <TableCell>{fmtMs(s.p50Ms)}</TableCell>
                        <TableCell>{fmtMs(s.p95Ms)}</TableCell>
                      </TableRow>
                    ))}
                    {rum.surfaces.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4}>
                          <Caption1 className={styles.muted}>No hard page loads recorded in this window.</Caption1>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className={styles.card}>
              <div className={styles.cardHead}>
                <ErrorCircle24Regular />
                <Subtitle2>Top client errors</Subtitle2>
              </div>
              <div className={styles.tableWrap}>
                <Table size="small" aria-label="Top client errors">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Message</TableHeaderCell>
                      <TableHeaderCell>Surface</TableHeaderCell>
                      <TableHeaderCell>Count</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rum.errors.map((e, i) => (
                      <TableRow key={`${e.type}-${i}`}>
                        <TableCell><Badge appearance="tint" color="danger">{e.type}</Badge></TableCell>
                        <TableCell>
                          <span className={styles.errMsg} title={e.message}>{e.message}</span>
                        </TableCell>
                        <TableCell><Text font="monospace" size={200}>{e.surface}</Text></TableCell>
                        <TableCell>{e.count}</TableCell>
                      </TableRow>
                    ))}
                    {rum.errors.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4}>
                          <Caption1 className={styles.muted}>No client errors in this window — good.</Caption1>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
