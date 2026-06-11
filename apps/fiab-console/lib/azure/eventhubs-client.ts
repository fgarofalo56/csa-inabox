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

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { armBase, armScope, serviceBusSuffix } from './cloud-endpoints';

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
  return fetchWithTimeout(url, {
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

/**
 * List the event hubs of an ARBITRARY namespace (subscription + RG + namespace
 * supplied by the caller). This is what the Real-Time Hub connect dialog uses:
 * it discovers many namespaces cross-subscription via Resource Graph, then lists
 * the hubs of whichever one the user picks — NOT the single env-pinned namespace.
 */
export async function listEventHubsIn(cfg: EventHubsConfig): Promise<EventHubEntity[]> {
  const raw = await armList(`${nsUrl(cfg)}/eventhubs?api-version=${EH_API}`);
  return raw.map(shapeEventHub);
}

export async function listEventHubs(): Promise<EventHubEntity[]> {
  return listEventHubsIn(readEventHubsConfig());
}

export interface CreateEventHubSpec {
  name: string;
  partitionCount?: number;        // 1–32 (standard); higher on premium/dedicated
  messageRetentionInDays?: number; // 1–7 (standard)
}

/** Create an event hub in an arbitrary namespace (PUT). */
export async function createEventHubIn(cfg: EventHubsConfig, spec: CreateEventHubSpec): Promise<EventHubEntity> {
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

export async function createEventHub(spec: CreateEventHubSpec): Promise<EventHubEntity> {
  return createEventHubIn(readEventHubsConfig(), spec);
}

/**
 * Create-if-missing an event hub: returns the existing entity when it already
 * exists, otherwise PUTs it. Backs the connect dialog's "+ Create new…" path so
 * re-selecting an existing name never errors and existing partition/retention
 * settings are preserved rather than reset to defaults.
 */
export async function ensureEventHub(cfg: EventHubsConfig, spec: CreateEventHubSpec): Promise<EventHubEntity> {
  const name = spec.name.trim();
  const probe = await callArm(`${nsUrl(cfg)}/eventhubs/${encodeURIComponent(name)}?api-version=${EH_API}`);
  if (probe.ok) return shapeEventHub(await probe.json());
  if (probe.status !== 404) {
    throw new EventHubsArmError(probe.status, await probe.text(), `ensureEventHub probe failed ${probe.status}`);
  }
  return createEventHubIn(cfg, spec);
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

export async function listConsumerGroupsIn(cfg: EventHubsConfig, eventHub: string): Promise<ConsumerGroup[]> {
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

export async function listConsumerGroups(eventHub: string): Promise<ConsumerGroup[]> {
  return listConsumerGroupsIn(readEventHubsConfig(), eventHub);
}

export async function createConsumerGroupIn(
  cfg: EventHubsConfig,
  eventHub: string,
  name: string,
  userMetadata?: string,
): Promise<ConsumerGroup> {
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

export async function createConsumerGroup(
  eventHub: string,
  name: string,
  userMetadata?: string,
): Promise<ConsumerGroup> {
  return createConsumerGroupIn(readEventHubsConfig(), eventHub, name, userMetadata);
}

/**
 * Create-if-missing a consumer group. The built-in "$Default" group always
 * exists, so it is short-circuited (ARM rejects PUT on it). The consumer-group
 * PUT is idempotent for user groups, so this is a thin wrapper that lets the
 * connect dialog's "+ Create new…" path be safely re-run.
 */
export async function ensureConsumerGroup(
  cfg: EventHubsConfig,
  eventHub: string,
  name: string,
): Promise<ConsumerGroup> {
  const cg = name.trim();
  if (!cg || cg === '$Default') return { name: '$Default', eventHub };
  return createConsumerGroupIn(cfg, eventHub, cg);
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

export async function listNamespaceAuthRulesIn(cfg: EventHubsConfig): Promise<AuthorizationRule[]> {
  const raw = await armList(`${nsUrl(cfg)}/authorizationRules?api-version=${EH_API}`);
  return raw.map((a: any) => ({
    name: a?.name,
    rights: a?.properties?.rights || [],
    scope: 'namespace' as const,
  }));
}

export async function listNamespaceAuthRules(): Promise<AuthorizationRule[]> {
  return listNamespaceAuthRulesIn(readEventHubsConfig());
}

export async function listEventHubAuthRulesIn(cfg: EventHubsConfig, eventHub: string): Promise<AuthorizationRule[]> {
  const raw = await armList(
    `${nsUrl(cfg)}/eventhubs/${encodeURIComponent(eventHub)}/authorizationRules?api-version=${EH_API}`,
  );
  return raw.map((a: any) => ({
    name: a?.name,
    rights: a?.properties?.rights || [],
    scope: eventHub,
  }));
}

export async function listEventHubAuthRules(eventHub: string): Promise<AuthorizationRule[]> {
  return listEventHubAuthRulesIn(readEventHubsConfig(), eventHub);
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

function shapeDrConfig(raw: any): DisasterRecoveryConfig {
  const p = raw?.properties || {};
  return {
    name: raw?.name,
    role: p.role,
    partnerNamespace: p.partnerNamespace,
    provisioningState: p.provisioningState,
  };
}

/**
 * Create (PUT) a Geo-DR alias on the primary namespace, pairing it with a
 * secondary namespace in another region. Only metadata replicates — event data
 * does NOT. Clients connect to the alias FQDN. Both namespaces must be Standard
 * tier or higher in matching/compatible tiers.
 *
 *   PUT .../disasterRecoveryConfigs/{alias}  body {properties:{partnerNamespace}}
 *
 * Docs: https://learn.microsoft.com/rest/api/eventhub/disaster-recovery-configs/create-or-update
 */
export async function createDisasterRecoveryConfig(
  alias: string,
  partnerNamespaceId: string,
): Promise<DisasterRecoveryConfig> {
  const cfg = readEventHubsConfig();
  const a = (alias || '').trim();
  const partner = (partnerNamespaceId || '').trim();
  if (!a) throw new EventHubsArmError(400, undefined, 'alias is required');
  if (!partner) throw new EventHubsArmError(400, undefined, 'partnerNamespaceId is required');
  const r = await callArm(
    `${nsUrl(cfg)}/disasterRecoveryConfigs/${encodeURIComponent(a)}?api-version=${EH_API}`,
    { method: 'PUT', body: JSON.stringify({ properties: { partnerNamespace: partner } }) },
  );
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `createDisasterRecoveryConfig failed ${r.status}`);
  return shapeDrConfig(await r.json());
}

/**
 * Break (DELETE) a Geo-DR pairing alias. The secondary namespace becomes
 * independent again. Accepts 200 or 204.
 *
 *   DELETE .../disasterRecoveryConfigs/{alias}
 */
export async function deleteDisasterRecoveryConfig(alias: string): Promise<void> {
  const cfg = readEventHubsConfig();
  const a = (alias || '').trim();
  if (!a) throw new EventHubsArmError(400, undefined, 'alias is required');
  const r = await callArm(
    `${nsUrl(cfg)}/disasterRecoveryConfigs/${encodeURIComponent(a)}?api-version=${EH_API}`,
    { method: 'DELETE' },
  );
  if (!r.ok && r.status !== 204) {
    throw new EventHubsArmError(r.status, await r.text(), `deleteDisasterRecoveryConfig failed ${r.status}`);
  }
}

/**
 * Initiate a Geo-DR failover (POST .../disasterRecoveryConfigs/{alias}/failover).
 * ONE-WAY, NON-REVERSIBLE: the secondary namespace is promoted to primary, and
 * the original primary is removed from the pairing. Re-pair afterward to restore
 * Geo-DR protection. Must be invoked against the SECONDARY namespace's alias.
 * Accepts 200 or 202.
 *
 * Docs: https://learn.microsoft.com/rest/api/eventhub/disaster-recovery-configs/fail-over
 */
export async function initiateGeoDrFailover(alias: string): Promise<void> {
  const cfg = readEventHubsConfig();
  const a = (alias || '').trim();
  if (!a) throw new EventHubsArmError(400, undefined, 'alias is required');
  const r = await callArm(
    `${nsUrl(cfg)}/disasterRecoveryConfigs/${encodeURIComponent(a)}/failover?api-version=${EH_API}`,
    { method: 'POST', body: '{}' },
  );
  if (!r.ok && r.status !== 202) {
    throw new EventHubsArmError(r.status, await r.text(), `initiateGeoDrFailover failed ${r.status}`);
  }
}

// ============================================================
// Capture configuration (PUT captureDescription on …/eventhubs/{eh}).
//
// Capture archives the event hub's stream to Blob Storage or ADLS Gen2 as Avro
// on a size/time-window basis. Set inline on the event hub resource via the
// standard event-hub PUT. Avro is the only ARM-supported encoding (Parquet
// requires Stream Analytics no-code editor, out of scope here).
//
// Docs: https://learn.microsoft.com/azure/event-hubs/event-hubs-capture-overview
//       https://learn.microsoft.com/rest/api/eventhub/event-hubs/create-or-update
//
// RBAC: the Console UAMI needs "Storage Blob Data Contributor" on the target
// storage account for Capture WRITES to succeed (the ARM PUT itself succeeds
// without it, but Capture then 403s at archive time). Documented in
// eventhubs.bicep.
// ============================================================
export const CAPTURE_DEFAULT_ARCHIVE_NAME_FORMAT =
  '{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}';

export interface CaptureSpec {
  enabled: boolean;
  /** 60–900 seconds (first window edge to win triggers a capture). */
  intervalInSeconds?: number;
  /** 10485760 (10 MB) – 524288000 (500 MB). */
  sizeLimitInBytes?: number;
  /** Storage account ARM resource id (Blob or ADLS Gen2). */
  storageAccountResourceId?: string;
  /** Blob container (or ADLS filesystem) to archive into. */
  blobContainer?: string;
  /** Archive name format — must contain all 9 capture tokens. */
  archiveNameFormat?: string;
  /** Skip writing empty Avro files when no events arrived in the window. */
  skipEmptyArchives?: boolean;
  /** Destination kind. BlockBlob → Blob Storage; DataLake → ADLS Gen2. */
  destination?: 'BlockBlob' | 'DataLake';
}

/** Read the current capture configuration off an event hub (null = disabled). */
export async function getEventHubCapture(eventHub: string): Promise<CaptureSpec | null> {
  const cfg = readEventHubsConfig();
  const r = await callArm(
    `${nsUrl(cfg)}/eventhubs/${encodeURIComponent(eventHub)}?api-version=${EH_API}`,
  );
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `getEventHubCapture failed ${r.status}`);
  const body: any = await r.json();
  const cd = body?.properties?.captureDescription;
  if (!cd) return null;
  const destName: string = cd?.destination?.name || '';
  const dp = cd?.destination?.properties || {};
  return {
    enabled: !!cd.enabled,
    intervalInSeconds: cd.intervalInSeconds,
    sizeLimitInBytes: cd.sizeLimitInBytes,
    skipEmptyArchives: cd.skipEmptyArchives,
    destination: destName.includes('AzureDataLake') ? 'DataLake' : 'BlockBlob',
    storageAccountResourceId: dp.storageAccountResourceId,
    blobContainer: dp.blobContainer,
    archiveNameFormat: dp.archiveNameFormat,
  };
}

/**
 * Enable/disable/update Capture on an event hub by PUTing captureDescription
 * inline on the event-hub resource. When disabling, only `{enabled:false}` is
 * sent. When enabling, the storage account + container are required.
 *
 *   PUT .../eventhubs/{eh}  body {properties:{captureDescription:{…}}}
 */
export async function updateEventHubCapture(
  eventHub: string,
  spec: CaptureSpec,
): Promise<EventHubEntity> {
  const cfg = readEventHubsConfig();
  const eh = (eventHub || '').trim();
  if (!eh) throw new EventHubsArmError(400, undefined, 'eventHub is required');

  let captureDescription: Record<string, unknown>;
  if (!spec.enabled) {
    captureDescription = { enabled: false };
  } else {
    const storageAccountResourceId = (spec.storageAccountResourceId || '').trim();
    const blobContainer = (spec.blobContainer || '').trim();
    if (!storageAccountResourceId) {
      throw new EventHubsArmError(400, undefined, 'storageAccountResourceId is required to enable capture');
    }
    if (!blobContainer) {
      throw new EventHubsArmError(400, undefined, 'blobContainer is required to enable capture');
    }
    const interval = Math.max(60, Math.min(900, spec.intervalInSeconds ?? 300));
    const size = Math.max(10485760, Math.min(524288000, spec.sizeLimitInBytes ?? 314572800));
    const destName = spec.destination === 'DataLake'
      ? 'EventHubArchive.AzureDataLake'
      : 'EventHubArchive.AzureBlockBlob';
    captureDescription = {
      enabled: true,
      encoding: 'Avro',
      intervalInSeconds: interval,
      sizeLimitInBytes: size,
      skipEmptyArchives: spec.skipEmptyArchives ?? false,
      destination: {
        name: destName,
        properties: {
          storageAccountResourceId,
          blobContainer,
          archiveNameFormat: (spec.archiveNameFormat || '').trim() || CAPTURE_DEFAULT_ARCHIVE_NAME_FORMAT,
        },
      },
    };
  }

  const r = await callArm(
    `${nsUrl(cfg)}/eventhubs/${encodeURIComponent(eh)}?api-version=${EH_API}`,
    { method: 'PUT', body: JSON.stringify({ properties: { captureDescription } }) },
  );
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `updateEventHubCapture failed ${r.status}`);
  return shapeEventHub(await r.json());
}

// ============================================================
// SAS key rotation (POST …/authorizationRules/{rule}/regenerateKeys).
//
// Regenerates the primary or secondary key on a SAS policy at namespace scope
// or per-event-hub scope. The response carries the full AccessKeys object (both
// keys + connection strings), so a follow-up listKeys is unnecessary. On a
// disableLocalAuth: true namespace the connection strings cannot authenticate;
// they are suppressed (same posture as listEventHubKeys) and localAuthDisabled
// is flagged so the UI surfaces the honest Entra-only message.
//
// Docs: https://learn.microsoft.com/rest/api/eventhub/event-hubs/regenerate-keys
//       https://learn.microsoft.com/rest/api/eventhub/namespaces/regenerate-keys
// ============================================================
export type RegenerateKeyType = 'PrimaryKey' | 'SecondaryKey';

/** Regenerate a per-event-hub SAS rule's primary/secondary key. */
export async function regenerateEventHubAuthRuleKeys(
  eventHub: string,
  ruleName: string,
  keyType: RegenerateKeyType,
): Promise<EventHubAccessKeys> {
  const cfg = readEventHubsConfig();
  const eh = (eventHub || '').trim();
  const rule = (ruleName || '').trim();
  if (!eh) throw new EventHubsArmError(400, undefined, 'eventHub is required');
  if (!rule) throw new EventHubsArmError(400, undefined, 'ruleName is required');
  const r = await callArm(
    `${nsUrl(cfg)}/eventhubs/${encodeURIComponent(eh)}/authorizationRules/${encodeURIComponent(rule)}/regenerateKeys?api-version=${EH_API}`,
    { method: 'POST', body: JSON.stringify({ keyType }) },
  );
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `regenerateEventHubAuthRuleKeys failed ${r.status}`);
  const k: any = await r.json();
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

/** Regenerate a namespace-scope SAS rule's primary/secondary key. */
export async function regenerateNamespaceAuthRuleKeys(
  ruleName: string,
  keyType: RegenerateKeyType,
): Promise<NamespaceKeys> {
  const cfg = readEventHubsConfig();
  const rule = (ruleName || '').trim() || 'RootManageSharedAccessKey';
  const r = await callArm(
    `${nsUrl(cfg)}/authorizationRules/${encodeURIComponent(rule)}/regenerateKeys?api-version=${EH_API}`,
    { method: 'POST', body: JSON.stringify({ keyType }) },
  );
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `regenerateNamespaceAuthRuleKeys failed ${r.status}`);
  const j: any = await r.json();
  return {
    primaryConnectionString: j?.primaryConnectionString ?? '',
    secondaryConnectionString: j?.secondaryConnectionString ?? '',
    primaryKey: j?.primaryKey ?? '',
    secondaryKey: j?.secondaryKey ?? '',
    keyName: j?.keyName ?? rule,
  };
}

// ============================================================
// Private endpoint connections on the namespace.
//
// Namespace-scoped approve/reject of incoming Private Link connections. The PE
// itself is provisioned by eventhubs.bicep (groupIds: ['namespace'], DNS zone
// privatelink.servicebus.windows.net / .usgovcloudapi.net). This surface
// approves/rejects/removes the connections (e.g. manual or cross-tenant ones).
//
//   GET    .../privateEndpointConnections
//   PUT    .../privateEndpointConnections/{name}  {properties:{privateLinkServiceConnectionState:{status,description}}}
//   DELETE .../privateEndpointConnections/{name}
//
// Docs: https://learn.microsoft.com/rest/api/eventhub/private-endpoint-connections
// ============================================================
export interface NamespacePrivateEndpointConnection {
  name: string;
  privateEndpointId?: string;
  /** Pending | Approved | Rejected | Disconnected */
  connectionStatus: string;
  provisioningState?: string;
  description?: string;
}

function shapePeConnection(raw: any): NamespacePrivateEndpointConnection {
  const p = raw?.properties || {};
  const state = p?.privateLinkServiceConnectionState || {};
  return {
    name: raw?.name,
    privateEndpointId: p?.privateEndpoint?.id,
    connectionStatus: state?.status || 'Unknown',
    provisioningState: p?.provisioningState,
    description: state?.description,
  };
}

export async function listNamespacePrivateEndpointConnections(): Promise<NamespacePrivateEndpointConnection[]> {
  const cfg = readEventHubsConfig();
  const raw = await armList(`${nsUrl(cfg)}/privateEndpointConnections?api-version=${EH_API}`);
  return raw.map(shapePeConnection);
}

async function setPeConnectionState(
  name: string,
  status: 'Approved' | 'Rejected',
  description?: string,
): Promise<NamespacePrivateEndpointConnection> {
  const cfg = readEventHubsConfig();
  const n = (name || '').trim();
  if (!n) throw new EventHubsArmError(400, undefined, 'name is required');
  const body = {
    properties: {
      privateLinkServiceConnectionState: {
        status,
        description: (description || '').trim() || `${status} via Loom console`,
      },
    },
  };
  const r = await callArm(
    `${nsUrl(cfg)}/privateEndpointConnections/${encodeURIComponent(n)}?api-version=${EH_API}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
  if (!r.ok) throw new EventHubsArmError(r.status, await r.text(), `setPeConnectionState(${status}) failed ${r.status}`);
  return shapePeConnection(await r.json());
}

export async function approvePrivateEndpointConnection(
  name: string,
  description?: string,
): Promise<NamespacePrivateEndpointConnection> {
  return setPeConnectionState(name, 'Approved', description);
}

export async function rejectPrivateEndpointConnection(
  name: string,
  description?: string,
): Promise<NamespacePrivateEndpointConnection> {
  return setPeConnectionState(name, 'Rejected', description);
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
  || `${armBase()}/providers/Microsoft.ResourceGraph/resources`;
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
    const r = await fetchWithTimeout(`${ARG_URL}?api-version=${ARG_API}`, {
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

// ============================================================
// Event Hubs Schema Registry — DATA-plane (schema CRUD + server-side
// compatibility enforcement).
//
// Distinct from the ARM schema-GROUP control plane above (which creates the
// group). This is the data plane that registers SCHEMAS into a group and lets
// the service enforce the group's compatibility policy on PUT.
//
//   PUT  https://{ns}.{serviceBusSuffix}/$schemagroups/{group}/schemas/{name}
//        Content-Type: application/json;serialization=Avro  (or Json / Protobuf)
//        body = the raw schema document
//        → 200/201 with Schema-Id + Schema-Version headers; 400 when the new
//          schema violates the group's Backward/Forward compatibility policy.
//
// Token scope: the Event Hubs data-plane resource `https://eventhubs.azure.net`
// (cloud-INVARIANT — same audience in Commercial + USGov, unlike ARM). The
// FQDN varies per cloud via serviceBusSuffix(). The Console UAMI needs
// "Schema Registry Contributor" (read/write/delete) on the namespace.
//
// Grounded in Learn:
//   https://learn.microsoft.com/azure/event-hubs/schema-registry-overview
//   https://learn.microsoft.com/rest/api/schemaregistry/
//
// This path is OPT-IN: it is only used when LOOM_EH_SCHEMA_GROUP is set (plus
// LOOM_EVENTHUB_NAMESPACE). When unset, the route falls through to the
// in-process Avro validator (schema-compat-validator.ts) — the Azure-native
// DEFAULT that works with no Fabric and no extra infra.
// ============================================================

/** Event Hubs Schema Registry data-plane token scope (cloud-invariant). */
export const EVENTHUBS_DATA_SCOPE = 'https://eventhubs.azure.net/.default';

/** Schema Registry data-plane REST api-version (GA). */
const SR_API = '2023-07-01';

/** Map a Loom schema format to the EH SR serialization content-type. */
function srContentType(format: 'Avro' | 'Json' | 'Protobuf'): string {
  switch (format) {
    case 'Json': return 'application/json;serialization=Json';
    case 'Protobuf': return 'text/vnd.ms.protobuf';
    case 'Avro':
    default: return 'application/json;serialization=Avro';
  }
}

/**
 * Honest config gate for the Schema Registry data-plane path. Returns the exact
 * missing env var so the route can decide whether to delegate to EH SR or fall
 * back to the in-process validator. Returns null only when BOTH the namespace
 * and the schema group are configured.
 */
export function schemaRegistryConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_EVENTHUB_NAMESPACE) return { missing: 'LOOM_EVENTHUB_NAMESPACE' };
  if (!process.env.LOOM_EH_SCHEMA_GROUP) return { missing: 'LOOM_EH_SCHEMA_GROUP' };
  return null;
}

/** Resolved Schema Registry data-plane base URL (no trailing slash). */
export function ehSchemaRegistryBase(): string {
  const raw = (process.env.LOOM_EVENTHUB_NAMESPACE || '').trim();
  if (!raw) throw new EventHubsArmError(503, undefined, 'Event Hubs namespace not configured');
  const suffix = (process.env.LOOM_EVENTHUB_DATA_SUFFIX || serviceBusSuffix()).replace(/^\.+|\.+$/g, '');
  const fqdn = raw.includes('.') ? raw.replace(/\/+$/, '') : `${raw}.${suffix}`;
  return `https://${fqdn}`;
}

export interface PutSchemaResult {
  /** Service-assigned schema id (GUID). */
  schemaId: string;
  /** Monotonic version number assigned within the schema group. */
  version: number;
}

/**
 * Register (PUT) a schema version on the Event Hubs Schema Registry data plane.
 *
 * The service enforces the schema GROUP's compatibility policy at PUT time:
 * when the group is Backward/Forward and the new schema violates it, the
 * service returns HTTP 400 with a descriptive body. We surface that verbatim
 * as an {@link EventHubsArmError} so the route can translate it into a 409 +
 * violations message. On success the Schema-Id / Schema-Version response
 * headers are returned. The PUT is idempotent by schema content.
 */
export async function putSchemaVersion(
  schemaGroup: string,
  schemaName: string,
  schemaBody: string,
  format: 'Avro' | 'Json' | 'Protobuf',
): Promise<PutSchemaResult> {
  const group = (schemaGroup || '').trim();
  const name = (schemaName || '').trim();
  if (!group) throw new EventHubsArmError(400, undefined, 'schemaGroup is required');
  if (!name) throw new EventHubsArmError(400, undefined, 'schemaName is required');
  const t = await credential.getToken(EVENTHUBS_DATA_SCOPE);
  if (!t?.token) throw new EventHubsArmError(401, undefined, 'Failed to acquire Event Hubs data-plane token');
  const url = `${ehSchemaRegistryBase()}/$schemagroups/${encodeURIComponent(group)}/schemas/${encodeURIComponent(name)}?api-version=${SR_API}`;
  const r = await fetchWithTimeout(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${t.token}`,
      'content-type': srContentType(format),
    },
    body: schemaBody,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new EventHubsArmError(
      r.status,
      text,
      `putSchemaVersion failed ${r.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
    );
  }
  const schemaId = r.headers.get('Schema-Id') || r.headers.get('schema-id') || '';
  const versionHeader = r.headers.get('Schema-Version') || r.headers.get('schema-version') || '';
  const version = Number.parseInt(versionHeader, 10);
  return { schemaId, version: Number.isFinite(version) ? version : 0 };
}
