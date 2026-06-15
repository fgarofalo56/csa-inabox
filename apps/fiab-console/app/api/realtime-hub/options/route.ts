/**
 * GET /api/realtime-hub/options
 *
 * Cascading source-binding option lists for the Real-Time Hub "Connect a
 * source" dialog — **Azure-native by default** (no Microsoft Fabric, per
 * .claude/rules/no-fabric-dependency.md). Mirrors the Fabric Real-Time hub
 * Azure-tab dropdowns one-for-one: namespace → event hub → consumer group /
 * key-name; IoT Hub → consumer group. Every list is REAL ARM / Resource Graph
 * data (no mocks, no `return []` placeholders).
 *
 * Query (`kind` drives the shape):
 *   ?kind=namespaces[&service=eventhub|iothub]    → discoverable EH namespaces / IoT hubs
 *   ?kind=eventhubs&subscriptionId&resourceGroup&namespace
 *   ?kind=consumerGroups&subscriptionId&resourceGroup&namespace&eventHub
 *   ?kind=authRules&subscriptionId&resourceGroup&namespace&eventHub
 *   ?kind=iotConsumerGroups&hubName[&subscriptionId&resourceGroup]
 *
 * Honest infra-gate: when no subscription is configured the route 503s with the
 * precise missing env var + bicep module (identical to GET /api/rti-hub), so the
 * dialog shows a MessageBar rather than an empty dropdown.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listStreamingResourcesViaGraph,
  rtiSubscriptionScope,
  listEventHubsIn,
  listConsumerGroupsIn,
  listEventHubAuthRulesIn,
  EventHubsArmError,
  type EventHubsConfig,
} from '@/lib/azure/eventhubs-client';
import { listIoTHubConsumerGroups, IoTHubArmError } from '@/lib/azure/iothub-client';
import { listConnections } from '@/lib/azure/connections-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function notConfigured() {
  return NextResponse.json(
    {
      ok: false,
      code: 'not_configured',
      error: 'No subscription configured for source discovery.',
      hint: 'Set LOOM_SUBSCRIPTION_ID (and optionally LOOM_EXTRA_SUBSCRIPTIONS) so the Real-Time Hub can enumerate Event Hubs / IoT Hubs via Azure Resource Graph. The Console UAMI also needs Reader at the subscription scope.',
      bicep: 'platform/fiab/bicep/modules/admin-plane/rti-hub-rbac.bicep',
    },
    { status: 503 },
  );
}

function passThrough(e: unknown) {
  if (e instanceof EventHubsArmError || e instanceof IoTHubArmError) {
    return NextResponse.json(
      { ok: false, error: e.message, status: e.status, body: e.body },
      { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
    );
  }
  return NextResponse.json({ ok: false, error: (e as any)?.message || String(e) }, { status: 500 });
}

/** Resolve a namespace EventHubsConfig from explicit query params. */
function readScope(p: URLSearchParams): EventHubsConfig | null {
  const subscriptionId = (p.get('subscriptionId') || '').trim();
  const resourceGroup = (p.get('resourceGroup') || '').trim();
  const namespace = (p.get('namespace') || '').trim();
  if (!subscriptionId || !resourceGroup || !namespace) return null;
  return { subscriptionId, resourceGroup, namespace };
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const kind = (p.get('kind') || '').trim();

  try {
    // ---- namespaces (and IoT hubs) — cross-subscription via Resource Graph ----
    if (kind === 'namespaces') {
      const subs = rtiSubscriptionScope();
      if (!subs.length) return notConfigured();
      const service = (p.get('service') || 'eventhub').trim();
      const want = service === 'iothub' ? 'iothub' : 'eventhub-namespace';
      const resources = await listStreamingResourcesViaGraph(subs);
      const options = resources
        .filter((r) => r.resourceKind === want)
        .map((r) => ({
          id: r.id,
          name: r.name,
          resourceGroup: r.resourceGroup,
          subscriptionId: r.subscriptionId,
          location: r.location,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      // Filter facets so the dialog can offer subscription / RG / region filters
      // exactly like the Fabric Azure tab. `subscriptions` always carries the
      // configured discovery scope (even when zero namespaces exist yet) so the
      // inline "Create new namespace" panel can offer a subscription picker.
      const facets = {
        subscriptions: Array.from(new Set([...subs, ...options.map((o) => o.subscriptionId)])).sort(),
        resourceGroups: Array.from(new Set(options.map((o) => o.resourceGroup))).sort(),
        locations: Array.from(new Set(options.map((o) => o.location).filter(Boolean))).sort(),
      };
      return NextResponse.json({ ok: true, kind, service, options, facets });
    }

    // ---- event hubs in a chosen namespace ----
    if (kind === 'eventhubs') {
      const scope = readScope(p);
      if (!scope) return NextResponse.json({ ok: false, error: 'subscriptionId, resourceGroup and namespace are required.' }, { status: 400 });
      const hubs = await listEventHubsIn(scope);
      const options = hubs
        .map((h) => ({
          name: h.name,
          description: `${h.partitionCount ?? '—'} partitions · ${h.messageRetentionInDays ?? '—'}d retention`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return NextResponse.json({ ok: true, kind, options });
    }

    // ---- consumer groups for a chosen event hub ----
    if (kind === 'consumerGroups') {
      const scope = readScope(p);
      const eventHub = (p.get('eventHub') || '').trim();
      if (!scope || !eventHub) return NextResponse.json({ ok: false, error: 'subscriptionId, resourceGroup, namespace and eventHub are required.' }, { status: 400 });
      const cgs = await listConsumerGroupsIn(scope, eventHub);
      const names = new Set(cgs.map((c) => c.name));
      // $Default is always present on every event hub even if ARM omits it.
      const options = Array.from(new Set(['$Default', ...names])).sort().map((name) => ({ name }));
      return NextResponse.json({ ok: true, kind, options });
    }

    // ---- authorization rules (SAS key names) for a chosen event hub ----
    if (kind === 'authRules') {
      const scope = readScope(p);
      const eventHub = (p.get('eventHub') || '').trim();
      if (!scope || !eventHub) return NextResponse.json({ ok: false, error: 'subscriptionId, resourceGroup, namespace and eventHub are required.' }, { status: 400 });
      const rules = await listEventHubAuthRulesIn(scope, eventHub);
      const options = rules
        .map((r) => ({ name: r.name, description: (r.rights || []).join(', ') }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return NextResponse.json({ ok: true, kind, options });
    }

    // ---- IoT Hub consumer groups (built-in events endpoint) ----
    if (kind === 'iotConsumerGroups') {
      const hubName = (p.get('hubName') || '').trim();
      if (!hubName) return NextResponse.json({ ok: false, error: 'hubName is required.' }, { status: 400 });
      const subscriptionId = (p.get('subscriptionId') || '').trim() || undefined;
      const resourceGroup = (p.get('resourceGroup') || '').trim() || undefined;
      const cgs = await listIoTHubConsumerGroups(hubName, { subscriptionId, resourceGroup });
      const names = new Set(cgs.map((c) => c.name));
      const options = Array.from(new Set(['$Default', ...names])).sort().map((name) => ({ name }));
      return NextResponse.json({ ok: true, kind, options });
    }

    // ---- Loom connections (Key Vault-backed data-source connections) ----
    // Powers the `dataConnectionId` picker on CDC / Service Bus / Kafka / Blob
    // sources so credentials are reused from /connections instead of being
    // re-typed as free text (no-vaporware + loom-no-freeform-config).
    if (kind === 'connections') {
      const wantType = (p.get('type') || '').trim();
      const conns = await listConnections(session);
      const options = conns
        .filter((c) => (wantType ? c.type === wantType : true))
        .map((c) => ({ id: c.id, name: c.name, description: c.type }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return NextResponse.json({ ok: true, kind, options });
    }

    return NextResponse.json({ ok: false, error: `Unknown kind "${kind}".`, hint: 'kind ∈ namespaces | eventhubs | consumerGroups | authRules | iotConsumerGroups | connections' }, { status: 400 });
  } catch (e) {
    return passThrough(e);
  }
}
