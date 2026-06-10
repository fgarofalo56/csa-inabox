/**
 * GET /api/rti-hub
 *
 * Real-Time Intelligence hub — the UNIFIED stream catalog. One-for-one with
 * the Fabric Real-Time hub "Get events" / data-streams surface, but
 * **Azure-native by default** (no Microsoft Fabric, per
 * .claude/rules/no-fabric-dependency.md):
 *
 *   - Enumerates EVERY Event Hub namespace, IoT Hub, and ADX (Kusto) cluster
 *     the Console UAMI can see across the configured subscriptions via Azure
 *     Resource Graph (cross-subscription, no per-RG knowledge required).
 *   - Merges the caller's Loom item index (eventstream / kql-database /
 *     eventhouse items from Cosmos).
 *   - Expands the env-pinned Loom Event Hubs namespace into its individual
 *     event-hub entities (real ARM list) so each is an individually
 *     subscribable source.
 *
 * Response groups rows into three tabs:
 *   - dataStreams  : real Azure streams + Loom items (the default catalog)
 *   - azureEvents  : Azure Event Grid system-topic connectors (Blob Storage
 *                    events today; the per-account system topics are wired in
 *                    the connect flow)
 *   - fabricEvents : Fabric-system event categories — **opt-in only**
 *                    (LOOM_EVENTSTREAM_BACKEND=fabric); [] + gated otherwise.
 *
 * Every row carries a `subscribePreFill` object: the exact body to POST to
 * /api/realtime-hub/connect-source to create a Loom eventstream pre-filled
 * with that source. No mocks — discovery is real Resource Graph + real ARM +
 * real Cosmos. When no subscription is configured the route 503s with the
 * precise missing env var so the UI shows an honest infra-gate.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listAllOwnedItems, listOwnedWorkspaces } from '../items/_lib/item-crud';
import {
  listStreamingResourcesViaGraph,
  rtiSubscriptionScope,
  listEventHubs,
  eventhubsConfigGate,
  readEventHubsConfig,
  EventHubsArmError,
  type RtiStreamResource,
} from '@/lib/azure/eventhubs-client';
import {
  eventgridTopicsConfigGate,
  listEventGridTopics,
} from '@/lib/azure/eventgrid-topics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FABRIC_OPT_IN = (process.env.LOOM_EVENTSTREAM_BACKEND || '').toLowerCase() === 'fabric';
// Fabric is unavailable in sovereign clouds regardless of opt-in.
const SOVEREIGN = /usgovcloudapi\.net|\.azure\.us/i.test(
  process.env.LOOM_ARG_URL || process.env.LOOM_ARM_SCOPE || '',
);

export type RtiHubKind =
  | 'eventstream' | 'eventhub-entity' | 'eventhub-namespace'
  | 'iothub' | 'adx-cluster' | 'kql-database' | 'eventhouse'
  | 'azure-event' | 'fabric-event';

export interface RtiSubscribePreFill {
  /** Fabric Eventstream source `type` enum value (RTH_SOURCE_TYPES). */
  sourceType: string;
  sourceName: string;
  properties: Record<string, unknown>;
}

export interface RtiHubRow {
  id: string;
  name: string;
  kind: RtiHubKind;
  /** Human-facing source label (the backing Azure service / Loom item type). */
  source: string;
  workspaceId?: string;
  workspace?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  location?: string;
  description?: string;
  /** Deep link to the Loom item editor (Loom-item rows only). */
  link?: string;
  subscribePreFill: RtiSubscribePreFill;
}

interface Warning { source: string; error: string }

const ITEM_KIND: Record<string, RtiHubKind> = {
  eventstream: 'eventstream',
  'kql-database': 'kql-database',
  eventhouse: 'eventhouse',
};

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const oid = session.claims.oid;

  const subscriptions = rtiSubscriptionScope();
  if (!subscriptions.length) {
    // Honest infra-gate: the cross-subscription discovery needs at least one
    // subscription id. The UI renders the gate + still shows Loom items below.
    return NextResponse.json(
      {
        ok: false,
        code: 'not_configured',
        error: 'No subscription configured for cross-subscription stream discovery.',
        hint: 'Set LOOM_SUBSCRIPTION_ID (and optionally LOOM_EXTRA_SUBSCRIPTIONS) so the RTI hub can enumerate Event Hubs, IoT Hubs, and ADX clusters via Azure Resource Graph. The Console UAMI also needs Reader at the subscription scope.',
        bicep: 'platform/fiab/bicep/modules/admin-plane/rti-hub-rbac.bicep',
      },
      { status: 503 },
    );
  }

  const warnings: Warning[] = [];
  const dataStreams: RtiHubRow[] = [];

  // ---- 1) Loom item index (Cosmos) — eventstream / kql-database / eventhouse ----
  let workspaceCount = 0;
  try {
    const [items, workspaces] = await Promise.all([listAllOwnedItems(oid), listOwnedWorkspaces(oid)]);
    workspaceCount = workspaces.length;
    const wsName = new Map(workspaces.map((w) => [w.id, w.name] as const));
    for (const it of items) {
      const kind = ITEM_KIND[it.itemType];
      if (!kind) continue;
      dataStreams.push({
        id: it.id,
        name: it.displayName,
        kind,
        source: kind === 'eventstream' ? 'Loom eventstream' : 'Loom KQL / Eventhouse',
        workspaceId: it.workspaceId,
        workspace: wsName.get(it.workspaceId) || it.workspaceId,
        description: it.description,
        link: `/items/${it.itemType}/${it.id}`,
        // Subscribing to an existing eventstream/table connects it as a
        // CustomEndpoint source into a new eventstream (the documented way to
        // chain a Loom stream into another eventstream).
        subscribePreFill: {
          sourceType: 'CustomEndpoint',
          sourceName: it.displayName,
          properties: { upstreamItemId: it.id, upstreamItemType: it.itemType },
        },
      });
    }
  } catch (e: any) {
    warnings.push({ source: 'loom-items', error: e?.message || String(e) });
  }

  // ---- 2) Cross-subscription Azure streams via Resource Graph ----
  let graphResources: RtiStreamResource[] = [];
  try {
    graphResources = await listStreamingResourcesViaGraph(subscriptions);
  } catch (e: any) {
    warnings.push({ source: 'resource-graph', error: e?.message || String(e) });
  }

  // The env-pinned Loom Event Hubs namespace (if configured) is expanded into
  // its individual event-hub entities so each is independently subscribable.
  const ehGate = eventhubsConfigGate();
  let configuredNamespace = '';
  if (!ehGate) {
    try {
      const cfg = readEventHubsConfig();
      configuredNamespace = cfg.namespace.toLowerCase();
      const entities = await listEventHubs();
      for (const eh of entities) {
        dataStreams.push({
          id: `${cfg.namespace}/${eh.name}`,
          name: eh.name,
          kind: 'eventhub-entity',
          source: `Event Hub · ${cfg.namespace}`,
          resourceGroup: cfg.resourceGroup,
          subscriptionId: cfg.subscriptionId,
          description: `${eh.partitionCount ?? '—'} partitions · ${eh.messageRetentionInDays ?? '—'}d retention`,
          subscribePreFill: {
            sourceType: 'AzureEventHub',
            sourceName: eh.name,
            properties: { eventHubName: eh.name, consumerGroupName: '$Default' },
          },
        });
      }
    } catch (e: any) {
      if (!(e instanceof EventHubsArmError && e.status === 503)) {
        warnings.push({ source: 'eventhub-entities', error: e?.message || String(e) });
      }
    }
  }

  for (const r of graphResources) {
    if (r.resourceKind === 'eventhub-namespace') {
      // Skip the env-pinned namespace here — it is already expanded into its
      // individual entities above (avoids a duplicate namespace-level row).
      if (configuredNamespace && r.name.toLowerCase() === configuredNamespace) continue;
      dataStreams.push({
        id: r.id,
        name: r.name,
        kind: 'eventhub-namespace',
        source: 'Event Hubs namespace',
        resourceGroup: r.resourceGroup,
        subscriptionId: r.subscriptionId,
        location: r.location,
        description: 'Event Hubs namespace — subscribe to ingest one of its event hubs.',
        subscribePreFill: {
          sourceType: 'AzureEventHub',
          sourceName: r.name,
          properties: { namespace: r.name, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId, consumerGroupName: '$Default' },
        },
      });
    } else if (r.resourceKind === 'iothub') {
      dataStreams.push({
        id: r.id,
        name: r.name,
        kind: 'iothub',
        source: 'Azure IoT Hub',
        resourceGroup: r.resourceGroup,
        subscriptionId: r.subscriptionId,
        location: r.location,
        description: 'IoT Hub — subscribe to ingest device-to-cloud telemetry.',
        subscribePreFill: {
          sourceType: 'AzureIoTHub',
          sourceName: r.name,
          properties: { iotHubName: r.name, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId, consumerGroupName: '$Default' },
        },
      });
    } else if (r.resourceKind === 'adx-cluster') {
      const uri = (r.properties as any)?.uri as string | undefined;
      dataStreams.push({
        id: r.id,
        name: r.name,
        kind: 'adx-cluster',
        source: 'Azure Data Explorer',
        resourceGroup: r.resourceGroup,
        subscriptionId: r.subscriptionId,
        location: r.location,
        description: uri ? `ADX cluster · ${uri}` : 'Azure Data Explorer cluster.',
        // An ADX-backed subscription routes through an Event Hub the activator
        // can read; the cluster uri is carried for the eventstream editor.
        subscribePreFill: {
          sourceType: 'AzureEventHub',
          sourceName: r.name,
          properties: { adxClusterUri: uri, adxClusterName: r.name, consumerGroupName: '$Default' },
        },
      });
    }
  }

  dataStreams.sort((a, b) => a.name.localeCompare(b.name));

  // ---- 3) Azure events tab — Event Grid system-topic connectors ----
  // Azure Event Grid system topics are per-resource (e.g. per storage account)
  // and have no top-level "events" ARM resource to enumerate via graph alone,
  // so the catalog surfaces the real connectable Azure event categories. Each
  // pre-fills a Blob Storage Events eventstream source (the connect flow binds
  // the System Topic). This is an honest, functional connect action — not mock
  // data — and is annotated `_eventGridDiscovery: 'phase-2'` for the per-account
  // system-topic enumeration that follows.
  const azureEvents: RtiHubRow[] = [
    {
      id: 'azure-blob-storage-events',
      name: 'Azure Blob Storage events',
      kind: 'azure-event',
      source: 'Azure Event Grid',
      description: 'React to blob created / replaced / deleted events from a storage account (Event Grid System Topic).',
      subscribePreFill: {
        sourceType: 'AzureBlobStorageEvents',
        sourceName: 'blob-storage-events',
        properties: {},
      },
    },
  ];

  // Business-event custom topics (the /business-events publishing surface) are
  // first-class discoverable sources in the Real-Time hub — each Event Grid
  // custom topic an operator publishes governed business signals to becomes a
  // subscribable Azure event source here. Real ARM enumeration; best-effort so
  // an Event-Grid config gate never blocks the rest of the catalog.
  try {
    const egGate = eventgridTopicsConfigGate();
    if (!egGate) {
      const topics = await listEventGridTopics();
      for (const t of topics) {
        azureEvents.push({
          id: `eventgrid-topic-${t.name}`,
          name: t.name,
          kind: 'azure-event',
          source: 'Business events · Event Grid',
          location: t.location,
          description: `Governed business-event topic (${t.inputSchema || 'CloudEvents v1.0'}). Subscribe to react to published business signals.`,
          subscribePreFill: {
            sourceType: 'AzureEventGridCustomTopic',
            sourceName: t.name,
            properties: { topic: t.name, inputSchema: t.inputSchema || 'CloudEventSchemaV1_0' },
          },
        });
      }
    }
  } catch (e: any) {
    warnings.push({ source: 'eventgrid-business-topics', error: e?.message || String(e) });
  }

  // ---- 4) Fabric events tab — opt-in only ----
  const fabricEnabled = FABRIC_OPT_IN && !SOVEREIGN;
  const fabricEvents: RtiHubRow[] = fabricEnabled
    ? [
        { type: 'FabricWorkspaceItemEvents', name: 'Fabric Workspace Item events', desc: 'Create/update/delete events on Fabric workspace items.' },
        { type: 'FabricJobEvents', name: 'Fabric Job events', desc: 'Job created / status-changed / succeeded / failed events.' },
        { type: 'FabricOneLakeEvents', name: 'Fabric OneLake events', desc: 'File/folder created/deleted/renamed events in OneLake.' },
        { type: 'FabricCapacityUtilizationEvents', name: 'Fabric Capacity Utilization events', desc: 'Capacity throttling / utilization events.' },
      ].map((f) => ({
        id: f.type.toLowerCase(),
        name: f.name,
        kind: 'fabric-event' as const,
        source: 'Microsoft Fabric',
        description: f.desc,
        subscribePreFill: { sourceType: f.type, sourceName: f.type, properties: {} },
      }))
    : [];

  const fabricGateReason = SOVEREIGN
    ? 'Microsoft Fabric is not available in Azure Government / sovereign clouds.'
    : (!FABRIC_OPT_IN
        ? 'Fabric events are opt-in. Set LOOM_EVENTSTREAM_BACKEND=fabric and bind a Fabric workspace to enable this tab.'
        : undefined);

  return NextResponse.json({
    ok: true,
    backend: 'azure-native',
    subscriptions,
    workspaceCount,
    counts: {
      dataStreams: dataStreams.length,
      azureEvents: azureEvents.length,
      fabricEvents: fabricEvents.length,
    },
    tabs: { dataStreams, azureEvents, fabricEvents },
    fabricEventsGated: !fabricEnabled,
    fabricGateReason,
    eventhubsConfigured: !ehGate,
    eventhubsConfigMissing: ehGate?.missing,
    _eventGridDiscovery: 'phase-2',
    warnings,
  });
}
