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
import { armBase, armScope } from './cloud-endpoints';

const ARM_SCOPE = armScope();
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
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${encodeURIComponent(cfg.resourceGroup)}/providers/Microsoft.EventHub/namespaces/${encodeURIComponent(cfg.namespace)}`;
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

/**
 * Read the namespace's top-level properties. Used to detect `disableLocalAuth`
 * so the source-node wizard knows whether SAS connection strings can actually
 * authenticate (they cannot when the namespace deploys with the secure-default
 * `disableLocalAuth: true`).
 */
export interface NamespaceProperties {
  disableLocalAuth: boolean;
  kafkaEnabled: boolean;
  publicNetworkAccess?: string;
}

export async function getNamespaceProperties(): Promise<NamespaceProperties> {
  const cfg = readEventHubsConfig();
  const r = await callArm(`${nsUrl(cfg)}?api-version=${EH_API}`);
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `getNamespace failed ${r.status}`);
  const body: any = await r.json();
  const p = body?.properties || {};
  return {
    disableLocalAuth: p.disableLocalAuth === true,
    kafkaEnabled: p.kafkaEnabled !== false,
    publicNetworkAccess: p.publicNetworkAccess,
  };
}

/**
 * Create (idempotent PUT) a per-event-hub SAS authorization rule. Defaults to
 * Send-only rights — exactly what a custom-app producer needs and nothing more.
 * On a `disableLocalAuth: true` namespace the rule is still created, but its
 * keys cannot authenticate; callers should gate the connection string via
 * {@link listEventHubKeys}'s `localAuthDisabled` flag.
 */
export async function createEventHubAuthRule(
  eventHub: string,
  ruleName: string,
  rights: Array<'Send' | 'Listen' | 'Manage'> = ['Send'],
): Promise<AuthorizationRule> {
  const cfg = readEventHubsConfig();
  const r = await callArm(
    `${nsUrl(cfg)}/eventhubs/${encodeURIComponent(eventHub)}/authorizationRules/${encodeURIComponent(ruleName.trim())}?api-version=${EH_API}`,
    { method: 'PUT', body: JSON.stringify({ properties: { rights } }) },
  );
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `createEventHubAuthRule failed ${r.status}`);
  const a: any = await r.json();
  return { name: a?.name, rights: a?.properties?.rights || rights, scope: eventHub };
}

/** SAS access keys + connection strings returned by the listKeys ARM action. */
export interface EventHubAccessKeys {
  keyName?: string;
  primaryKey?: string;
  secondaryKey?: string;
  primaryConnectionString?: string;
  secondaryConnectionString?: string;
  /**
   * True when the namespace sets `disableLocalAuth: true`. ARM still returns
   * key values, but they CANNOT authenticate — the connection strings are
   * therefore suppressed (set to undefined) and Entra auth must be used instead.
   */
  localAuthDisabled: boolean;
}

/**
 * List the SAS keys for a per-event-hub authorization rule (POST listKeys).
 * When the namespace has local auth disabled the connection strings are
 * suppressed and `localAuthDisabled: true` is set so the BFF/wizard surface the
 * honest "use Entra / HTTPS REST" path rather than a non-working SAS string.
 */
export async function listEventHubKeys(eventHub: string, ruleName: string): Promise<EventHubAccessKeys> {
  const cfg = readEventHubsConfig();
  const r = await callArm(
    `${nsUrl(cfg)}/eventhubs/${encodeURIComponent(eventHub)}/authorizationRules/${encodeURIComponent(ruleName)}/listKeys?api-version=${EH_API}`,
    { method: 'POST' },
  );
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `listEventHubKeys failed ${r.status}`);
  const k: any = await r.json();
  // Detect the secure-default posture; on failure assume disabled (fail safe).
  let localAuthDisabled = true;
  try { localAuthDisabled = (await getNamespaceProperties()).disableLocalAuth; }
  catch { localAuthDisabled = true; }
  return {
    keyName: k?.keyName,
    primaryKey: localAuthDisabled ? undefined : k?.primaryKey,
    secondaryKey: localAuthDisabled ? undefined : k?.secondaryKey,
    primaryConnectionString: localAuthDisabled ? undefined : k?.primaryConnectionString,
    secondaryConnectionString: localAuthDisabled ? undefined : k?.secondaryConnectionString,
    localAuthDisabled,
  };
}

// ============================================================
// Namespace SAS keys (privileged). POST …/authorizationRules/{rule}/listKeys
// returns the SAS connection string + key for the rule. Used to wire a Stream
// Analytics input/output that authenticates to the namespace by connection
// string. Requires the UAMI to hold Contributor (or Data Owner) on the
// namespace — already granted via eventhubs.bicep consolePrincipalId grants.
// ============================================================
export interface NamespaceKeys {
  primaryConnectionString: string;
  secondaryConnectionString: string;
  primaryKey: string;
  secondaryKey: string;
  keyName: string;
}

export async function listNamespaceKeys(
  ruleName = 'RootManageSharedAccessKey',
): Promise<NamespaceKeys> {
  const cfg = readEventHubsConfig();
  const r = await callArm(
    `${nsUrl(cfg)}/authorizationRules/${encodeURIComponent(ruleName)}/listKeys?api-version=${EH_API}`,
    { method: 'POST', body: '{}' },
  );
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `listNamespaceKeys failed ${r.status}`);
  const j: any = await r.json();
  return {
    primaryConnectionString: j?.primaryConnectionString ?? '',
    secondaryConnectionString: j?.secondaryConnectionString ?? '',
    primaryKey: j?.primaryKey ?? '',
    secondaryKey: j?.secondaryKey ?? '',
    keyName: j?.keyName ?? ruleName,
  };
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

// ============================================================
// Cross-subscription stream discovery via Azure Resource Graph (2022-10-01)
//
// POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01
//   body { subscriptions: [...], query: "<KQL>", options: { $skipToken } }
// Docs: https://learn.microsoft.com/azure/governance/resource-graph/first-query-rest-api
//       https://learn.microsoft.com/azure/governance/resource-graph/concepts/paging-results
//
// Used by GET /api/rti-hub to enumerate ALL Event Hub namespaces, IoT Hubs,
// and ADX (Kusto) clusters across the configured subscriptions without
// knowing every resource group name. Pagination follows the `$skipToken`
// returned at the TOP LEVEL of the response — the continuation token is sent
// back in the request body's `options.$skipToken` (NOT a URL query param).
//
// RBAC: The Console UAMI needs at least "Reader" at the SUBSCRIPTION scope
// for each subscription queried. The existing EH "Contributor" grant is
// resource-group-scoped and is NOT sufficient for cross-RG Resource Graph
// queries. The subscription-scoped Reader is granted in
// platform/fiab/bicep/modules/admin-plane/scaling-rbac.bicep.
//
// Sovereign cloud: the ARM/Resource Graph endpoint defaults to Commercial.
// Override per cloud with LOOM_ARG_URL (the full …/Microsoft.ResourceGraph/
// resources URL) and LOOM_ARM_SCOPE (the matching ARM token scope):
//   GCC      LOOM_ARG_URL=https://management.usgovcloudapi.net/providers/Microsoft.ResourceGraph/resources
//            LOOM_ARM_SCOPE=https://management.usgovcloudapi.net/.default
//   GCC-High/IL5
//            LOOM_ARG_URL=https://management.azure.us/providers/Microsoft.ResourceGraph/resources
//            LOOM_ARM_SCOPE=https://management.azure.us/.default
// The credential chain (UAMI + DefaultAzureCredential) works identically in
// sovereign clouds when configured with the correct tenant/environment.
// ============================================================

const ARG_API = '2022-10-01';
const ARG_URL = process.env.LOOM_ARG_URL
  || 'https://management.azure.com/providers/Microsoft.ResourceGraph/resources';
const ARG_SCOPE = process.env.LOOM_ARM_SCOPE || ARM_SCOPE;

export type RtiStreamKind = 'eventhub-namespace' | 'iothub' | 'adx-cluster';

export interface RtiStreamResource {
  id: string;
  name: string;
  /** Normalized resource type slug for the RTI Hub catalog tabs. */
  resourceKind: RtiStreamKind;
  location: string;
  resourceGroup: string;
  subscriptionId: string;
  properties?: Record<string, unknown>;
}

/**
 * Resolve the set of subscriptions the RTI Hub should query. The primary
 * subscription is LOOM_SUBSCRIPTION_ID (or LOOM_EVENTHUB_SUB / LOOM_KUSTO_SUB
 * as fallbacks); additional subscriptions can be added via
 * LOOM_EXTRA_SUBSCRIPTIONS (comma-separated). De-duplicated, order preserved.
 */
export function rtiSubscriptionScope(): string[] {
  const primary = process.env.LOOM_SUBSCRIPTION_ID
    || process.env.LOOM_EVENTHUB_SUB
    || process.env.LOOM_KUSTO_SUB
    || '';
  const extra = (process.env.LOOM_EXTRA_SUBSCRIPTIONS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const all = [primary, ...extra].filter(Boolean);
  return Array.from(new Set(all));
}

/**
 * Query Azure Resource Graph for every Event Hub namespace, IoT Hub, and ADX
 * (Kusto) cluster the Console UAMI can see across the given subscriptions.
 *
 * Returns [] (not an error) when `subscriptions` is empty so the route can
 * surface an honest MessageBar gate instead of a 5xx. Throws
 * EventHubsArmError on a real ARM failure (auth / throttling) so the route can
 * record it in `warnings[]` and still return partial data.
 */
export async function listStreamingResourcesViaGraph(
  subscriptions: string[],
): Promise<RtiStreamResource[]> {
  if (!subscriptions.length) return [];
  const t = await credential.getToken(ARG_SCOPE);
  if (!t?.token) throw new EventHubsArmError(401, undefined, 'Failed to acquire ARM token for Resource Graph');
  const kql = [
    'Resources',
    "| where type in~ ('microsoft.eventhub/namespaces','microsoft.devices/iothubs','microsoft.kusto/clusters')",
    '| project id, name, type, location, resourceGroup, subscriptionId, properties',
    '| order by type asc, name asc',
  ].join('\n');
  const out: RtiStreamResource[] = [];
  let skipToken: string | undefined;
  let guard = 0;
  do {
    guard++;
    const body: Record<string, unknown> = { subscriptions, query: kql };
    if (skipToken) body.options = { $skipToken: skipToken };
    const r = await fetch(`${ARG_URL}?api-version=${ARG_API}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `Resource Graph query failed ${r.status}`);
    const j: any = await r.json();
    const rows: any[] = Array.isArray(j?.data) ? j.data : (Array.isArray(j?.data?.rows) ? j.data.rows : []);
    for (const row of rows) {
      const rawType = String(row?.type || '').toLowerCase();
      let resourceKind: RtiStreamKind;
      if (rawType === 'microsoft.eventhub/namespaces') resourceKind = 'eventhub-namespace';
      else if (rawType === 'microsoft.devices/iothubs') resourceKind = 'iothub';
      else if (rawType === 'microsoft.kusto/clusters') resourceKind = 'adx-cluster';
      else continue;
      out.push({
        id: row.id, name: row.name, resourceKind,
        location: row.location, resourceGroup: row.resourceGroup,
        subscriptionId: row.subscriptionId,
        properties: (row.properties && typeof row.properties === 'object') ? row.properties : undefined,
      });
    }
    skipToken = j?.$skipToken ?? j?.['$skipToken'];
  } while (skipToken && guard < 20);
  return out;
}
