'use client';

/**
 * PSR-1 — /admin/performance editor.
 *
 * Repeatable performance suite surface: per-metric p50/p95 trend charts (each
 * with its Fabric-bar reference line), a "Run benchmark now" action that fires
 * the suite server-side against the live estate, and honest MessageBar gates for
 * any unconfigured backend. Fluent v9 + Loom tokens only (web3-ui.md); real
 * Cosmos-backed trend (no-vaporware.md); Azure-native backends only
 * (no-fabric-dependency.md).
 */
import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Body1,
  Caption1,
  Text,
  Badge,
  Button,
  Spinner,
  Switch,
  Dropdown,
  Option,
  ProgressBar,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Play20Regular, Timer20Regular, Server20Regular, Globe20Regular } from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';
import { useAdminTabStyles } from '@/lib/components/ui/admin-tab-styles';
import { PerfMetricCard } from '@/lib/components/admin/perf-metric-card';
import { SparkPoolCard } from '@/lib/components/admin/spark-pool-card';
import { isPageTtiMetric } from '@/lib/perf/perf-metrics';
import type { MetricTrend, TrendModel } from '@/lib/perf/perf-store';

interface RunStatus {
  status: 'running' | 'completed' | 'failed';
  totalMetrics: number;
  completedMetrics: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
}
interface Gate {
  missing: string[];
  message: string;
}

const SAMPLE_CHOICES = [
  { key: '4', label: '4 samples (quick)' },
  { key: '6', label: '6 samples (default)' },
  { key: '10', label: '10 samples (thorough)' },
];

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground2, lineHeight: 1.55, marginBottom: tokens.spacingVerticalL },
  explainer: { marginBottom: tokens.spacingVerticalL },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalL,
  },
  stat: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  statIcon: {
    flexShrink: 0,
    width: '40px',
    height: '40px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  statBody: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  statLabel: {
    fontSize: tokens.fontSizeBase100,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  statValue: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightBold,
    marginTop: tokens.spacingVerticalXXS,
    lineHeight: 1.1,
  },
  progressWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginBottom: tokens.spacingVerticalL },
  grid: { marginBottom: tokens.spacingVerticalL },
  muted: { color: tokens.colorNeutralForeground3 },
});

export function PerformanceEditor() {
  const styles = useStyles();
  const a = useAdminTabStyles();
  const [model, setModel] = useState<TrendModel | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [samples, setSamples] = useState('6');
  const [includeSpark, setIncludeSpark] = useState(false);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    setGate(null);
    clientFetch('/api/admin/performance', { cache: 'no-store' }, 30_000)
      .then(async (r) => {
        if (r.status === 401) {
          setUnauth(true);
          return null;
        }
        return r.json();
      })
      .then((j: any) => {
        if (!j) return;
        if (j.ok) {
          setModel(j.data as TrendModel);
          if (j.gate) setGate(j.gate as Gate);
        } else {
          setError(j.error || 'Failed to load benchmark trend');
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [load]);

  const poll = useCallback(
    (runId: string) => {
      clientFetch(`/api/admin/performance/run?runId=${encodeURIComponent(runId)}`, { cache: 'no-store' }, 30_000)
        .then((r) => r.json())
        .then((j: any) => {
          if (j?.ok && j.status) {
            setRunStatus(j.status as RunStatus);
            if (j.status.status === 'running') {
              pollRef.current = setTimeout(() => poll(runId), 3000);
            } else {
              setRunning(false);
              load(); // refresh the trend with the new run appended
            }
          } else {
            // Keep polling a bit in case the status doc isn't visible yet.
            pollRef.current = setTimeout(() => poll(runId), 3000);
          }
        })
        .catch(() => {
          pollRef.current = setTimeout(() => poll(runId), 4000);
        });
    },
    [load],
  );

  const runNow = useCallback(() => {
    setRunning(true);
    setRunStatus(null);
    setError(null);
    clientFetch(
      '/api/admin/performance/run',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ samples: Number(samples), includeSpark }),
      },
      30_000,
    )
      .then(async (r) => {
        if (r.status === 401) {
          setUnauth(true);
          setRunning(false);
          return null;
        }
        return r.json();
      })
      .then((j: any) => {
        if (!j) return;
        if (j.ok && j.runId) {
          setRunStatus({ status: 'running', totalMetrics: j.totalMetrics ?? 0, completedMetrics: 0, startedAt: new Date().toISOString() });
          poll(j.runId);
        } else {
          setRunning(false);
          setError(j.error || j.reason || 'Failed to start benchmark run');
        }
      })
      .catch((e) => {
        setRunning(false);
        setError(String(e));
      });
  }, [samples, includeSpark, poll]);

  const { engineMetrics, surfaceMetrics } = useMemo(() => {
    const metrics = model?.metrics ?? [];
    const engine: MetricTrend[] = [];
    const surface: MetricTrend[] = [];
    for (const m of metrics) (isPageTtiMetric(m.metric) ? surface : engine).push(m);
    return { engineMetrics: engine, surfaceMetrics: surface };
  }, [model]);

  const lastRun = model?.runs?.[0];

  if (unauth) return <SignInRequired subject="performance benchmarks" />;

  return (
    <>
      <Body1 className={styles.intro}>
        A repeatable performance suite that measures the numbers users feel — Spark attach, warehouse
        and ADX query latency, dashboard tile TTI, Copilot turn latency, and page TTI for the top
        surfaces — against real Azure-native backends, then persists and trends them. Each chart shows
        the current p50/p95 with the published <strong>Microsoft Fabric bar</strong> as an
        outcome-equivalence reference line.
      </Body1>

      <div className={styles.explainer}>
        <SectionExplainer>
          Every metric drives a real backend (Synapse serverless/dedicated, Azure Data Explorer, Azure
          OpenAI, and HTML GET timing) — no Fabric dependency. Results write to the{' '}
          <code>perf-benchmarks</code> Cosmos container and trend across rolls.
          <LearnPopover
            title="Benchmark harness (PSR-1)"
            content="Run drives each backend N times, records p50/p95/p99 + cold-vs-warm, and appends a run document. The Fabric reference lines (starter-pool ~5-10s attach, Direct Lake sub-second, RTI 2-30s) are outcome-equivalence targets, not mechanism-parity claims. Spark attach + notebook round-trip are off by default because they spend real compute."
            learnMoreHref="https://learn.microsoft.com/fabric/data-engineering/configure-starter-pools"
          />
        </SectionExplainer>
      </div>

      {error && (
        <MessageBar intent="error" className={a.messageBar}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {gate && (
        <MessageBar intent="warning" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Trend store not configured</MessageBarTitle>
            {gate.message}
          </MessageBarBody>
        </MessageBar>
      )}

      {runStatus?.status === 'failed' && (
        <MessageBar intent="error" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Benchmark run failed</MessageBarTitle>
            {runStatus.error || 'The run did not complete. See console logs.'}
          </MessageBarBody>
        </MessageBar>
      )}

      <SparkPoolCard />

      <Section
        title="Benchmark run"
        actions={
          <div className={styles.toolbar}>
            <Switch
              checked={includeSpark}
              onChange={(_, d) => setIncludeSpark(!!d.checked)}
              label="Include Spark (billed)"
              disabled={running}
            />
            <Dropdown
              value={SAMPLE_CHOICES.find((c) => c.key === samples)?.label ?? samples}
              selectedOptions={[samples]}
              onOptionSelect={(_, d) => setSamples(d.optionValue ?? '6')}
              disabled={running}
            >
              {SAMPLE_CHOICES.map((c) => (
                <Option key={c.key} value={c.key}>
                  {c.label}
                </Option>
              ))}
            </Dropdown>
            <Button appearance="primary" icon={<Play20Regular />} onClick={runNow} disabled={running}>
              {running ? 'Running…' : 'Run benchmark now'}
            </Button>
          </div>
        }
      >
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statIcon} aria-hidden>
              <Timer20Regular />
            </span>
            <div className={styles.statBody}>
              <div className={styles.statLabel}>Runs recorded</div>
              <div className={styles.statValue}>{model?.runs?.length ?? 0}</div>
            </div>
          </div>
          <div className={styles.stat}>
            <span className={styles.statIcon} aria-hidden>
              <Server20Regular />
            </span>
            <div className={styles.statBody}>
              <div className={styles.statLabel}>Engine metrics</div>
              <div className={styles.statValue}>{engineMetrics.length}</div>
            </div>
          </div>
          <div className={styles.stat}>
            <span className={styles.statIcon} aria-hidden>
              <Globe20Regular />
            </span>
            <div className={styles.statBody}>
              <div className={styles.statLabel}>Surfaces (page TTI)</div>
              <div className={styles.statValue}>{surfaceMetrics.length}</div>
            </div>
          </div>
        </div>

        {running && runStatus && (
          <div className={styles.progressWrap}>
            <Caption1>
              Running benchmark — {runStatus.completedMetrics}/{runStatus.totalMetrics} metrics
            </Caption1>
            <ProgressBar
              value={runStatus.totalMetrics > 0 ? runStatus.completedMetrics / runStatus.totalMetrics : undefined}
            />
          </div>
        )}

        {loading ? (
          <Spinner label="Loading benchmark trend…" />
        ) : (
          <Text className={styles.muted}>
            {lastRun ? (
              <>
                Last run {new Date(lastRun.ts).toLocaleString()} · rev <code>{lastRun.rev}</code> ·{' '}
                <code>{lastRun.gitSha.slice(0, 12)}</code>
              </>
            ) : (
              'No benchmark run recorded yet — click "Run benchmark now" to measure the live estate.'
            )}
          </Text>
        )}
      </Section>

      {!loading && engineMetrics.length > 0 && (
        <Section title="Engines">
          <TileGrid minTileWidth={360} className={styles.grid}>
            {engineMetrics.map((m) => (
              <PerfMetricCard key={m.metric} trend={m} />
            ))}
          </TileGrid>
        </Section>
      )}

      {!loading && surfaceMetrics.length > 0 && (
        <Section title="Page TTI — top surfaces">
          <TileGrid minTileWidth={360} className={styles.grid}>
            {surfaceMetrics.map((m) => (
              <PerfMetricCard key={m.metric} trend={m} />
            ))}
          </TileGrid>
        </Section>
      )}

      {!loading && !gate && engineMetrics.length === 0 && surfaceMetrics.length === 0 && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>No benchmark data yet</MessageBarTitle>
            Click <strong>Run benchmark now</strong> to drive every configured backend and record the
            first run. Metrics whose backend is unconfigured will show an honest gate naming the exact
            env var to set.
          </MessageBarBody>
        </MessageBar>
      )}
    </>
  );
}

export default PerformanceEditor;
