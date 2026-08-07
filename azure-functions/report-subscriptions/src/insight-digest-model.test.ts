/**
 * B-N19d — Function-side port contract tests.
 *
 * These golden vectors are duplicated verbatim from
 * `apps/fiab-console/lib/insights/__tests__/digest-model.test.ts`. If the delta
 * math, prompt, or HTML changes on one side without being mirrored here (or
 * vice-versa), one of the two suites fails — which is the whole point of the
 * deliberate port (the two apps have no shared workspace package).
 */
import { describe, it, expect } from 'vitest';
import {
  DIGEST_MODEL_VERSION,
  buildDigestPrompt,
  computeMetricDeltas,
  deterministicNarration,
  escapeHtml,
  formatDeltaPct,
  formatMetricValue,
  percentChange,
  pickInterval,
  rankDeltas,
  renderDigestHtml,
  splitWindowSeries,
  type DigestObservation,
  type MetricSample,
} from './insight-digest-model';

const TYPE = 'microsoft.documentdb/databaseaccounts';
const T0 = Date.parse('2026-07-01T00:00:00Z');
const SPLIT = T0 + 4 * 3_600_000;

function pts(values: Array<[number, number | null]>) {
  return values.map(([hourOffset, value]) => ({
    timeStamp: new Date(T0 + hourOffset * 3_600_000).toISOString(),
    value,
  }));
}

describe('port contract', () => {
  it('pins the model version shared with the console', () => {
    expect(DIGEST_MODEL_VERSION).toBe(1);
  });
});

describe('splitWindowSeries', () => {
  it('averages non-Total aggregations per half', () => {
    const s = splitWindowSeries(pts([[0, 10], [1, 20], [5, 40], [6, 60]]), SPLIT, 'Average');
    expect(s.previous).toBe(15);
    expect(s.current).toBe(50);
  });

  it('sums Total/Count aggregations per half', () => {
    const s = splitWindowSeries(pts([[0, 10], [1, 20], [5, 40]]), SPLIT, 'Total');
    expect(s.previous).toBe(30);
    expect(s.current).toBe(40);
  });

  it('ignores null points and yields null for an empty half', () => {
    const s = splitWindowSeries(pts([[0, null], [5, 7]]), SPLIT, 'Average');
    expect(s.previous).toBeNull();
    expect(s.current).toBe(7);
  });
});

describe('percentChange', () => {
  it('matches the console vectors', () => {
    expect(percentChange(100, 125)).toBe(25);
    expect(percentChange(100, 50)).toBe(-50);
    expect(percentChange(0, 5)).toBeNull();
    expect(percentChange(0, 0)).toBe(0);
  });
});

describe('computeMetricDeltas', () => {
  const sample = (points: MetricSample['points'], aggregation = 'Average'): MetricSample => ({
    resourceId: '/subscriptions/s/rg/cosmos1',
    resourceName: 'cosmos1',
    resourceType: TYPE,
    metric: 'TotalRequestUnits',
    label: 'Request Units consumed',
    aggregation,
    points,
  });

  it('flags an at-or-above-threshold movement', () => {
    const [d] = computeMetricDeltas([sample(pts([[0, 100], [5, 200]]))], SPLIT, 25);
    expect(d.deltaPct).toBe(100);
    expect(d.anomaly).toBe(true);
  });

  it('leaves a sub-threshold movement un-flagged', () => {
    const [d] = computeMetricDeltas([sample(pts([[0, 100], [5, 110]]))], SPLIT, 25);
    expect(d.deltaPct).toBeCloseTo(10, 6);
    expect(d.anomaly).toBe(false);
  });

  it('flags an appearing metric and a 0 -> non-zero jump', () => {
    expect(computeMetricDeltas([sample(pts([[5, 42]]))], SPLIT, 25)[0].anomaly).toBe(true);
    expect(computeMetricDeltas([sample(pts([[0, 0], [5, 9]]), 'Total')], SPLIT, 25)[0].anomaly).toBe(true);
  });
});

describe('rankDeltas', () => {
  it('puts anomalies first, then the largest measurable magnitude', () => {
    const base = {
      resourceId: 'r', resourceName: 'r', resourceType: TYPE, metric: 'm',
      aggregation: 'Average', previous: 1, current: 2, direction: 'up' as const,
    };
    const ranked = rankDeltas([
      { ...base, label: 'small', deltaPct: 5, anomaly: false },
      { ...base, label: 'unmeasurable', deltaPct: null, anomaly: false },
      { ...base, label: 'big', deltaPct: 300, anomaly: true },
      { ...base, label: 'medium', deltaPct: 40, anomaly: false },
    ]);
    expect(ranked.map((d) => d.label)).toEqual(['big', 'medium', 'small', 'unmeasurable']);
  });
});

describe('formatting', () => {
  it('matches the console vectors', () => {
    expect(formatMetricValue(1_500_000)).toBe('1.50M');
    expect(formatMetricValue(2_500)).toBe('2.50K');
    expect(formatDeltaPct(12.34)).toBe('+12.3%');
    expect(formatDeltaPct(null)).toBe('n/a');
  });
});

const OBS: DigestObservation = {
  digestName: 'Platform health',
  windowStart: '2026-07-01T04:00:00.000Z',
  windowEnd: '2026-07-01T08:00:00.000Z',
  lookbackHours: 4,
  anomalyThresholdPct: 25,
  deltas: [
    {
      resourceId: 'r1', resourceName: 'cosmos-loom', resourceType: TYPE,
      metric: 'TotalRequestUnits', label: 'Request Units consumed', aggregation: 'Total',
      previous: 100, current: 400, deltaPct: 300, direction: 'up', anomaly: true,
    },
  ],
  alerts: [
    { id: 'a1', alertRule: 'loom-cosmos-429', severity: 'Sev2', startDateTime: '2026-07-01T05:00:00.000Z' },
  ],
};

describe('narration + body', () => {
  it('grounds the prompt in the observed rows', () => {
    const p = buildDigestPrompt(OBS);
    expect(p.system).toContain('Never invent a metric');
    expect(p.user).toContain('[ANOMALY]');
    expect(p.user).toContain('loom-cosmos-429');
  });

  it('produces the deterministic fallback narration', () => {
    const n = deterministicNarration(OBS);
    expect(n).toContain('crossed the 25% threshold');
    expect(n).toContain('1 alert instance');
  });

  it('renders + escapes the delivered HTML body', () => {
    const html = renderDigestHtml({ ...OBS, digestName: '<script>x</script>' }, 'ok');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('+300.0%');
    expect(escapeHtml(`a"b'c&d`)).toBe('a&quot;b&#39;c&amp;d');
  });
});

describe('pickInterval', () => {
  it('keeps a two-window sample under the Monitor point budget', () => {
    expect(pickInterval(1)).toBe('PT5M');
    expect(pickInterval(6)).toBe('PT15M');
    expect(pickInterval(24)).toBe('PT1H');
    expect(pickInterval(168)).toBe('PT6H');
  });
});
