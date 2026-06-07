/**
 * Azure Event Hubs namespace — ARM management-plane client.
 *
 * Backs the Event Hubs namespace navigator hosted in the Eventstream editor's
 * left pane (the Azure service that feeds Fabric Eventstreams). Once the
 * namespace is known (env-pinned LOOM_EVENTHUB_NAMESPACE + LOOM_SUBSCRIPTION_ID
 * + resource group), the pane becomes a typed navigator over the real
 * Microsoft.EventHub/namespaces/{ns} ARM surface:
 *
 *   - Event hubs (entities)        GET/PUT/DELETE …/eventhubs[/{eh}]
 *   - Consumer groups (per hub)    GET/PUT/DELETE …/eventhubs/{eh}/consumergroups[/{cg}]
 *   - Schema groups                GET/PUT/DELETE …/schemagroups[/{sg}]
 *   - Authorization rules (read)   GET …/authorizationRules  +  …/eventhubs/{eh}/authorizationRules
 *   - Network rule set (read)      GET …/networkRuleSets/default
 *   - Geo-DR configs (read)        GET …/disasterRecoveryConfigs
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
 * DefaultAzureCredential) against the ARM scope. The Loom UAMI must hold
 * "Azure Event Hubs Data Owner" (data plane) and "Contributor" (control plane)
 * on the namespace to create/delete entities.
 *
 * No mocks. Real ARM REST only. When the namespace env is unset the routes 503
 * via eventhubsConfigGate() and the navigator shows a single honest infra-gate.
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

// Cloud-aware ARM base. Commercial → management.azure.com (default); Gov
// (GCC-High / IL5) sets LOOM_ARM_ENDPOINT=https://management.usgovcloudapi.net
// via bicep. Mirrors adf-client / azure-sql-client / setup routes.
const ARM_BASE = (process.env.LOOM_ARM_ENDPOINT || 'https://management.azure.com').replace(/\/+$/, '');
const ARM_SCOPE = `${ARM_BASE}/.default`;
// Stable GA api-version covering eventhubs, consumergroups, schemagroups,
// authorizationRules, networkRuleSets, disasterRecoveryConfigs.
const EH_API = '2024-01-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class EventHubsArmError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Event Hubs ARM call failed (${status})`);
    this.name = 'EventHubsArmError';
    this.status = status;
    this.body = body;
  }
}

export interface EventHubsConfig {
  subscriptionId: string;
  resourceGroup: string;
  namespace: string;
}

/**
 * Honest config gate. Returns the exact missing env var so each BFF route can
 * 503 with a precise MessageBar (`code: 'not_configured'`) instead of a generic
 * 500. Returns null when the namespace + subscription + RG are all set.
 * Mirrors databricksConfigGate / readKustoArmConfig.
 */
export function eventhubsConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_EVENTHUB_NAMESPACE) return { missing: 'LOOM_EVENTHUB_NAMESPACE' };
  if (!(process.env.LOOM_EVENTHUB_SUB || process.env.LOOM_SUBSCRIPTION_ID)) {
    return { missing: 'LOOM_EVENTHUB_SUB (or LOOM_SUBSCRIPTION_ID)' };
  }
  if (!(process.env.LOOM_EVENTHUB_RG || process.env.LOOM_DLZ_RG)) {
    return { missing: 'LOOM_EVENTHUB_RG (or LOOM_DLZ_RG)' };
  }
  return null;
}

export function readEventHubsConfig(): EventHubsConfig {
  const subscriptionId = process.env.LOOM_EVENTHUB_SUB || process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup = process.env.LOOM_EVENTHUB_RG || process.env.LOOM_DLZ_RG || '';
  const namespace = process.env.LOOM_EVENTHUB_NAMESPACE || '';
  if (!subscriptionId || !resourceGroup || !namespace) {
    throw new EventHubsArmError(503, undefined, 'Event Hubs namespace not configured');
  }
  return { subscriptionId, resourceGroup, namespace };
}

function nsUrl(cfg: EventHubsConfig): string {
  return `${ARM_BASE}/subscriptions/${cfg.subscriptionId}/resourceGroups/${encodeURIComponent(cfg.resourceGroup)}/providers/Microsoft.EventHub/namespaces/${encodeURIComponent(cfg.namespace)}`;
}

async function callArm(url: string, init?: RequestInit): Promise<Response> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new EventHubsArmError(401, undefined, 'Failed to acquire ARM token');
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${t.token}`,
      'content-type': 'application/json',
    },
  });
}

/** GET a paged ARM list, walking `nextLink` so counts are real. */
async function armList<T = any>(url: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next) {
    const r: Response = await callArm(next);
    if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `list failed ${r.status}`);
    const body: any = await r.json();
    if (Array.isArray(body?.value)) out.push(...body.value);
    next = body?.nextLink;
  }
  return out;
}

// ============================================================
// Event hubs (entities)
// ============================================================
export interface EventHubEntity {
  name: string;
  partitionCount?: number;
  messageRetentionInDays?: number;
  status?: string;
  partitionIds?: string[];
  createdAt?: string;
  captureEnabled?: boolean;
}

function shapeEventHub(raw: any): EventHubEntity {
  const p = raw?.properties || {};
  // Newer namespaces report retention via retentionDescription (hours);
  // older/standard ones via messageRetentionInDays. Normalize to days.
  let retentionDays: number | undefined = p.messageRetentionInDays;
  const hours = p.retentionDescription?.retentionTimeInHours;
  if (retentionDays == null && typeof hours === 'number') {
    retentionDays = Math.max(1, Math.round(hours / 24));
  }
  return {
    name: raw?.name,
    partitionCount: p.partitionCount,
    messageRetentionInDays: retentionDays,
    status: p.status,
    partitionIds: p.partitionIds,
    createdAt: p.createdAt,
    captureEnabled: !!p.captureDescription?.enabled,
  };
}

export async function listEventHubs(): Promise<EventHubEntity[]> {
  const cfg = readEventHubsConfig();
  const raw = await armList(`${nsUrl(cfg)}/eventhubs?api-version=${EH_API}`);
  return raw.map(shapeEventHub);
}

export interface CreateEventHubSpec {
  name: string;
  partitionCount?: number;        // 1–32 (standard); higher on premium/dedicated
  messageRetentionInDays?: number; // 1–7 (standard)
}

export async function createEventHub(spec: CreateEventHubSpec): Promise<EventHubEntity> {
  const cfg = readEventHubsConfig();
  const name = spec.name.trim();
  const properties: Record<string, unknown> = {
    partitionCount: spec.partitionCount ?? 2,
    messageRetentionInDays: spec.messageRetentionInDays ?? 1,
  };
  const r = await callArm(
    `${nsUrl(cfg)}/eventhubs/${encodeURIComponent(name)}?api-version=${EH_API}`,
    { method: 'PUT', body: JSON.stringify({ properties }) },
  );
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `createEventHub failed ${r.status}`);
  return shapeEventHub(await r.json());
}

export async function deleteEventHub(name: string): Promise<void> {
  const cfg = readEventHubsConfig();
  const r = await callArm(
    `${nsUrl(cfg)}/eventhubs/${encodeURIComponent(name)}?api-version=${EH_API}`,
    { method: 'DELETE' },
  );
  if (!r.ok && r.status !== 204) {
    throw new EventHubsArmError(r.status, await r.text(), `deleteEventHub failed ${r.status}`);
  }
}

// ============================================================
// Consumer groups (per event hub)
// ============================================================
export interface ConsumerGroup {
  name: string;
  eventHub: string;
  userMetadata?: string;
  createdAt?: string;
}

export async function listConsumerGroups(eventHub: string): Promise<ConsumerGroup[]> {
  const cfg = readEventHubsConfig();
  const raw = await armList(
    `${nsUrl(cfg)}/eventhubs/${encodeURIComponent(eventHub)}/consumergroups?api-version=${EH_API}`,
  );
  return raw.map((c: any) => ({
    name: c?.name,
    eventHub,
    userMetadata: c?.properties?.userMetadata,
    createdAt: c?.properties?.createdAt,
  }));
}

export async function createConsumerGroup(
  eventHub: string,
  name: string,
  userMetadata?: string,
): Promise<ConsumerGroup> {
  const cfg = readEventHubsConfig();
  const properties: Record<string, unknown> = {};
  if (userMetadata) properties.userMetadata = userMetadata;
  const r = await callArm(
    `${nsUrl(cfg)}/eventhubs/${encodeURIComponent(eventHub)}/consumergroups/${encodeURIComponent(name.trim())}?api-version=${EH_API}`,
    { method: 'PUT', body: JSON.stringify({ properties }) },
  );
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `createConsumerGroup failed ${r.status}`);
  const c: any = await r.json();
  return { name: c?.name, eventHub, userMetadata: c?.properties?.userMetadata, createdAt: c?.properties?.createdAt };
}

export async function deleteConsumerGroup(eventHub: string, name: string): Promise<void> {
  const cfg = readEventHubsConfig();
  // The default "$Default" consumer group cannot be deleted; ARM returns 400.
  const r = await callArm(
    `${nsUrl(cfg)}/eventhubs/${encodeURIComponent(eventHub)}/consumergroups/${encodeURIComponent(name)}?api-version=${EH_API}`,
    { method: 'DELETE' },
  );
  if (!r.ok && r.status !== 204) {
    throw new EventHubsArmError(r.status, await r.text(), `deleteConsumerGroup failed ${r.status}`);
  }
}

// ============================================================
// Schema groups (namespace-level schema registry)
// ============================================================
export interface SchemaGroup {
  name: string;
  schemaType?: string;        // Avro | Json | Unknown
  schemaCompatibility?: string; // None | Backward | Forward
  createdAtUtc?: string;
}

export async function listSchemaGroups(): Promise<SchemaGroup[]> {
  const cfg = readEventHubsConfig();
  const raw = await armList(`${nsUrl(cfg)}/schemagroups?api-version=${EH_API}`);
  return raw.map((g: any) => ({
    name: g?.name,
    schemaType: g?.properties?.schemaType,
    schemaCompatibility: g?.properties?.schemaCompatibility,
    createdAtUtc: g?.properties?.createdAtUtc,
  }));
}

export interface CreateSchemaGroupSpec {
  name: string;
  schemaType?: 'Avro' | 'Json';
  schemaCompatibility?: 'None' | 'Backward' | 'Forward';
}

export async function createSchemaGroup(spec: CreateSchemaGroupSpec): Promise<SchemaGroup> {
  const cfg = readEventHubsConfig();
  const properties: Record<string, unknown> = {
    schemaType: spec.schemaType ?? 'Avro',
    schemaCompatibility: spec.schemaCompatibility ?? 'None',
  };
  const r = await callArm(
    `${nsUrl(cfg)}/schemagroups/${encodeURIComponent(spec.name.trim())}?api-version=${EH_API}`,
    { method: 'PUT', body: JSON.stringify({ properties }) },
  );
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `createSchemaGroup failed ${r.status}`);
  const g: any = await r.json();
  return {
    name: g?.name,
    schemaType: g?.properties?.schemaType,
    schemaCompatibility: g?.properties?.schemaCompatibility,
    createdAtUtc: g?.properties?.createdAtUtc,
  };
}

export async function deleteSchemaGroup(name: string): Promise<void> {
  const cfg = readEventHubsConfig();
  const r = await callArm(
    `${nsUrl(cfg)}/schemagroups/${encodeURIComponent(name)}?api-version=${EH_API}`,
    { method: 'DELETE' },
  );
  if (!r.ok && r.status !== 204) {
    throw new EventHubsArmError(r.status, await r.text(), `deleteSchemaGroup failed ${r.status}`);
  }
}

// ============================================================
// Authorization rules (read-only — SAS policies). Namespace-level plus,
// optionally, per-event-hub. Keys are NOT returned here (listKeys is a
// separate privileged action surfaced behind a copy affordance later).
// ============================================================
export interface AuthorizationRule {
  name: string;
  rights: string[];       // Listen | Send | Manage
  scope: 'namespace' | string; // 'namespace' or the parent event hub name
}

export async function listNamespaceAuthRules(): Promise<AuthorizationRule[]> {
  const cfg = readEventHubsConfig();
  const raw = await armList(`${nsUrl(cfg)}/authorizationRules?api-version=${EH_API}`);
  return raw.map((a: any) => ({
    name: a?.name,
    rights: a?.properties?.rights || [],
    scope: 'namespace' as const,
  }));
}

export async function listEventHubAuthRules(eventHub: string): Promise<AuthorizationRule[]> {
  const cfg = readEventHubsConfig();
  const raw = await armList(
    `${nsUrl(cfg)}/eventhubs/${encodeURIComponent(eventHub)}/authorizationRules?api-version=${EH_API}`,
  );
  return raw.map((a: any) => ({
    name: a?.name,
    rights: a?.properties?.rights || [],
    scope: eventHub,
  }));
}

// ============================================================
// Network rule set (read-only) — default IP / VNet firewall on the namespace.
// ============================================================
export interface NetworkRuleSet {
  defaultAction?: string;       // Allow | Deny
  publicNetworkAccess?: string; // Enabled | Disabled | SecuredByPerimeter
  ipRuleCount: number;
  vnetRuleCount: number;
  trustedServiceAccessEnabled?: boolean;
}

export async function getNetworkRuleSet(): Promise<NetworkRuleSet> {
  const cfg = readEventHubsConfig();
  const r = await callArm(`${nsUrl(cfg)}/networkRuleSets/default?api-version=${EH_API}`);
  // A namespace with no firewall configured returns 404 — treat as "Allow all".
  if (r.status === 404) {
    return { defaultAction: 'Allow', publicNetworkAccess: 'Enabled', ipRuleCount: 0, vnetRuleCount: 0 };
  }
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `getNetworkRuleSet failed ${r.status}`);
  const body: any = await r.json();
  const p = body?.properties || {};
  return {
    defaultAction: p.defaultAction,
    publicNetworkAccess: p.publicNetworkAccess,
    ipRuleCount: Array.isArray(p.ipRules) ? p.ipRules.length : 0,
    vnetRuleCount: Array.isArray(p.virtualNetworkRules) ? p.virtualNetworkRules.length : 0,
    trustedServiceAccessEnabled: p.trustedServiceAccessEnabled,
  };
}

// ============================================================
// Geo-disaster-recovery configs (read-only).
// ============================================================
export interface DisasterRecoveryConfig {
  name: string;
  role?: string;                 // Primary | Secondary | PrimaryNotReplicating
  partnerNamespace?: string;
  provisioningState?: string;
}

export async function listDisasterRecoveryConfigs(): Promise<DisasterRecoveryConfig[]> {
  const cfg = readEventHubsConfig();
  const raw = await armList(`${nsUrl(cfg)}/disasterRecoveryConfigs?api-version=${EH_API}`);
  return raw.map((d: any) => ({
    name: d?.name,
    role: d?.properties?.role,
    partnerNamespace: d?.properties?.partnerNamespace,
    provisioningState: d?.properties?.provisioningState,
  }));
}
