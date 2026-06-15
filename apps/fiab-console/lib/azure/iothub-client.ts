/**
 * Azure IoT Hub — ARM management-plane client (built-in Event Hubs endpoint).
 *
 * An Eventstream "IoT Hub" source does NOT talk to the device-facing IoT Hub
 * data plane. It reads the hub's BUILT-IN Event Hubs-compatible endpoint —
 * every IoT Hub exposes one under `properties.eventHubEndpoints.events`. This
 * client resolves that endpoint (FQDN + entity path) from ARM so the source
 * node can be consumed exactly like an Event Hub (same AMQP/Kafka surface,
 * same Entra auth). Grounded in Learn:
 *   https://learn.microsoft.com/azure/iot-hub/iot-hub-devguide-messages-read-builtin
 *   https://learn.microsoft.com/rest/api/iothub/iot-hub-resource/get
 *
 * Sovereign-cloud aware: the ARM host follows AZURE_CLOUD / LOOM_ARM_ENDPOINT
 * (Commercial / GCC-High / IL5), identical to adf-client.ts. The endpoint FQDN
 * returned by ARM is authoritative (it already carries the correct
 * `servicebus.usgovcloudapi.net` suffix in Government), so no suffix override
 * is needed.
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
 * DefaultAzureCredential) against the ARM scope. The Loom UAMI must hold at
 * least Reader on the IoT Hub to resolve the endpoint, and "Azure Event Hubs
 * Data Receiver" on the hub's built-in endpoint to actually read events.
 *
 * No mocks. Real ARM REST only. When env is unset the BFF 503s via
 * iotHubConfigGate() with the exact missing variable.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
// ARM endpoint is sovereign-cloud aware — canonical resolver, not a local copy
// (keeps the management host literal solely in cloud-endpoints.ts).
import { armBase } from './cloud-endpoints';

// Stable GA api-version for Microsoft.Devices/IotHubs.
const IOTHUB_API = '2023-06-30';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class IoTHubArmError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `IoT Hub ARM call failed (${status})`);
    this.name = 'IoTHubArmError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Honest config gate. The IoT Hub source resolves the hub by name within a
 * subscription + resource group. These default to the shared Loom landing-zone
 * subscription/RG; an explicit IoT-specific override wins when present.
 */
export function iotHubConfigGate(opts?: { subscriptionId?: string; resourceGroup?: string }): { missing: string } | null {
  const sub = opts?.subscriptionId || process.env.LOOM_IOTHUB_SUB || process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) return { missing: 'LOOM_IOTHUB_SUB (or LOOM_SUBSCRIPTION_ID)' };
  const rg = opts?.resourceGroup || process.env.LOOM_IOTHUB_RG || process.env.LOOM_DLZ_RG;
  if (!rg) return { missing: 'LOOM_IOTHUB_RG (or LOOM_DLZ_RG)' };
  return null;
}

interface ResolvedScope { subscriptionId: string; resourceGroup: string; }

function resolveScope(opts?: { subscriptionId?: string; resourceGroup?: string }): ResolvedScope {
  const subscriptionId = opts?.subscriptionId || process.env.LOOM_IOTHUB_SUB || process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup = opts?.resourceGroup || process.env.LOOM_IOTHUB_RG || process.env.LOOM_DLZ_RG || '';
  if (!subscriptionId || !resourceGroup) {
    throw new IoTHubArmError(503, undefined, 'IoT Hub subscription/resource group not configured');
  }
  return { subscriptionId, resourceGroup };
}

async function callArm(url: string, init?: RequestInit): Promise<Response> {
  const scope = `${armBase()}/.default`;
  const t = await credential.getToken(scope);
  if (!t?.token) throw new IoTHubArmError(401, undefined, 'Failed to acquire ARM token');
  return fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${t.token}`,
      'content-type': 'application/json',
    },
  });
}

/** The resolved built-in Event Hubs-compatible endpoint of an IoT Hub. */
export interface IoTHubEhEndpoint {
  /** Event Hubs-compatible FQDN, e.g. "ihsuprodxxx.servicebus.windows.net". */
  fqdn: string;
  /** The Event Hubs-compatible entity path within that namespace. */
  entityPath: string;
  partitionCount?: number;
  retentionTimeInDays?: number;
}

/**
 * Resolve the built-in Event Hubs-compatible endpoint for an IoT Hub. The ARM
 * resource returns `properties.eventHubEndpoints.events.{ endpoint, path }`
 * where `endpoint` is `sb://<ns>.servicebus.windows.net/`; we strip the scheme
 * + trailing slash to a bare FQDN the Event Hubs data plane can use.
 */
export async function getIoTHubEhEndpoint(
  hubName: string,
  opts?: { subscriptionId?: string; resourceGroup?: string },
): Promise<IoTHubEhEndpoint> {
  const name = (hubName || '').trim();
  if (!name) throw new IoTHubArmError(400, undefined, 'IoT Hub name is required');
  const { subscriptionId, resourceGroup } = resolveScope(opts);
  const url = `${armBase()}/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Devices/IotHubs/${encodeURIComponent(name)}?api-version=${IOTHUB_API}`;
  const r = await callArm(url);
  if (!r.ok) throw new IoTHubArmError(r.status, await r.text(), `getIoTHub(${name}) failed ${r.status}`);
  const body: any = await r.json();
  const events = body?.properties?.eventHubEndpoints?.events;
  if (!events?.endpoint || !events?.path) {
    throw new IoTHubArmError(
      404,
      body,
      `IoT Hub "${name}" did not expose a built-in Event Hubs endpoint (properties.eventHubEndpoints.events).`,
    );
  }
  const fqdn = String(events.endpoint).replace(/^sb:\/\//i, '').replace(/\/+$/, '');
  return {
    fqdn,
    entityPath: String(events.path),
    partitionCount: typeof events.partitionCount === 'number' ? events.partitionCount : undefined,
    retentionTimeInDays: typeof events.retentionTimeInDays === 'number' ? events.retentionTimeInDays : undefined,
  };
}

// ============================================================
// Built-in Event Hubs endpoint consumer groups
//
// An Eventstream IoT Hub source reads the hub's built-in `events` endpoint
// through a CONSUMER GROUP — exactly like an Event Hub. ARM exposes those as
//   …/IotHubs/{name}/eventHubEndpoints/events/ConsumerGroups[/{cg}]
// (the "events" partition is the only built-in routing endpoint). The connect
// dialog populates its Consumer-group dropdown from this list and "+ Create
// new…" PUTs a new one. Grounded in Learn:
//   https://learn.microsoft.com/rest/api/iothub/iot-hub-resource/list-event-hub-consumer-groups
//   https://learn.microsoft.com/rest/api/iothub/iot-hub-resource/create-event-hub-consumer-group
// ============================================================

export interface IoTHubConsumerGroup {
  name: string;
  hubName: string;
}

/** List the consumer groups on an IoT Hub's built-in `events` endpoint. */
export async function listIoTHubConsumerGroups(
  hubName: string,
  opts?: { subscriptionId?: string; resourceGroup?: string },
): Promise<IoTHubConsumerGroup[]> {
  const name = (hubName || '').trim();
  if (!name) throw new IoTHubArmError(400, undefined, 'IoT Hub name is required');
  const scope = resolveScope(opts);
  const base = `${armBase()}/subscriptions/${scope.subscriptionId}/resourceGroups/${encodeURIComponent(scope.resourceGroup)}/providers/Microsoft.Devices/IotHubs/${encodeURIComponent(name)}/eventHubEndpoints/events/ConsumerGroups?api-version=${IOTHUB_API}`;
  const out: IoTHubConsumerGroup[] = [];
  let next: string | undefined = base;
  let guard = 0;
  while (next && guard < 20) {
    guard++;
    const r: Response = await callArm(next);
    if (!r.ok) throw new IoTHubArmError(r.status, await r.text(), `listIoTHubConsumerGroups(${name}) failed ${r.status}`);
    const body: any = await r.json();
    const rows: any[] = Array.isArray(body?.value) ? body.value : [];
    for (const row of rows) {
      // Each entry is either a bare string name or an object with `.name`.
      const cgName = typeof row === 'string' ? row : (row?.name || row?.properties?.name);
      if (cgName) out.push({ name: String(cgName), hubName: name });
    }
    next = body?.nextLink;
  }
  return out;
}

/**
 * Create-if-missing a consumer group on the IoT Hub's built-in endpoint. The
 * default "$Default" group always exists, so it is short-circuited. The PUT is
 * idempotent, so the connect dialog's "+ Create new…" path is safe to re-run.
 */
export async function ensureIoTHubConsumerGroup(
  hubName: string,
  name: string,
  opts?: { subscriptionId?: string; resourceGroup?: string },
): Promise<IoTHubConsumerGroup> {
  const hub = (hubName || '').trim();
  if (!hub) throw new IoTHubArmError(400, undefined, 'IoT Hub name is required');
  const cg = (name || '').trim();
  if (!cg || cg === '$Default') return { name: '$Default', hubName: hub };
  const scope = resolveScope(opts);
  const url = `${armBase()}/subscriptions/${scope.subscriptionId}/resourceGroups/${encodeURIComponent(scope.resourceGroup)}/providers/Microsoft.Devices/IotHubs/${encodeURIComponent(hub)}/eventHubEndpoints/events/ConsumerGroups/${encodeURIComponent(cg)}?api-version=${IOTHUB_API}`;
  const r = await callArm(url, { method: 'PUT', body: JSON.stringify({ properties: { name: cg } }) });
  if (!r.ok) throw new IoTHubArmError(r.status, await r.text(), `ensureIoTHubConsumerGroup(${cg}) failed ${r.status}`);
  return { name: cg, hubName: hub };
}
