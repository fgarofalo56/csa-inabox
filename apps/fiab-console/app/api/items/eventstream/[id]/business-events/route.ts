/**
 * Business Events publisher — governed event-type registry + real Event Hubs send
 * for CSA Loom Eventstreams.
 *
 * GET  /api/items/eventstream/[id]/business-events
 *   Returns the registered governed event types and the Event Hub binding for
 *   this stream. { ok, eventHub, eventTypes[], ehGate?, gate? }
 *
 * POST /api/items/eventstream/[id]/business-events
 *   Four actions (all real Azure, no mocks):
 *
 *   action='define'  { eventType, displayName, category, description?, fields[], channels[], eventHubName?, owner? }
 *     Registers (upserts) a governed event-type schema in the Cosmos
 *     business-event-types container.
 *
 *   action='delete'  { id }
 *     Removes a governed event type.
 *
 *   action='publish'  { id, payload: Record<string,unknown>, partitionKey? }
 *     1. Loads the registered event type from Cosmos.
 *     2. Validates the payload against the governed field schema (pure, no I/O).
 *     3. Publishes a CloudEvents-shaped message to the Event Hub named in the
 *        event type (or the stream's default hub) using eventhubs-data-client
 *        sendEvents — real HTTPS data-plane POST.
 *
 *   action='list-event-types'
 *     POST alias of GET for the tab component.
 *
 * Azure-native DEFAULT (no-fabric-dependency.md): works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset. Gated on LOOM_EVENTHUB_NAMESPACE
 * (publish) + LOOM_COSMOS_ENDPOINT (registry) with honest 501 gates that name
 * the exact env var.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { loadKustoItem, KustoError } from '@/lib/azure/kusto-client';
import {
  listEventTypes,
  getEventType,
  upsertEventType,
  deleteEventType,
  validatePayload,
  businessEventsConfigGate,
  type BusinessEventType,
  type BusinessEventField,
  type BusinessChannel,
  BUSINESS_FIELD_TYPES,
} from '@/lib/azure/business-events-store';
import { sendEvents, EventHubsDataError } from '@/lib/azure/eventhubs-data-client';
import { eventhubsConfigGate } from '@/lib/azure/eventhubs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EVENTHUB_GATE_HINT =
  'Set LOOM_EVENTHUB_NAMESPACE (+ LOOM_EVENTHUB_RG / LOOM_EVENTHUB_SUB) to enable ' +
  'the Azure-native eventstream backend. Grant the Console UAMI ' +
  '"Azure Event Hubs Data Owner" on the namespace for publish access. ' +
  'See platform/fiab/bicep/modules/landing-zone/event-hubs.bicep.';

const COSMOS_GATE_HINT =
  'Set LOOM_COSMOS_ENDPOINT so Loom can reach the business-event-type registry. ' +
  'Grant the Console UAMI "Cosmos DB Built-in Data Contributor" at account scope.';

/**
 * Resolve the backing Event Hub entity for publishing. Priority:
 *  1. Explicit eventHubName on the event type (most specific)
 *  2. The stream item's saved hub name from Cosmos state
 *  3. Env default LOOM_EVENTHUB_DEFAULT_HUB
 *  4. Hard fallback 'loom-eventstream'
 */
function resolveHub(eventType: BusinessEventType, itemState: Record<string, unknown>): string {
  if (eventType.eventHubName && eventType.eventHubName.trim()) return eventType.eventHubName.trim();
  const stateHub =
    (itemState?.hubName as string | undefined) ||
    (itemState?.ehName as string | undefined) ||
    (itemState?.eventHubName as string | undefined);
  if (stateHub && stateHub.trim()) return stateHub.trim();
  return (process.env.LOOM_EVENTHUB_DEFAULT_HUB || 'loom-eventstream').trim();
}

/** Sanitize one field spec from untrusted input. */
function cleanField(raw: unknown): BusinessEventField | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  const type =
    typeof r.type === 'string' && (BUSINESS_FIELD_TYPES as string[]).includes(r.type)
      ? (r.type as BusinessEventField['type'])
      : null;
  if (!name || !type) return null;
  return {
    name,
    type,
    required: r.required === true,
    description: typeof r.description === 'string' ? r.description.trim() || undefined : undefined,
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const cosmosGate = businessEventsConfigGate();
  if (cosmosGate) {
    return apiOk({
      gate: { missing: cosmosGate.missing, hint: COSMOS_GATE_HINT },
      eventHub: null,
      eventTypes: [],
    });
  }

  try {
    const id = (await ctx.params).id;
    let eventHub: string | null = null;
    try {
      const item = await loadKustoItem(id, 'eventstream', session.claims.oid);
      if (item) {
        eventHub = resolveHub(
          { eventHubName: '' } as BusinessEventType,
          (item.state as Record<string, unknown>) ?? {},
        );
      }
    } catch { /* item may not exist on /new — non-blocking */ }

    const ehGate = eventhubsConfigGate();
    const eventTypes = await listEventTypes();
    return apiOk({
      eventHub: eventHub ?? null,
      ehGate: ehGate ? { missing: ehGate.missing, hint: EVENTHUB_GATE_HINT } : null,
      eventTypes,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    if (status !== 500) return apiError(e?.message || String(e), status);
    return apiServerError(e, 'Failed to load eventstream business events');
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const body = await req.json().catch(() => ({}));
  const action = typeof body?.action === 'string' ? body.action : '';

  // ── list-event-types: POST alias of GET ───────────────────────────────
  if (action === 'list-event-types') {
    const cosmosGate = businessEventsConfigGate();
    if (cosmosGate) {
      return apiOk({
        gate: { missing: cosmosGate.missing, hint: COSMOS_GATE_HINT },
        eventTypes: [],
      });
    }
    try {
      const types = await listEventTypes();
      return apiOk({ eventTypes: types });
    } catch (e: any) {
      return apiServerError(e, 'Failed to list event types');
    }
  }

  // ── define: register / update a governed event type ───────────────────
  if (action === 'define') {
    const cosmosGate = businessEventsConfigGate();
    if (cosmosGate) {
      return apiError(
        `Business-event registry not configured: ${cosmosGate.missing}`,
        501,
        { hint: COSMOS_GATE_HINT },
      );
    }
    const eventType = typeof body?.eventType === 'string' ? body.eventType.trim() : '';
    if (!eventType) return apiError('eventType is required', 400);
    const displayName = typeof body?.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : eventType;
    const category = typeof body?.category === 'string' && body.category.trim() ? body.category.trim() : 'General';
    const description = typeof body?.description === 'string' ? body.description.trim() || undefined : undefined;
    const owner = typeof body?.owner === 'string' ? body.owner.trim() || undefined : undefined;
    const eventHubName = typeof body?.eventHubName === 'string' ? body.eventHubName.trim() || undefined : undefined;
    const eventGridTopic = typeof body?.eventGridTopic === 'string' ? body.eventGridTopic.trim() || undefined : undefined;

    const rawFields: unknown[] = Array.isArray(body?.fields) ? body.fields : [];
    const fields: BusinessEventField[] = rawFields.map(cleanField).filter((f): f is BusinessEventField => f !== null);

    const VALID_CHANNELS: BusinessChannel[] = ['eventhub', 'eventgrid'];
    const rawChannels: unknown[] = Array.isArray(body?.channels) ? body.channels : ['eventhub'];
    const channels: BusinessChannel[] = rawChannels.filter(
      (c): c is BusinessChannel => VALID_CHANNELS.includes(c as BusinessChannel),
    );
    if (!channels.length) channels.push('eventhub');

    try {
      const saved = await upsertEventType(
        { eventType, displayName, category, description, fields, channels, eventHubName, eventGridTopic, owner },
        session.claims.oid,
      );
      return apiOk({ eventType: saved });
    } catch (e: any) {
      return apiServerError(e, 'Failed to register event type');
    }
  }

  // ── delete: remove a governed event type ──────────────────────────────
  if (action === 'delete') {
    const cosmosGate = businessEventsConfigGate();
    if (cosmosGate) {
      return apiError(
        `Business-event registry not configured: ${cosmosGate.missing}`,
        501,
        { hint: COSMOS_GATE_HINT },
      );
    }
    const typeId = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!typeId) return apiError('id is required', 400);
    try {
      await deleteEventType(typeId);
      return apiOk({ deleted: typeId });
    } catch (e: any) {
      return apiServerError(e, 'Failed to delete event type');
    }
  }

  // ── publish: validate payload + send to real Event Hub ────────────────
  if (action === 'publish') {
    const ehGate = eventhubsConfigGate();
    if (ehGate) {
      return apiError(
        `Event Hubs not configured: ${ehGate.missing}`,
        501,
        { hint: EVENTHUB_GATE_HINT, gate: { missing: ehGate.missing } },
      );
    }
    const cosmosGate = businessEventsConfigGate();
    if (cosmosGate) {
      return apiError(
        `Business-event registry not configured: ${cosmosGate.missing}`,
        501,
        { hint: COSMOS_GATE_HINT },
      );
    }

    const typeId = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!typeId) return apiError('id is required', 400);
    const rawPayload = body?.payload;
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      return apiError('payload must be a JSON object', 400);
    }
    const payload = rawPayload as Record<string, unknown>;
    const partitionKey = typeof body?.partitionKey === 'string' ? body.partitionKey.trim() || undefined : undefined;

    try {
      const id = (await ctx.params).id;

      // 1. Load the registered governed event type.
      const et = await getEventType(typeId);
      if (!et) {
        return apiError(`Event type "${typeId}" not found in the registry.`, 404);
      }

      // 2. Validate payload against the governed field schema (pure, no I/O).
      const validationErrors = validatePayload(et, payload);
      if (validationErrors.length > 0) {
        return apiError(
          `Payload validation failed (${String(validationErrors.length)} error${validationErrors.length === 1 ? '' : 's'}).`,
          422,
          { validationErrors },
        );
      }

      // 3. Resolve backing Event Hub entity.
      let eventHub: string;
      try {
        const item = await loadKustoItem(id, 'eventstream', session.claims.oid);
        eventHub = resolveHub(et, (item?.state as Record<string, unknown>) ?? {});
      } catch {
        // Fallback: resolve without item state.
        eventHub = resolveHub(et, {});
      }

      // 4. Build a CloudEvents 1.0 envelope.
      const cloudEventId = `${String(Date.now())}-${Math.random().toString(36).slice(2, 9)}`;
      const cloudEvent: Record<string, unknown> = {
        specversion: '1.0',
        id: cloudEventId,
        type: et.eventType,
        source: `urn:csa-loom:eventstream:${id}`,
        time: new Date().toISOString(),
        datacontenttype: 'application/json',
        data: payload,
      };

      // 5. Send via real HTTPS data-plane REST — no Fabric, no mock.
      const result = await sendEvents(
        eventHub,
        [{ body: cloudEvent, properties: { eventType: et.eventType, source: 'csa-loom' } }],
        partitionKey ? { partitionKey } : {},
      );

      return apiOk({
        sent: result.sent,
        hub: eventHub,
        eventType: et.eventType,
        cloudEventId,
      });
    } catch (e: any) {
      if (e instanceof EventHubsDataError) {
        return apiError(e.message, e.status, { hint: EVENTHUB_GATE_HINT });
      }
      const status = e instanceof KustoError ? e.status : 500;
      if (status !== 500) return apiError(e?.message || String(e), status);
      return apiServerError(e, 'Failed to publish event');
    }
  }

  return apiError(`unknown action "${action}"`, 400);
}
