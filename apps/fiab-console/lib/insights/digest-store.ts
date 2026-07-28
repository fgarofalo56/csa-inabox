/**
 * B-N19d — insight-digest store (Cosmos) + the console-side digest RUN.
 *
 * Store: `insight-digests` (PK /tenantId) holds the definitions; the C5
 * report-subscriptions timer Function reads the SAME container on its existing
 * tick and delivers due digests through the SAME delivery Logic App. Runs are
 * appended to `insight-digest-log` (PK /digestId) by BOTH sides, so the console
 * history shows scheduled deliveries and console previews in one list.
 *
 * Run: `runDigest` samples REAL Azure Monitor platform metrics (via
 * monitor-client's `fetchMetrics` over `listResources` + `METRIC_CATALOG`) for
 * the digest's resource types across the current window and the immediately
 * preceding window of equal length, folds them into deltas with the pure model,
 * pulls REAL fired alert instances (`listAlertHistory`), and narrates through
 * the Loom Azure OpenAI deployment. There are no mock series anywhere: when
 * Monitor is not configured the run surfaces the honest gate instead.
 *
 * Azure-native, no Fabric.
 */
import { insightDigestsContainer, insightDigestLogContainer } from '@/lib/azure/cosmos-client';
import {
  fetchMetrics,
  listResources,
  listAlertHistory,
  metricsForType,
  METRIC_CATALOG,
  type LoomResource,
} from '@/lib/azure/monitor-client';
import { aoaiChat } from '@/lib/azure/aoai-chat-client';
import {
  DIGEST_MAX_ROWS,
  buildDigestPrompt,
  computeMetricDeltas,
  deterministicNarration,
  renderDigestHtml,
  type DigestAlert,
  type DigestMetricPlanEntry,
  type DigestObservation,
  type InsightDigestDoc,
  type InsightDigestRun,
  type MetricDelta,
  type MetricSample,
} from './digest-model';

/** Resource types a digest may sample — the live METRIC_CATALOG key set. */
export function digestResourceTypes(): string[] {
  return Object.keys(METRIC_CATALOG).sort();
}

/** Max metrics requested per resource. */
const MAX_METRICS_PER_RESOURCE = 4;

/**
 * Resolve the selected resource types into the concrete metric plan the C5
 * Function executes. Derived here (the console owns METRIC_CATALOG) and stored
 * on the doc so the Function needs no copy of the catalog.
 */
export function buildMetricPlan(resourceTypes: string[]): DigestMetricPlanEntry[] {
  const plan: DigestMetricPlanEntry[] = [];
  for (const t of resourceTypes || []) {
    for (const m of metricsForType(t).slice(0, MAX_METRICS_PER_RESOURCE)) {
      plan.push({ resourceType: t.toLowerCase(), metric: m.metric, aggregation: m.aggregation, label: m.label });
    }
  }
  return plan;
}

/** Max Azure resources sampled per run (bounds the Monitor fan-out). */
const MAX_RESOURCES_PER_RUN = 12;

// ── store ───────────────────────────────────────────────────────────────────

/** Every digest for a tenant, newest first (single-partition query). */
export async function listDigests(tenantId: string): Promise<InsightDigestDoc[]> {
  const c = await insightDigestsContainer();
  const { resources } = await c.items
    .query<InsightDigestDoc>(
      {
        query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.updatedAt DESC',
        parameters: [{ name: '@t', value: tenantId }],
      },
      { partitionKey: tenantId },
    )
    .fetchAll();
  return resources;
}

/** One digest by id (point-read within the tenant partition). */
export async function getDigest(tenantId: string, id: string): Promise<InsightDigestDoc | null> {
  const c = await insightDigestsContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<InsightDigestDoc>();
    return resource && resource.tenantId === tenantId ? resource : null;
  } catch {
    return null;
  }
}

/** Create or replace a digest definition. */
export async function upsertDigest(doc: InsightDigestDoc): Promise<InsightDigestDoc> {
  const c = await insightDigestsContainer();
  const { resource } = await c.items.upsert<InsightDigestDoc>(doc);
  return (resource as InsightDigestDoc) || doc;
}

/** Delete a digest definition. Returns false when it did not exist. */
export async function deleteDigest(tenantId: string, id: string): Promise<boolean> {
  const c = await insightDigestsContainer();
  try {
    await c.item(id, tenantId).delete();
    return true;
  } catch {
    return false;
  }
}

/** Queue an out-of-band run — the C5 Function consumes + clears the stamp. */
export async function requestRunNow(tenantId: string, id: string): Promise<InsightDigestDoc | null> {
  const doc = await getDigest(tenantId, id);
  if (!doc) return null;
  doc.runNowRequestedAt = new Date().toISOString();
  doc.updatedAt = doc.runNowRequestedAt;
  return upsertDigest(doc);
}

/** Recent runs for a digest, newest first (single-partition query). */
export async function listDigestRuns(digestId: string, limit = 20): Promise<InsightDigestRun[]> {
  const c = await insightDigestLogContainer();
  const { resources } = await c.items
    .query<InsightDigestRun>(
      {
        query: 'SELECT TOP @n * FROM c WHERE c.digestId = @d ORDER BY c.ranAt DESC',
        parameters: [
          { name: '@n', value: Math.min(100, Math.max(1, limit)) },
          { name: '@d', value: digestId },
        ],
      },
      { partitionKey: digestId },
    )
    .fetchAll();
  return resources;
}

/** Append a run row (used by the preview path; the Function writes its own). */
export async function recordDigestRun(run: InsightDigestRun): Promise<void> {
  const c = await insightDigestLogContainer();
  await c.items.create(run);
}

// ── run ─────────────────────────────────────────────────────────────────────

export interface DigestRunResult {
  observation: DigestObservation;
  narration: string;
  /** True when the Copilot narration was used; false = deterministic fallback. */
  narratedByCopilot: boolean;
  /** Non-fatal reason the Copilot narration was skipped, when it was. */
  narrationNote?: string;
  html: string;
  resourcesSampled: number;
}

/**
 * Execute one digest: real Monitor metrics over (previous | current) windows,
 * real fired alerts, real Copilot narration. NEVER delivers — delivery is the
 * C5 Function's job. Throws `MonitorNotConfiguredError` so the BFF can render
 * the honest Monitor gate rather than a fake empty digest.
 */
export async function runDigest(doc: InsightDigestDoc, now = new Date()): Promise<DigestRunResult> {
  const lookbackMs = doc.lookbackHours * 3_600_000;
  const windowEnd = now;
  const splitAtMs = windowEnd.getTime() - lookbackMs;
  // Two windows back-to-back in ONE Monitor call per metric family: fetchMetrics
  // derives its start from timespan = 2 x lookback, ending now, and the pure
  // model splits the returned series at splitAtMs.
  const timespanHours = doc.lookbackHours * 2;
  const timespan = `PT${Math.max(1, Math.round(timespanHours))}H`;
  const interval = pickInterval(doc.lookbackHours);

  const wanted = new Set(doc.resourceTypes.map((t) => t.toLowerCase()));
  // Throws MonitorNotConfiguredError when Monitor is unconfigured — propagated
  // so the BFF renders the honest gate instead of an empty, fake-looking digest.
  const resources: LoomResource[] = await listResources();
  const targets = resources.filter((r) => wanted.has(r.type.toLowerCase())).slice(0, MAX_RESOURCES_PER_RUN);

  const samples: MetricSample[] = [];
  for (const r of targets) {
    // The SAME plan the C5 Function executes (re-derived when an older doc
    // predates the plan field), so preview and delivery sample identically.
    const plan = (doc.metricPlan && doc.metricPlan.length ? doc.metricPlan : buildMetricPlan(doc.resourceTypes))
      .filter((p) => p.resourceType === r.type.toLowerCase());
    // Monitor requires one call per aggregation column; group the plan rows.
    const byAgg = new Map<string, { metric: string; label: string }[]>();
    for (const m of plan) {
      const list = byAgg.get(m.aggregation) || [];
      list.push({ metric: m.metric, label: m.label });
      byAgg.set(m.aggregation, list);
    }
    for (const [aggregation, entries] of byAgg) {
      try {
        const results = await fetchMetrics({
          resourceId: r.id,
          metricNames: entries.map((e) => e.metric),
          timespan,
          interval,
          aggregation,
        });
        for (const res of results) {
          const entry = entries.find((e) => e.metric.toLowerCase() === (res.name || '').toLowerCase());
          samples.push({
            resourceId: r.id,
            resourceName: r.name,
            resourceType: r.type,
            metric: res.name || entry?.metric || '',
            label: entry?.label || res.name || '',
            aggregation,
            unit: res.unit,
            points: res.points,
          });
        }
      } catch {
        // A single metric family failing must not void the whole digest — the
        // remaining resources still produce an honest (partial) observation.
      }
    }
  }

  const deltas: MetricDelta[] = computeMetricDeltas(samples, splitAtMs, doc.anomalyThresholdPct);

  let alerts: DigestAlert[] = [];
  if (doc.includeAlerts) {
    try {
      const days = Math.max(1, Math.ceil(doc.lookbackHours / 24));
      const history = await listAlertHistory({ days });
      alerts = history
        .filter((a) => {
          const t = Date.parse(a.startDateTime);
          return Number.isFinite(t) && t >= splitAtMs && t <= windowEnd.getTime();
        })
        .slice(0, DIGEST_MAX_ROWS)
        .map((a) => ({
          id: a.id,
          alertRule: a.alertRule,
          severity: a.severity,
          startDateTime: a.startDateTime,
          monitorCondition: a.monitorCondition,
          targetResourceName: a.targetResourceName,
        }));
    } catch {
      // Alerts are additive; a Monitoring-Reader gap must not void the digest.
    }
  }

  const observation: DigestObservation = {
    digestName: doc.name,
    windowStart: new Date(splitAtMs).toISOString(),
    windowEnd: windowEnd.toISOString(),
    lookbackHours: doc.lookbackHours,
    anomalyThresholdPct: doc.anomalyThresholdPct,
    deltas,
    alerts,
  };

  let narration = deterministicNarration(observation);
  let narratedByCopilot = false;
  let narrationNote: string | undefined;
  if (doc.narration === 'copilot') {
    const prompt = buildDigestPrompt(observation);
    try {
      const text = await aoaiChat({
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0.2,
        maxCompletionTokens: 700,
        taskClass: 'general',
      });
      const trimmed = (text || '').trim();
      if (trimmed) {
        narration = trimmed;
        narratedByCopilot = true;
      } else {
        narrationNote = 'Copilot returned an empty narration; the deterministic summary was used.';
      }
    } catch (e) {
      narrationNote = `Copilot narration unavailable (${(e as Error)?.message || e}); the deterministic summary was used.`;
    }
  }

  return {
    observation,
    narration,
    narratedByCopilot,
    narrationNote,
    html: renderDigestHtml(observation, narration),
    resourcesSampled: targets.length,
  };
}

/** Grain that keeps a two-window sample under Monitor's point budget. */
function pickInterval(lookbackHours: number): string {
  if (lookbackHours <= 2) return 'PT5M';
  if (lookbackHours <= 12) return 'PT15M';
  if (lookbackHours <= 48) return 'PT1H';
  return 'PT6H';
}
