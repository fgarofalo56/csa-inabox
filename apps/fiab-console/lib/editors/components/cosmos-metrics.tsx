'use client';

/**
 * CosmosMetrics — the Cosmos DB account/container **Metrics** surface, one-for-one
 * with the Azure portal Cosmos DB "Metrics" / "Insights" blades. Charts the live
 * Azure Monitor platform metrics for the configured navigator account:
 *
 *   - RU consumed vs provisioned  (TotalRequestUnits vs ProvisionedThroughput) —
 *     two adjacent sparkline tiles so saturation against the provisioned ceiling
 *     is obvious, exactly like the portal "Normalized RU Consumption" + throughput
 *     overlay.
 *   - Data storage               (DataUsage)
 *   - Throttled requests (429)   (TotalRequests filtered StatusCode '429') — the
 *     "rate limited / 429" signal Cosmos operators watch for under-provisioning.
 *
 * Real backend only (per no-vaporware.md): every series comes from
 *   GET /api/items/cosmos-db/{id}/metrics?db&container&timespan
 * which calls the Azure Monitor metrics REST surface via monitor-client. A
 * container with no traffic in the window renders an honest "No data points in
 * window" tile (from MetricChart), never fabricated data. When the account is
 * unconfigured the route 503s and we show the env-var infra gate.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Caption1, MessageBar, MessageBarBody, MessageBarTitle,
  Select, Field, Spinner, Subtitle2, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync20Regular } from '@fluentui/react-icons';
import { MetricChart, type MetricPoint } from '@/lib/components/monitor/metric-chart';

interface MetricSeries {
  name: string;
  unit?: string;
  aggregation?: string;
  points: MetricPoint[];
}

export interface CosmosMetricsProps {
  /** Fabric item UUID — passed through to the route path (config comes from env). */
  id: string;
  /** Database to scope to (optional → account-level aggregate). */
  db?: string;
  /** Container to scope to (optional; requires db). */
  container?: string;
}

const TIMESPANS = [
  { value: 'PT1H', label: 'Last 1 hour' },
  { value: 'PT6H', label: 'Last 6 hours' },
  { value: 'P1D', label: 'Last 24 hours' },
  { value: 'P7D', label: 'Last 7 days' },
];

const METRIC_META: Record<string, { label: string; unit: string }> = {
  TotalRequestUnits: { label: 'RU consumed', unit: 'RU' },
  ProvisionedThroughput: { label: 'Provisioned throughput', unit: 'RU/s' },
  DataUsage: { label: 'Data storage', unit: 'bytes' },
  TotalRequests: { label: 'Throttled requests (429)', unit: 'count' },
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '14px', minHeight: 0 },
  controls: { display: 'flex', alignItems: 'flex-end', gap: '10px', flexWrap: 'wrap' },
  scope: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: '12px',
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' },
});

function metaFor(name: string): { label: string; unit: string } {
  return METRIC_META[name] || { label: name, unit: '' };
}

export function CosmosMetrics({ id, db, container }: CosmosMetricsProps) {
  const s = useStyles();
  const [timespan, setTimespan] = useState('PT1H');
  const [metrics, setMetrics] = useState<MetricSeries[] | null>(null);
  const [throttled, setThrottled] = useState<MetricSeries[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing?: string; hint?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setGate(null);
    try {
      const qs = new URLSearchParams({ timespan });
      if (db) qs.set('db', db);
      if (container) qs.set('container', container);
      const r = await fetch(`/api/items/cosmos-db/${encodeURIComponent(id)}/metrics?${qs.toString()}`);
      const text = await r.text();
      let j: any = {};
      try { j = text ? JSON.parse(text) : {}; } catch { j = { ok: false, error: text || `HTTP ${r.status}` }; }
      if (j?.code === 'not_configured') {
        setGate({ missing: j.missing, hint: j.hint });
        setMetrics(null);
        setThrottled(null);
        return;
      }
      if (!j?.ok) {
        setError(j?.error || `Failed to load metrics (HTTP ${r.status})`);
        return;
      }
      setMetrics(j.metrics || []);
      setThrottled(j.throttled || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id, db, container, timespan]);

  useEffect(() => { void load(); }, [load]);

  const scopeLabel = db
    ? (container ? `${db} / ${container}` : `${db} (all containers)`)
    : 'Account (all databases)';

  // RU consumed + provisioned shown together so saturation is obvious; storage
  // and the 429 throttle series follow.
  const ruAndProvisioned = (metrics || []).filter(
    (m) => m.name === 'TotalRequestUnits' || m.name === 'ProvisionedThroughput',
  );
  const storage = (metrics || []).filter((m) => m.name === 'DataUsage');

  return (
    <div className={s.root}>
      <div className={s.controls}>
        <Field label="Time range" style={{ minWidth: 180 }}>
          <Select value={timespan} onChange={(_, d) => setTimespan(d.value)} disabled={loading}>
            {TIMESPANS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </Field>
        <div className={s.scope}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Scope</Caption1>
          <Badge appearance="tint" size="medium">{scopeLabel}</Badge>
        </div>
        <span className={s.spacer} />
        <Button
          appearance="outline" icon={<ArrowSync20Regular />}
          onClick={() => void load()} disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Cosmos DB account not configured</MessageBarTitle>
            {gate.missing && <>Set <code>{gate.missing}</code> on the Console Container App. </>}
            {gate.hint || 'Configure the Cosmos navigator account and grant the Console UAMI Monitoring Reader.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Metrics error</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      {loading && !metrics && !gate && <Spinner size="tiny" label="Loading Azure Monitor metrics…" />}

      {metrics && !gate && (
        <>
          <div className={s.sectionHead}>
            <Subtitle2>Request Units — consumed vs provisioned</Subtitle2>
          </div>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Compare consumed RU (left) against the provisioned RU/s ceiling (right). When consumed
            approaches the ceiling Cosmos starts rate-limiting requests (429s, below).
          </Caption1>
          <div className={s.grid}>
            {ruAndProvisioned.map((m) => (
              <MetricChart key={m.name} title={metaFor(m.name).label} unit={metaFor(m.name).unit || m.unit} points={m.points} />
            ))}
            {ruAndProvisioned.length === 0 && (
              <Caption1>No RU series returned for this scope in the selected window.</Caption1>
            )}
          </div>

          <div className={s.sectionHead}>
            <Subtitle2>Storage</Subtitle2>
          </div>
          <div className={s.grid}>
            {storage.map((m) => (
              <MetricChart key={m.name} title={metaFor(m.name).label} unit={metaFor(m.name).unit || m.unit} points={m.points} />
            ))}
            {storage.length === 0 && (
              <Caption1>No storage series returned for this scope in the selected window.</Caption1>
            )}
          </div>

          <div className={s.sectionHead}>
            <Subtitle2>Throttling — HTTP 429 (rate limited)</Subtitle2>
          </div>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Real count of requests Cosmos rate-limited with HTTP 429 in each interval. A flat
            zero series means no throttling occurred — increase provisioned RU/s if this rises.
          </Caption1>
          <div className={s.grid}>
            {(throttled || []).map((m) => (
              <MetricChart key={m.name} title={metaFor(m.name).label} unit={metaFor(m.name).unit || m.unit} points={m.points} />
            ))}
            {(!throttled || throttled.length === 0) && (
              <Caption1>No 429 series returned for this scope in the selected window.</Caption1>
            )}
          </div>
        </>
      )}
    </div>
  );
}
