'use client';

/**
 * SparkObservabilityPane — Monitor → Spark. Analytics, performance-tuning, and
 * troubleshooting for Spark applications + runs, plus deep links to the native
 * Spark diagnostic tools (Synapse Spark UI / History Server, Databricks Spark
 * UI). All data is live from Log Analytics via /api/monitor/spark — no mocks.
 *
 * States (per no-vaporware):
 *   - 401          → <SignInRequired/>
 *   - gate         → styled MessageBar naming the exact env vars to set
 *   - empty list   → "telemetry not flowing yet" note + native links still shown
 *   - data         → sortable applications table; click a row to drill into its
 *                    metric summary + heuristic tuning recommendations.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  makeStyles, tokens, Spinner, Badge, Button, Caption1, Title3, Subtitle2, Text,
  MessageBar, MessageBarBody, MessageBarTitle, Divider, Link as FluentLink,
} from '@fluentui/react-components';
import {
  ArrowSync16Regular, Open16Regular, Flash20Regular, Lightbulb20Regular,
  ArrowLeft16Regular, Warning16Regular, CheckmarkCircle16Regular, ErrorCircle16Regular,
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
interface NativeLink { label: string; href: string; detail: string; }

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  grow: { flex: 1 },
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
  recHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
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

export function SparkObservabilityPane() {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [unauth, setUnauth] = useState(false);
  const [gate, setGate] = useState<{ missing: string[]; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apps, setApps] = useState<SparkApplication[]>([]);
  const [telemetryConfigured, setTelemetryConfigured] = useState(true);
  const [links, setLinks] = useState<NativeLink[]>([]);

  const [selected, setSelected] = useState<SparkApplication | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [metrics, setMetrics] = useState<Record<string, number> | null>(null);
  const [recs, setRecs] = useState<TuningRec[]>([]);

  const load = useCallback(() => {
    setLoading(true); setError(null); setGate(null);
    clientFetch('/api/monitor/spark?days=7&limit=100')
      .then(async (r) => {
        if (r.status === 401) { setUnauth(true); return; }
        const j = await r.json();
        if (!j.ok) {
          if (j.gate) setGate(j.gate); else setError(j.error || 'failed');
          return;
        }
        setApps(j.applications || []);
        setTelemetryConfigured(j.telemetryConfigured !== false);
        setLinks(j.nativeLinks || []);
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

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
            {gate.message}
          </MessageBarBody>
        </MessageBar>
        {links.length > 0 && <NativeLinks links={links} styles={s} />}
      </div>
    );
  }

  // Drill-down view.
  if (selected) {
    return (
      <div className={s.root}>
        <div className={s.toolbar}>
          <Button appearance="subtle" icon={<ArrowLeft16Regular />} onClick={() => setSelected(null)}>
            All applications
          </Button>
          <Title3>{selected.name}</Title3>
          <Badge appearance="tint" color={selected.engine === 'databricks' ? 'brand' : 'informative'}>
            {selected.engine === 'databricks' ? 'Databricks' : 'Synapse Spark'}
          </Badge>
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

  // List view.
  const columns: LoomColumn<SparkApplication>[] = [
    { key: 'name', label: 'Application', sortable: true, filterable: true, width: 240,
      render: (a) => <Text weight="semibold">{a.name}</Text>, getValue: (a) => a.name },
    { key: 'engine', label: 'Engine', sortable: true, filterable: true, width: 130,
      render: (a) => <Badge appearance="tint" color={a.engine === 'databricks' ? 'brand' : 'informative'}>{a.engine === 'databricks' ? 'Databricks' : 'Synapse'}</Badge>,
      getValue: (a) => a.engine },
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
    <div className={s.root}>
      <div className={s.toolbar}>
        <Flash20Regular />
        <div className={s.grow}>
          <Subtitle2>Spark applications &amp; runs</Subtitle2>
          <Caption1 className={s.hint} style={{ display: 'block' }}>
            Live from Log Analytics — Synapse Spark (SparkListenerEvent) + Databricks runs. Click a row for metrics &amp; tuning.
          </Caption1>
        </div>
        <Button appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Couldn&apos;t read Spark telemetry</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

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
        columns={columns}
        rows={apps}
        getRowId={(a) => a.appId}
        loading={loading}
        skeleton={6}
        onRowClick={drillInto}
        ariaLabel="Spark applications"
        empty={null}
      />

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
