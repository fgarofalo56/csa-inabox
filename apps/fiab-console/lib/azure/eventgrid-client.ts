/**
 * eventgrid-client — minimal ARM wrapper to wire the Direct-Lake-shim's
 * change-detection path: a Storage **Event Grid system topic** + a
 * **Service Bus queue** subscription that delivers `BlobCreated` events for
 * Delta `_delta_log` commits to the running shim.
 *
 * This is the runtime "configure the shim" half of the Direct Lake (shim) tab:
 * when an operator points a semantic model at a Delta source, the BFF PUT
 * ensures the system topic + subscription exist for that storage account so
 * the shim starts receiving commit notifications. (aas.bicep wires the same
 * topology at deploy time for the default DLZ lake account; this lets the
 * operator extend it to additional / external Delta source accounts at
 * runtime.)
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) via ManagedIdentityCredential
 * chained with DefaultAzureCredential. The UAMI needs EventGrid Contributor on
 * the storage account's resource group; a 403 surfaces as an honest gate.
 *
 * Real ARM only — no mocks. Sovereign-cloud aware via armBase().
 * Docs:
 *   https://learn.microsoft.com/azure/event-grid/system-topics
 *   https://learn.microsoft.com/rest/api/eventgrid/controlplane/system-topics
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import { parseDeltaSource, toAbfss, toHttps, type DeltaSourceRef } from './delta-source-uri';

// Re-export the pure URI helpers so existing importers of eventgrid-client keep
// working (the implementations now live in the dependency-free delta-source-uri
// module so they are unit-testable without the Azure SDK).
export { parseDeltaSource, toAbfss, toHttps };
export type { DeltaSourceRef };

const EG_API = '2023-12-15-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const cred = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export class EventGridError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'EventGridError';
    this.status = status;
    this.body = body;
  }
}

async function armToken(): Promise<string> {
  const t = await cred.getToken(armScope());
  if (!t?.token) throw new EventGridError('Failed to acquire ARM token for Event Grid', 401);
  return t.token;
}

async function arm<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await armToken();
  const res = await fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = json?.error?.message || text || `ARM ${res.status}`;
    throw new EventGridError(msg, res.status, json || text);
  }
  return json as T;
}

function storageAccountId(sub: string, rg: string, account: string): string {
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${account}`;
}

function systemTopicName(account: string): string {
  return `loom-dl-shim-${account}`;
}

export interface ShimSubscriptionStatus {
  systemTopic: string;
  /** ARM provisioningState of the system topic, or 'NotFound'. */
  topicState: string;
  subscriptionName: string;
  /** ARM provisioningState of the event subscription, or 'NotFound'. */
  subscriptionState: string;
  /** Service Bus queue resource id the subscription delivers to (echoed for transparency). */
  destinationQueueId?: string;
}

/**
 * Read the current system-topic + delta-log subscription state for a storage
 * account. Never throws on 404 — a missing topic/subscription is reported as
 * 'NotFound' so the UI renders an honest "not yet wired" state.
 */
export async function getShimSubscriptionStatus(
  account: string,
  opts?: { subscriptionId?: string; resourceGroup?: string },
): Promise<ShimSubscriptionStatus> {
  const sub = opts?.subscriptionId || process.env.LOOM_SUBSCRIPTION_ID;
  const rg = opts?.resourceGroup || process.env.LOOM_DLZ_RG;
  if (!sub || !rg) throw new EventGridError('LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG required', 400);
  const topic = systemTopicName(account);
  const base = `${armBase()}/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.EventGrid/systemTopics/${topic}`;
  const out: ShimSubscriptionStatus = {
    systemTopic: topic,
    topicState: 'NotFound',
    subscriptionName: 'loom-dl-shim-delta-log',
    subscriptionState: 'NotFound',
    destinationQueueId: process.env.LOOM_DIRECT_LAKE_SHIM_QUEUE_ID || undefined,
  };
  try {
    const t = await arm<any>(`${base}?api-version=${EG_API}`);
    out.topicState = t?.properties?.provisioningState || 'Succeeded';
  } catch (e) {
    if (e instanceof EventGridError && e.status === 404) return out;
    throw e;
  }
  try {
    const s = await arm<any>(`${base}/eventSubscriptions/loom-dl-shim-delta-log?api-version=${EG_API}`);
    out.subscriptionState = s?.properties?.provisioningState || 'Succeeded';
  } catch (e) {
    if (!(e instanceof EventGridError && e.status === 404)) throw e;
  }
  return out;
}

/**
 * Ensure the Event Grid system topic + delta-log Service Bus subscription exist
 * for a storage account, so the shim receives `_delta_log` BlobCreated events.
 * Idempotent (ARM PUT). Requires LOOM_DIRECT_LAKE_SHIM_QUEUE_ID (the Service
 * Bus queue ARM resource id the shim consumes) — when unset, throws a typed
 * 400 the route surfaces as an honest gate. Returns the resulting status.
 */
export async function ensureShimSubscription(
  account: string,
  opts?: { subscriptionId?: string; resourceGroup?: string; location?: string; queueResourceId?: string },
): Promise<ShimSubscriptionStatus> {
  const sub = opts?.subscriptionId || process.env.LOOM_SUBSCRIPTION_ID;
  const rg = opts?.resourceGroup || process.env.LOOM_DLZ_RG;
  const location = opts?.location || process.env.LOOM_LOCATION || 'eastus2';
  const queueId = opts?.queueResourceId || process.env.LOOM_DIRECT_LAKE_SHIM_QUEUE_ID;
  if (!sub || !rg) throw new EventGridError('LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG required', 400);
  if (!queueId) {
    throw new EventGridError(
      'LOOM_DIRECT_LAKE_SHIM_QUEUE_ID is not set — cannot create the Event Grid → Service Bus subscription. ' +
        'Deploy the Direct-Lake-shim Service Bus queue (aas.bicep) and set this to its ARM resource id.',
      400,
    );
  }
  const topic = systemTopicName(account);
  const base = `${armBase()}/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.EventGrid/systemTopics/${topic}`;

  // 1. System topic on the storage account (Microsoft.Storage.StorageAccounts).
  await arm<any>(`${base}?api-version=${EG_API}`, {
    method: 'PUT',
    body: JSON.stringify({
      location,
      properties: {
        source: storageAccountId(sub, rg, account),
        topicType: 'Microsoft.Storage.StorageAccounts',
      },
    }),
  });

  // 2. Subscription → Service Bus queue, filtered to Delta commit JSON files.
  //    The shim's regex (`_delta_log/<n>.json`) does the precise match; we
  //    pre-filter to BlobCreated + ".json" to cut noise.
  await arm<any>(`${base}/eventSubscriptions/loom-dl-shim-delta-log?api-version=${EG_API}`, {
    method: 'PUT',
    body: JSON.stringify({
      properties: {
        eventDeliverySchema: 'EventGridSchema',
        destination: {
          endpointType: 'ServiceBusQueue',
          properties: { resourceId: queueId },
        },
        filter: {
          includedEventTypes: ['Microsoft.Storage.BlobCreated'],
          subjectEndsWith: '.json',
          isSubjectCaseSensitive: false,
        },
        retryPolicy: { maxDeliveryAttempts: 10, eventTimeToLiveInMinutes: 60 },
      },
    }),
  });

  return getShimSubscriptionStatus(account, { subscriptionId: sub, resourceGroup: rg });
}
