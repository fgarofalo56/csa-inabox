/**
 * Shared Azure Monitor Metrics BFF for the three messaging namespace editors
 * (Event Hubs / Service Bus / Event Grid). Reads the deployment-pinned
 * resource's ARM id from each service's client and queries the REAL Azure
 * Monitor metrics REST surface (Microsoft.Insights/metrics) via
 * monitor-client.fetchMetrics — no mocks, no sample data.
 *
 *   GET /api/messaging/metrics?kind=event-hubs|service-bus|event-grid
 *         &topic=NAME        (event-grid only — metrics are per-topic)
 *         &range=1h|6h|24h   (defaults 1h)
 *     → { ok, kind, resourceId, range, timespan, interval,
 *         metrics: [{ name, label, unit, aggregation, points:[{timeStamp,value}] }] }
 *
 * The metric catalog per kind is grounded in the Azure Monitor supported-metrics
 * reference (each metric paired with its canonical aggregation). Because the
 * metrics REST surface takes ONE aggregation per request, metrics are grouped by
 * aggregation and one fetchMetrics call is issued per group, then merged back in
 * catalog order (mirrors the stream-analytics-job metrics route).
 *
 * Honest gates (no-vaporware):
 *   - 401 when unauthenticated.
 *   - 503 { code:'not_configured' } when the service's env (namespace/sub/rg,
 *     or topic) is unset — the exact missing var is named.
 *   - 403 { code:'forbidden', role:'Monitoring Reader' } when the Console UAMI
 *     lacks Monitoring Reader on the resource (metrics read denied).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchMetrics, MonitorError, type MetricResult } from '@/lib/azure/monitor-client';
import { eventhubsConfigGate, eventHubsNamespaceResourceId } from '@/lib/azure/eventhubs-client';
import { servicebusConfigGate, serviceBusNamespaceResourceId } from '@/lib/azure/servicebus-client';
import { eventgridTopicsConfigGate, eventGridTopicResourceId } from '@/lib/azure/eventgrid-topics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Kind = 'event-hubs' | 'service-bus' | 'event-grid';

interface MetricDef { metric: string; aggregation: string; label: string }

/**
 * Curated headline metrics per messaging resource type, grounded in the Azure
 * Monitor supported-metrics reference. Each metric is paired with the
 * aggregation the portal Metrics blade uses for it (counters → Total, gauges →
 * Average). Dead-letter is included where the resource type has it (Service Bus
 * DeadletteredMessages, Event Grid DeadLetteredCount); Event Hubs has none.
 */
const CATALOG: Record<Kind, MetricDef[]> = {
  // Microsoft.EventHub/namespaces
  'event-hubs': [
    { metric: 'IncomingMessages', aggregation: 'Total', label: 'Incoming Messages' },
    { metric: 'OutgoingMessages', aggregation: 'Total', label: 'Outgoing Messages' },
    { metric: 'IncomingBytes', aggregation: 'Total', label: 'Incoming Bytes' },
    { metric: 'OutgoingBytes', aggregation: 'Total', label: 'Outgoing Bytes' },
    { metric: 'IncomingRequests', aggregation: 'Total', label: 'Incoming Requests' },
    { metric: 'ThrottledRequests', aggregation: 'Total', label: 'Throttled Requests' },
    { metric: 'ServerErrors', aggregation: 'Total', label: 'Server Errors' },
    { metric: 'UserErrors', aggregation: 'Total', label: 'User Errors' },
    { metric: 'ActiveConnections', aggregation: 'Average', label: 'Active Connections' },
  ],
  // Microsoft.ServiceBus/namespaces
  'service-bus': [
    { metric: 'IncomingMessages', aggregation: 'Total', label: 'Incoming Messages' },
    { metric: 'OutgoingMessages', aggregation: 'Total', label: 'Outgoing Messages' },
    { metric: 'IncomingRequests', aggregation: 'Total', label: 'Incoming Requests' },
    { metric: 'ThrottledRequests', aggregation: 'Total', label: 'Throttled Requests' },
    { metric: 'ServerErrors', aggregation: 'Total', label: 'Server Errors' },
    { metric: 'UserErrors', aggregation: 'Total', label: 'User Errors' },
    { metric: 'ActiveConnections', aggregation: 'Total', label: 'Active Connections' },
    { metric: 'ActiveMessages', aggregation: 'Average', label: 'Active Messages' },
    { metric: 'DeadletteredMessages', aggregation: 'Average', label: 'Dead-lettered Messages' },
  ],
  // Microsoft.EventGrid/topics (per-topic)
  'event-grid': [
    { metric: 'PublishSuccessCount', aggregation: 'Total', label: 'Published Events' },
    { metric: 'PublishFailCount', aggregation: 'Total', label: 'Publish Failures' },
    { metric: 'UnmatchedEventCount', aggregation: 'Total', label: 'Unmatched Events' },
    { metric: 'MatchedEventCount', aggregation: 'Total', label: 'Matched Events' },
    { metric: 'DeliverySuccessCount', aggregation: 'Total', label: 'Delivered Events' },
    { metric: 'DeadLetteredCount', aggregation: 'Total', label: 'Dead-lettered Events' },
    { metric: 'DroppedEventCount', aggregation: 'Total', label: 'Dropped Events' },
    { metric: 'PublishSuccessLatencyInMs', aggregation: 'Average', label: 'Publish Latency (ms)' },
  ],
};

/** Range → (timespan ISO duration, sampling interval). */
const RANGES: Record<string, { timespan: string; interval: string }> = {
  '1h': { timespan: 'PT1H', interval: 'PT1M' },
  '6h': { timespan: 'PT6H', interval: 'PT5M' },
  '24h': { timespan: 'P1D', interval: 'PT15M' },
};

function unauth() {
  return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
}

function notConfigured(missing: string, kindLabel: string) {
  return NextResponse.json(
    {
      ok: false,
      code: 'not_configured',
      error: `${kindLabel} not configured: set ${missing}.`,
      missing,
    },
    { status: 503 },
  );
}

/**
 * Resolve the ARM resource id + config gate for the requested kind. Returns
 * either a resourceId or an early NextResponse (503 gate / 400 bad request).
 */
function resolveResource(kind: Kind, topic: string): { resourceId: string } | NextResponse {
  if (kind === 'event-hubs') {
    const g = eventhubsConfigGate();
    if (g) return notConfigured(g.missing, 'Event Hubs namespace');
    return { resourceId: eventHubsNamespaceResourceId() };
  }
  if (kind === 'service-bus') {
    const g = servicebusConfigGate();
    if (g) return notConfigured(g.missing, 'Service Bus namespace');
    return { resourceId: serviceBusNamespaceResourceId() };
  }
  // event-grid — per-topic
  const g = eventgridTopicsConfigGate();
  if (g) return notConfigured(g.missing, 'Event Grid');
  if (!topic) {
    return NextResponse.json(
      { ok: false, error: 'topic query param is required for Event Grid metrics' },
      { status: 400 },
    );
  }
  return { resourceId: eventGridTopicResourceId(topic) };
}

/** Load the catalog for `kind`, grouping by aggregation, merged in catalog order. */
async function loadMetrics(
  resourceId: string,
  defs: MetricDef[],
  timespan: string,
  interval: string,
): Promise<Array<{ name: string; label: string; unit: string; aggregation: string; points: MetricResult['points'] }>> {
  const byAgg = new Map<string, MetricDef[]>();
  for (const d of defs) {
    const arr = byAgg.get(d.aggregation) || [];
    arr.push(d);
    byAgg.set(d.aggregation, arr);
  }
  const groups = await Promise.all(
    [...byAgg.entries()].map(([aggregation, group]) =>
      fetchMetrics({
        resourceId,
        metricNames: group.map((g) => g.metric),
        timespan,
        interval,
        aggregation,
      }),
    ),
  );
  const byName = new Map<string, MetricResult>();
  for (const m of groups.flat()) byName.set(m.name.toLowerCase(), m);
  return defs.map((d) => {
    const m = byName.get(d.metric.toLowerCase());
    return {
      name: d.metric,
      label: d.label,
      unit: m?.unit || '',
      aggregation: d.aggregation,
      points: m?.points || [],
    };
  });
}

export async function GET(req: NextRequest) {
  if (!getSession()) return unauth();

  const sp = req.nextUrl.searchParams;
  const kind = (sp.get('kind') || '') as Kind;
  if (!CATALOG[kind]) {
    return NextResponse.json(
      { ok: false, error: `unknown kind '${kind}' (expected event-hubs | service-bus | event-grid)` },
      { status: 400 },
    );
  }
  const topic = (sp.get('topic') || '').trim();
  const rangeKey = RANGES[sp.get('range') || ''] ? (sp.get('range') as string) : '1h';
  const { timespan, interval } = RANGES[rangeKey];

  const resolved = resolveResource(kind, topic);
  if (resolved instanceof NextResponse) return resolved;

  try {
    const metrics = await loadMetrics(resolved.resourceId, CATALOG[kind], timespan, interval);
    return NextResponse.json({
      ok: true,
      kind,
      resourceId: resolved.resourceId,
      range: rangeKey,
      timespan,
      interval,
      metrics,
    });
  } catch (e: unknown) {
    // Honest role-gate: metrics read denied → name the exact role to grant.
    if (e instanceof MonitorError && (e.status === 403 || e.status === 401)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'forbidden',
          role: 'Monitoring Reader',
          error:
            'Reading Azure Monitor metrics was denied. Grant the Console UAMI the ' +
            '"Monitoring Reader" role on this resource (or its resource group).',
          detail: e.message,
        },
        { status: 403 },
      );
    }
    const status = e instanceof MonitorError && e.status >= 400 && e.status < 600 ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: (e as Error)?.message || String(e) },
      { status },
    );
  }
}
