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

import { armGet, armPut, armPost, armDelete } from './arm-client';

// Control-plane api-version with queues/topics/subscriptions/rules CRUD,
// authorizationRules (SAS), networkRuleSets and privateEndpointConnections.
const SB_API = '2021-11-01';

/**
 * Serialize a whole number of a single unit into an ISO-8601 duration the
 * Service Bus ARM surface accepts (e.g. 30s → "PT30S", 14d → "P14D"). Returns
 * undefined for a non-finite / non-positive value so the caller omits the
 * property and the service default applies.
 */
export function iso8601Duration(value: number | undefined, unit: 'S' | 'M' | 'H' | 'D'): string | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  const n = Math.floor(value);
  return unit === 'D' ? `P${n}D` : `PT${n}${unit}`;
}

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
  activeMessageCount?: number;
  deadLetterMessageCount?: number;
  requiresSession?: boolean;
  requiresDuplicateDetection?: boolean;
  defaultMessageTimeToLive?: string;
  deadLetteringOnMessageExpiration?: boolean;
  duplicateDetectionHistoryTimeWindow?: string;
  maxDeliveryCount?: number;
  enablePartitioning?: boolean;
  forwardTo?: string;
  autoDeleteOnIdle?: string;
}

function shapeQueue(raw: any): QueueEntity {
  const p = raw?.properties || {};
  const cd = p.countDetails || {};
  return {
    name: raw?.name,
    status: p.status,
    maxSizeInMegabytes: p.maxSizeInMegabytes,
    lockDuration: p.lockDuration,
    messageCount: p.messageCount,
    activeMessageCount: cd.activeMessageCount,
    deadLetterMessageCount: cd.deadLetterMessageCount,
    requiresSession: p.requiresSession,
    requiresDuplicateDetection: p.requiresDuplicateDetection,
    defaultMessageTimeToLive: p.defaultMessageTimeToLive,
    deadLetteringOnMessageExpiration: p.deadLetteringOnMessageExpiration,
    duplicateDetectionHistoryTimeWindow: p.duplicateDetectionHistoryTimeWindow,
    maxDeliveryCount: p.maxDeliveryCount,
    enablePartitioning: p.enablePartitioning,
    forwardTo: p.forwardTo,
    autoDeleteOnIdle: p.autoDeleteOnIdle,
  };
}

export async function listQueues(): Promise<QueueEntity[]> {
  const cfg = readServiceBusConfig();
  const body = await armGet<any>(`${nsPath(cfg)}/queues?api-version=${SB_API}`);
  return Array.isArray(body?.value) ? body.value.map(shapeQueue) : [];
}

/**
 * Full create/update settings a Service Bus queue exposes in the Azure portal.
 * `requiresDuplicateDetection`, `requiresSession`, `enablePartitioning` are set
 * at creation only (ARM rejects changing them on an existing entity). Durations
 * are ISO-8601 (see {@link iso8601Duration}); omitted properties fall through to
 * the service default. Docs: https://learn.microsoft.com/rest/api/servicebus/controlplane-stable/queues/create-or-update
 */
export interface CreateQueueSpec {
  name: string;
  maxSizeInMegabytes?: number;
  requiresSession?: boolean;
  requiresDuplicateDetection?: boolean;
  /** ISO-8601, e.g. "PT30S". Max 5 minutes. */
  lockDuration?: string;
  /** ISO-8601, e.g. "P14D". */
  defaultMessageTimeToLive?: string;
  deadLetteringOnMessageExpiration?: boolean;
  /** ISO-8601 window; only meaningful when requiresDuplicateDetection. */
  duplicateDetectionHistoryTimeWindow?: string;
  maxDeliveryCount?: number;
  enablePartitioning?: boolean;
  enableBatchedOperations?: boolean;
  /** Auto-forward target entity name (queue/topic) — empty to disable. */
  forwardTo?: string;
  forwardDeadLetteredMessagesTo?: string;
  /** ISO-8601 idle-delete window, e.g. "P10675199D" (never). */
  autoDeleteOnIdle?: string;
}

export async function createQueue(spec: CreateQueueSpec): Promise<QueueEntity> {
  const cfg = readServiceBusConfig();
  const properties: Record<string, unknown> = {
    maxSizeInMegabytes: spec.maxSizeInMegabytes ?? 1024,
    requiresSession: !!spec.requiresSession,
    requiresDuplicateDetection: !!spec.requiresDuplicateDetection,
    deadLetteringOnMessageExpiration: !!spec.deadLetteringOnMessageExpiration,
    enablePartitioning: !!spec.enablePartitioning,
    enableBatchedOperations: spec.enableBatchedOperations ?? true,
  };
  if (spec.lockDuration) properties.lockDuration = spec.lockDuration;
  if (spec.defaultMessageTimeToLive) properties.defaultMessageTimeToLive = spec.defaultMessageTimeToLive;
  if (spec.requiresDuplicateDetection && spec.duplicateDetectionHistoryTimeWindow) {
    properties.duplicateDetectionHistoryTimeWindow = spec.duplicateDetectionHistoryTimeWindow;
  }
  if (Number.isFinite(spec.maxDeliveryCount)) properties.maxDeliveryCount = spec.maxDeliveryCount;
  if (spec.forwardTo?.trim()) properties.forwardTo = spec.forwardTo.trim();
  if (spec.forwardDeadLetteredMessagesTo?.trim()) properties.forwardDeadLetteredMessagesTo = spec.forwardDeadLetteredMessagesTo.trim();
  if (spec.autoDeleteOnIdle) properties.autoDeleteOnIdle = spec.autoDeleteOnIdle;
  const raw = await armPut<any>(`${nsPath(cfg)}/queues/${encodeURIComponent(spec.name)}?api-version=${SB_API}`, { properties });
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
  defaultMessageTimeToLive?: string;
  requiresDuplicateDetection?: boolean;
  duplicateDetectionHistoryTimeWindow?: string;
  enablePartitioning?: boolean;
  supportOrdering?: boolean;
  autoDeleteOnIdle?: string;
}

function shapeTopic(raw: any): TopicEntity {
  const p = raw?.properties || {};
  return {
    name: raw?.name,
    status: p.status,
    maxSizeInMegabytes: p.maxSizeInMegabytes,
    subscriptionCount: p.subscriptionCount,
    defaultMessageTimeToLive: p.defaultMessageTimeToLive,
    requiresDuplicateDetection: p.requiresDuplicateDetection,
    duplicateDetectionHistoryTimeWindow: p.duplicateDetectionHistoryTimeWindow,
    enablePartitioning: p.enablePartitioning,
    supportOrdering: p.supportOrdering,
    autoDeleteOnIdle: p.autoDeleteOnIdle,
  };
}

export async function listTopics(): Promise<TopicEntity[]> {
  const cfg = readServiceBusConfig();
  const body = await armGet<any>(`${nsPath(cfg)}/topics?api-version=${SB_API}`);
  return Array.isArray(body?.value) ? body.value.map(shapeTopic) : [];
}

/**
 * Full create/update settings a Service Bus topic exposes in the Azure portal.
 * `requiresDuplicateDetection` and `enablePartitioning` are creation-only.
 * Docs: https://learn.microsoft.com/rest/api/servicebus/controlplane-stable/topics/create-or-update
 */
export interface CreateTopicSpec {
  name: string;
  maxSizeInMegabytes?: number;
  defaultMessageTimeToLive?: string;
  requiresDuplicateDetection?: boolean;
  duplicateDetectionHistoryTimeWindow?: string;
  enablePartitioning?: boolean;
  enableBatchedOperations?: boolean;
  supportOrdering?: boolean;
  autoDeleteOnIdle?: string;
}

export async function createTopic(spec: CreateTopicSpec): Promise<TopicEntity> {
  const cfg = readServiceBusConfig();
  const properties: Record<string, unknown> = {
    maxSizeInMegabytes: spec.maxSizeInMegabytes ?? 1024,
    requiresDuplicateDetection: !!spec.requiresDuplicateDetection,
    enablePartitioning: !!spec.enablePartitioning,
    enableBatchedOperations: spec.enableBatchedOperations ?? true,
  };
  if (spec.defaultMessageTimeToLive) properties.defaultMessageTimeToLive = spec.defaultMessageTimeToLive;
  if (spec.requiresDuplicateDetection && spec.duplicateDetectionHistoryTimeWindow) {
    properties.duplicateDetectionHistoryTimeWindow = spec.duplicateDetectionHistoryTimeWindow;
  }
  if (typeof spec.supportOrdering === 'boolean') properties.supportOrdering = spec.supportOrdering;
  if (spec.autoDeleteOnIdle) properties.autoDeleteOnIdle = spec.autoDeleteOnIdle;
  const raw = await armPut<any>(`${nsPath(cfg)}/topics/${encodeURIComponent(spec.name)}?api-version=${SB_API}`, { properties });
  return shapeTopic(raw);
}

export async function deleteTopic(name: string): Promise<void> {
  const cfg = readServiceBusConfig();
  await armDelete(`${nsPath(cfg)}/topics/${encodeURIComponent(name)}?api-version=${SB_API}`);
}

// ============================================================
// Topic subscriptions (Microsoft.ServiceBus/namespaces/topics/subscriptions).
// A topic is inert without subscriptions — each is an independent, ordered
// virtual queue that receives a copy of every published message that matches
// its filter rules. Docs:
// https://learn.microsoft.com/rest/api/servicebus/controlplane-stable/subscriptions
// ============================================================
export interface SubscriptionEntity {
  name: string;
  topic: string;
  status?: string;
  lockDuration?: string;
  requiresSession?: boolean;
  defaultMessageTimeToLive?: string;
  deadLetteringOnMessageExpiration?: boolean;
  deadLetteringOnFilterEvaluationExceptions?: boolean;
  maxDeliveryCount?: number;
  messageCount?: number;
  activeMessageCount?: number;
  deadLetterMessageCount?: number;
  forwardTo?: string;
  autoDeleteOnIdle?: string;
}

function shapeSubscription(topic: string, raw: any): SubscriptionEntity {
  const p = raw?.properties || {};
  const cd = p.countDetails || {};
  return {
    name: raw?.name,
    topic,
    status: p.status,
    lockDuration: p.lockDuration,
    requiresSession: p.requiresSession,
    defaultMessageTimeToLive: p.defaultMessageTimeToLive,
    deadLetteringOnMessageExpiration: p.deadLetteringOnMessageExpiration,
    deadLetteringOnFilterEvaluationExceptions: p.deadLetteringOnFilterEvaluationExceptions,
    maxDeliveryCount: p.maxDeliveryCount,
    messageCount: p.messageCount,
    activeMessageCount: cd.activeMessageCount,
    deadLetterMessageCount: cd.deadLetterMessageCount,
    forwardTo: p.forwardTo,
    autoDeleteOnIdle: p.autoDeleteOnIdle,
  };
}

export async function listSubscriptions(topic: string): Promise<SubscriptionEntity[]> {
  const cfg = readServiceBusConfig();
  const body = await armGet<any>(`${nsPath(cfg)}/topics/${encodeURIComponent(topic)}/subscriptions?api-version=${SB_API}`);
  return Array.isArray(body?.value) ? body.value.map((r: any) => shapeSubscription(topic, r)) : [];
}

export interface CreateSubscriptionSpec {
  topic: string;
  name: string;
  requiresSession?: boolean;
  /** ISO-8601, e.g. "PT30S". Max 5 minutes. */
  lockDuration?: string;
  /** ISO-8601, e.g. "P14D". */
  defaultMessageTimeToLive?: string;
  deadLetteringOnMessageExpiration?: boolean;
  deadLetteringOnFilterEvaluationExceptions?: boolean;
  maxDeliveryCount?: number;
  enableBatchedOperations?: boolean;
  forwardTo?: string;
  forwardDeadLetteredMessagesTo?: string;
  autoDeleteOnIdle?: string;
}

export async function createSubscription(spec: CreateSubscriptionSpec): Promise<SubscriptionEntity> {
  const cfg = readServiceBusConfig();
  const topic = spec.topic.trim();
  const properties: Record<string, unknown> = {
    requiresSession: !!spec.requiresSession,
    deadLetteringOnMessageExpiration: !!spec.deadLetteringOnMessageExpiration,
    deadLetteringOnFilterEvaluationExceptions: spec.deadLetteringOnFilterEvaluationExceptions ?? true,
    maxDeliveryCount: Number.isFinite(spec.maxDeliveryCount) ? spec.maxDeliveryCount : 10,
    enableBatchedOperations: spec.enableBatchedOperations ?? true,
  };
  if (spec.lockDuration) properties.lockDuration = spec.lockDuration;
  if (spec.defaultMessageTimeToLive) properties.defaultMessageTimeToLive = spec.defaultMessageTimeToLive;
  if (spec.forwardTo?.trim()) properties.forwardTo = spec.forwardTo.trim();
  if (spec.forwardDeadLetteredMessagesTo?.trim()) properties.forwardDeadLetteredMessagesTo = spec.forwardDeadLetteredMessagesTo.trim();
  if (spec.autoDeleteOnIdle) properties.autoDeleteOnIdle = spec.autoDeleteOnIdle;
  const raw = await armPut<any>(
    `${nsPath(cfg)}/topics/${encodeURIComponent(topic)}/subscriptions/${encodeURIComponent(spec.name)}?api-version=${SB_API}`,
    { properties },
  );
  return shapeSubscription(topic, raw);
}

export async function deleteSubscription(topic: string, name: string): Promise<void> {
  const cfg = readServiceBusConfig();
  await armDelete(`${nsPath(cfg)}/topics/${encodeURIComponent(topic)}/subscriptions/${encodeURIComponent(name)}?api-version=${SB_API}`);
}

// ============================================================
// Subscription filter rules
// (…/topics/{t}/subscriptions/{s}/rules). Each rule is a SQL filter, a
// correlation filter, or a true/false filter, optionally with a SQL action that
// mutates matched messages. A subscription starts with a built-in `$Default`
// TrueFilter (matches everything) — to filter, add a rule and delete `$Default`.
// Docs: https://learn.microsoft.com/rest/api/servicebus/controlplane-stable/rules
// ============================================================
export interface CorrelationFilterSpec {
  correlationId?: string;
  messageId?: string;
  to?: string;
  replyTo?: string;
  label?: string;         // ARM field: `label` (a.k.a. Subject)
  sessionId?: string;
  replyToSessionId?: string;
  contentType?: string;
  /** Custom user/application properties to match. */
  properties?: Record<string, string>;
}

export interface RuleEntity {
  name: string;
  filterType: 'SqlFilter' | 'CorrelationFilter';
  sqlExpression?: string;
  correlationFilter?: CorrelationFilterSpec;
  actionSqlExpression?: string;
}

function shapeRule(raw: any): RuleEntity {
  const p = raw?.properties || {};
  const filterType: 'SqlFilter' | 'CorrelationFilter' = p.filterType === 'CorrelationFilter' ? 'CorrelationFilter' : 'SqlFilter';
  const cf = p.correlationFilter || {};
  return {
    name: raw?.name,
    filterType,
    sqlExpression: p.sqlFilter?.sqlExpression,
    correlationFilter: filterType === 'CorrelationFilter' ? {
      correlationId: cf.correlationId,
      messageId: cf.messageId,
      to: cf.to,
      replyTo: cf.replyTo,
      label: cf.label,
      sessionId: cf.sessionId,
      replyToSessionId: cf.replyToSessionId,
      contentType: cf.contentType,
      properties: cf.properties && typeof cf.properties === 'object' ? cf.properties : undefined,
    } : undefined,
    actionSqlExpression: p.action?.sqlExpression,
  };
}

export async function listRules(topic: string, subscription: string): Promise<RuleEntity[]> {
  const cfg = readServiceBusConfig();
  const body = await armGet<any>(
    `${nsPath(cfg)}/topics/${encodeURIComponent(topic)}/subscriptions/${encodeURIComponent(subscription)}/rules?api-version=${SB_API}`,
  );
  return Array.isArray(body?.value) ? body.value.map(shapeRule) : [];
}

export interface CreateRuleSpec {
  topic: string;
  subscription: string;
  name: string;
  filterType: 'SqlFilter' | 'CorrelationFilter';
  /** Required when filterType === 'SqlFilter', e.g. "priority > 5 AND label = 'urgent'". */
  sqlExpression?: string;
  correlationFilter?: CorrelationFilterSpec;
  /** Optional SQL action applied to matched messages. */
  actionSqlExpression?: string;
}

export async function createRule(spec: CreateRuleSpec): Promise<RuleEntity> {
  const cfg = readServiceBusConfig();
  const properties: Record<string, unknown> = { filterType: spec.filterType };
  if (spec.filterType === 'SqlFilter') {
    const sql = (spec.sqlExpression || '').trim();
    if (!sql) throw new Error('sqlExpression is required for a SQL filter rule');
    properties.sqlFilter = { sqlExpression: sql };
  } else {
    const cf = spec.correlationFilter || {};
    const props: Record<string, unknown> = {};
    for (const k of ['correlationId', 'messageId', 'to', 'replyTo', 'label', 'sessionId', 'replyToSessionId', 'contentType'] as const) {
      const v = (cf[k] || '').toString().trim();
      if (v) props[k] = v;
    }
    if (cf.properties && Object.keys(cf.properties).length) props.properties = cf.properties;
    if (!Object.keys(props).length) throw new Error('at least one correlation field is required for a correlation filter rule');
    properties.correlationFilter = props;
  }
  const action = (spec.actionSqlExpression || '').trim();
  if (action) properties.action = { sqlExpression: action };
  const raw = await armPut<any>(
    `${nsPath(cfg)}/topics/${encodeURIComponent(spec.topic)}/subscriptions/${encodeURIComponent(spec.subscription)}/rules/${encodeURIComponent(spec.name)}?api-version=${SB_API}`,
    { properties },
  );
  return shapeRule(raw);
}

export async function deleteRule(topic: string, subscription: string, name: string): Promise<void> {
  const cfg = readServiceBusConfig();
  await armDelete(
    `${nsPath(cfg)}/topics/${encodeURIComponent(topic)}/subscriptions/${encodeURIComponent(subscription)}/rules/${encodeURIComponent(name)}?api-version=${SB_API}`,
  );
}

// ============================================================
// Shared access policies (namespace-level SAS authorization rules) +
// listKeys / regenerateKeys. Keys/connection strings are suppressed when the
// namespace deploys with the secure-default `disableLocalAuth: true` (Entra-only
// auth) — the SAS values exist but cannot authenticate, so the UI shows the
// honest Entra-only posture instead of a non-working connection string.
// Docs: https://learn.microsoft.com/rest/api/servicebus/controlplane-stable/namespaces-authorization-rules
// ============================================================
export type SasRight = 'Listen' | 'Send' | 'Manage';

export interface AuthorizationRule {
  name: string;
  rights: SasRight[];
}

export async function listNamespaceAuthRules(): Promise<AuthorizationRule[]> {
  const cfg = readServiceBusConfig();
  const body = await armGet<any>(`${nsPath(cfg)}/authorizationRules?api-version=${SB_API}`);
  return Array.isArray(body?.value)
    ? body.value.map((a: any) => ({ name: a?.name, rights: (a?.properties?.rights || []) as SasRight[] }))
    : [];
}

export async function createNamespaceAuthRule(name: string, rights: SasRight[]): Promise<AuthorizationRule> {
  const cfg = readServiceBusConfig();
  const r = rights.length ? rights : ['Listen' as SasRight];
  // Manage implies Send + Listen — ARM requires all three present when Manage is set.
  const effective = r.includes('Manage') ? (['Listen', 'Send', 'Manage'] as SasRight[]) : r;
  const raw = await armPut<any>(
    `${nsPath(cfg)}/authorizationRules/${encodeURIComponent(name.trim())}?api-version=${SB_API}`,
    { properties: { rights: effective } },
  );
  return { name: raw?.name, rights: (raw?.properties?.rights || effective) as SasRight[] };
}

export async function deleteNamespaceAuthRule(name: string): Promise<void> {
  const cfg = readServiceBusConfig();
  await armDelete(`${nsPath(cfg)}/authorizationRules/${encodeURIComponent(name)}?api-version=${SB_API}`);
}

export interface AccessKeys {
  keyName: string;
  primaryKey?: string;
  secondaryKey?: string;
  primaryConnectionString?: string;
  secondaryConnectionString?: string;
  /** True when the namespace has local (SAS) auth disabled — keys can't authenticate. */
  localAuthDisabled: boolean;
}

async function isLocalAuthDisabled(): Promise<boolean> {
  try { return (await getNamespaceProperties()).disableLocalAuth === true; }
  catch { return true; } // fail safe: assume Entra-only
}

function shapeKeys(raw: any, ruleName: string, localAuthDisabled: boolean): AccessKeys {
  return {
    keyName: raw?.keyName ?? ruleName,
    primaryKey: localAuthDisabled ? undefined : raw?.primaryKey,
    secondaryKey: localAuthDisabled ? undefined : raw?.secondaryKey,
    primaryConnectionString: localAuthDisabled ? undefined : raw?.primaryConnectionString,
    secondaryConnectionString: localAuthDisabled ? undefined : raw?.secondaryConnectionString,
    localAuthDisabled,
  };
}

export async function listNamespaceKeys(ruleName: string): Promise<AccessKeys> {
  const cfg = readServiceBusConfig();
  const rule = (ruleName || '').trim() || 'RootManageSharedAccessKey';
  const [raw, localAuthDisabled] = await Promise.all([
    armPost<any>(`${nsPath(cfg)}/authorizationRules/${encodeURIComponent(rule)}/listKeys?api-version=${SB_API}`),
    isLocalAuthDisabled(),
  ]);
  return shapeKeys(raw, rule, localAuthDisabled);
}

export type RegenerateKeyType = 'PrimaryKey' | 'SecondaryKey';

export async function regenerateNamespaceKeys(ruleName: string, keyType: RegenerateKeyType): Promise<AccessKeys> {
  const cfg = readServiceBusConfig();
  const rule = (ruleName || '').trim() || 'RootManageSharedAccessKey';
  const [raw, localAuthDisabled] = await Promise.all([
    armPost<any>(`${nsPath(cfg)}/authorizationRules/${encodeURIComponent(rule)}/regenerateKeys?api-version=${SB_API}`, { keyType }),
    isLocalAuthDisabled(),
  ]);
  return shapeKeys(raw, rule, localAuthDisabled);
}

// ============================================================
// Networking (read-only) — default IP/VNet firewall + private endpoint
// connections on the namespace. Mirrors the Azure portal Networking blade.
// Docs: https://learn.microsoft.com/rest/api/servicebus/controlplane-stable/namespaces-network-rule-set
// ============================================================
export interface SbNetworkRuleSet {
  defaultAction?: string;       // Allow | Deny
  publicNetworkAccess?: string; // Enabled | Disabled | SecuredByPerimeter
  trustedServiceAccessEnabled?: boolean;
  ipRules: { ipMask: string; action?: string }[];
  vnetRules: { subnetId: string }[];
}

export async function getNetworkRuleSet(): Promise<SbNetworkRuleSet> {
  const cfg = readServiceBusConfig();
  let body: any;
  try {
    body = await armGet<any>(`${nsPath(cfg)}/networkRuleSets/default?api-version=${SB_API}`);
  } catch (e: any) {
    // A namespace with no firewall configured returns 404 — treat as "Allow all".
    if (String(e?.message || '').includes(' 404')) {
      return { defaultAction: 'Allow', publicNetworkAccess: 'Enabled', ipRules: [], vnetRules: [] };
    }
    throw e;
  }
  const p = body?.properties || {};
  const ipRules = Array.isArray(p.ipRules)
    ? p.ipRules.map((x: any) => ({ ipMask: x?.ipMask, action: x?.action || 'Allow' })).filter((x: any) => !!x.ipMask)
    : [];
  const vnetRules = Array.isArray(p.virtualNetworkRules)
    ? p.virtualNetworkRules.map((x: any) => ({ subnetId: x?.subnet?.id })).filter((x: any) => !!x.subnetId)
    : [];
  return {
    defaultAction: p.defaultAction,
    publicNetworkAccess: p.publicNetworkAccess,
    trustedServiceAccessEnabled: p.trustedServiceAccessEnabled,
    ipRules,
    vnetRules,
  };
}

export interface PrivateEndpointConnection {
  name: string;
  connectionStatus: string;
  provisioningState?: string;
  description?: string;
}

export async function listPrivateEndpointConnections(): Promise<PrivateEndpointConnection[]> {
  const cfg = readServiceBusConfig();
  const body = await armGet<any>(`${nsPath(cfg)}/privateEndpointConnections?api-version=${SB_API}`);
  return Array.isArray(body?.value)
    ? body.value.map((raw: any) => {
        const p = raw?.properties || {};
        const state = p?.privateLinkServiceConnectionState || {};
        return {
          name: raw?.name,
          connectionStatus: state?.status || 'Unknown',
          provisioningState: p?.provisioningState,
          description: state?.description,
        };
      })
    : [];
}
