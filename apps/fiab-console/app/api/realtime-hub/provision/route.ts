/**
 * POST /api/realtime-hub/provision
 *
 * Create-if-missing for the Real-Time Hub "Connect a source" dialog's inline
 * "+ Create new…" affordance — **Azure-native, real ARM PUTs** (no mocks, per
 * .claude/rules/no-vaporware.md). When a user picks a namespace / IoT hub that
 * has no event hub or consumer group yet, this provisions one and returns it so
 * the dialog selects it immediately, then the source binds against it.
 *
 * Body (`kind` drives what is created):
 *   { kind:'eventhub', subscriptionId, resourceGroup, namespace, eventHub,
 *     partitionCount?, retentionDays? }
 *   { kind:'consumerGroup', subscriptionId, resourceGroup, namespace, eventHub,
 *     consumerGroup }
 *   { kind:'iotConsumerGroup', hubName, consumerGroup[, subscriptionId, resourceGroup] }
 *
 * Requires the Console UAMI to hold Contributor on the target namespace / hub
 * (granted by platform/fiab/bicep/modules/landing-zone/eventhubs.bicep for the
 * env-pinned namespace; for arbitrary cross-subscription namespaces set
 * grantSubscriptionContributor=true on admin-plane/rti-hub-rbac.bicep). ARM
 * errors are surfaced verbatim (status + body) so the dialog shows the real
 * reason (e.g. 403 AuthorizationFailed) rather than a generic failure.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import {
  ensureEventHub,
  ensureConsumerGroup,
  ensureNamespace,
  EventHubsArmError,
  type EventHubsConfig,
} from '@/lib/azure/eventhubs-client';
import { ensureIoTHubConsumerGroup, IoTHubArmError } from '@/lib/azure/iothub-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function passThrough(e: unknown) {
  if (e instanceof EventHubsArmError || e instanceof IoTHubArmError) {
    return NextResponse.json(
      { ok: false, error: e.message, status: e.status, body: e.body },
      { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
    );
  }
  return NextResponse.json({ ok: false, error: (e as any)?.message || String(e) }, { status: 500 });
}

function readScope(body: any): EventHubsConfig | null {
  const subscriptionId = String(body?.subscriptionId || '').trim();
  const resourceGroup = String(body?.resourceGroup || '').trim();
  const namespace = String(body?.namespace || '').trim();
  if (!subscriptionId || !resourceGroup || !namespace) return null;
  return { subscriptionId, resourceGroup, namespace };
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const limited = await enforceRateLimit(session, 'provision');
  if (limited) return limited;

  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return NextResponse.json({ ok: false, error: 'Content-Type must be application/json' }, { status: 415 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const kind = String(body.kind || '').trim();

  try {
    if (kind === 'namespace') {
      const scope = readScope(body);
      if (!scope) return NextResponse.json({ ok: false, error: 'subscriptionId, resourceGroup and namespace are required.' }, { status: 400 });
      const location = String(body.location || '').trim();
      if (!location) return NextResponse.json({ ok: false, error: 'location (Azure region) is required.', hint: 'e.g. eastus' }, { status: 400 });
      const skuRaw = String(body.sku || 'Standard').trim();
      const sku = (['Basic', 'Standard', 'Premium'] as const).includes(skuRaw as any) ? (skuRaw as 'Basic' | 'Standard' | 'Premium') : 'Standard';
      const ns = await ensureNamespace(scope, { location, sku });
      return NextResponse.json({ ok: true, kind, created: { name: ns.name, location: ns.location, sku: ns.sku } });
    }

    if (kind === 'eventhub') {
      const scope = readScope(body);
      if (!scope) return NextResponse.json({ ok: false, error: 'subscriptionId, resourceGroup and namespace are required.' }, { status: 400 });
      const eventHub = String(body.eventHub || '').trim();
      if (!eventHub) return NextResponse.json({ ok: false, error: 'eventHub (name) is required.' }, { status: 400 });
      const partitionCount = Number.isFinite(+body.partitionCount) ? Math.max(1, Math.min(32, Math.trunc(+body.partitionCount))) : undefined;
      const messageRetentionInDays = Number.isFinite(+body.retentionDays) ? Math.max(1, Math.min(7, Math.trunc(+body.retentionDays))) : undefined;
      const eh = await ensureEventHub(scope, { name: eventHub, partitionCount, messageRetentionInDays });
      return NextResponse.json({ ok: true, kind, created: { name: eh.name, partitionCount: eh.partitionCount, messageRetentionInDays: eh.messageRetentionInDays } });
    }

    if (kind === 'consumerGroup') {
      const scope = readScope(body);
      if (!scope) return NextResponse.json({ ok: false, error: 'subscriptionId, resourceGroup and namespace are required.' }, { status: 400 });
      const eventHub = String(body.eventHub || '').trim();
      const consumerGroup = String(body.consumerGroup || '').trim();
      if (!eventHub) return NextResponse.json({ ok: false, error: 'eventHub is required.' }, { status: 400 });
      if (!consumerGroup) return NextResponse.json({ ok: false, error: 'consumerGroup (name) is required.' }, { status: 400 });
      const cg = await ensureConsumerGroup(scope, eventHub, consumerGroup);
      return NextResponse.json({ ok: true, kind, created: { name: cg.name } });
    }

    if (kind === 'iotConsumerGroup') {
      const hubName = String(body.hubName || '').trim();
      const consumerGroup = String(body.consumerGroup || '').trim();
      if (!hubName) return NextResponse.json({ ok: false, error: 'hubName is required.' }, { status: 400 });
      if (!consumerGroup) return NextResponse.json({ ok: false, error: 'consumerGroup (name) is required.' }, { status: 400 });
      const subscriptionId = String(body.subscriptionId || '').trim() || undefined;
      const resourceGroup = String(body.resourceGroup || '').trim() || undefined;
      const cg = await ensureIoTHubConsumerGroup(hubName, consumerGroup, { subscriptionId, resourceGroup });
      return NextResponse.json({ ok: true, kind, created: { name: cg.name } });
    }

    return NextResponse.json({ ok: false, error: `Unknown kind "${kind}".`, hint: 'kind ∈ namespace | eventhub | consumerGroup | iotConsumerGroup' }, { status: 400 });
  } catch (e) {
    return passThrough(e);
  }
}
