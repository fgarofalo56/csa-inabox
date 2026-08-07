/**
 * B-N19d — insight-digest PURE model (Function-side port).
 *
 * DELIBERATE PORT of the pure helpers in
 * `apps/fiab-console/lib/insights/digest-model.ts`. The console and this timer
 * Function are separately deployed artifacts with independent package.json /
 * tsconfig trees — there is no shared workspace package to import from — so the
 * ~200 lines of delta math + prompt + HTML that MUST agree between the console
 * preview and the delivered email live in both places. `DIGEST_MODEL_VERSION` is
 * asserted equal by BOTH test suites, so a change on one side that is not
 * mirrored fails CI on the other.
 *
 * Nothing here does I/O. Cron matching is NOT duplicated — the digest reuses
 * `cron-match.isDueWithin`, the exact matcher report subscriptions use.
 */

/** Must equal apps/fiab-console/lib/insights/digest-model.ts DIGEST_MODEL_VERSION. */
export const DIGEST_MODEL_VERSION = 1;

/** Max metric rows carried into the narration prompt / email body. */
export const DIGEST_MAX_ROWS = 25;

export type DigestNarrationMode = 'copilot' | 'deterministic';
export type DigestRunStatus = 'succeeded' | 'failed' | 'skipped';

/**
 * One resolved metric the digest samples. SERVER-DERIVED by the console at save
 * time from its METRIC_CATALOG, so this Function executes a plan and never
 * carries its own copy of the catalog.
 */
export interface DigestMetricPlanEntry {
  resourceType: string;
  metric: string;
  aggregation: string;
  label: string;
}

/** One persisted digest subscription (Cosmos `insight-digests`, PK /tenantId). */
export interface InsightDigestDoc {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  cron: string;
  enabled: boolean;
  lookbackHours: number;
  resourceTypes: string[];
  metricPlan?: DigestMetricPlanEntry[];
  includeAlerts: boolean;
  anomalyThresholdPct: number;
  recipients: string[];
  narration: DigestNarrationMode;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: DigestRunStatus;
  lastError?: string;
  runNowRequestedAt?: string;
}

export interface DigestSeriesPoint {
  timeStamp: string;
  value: number | null;
}

export interface SplitSeries {
  previous: number | null;
  current: number | null;
  previousPoints: number;
  currentPoints: number;
}

export type DeltaDirection = 'up' | 'down' | 'flat' | 'new' | 'gone';

export interface MetricDelta {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  metric: string;
  label: string;
  aggregation: string;
  unit?: string;
  previous: number | null;
  current: number | null;
  deltaPct: number | null;
  direction: DeltaDirection;
  anomaly: boolean;
}

export interface DigestAlert {
  id: string;
  alertRule: string;
  severity?: string;
  startDateTime: string;
  monitorCondition?: string;
  targetResourceName?: string;
}

export interface DigestObservation {
  digestName: string;
  windowStart: string;
  windowEnd: string;
  lookbackHours: number;
  anomalyThresholdPct: number;
  deltas: MetricDelta[];
  alerts: DigestAlert[];
}

export interface MetricSample {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  metric: string;
  label: string;
  aggregation: string;
  unit?: string;
  points: DigestSeriesPoint[];
}

/** Aggregate a Monitor series into (previous, current) halves split at `splitAtMs`. */
export function splitWindowSeries(
  points: DigestSeriesPoint[],
  splitAtMs: number,
  aggregation: string,
): SplitSeries {
  const sum = aggregation === 'Total' || aggregation === 'Count';
  let prevAcc = 0;
  let curAcc = 0;
  let prevN = 0;
  let curN = 0;
  for (const p of points || []) {
    if (!p || p.value == null || !Number.isFinite(p.value)) continue;
    const t = Date.parse(p.timeStamp);
    if (!Number.isFinite(t)) continue;
    if (t < splitAtMs) {
      prevAcc += p.value;
      prevN += 1;
    } else {
      curAcc += p.value;
      curN += 1;
    }
  }
  const fold = (acc: number, n: number): number | null => {
    if (!n) return null;
    return sum ? acc : acc / n;
  };
  return { previous: fold(prevAcc, prevN), current: fold(curAcc, curN), previousPoints: prevN, currentPoints: curN };
}

export function percentChange(previous: number | null, current: number | null): number | null {
  if (previous == null || current == null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function deltaDirection(previous: number | null, current: number | null): DeltaDirection {
  if (previous == null && current == null) return 'flat';
  if (previous == null) return 'new';
  if (current == null) return 'gone';
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
}

function clampNumber(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

export function computeMetricDeltas(
  samples: MetricSample[],
  splitAtMs: number,
  anomalyThresholdPct: number,
): MetricDelta[] {
  const threshold = clampNumber(anomalyThresholdPct, 5, 500);
  const out: MetricDelta[] = [];
  for (const s of samples || []) {
    const split = splitWindowSeries(s.points, splitAtMs, s.aggregation);
    const deltaPct = percentChange(split.previous, split.current);
    const direction = deltaDirection(split.previous, split.current);
    const anomaly =
      (deltaPct != null && Math.abs(deltaPct) >= threshold) ||
      direction === 'new' ||
      direction === 'gone' ||
      (split.previous === 0 && (split.current ?? 0) > 0);
    out.push({
      resourceId: s.resourceId,
      resourceName: s.resourceName,
      resourceType: s.resourceType,
      metric: s.metric,
      label: s.label,
      aggregation: s.aggregation,
      unit: s.unit,
      previous: split.previous,
      current: split.current,
      deltaPct,
      direction,
      anomaly,
    });
  }
  return out;
}

export function rankDeltas(deltas: MetricDelta[], limit = DIGEST_MAX_ROWS): MetricDelta[] {
  const mag = (d: MetricDelta): number => (d.deltaPct == null ? Number.POSITIVE_INFINITY : Math.abs(d.deltaPct));
  return [...(deltas || [])]
    .sort((a, b) => {
      if (a.anomaly !== b.anomaly) return a.anomaly ? -1 : 1;
      const ma = mag(a);
      const mb = mag(b);
      if (ma === mb) return a.label.localeCompare(b.label);
      if (!Number.isFinite(ma)) return 1;
      if (!Number.isFinite(mb)) return -1;
      return mb - ma;
    })
    .slice(0, Math.max(1, limit));
}

export function formatMetricValue(v: number | null): string {
  if (v == null) return 'n/a';
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  if (abs >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}

export function formatDeltaPct(pct: number | null): string {
  if (pct == null) return 'n/a';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export function shortType(resourceType: string): string {
  const t = (resourceType || '').trim();
  const slash = t.lastIndexOf('/');
  return slash >= 0 ? t.slice(slash + 1) : t;
}

export interface DigestPrompt {
  system: string;
  user: string;
}

export function buildDigestPrompt(obs: DigestObservation): DigestPrompt {
  const rows = rankDeltas(obs.deltas).map((d) => {
    const flag = d.anomaly ? ' [ANOMALY]' : '';
    return `- ${d.resourceName} (${shortType(d.resourceType)}) · ${d.label}: ${formatMetricValue(d.previous)} -> ${formatMetricValue(d.current)} (${formatDeltaPct(d.deltaPct)})${flag}`;
  });
  const alerts = (obs.alerts || []).slice(0, DIGEST_MAX_ROWS).map(
    (a) => `- ${a.alertRule}${a.severity ? ` (${a.severity})` : ''} on ${a.targetResourceName || 'platform'} at ${a.startDateTime}`,
  );

  const system = [
    'You are the CSA Loom platform-insights analyst.',
    'Write a short operations digest from the observations supplied by the user message.',
    'HARD RULES:',
    '1. Use ONLY the numbers and names given. Never invent a metric, resource, cause, or trend.',
    '2. If the observations are empty or inconclusive, say so plainly in one sentence.',
    '3. Do not speculate about root cause; describe what moved and what an operator should check.',
    '4. Plain prose, no markdown headings, no bullet characters, at most 3 short paragraphs.',
  ].join('\n');

  const user = [
    `Digest: ${obs.digestName}`,
    `Window: ${obs.windowStart} to ${obs.windowEnd} (${obs.lookbackHours}h, compared with the preceding ${obs.lookbackHours}h).`,
    `Anomaly threshold: ${obs.anomalyThresholdPct}% change.`,
    '',
    rows.length ? `Metric movement (previous -> current):\n${rows.join('\n')}` : 'Metric movement: none observed in this window.',
    '',
    alerts.length ? `Fired alerts in the window:\n${alerts.join('\n')}` : 'Fired alerts in the window: none.',
  ].join('\n');

  return { system, user };
}

export function deterministicNarration(obs: DigestObservation): string {
  const ranked = rankDeltas(obs.deltas);
  const anomalies = ranked.filter((d) => d.anomaly);
  const parts: string[] = [];
  parts.push(
    `${obs.digestName}: ${obs.deltas.length} metric${obs.deltas.length === 1 ? '' : 's'} sampled over the last ${obs.lookbackHours}h ` +
      `(window ending ${obs.windowEnd}), compared with the preceding ${obs.lookbackHours}h.`,
  );
  if (anomalies.length) {
    const top = anomalies.slice(0, 5).map(
      (d) => `${d.resourceName} ${d.label} ${formatMetricValue(d.previous)} to ${formatMetricValue(d.current)} (${formatDeltaPct(d.deltaPct)})`,
    );
    parts.push(`${anomalies.length} movement${anomalies.length === 1 ? '' : 's'} crossed the ${obs.anomalyThresholdPct}% threshold: ${top.join('; ')}.`);
  } else {
    parts.push(`No metric moved by ${obs.anomalyThresholdPct}% or more.`);
  }
  parts.push(
    obs.alerts.length
      ? `${obs.alerts.length} alert instance${obs.alerts.length === 1 ? '' : 's'} fired in the window (most recent: ${obs.alerts[0]?.alertRule}).`
      : 'No Azure Monitor alerts fired in the window.',
  );
  return parts.join(' ');
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] || c);
}

export function renderDigestHtml(obs: DigestObservation, narration: string): string {
  const ranked = rankDeltas(obs.deltas);
  const rows = ranked
    .map((d) => {
      const tone = d.anomaly ? '#b10e1c' : '#3b3a39';
      const arrow = d.direction === 'up' ? '▲' : d.direction === 'down' ? '▼' : '—';
      return (
        '<tr>' +
        `<td style="padding:8px;border-bottom:1px solid #edebe9;">${escapeHtml(d.resourceName)}<br><span style="color:#605e5c;font-size:12px;">${escapeHtml(shortType(d.resourceType))}</span></td>` +
        `<td style="padding:8px;border-bottom:1px solid #edebe9;">${escapeHtml(d.label)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #edebe9;text-align:right;">${escapeHtml(formatMetricValue(d.previous))}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #edebe9;text-align:right;">${escapeHtml(formatMetricValue(d.current))}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #edebe9;text-align:right;color:${tone};">${arrow} ${escapeHtml(formatDeltaPct(d.deltaPct))}</td>` +
        '</tr>'
      );
    })
    .join('');

  const alertRows = (obs.alerts || [])
    .slice(0, DIGEST_MAX_ROWS)
    .map(
      (a) =>
        '<tr>' +
        `<td style="padding:8px;border-bottom:1px solid #edebe9;">${escapeHtml(a.alertRule)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #edebe9;">${escapeHtml(a.severity || '')}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #edebe9;">${escapeHtml(a.targetResourceName || '')}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #edebe9;">${escapeHtml(a.startDateTime)}</td>` +
        '</tr>',
    )
    .join('');

  return [
    '<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#201f1e;max-width:820px;">',
    `<h2 style="margin:0 0 4px 0;font-size:20px;">${escapeHtml(obs.digestName)}</h2>`,
    `<div style="color:#605e5c;font-size:13px;margin-bottom:16px;">${escapeHtml(obs.windowStart)} &rarr; ${escapeHtml(obs.windowEnd)} &middot; ${escapeHtml(String(obs.lookbackHours))}h window &middot; anomaly threshold ${escapeHtml(String(obs.anomalyThresholdPct))}%</div>`,
    `<p style="font-size:14px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(narration)}</p>`,
    rows
      ? '<h3 style="font-size:15px;margin:20px 0 8px 0;">Metric movement</h3>' +
        '<table style="border-collapse:collapse;width:100%;font-size:13px;"><thead><tr>' +
        '<th style="text-align:left;padding:8px;border-bottom:2px solid #edebe9;">Resource</th>' +
        '<th style="text-align:left;padding:8px;border-bottom:2px solid #edebe9;">Metric</th>' +
        '<th style="text-align:right;padding:8px;border-bottom:2px solid #edebe9;">Previous</th>' +
        '<th style="text-align:right;padding:8px;border-bottom:2px solid #edebe9;">Current</th>' +
        '<th style="text-align:right;padding:8px;border-bottom:2px solid #edebe9;">Change</th>' +
        `</tr></thead><tbody>${rows}</tbody></table>`
      : '<p style="font-size:13px;color:#605e5c;">No metric samples were returned for the selected resource types in this window.</p>',
    alertRows
      ? '<h3 style="font-size:15px;margin:20px 0 8px 0;">Alerts fired</h3>' +
        '<table style="border-collapse:collapse;width:100%;font-size:13px;"><thead><tr>' +
        '<th style="text-align:left;padding:8px;border-bottom:2px solid #edebe9;">Rule</th>' +
        '<th style="text-align:left;padding:8px;border-bottom:2px solid #edebe9;">Severity</th>' +
        '<th style="text-align:left;padding:8px;border-bottom:2px solid #edebe9;">Target</th>' +
        '<th style="text-align:left;padding:8px;border-bottom:2px solid #edebe9;">Fired</th>' +
        `</tr></thead><tbody>${alertRows}</tbody></table>`
      : '',
    '<p style="color:#605e5c;font-size:12px;margin-top:24px;">Generated by CSA Loom scheduled insights. Manage this digest in Governance &rarr; Insights &amp; reports.</p>',
    '</div>',
  ].join('');
}

/**
 * Metric grain that keeps a two-window sample under Azure Monitor's per-call
 * datapoint budget. Pure, and it lives here (not in the engine) so the model's
 * spec can exercise it without dragging the Azure SDK into the test graph.
 */
export function pickInterval(lookbackHours: number): string {
  if (lookbackHours <= 2) return 'PT5M';
  if (lookbackHours <= 12) return 'PT15M';
  if (lookbackHours <= 48) return 'PT1H';
  return 'PT6H';
}
