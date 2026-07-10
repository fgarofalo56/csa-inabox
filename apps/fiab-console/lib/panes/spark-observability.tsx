'use client';

/**
 * SparkObservabilityPane — Monitor → Spark. The user-facing Spark-insights
 * reports over Loom Log Analytics, in three views:
 *
 *   1. Performance     — sortable applications/runs table → drill into per-app
 *                        metric summary + heuristic tuning recommendations.
 *   2. Troubleshooting — failed apps / apps with failure signals across the
 *                        window, with the error class + drill-in.
 *   3. Optimization    — tuning recommendations aggregated across recent apps,
 *                        each with the count of affected apps + concrete advice.
 *
 * Plus deep links to the native Spark diagnostic tools (Synapse Spark UI /
 * History Server, Databricks Spark UI). All data is live from Log Analytics via
 * /api/monitor/spark — no mocks.
 *
 * States (per no-vaporware):
 *   - 401          → <SignInRequired/>
 *   - gate         → styled MessageBar naming the exact env vars + the audit link
 *   - empty        → "telemetry not flowing yet" note + native links still shown
 * A timing status bar reports scan time + sample size on the report views.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  makeStyles, tokens, Spinner, Badge, Button, Caption1, Title3, Subtitle2, Text,
  MessageBar, MessageBarBody, MessageBarTitle, Divider, Link as FluentLink,
  TabList, Tab, type SelectTabData, type SelectTabEvent,
} from '@fluentui/react-components';
import {
  ArrowSync16Regular, Open16Regular, Flash20Regular, Lightbulb20Regular,
  ArrowLeft16Regular, Warning16Regular, CheckmarkCircle16Regular, ErrorCircle16Regular,
  Timer16Regular, WrenchScrewdriver20Regular, TopSpeed20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface SparkApplication {
  appId: string; name: string; engine: 'synapse-spark' | 'databricks';
  pool?: string; user?: string; start?: string; end?: string; durationMs?: number;
  status?: string; events?: number;
}
interface TuningRec {
  id: string; severity: 'info' | 'warning' | 'critical'; title: string; detail: string;
  conf?: { key: string; value: string }[]; presetId?: string;
}
interface FailureInsight {
  appId: string; name: string; engine: 'synapse-spark' | 'databricks';
  pool?: string; user?: string; start?: string; durationMs?: number; errorSignal: string;
}
interface OptimizationInsight extends TuningRec { affectedApps: number; sampleAppIds: string[]; }
interface InsightsScan {
  scannedAt: string; windowDays: number; sampled: number; totalApps: number;
  failures: FailureInsight[]; optimization: OptimizationInsight[]; elapsedMs: number;
}
interface NativeLink { label: string; href: string; detail: string; }

type ReportTab = 'performance' | 'troubleshooting' | 'optimization';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: 0 },
  linkGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: tokens.spacingHorizontalM },
  linkCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  linkHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  hint: { color: tokens.colorNeutralForeground3 },
  recList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  recCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    borderLeft: `3px solid ${tokens.colorNeutralStroke1}`, background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  recCardWarn: { borderLeftColor: tokens.colorPaletteYellowBorderActive },
  recCardCrit: { borderLeftColor: tokens.colorPaletteRedBorderActive },
  recHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  confChips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS },
  chip: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    padding: `2px ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  metricsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: tokens.spacingHorizontalM },
  metricCard: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1,
  },
  metricVal: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase500 },
  statusBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`, color: tokens.colorNeutralForeground3,
  },
});

function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60); return `${h}h ${m % 60}m`;
}
function fmtBytes(n?: number): string {
  if (typeof n !== 'number') return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}
function statusColor(s?: string): 'success' | 'danger' | 'warning' | 'informative' {
  const v = (s || '').toLowerCase();
  if (v.includes('succeed')) return 'success';
  if (v.includes('fail') || v.includes('error')) return 'danger';
  if (v.includes('run')) return 'warning';
  return 'informative';
}
function engineBadge(engine: 'synapse-spark' | 'databricks') {
  return (
    <Badge appearance="tint" color={engine === 'databricks' ? 'brand' : 'informative'}>
      {engine === 'databricks' ? 'Databricks' : 'Synapse'}
    </Badge>
  );
}

export function SparkObservabilityPane() {
  const s = useStyles();
  const [tab, setTab] = useState<ReportTab>('performance');

  // Shared / performance-tab state.
  const [loading, setLoading] = useState(true);
  const [unauth, setUnauth] = useState(false);
  const [gate, setGate] = useState<{ missing: string[]; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apps, setApps] = useState<SparkApplication[]>([]);
  const [telemetryConfigured, setTelemetryConfigured] = useState(true);
  const [links, setLinks] = useState<NativeLink[]>([]);

  // Drill-down (used by Performance + Troubleshooting).
  const [selected, setSelected] = useState<SparkApplication | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [metrics, setMetrics] = useState<Record<string, number> | null>(null);
  const [recs, setRecs] = useState<TuningRec[]>([]);

  // Insights scan (Troubleshooting + Optimization).
  const [scan, setScan] = useState<InsightsScan | null>(null);
  const [scanLoading, setScanLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true); setError(null); setGate(null);
    clientFetch('/api/monitor/spark?days=7&limit=100')
      .then(async (r) => {
        if (r.status === 401) { setUnauth(true); return; }
        const j = await r.json();
        if (!j.ok) { if (j.gate) setGate(j.gate); else setError(j.error || 'failed'); return; }
        setApps(j.applications || []);
        setTelemetryConfigured(j.telemetryConfigured !== false);
        setLinks(j.nativeLinks || []);
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);

  const loadScan = useCallback(() => {
    setScanLoading(true); setError(null);
    clientFetch('/api/monitor/spark?report=insights&days=7&sample=12')
      .then(async (r) => {
        if (r.status === 401) { setUnauth(true); return; }
        const j = await r.json();
        if (!j.ok) { if (j.gate) setGate(j.gate); else setError(j.error || 'failed'); return; }
        setScan(j.scan || null);
        setTelemetryConfigured(j.telemetryConfigured !== false);
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setScanLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  // Lazily scan the first time the user opens a report view that needs it.
  useEffect(() => {
    if ((tab === 'troubleshooting' || tab === 'optimization') && !scan && !scanLoading && !gate) loadScan();
  }, [tab, scan, scanLoading, gate, loadScan]);

  const drillInto = useCallback((app: SparkApplication) => {
    setSelected(app); setDrillLoading(true); setMetrics(null); setRecs([]);
    clientFetch(`/api/monitor/spark?appId=${encodeURIComponent(app.appId)}&days=7`)
      .then(async (r) => {
        const j = await r.json();
        if (j.ok) { setMetrics(j.metrics || {}); setRecs(j.recommendations || []); }
        else setError(j.error || 'failed to load app metrics');
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setDrillLoading(false));
  }, []);

  if (unauth) return <SignInRequired subject="Spark telemetry" />;

  if (gate) {
    return (
      <div className={s.root}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Spark telemetry not configured</MessageBarTitle>
            {gate.message}{' '}
            Admins can audit + fix telemetry routing for every Spark engine on the{' '}
            <FluentLink href="/admin/capacity">Capacity &amp; compute → Spark telemetry</FluentLink> page.
          </MessageBarBody>
        </MessageBar>
        {links.length > 0 && <NativeLinks links={links} styles={s} />}
      </div>
    );
  }

  // Drill-down view (from Performance or Troubleshooting).
  if (selected) {
    return (
      <div className={s.root}>
        <div className={s.toolbar}>
          <Button appearance="subtle" icon={<ArrowLeft16Regular />} onClick={() => setSelected(null)}>
            Back to reports
          </Button>
          <Title3>{selected.name}</Title3>
          {engineBadge(selected.engine)}
          {selected.status && <Badge appearance="tint" color={statusColor(selected.status)}>{selected.status}</Badge>}
        </div>
        <Caption1 className={s.hint}>{selected.appId}{selected.pool ? ` · ${selected.pool}` : ''} · {fmtDuration(selected.durationMs)}</Caption1>

        {drillLoading && <Spinner size="small" label="Reading application metrics…" />}

        {!drillLoading && metrics && (
          <>
            <Section title="Metrics">
              <div className={s.metricsGrid}>
                <MetricCard styles={s} label="Disk spill" value={fmtBytes(metrics.diskSpillBytes)} />
                <MetricCard styles={s} label="Shuffle read" value={fmtBytes(metrics.shuffleReadBytes)} />
                <MetricCard styles={s} label="Shuffle write" value={fmtBytes(metrics.shuffleWriteBytes)} />
                <MetricCard styles={s} label="Input" value={fmtBytes(metrics.inputBytes)} />
                <MetricCard styles={s} label="GC time" value={metrics.gcTimeMs != null ? fmtDuration(metrics.gcTimeMs) : '—'} />
                <MetricCard styles={s} label="Failed tasks" value={metrics.failedTasks != null ? String(metrics.failedTasks) : '—'} />
              </div>
              {Object.values(metrics).every((v) => v == null) && (
                <Caption1 className={s.hint} style={{ marginTop: tokens.spacingVerticalS }}>
                  No SparkMetrics rows for this application in the window. Metric-level detail requires the
                  Synapse Spark→LA metrics sink; the recommendations below still reflect what is available.
                </Caption1>
              )}
            </Section>

            <Section title="Performance-tuning recommendations">
              <div className={s.recList}>
                {recs.map((rec) => <RecCard key={rec.id} rec={rec} styles={s} />)}
              </div>
            </Section>
          </>
        )}

        {links.length > 0 && (
          <Section title="Open in native Spark tools">
            <NativeLinks links={links} styles={s} />
          </Section>
        )}
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Flash20Regular />
        <div className={s.grow}>
          <Subtitle2>Spark insights</Subtitle2>
          <Caption1 className={s.hint} style={{ display: 'block' }}>
            Live from Log Analytics — Synapse Spark (SparkListenerEvent) + Databricks runs. Performance, troubleshooting &amp; optimization.
          </Caption1>
        </div>
        <Button
          appearance="subtle" icon={<ArrowSync16Regular />}
          onClick={() => { load(); if (tab !== 'performance') loadScan(); }}
          disabled={loading || scanLoading}
        >
          Refresh
        </Button>
      </div>

      <TabList selectedValue={tab} onTabSelect={(_e: SelectTabEvent, d: SelectTabData) => setTab(d.value as ReportTab)}>
        <Tab value="performance" icon={<TopSpeed20Regular />}>Performance</Tab>
        <Tab value="troubleshooting" icon={<WrenchScrewdriver20Regular />}>Troubleshooting</Tab>
        <Tab value="optimization" icon={<Lightbulb20Regular />}>Optimization</Tab>
      </TabList>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Couldn&apos;t read Spark telemetry</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      {tab === 'performance' && (
        <PerformanceReport
          styles={s} apps={apps} loading={loading} error={error}
          telemetryConfigured={telemetryConfigured} onDrill={drillInto}
        />
      )}
      {tab === 'troubleshooting' && (
        <TroubleshootingReport styles={s} scan={scan} loading={scanLoading} onDrill={drillInto} />
      )}
      {tab === 'optimization' && (
        <OptimizationReport styles={s} scan={scan} loading={scanLoading} />
      )}

      {links.length > 0 && (
        <>
          <Divider />
          <Section title="Native Spark diagnostic tools">
            <NativeLinks links={links} styles={s} />
          </Section>
        </>
      )}
    </div>
  );
}

// ---- Performance report -----------------------------------------------------

function PerformanceReport({
  styles: s, apps, loading, error, telemetryConfigured, onDrill,
}: {
  styles: ReturnType<typeof useStyles>; apps: SparkApplication[]; loading: boolean;
  error: string | null; telemetryConfigured: boolean; onDrill: (a: SparkApplication) => void;
}) {
  const columns: LoomColumn<SparkApplication>[] = [
    { key: 'name', label: 'Application', sortable: true, filterable: true, width: 240,
      render: (a) => <Text weight="semibold">{a.name}</Text>, getValue: (a) => a.name },
    { key: 'engine', label: 'Engine', sortable: true, filterable: true, width: 130,
      render: (a) => engineBadge(a.engine), getValue: (a) => a.engine },
    { key: 'pool', label: 'Pool / cluster', sortable: true, filterable: true, width: 160, getValue: (a) => a.pool || '' },
    { key: 'user', label: 'Submitter', sortable: true, filterable: true, width: 150, getValue: (a) => a.user || '' },
    { key: 'start', label: 'Started', sortable: true, width: 170,
      render: (a) => <span>{a.start ? new Date(a.start).toLocaleString() : '—'}</span>, getValue: (a) => a.start || '' },
    { key: 'durationMs', label: 'Duration', sortable: true, width: 110,
      render: (a) => <span>{fmtDuration(a.durationMs)}</span>, getValue: (a) => String(a.durationMs ?? 0) },
    { key: 'status', label: 'Status', sortable: true, filterable: true, width: 120,
      render: (a) => a.status ? <Badge appearance="tint" color={statusColor(a.status)}>{a.status}</Badge> : <span className={s.hint}>—</span>,
      getValue: (a) => a.status || '' },
  ];
  return (
    <>
      {!loading && !error && apps.length === 0 && (
        <MessageBar intent={telemetryConfigured ? 'info' : 'warning'}>
          <MessageBarBody>
            <MessageBarTitle>No Spark applications in the last 7 days</MessageBarTitle>
            {telemetryConfigured
              ? 'The workspace is reachable but no Spark application telemetry has arrived yet. Run a notebook or Spark job — every Loom Spark session ships its events/metrics here automatically.'
              : 'Spark→Log-Analytics emission isn’t wired in this deployment (LOOM_SPARK_LA_WORKSPACE_ID unset), so sessions aren’t reporting telemetry. Set it to the Loom LA workspace + LOOM_SPARK_LA_KEY (or the Key-Vault refs) so Loom Spark sessions emit SparkListenerEvent / SparkMetrics. Meanwhile, open the native Spark tools below.'}
          </MessageBarBody>
        </MessageBar>
      )}
      <LoomDataTable
        columns={columns} rows={apps} getRowId={(a) => a.appId}
        loading={loading} skeleton={6} onRowClick={onDrill}
        ariaLabel="Spark applications" empty={null}
      />
    </>
  );
}

// ---- Troubleshooting report -------------------------------------------------

function TroubleshootingReport({
  styles: s, scan, loading, onDrill,
}: {
  styles: ReturnType<typeof useStyles>; scan: InsightsScan | null; loading: boolean;
  onDrill: (a: SparkApplication) => void;
}) {
  const columns: LoomColumn<FailureInsight>[] = [
    { key: 'name', label: 'Application', sortable: true, filterable: true, width: 230,
      render: (f) => <Text weight="semibold">{f.name}</Text>, getValue: (f) => f.name },
    { key: 'engine', label: 'Engine', sortable: true, filterable: true, width: 120,
      render: (f) => engineBadge(f.engine), getValue: (f) => f.engine },
    { key: 'errorSignal', label: 'Failure signal', sortable: true, filterable: true, width: 240,
      render: (f) => <Badge appearance="tint" color="danger" icon={<ErrorCircle16Regular />}>{f.errorSignal}</Badge>,
      getValue: (f) => f.errorSignal },
    { key: 'pool', label: 'Pool / cluster', sortable: true, filterable: true, width: 150, getValue: (f) => f.pool || '' },
    { key: 'start', label: 'Started', sortable: true, width: 170,
      render: (f) => <span>{f.start ? new Date(f.start).toLocaleString() : '—'}</span>, getValue: (f) => f.start || '' },
    { key: 'durationMs', label: 'Duration', sortable: true, width: 110,
      render: (f) => <span>{fmtDuration(f.durationMs)}</span>, getValue: (f) => String(f.durationMs ?? 0) },
  ];
  const rows = scan?.failures || [];
  return (
    <>
      {!loading && scan && rows.length === 0 && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>No failing Spark applications</MessageBarTitle>
            None of the {scan.sampled} most-recent applications reported a failure or failure signal in the last {scan.windowDays} days.
          </MessageBarBody>
        </MessageBar>
      )}
      <LoomDataTable
        columns={columns} rows={rows} getRowId={(f) => f.appId}
        loading={loading} skeleton={5}
        onRowClick={(f) => onDrill({ appId: f.appId, name: f.name, engine: f.engine, pool: f.pool, user: f.user, start: f.start, durationMs: f.durationMs, status: 'Failed' })}
        ariaLabel="Failed Spark applications" empty={null}
      />
      <TimingBar scan={scan} loading={loading} noun="applications scanned" />
    </>
  );
}

// ---- Optimization report ----------------------------------------------------

function OptimizationReport({
  styles: s, scan, loading,
}: {
  styles: ReturnType<typeof useStyles>; scan: InsightsScan | null; loading: boolean;
}) {
  const recs = scan?.optimization || [];
  return (
    <>
      {loading && <Spinner size="small" label="Scanning recent applications…" />}
      {!loading && scan && recs.length === 0 && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>No optimization opportunities detected</MessageBarTitle>
            The {scan.sampled} most-recent applications show no spill, skew, GC pressure, or over/under-provisioning worth acting on.
          </MessageBarBody>
        </MessageBar>
      )}
      {!loading && recs.length > 0 && (
        <div className={s.recList}>
          {recs.map((rec) => (
            <div
              key={rec.id}
              className={`${s.recCard} ${rec.severity === 'critical' ? s.recCardCrit : rec.severity === 'warning' ? s.recCardWarn : ''}`}
            >
              <div className={s.recHead}>
                {rec.severity === 'critical' ? <ErrorCircle16Regular /> : rec.severity === 'warning' ? <Warning16Regular /> : <Lightbulb20Regular />}
                <Text weight="semibold">{rec.title}</Text>
                <Badge appearance="outline" size="small" color={rec.affectedApps > 1 ? 'danger' : 'informative'}>
                  {rec.affectedApps} app{rec.affectedApps === 1 ? '' : 's'}
                </Badge>
                {rec.presetId && <Badge appearance="outline" size="small">preset: {rec.presetId}</Badge>}
              </div>
              <Caption1>{rec.detail}</Caption1>
              {rec.conf && rec.conf.length > 0 && (
                <div className={s.confChips}>
                  {rec.conf.map((c) => <span key={c.key} className={s.chip}>{c.key} = {c.value}</span>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <TimingBar scan={scan} loading={loading} noun="applications scanned" />
    </>
  );
}

// ---- shared bits ------------------------------------------------------------

function TimingBar({ scan, loading, noun }: { scan: InsightsScan | null; loading: boolean; noun: string }) {
  const s = useStyles();
  if (loading) return <div className={s.statusBar}><Spinner size="tiny" /><Caption1>Scanning Log Analytics…</Caption1></div>;
  if (!scan) return null;
  return (
    <div className={s.statusBar}>
      <Timer16Regular />
      <Caption1>
        {scan.sampled} of {scan.totalApps} {noun} · {scan.windowDays}-day window · {scan.elapsedMs} ms · {new Date(scan.scannedAt).toLocaleTimeString()}
      </Caption1>
    </div>
  );
}

function MetricCard({ styles, label, value }: { styles: ReturnType<typeof useStyles>; label: string; value: string }) {
  return (
    <div className={styles.metricCard}>
      <Caption1 className={styles.hint}>{label}</Caption1>
      <span className={styles.metricVal}>{value}</span>
    </div>
  );
}

function RecCard({ rec, styles }: { rec: TuningRec; styles: ReturnType<typeof useStyles> }) {
  const cls = `${styles.recCard} ${rec.severity === 'critical' ? styles.recCardCrit : rec.severity === 'warning' ? styles.recCardWarn : ''}`;
  const Icon = rec.severity === 'critical' ? ErrorCircle16Regular : rec.severity === 'warning' ? Warning16Regular
    : rec.id === 'healthy' ? CheckmarkCircle16Regular : Lightbulb20Regular;
  return (
    <div className={cls}>
      <div className={styles.recHead}>
        <Icon />
        <Text weight="semibold">{rec.title}</Text>
        {rec.presetId && <Badge appearance="outline" size="small">preset: {rec.presetId}</Badge>}
      </div>
      <Caption1>{rec.detail}</Caption1>
      {rec.conf && rec.conf.length > 0 && (
        <div className={styles.confChips}>
          {rec.conf.map((c) => <span key={c.key} className={styles.chip}>{c.key} = {c.value}</span>)}
        </div>
      )}
    </div>
  );
}

function NativeLinks({ links, styles }: { links: NativeLink[]; styles: ReturnType<typeof useStyles> }) {
  return (
    <div className={styles.linkGrid}>
      {links.map((l) => (
        <div key={l.href} className={styles.linkCard}>
          <div className={styles.linkHead}>
            <Open16Regular />
            <FluentLink href={l.href} target="_blank" rel="noreferrer"><Text weight="semibold">{l.label}</Text></FluentLink>
          </div>
          <Caption1 className={styles.hint}>{l.detail}</Caption1>
        </div>
      ))}
    </div>
  );
}
