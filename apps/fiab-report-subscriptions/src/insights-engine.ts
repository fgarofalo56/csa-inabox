/**
 * B-N19d — insights-engine: the scheduled insight-digest processor that runs on
 * the EXISTING C5 report-subscriptions timer tick.
 *
 * This is an EXTENSION of the report-subscriptions Function, not a second
 * scheduler: `functions/reportSubscriptions.ts` calls `runSubscriptions` and
 * then `runInsightDigests` inside the same invocation, using the same window,
 * the same Cosmos database, the same AAD credential, the same cron matcher, and
 * the same delivery Logic App.
 *
 * On each tick, for every enabled digest whose cron became due in the window
 * (or which an operator queued via `runNowRequestedAt`):
 *   1. resolve the Loom resources of the digest's resource types via ARM
 *      (`/subscriptions/{sub}/resources?$filter=resourceType eq '…'`),
 *   2. read REAL Azure Monitor platform metrics over a window twice the
 *      lookback (so the previous and current halves come from ONE call per
 *      metric family) — `microsoft.insights/metrics`,
 *   3. read REAL fired alert instances — `Microsoft.AlertsManagement/alerts`,
 *   4. fold them into deltas with the shared pure model and narrate on the Loom
 *      Azure OpenAI deployment (deterministic fallback when AOAI is absent or
 *      fails — a digest ALWAYS delivers something true),
 *   5. deliver the HTML body through the SAME delivery Logic App, and
 *   6. append an `insight-digest-log` row and stamp lastRunAt/lastStatus.
 *
 * Auth: the Function App identity. Needs Monitoring Reader at subscription
 * scope (admin-plane/monitoring-reader-rbac.bicep, digestPrincipalId) and
 * Cognitive Services OpenAI User on the AOAI account (granted in
 * report-subscriptions-function.bicep).
 *
 * Azure-native, no Fabric: Azure Monitor + Azure OpenAI + a Consumption Logic
 * App. No Fabric/Power BI host is contacted on this path.
 */
import type { Container } from '@azure/cosmos';
import { isDueWithin } from './cron-match';
import {
  acquireToken,
  deliverEmail,
  deliveryConfigGate,
  loomDb,
  type EngineLog,
} from './subscription-engine';
import {
  buildDigestPrompt,
  computeMetricDeltas,
  deterministicNarration,
  renderDigestHtml,
  type DigestAlert,
  type DigestObservation,
  type DigestSeriesPoint,
  type InsightDigestDoc,
  type MetricSample,
} from './insight-digest-model';

const ARM_BASE = process.env.LOOM_ARM_ENDPOINT || 'https://management.azure.com';
const ARM_SCOPE = process.env.LOOM_ARM_SCOPE || 'https://management.azure.com/.default';
const RESOURCES_API = process.env.LOOM_ARM_RESOURCES_API || '2021-04-01';
const METRICS_API = process.env.LOOM_ARM_METRICS_API || '2018-01-01';
const ALERTS_API = process.env.LOOM_ARM_ALERTS_API || '2019-05-05-preview';
const AOAI_API_VERSION = process.env.LOOM_AOAI_API_VERSION || '2024-10-21';
const AOAI_SCOPE = process.env.LOOM_AOAI_SCOPE || 'https://cognitiveservices.azure.com/.default';

/** Max Azure resources sampled per digest run (bounds the Monitor fan-out). */
const MAX_RESOURCES_PER_RUN = 12;
/** Cap on digests processed per tick so one tenant cannot starve the tick. */
const MAX_DIGESTS_PER_TICK = 25;

interface ArmResource {
  id: string;
  name: string;
  type: string;
}

async function armGet(path: string): Promise<any> {
  const tok = await acquireToken(ARM_SCOPE);
  const url = path.startsWith('http') ? path : `${ARM_BASE}${path}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${tok}`, accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`ARM GET ${url.split('?')[0]} failed (${res.status}): ${t.slice(0, 300) || res.statusText}`);
  }
  return res.json();
}

/** The subscription(s) the digest samples — admin sub plus the DLZ sub when set. */
function subscriptionIds(): string[] {
  const ids = [process.env.LOOM_SUBSCRIPTION_ID, process.env.LOOM_DLZ_SUBSCRIPTION_ID]
    .map((v) => (v || '').trim())
    .filter(Boolean);
  return Array.from(new Set(ids));
}

/** Loom resources of the requested ARM types across the deployment's subscriptions. */
export async function listDigestResources(resourceTypes: string[]): Promise<ArmResource[]> {
  const wanted = new Set(resourceTypes.map((t) => t.toLowerCase()));
  const out: ArmResource[] = [];
  for (const sub of subscriptionIds()) {
    for (const type of wanted) {
      const filter = encodeURIComponent(`resourceType eq '${type}'`);
      const j = await armGet(`/subscriptions/${sub}/resources?api-version=${RESOURCES_API}&$filter=${filter}`);
      for (const r of j?.value || []) {
        if (r?.id && r?.name) out.push({ id: r.id, name: r.name, type: r.type || type });
      }
    }
  }
  return out;
}

/** Read one metric family for one resource over `timespan` at `interval`. */
async function fetchMetricSeries(
  resourceId: string,
  metricNames: string[],
  aggregation: string,
  startIso: string,
  endIso: string,
  interval: string,
): Promise<Array<{ name: string; unit: string; points: DigestSeriesPoint[] }>> {
  const qs = new URLSearchParams({
    'api-version': METRICS_API,
    metricnames: metricNames.join(','),
    aggregation,
    timespan: `${startIso}/${endIso}`,
    interval,
  });
  const j = await armGet(`${resourceId}/providers/microsoft.insights/metrics?${qs.toString()}`);
  const aggKey = aggregation.toLowerCase();
  const out: Array<{ name: string; unit: string; points: DigestSeriesPoint[] }> = [];
  for (const m of j?.value || []) {
    const merged = new Map<string, number | null>();
    const order: string[] = [];
    for (const ts of m?.timeseries || []) {
      for (const d of ts?.data || []) {
        const t = d.timeStamp as string;
        const v = typeof d[aggKey] === 'number' ? (d[aggKey] as number) : null;
        if (!merged.has(t)) {
          merged.set(t, v);
          order.push(t);
        } else if (v != null) {
          const prev = merged.get(t);
          merged.set(t, (prev == null ? 0 : prev) + v);
        }
      }
    }
    out.push({
      name: m?.name?.value || m?.name || '',
      unit: m?.unit || '',
      points: order.map((t) => ({ timeStamp: t, value: merged.get(t) ?? null })),
    });
  }
  return out;
}

/** Fired alert instances in the window (best-effort: an RBAC gap is not fatal). */
async function fetchAlerts(startMs: number, endMs: number, cap: number): Promise<DigestAlert[]> {
  const subs = subscriptionIds();
  if (!subs.length) return [];
  const days = Math.min(30, Math.max(1, Math.ceil((endMs - startMs) / 86_400_000)));
  const out: DigestAlert[] = [];
  for (const sub of subs) {
    const qs = new URLSearchParams({
      'api-version': ALERTS_API,
      timeRange: `${days}d`,
      sortBy: 'startDateTime',
      sortOrder: 'desc',
    });
    const j = await armGet(`/subscriptions/${sub}/providers/Microsoft.AlertsManagement/alerts?${qs.toString()}`);
    for (const a of j?.value || []) {
      const ess = a?.properties?.essentials || {};
      const started = Date.parse(ess.startDateTime || '');
      if (!Number.isFinite(started) || started < startMs || started > endMs) continue;
      out.push({
        id: a.name || a.id,
        alertRule: ess.alertRule || '',
        severity: ess.severity,
        startDateTime: ess.startDateTime,
        monitorCondition: ess.monitorCondition,
        targetResourceName: ess.targetResourceName,
      });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** Grain that keeps a two-window sample under Monitor's point budget. */
export function pickInterval(lookbackHours: number): string {
  if (lookbackHours <= 2) return 'PT5M';
  if (lookbackHours <= 12) return 'PT15M';
  if (lookbackHours <= 48) return 'PT1H';
  return 'PT6H';
}

/** Narrate the observation on the Loom AOAI deployment; falls back deterministically. */
async function narrate(obs: DigestObservation, mode: string, log: EngineLog): Promise<string> {
  const fallback = deterministicNarration(obs);
  if (mode !== 'copilot') return fallback;
  const endpoint = (process.env.LOOM_AOAI_ENDPOINT || '').replace(/\/+$/, '');
  const deployment = process.env.LOOM_AOAI_DEPLOYMENT || '';
  if (!endpoint || !deployment) return fallback;
  try {
    const prompt = buildDigestPrompt(obs);
    const tok = await acquireToken(AOAI_SCOPE);
    const res = await fetch(
      `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${AOAI_API_VERSION}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          temperature: 0.2,
          max_completion_tokens: 700,
        }),
      },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      log.warn?.(`digest narration fell back to deterministic (AOAI ${res.status}): ${t.slice(0, 200)}`);
      return fallback;
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (j?.choices?.[0]?.message?.content || '').trim();
    return text || fallback;
  } catch (e: any) {
    log.warn?.(`digest narration fell back to deterministic: ${e?.message || e}`);
    return fallback;
  }
}

/** Build the observation for one digest from REAL Monitor data. */
export async function observeDigest(doc: InsightDigestDoc, now: Date): Promise<{ obs: DigestObservation; resourcesSampled: number }> {
  const lookbackMs = doc.lookbackHours * 3_600_000;
  const endMs = now.getTime();
  const splitAtMs = endMs - lookbackMs;
  const startMs = splitAtMs - lookbackMs;
  const interval = pickInterval(doc.lookbackHours);

  const plan = doc.metricPlan || [];
  const types = Array.from(new Set(plan.map((p) => p.resourceType)));
  const resources = types.length ? (await listDigestResources(types)).slice(0, MAX_RESOURCES_PER_RUN) : [];

  const samples: MetricSample[] = [];
  for (const r of resources) {
    const forType = plan.filter((p) => p.resourceType === r.type.toLowerCase());
    const byAgg = new Map<string, typeof forType>();
    for (const p of forType) {
      const list = byAgg.get(p.aggregation) || [];
      list.push(p);
      byAgg.set(p.aggregation, list);
    }
    for (const [aggregation, entries] of byAgg) {
      try {
        const series = await fetchMetricSeries(
          r.id,
          entries.map((e) => e.metric),
          aggregation,
          new Date(startMs).toISOString(),
          new Date(endMs).toISOString(),
          interval,
        );
        for (const s of series) {
          const entry = entries.find((e) => e.metric.toLowerCase() === (s.name || '').toLowerCase());
          samples.push({
            resourceId: r.id,
            resourceName: r.name,
            resourceType: r.type,
            metric: s.name || entry?.metric || '',
            label: entry?.label || s.name || '',
            aggregation,
            unit: s.unit,
            points: s.points,
          });
        }
      } catch {
        // One metric family failing must not void the whole digest.
      }
    }
  }

  let alerts: DigestAlert[] = [];
  if (doc.includeAlerts) {
    try {
      alerts = await fetchAlerts(splitAtMs, endMs, 25);
    } catch {
      // Alerts are additive — a Monitoring-Reader gap must not void the digest.
    }
  }

  return {
    obs: {
      digestName: doc.name,
      windowStart: new Date(splitAtMs).toISOString(),
      windowEnd: new Date(endMs).toISOString(),
      lookbackHours: doc.lookbackHours,
      anomalyThresholdPct: doc.anomalyThresholdPct,
      deltas: computeMetricDeltas(samples, splitAtMs, doc.anomalyThresholdPct),
      alerts,
    },
    resourcesSampled: resources.length,
  };
}

export interface DigestTickSummary {
  scanned: number;
  due: number;
  delivered: number;
  failed: number;
  gated: number;
}

/**
 * Process every enabled insight digest due in (windowStartMs, windowEndMs] —
 * plus any an operator queued with "Send" — on the SAME tick that delivers
 * report subscriptions.
 */
export async function runInsightDigests(
  log: EngineLog,
  windowStartMs: number,
  windowEndMs: number,
): Promise<DigestTickSummary> {
  const db = loomDb();
  const digestsC: Container = db.container('insight-digests');
  const logC: Container = db.container('insight-digest-log');

  const { resources: digests } = await digestsC.items
    .query<InsightDigestDoc>('SELECT * FROM c WHERE c.enabled = true')
    .fetchAll();

  const summary: DigestTickSummary = { scanned: digests.length, due: 0, delivered: 0, failed: 0, gated: 0 };
  const gate = deliveryConfigGate();

  let processed = 0;
  for (const doc of digests) {
    if (processed >= MAX_DIGESTS_PER_TICK) break;
    const queued = Boolean(doc.runNowRequestedAt);
    if (!queued && !isDueWithin(doc.cron, windowStartMs, windowEndMs)) continue;
    summary.due += 1;
    processed += 1;

    const ranAt = new Date().toISOString();
    const now = new Date(windowEndMs);

    if (gate) {
      // Honest, recorded skip — the definition stays, nothing is invented.
      summary.gated += 1;
      try {
        await logC.items.create({
          id: `digestrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          digestId: doc.id,
          tenantId: doc.tenantId,
          ranAt,
          status: 'skipped',
          windowStart: new Date(windowEndMs - doc.lookbackHours * 3_600_000).toISOString(),
          windowEnd: now.toISOString(),
          deltaCount: 0,
          anomalyCount: 0,
          alertCount: 0,
          error: gate,
        });
        doc.lastRunAt = ranAt;
        doc.lastStatus = 'skipped';
        doc.lastError = gate;
        delete doc.runNowRequestedAt;
        await digestsC.item(doc.id, doc.tenantId).replace(doc);
      } catch (inner: any) {
        log.error(`insight digest ${doc.id}: failed to record the delivery gate — ${inner?.message || inner}`);
      }
      log.warn?.(`insight digest ${doc.id}: skipped — ${gate}`);
      continue;
    }

    try {
      const { obs, resourcesSampled } = await observeDigest(doc, now);
      const narration = await narrate(obs, doc.narration, log);
      const html = renderDigestHtml(obs, narration);

      await deliverEmail({
        recipients: doc.recipients,
        subject: `${doc.name} — Loom insights (${doc.lookbackHours}h)`,
        reportName: doc.name,
        bodyHtml: html,
      });

      await logC.items.create({
        id: `digestrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        digestId: doc.id,
        tenantId: doc.tenantId,
        ranAt,
        status: 'succeeded',
        windowStart: obs.windowStart,
        windowEnd: obs.windowEnd,
        narration,
        deltaCount: obs.deltas.length,
        anomalyCount: obs.deltas.filter((d) => d.anomaly).length,
        alertCount: obs.alerts.length,
        recipients: doc.recipients,
      });

      doc.lastRunAt = ranAt;
      doc.lastStatus = 'succeeded';
      doc.lastError = undefined;
      delete doc.runNowRequestedAt;
      await digestsC.item(doc.id, doc.tenantId).replace(doc);

      summary.delivered += 1;
      log.log(
        `insight digest ${doc.id}: delivered to ${doc.recipients.length} recipient(s) — ` +
          `${obs.deltas.length} metric(s) over ${resourcesSampled} resource(s), ${obs.alerts.length} alert(s)`,
      );
    } catch (e: any) {
      const error = e?.message || String(e);
      summary.failed += 1;
      try {
        await logC.items.create({
          id: `digestrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          digestId: doc.id,
          tenantId: doc.tenantId,
          ranAt,
          status: 'failed',
          windowStart: new Date(windowEndMs - doc.lookbackHours * 3_600_000).toISOString(),
          windowEnd: now.toISOString(),
          deltaCount: 0,
          anomalyCount: 0,
          alertCount: 0,
          error,
        });
        doc.lastRunAt = ranAt;
        doc.lastStatus = 'failed';
        doc.lastError = error;
        delete doc.runNowRequestedAt;
        await digestsC.item(doc.id, doc.tenantId).replace(doc);
      } catch (inner: any) {
        log.error(`insight digest ${doc.id}: failed to record the run error — ${inner?.message || inner}`);
      }
      log.error(`insight digest ${doc.id}: delivery failed — ${error}`);
    }
  }

  log.log(
    `insight-digests: scanned ${summary.scanned}, due ${summary.due}, delivered ${summary.delivered}, ` +
      `failed ${summary.failed}, gated ${summary.gated}`,
  );
  return summary;
}
