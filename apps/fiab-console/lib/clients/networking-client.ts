/**
 * networking-client — the WRITE side of the workspace "Advanced networking"
 * surface (F15). Azure-native parity with the Fabric workspace networking pane
 * (inbound protection / outbound access rules / IP firewall / trusted
 * instances), built entirely on real Azure Resource Manager — NO Fabric or
 * Power BI dependency (per no-fabric-dependency.md).
 *
 * Backends (all real ARM REST — no mocks, no placeholders):
 *   IP firewall rules  → Microsoft.Network/networkSecurityGroups/securityRules
 *                         PUT/DELETE on the hub private-endpoints NSG
 *                         (api-version 2024-05-01)
 *   Inbound protection → Microsoft.Network/privateEndpoints  (PUT/GET/DELETE,
 *                         api-version 2024-03-01) + privateDnsZoneGroups
 *   Outbound PE rules  → same privateEndpoints surface, registered per-workspace
 *   Trusted instances  → NSG allow-rule + a Cosmos-backed allowlist doc
 *
 * Auth: ChainedTokenCredential(UAMI → DefaultAzureCredential) on the ARM scope —
 * identical to every other Loom ARM client. The UAMI needs **Network
 * Contributor** (4d97b98b-1d4f-4787-a291-c67834d212e7) on the networking RG;
 * network.bicep grants it. When the grant is missing ARM returns 403, surfaced
 * to the BFF as a NetworkingArmError(status=403) so the UI shows an honest
 * MessageBar naming the exact role to grant — not a generic error page.
 *
 * Honest gate: when LOOM_SUBSCRIPTION_ID / LOOM_NETWORKING_RG aren't configured
 * this throws NetworkingNotConfiguredError, which the BFF maps to a 503 +
 * MessageBar naming the exact env var. No mocks, no sample data.
 *
 * Learn:
 *   https://learn.microsoft.com/rest/api/virtualnetwork/security-rules/create-or-update
 *   https://learn.microsoft.com/rest/api/virtualnetwork/private-endpoints/create-or-update
 *   https://learn.microsoft.com/rest/api/virtualnetwork/private-dns-zone-groups/create-or-update
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { randomUUID } from 'node:crypto';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { networkingConfigContainer } from '@/lib/azure/cosmos-client';
import { normalizePrivateLinkTargetId, privateDnsZoneNameForGroupId } from '@/lib/azure/pe-subresource-groups';
import { listPrivateDnsZones } from '@/lib/azure/network-discovery';

const ARM = armBase();
const ARM_SCOPE = armScope();
// NSG + security rules share the same API version network.bicep declares.
const NSG_API = '2024-05-01';
// Private endpoints + DNS zone groups — same version network-discovery.ts uses.
const PE_API = '2024-03-01';
// Virtual networks — used to resolve the managed-VNet region for a managed PE.
const VNET_API = '2024-05-01';
/** Tag stamped on private endpoints Loom creates via the self-service surface. */
const LOOM_MANAGED_TAG = 'loom-managed';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NetworkingArmError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'NetworkingArmError';
    this.status = status;
    this.body = body;
  }
}

export class NetworkingNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`Advanced networking not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'NetworkingNotConfiguredError';
  }
}

// ---------------------------------------------------------------------------
// Config (honest gate)
// ---------------------------------------------------------------------------

export interface NetworkingConfig {
  subscriptionId: string;
  /** RG that owns the hub VNet / NSG / private endpoints. */
  networkingRg: string;
  /** Hub VNet name (informational — used for display + reserved future use). */
  hubVnetName: string;
  /** ARM id of snet-private-endpoints (required for inbound/outbound PE create). */
  peSubnetId: string;
  /** The NSG the IP-firewall + trusted-instance rules are written to. */
  nsgName: string;
}

/**
 * Read the networking infra config from env. `subscriptionId` + `networkingRg`
 * are required; `peSubnetId` / `hubVnetName` are optional (their absence
 * degrades to IP-rules-only mode — the inbound/outbound PE controls show an
 * honest gate rather than throwing). The NSG defaults to the bicep-named
 * `nsg-snet-private-endpoints` when `LOOM_NSG_NAME` is unset.
 */
export function readNetworkingConfig(): NetworkingConfig {
  const missing: string[] = [];
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID || '';
  const networkingRg = process.env.LOOM_NETWORKING_RG || process.env.LOOM_ADMIN_RG || '';
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');
  if (!networkingRg) missing.push('LOOM_NETWORKING_RG (or LOOM_ADMIN_RG)');
  if (missing.length) throw new NetworkingNotConfiguredError(missing);
  return {
    subscriptionId,
    networkingRg,
    hubVnetName: process.env.LOOM_HUB_VNET_NAME || '',
    peSubnetId: process.env.LOOM_PE_SUBNET_ID || '',
    nsgName: process.env.LOOM_NSG_NAME || 'nsg-snet-private-endpoints',
  };
}

// ---------------------------------------------------------------------------
// ARM helpers
// ---------------------------------------------------------------------------

async function token(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new NetworkingArmError('Failed to acquire ARM token', 401);
  return t.token;
}

async function armReq<T>(method: string, path: string, body?: unknown): Promise<T> {
  const tk = await token();
  const url = path.startsWith('http') ? path : `${ARM}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${tk}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const msg = (json?.error?.message || json?.message ||
      (typeof json === 'string' ? json : `ARM ${method} ${path} failed (${res.status})`)).toString();
    throw new NetworkingArmError(msg, res.status, json);
  }
  return (json as T) ?? ({} as T);
}

const armGet = <T>(p: string) => armReq<T>('GET', p);
const armPut = <T>(p: string, b: unknown) => armReq<T>('PUT', p, b);
const armPatch = <T>(p: string, b: unknown) => armReq<T>('PATCH', p, b);
const armDelete = (p: string) => armReq<void>('DELETE', p);

function nsgBase(cfg: NetworkingConfig): string {
  return `/subscriptions/${cfg.subscriptionId}/resourceGroups/${encodeURIComponent(cfg.networkingRg)}/providers/Microsoft.Network/networkSecurityGroups/${encodeURIComponent(cfg.nsgName)}`;
}
function peBase(cfg: NetworkingConfig, name: string): string {
  return `/subscriptions/${cfg.subscriptionId}/resourceGroups/${encodeURIComponent(cfg.networkingRg)}/providers/Microsoft.Network/privateEndpoints/${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without ARM / identity)
// ---------------------------------------------------------------------------

/** True for a syntactically valid IPv4 CIDR (e.g. `203.0.113.0/24`) or a bare
 * IPv4 address (treated as /32). Rejects out-of-range octets and prefix > 32. */
export function isValidCidr(cidr: string): boolean {
  if (typeof cidr !== 'string') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(cidr.trim());
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return false;
  if (m[5] !== undefined) {
    const prefix = Number(m[5]);
    if (prefix < 0 || prefix > 32) return false;
  }
  return true;
}

/**
 * ARM-safe NSG security-rule name. ARM requires
 * `^[a-zA-Z0-9][a-zA-Z0-9\-._]{0,78}[a-zA-Z0-9_]$` (≤ 80 chars). CIDR slashes/dots
 * are replaced with dashes and the whole thing capped, with a trailing-char
 * sanitiser so a truncation never lands on an illegal final character.
 */
export function nsgRuleNameFor(workspaceId: string, cidr: string, suffix?: string): string {
  const wsSlug = (workspaceId || 'ws').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'ws';
  const cidrSlug = cidr.replace(/[./]/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
  let name = `loom-ws-${wsSlug}-${cidrSlug}${suffix ? `-${suffix}` : ''}`;
  if (name.length > 80) name = name.slice(0, 80);
  // Final character must be alphanumeric or underscore.
  name = name.replace(/[^a-zA-Z0-9_]+$/, '');
  return name;
}

/** Next free priority given the existing rule priorities. Steps by `step` from
 * `base`, skipping any taken slot, capped at the ARM maximum (4096 exclusive). */
export function nextPriority(existing: number[], base = 200, step = 10): number {
  const taken = new Set(existing.filter((n) => Number.isFinite(n)));
  // Advance past the current max so we don't collide, then fill the next slot.
  const max = existing.length ? Math.max(base - step, ...existing) : base - step;
  let p = Math.max(base, max + step);
  while (taken.has(p) && p < 4096) p += step;
  return p;
}

// ---------------------------------------------------------------------------
// NSG security rules (IP firewall)
// ---------------------------------------------------------------------------

export interface NsgRule {
  name: string;
  priority: number;
  direction: 'Inbound' | 'Outbound';
  access: 'Allow' | 'Deny';
  protocol: '*' | 'Tcp' | 'Udp' | 'Icmp';
  sourceAddressPrefix: string;
  destinationAddressPrefix: string;
  destinationPortRange: string;
  sourcePortRange: string;
  description?: string;
  provisioningState?: string;
  /** True for the Loom-managed rules this surface writes (`loom-*`). */
  managed?: boolean;
}

function shapeRule(raw: any): NsgRule {
  const p = raw?.properties || {};
  const name: string = raw?.name || '';
  return {
    name,
    priority: p.priority,
    direction: p.direction,
    access: p.access,
    protocol: p.protocol,
    sourceAddressPrefix: p.sourceAddressPrefix || (p.sourceAddressPrefixes || [])[0] || '*',
    destinationAddressPrefix: p.destinationAddressPrefix || (p.destinationAddressPrefixes || [])[0] || '*',
    destinationPortRange: p.destinationPortRange || (p.destinationPortRanges || []).join(',') || '*',
    sourcePortRange: p.sourcePortRange || (p.sourcePortRanges || []).join(',') || '*',
    description: p.description,
    provisioningState: p.provisioningState,
    managed: name.startsWith('loom-'),
  };
}

/** All custom security rules on the hub NSG (default rules are not returned by
 * the securityRules sub-resource list). */
export async function listNsgRules(): Promise<NsgRule[]> {
  const cfg = readNetworkingConfig();
  const j = await armGet<{ value?: any[] }>(`${nsgBase(cfg)}/securityRules?api-version=${NSG_API}`);
  return (j?.value || []).map(shapeRule).sort((a, b) => a.priority - b.priority);
}

export interface PutNsgRuleInput {
  priority: number;
  direction: 'Inbound' | 'Outbound';
  access: 'Allow' | 'Deny';
  protocol?: '*' | 'Tcp' | 'Udp' | 'Icmp';
  /** The IP range this rule targets — written to the source prefix for inbound
   * rules, the destination prefix for outbound rules. */
  cidr: string;
  destinationPortRange?: string;
  description?: string;
}

/** Idempotent upsert of a single security rule (PUT .../securityRules/{name}). */
export async function putNsgRule(ruleName: string, input: PutNsgRuleInput): Promise<NsgRule> {
  const cfg = readNetworkingConfig();
  const inbound = input.direction === 'Inbound';
  const body = {
    properties: {
      priority: input.priority,
      direction: input.direction,
      access: input.access,
      protocol: input.protocol || '*',
      sourceAddressPrefix: inbound ? input.cidr : '*',
      destinationAddressPrefix: inbound ? '*' : input.cidr,
      sourcePortRange: '*',
      destinationPortRange: input.destinationPortRange || '*',
      description: input.description || `Loom advanced-networking ${input.direction} rule`,
    },
  };
  const raw = await armPut<any>(`${nsgBase(cfg)}/securityRules/${encodeURIComponent(ruleName)}?api-version=${NSG_API}`, body);
  return shapeRule(raw);
}

export async function deleteNsgRule(ruleName: string): Promise<void> {
  const cfg = readNetworkingConfig();
  await armDelete(`${nsgBase(cfg)}/securityRules/${encodeURIComponent(ruleName)}?api-version=${NSG_API}`);
}

/**
 * Add an IP firewall rule for a workspace. Auto-derives the rule name + a free
 * priority from the existing rule set, then writes a REAL NSG security rule.
 */
export async function addIpFirewallRule(
  workspaceId: string,
  input: { cidr: string; direction: 'Inbound' | 'Outbound'; access: 'Allow' | 'Deny'; protocol?: '*' | 'Tcp' | 'Udp' | 'Icmp'; description?: string },
): Promise<NsgRule> {
  if (!isValidCidr(input.cidr)) throw new NetworkingArmError(`Invalid CIDR: ${input.cidr}`, 400);
  const existing = await listNsgRules();
  const priority = nextPriority(existing.filter((r) => r.direction === input.direction).map((r) => r.priority));
  if (priority >= 4096) {
    throw new NetworkingArmError('NSG rule priority limit (4096) reached — delete existing rules before adding more', 409);
  }
  const name = nsgRuleNameFor(workspaceId, input.cidr, input.direction === 'Inbound' ? 'in' : 'out');
  return putNsgRule(name, {
    priority,
    direction: input.direction,
    access: input.access,
    protocol: input.protocol,
    cidr: input.cidr,
    description: input.description || `Loom workspace ${workspaceId} IP firewall rule`,
  });
}

// ---------------------------------------------------------------------------
// Private endpoints (inbound protection + outbound PE rules)
// ---------------------------------------------------------------------------

export interface PeStatus {
  id: string;
  name: string;
  provisioningState?: string;
  connectionState?: string;
  privateIp?: string;
  privateLinkServiceId?: string;
  groupIds?: string[];
}

function shapePe(raw: any): PeStatus {
  const p = raw?.properties || {};
  const conn = (p.privateLinkServiceConnections || p.manualPrivateLinkServiceConnections || [])[0]?.properties || {};
  return {
    id: raw?.id || '',
    name: raw?.name || '',
    provisioningState: p.provisioningState,
    connectionState: conn?.privateLinkServiceConnectionState?.status,
    privateLinkServiceId: conn?.privateLinkServiceId,
    groupIds: conn?.groupIds || [],
  };
}

export interface PeCreateInput {
  name: string;
  location: string;
  privateLinkServiceId: string;
  groupIds: string[];
  requestMessage?: string;
}

/** Create (or update) a private endpoint into snet-private-endpoints. */
export async function createPrivateEndpoint(input: PeCreateInput): Promise<PeStatus> {
  const cfg = readNetworkingConfig();
  if (!cfg.peSubnetId) {
    throw new NetworkingArmError('Private endpoint subnet not configured — set LOOM_PE_SUBNET_ID', 503);
  }
  if (!input.privateLinkServiceId) {
    throw new NetworkingArmError('privateLinkServiceId is required', 400);
  }
  const body = {
    location: input.location,
    properties: {
      subnet: { id: cfg.peSubnetId },
      privateLinkServiceConnections: [
        {
          name: `${input.name}-conn`,
          properties: {
            privateLinkServiceId: input.privateLinkServiceId,
            groupIds: input.groupIds,
            requestMessage: input.requestMessage || 'Loom advanced-networking',
          },
        },
      ],
    },
  };
  const raw = await armPut<any>(`${peBase(cfg, input.name)}?api-version=${PE_API}`, body);
  return shapePe(raw);
}

export async function getPrivateEndpoint(peName: string): Promise<PeStatus | null> {
  const cfg = readNetworkingConfig();
  try {
    const raw = await armGet<any>(`${peBase(cfg, peName)}?api-version=${PE_API}`);
    return shapePe(raw);
  } catch (e) {
    if (e instanceof NetworkingArmError && e.status === 404) return null;
    throw e;
  }
}

export async function deletePrivateEndpoint(peName: string): Promise<void> {
  const cfg = readNetworkingConfig();
  await armDelete(`${peBase(cfg, peName)}?api-version=${PE_API}`);
}

/** Register the PE's FQDN in a hub private DNS zone (so the FQDN resolves to the
 * PE private IP). `dnsZoneId` is the ARM id of the privatelink.* zone. */
export async function createPrivateDnsZoneGroup(peName: string, dnsZoneId: string, configName = 'default'): Promise<void> {
  const cfg = readNetworkingConfig();
  const body = {
    properties: {
      privateDnsZoneConfigs: [
        { name: configName, properties: { privateDnsZoneId: dnsZoneId } },
      ],
    },
  };
  await armPut<any>(`${peBase(cfg, peName)}/privateDnsZoneGroups/default?api-version=${PE_API}`, body);
}

/** Stable PE name for a workspace's inbound-protection endpoint. */
export function inboundPeName(workspaceId: string): string {
  const slug = (workspaceId || 'ws').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'ws';
  return `pe-loom-${slug}-inbound`;
}

// ---------------------------------------------------------------------------
// Cosmos-backed allowlist (trusted instances) + outbound rule registry
// ---------------------------------------------------------------------------

export interface TrustedInstance {
  id: string;
  label: string;
  ipCidr: string;
  direction: 'Inbound' | 'Outbound';
  addedAt: string;
  /** The NSG rule name written for this allowlist entry. */
  nsgRuleName: string;
}

export interface OutboundRule {
  id: string;
  type: 'PrivateEndpoint' | 'ServiceEndpoint';
  /** ARM id of the target resource (PE type). */
  targetResourceId?: string;
  /** Service tag (ServiceEndpoint type), e.g. 'Microsoft.Storage'. */
  targetService?: string;
  groupIds?: string[];
  /** PE name in ARM (PrivateEndpoint type) so it can be deleted on removal. */
  peName?: string;
  state: string;
  addedAt: string;
}

interface NetworkingDoc {
  id: string;
  workspaceId: string;
  trustedInstances: TrustedInstance[];
  outboundRules: OutboundRule[];
}

async function readDoc(workspaceId: string): Promise<NetworkingDoc> {
  const c = await networkingConfigContainer();
  try {
    const { resource } = await c.item(workspaceId, workspaceId).read<NetworkingDoc>();
    if (resource) {
      return {
        id: workspaceId,
        workspaceId,
        trustedInstances: resource.trustedInstances || [],
        outboundRules: resource.outboundRules || [],
      };
    }
  } catch {
    /* not found — fall through to a fresh doc */
  }
  return { id: workspaceId, workspaceId, trustedInstances: [], outboundRules: [] };
}

async function writeDoc(doc: NetworkingDoc): Promise<NetworkingDoc> {
  const c = await networkingConfigContainer();
  const { resource } = await c.items.upsert<NetworkingDoc>(doc);
  return resource as NetworkingDoc;
}

export async function listTrustedInstances(workspaceId: string): Promise<TrustedInstance[]> {
  return (await readDoc(workspaceId)).trustedInstances;
}

/** Add a trusted instance — writes a REAL NSG allow rule, then records the
 * allowlist entry in Cosmos. */
export async function addTrustedInstance(
  workspaceId: string,
  input: { label: string; ipCidr: string; direction: 'Inbound' | 'Outbound' },
): Promise<TrustedInstance> {
  if (!isValidCidr(input.ipCidr)) throw new NetworkingArmError(`Invalid CIDR: ${input.ipCidr}`, 400);
  const id = randomUUID();
  const nsgRuleName = nsgRuleNameFor(workspaceId, input.ipCidr, `trusted-${id.slice(0, 8)}`);
  const existing = await listNsgRules();
  const priority = nextPriority(existing.filter((r) => r.direction === input.direction).map((r) => r.priority));
  if (priority >= 4096) {
    throw new NetworkingArmError('NSG rule priority limit (4096) reached — delete existing rules before adding more', 409);
  }
  await putNsgRule(nsgRuleName, {
    priority,
    direction: input.direction,
    access: 'Allow',
    cidr: input.ipCidr,
    description: `Loom trusted instance: ${input.label}`,
  });
  const doc = await readDoc(workspaceId);
  const instance: TrustedInstance = {
    id,
    label: input.label,
    ipCidr: input.ipCidr,
    direction: input.direction,
    addedAt: new Date().toISOString(),
    nsgRuleName,
  };
  doc.trustedInstances.push(instance);
  await writeDoc(doc);
  return instance;
}

export async function removeTrustedInstance(workspaceId: string, instanceId: string): Promise<void> {
  const doc = await readDoc(workspaceId);
  const inst = doc.trustedInstances.find((t) => t.id === instanceId);
  if (!inst) throw new NetworkingArmError('Trusted instance not found', 404);
  try {
    await deleteNsgRule(inst.nsgRuleName);
  } catch (e) {
    if (!(e instanceof NetworkingArmError && e.status === 404)) throw e;
  }
  doc.trustedInstances = doc.trustedInstances.filter((t) => t.id !== instanceId);
  await writeDoc(doc);
}

export async function listOutboundRules(workspaceId: string): Promise<OutboundRule[]> {
  return (await readDoc(workspaceId)).outboundRules;
}

/** Add an outbound private-endpoint access rule — creates a REAL private
 * endpoint to the target resource, then records it in Cosmos. */
export async function addOutboundPeRule(
  workspaceId: string,
  input: { targetResourceId: string; groupIds: string[]; location: string },
): Promise<OutboundRule> {
  const id = randomUUID();
  const slug = (workspaceId || 'ws').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'ws';
  const peName = `pe-loom-${slug}-${id.slice(0, 8)}`;
  const pe = await createPrivateEndpoint({
    name: peName,
    location: input.location,
    privateLinkServiceId: input.targetResourceId,
    groupIds: input.groupIds,
    requestMessage: `Loom workspace ${workspaceId} outbound access`,
  });
  const doc = await readDoc(workspaceId);
  const rule: OutboundRule = {
    id,
    type: 'PrivateEndpoint',
    targetResourceId: input.targetResourceId,
    groupIds: input.groupIds,
    peName,
    state: pe.provisioningState || 'Creating',
    addedAt: new Date().toISOString(),
  };
  doc.outboundRules.push(rule);
  await writeDoc(doc);
  return rule;
}

export async function removeOutboundRule(workspaceId: string, ruleId: string): Promise<void> {
  const doc = await readDoc(workspaceId);
  const rule = doc.outboundRules.find((r) => r.id === ruleId);
  if (!rule) throw new NetworkingArmError('Outbound rule not found', 404);
  if (rule.type === 'PrivateEndpoint' && rule.peName) {
    try {
      await deletePrivateEndpoint(rule.peName);
    } catch (e) {
      if (!(e instanceof NetworkingArmError && e.status === 404)) throw e;
    }
  }
  doc.outboundRules = doc.outboundRules.filter((r) => r.id !== ruleId);
  await writeDoc(doc);
}

// ---------------------------------------------------------------------------
// Self-service MANAGED private endpoints (admin Network page — Phase 4 G5)
// ---------------------------------------------------------------------------
//
// The workspace-scoped outbound rules above register a PE against a Cosmos doc
// for a single workspace. This section powers the tenant-admin "Managed private
// endpoints" surface on the shared admin Network page: create a REAL
// Microsoft.Network/privateEndpoints into the DLZ managed-VNet PE subnet
// (LOOM_PE_SUBNET_ID) against ANY connectable Azure resource, then track the
// approval lifecycle. A managed PE is created with a MANUAL private-link service
// connection so it lands **Pending** until the OWNER of the target resource
// approves the connection — the honest governance approval step this surface
// tracks (it never auto-approves on the requestor's behalf).
//
// Real ARM (2024-03-01), no mocks. Honest gates flow through the shared
// networkingErrorResponse mapper via NetworkingNotConfiguredError (503, exact
// env var) / NetworkingArmError 401|403 (403, Network Contributor role).
//
// Learn: https://learn.microsoft.com/rest/api/virtualnetwork/private-endpoints/create-or-update
//        https://learn.microsoft.com/azure/private-link/manage-private-endpoint

export interface ManagedPrivateEndpoint {
  id: string;
  name: string;
  location?: string;
  resourceGroup?: string;
  provisioningState?: string;
  /** Approval status of the private-link connection: Pending | Approved | Rejected | Disconnected. */
  connectionState?: string;
  /** Approver's description returned by ARM (why approved / rejected). */
  connectionDescription?: string;
  /** ARM `actionsRequired` hint (e.g. "None" once approved). */
  actionsRequired?: string;
  /** ARM id of the target (backing) resource the PE fronts. */
  privateLinkServiceId?: string;
  /** Friendly name of the target resource (last id segment). */
  targetResourceName?: string;
  /** Sub-resource group id(s) the PE connects to (e.g. ['blob'] / ['sqlServer']). */
  groupIds?: string[];
  /** ARM id of the subnet the PE's NIC lives in. */
  subnetId?: string;
  /** The approval request message sent to the target owner (Loom stores the justification here). */
  requestMessage?: string;
  /** True when Loom created this PE via the self-service surface (loom-managed tag). */
  loomManaged?: boolean;
  /** OID of the admin who created it (loom-created-by tag). */
  createdBy?: string;
  /** ISO timestamp the PE was created (loom-created-at tag). */
  createdAt?: string;
  /** True once a privateDnsZoneGroups config points the matching privatelink.*
   * zone at this PE (so its FQDN actually resolves after approval). Populated
   * by the create / poll paths — undefined when not yet checked. */
  dnsRegistered?: boolean;
  /** The privatelink.* zone the PE registers (or should register) into. */
  dnsZoneName?: string;
  /** Honest note when DNS registration could not be completed (e.g. the
   * matching privatelink zone does not exist in the networking RG). */
  dnsNote?: string;
}

/** Shape one ARM privateEndpoint resource into a {@link ManagedPrivateEndpoint}. */
function shapeManagedPe(raw: any): ManagedPrivateEndpoint {
  const p = raw?.properties || {};
  const conns: any[] = p.privateLinkServiceConnections?.length
    ? p.privateLinkServiceConnections
    : (p.manualPrivateLinkServiceConnections || []);
  const conn = conns[0]?.properties || {};
  const st = conn?.privateLinkServiceConnectionState || {};
  const svcId: string | undefined = conn?.privateLinkServiceId;
  const id: string = raw?.id || '';
  const rg = /\/resourceGroups\/([^/]+)\//i.exec(id)?.[1];
  const tags: Record<string, string> =
    raw?.tags && typeof raw.tags === 'object' ? raw.tags : {};
  return {
    id,
    name: raw?.name || id.split('/').pop() || '',
    location: raw?.location,
    resourceGroup: rg,
    provisioningState: p.provisioningState,
    connectionState: st?.status,
    connectionDescription: st?.description,
    actionsRequired: st?.actionsRequired,
    privateLinkServiceId: svcId,
    targetResourceName: svcId ? svcId.split('/').pop() : undefined,
    groupIds: conn?.groupIds || [],
    subnetId: p?.subnet?.id,
    requestMessage: conn?.requestMessage,
    loomManaged: String(tags[LOOM_MANAGED_TAG] || '').toLowerCase() === 'true',
    createdBy: tags['loom-created-by'],
    createdAt: tags['loom-created-at'],
  };
}

/**
 * List every private endpoint in the networking RG (the DLZ managed network),
 * shaped with its connection-approval state. Loom-managed endpoints (created via
 * this surface) sort first. Needs only Reader on the networking RG for the list;
 * a missing sub/RG throws NetworkingNotConfiguredError → honest 503 at the BFF.
 */
export async function listManagedPrivateEndpoints(): Promise<ManagedPrivateEndpoint[]> {
  const cfg = readNetworkingConfig();
  const path =
    `/subscriptions/${cfg.subscriptionId}/resourceGroups/${encodeURIComponent(cfg.networkingRg)}` +
    `/providers/Microsoft.Network/privateEndpoints?api-version=${PE_API}`;
  const j = await armGet<{ value?: any[] }>(path);
  const out = (j?.value || []).map(shapeManagedPe);
  out.sort((a, b) =>
    (Number(!!b.loomManaged) - Number(!!a.loomManaged)) || a.name.localeCompare(b.name));
  return out;
}

/** Read a single managed PE's live connection-approval state (poll after approve). */
export async function getPrivateEndpointConnectionState(
  name: string,
): Promise<ManagedPrivateEndpoint | null> {
  const cfg = readNetworkingConfig();
  try {
    const raw = await armGet<any>(`${peBase(cfg, name)}?api-version=${PE_API}`);
    return shapeManagedPe(raw);
  } catch (e) {
    if (e instanceof NetworkingArmError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Resolve the Azure region for a managed PE. A private endpoint must be in the
 * same region as the subnet it deploys into, so we prefer the explicit body /
 * LOOM_LOCATION / LOOM_REGION value, then fall back to reading the managed-VNet's
 * own region from ARM (derived from the PE subnet id). Throws an honest 400 when
 * neither is resolvable.
 */
async function resolveManagedPeLocation(cfg: NetworkingConfig, explicit?: string): Promise<string> {
  const env = (explicit || process.env.LOOM_LOCATION || process.env.LOOM_REGION || '').trim();
  if (env) return env;
  const vnetId = cfg.peSubnetId ? cfg.peSubnetId.split('/subnets/')[0] : '';
  if (vnetId) {
    try {
      const vnet = await armGet<{ location?: string }>(`${vnetId}?api-version=${VNET_API}`);
      if (vnet?.location) return String(vnet.location);
    } catch { /* fall through to the honest error below */ }
  }
  throw new NetworkingArmError(
    'Could not resolve an Azure region for the managed private endpoint — set LOOM_LOCATION.',
    400,
  );
}

export interface ManagedPeCreateInput {
  /** ARM-safe PE name (validated by the BFF route). */
  name: string;
  /** Full ARM id of the target resource (SQL databases are normalized to the server). */
  targetResourceId: string;
  /** ARM resource type of the picked resource (drives SQL server normalization). */
  armType?: string;
  /** Sub-resource group id (e.g. blob/dfs/sqlServer/vault/namespace). */
  groupId: string;
  /** Justification — sent to the target owner as the approval request message. */
  justification: string;
  /** Region override; defaults to LOOM_LOCATION → managed-VNet region. */
  location?: string;
  /** OID of the creating admin (stamped as the loom-created-by tag). */
  createdBy?: string;
}

/**
 * Create a REAL Microsoft.Network/privateEndpoints into the DLZ managed-VNet PE
 * subnet (LOOM_PE_SUBNET_ID), against the target resource, with a MANUAL
 * private-link connection so it lands Pending until the target owner approves.
 * The justification rides along as the connection `requestMessage` (shown to the
 * approver). Throws NetworkingNotConfiguredError when the PE subnet isn't wired.
 */
export async function createManagedPrivateEndpoint(
  input: ManagedPeCreateInput,
): Promise<ManagedPrivateEndpoint> {
  const cfg = readNetworkingConfig();
  if (!cfg.peSubnetId) {
    // Honest structured 503 — the managed-VNet PE subnet isn't wired yet.
    throw new NetworkingNotConfiguredError(['LOOM_PE_SUBNET_ID']);
  }
  const target = normalizePrivateLinkTargetId(input.targetResourceId, input.armType);
  if (!target.startsWith('/subscriptions/')) {
    throw new NetworkingArmError(
      'targetResourceId must be the full ARM id of the target resource (/subscriptions/…)',
      400,
    );
  }
  if (!input.groupId) throw new NetworkingArmError('groupId (sub-resource) is required', 400);
  const location = await resolveManagedPeLocation(cfg, input.location);
  // requestMessage is capped at 140 chars by ARM.
  const requestMessage = (input.justification || 'CSA Loom managed private endpoint').slice(0, 140);
  const body = {
    location,
    tags: {
      [LOOM_MANAGED_TAG]: 'true',
      'loom-created-at': new Date().toISOString(),
      ...(input.createdBy ? { 'loom-created-by': input.createdBy } : {}),
    },
    properties: {
      subnet: { id: cfg.peSubnetId },
      // MANUAL connection ⇒ always lands Pending until the target owner approves
      // — the honest governance approval step (never auto-approved here).
      manualPrivateLinkServiceConnections: [
        {
          name: `${input.name}-conn`,
          properties: {
            privateLinkServiceId: target,
            groupIds: [input.groupId],
            requestMessage,
          },
        },
      ],
    },
  };
  const raw = await armPut<any>(`${peBase(cfg, input.name)}?api-version=${PE_API}`, body);
  return shapeManagedPe(raw);
}

/** Delete a managed private endpoint by name via ARM. */
export async function deleteManagedPrivateEndpoint(name: string): Promise<void> {
  const cfg = readNetworkingConfig();
  await armDelete(`${peBase(cfg, name)}?api-version=${PE_API}`);
}

export interface ManagedPeDnsResult {
  registered: boolean;
  zoneName?: string;
  zoneId?: string;
  note?: string;
}

/**
 * Ensure the managed PE carries a `privateDnsZoneGroups` config referencing the
 * matching `privatelink.*` zone — WITHOUT it the endpoint never resolves, even
 * after the target owner approves the connection (adversarial-audit finding:
 * createManagedPrivateEndpoint created the PE but never registered DNS).
 *
 * Idempotent: an already-attached matching zone config is reported without a
 * re-PUT (the PUT itself is also a safe upsert on .../privateDnsZoneGroups/default).
 * Honest when the zone is missing: returns registered:false + a note naming the
 * exact privatelink zone to deploy in the networking RG — never a silent no-op.
 */
export async function ensureManagedPeDnsZoneGroup(
  peName: string,
  groupId: string,
  targetResourceId?: string,
): Promise<ManagedPeDnsResult> {
  const cfg = readNetworkingConfig();
  const expected = privateDnsZoneNameForGroupId(groupId, targetResourceId);
  if (!expected) {
    return {
      registered: false,
      note: `No documented privatelink DNS zone for sub-resource "${groupId}" — register the endpoint's FQDN in your hub private DNS manually.`,
    };
  }
  // Already attached? Report it without another PUT.
  try {
    const j = await armGet<{ value?: any[] }>(`${peBase(cfg, peName)}/privateDnsZoneGroups?api-version=${PE_API}`);
    for (const g of j?.value || []) {
      for (const c of g?.properties?.privateDnsZoneConfigs || []) {
        const zoneId = String(c?.properties?.privateDnsZoneId || '');
        if (zoneId.toLowerCase().endsWith(`/privatednszones/${expected.toLowerCase()}`)) {
          return { registered: true, zoneName: expected, zoneId };
        }
      }
    }
  } catch { /* zone-group list failed — fall through to the attach attempt */ }
  // Resolve the zone's ARM id from the live private DNS zones the Console
  // identity can read (hub networking RG preferred when the zone exists twice).
  const zones = await listPrivateDnsZones();
  const matches = zones.filter((z) => z.name.toLowerCase() === expected.toLowerCase());
  const zone =
    matches.find((z) => (z.resourceGroup || '').toLowerCase() === cfg.networkingRg.toLowerCase()) || matches[0];
  if (!zone?.resourceGroup) {
    return {
      registered: false,
      zoneName: expected,
      note: `Private DNS zone "${expected}" does not exist in the networking resource group "${cfg.networkingRg}" (or anywhere the Console identity can read) — the endpoint will NOT resolve privately. Deploy the zone (platform/fiab/bicep/modules/admin-plane/network.bicep private DNS zones) and link it to the hub VNet, then refresh this endpoint.`,
    };
  }
  const zoneId =
    `/subscriptions/${zone.subscriptionId}/resourceGroups/${encodeURIComponent(zone.resourceGroup)}` +
    `/providers/Microsoft.Network/privateDnsZones/${zone.name}`;
  await createPrivateDnsZoneGroup(peName, zoneId);
  return { registered: true, zoneName: expected, zoneId };
}

// ---------------------------------------------------------------------------
// Storage RESOURCE-INSTANCE rules — trusted workspace access (Phase 4 G6)
// ---------------------------------------------------------------------------
//
// The Azure-native equivalent of Fabric's "trusted workspace access": authorize
// a specific Azure resource INSTANCE (by ARM id + tenant) to reach a firewalled
// ADLS Gen2 / Blob storage account whose networkAcls.defaultAction is Deny.
// ARM models these as `properties.networkAcls.resourceAccessRules[]` entries of
// `{ tenantId, resourceId }` on Microsoft.Storage/storageAccounts (the portal
// calls them "resource instances"). Enforcement matches the managed-identity
// token's `xms_mirid` claim against the rule's resourceId — so a user-assigned
// managed identity (Console UAMI / per-workspace uami-ws-<id>) is authorized by
// adding ITS OWN ARM resource id as a rule.
//
// Real ARM (GET + PATCH, api-version 2023-05-01), no mocks. The PATCH always
// carries the COMPLETE networkAcls object read back from the live account
// (bypass / defaultAction / ipRules / virtualNetworkRules preserved verbatim)
// so a rules-only update can never clobber the rest of the firewall.
//
// The Console UAMI needs **Storage Account Contributor**
// (17d1049b-9a84-46fb-8f53-869881c3d3ab) — or Owner — on the target storage
// account to PATCH networkAcls; a 403 surfaces as an honest MessageBar via
// storageTrustedAccessErrorResponse in _gate.ts.
//
// Learn:
//   https://learn.microsoft.com/azure/storage/common/storage-network-security-resource-instances
//   https://learn.microsoft.com/rest/api/storagerp/storage-accounts/update

/** Storage-account ARM api-version (matches storage-discovery.ts). */
const STORAGE_ACCOUNTS_API = '2023-05-01';

const STORAGE_ACCOUNT_ID_RE =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Storage\/storageAccounts\/[^/]+$/i;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One `networkAcls.resourceAccessRules[]` entry ("resource instance" in the portal). */
export interface StorageResourceInstanceRule {
  tenantId: string;
  resourceId: string;
}

/** Live trusted-access posture of a storage account (shaped from ARM GET/PATCH). */
export interface StorageTrustedAccessState {
  accountId: string;
  accountName: string;
  location?: string;
  /** Enabled | Disabled | SecuredByPerimeter — rules only take effect when Enabled. */
  publicNetworkAccess?: string;
  /** networkAcls.defaultAction: Allow | Deny — rules only matter under Deny. */
  defaultAction?: string;
  /** networkAcls.bypass, e.g. 'AzureServices'. */
  bypass?: string;
  resourceInstances: StorageResourceInstanceRule[];
}

/** Validate + normalize a full storage-account ARM id; honest 400 otherwise. */
export function assertStorageAccountArmId(id: string): string {
  const trimmed = (id || '').trim().replace(/\/+$/, '');
  if (!STORAGE_ACCOUNT_ID_RE.test(trimmed)) {
    throw new NetworkingArmError(
      'storageAccountId must be a full ARM id: /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{name}',
      400,
    );
  }
  return trimmed;
}

function shapeTrustedAccess(raw: any): StorageTrustedAccessState {
  const props = raw?.properties || {};
  const acls = props.networkAcls || {};
  const id: string = raw?.id || '';
  return {
    accountId: id,
    accountName: raw?.name || id.split('/').pop() || '',
    location: raw?.location,
    publicNetworkAccess: props.publicNetworkAccess,
    defaultAction: acls.defaultAction,
    bypass: acls.bypass,
    resourceInstances: (acls.resourceAccessRules || []).map((r: any) => ({
      tenantId: r?.tenantId || '',
      resourceId: r?.resourceId || '',
    })),
  };
}

/** The complete networkAcls object to PATCH back — every sibling field the live
 * account carries is preserved verbatim so a rules-only edit never widens or
 * narrows the rest of the firewall. */
function aclsForPatch(acls: any, resourceAccessRules: StorageResourceInstanceRule[]): any {
  return {
    bypass: acls?.bypass ?? 'AzureServices',
    defaultAction: acls?.defaultAction ?? 'Allow',
    ipRules: acls?.ipRules ?? [],
    virtualNetworkRules: acls?.virtualNetworkRules ?? [],
    resourceAccessRules,
  };
}

/** Read the live resource-instance rules (+ firewall posture) of a storage account. */
export async function getStorageTrustedAccess(storageAccountId: string): Promise<StorageTrustedAccessState> {
  const id = assertStorageAccountArmId(storageAccountId);
  const raw = await armGet<any>(`${id}?api-version=${STORAGE_ACCOUNTS_API}`);
  return shapeTrustedAccess(raw);
}

/**
 * Authorize a resource instance (identity) on the storage account: GET the live
 * networkAcls, append `{ tenantId, resourceId }` to resourceAccessRules, then
 * PATCH the account with the complete acls object. Idempotent — an entry that
 * already exists (case-insensitive) returns the current state without a PATCH.
 */
export async function addStorageResourceInstance(
  storageAccountId: string,
  rule: StorageResourceInstanceRule,
): Promise<StorageTrustedAccessState> {
  const id = assertStorageAccountArmId(storageAccountId);
  const resourceId = (rule.resourceId || '').trim().replace(/\/+$/, '');
  if (!resourceId.startsWith('/subscriptions/')) {
    throw new NetworkingArmError('resourceId must be a full ARM id (/subscriptions/…)', 400);
  }
  if (!GUID_RE.test((rule.tenantId || '').trim())) {
    throw new NetworkingArmError('tenantId must be an Entra tenant GUID', 400);
  }
  const tenantId = rule.tenantId.trim();
  const raw = await armGet<any>(`${id}?api-version=${STORAGE_ACCOUNTS_API}`);
  const acls = raw?.properties?.networkAcls || {};
  const existing: any[] = acls.resourceAccessRules || [];
  const dup = existing.some((r) =>
    String(r?.resourceId || '').toLowerCase() === resourceId.toLowerCase() &&
    String(r?.tenantId || '').toLowerCase() === tenantId.toLowerCase());
  if (dup) return shapeTrustedAccess(raw);
  const next = [
    ...existing.map((r) => ({ tenantId: r?.tenantId, resourceId: r?.resourceId })),
    { tenantId, resourceId },
  ];
  const patched = await armPatch<any>(`${id}?api-version=${STORAGE_ACCOUNTS_API}`, {
    properties: { networkAcls: aclsForPatch(acls, next) },
  });
  return shapeTrustedAccess(patched);
}

/**
 * Revoke a resource-instance rule: GET the live networkAcls, drop the matching
 * `{ resourceId (, tenantId) }` entry, PATCH the complete acls back. Honest 404
 * when no rule matches (nothing is PATCHed).
 */
export async function removeStorageResourceInstance(
  storageAccountId: string,
  resourceId: string,
  tenantId?: string,
): Promise<StorageTrustedAccessState> {
  const id = assertStorageAccountArmId(storageAccountId);
  const target = (resourceId || '').trim().replace(/\/+$/, '').toLowerCase();
  if (!target.startsWith('/subscriptions/')) {
    throw new NetworkingArmError('resourceId must be a full ARM id (/subscriptions/…)', 400);
  }
  const raw = await armGet<any>(`${id}?api-version=${STORAGE_ACCOUNTS_API}`);
  const acls = raw?.properties?.networkAcls || {};
  const existing: any[] = acls.resourceAccessRules || [];
  const remaining = existing.filter((r) => {
    const ridMatch = String(r?.resourceId || '').replace(/\/+$/, '').toLowerCase() === target;
    const tidMatch = !tenantId ||
      String(r?.tenantId || '').toLowerCase() === tenantId.trim().toLowerCase();
    return !(ridMatch && tidMatch);
  });
  if (remaining.length === existing.length) {
    throw new NetworkingArmError('Resource-instance rule not found on the storage account', 404);
  }
  const patched = await armPatch<any>(`${id}?api-version=${STORAGE_ACCOUNTS_API}`, {
    properties: {
      networkAcls: aclsForPatch(
        acls,
        remaining.map((r) => ({ tenantId: r?.tenantId, resourceId: r?.resourceId })),
      ),
    },
  });
  return shapeTrustedAccess(patched);
}
