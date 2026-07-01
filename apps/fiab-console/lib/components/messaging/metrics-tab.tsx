'use client';

/**
 * MessagingMetricsTab — the shared Metrics blade for the three messaging
 * namespace editors (Event Hubs / Service Bus / Event Grid). Queries the real
 * Azure Monitor metrics REST surface via /api/messaging/metrics and renders one
 * MetricChart tile per metric (the same lightweight SVG tiles the Monitor hub
 * uses), with a 1h/6h/24h range switch and Refresh.
 *
 * Honest gates (no-vaporware): a 503 config-gate or a 403 "grant Monitoring
 * Reader" gate renders as a styled Fluent MessageBar naming the exact
 * remediation — the surface still renders. No mocks; every point is a real
 * Azure Monitor sample.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Caption1, Button, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  ToggleButton,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync20Regular, DataTrending20Regular } from '@fluentui/react-icons';
import { MetricChart, type MetricPoint } from '@/lib/components/monitor/metric-chart';

export type MessagingKind = 'event-hubs' | 'service-bus' | 'event-grid';

interface MetricSeries {
  name: string;
  label: string;
  unit: string;
  aggregation: string;
  points: MetricPoint[];
}

const RANGES: { key: string; label: string }[] = [
  { key: '1h', label: '1 hour' },
  { key: '6h', label: '6 hours' },
  { key: '24h', label: '24 hours' },
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  ranges: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' },
  spacer: { flex: 1 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: tokens.spacingVerticalM,
    minWidth: 0,
  },
  hint: { color: tokens.colorNeutralForeground3 },
});

interface Props {
  kind: MessagingKind;
  /** Event Grid metrics are per-topic; required for kind==='event-grid'. */
  topic?: string;
  /** Optional label shown as a badge (namespace/topic name). */
  scopeLabel?: string;
}

export function MessagingMetricsTab({ kind, topic, scopeLabel }: Props) {
  const s = useStyles();
  const [range, setRange] = useState('1h');
  const [loading, setLoading] = useState(true);
  const [series, setSeries] = useState<MetricSeries[] | null>(null);
  const [gate, setGate] = useState<{ title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needTopic = kind === 'event-grid' && !topic;

  const load = useCallback(async () => {
    if (needTopic) { setLoading(false); return; }
    setLoading(true); setGate(null); setError(null);
    try {
      const qs = new URLSearchParams({ kind, range });
      if (topic) qs.set('topic', topic);
      const r = await fetch(`/api/messaging/metrics?${qs.toString()}`);
      const j = await r.json();
      if (!j.ok) {
        if (j.code === 'not_configured') {
          setGate({ title: 'Metrics unavailable', body: j.error || 'This resource is not configured.' });
        } else if (j.code === 'forbidden') {
          setGate({
            title: 'Grant Monitoring Reader',
            body: j.error || 'Reading metrics was denied — grant the Console UAMI the "Monitoring Reader" role on this resource.',
          });
        } else {
          setError(j.error || 'Failed to load metrics.');
        }
        setSeries(null);
        return;
      }
      setSeries(Array.isArray(j.metrics) ? j.metrics : []);
    } catch (e: any) {
      setError(e?.message || String(e));
      setSeries(null);
    } finally {
      setLoading(false);
    }
  }, [kind, topic, range, needTopic]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <DataTrending20Regular />
        <Subtitle2>Metrics</Subtitle2>
        {scopeLabel && <Badge appearance="outline">{scopeLabel}</Badge>}
        <div className={s.spacer} />
        <div className={s.ranges}>
          {RANGES.map((r) => (
            <ToggleButton
              key={r.key}
              size="small"
              appearance={range === r.key ? 'primary' : 'subtle'}
              checked={range === r.key}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </ToggleButton>
          ))}
        </div>
        <Button appearance="outline" size="small" icon={<ArrowSync20Regular />} onClick={() => void load()}>Refresh</Button>
      </div>

      <Caption1 className={s.hint}>
        Live Azure Monitor platform metrics (Microsoft.Insights/metrics) for this{' '}
        {kind === 'event-grid' ? 'topic' : 'namespace'}. Values are aggregated per sample interval.
      </Caption1>

      {needTopic && (
        <MessageBar intent="info">
          <MessageBarBody>Select a topic on the Topics tab to view its metrics.</MessageBarBody>
        </MessageBar>
      )}

      {loading && <Spinner size="small" label="Loading metrics…" labelPosition="after" />}

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{gate.title}</MessageBarTitle>
            {gate.body}
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {!loading && !gate && !error && series && series.length > 0 && (
        <div className={s.grid}>
          {series.map((m) => (
            <MetricChart key={m.name} title={m.label} unit={m.unit} points={m.points} />
          ))}
        </div>
      )}

      {!loading && !gate && !error && series && series.length === 0 && (
        <MessageBar intent="info"><MessageBarBody>No metrics returned for this resource.</MessageBarBody></MessageBar>
      )}
    </div>
  );
}
