import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { PerfMetricCard } from '../perf-metric-card';
import type { MetricTrend, TrendPoint } from '@/lib/perf/perf-store';

afterEach(cleanup);

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

function point(overrides: Partial<TrendPoint>): TrendPoint {
  return {
    runId: 'r1',
    gitSha: 'abc123def456',
    rev: 'rev-1',
    ts: '2026-07-09T12:00:00.000Z',
    p50: 120,
    p95: 240,
    p99: 300,
    coldMs: 500,
    warmMs: 110,
    ...overrides,
  };
}

describe('PerfMetricCard', () => {
  it('renders the metric label, current p50/p95, and the Fabric bar', () => {
    const trend: MetricTrend = {
      metric: 'adx-query',
      backend: 'adx',
      points: [point({ runId: 'r0', ts: '2026-07-08T12:00:00.000Z' }), point({})],
      latest: point({}),
    };
    wrap(<PerfMetricCard trend={trend} />);
    expect(screen.getByText('ADX query')).toBeInTheDocument();
    // 'p50' appears both as a stat label and in the chart legend — assert ≥1.
    expect(screen.getAllByText('p50').length).toBeGreaterThan(0);
    // The formatted p50 value tile is unique.
    expect(screen.getByText('120 ms')).toBeInTheDocument();
    // Fabric reference-line label surfaces on the card.
    expect(screen.getAllByText(/Fabric RTI/i).length).toBeGreaterThan(0);
  });

  it('shows an honest gate when the latest point is gated', () => {
    const gated = point({ p50: null, p95: null, p99: null, coldMs: null, warmMs: null, gated: true });
    const trend: MetricTrend = {
      metric: 'warehouse-query-dedicated',
      backend: 'synapse-dedicated',
      points: [gated],
      latest: gated,
    };
    wrap(<PerfMetricCard trend={trend} />);
    expect(screen.getByText('Backend not configured')).toBeInTheDocument();
  });

  it('live config CONFIGURED overrides a stale gated run — no false "not set"', () => {
    // The live production bug: last run recorded gated=true (env was unset then),
    // but LOOM_SYNAPSE_WORKSPACE IS set now. The card must NOT claim it is unset.
    const staleGated = point({ p50: null, p95: null, p99: null, coldMs: null, warmMs: null, gated: true, gateEnv: 'LOOM_SYNAPSE_WORKSPACE' });
    const trend: MetricTrend = {
      metric: 'warehouse-query-serverless',
      backend: 'synapse-serverless',
      points: [staleGated],
      latest: staleGated,
    };
    wrap(<PerfMetricCard trend={trend} config={{ configured: true }} />);
    expect(screen.queryByText('Backend not configured')).not.toBeInTheDocument();
    expect(screen.queryByText(/is not set in this deployment/)).not.toBeInTheDocument();
    // Instead it prompts a run against the now-configured backend.
    expect(screen.getByText('Backend configured — not yet measured')).toBeInTheDocument();
  });

  it('live config NOT configured still shows the honest gate', () => {
    const gated = point({ p50: null, p95: null, p99: null, coldMs: null, warmMs: null, gated: true });
    const trend: MetricTrend = {
      metric: 'warehouse-query-serverless',
      backend: 'synapse-serverless',
      points: [gated],
      latest: gated,
    };
    wrap(
      <PerfMetricCard
        trend={trend}
        config={{ configured: false, gateEnv: 'LOOM_SYNAPSE_WORKSPACE', gateMessage: 'Set it.' }}
      />,
    );
    expect(screen.getByText('Backend not configured')).toBeInTheDocument();
    expect(screen.getByText(/LOOM_SYNAPSE_WORKSPACE is not set/)).toBeInTheDocument();
  });

  it('configured with real numbers renders stats (not a prompt)', () => {
    const good = point({ p50: 120 });
    const trend: MetricTrend = {
      metric: 'warehouse-query-serverless',
      backend: 'synapse-serverless',
      points: [good],
      latest: good,
    };
    wrap(<PerfMetricCard trend={trend} config={{ configured: true }} />);
    expect(screen.queryByText('Backend configured — not yet measured')).not.toBeInTheDocument();
    expect(screen.getByText('120 ms')).toBeInTheDocument();
  });

  it('flags a p95 over the Fabric bar', () => {
    const over = point({ p50: 6000, p95: 9000, p99: 12000 });
    const trend: MetricTrend = {
      metric: 'warehouse-query-serverless',
      backend: 'synapse-serverless',
      points: [over],
      latest: over,
    };
    wrap(<PerfMetricCard trend={trend} />);
    // p95 9000ms is over the 1000ms Direct Lake bar.
    expect(screen.getByText('over bar')).toBeInTheDocument();
  });
});
