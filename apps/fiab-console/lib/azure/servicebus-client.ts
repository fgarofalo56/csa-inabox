/**
 * Thin Azure Service Bus control-plane client.
 *
 * Backs the `service-bus-namespace` item: a navigator over the deployment-pinned
 * Service Bus namespace (Microsoft.ServiceBus/namespaces). Reuses the shared,
 * sovereign-cloud-aware ARM fetcher in arm-client.ts (armGet/armPut) so it does
 * not re-implement token acquisition. Real ARM REST — no mocks.
 *
 * Config (honest gate, no defaults invented):
 *   LOOM_SERVICEBUS_NAMESPACE                       — the namespace name (required)
 *   LOOM_SERVICEBUS_SUB | LOOM_SUBSCRIPTION_ID      — subscription id
 *   LOOM_SERVICEBUS_RG  | LOOM_DLZ_RG               — resource group
 *
 * The Console UAMI must hold Contributor on the namespace (or its RG) — a 403
 * surfaces verbatim so the editor shows an honest remediation gate. No Microsoft
 * Fabric dependency: this is a first-class Azure resource (no-fabric-dependency.md).
 *
 * Docs: https://learn.microsoft.com/rest/api/servicebus/
 */

import { armGet, armPut, armDelete } from './arm-client';

// Control-plane api-version with queues/topics CRUD + namespace properties.
const SB_API = '2021-11-01';

export interface ServiceBusConfig {
  subscriptionId: string;
  resourceGroup: string;
  namespace: string;
}

export function servicebusConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_SERVICEBUS_NAMESPACE) return { missing: 'LOOM_SERVICEBUS_NAMESPACE' };
  if (!(process.env.LOOM_SERVICEBUS_SUB || process.env.LOOM_SUBSCRIPTION_ID)) {
    return { missing: 'LOOM_SERVICEBUS_SUB (or LOOM_SUBSCRIPTION_ID)' };
  }
  if (!(process.env.LOOM_SERVICEBUS_RG || process.env.LOOM_DLZ_RG)) {
    return { missing: 'LOOM_SERVICEBUS_RG (or LOOM_DLZ_RG)' };
  }
  return null;
}

export function readServiceBusConfig(): ServiceBusConfig {
  const subscriptionId = process.env.LOOM_SERVICEBUS_SUB || process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup = process.env.LOOM_SERVICEBUS_RG || process.env.LOOM_DLZ_RG || '';
  const namespace = process.env.LOOM_SERVICEBUS_NAMESPACE || '';
  if (!subscriptionId || !resourceGroup || !namespace) {
    throw new Error('Service Bus namespace not configured');
  }
  return { subscriptionId, resourceGroup, namespace };
}

function nsPath(cfg: ServiceBusConfig): string {
  return `/subscriptions/${cfg.subscriptionId}/resourceGroups/${encodeURIComponent(cfg.resourceGroup)}/providers/Microsoft.ServiceBus/namespaces/${encodeURIComponent(cfg.namespace)}`;
}

export interface NamespaceProperties {
  name: string;
  location?: string;
  sku?: string;
  tier?: string;
  status?: string;
  provisioningState?: string;
  endpoint?: string;
  disableLocalAuth?: boolean;
  minimumTlsVersion?: string;
}

export async function getNamespaceProperties(): Promise<NamespaceProperties> {
  const cfg = readServiceBusConfig();
  const raw = await armGet<any>(`${nsPath(cfg)}?api-version=${SB_API}`);
  return {
    name: raw?.name,
    location: raw?.location,
    sku: raw?.sku?.name,
    tier: raw?.sku?.tier,
    status: raw?.properties?.status,
    provisioningState: raw?.properties?.provisioningState,
    endpoint: raw?.properties?.serviceBusEndpoint,
    disableLocalAuth: raw?.properties?.disableLocalAuth,
    minimumTlsVersion: raw?.properties?.minimumTlsVersion,
  };
}

export interface QueueEntity {
  name: string;
  status?: string;
  maxSizeInMegabytes?: number;
  lockDuration?: string;
  messageCount?: number;
  requiresSession?: boolean;
}

function shapeQueue(raw: any): QueueEntity {
  return {
    name: raw?.name,
    status: raw?.properties?.status,
    maxSizeInMegabytes: raw?.properties?.maxSizeInMegabytes,
    lockDuration: raw?.properties?.lockDuration,
    messageCount: raw?.properties?.messageCount,
    requiresSession: raw?.properties?.requiresSession,
  };
}

export async function listQueues(): Promise<QueueEntity[]> {
  const cfg = readServiceBusConfig();
  const body = await armGet<any>(`${nsPath(cfg)}/queues?api-version=${SB_API}`);
  return Array.isArray(body?.value) ? body.value.map(shapeQueue) : [];
}

export interface CreateQueueSpec {
  name: string;
  maxSizeInMegabytes?: number;
  requiresSession?: boolean;
}

export async function createQueue(spec: CreateQueueSpec): Promise<QueueEntity> {
  const cfg = readServiceBusConfig();
  const raw = await armPut<any>(`${nsPath(cfg)}/queues/${encodeURIComponent(spec.name)}?api-version=${SB_API}`, {
    properties: {
      maxSizeInMegabytes: spec.maxSizeInMegabytes ?? 1024,
      requiresSession: !!spec.requiresSession,
    },
  });
  return shapeQueue(raw);
}

export async function deleteQueue(name: string): Promise<void> {
  const cfg = readServiceBusConfig();
  await armDelete(`${nsPath(cfg)}/queues/${encodeURIComponent(name)}?api-version=${SB_API}`);
}

export interface TopicEntity {
  name: string;
  status?: string;
  maxSizeInMegabytes?: number;
  subscriptionCount?: number;
}

function shapeTopic(raw: any): TopicEntity {
  return {
    name: raw?.name,
    status: raw?.properties?.status,
    maxSizeInMegabytes: raw?.properties?.maxSizeInMegabytes,
    subscriptionCount: raw?.properties?.subscriptionCount,
  };
}

export async function listTopics(): Promise<TopicEntity[]> {
  const cfg = readServiceBusConfig();
  const body = await armGet<any>(`${nsPath(cfg)}/topics?api-version=${SB_API}`);
  return Array.isArray(body?.value) ? body.value.map(shapeTopic) : [];
}

export interface CreateTopicSpec {
  name: string;
  maxSizeInMegabytes?: number;
}

export async function createTopic(spec: CreateTopicSpec): Promise<TopicEntity> {
  const cfg = readServiceBusConfig();
  const raw = await armPut<any>(`${nsPath(cfg)}/topics/${encodeURIComponent(spec.name)}?api-version=${SB_API}`, {
    properties: { maxSizeInMegabytes: spec.maxSizeInMegabytes ?? 1024 },
  });
  return shapeTopic(raw);
}

export async function deleteTopic(name: string): Promise<void> {
  const cfg = readServiceBusConfig();
  await armDelete(`${nsPath(cfg)}/topics/${encodeURIComponent(name)}?api-version=${SB_API}`);
}
