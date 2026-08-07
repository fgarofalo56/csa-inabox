/**
 * B-N19d — pure digest-model tests.
 *
 * Also the CONTRACT test for the deliberate console↔Function port: the golden
 * vectors here are duplicated verbatim in
 * `azure-functions/report-subscriptions/src/insight-digest-model.test.ts`, and both
 * suites pin `DIGEST_MODEL_VERSION`. Changing the math on one side without
 * mirroring it fails the other side's suite.
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
  isSupportedCron,
  percentChange,
  rankDeltas,
  renderDigestHtml,
  splitWindowSeries,
  validateDigestInput,
  type DigestObservation,
  type MetricSample,
} from '@/lib/insights/digest-model';

const TYPES = ['microsoft.documentdb/databaseaccounts', 'microsoft.app/containerapps'];

/** t0 = 2026-07-01T00:00:00Z; the split lands at t0 + 4h. */
const T0 = Date.parse('2026-07-01T00:00:00Z');
const SPLIT = T0 + 4 * 3_600_000;

function pts(values: Array<[number, number | null]>) {
  return values.map(([hourOffset, value]) => ({
    timeStamp: new Date(T0 + hourOffset * 3_600_000).toISOString(),
    value,
  }));
}

describe('digest model — port contract', () => {
  it('pins the model version shared with the report-subscriptions Function', () => {
    expect(DIGEST_MODEL_VERSION).toBe(1);
  });
});

describe('splitWindowSeries', () => {
  it('averages non-Total aggregations per half', () => {
    const s = splitWindowSeries(pts([[0, 10], [1, 20], [5, 40], [6, 60]]), SPLIT, 'Average');
    expect(s.previous).toBe(15);
    expect(s.current).toBe(50);
    expect(s.previousPoints).toBe(2);
    expect(s.currentPoints).toBe(2);
  });

  it('sums Total/Count aggregations per half', () => {
    const s = splitWindowSeries(pts([[0, 10], [1, 20], [5, 40]]), SPLIT, 'Total');
    expect(s.previous).toBe(30);
    expect(s.current).toBe(40);
  });

  it('ignores null and non-finite points and yields null for an empty half', () => {
    const s = splitWindowSeries(pts([[0, null], [5, 7]]), SPLIT, 'Average');
    expect(s.previous).toBeNull();
    expect(s.current).toBe(7);
  });

  it('ignores unparseable timestamps', () => {
    const s = splitWindowSeries([{ timeStamp: 'not-a-date', value: 5 }], SPLIT, 'Average');
    expect(s.previous).toBeNull();
    expect(s.current).toBeNull();
  });
});

describe('percentChange', () => {
  it('computes a signed percentage against the previous window', () => {
    expect(percentChange(100, 125)).toBe(25);
    expect(percentChange(100, 50)).toBe(-50);
  });
  it('is null when it cannot be measured, and 0 for 0 -> 0', () => {
    expect(percentChange(0, 5)).toBeNull();
    expect(percentChange(0, 0)).toBe(0);
    expect(percentChange(null, 5)).toBeNull();
    expect(percentChange(5, null)).toBeNull();
  });
});

describe('computeMetricDeltas', () => {
  const sample = (name: string, points: MetricSample['points'], aggregation = 'Average'): MetricSample => ({
    resourceId: `/subscriptions/s/resourceGroups/rg/providers/${TYPES[0]}/${name}`,
    resourceName: name,
    resourceType: TYPES[0],
    metric: 'TotalRequestUnits',
    label: 'Request Units consumed',
    aggregation,
    points,
  });

  it('flags a movement at or above the threshold as an anomaly', () => {
    const [d] = computeMetricDeltas([sample('cosmos1', pts([[0, 100], [5, 200]]))], SPLIT, 25);
    expect(d.previous).toBe(100);
    expect(d.current).toBe(200);
    expect(d.deltaPct).toBe(100);
    expect(d.direction).toBe('up');
    expect(d.anomaly).toBe(true);
  });

  it('leaves a sub-threshold movement un-flagged', () => {
    const [d] = computeMetricDeltas([sample('cosmos1', pts([[0, 100], [5, 110]]))], SPLIT, 25);
    expect(d.deltaPct).toBeCloseTo(10, 6);
    expect(d.anomaly).toBe(false);
  });

  it('flags a metric that appeared (previous half empty) as an anomaly', () => {
    const [d] = computeMetricDeltas([sample('cosmos1', pts([[5, 42]]))], SPLIT, 25);
    expect(d.direction).toBe('new');
    expect(d.anomaly).toBe(true);
  });

  it('flags 0 -> non-zero even though the percentage is unmeasurable', () => {
    const [d] = computeMetricDeltas([sample('cosmos1', pts([[0, 0], [5, 9]]), 'Total')], SPLIT, 25);
    expect(d.deltaPct).toBeNull();
    expect(d.anomaly).toBe(true);
  });
});

describe('rankDeltas', () => {
  it('puts anomalies first, then the largest measurable magnitude', () => {
    const base = {
      resourceId: 'r', resourceName: 'r', resourceType: TYPES[0], metric: 'm',
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
  it('compacts large values and signs percentages', () => {
    expect(formatMetricValue(1_500_000)).toBe('1.50M');
    expect(formatMetricValue(2_500)).toBe('2.50K');
    expect(formatMetricValue(null)).toBe('n/a');
    expect(formatDeltaPct(12.34)).toBe('+12.3%');
    expect(formatDeltaPct(-3)).toBe('-3.0%');
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
      resourceId: 'r1', resourceName: 'cosmos-loom', resourceType: TYPES[0],
      metric: 'TotalRequestUnits', label: 'Request Units consumed', aggregation: 'Total',
      previous: 100, current: 400, deltaPct: 300, direction: 'up', anomaly: true,
    },
  ],
  alerts: [
    { id: 'a1', alertRule: 'loom-cosmos-429', severity: 'Sev2', startDateTime: '2026-07-01T05:00:00.000Z' },
  ],
};

describe('narration', () => {
  it('grounds the prompt in the observed rows and forbids invention', () => {
    const p = buildDigestPrompt(OBS);
    expect(p.system).toContain('Never invent a metric');
    expect(p.user).toContain('cosmos-loom');
    expect(p.user).toContain('[ANOMALY]');
    expect(p.user).toContain('loom-cosmos-429');
  });

  it('states the threshold crossings and alert count deterministically', () => {
    const n = deterministicNarration(OBS);
    expect(n).toContain('Platform health');
    expect(n).toContain('crossed the 25% threshold');
    expect(n).toContain('1 alert instance');
  });

  it('says plainly when nothing moved', () => {
    const n = deterministicNarration({ ...OBS, deltas: [], alerts: [] });
    expect(n).toContain('No metric moved by 25% or more.');
    expect(n).toContain('No Azure Monitor alerts fired');
  });
});

describe('renderDigestHtml', () => {
  it('renders the narration, the movement table, and the alert table', () => {
    const html = renderDigestHtml(OBS, 'Requests tripled.');
    expect(html).toContain('Platform health');
    expect(html).toContain('Requests tripled.');
    expect(html).toContain('Metric movement');
    expect(html).toContain('Alerts fired');
    expect(html).toContain('+300.0%');
  });

  it('escapes interpolated values (no HTML injection through a digest name)', () => {
    const html = renderDigestHtml({ ...OBS, digestName: '<script>x</script>' }, 'ok');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(escapeHtml(`a"b'c&d`)).toBe('a&quot;b&#39;c&amp;d');
  });

  it('says so honestly when Monitor returned no samples', () => {
    const html = renderDigestHtml({ ...OBS, deltas: [], alerts: [] }, 'nothing to report');
    expect(html).toContain('No metric samples were returned');
  });
});

describe('isSupportedCron', () => {
  it('accepts the 6-field NCRONTAB report subscriptions use', () => {
    expect(isSupportedCron('0 0 8 * * 1-5')).toBe(true);
    expect(isSupportedCron('0 */15 * * * *')).toBe(true);
  });
  it('rejects a 5-field crontab and out-of-range values', () => {
    expect(isSupportedCron('0 8 * * 1-5')).toBe(false);
    expect(isSupportedCron('0 0 99 * * *')).toBe(false);
  });
});

describe('validateDigestInput', () => {
  const good = {
    name: 'Platform health',
    cron: '0 0 8 * * 1-5',
    lookbackHours: 24,
    anomalyThresholdPct: 25,
    resourceTypes: [TYPES[0]],
    recipients: ['ops@contoso.com'],
    narration: 'copilot',
  };

  it('accepts and normalizes a valid digest', () => {
    const v = validateDigestInput(good, TYPES);
    expect(v.ok).toBe(true);
    expect(v.value.resourceTypes).toEqual([TYPES[0]]);
    expect(v.value.enabled).toBe(true);
    expect(v.value.includeAlerts).toBe(true);
  });

  it('rejects a resource type outside the live METRIC_CATALOG (no freeform config)', () => {
    const v = validateDigestInput({ ...good, resourceTypes: ['microsoft.evil/thing'] }, TYPES);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('unsupported type');
  });

  it('rejects a bad email, an empty recipient list, and an out-of-range window', () => {
    expect(validateDigestInput({ ...good, recipients: ['nope'] }, TYPES).ok).toBe(false);
    expect(validateDigestInput({ ...good, recipients: [] }, TYPES).ok).toBe(false);
    expect(validateDigestInput({ ...good, lookbackHours: 100_000 }, TYPES).ok).toBe(false);
  });

  it('dedupes recipients and resource types', () => {
    const v = validateDigestInput(
      { ...good, recipients: ['a@b.com', 'a@b.com'], resourceTypes: [TYPES[0], TYPES[0]] },
      TYPES,
    );
    expect(v.value.recipients).toEqual(['a@b.com']);
    expect(v.value.resourceTypes).toEqual([TYPES[0]]);
  });

  it('requires at least one resource type', () => {
    const v = validateDigestInput({ ...good, resourceTypes: [] }, TYPES);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('at least one resource type');
  });
});
