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

const ARM = armBase();
const ARM_SCOPE = armScope();
// NSG + security rules share the same API version network.bicep declares.
const NSG_API = '2024-05-01';
// Private endpoints + DNS zone groups — same version network-discovery.ts uses.
const PE_API = '2024-03-01';

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
