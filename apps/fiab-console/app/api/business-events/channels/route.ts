/**
 * Business-event CHANNELS — the publish destinations + capacity metering.
 *
 *   GET /api/business-events/channels
 *     → {
 *         ok,
 *         eventGrid: { configured, topics: EventGridTopic[], gate? },
 *         eventHub:  { configured, namespace?, hubs: [...], gate? },
 *         metering:  { window, eventGrid: MeterPoint[], eventHub: MeterPoint[] } | null
 *       }
 *
 * Enumerates the real Event Grid custom topics + Event Hub entities the Console
 * UAMI can publish to, and reads recent throughput from Azure Monitor so the UI
 * shows real capacity consumption (PublishSuccessCount on the topic;
 * IncomingMessages on the namespace). Each backend gates independently with the
 * precise missing env var; one being unset never blocks the other.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventgridTopicsConfigGate,
  readEventGridTopicsConfig,
  listEventGridTopics,
  type EventGridTopic,
} from '@/lib/azure/eventgrid-topics-client';
import {
  eventhubsConfigGate,
  readEventHubsConfig,
  listEventHubs,
} from '@/lib/azure/eventhubs-client';
import { armBase } from '@/lib/azure/cloud-endpoints';
import { fetchMetrics } from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MeterSeries { name: string; unit: string; points: { timeStamp: string; value: number | null }[] }

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // ── Event Grid custom topics ─────────────────────────────────────────────
  const egGate = eventgridTopicsConfigGate();
  let egTopics: EventGridTopic[] = [];
  let egResourceId = '';
  if (!egGate) {
    try {
      const cfg = readEventGridTopicsConfig();
      egTopics = await listEventGridTopics();
      const first = egTopics[0]?.name;
      if (first) {
        egResourceId = `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.EventGrid/topics/${first}`;
      }
    } catch (e: any) {
      // Surface as a soft warning on the eventGrid block (still render the UI).
      egTopics = [];
    }
  }

  // ── Event Hubs entities ──────────────────────────────────────────────────
  const ehGate = eventhubsConfigGate();
  let ehHubs: { name: string; partitionCount?: number; messageRetentionInDays?: number }[] = [];
  let ehNamespace = '';
  let ehResourceId = '';
  if (!ehGate) {
    try {
      const cfg = readEventHubsConfig();
      ehNamespace = cfg.namespace;
      ehResourceId = `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.EventHub/namespaces/${cfg.namespace}`;
      const hubs = await listEventHubs();
      ehHubs = hubs.map((h) => ({
        name: h.name,
        partitionCount: h.partitionCount,
        messageRetentionInDays: h.messageRetentionInDays,
      }));
    } catch {
      ehHubs = [];
    }
  }

  // ── Capacity metering (Azure Monitor) — best-effort, never blocks ─────────
  let metering: {
    window: string;
    eventGrid: MeterSeries[];
    eventHub: MeterSeries[];
  } | null = null;
  try {
    const window = 'P1D';
    const eventGrid: MeterSeries[] = egResourceId
      ? (await fetchMetrics({
          resourceId: egResourceId,
          metricNames: ['PublishSuccessCount', 'PublishFailCount'],
          timespan: window,
          interval: 'PT1H',
          aggregation: 'Total',
        })).map((m) => ({ name: m.name, unit: m.unit, points: m.points }))
      : [];
    const eventHub: MeterSeries[] = ehResourceId
      ? (await fetchMetrics({
          resourceId: ehResourceId,
          metricNames: ['IncomingMessages', 'IncomingBytes'],
          timespan: window,
          interval: 'PT1H',
          aggregation: 'Total',
        })).map((m) => ({ name: m.name, unit: m.unit, points: m.points }))
      : [];
    if (eventGrid.length || eventHub.length) metering = { window, eventGrid, eventHub };
  } catch {
    metering = null;
  }

  return NextResponse.json({
    ok: true,
    eventGrid: {
      configured: !egGate,
      topics: egTopics,
      gate: egGate ? { missing: egGate.missing } : undefined,
    },
    eventHub: {
      configured: !ehGate,
      namespace: ehNamespace || undefined,
      hubs: ehHubs,
      gate: ehGate ? { missing: ehGate.missing } : undefined,
    },
    metering,
  });
}
