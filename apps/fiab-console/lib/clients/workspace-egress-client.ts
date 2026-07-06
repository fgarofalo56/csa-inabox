/**
 * workspace-egress-client — workspace OUTBOUND ACCESS PROTECTION (rel-T89).
 *
 * Azure-native parity with Microsoft Fabric's "workspace outbound access
 * protection" (GA March 2026): a per-workspace allow-list of outbound
 * destinations for the workspace's data-plane compute, enforced on the REAL
 * Azure control plane — NO Fabric / Power BI dependency (no-fabric-dependency.md).
 *
 * WHERE THE ALLOW-LIST IS ENFORCED (real ARM REST — no mocks):
 *   The admin picks the workspace compute subnet's Network Security Group (from
 *   the NSGs the Console identity can read) and defines an allow-list of
 *   destinations. Each destination compiles to a REAL outbound NSG security rule
 *   written to that NSG:
 *     - service-tag  → Allow Outbound to a documented Azure service tag
 *                       (destinationAddressPrefix = "Storage" / "Sql" /
 *                       "AzureActiveDirectory" / "AzureKeyVault" / …). NSG
 *                       supports service tags natively.
 *     - ip (CIDR)    → Allow Outbound to an IPv4 CIDR / address.
 *   When `defaultDeny` is on, a final low-precedence Deny-Outbound-to-Internet
 *   rule is written so ONLY the allow-list can egress — the crux of outbound
 *   access protection. The allow rules sit at lower priority numbers (higher
 *   precedence) so they win over the deny.
 *
 *   FQDN destinations cannot be enforced by an NSG (Azure NSGs match IPs /
 *   service tags, not hostnames) — they need an Azure Firewall application rule.
 *   Per no-vaporware.md this is surfaced as an HONEST GATE: the FQDN is stored on
 *   the policy and returned in the reconcile receipt under `firewallRequired`
 *   with the exact remediation (deploy an Azure Firewall + application rule).
 *   Service-tag + CIDR destinations are enforced for real regardless.
 *
 *   PUT/GET/DELETE .../networkSecurityGroups/{nsg}/securityRules/{name}
 *   (api-version 2024-05-01). Auth: ChainedTokenCredential(UAMI →
 *   DefaultAzureCredential) on the ARM scope — the Console UAMI needs **Network
 *   Contributor** on the RG owning the chosen NSG (network.bicep grants it on the
 *   admin networking RG). A 403 surfaces as an honest MessageBar naming the role.
 *
 * The policy set is stored in Cosmos (`workspace-egress-policies`, partitioned by
 * /workspaceId) — a parallel, self-wired container (mirrors
 * protection-policy-client.ts; does NOT edit cosmos-client.ts). The compile /
 * validation core is PURE (compileEgressRules / validateEgressPolicy /
 * normalizeEgressPolicy) so the tests need no Azure backend.
 *
 * Learn:
 *   https://learn.microsoft.com/fabric/security/workspace-outbound-access-protection-overview
 *   https://learn.microsoft.com/azure/virtual-network/network-security-groups-overview
 *   https://learn.microsoft.com/azure/virtual-network/service-tags-overview
 *   https://learn.microsoft.com/rest/api/virtualnetwork/security-rules/create-or-update
 */

import { CosmosClient, type Container } from '@azure/cosmos';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { isValidCidr, nextPriority } from '@/lib/clients/networking-client';
import { listNetworkSecurityGroups, type NsgInfo } from '@/lib/azure/network-discovery';
import { auditLogContainer } from '@/lib/azure/cosmos-client';

const ARM_SCOPE = armScope();
const NSG_API = '2024-05-01';

// ── Types ────────────────────────────────────────────────────────────────────

export type EgressDestinationType = 'service-tag' | 'ip' | 'fqdn';

export interface EgressDestination {
  /** Stable id for the destination row (client-generated or derived). */
  id: string;
  type: EgressDestinationType;
  /** Service tag name, IPv4 CIDR/address, or FQDN — per {@link type}. */
  value: string;
  /** Optional human label shown in the UI. */
  label?: string;
  /** L4 protocol for the compiled rule (service-tag/fqdn default Tcp; ip default *). */
  protocol?: '*' | 'Tcp' | 'Udp';
  /** Destination port(s), e.g. '443' or '443,1433' or '*'. Default 443 for
   * service-tag/fqdn, '*' for ip. */
  ports?: string;
}

export interface WorkspaceEgressPolicy {
  id: string;
  /** Partition key — the Loom workspace / governance domain the policy scopes. */
  workspaceId: string;
  /** Display name for the workspace/policy. */
  workspaceName?: string;
  /** Full ARM id of the NSG on the workspace compute subnet the rules target. */
  nsgId: string;
  /** Friendly NSG name (last id segment) — display only. */
  nsgName?: string;
  /** When true, write a final Deny-Outbound-to-Internet rule so ONLY the
   * allow-list can egress (outbound access protection). Default true. */
  defaultDeny: boolean;
  /** The exhaustive outbound allow-list. */
  destinations: EgressDestination[];
  tenantId: string;
  updatedAt: string;
  updatedBy?: string;
}

export interface WorkspaceEgressPolicyInput {
  id?: string;
  workspaceId: string;
  workspaceName?: string;
  nsgId: string;
  nsgName?: string;
  defaultDeny?: boolean;
  destinations?: Array<Partial<EgressDestination>>;
}

/**
 * A curated set of the most common Azure service tags a data-plane workspace
 * egresses to. This is the DROPDOWN VOCABULARY (no freeform) — every value is a
 * real Azure service tag accepted verbatim by an NSG's destinationAddressPrefix.
 * Regional variants (e.g. `Storage.eastus`) are also valid; the UI lets the admin
 * append a region. Grounded in the Service Tags reference (Learn).
 */
export const AZURE_SERVICE_TAGS: { value: string; label: string }[] = [
  { value: 'AzureActiveDirectory', label: 'Microsoft Entra ID (sign-in / tokens)' },
  { value: 'AzureResourceManager', label: 'Azure Resource Manager (control plane)' },
  { value: 'Storage', label: 'Azure Storage (Blob / ADLS Gen2 / OneLake)' },
  { value: 'Sql', label: 'Azure SQL / Synapse SQL' },
  { value: 'AzureKeyVault', label: 'Azure Key Vault' },
  { value: 'AzureMonitor', label: 'Azure Monitor / Log Analytics' },
  { value: 'AzureContainerRegistry', label: 'Azure Container Registry' },
  { value: 'AzureCosmosDB', label: 'Azure Cosmos DB' },
  { value: 'AzureDataExplorer', label: 'Azure Data Explorer (ADX / Kusto)' },
  { value: 'EventHub', label: 'Azure Event Hubs' },
  { value: 'ServiceBus', label: 'Azure Service Bus' },
  { value: 'AzureMachineLearning', label: 'Azure Machine Learning' },
  { value: 'AzureDatabricks', label: 'Azure Databricks control plane' },
  { value: 'AzureActiveDirectoryDomainServices', label: 'Entra Domain Services' },
  { value: 'EventGrid', label: 'Azure Event Grid' },
  { value: 'AzureFrontDoor.Frontend', label: 'Azure Front Door' },
  { value: 'MicrosoftContainerRegistry', label: 'Microsoft Container Registry (mcr)' },
  { value: 'AzureCloud', label: 'Azure Cloud (all public Azure — broad)' },
  { value: 'Internet', label: 'Internet (broad — any public destination)' },
];

const SERVICE_TAG_SET = new Set(AZURE_SERVICE_TAGS.map((t) => t.value.toLowerCase()));

// ── Pure validators / compilers (no Azure) ───────────────────────────────────

/** Loose RFC-1123 hostname / wildcard-FQDN check (e.g. `contoso.com`,
 * `*.blob.core.windows.net`). Rejects schemes, spaces, and paths. */
export function isValidFqdn(fqdn: string): boolean {
  if (typeof fqdn !== 'string') return false;
  const v = fqdn.trim();
  if (!v || v.length > 253 || /\s|[/:@]/.test(v)) return false;
  return /^(\*\.)?([a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/.test(v);
}

/** True when a value is a documented Azure service tag (optionally region-scoped
 * like `Storage.eastus`). Case-insensitive on the base tag. */
export function isKnownServiceTag(value: string): boolean {
  const base = String(value || '').split('.')[0].toLowerCase();
  return SERVICE_TAG_SET.has(base);
}

/** Validate one destination. Returns the first error, or null when valid. */
export function validateDestination(d: Partial<EgressDestination>): string | null {
  if (!d || !d.type) return 'destination type required';
  const value = String(d.value || '').trim();
  if (!value) return 'destination value required';
  if (d.type === 'service-tag') {
    if (!isKnownServiceTag(value)) return `unknown Azure service tag: ${value}`;
  } else if (d.type === 'ip') {
    if (!isValidCidr(value)) return `invalid IPv4 CIDR / address: ${value}`;
  } else if (d.type === 'fqdn') {
    if (!isValidFqdn(value)) return `invalid FQDN: ${value}`;
  } else {
    return `unknown destination type: ${d.type}`;
  }
  if (d.protocol && !['*', 'Tcp', 'Udp'].includes(d.protocol)) return `invalid protocol: ${d.protocol}`;
  return null;
}

/** Validate an incoming policy. Returns the first error, or null when valid. */
export function validateEgressPolicy(p: WorkspaceEgressPolicyInput): string | null {
  if (!p) return 'policy body required';
  if (!String(p.workspaceId || '').trim()) return 'workspaceId required';
  if (!String(p.nsgId || '').trim()) return 'nsgId required';
  if (!/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/networkSecurityGroups\/[^/]+$/i.test(String(p.nsgId).trim())) {
    return 'nsgId must be a full ARM id of a Microsoft.Network/networkSecurityGroups resource';
  }
  for (const d of p.destinations || []) {
    const err = validateDestination(d);
    if (err) return err;
  }
  return null;
}

/** Deterministic destination id (stable across edits so rule names don't churn). */
function destinationId(type: EgressDestinationType, value: string): string {
  return `${type}:${value.trim().toLowerCase()}`;
}

/** Normalize an input into a stored policy (pure). defaultDeny defaults to true. */
export function normalizeEgressPolicy(
  p: WorkspaceEgressPolicyInput,
  ctx: { tenantId: string; updatedBy?: string; now?: string },
): WorkspaceEgressPolicy {
  const workspaceId = String(p.workspaceId).trim();
  const seen = new Set<string>();
  const destinations: EgressDestination[] = [];
  for (const raw of p.destinations || []) {
    const type = raw.type as EgressDestinationType;
    const value = String(raw.value || '').trim();
    if (!type || !value) continue;
    const id = destinationId(type, value);
    if (seen.has(id)) continue;
    seen.add(id);
    const defaultPorts = type === 'ip' ? '*' : '443';
    const defaultProto = type === 'ip' ? '*' : 'Tcp';
    destinations.push({
      id,
      type,
      value,
      label: raw.label ? String(raw.label).trim() : undefined,
      protocol: (raw.protocol as EgressDestination['protocol']) || (defaultProto as EgressDestination['protocol']),
      ports: raw.ports ? String(raw.ports).trim() : defaultPorts,
    });
  }
  const nsgId = String(p.nsgId).trim();
  return {
    id: (p.id && String(p.id).trim()) || `egress:${workspaceId}`,
    workspaceId,
    workspaceName: p.workspaceName ? String(p.workspaceName).trim() : undefined,
    nsgId,
    nsgName: p.nsgName ? String(p.nsgName).trim() : nsgId.split('/').pop(),
    defaultDeny: p.defaultDeny !== false,
    destinations,
    tenantId: ctx.tenantId,
    updatedAt: ctx.now || new Date().toISOString(),
    updatedBy: ctx.updatedBy,
  };
}

/** ARM-safe NSG rule name for an egress destination. Prefix `loom-egress-` so
 * reconcile only ever manages ITS OWN rules (never the F15 `loom-ws-` rules or a
 * hand-authored rule). ARM allows `^[a-zA-Z0-9][a-zA-Z0-9\-._]{0,78}[a-zA-Z0-9_]$`. */
export function egressRuleName(workspaceId: string, dest: EgressDestination): string {
  const wsSlug = (workspaceId || 'ws').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'ws';
  const valSlug = dest.value.replace(/[.*/]/g, '-').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
  let name = `loom-egress-${wsSlug}-${dest.type === 'service-tag' ? 'tag' : 'ip'}-${valSlug}`;
  if (name.length > 80) name = name.slice(0, 80);
  return name.replace(/[^a-zA-Z0-9_]+$/, '');
}

/** Deny-all-outbound-to-Internet rule name for a workspace. */
export function egressDenyRuleName(workspaceId: string): string {
  const wsSlug = (workspaceId || 'ws').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'ws';
  return `loom-egress-${wsSlug}-deny-internet`;
}

export interface CompiledEgressRule {
  name: string;
  access: 'Allow' | 'Deny';
  protocol: '*' | 'Tcp' | 'Udp';
  /** NSG destinationAddressPrefix — a service tag or a CIDR/address. */
  destinationAddressPrefix: string;
  destinationPortRange: string;
  description: string;
}

export interface CompiledEgress {
  /** Outbound Allow rules for enforceable (service-tag / ip) destinations. */
  allowRules: CompiledEgressRule[];
  /** The final Deny-Internet rule, when defaultDeny is on. */
  denyRule: CompiledEgressRule | null;
  /** FQDN destinations that need an Azure Firewall (honest gate, not NSG-enforceable). */
  firewallRequired: EgressDestination[];
}

/**
 * PURE: compile a policy into the NSG outbound rules to write (no priorities —
 * those are assigned live at reconcile so they never collide with rules already
 * on the target NSG). service-tag + ip become Allow rules; fqdn is collected as
 * firewallRequired (honest gate). defaultDeny yields the final Deny-Internet rule.
 */
export function compileEgressRules(policy: WorkspaceEgressPolicy): CompiledEgress {
  const allowRules: CompiledEgressRule[] = [];
  const firewallRequired: EgressDestination[] = [];
  for (const d of policy.destinations) {
    if (d.type === 'fqdn') { firewallRequired.push(d); continue; }
    allowRules.push({
      name: egressRuleName(policy.workspaceId, d),
      access: 'Allow',
      protocol: d.protocol || (d.type === 'ip' ? '*' : 'Tcp'),
      destinationAddressPrefix: d.value,
      destinationPortRange: d.ports || (d.type === 'ip' ? '*' : '443'),
      description: `Loom egress allow: ${d.label || d.value} (workspace ${policy.workspaceId})`,
    });
  }
  const denyRule: CompiledEgressRule | null = policy.defaultDeny
    ? {
        name: egressDenyRuleName(policy.workspaceId),
        access: 'Deny',
        protocol: '*',
        destinationAddressPrefix: 'Internet',
        destinationPortRange: '*',
        description: `Loom egress default-deny to Internet (workspace ${policy.workspaceId})`,
      }
    : null;
  return { allowRules, denyRule, firewallRequired };
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class EgressArmError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'EgressArmError';
    this.status = status;
    this.body = body;
  }
}

// ── ARM wiring (writes to an arbitrary NSG by its full ARM id) ────────────────

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const armCredential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function armToken(): Promise<string> {
  const t = await armCredential.getToken(ARM_SCOPE);
  if (!t?.token) throw new EgressArmError('Failed to acquire ARM token', 401);
  return t.token;
}

async function armReq<T>(method: string, path: string, body?: unknown): Promise<T> {
  const tk = await armToken();
  const url = path.startsWith('http') ? path : `${armBase()}${path}`;
  const res = await fetchWithTimeout(url, {
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
    throw new EgressArmError(msg, res.status, json);
  }
  return (json as T) ?? ({} as T);
}

/** The custom security rules currently on the target NSG (name + priority). */
async function listNsgSecurityRules(nsgId: string): Promise<{ name: string; priority: number; direction: string }[]> {
  const j = await armReq<{ value?: any[] }>('GET', `${nsgId}/securityRules?api-version=${NSG_API}`);
  return (j?.value || []).map((r: any) => ({
    name: r?.name || '',
    priority: Number(r?.properties?.priority) || 0,
    direction: r?.properties?.direction || '',
  }));
}

async function putNsgSecurityRule(
  nsgId: string,
  rule: CompiledEgressRule,
  priority: number,
): Promise<void> {
  const body = {
    properties: {
      priority,
      direction: 'Outbound',
      access: rule.access,
      protocol: rule.protocol,
      sourceAddressPrefix: '*',
      sourcePortRange: '*',
      destinationAddressPrefix: rule.destinationAddressPrefix,
      destinationPortRange: rule.destinationPortRange,
      description: rule.description.slice(0, 140),
    },
  };
  await armReq('PUT', `${nsgId}/securityRules/${encodeURIComponent(rule.name)}?api-version=${NSG_API}`, body);
}

async function deleteNsgSecurityRule(nsgId: string, name: string): Promise<void> {
  try {
    await armReq('DELETE', `${nsgId}/securityRules/${encodeURIComponent(name)}?api-version=${NSG_API}`);
  } catch (e) {
    if (!(e instanceof EgressArmError && e.status === 404)) throw e;
  }
}

// ── Cosmos wiring (parallel container; does NOT edit cosmos-client.ts) ─────────

let _client: CosmosClient | null = null;
let _container: Container | null = null;

function cosmosEndpoint(): string {
  const v = process.env.LOOM_COSMOS_ENDPOINT;
  if (!v) throw new Error('LOOM_COSMOS_ENDPOINT is not configured');
  return v;
}
function cosmosCredential() {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const chain: any[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  chain.push(new DefaultAzureCredential());
  return new ChainedTokenCredential(new AcaManagedIdentityCredential(), ...chain);
}
function cosmos(): CosmosClient {
  if (_client) return _client;
  _client = new CosmosClient({ endpoint: cosmosEndpoint(), aadCredentials: cosmosCredential() });
  return _client;
}
async function container(): Promise<Container> {
  if (_container) return _container;
  const c = cosmos();
  const { database } = await c.databases.createIfNotExists({ id: process.env.LOOM_COSMOS_DATABASE || 'loom' });
  _container = (
    await database.containers.createIfNotExists({
      id: 'workspace-egress-policies',
      partitionKey: { paths: ['/workspaceId'] },
    })
  ).container;
  return _container;
}

/** List every egress policy for a tenant (cross-partition, tenant-scoped). */
export async function listEgressPolicies(tenantId: string): Promise<WorkspaceEgressPolicy[]> {
  const c = await container();
  const { resources } = await c.items
    .query<WorkspaceEgressPolicy>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources;
}

/** Point-read one policy by id within its workspace partition. */
export async function getEgressPolicy(id: string, workspaceId: string): Promise<WorkspaceEgressPolicy | null> {
  const c = await container();
  try {
    const { resource } = await c.item(id, workspaceId).read<WorkspaceEgressPolicy>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Upsert a normalized policy. */
export async function upsertEgressPolicy(policy: WorkspaceEgressPolicy): Promise<WorkspaceEgressPolicy> {
  const c = await container();
  const { resource } = await c.items.upsert<WorkspaceEgressPolicy>(policy);
  return (resource as WorkspaceEgressPolicy) ?? policy;
}

/** Delete a policy doc by id + workspaceId. Idempotent (404 → ok). */
export async function deleteEgressPolicyDoc(id: string, workspaceId: string): Promise<void> {
  const c = await container();
  try {
    await c.item(id, workspaceId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}

// ── NSG candidates for the picker (Reader on the NSGs) ────────────────────────

export interface EgressNsgOption {
  id: string;
  name: string;
  resourceGroup?: string;
  location?: string;
  /** Subnets this NSG is attached to (helps the admin identify the compute subnet). */
  subnets: string[];
}

/** Every NSG the Console identity can read, shaped for the workspace picker. */
export async function listEgressCandidateNsgs(): Promise<EgressNsgOption[]> {
  const nsgs: NsgInfo[] = await listNetworkSecurityGroups();
  return nsgs.map((n) => ({
    id: n.id,
    name: n.name,
    resourceGroup: n.resourceGroup,
    location: n.location,
    subnets: (n.subnetIds || []).map((s) => s.split('/').pop() || s),
  }));
}

// ── Reconcile (real NSG converge or honest gate) ──────────────────────────────

export interface EgressReconcileReceipt {
  status: 'converged' | 'partial' | 'gated';
  policyId: string;
  workspaceId: string;
  nsgName?: string;
  rulesWritten: number;
  rulesRevoked: number;
  /** FQDN destinations that need an Azure Firewall (honest gate). */
  firewallRequired: string[];
  errors: number;
  gate?: string;
  detail: string[];
  at: string;
}

/** Every loom-egress-managed rule name currently on the NSG for THIS workspace. */
function managedRuleNamesFor(workspaceId: string, live: { name: string }[]): Set<string> {
  const wsSlug = (workspaceId || 'ws').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16).toLowerCase();
  const wsSlug10 = wsSlug.slice(0, 10);
  return new Set(
    live
      .map((r) => r.name)
      .filter((n) => {
        const lower = n.toLowerCase();
        return lower.startsWith(`loom-egress-${wsSlug10}-`) || lower === `loom-egress-${wsSlug}-deny-internet`;
      }),
  );
}

/**
 * Converge the workspace's egress allow-list onto its NSG. Compiles the policy,
 * reads the live rules, PUTs each target rule (reusing an existing rule's
 * priority so re-reconcile doesn't churn priorities), and DELETEs any prior
 * loom-egress rule for this workspace that is no longer in the target. Writes a
 * receipt to the audit log. Idempotent. Honest gate on a 403 (Network
 * Contributor) / config error — never a silent no-op.
 */
export async function reconcileEgressPolicy(policy: WorkspaceEgressPolicy): Promise<EgressReconcileReceipt> {
  const at = new Date().toISOString();
  const detail: string[] = [];
  const compiled = compileEgressRules(policy);
  const targetRules: CompiledEgressRule[] = [
    ...compiled.allowRules,
    ...(compiled.denyRule ? [compiled.denyRule] : []),
  ];
  const firewallRequired = compiled.firewallRequired.map((d) => d.value);

  let live: { name: string; priority: number; direction: string }[];
  try {
    live = await listNsgSecurityRules(policy.nsgId);
  } catch (e) {
    const status = e instanceof EgressArmError ? e.status : 0;
    const gate =
      status === 403 || status === 401
        ? `The Console identity lacks Network Contributor on the resource group owning "${policy.nsgName || policy.nsgId.split('/').pop()}". Grant Network Contributor (4d97b98b-1d4f-4787-a291-c67834d212e7) on that RG so egress rules can be reconciled.`
        : `Could not read the NSG "${policy.nsgName || policy.nsgId.split('/').pop()}": ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`;
    const receipt: EgressReconcileReceipt = {
      status: 'gated', policyId: policy.id, workspaceId: policy.workspaceId, nsgName: policy.nsgName,
      rulesWritten: 0, rulesRevoked: 0, firewallRequired, errors: 0, gate, detail, at,
    };
    await writeReceipt(policy, receipt);
    return receipt;
  }

  const liveByName = new Map(live.map((r) => [r.name, r]));
  const usedPriorities = new Set(live.filter((r) => r.direction === 'Outbound').map((r) => r.priority));
  const targetNames = new Set(targetRules.map((r) => r.name));

  let rulesWritten = 0;
  let rulesRevoked = 0;
  let errors = 0;
  let gate: string | undefined;

  // Write allow rules first (low priority band, higher precedence), deny last.
  for (const rule of targetRules) {
    // Reuse the rule's existing priority when it's already present (no churn);
    // otherwise take the next free outbound slot. The deny rule sits high (4000+)
    // so every allow rule wins over it.
    let priority = liveByName.get(rule.name)?.priority ?? 0;
    if (!priority) {
      const base = rule.access === 'Deny' ? 4000 : 300;
      priority = nextPriority([...usedPriorities], base, 10);
      usedPriorities.add(priority);
    }
    if (priority >= 4096) {
      gate = gate || `NSG "${policy.nsgName}" has no free outbound priority slot (< 4096) — remove unused rules before adding more.`;
      break;
    }
    try {
      await putNsgSecurityRule(policy.nsgId, rule, priority);
      rulesWritten++;
    } catch (e) {
      const status = e instanceof EgressArmError ? e.status : 0;
      if (status === 403 || status === 401) {
        gate = gate || `The Console identity lacks Network Contributor on the RG owning "${policy.nsgName}". Grant Network Contributor to reconcile egress rules.`;
        break;
      }
      errors++;
      detail.push(`write ${rule.name} failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  }

  // Revoke stale loom-egress rules for this workspace that are no longer targeted.
  if (!gate) {
    const managed = managedRuleNamesFor(policy.workspaceId, live);
    for (const name of managed) {
      if (targetNames.has(name)) continue;
      try {
        await deleteNsgSecurityRule(policy.nsgId, name);
        rulesRevoked++;
      } catch (e) {
        errors++;
        detail.push(`revoke ${name} failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      }
    }
  }

  const status: EgressReconcileReceipt['status'] = gate ? 'gated' : errors ? 'partial' : 'converged';
  const receipt: EgressReconcileReceipt = {
    status, policyId: policy.id, workspaceId: policy.workspaceId, nsgName: policy.nsgName,
    rulesWritten, rulesRevoked, firewallRequired, errors, gate, detail, at,
  };
  await writeReceipt(policy, receipt);
  return receipt;
}

/** Revoke ALL loom-egress rules for a workspace (used on policy delete). */
export async function revokeAllEgressRules(policy: WorkspaceEgressPolicy): Promise<number> {
  const live = await listNsgSecurityRules(policy.nsgId);
  const managed = managedRuleNamesFor(policy.workspaceId, live);
  let revoked = 0;
  for (const name of managed) {
    await deleteNsgSecurityRule(policy.nsgId, name);
    revoked++;
  }
  return revoked;
}

async function writeReceipt(policy: WorkspaceEgressPolicy, receipt: EgressReconcileReceipt): Promise<void> {
  try {
    const aud = await auditLogContainer();
    await aud.items.upsert({
      id: `egress-reconcile:${policy.id}:${receipt.at}`,
      itemId: policy.workspaceId,
      kind: 'workspace-egress-reconcile',
      tenantId: policy.tenantId,
      ...receipt,
    });
  } catch { /* audit best-effort */ }
}
