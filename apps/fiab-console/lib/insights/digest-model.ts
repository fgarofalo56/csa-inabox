/**
 * B-N19d — scheduled insights / anomaly-narration digest: the PURE model.
 *
 * A digest turns Azure Monitor metric movement + fired-alert history over a
 * lookback window into a Copilot-narrated summary that is DELIVERED through the
 * EXISTING C5 report-subscriptions timer Function (apps/fiab-report-subscriptions)
 * — the same tick, the same delivery Logic App, the same Cosmos plumbing. There
 * is no second scheduler.
 *
 * This module is pure data + pure functions (no Azure SDK, no fetch) so both the
 * BFF preview path and the unit tests exercise the identical math:
 *   • `splitWindowSeries`  — halve a Monitor time-series into previous/current.
 *   • `computeMetricDeltas` — per-metric delta %, direction, anomaly verdict.
 *   • `rankDeltas`          — the "what actually moved" ordering.
 *   • `buildDigestPrompt`   — the Copilot narration prompt (grounded, no invention).
 *   • `deterministicNarration` — the honest fallback when Copilot is unavailable.
 *   • `renderDigestHtml`    — the delivered email body.
 *   • `validateDigestInput` — the no-freeform-config validator for the BFF.
 *
 * DELIBERATE PORT: `apps/fiab-report-subscriptions/src/insight-digest-model.ts`
 * is a narrow copy of the pure helpers below (the Function is a separately
 * deployed artifact with its own package.json — there is no shared workspace
 * package to import from). Both files export `DIGEST_MODEL_VERSION` and both
 * test suites assert the same value + the same golden vectors, so a change to
 * one that is not mirrored fails CI on the other side.
 *
 * Azure-native, no Fabric: every signal comes from Azure Monitor (metrics +
 * AlertsManagement) and the Loom Cosmos catalog. Narration runs on the Loom
 * Azure OpenAI deployment (in-boundary). No SaaS analytics service is contacted.
 */
import { validateNcrontab } from '@/lib/util/ncrontab';

/** Bump when the delta math / prompt / HTML contract changes — asserted in BOTH apps' tests. */
export const DIGEST_MODEL_VERSION = 1;

/** Lookback bounds (hours) — a digest window is between 1h and 14d. */
export const DIGEST_MIN_LOOKBACK_HOURS = 1;
export const DIGEST_MAX_LOOKBACK_HOURS = 336;
/** Anomaly threshold bounds (percent change that counts as "notable"). */
export const DIGEST_MIN_ANOMALY_PCT = 5;
export const DIGEST_MAX_ANOMALY_PCT = 500;
/** Max metric rows carried into the narration prompt / email body. */
export const DIGEST_MAX_ROWS = 25;
/** Max recipients on one digest (matches the delivery Logic App's practical cap). */
export const DIGEST_MAX_RECIPIENTS = 50;

export type DigestNarrationMode = 'copilot' | 'deterministic';
export type DigestRunStatus = 'succeeded' | 'failed' | 'skipped';

/**
 * One resolved metric the digest samples. SERVER-DERIVED at save time from the
 * console's `METRIC_CATALOG` so the C5 Function never needs its own copy of the
 * catalog — it just executes the plan. Re-derived on every PATCH, so a catalog
 * change reaches existing digests the next time they are edited (and the
 * console's own run always re-derives).
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
  /** 6-field NCRONTAB, evaluated by the SAME matcher the C5 Function uses. */
  cron: string;
  enabled: boolean;
  /** Window compared against the immediately preceding window of equal length. */
  lookbackHours: number;
  /** Azure resource types (METRIC_CATALOG keys) whose Loom resources are sampled. */
  resourceTypes: string[];
  /** Server-derived metric plan (see {@link DigestMetricPlanEntry}). */
  metricPlan?: DigestMetricPlanEntry[];
  /** Include fired Azure Monitor alert instances in the window. */
  includeAlerts: boolean;
  /** Percent change at/above which a metric move is called out as an anomaly. */
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
  /** Set by "Run on next tick" — consumed + cleared by the C5 Function. */
  runNowRequestedAt?: string;
}

/** One append-only digest run row (Cosmos `insight-digest-log`, PK /digestId). */
export interface InsightDigestRun {
  id: string;
  digestId: string;
  tenantId: string;
  ranAt: string;
  status: DigestRunStatus;
  windowStart: string;
  windowEnd: string;
  narration?: string;
  deltaCount: number;
  anomalyCount: number;
  alertCount: number;
  recipients?: string[];
  /** True when the run was a console preview (computed, never delivered). */
  preview?: boolean;
  error?: string;
}

/** A Monitor time-series point (structurally matches monitor-client's MetricSeriesPoint). */
export interface DigestSeriesPoint {
  timeStamp: string;
  value: number | null;
}

/** The previous/current halves of one metric series. */
export interface SplitSeries {
  previous: number | null;
  current: number | null;
  previousPoints: number;
  currentPoints: number;
}

export type DeltaDirection = 'up' | 'down' | 'flat' | 'new' | 'gone';

/** One metric's movement between the previous and current window. */
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
  /** Percent change vs the previous window; null when previous is 0/absent. */
  deltaPct: number | null;
  direction: DeltaDirection;
  /** |deltaPct| >= the digest's anomaly threshold (or a 0 → non-0 appearance). */
  anomaly: boolean;
}

/** A fired alert instance folded into the digest. */
export interface DigestAlert {
  id: string;
  alertRule: string;
  severity?: string;
  startDateTime: string;
  monitorCondition?: string;
  targetResourceName?: string;
}

/** Everything one digest run observed — the narration + email input. */
export interface DigestObservation {
  digestName: string;
  windowStart: string;
  windowEnd: string;
  lookbackHours: number;
  anomalyThresholdPct: number;
  deltas: MetricDelta[];
  alerts: DigestAlert[];
}

// ── series math ─────────────────────────────────────────────────────────────

/**
 * Aggregate a Monitor series into (previous, current) halves split at
 * `splitAtMs`. `Total`/`Count` aggregations SUM their half; every other
 * aggregation averages it (matching how the Azure portal reads the column).
 * Null points are ignored; a half with no points aggregates to null.
 */
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
  return {
    previous: fold(prevAcc, prevN),
    current: fold(curAcc, curN),
    previousPoints: prevN,
    currentPoints: curN,
  };
}

/** Percent change from `previous` to `current`; null when it is undefined. */
export function percentChange(previous: number | null, current: number | null): number | null {
  if (previous == null || current == null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** Classify a movement into a direction the narration can speak plainly. */
export function deltaDirection(previous: number | null, current: number | null): DeltaDirection {
  if (previous == null && current == null) return 'flat';
  if (previous == null) return 'new';
  if (current == null) return 'gone';
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
}

/** One metric sample to fold into a delta (the shape the callers assemble). */
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

/**
 * Fold raw samples into deltas. `splitAtMs` is the boundary between the
 * previous and current halves (windowEnd - lookback). A metric is an ANOMALY
 * when |deltaPct| >= the threshold, or when it appeared/disappeared entirely.
 */
export function computeMetricDeltas(
  samples: MetricSample[],
  splitAtMs: number,
  anomalyThresholdPct: number,
): MetricDelta[] {
  const threshold = clampNumber(anomalyThresholdPct, DIGEST_MIN_ANOMALY_PCT, DIGEST_MAX_ANOMALY_PCT);
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

/** Anomalies first, then by |deltaPct| descending; capped at `limit`. */
export function rankDeltas(deltas: MetricDelta[], limit = DIGEST_MAX_ROWS): MetricDelta[] {
  const mag = (d: MetricDelta): number => (d.deltaPct == null ? Number.POSITIVE_INFINITY : Math.abs(d.deltaPct));
  return [...(deltas || [])]
    .sort((a, b) => {
      if (a.anomaly !== b.anomaly) return a.anomaly ? -1 : 1;
      const ma = mag(a);
      const mb = mag(b);
      if (ma === mb) return a.label.localeCompare(b.label);
      // Infinity (undefined delta) sorts BELOW real magnitudes so a measurable
      // 300% jump always outranks an unmeasurable one.
      if (!Number.isFinite(ma)) return 1;
      if (!Number.isFinite(mb)) return -1;
      return mb - ma;
    })
    .slice(0, Math.max(1, limit));
}

function clampNumber(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** Compact numeric formatting for both the prompt and the email body. */
export function formatMetricValue(v: number | null): string {
  if (v == null) return 'n/a';
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  if (abs >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}

/** "+12.4%" / "-3.0%" / "n/a" for a delta percentage. */
export function formatDeltaPct(pct: number | null): string {
  if (pct == null) return 'n/a';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// ── narration ───────────────────────────────────────────────────────────────

export interface DigestPrompt {
  system: string;
  user: string;
}

/**
 * Build the grounded narration prompt. The model is given ONLY the observed
 * rows and is explicitly forbidden from inventing numbers, causes, or
 * resources — the same refuse-don't-guess contract the rest of Loom's Copilot
 * surfaces use (N9).
 */
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

/** `microsoft.documentdb/databaseaccounts` → `databaseaccounts`. */
export function shortType(resourceType: string): string {
  const t = (resourceType || '').trim();
  const slash = t.lastIndexOf('/');
  return slash >= 0 ? t.slice(slash + 1) : t;
}

/**
 * The honest fallback narration: a deterministic, fully-grounded summary used
 * when the digest is configured for `deterministic` narration OR when the
 * Copilot call fails. It never blocks delivery and never invents anything.
 */
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

// ── delivered body ──────────────────────────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape a value for interpolation into the digest email body. */
export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] || c);
}

/**
 * Render the delivered digest body. Inline styles only (email clients strip
 * <style>), no external assets, no tracking pixels — an IL5-safe plain artifact.
 */
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

// ── validation (no-freeform-config) ─────────────────────────────────────────

/** The client-writable slice of a digest. Everything else is server-stamped. */
export interface DigestInput {
  name?: unknown;
  description?: unknown;
  cron?: unknown;
  enabled?: unknown;
  lookbackHours?: unknown;
  resourceTypes?: unknown;
  includeAlerts?: unknown;
  anomalyThresholdPct?: unknown;
  recipients?: unknown;
  narration?: unknown;
}

export interface DigestValidation {
  ok: boolean;
  errors: string[];
  value: {
    name: string;
    description: string;
    cron: string;
    enabled: boolean;
    lookbackHours: number;
    resourceTypes: string[];
    includeAlerts: boolean;
    anomalyThresholdPct: number;
    recipients: string[];
    narration: DigestNarrationMode;
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * True when `cron` is a schedule the C5 Function's matcher can evaluate — the
 * SAME 6-field NCRONTAB validator report subscriptions use
 * (`lib/util/ncrontab.validateNcrontab`, mirrored by the Function's
 * `cron-match.parseCron`), so a digest and a report subscription can never
 * disagree about what a schedule means.
 */
export function isSupportedCron(cron: string): boolean {
  return validateNcrontab(String(cron || '')) === null;
}

/**
 * Validate + normalize a digest write. Rejects anything not on the allowed
 * value set — the BFF never persists a free-form blob (loom_no_freeform_config).
 * `allowedResourceTypes` is the live METRIC_CATALOG key set supplied by the caller.
 */
export function validateDigestInput(input: DigestInput, allowedResourceTypes: string[]): DigestValidation {
  const errors: string[] = [];
  const allowed = new Set((allowedResourceTypes || []).map((t) => t.toLowerCase()));

  const name = String(input.name ?? '').trim();
  if (!name) errors.push('name is required');
  if (name.length > 120) errors.push('name must be 120 characters or fewer');

  const description = String(input.description ?? '').trim().slice(0, 500);

  const cron = String(input.cron ?? '').trim();
  if (!cron) errors.push('cron is required');
  else {
    const cronErr = validateNcrontab(cron);
    if (cronErr) errors.push(cronErr);
  }

  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
  const includeAlerts = input.includeAlerts === undefined ? true : Boolean(input.includeAlerts);

  const lookbackRaw = Number(input.lookbackHours ?? 24);
  if (!Number.isFinite(lookbackRaw) || lookbackRaw < DIGEST_MIN_LOOKBACK_HOURS || lookbackRaw > DIGEST_MAX_LOOKBACK_HOURS) {
    errors.push(`lookbackHours must be between ${DIGEST_MIN_LOOKBACK_HOURS} and ${DIGEST_MAX_LOOKBACK_HOURS}`);
  }
  const lookbackHours = clampNumber(Math.round(lookbackRaw), DIGEST_MIN_LOOKBACK_HOURS, DIGEST_MAX_LOOKBACK_HOURS);

  const thresholdRaw = Number(input.anomalyThresholdPct ?? 25);
  if (!Number.isFinite(thresholdRaw) || thresholdRaw < DIGEST_MIN_ANOMALY_PCT || thresholdRaw > DIGEST_MAX_ANOMALY_PCT) {
    errors.push(`anomalyThresholdPct must be between ${DIGEST_MIN_ANOMALY_PCT} and ${DIGEST_MAX_ANOMALY_PCT}`);
  }
  const anomalyThresholdPct = clampNumber(Math.round(thresholdRaw), DIGEST_MIN_ANOMALY_PCT, DIGEST_MAX_ANOMALY_PCT);

  const typesRaw = Array.isArray(input.resourceTypes) ? input.resourceTypes : [];
  const resourceTypes: string[] = [];
  for (const t of typesRaw) {
    const key = String(t ?? '').trim().toLowerCase();
    if (!key) continue;
    if (!allowed.has(key)) {
      errors.push(`resourceTypes contains an unsupported type: ${key}`);
      continue;
    }
    if (!resourceTypes.includes(key)) resourceTypes.push(key);
  }
  if (!resourceTypes.length) errors.push('select at least one resource type to sample');

  const recipientsRaw = Array.isArray(input.recipients) ? input.recipients : [];
  const recipients: string[] = [];
  for (const r of recipientsRaw) {
    const addr = String(r ?? '').trim();
    if (!addr) continue;
    if (!EMAIL_RE.test(addr)) {
      errors.push(`recipient is not a valid email address: ${addr}`);
      continue;
    }
    if (!recipients.includes(addr)) recipients.push(addr);
  }
  if (!recipients.length) errors.push('at least one recipient is required');
  if (recipients.length > DIGEST_MAX_RECIPIENTS) errors.push(`at most ${DIGEST_MAX_RECIPIENTS} recipients`);

  const narrationRaw = String(input.narration ?? 'copilot');
  const narration: DigestNarrationMode = narrationRaw === 'deterministic' ? 'deterministic' : 'copilot';
  if (narrationRaw !== 'copilot' && narrationRaw !== 'deterministic') {
    errors.push('narration must be copilot or deterministic');
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      name,
      description,
      cron,
      enabled,
      lookbackHours,
      resourceTypes,
      includeAlerts,
      anomalyThresholdPct,
      recipients,
      narration,
    },
  };
}
