/**
 * Private-endpoint / private-DNS discovery over Azure Resource Manager (ARM).
 *
 * Loom deploys most backing services with `publicNetworkAccess=Disabled` and a
 * private endpoint + private DNS zone (linked to the hub VNet) — so the console
 * reaches them privately. Developers who need to reach those services DIRECTLY
 * (Synapse Studio, SSMS, Storage Explorer, az cli) from outside the app — e.g.
 * over the corporate VPN — must resolve the service's public FQDN to its
 * PRIVATE endpoint IP. This helper enumerates every private endpoint the
 * Console identity can read and returns the exact FQDN→private-IP mappings
 * (from the PE's `customDnsConfigs`) plus the `privatelink.*` zone each needs,
 * which the Network page turns into a copy/paste hosts-file block + enterprise
 * DNS-forwarder instructions.
 *
 * Real ARM REST — no mocks:
 *   GET /subscriptions/{sub}/providers/Microsoft.Network/privateEndpoints
 *       ?api-version=2024-03-01
 *   → properties.customDnsConfigs[{fqdn, ipAddresses[]}]  (fqdn→private IP)
 *   → properties.privateLinkServiceConnections[].properties.{privateLinkServiceId, groupIds}
 *
 * Auth: ChainedTokenCredential(UAMI → DefaultAzureCredential) on the ARM scope.
 * Needs Reader (Microsoft.Network/privateEndpoints/read) on the subscription/RGs.
 *
 * Learn: https://learn.microsoft.com/rest/api/virtualnetwork/private-endpoints/list-by-subscription
 *        https://learn.microsoft.com/azure/dns/private-dns-overview
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import {
  armBase, armScope, stripArmBase, detectLoomCloud, cloudBoundaryLabel,
  type LoomCloud,
} from './cloud-endpoints';
import { DOMAIN_TAG_KEY } from './domain-registry';

const ARM_SCOPE = armScope();
const SUBSCRIPTIONS_API = '2022-12-01';
const PE_API = '2024-03-01';
const NIC_API = '2024-03-01';
const NSG_API = '2024-05-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class NetworkDiscoveryError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'NetworkDiscoveryError';
    this.status = status;
    this.body = body;
  }
}

export interface PrivateDnsRecord {
  /** Public service FQDN (what clients resolve), e.g. `myws.sql.azuresynapse.net`. */
  fqdn: string;
  /** Private endpoint IP(s) the FQDN must resolve to. */
  ips: string[];
  /** The `privatelink.*` zone this FQDN belongs to (for DNS forwarders). */
  zone: string;
}

export interface PrivateEndpointInfo {
  id: string;
  name: string;
  resourceGroup?: string;
  subscriptionId: string;
  location?: string;
  /** ARM id of the resource the PE connects to. */
  connectedResourceId?: string;
  /** Friendly name of the connected resource (last id segment). */
  connectedResourceName?: string;
  /** ARM resource type of the connected backing service, resolved via Azure
   * Resource Graph (e.g. `Microsoft.Synapse/workspaces`). Lets the topology label
   * each PE with the Loom logical service it fronts, not just the raw name. */
  connectedResourceType?: string;
  /** Loom domain id the backing service is tagged with (the `loom-domain`
   * chargeback tag dlz-attach stamps), resolved via Azure Resource Graph.
   * undefined for shared/admin-plane resources or when ARG is unreadable. */
  loomDomain?: string;
  /** Sub-resource group(s), e.g. ['sqlServer'] / ['blob'] / ['Dev']. */
  groupIds: string[];
  /** Provisioning + connection state. */
  state?: string;
  /** ARM id of the subnet the PE's NIC lives in (`properties.subnet.id`) — the
   * authoritative key for drawing accurate PE→subnet topology edges. */
  subnetId?: string;
  /** Friendly subnet name (last id segment of {@link subnetId}). */
  subnetName?: string;
  /** FQDN→IP→zone mappings derived from customDnsConfigs. */
  dns: PrivateDnsRecord[];
  /** Private IP(s) on the endpoint NIC — the authoritative IP for the hosts file
   * when a customDnsConfig has an FQDN but no echoed ipAddresses. */
  nicIps?: string[];
  /** Internal: the NIC ARM id, resolved to nicIps in a second pass. */
  _nicId?: string;
}

async function armToken(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new NetworkDiscoveryError('Failed to acquire ARM token', 401);
  return t.token;
}

async function armGet<T = any>(path: string): Promise<T> {
  const token = await armToken();
  const res = await fetchWithTimeout(`${armBase()}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message ||
      (typeof json === 'string' ? json : `ARM GET ${path} failed ${res.status}`);
    throw new NetworkDiscoveryError(msg, res.status, json);
  }
  return (json as T) ?? ({} as T);
}

async function armList<T = any>(firstPath: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = firstPath;
  let guard = 0;
  while (next && guard < 50) {
    guard += 1;
    const path: string = stripArmBase(next);
    const page: { value?: T[]; nextLink?: string } =
      await armGet<{ value?: T[]; nextLink?: string }>(path);
    if (Array.isArray(page.value)) out.push(...page.value);
    next = page.nextLink || null;
  }
  return out;
}

async function targetSubscriptionIds(): Promise<string[]> {
  const single = process.env.LOOM_SUBSCRIPTION_ID;
  if (single) return [single.trim()];
  const subs = await armList<{ subscriptionId: string }>(`/subscriptions?api-version=${SUBSCRIPTIONS_API}`);
  return subs.map((s) => s.subscriptionId).filter(Boolean);
}

/** Derive the `privatelink.*` zone for a public FQDN by prefixing `privatelink.`
 * after the leading resource-name label (the documented mapping for most
 * services: `<name>.sql.azuresynapse.net` → `privatelink.sql.azuresynapse.net`). */
export function privatelinkZoneFor(fqdn: string): string {
  const parts = fqdn.split('.');
  if (parts.length <= 2) return `privatelink.${fqdn}`;
  if (parts[1] === 'privatelink') return parts.slice(1).join('.');
  return `privatelink.${parts.slice(1).join('.')}`;
}

function shape(raw: any, subscriptionId: string): PrivateEndpointInfo {
  const id: string = raw?.id || '';
  const rg = /\/resourceGroups\/([^/]+)\//i.exec(id)?.[1];
  const conns: any[] = raw?.properties?.privateLinkServiceConnections
    || raw?.properties?.manualPrivateLinkServiceConnections || [];
  const conn = conns[0]?.properties || {};
  const connId: string | undefined = conn.privateLinkServiceId;
  const groupIds: string[] = conns.flatMap((c: any) => c?.properties?.groupIds || []);
  // Keep EVERY customDnsConfig FQDN (even when ipAddresses is empty — common when
  // the IP is registered in a private DNS zone group rather than echoed back). The
  // missing IPs are filled from the endpoint NIC in a second pass, so the hosts
  // file covers all endpoints (SQL, Synapse, Storage, KV, …) — not just the few
  // that happen to echo an IP here.
  const dnsConfigs: any[] = raw?.properties?.customDnsConfigs || [];
  const dns: PrivateDnsRecord[] = dnsConfigs
    .filter((d) => d?.fqdn)
    .map((d) => ({
      fqdn: d.fqdn,
      ips: Array.isArray(d.ipAddresses) ? d.ipAddresses : [],
      zone: privatelinkZoneFor(d.fqdn),
    }));
  const subnetId: string | undefined = raw?.properties?.subnet?.id;
  return {
    id,
    name: raw?.name || id.split('/').pop() || 'private-endpoint',
    resourceGroup: rg,
    subscriptionId,
    location: raw?.location,
    connectedResourceId: connId,
    connectedResourceName: connId ? connId.split('/').pop() : undefined,
    groupIds,
    state: conns[0]?.properties?.privateLinkServiceConnectionState?.status || raw?.properties?.provisioningState,
    subnetId,
    subnetName: subnetId ? subnetId.split('/').pop() : undefined,
    dns,
    _nicId: raw?.properties?.networkInterfaces?.[0]?.id,
  };
}

/** Resolve the private IP(s) on a private-endpoint NIC. */
async function nicPrivateIps(nicId: string): Promise<string[]> {
  try {
    const nic = await armGet<any>(`${nicId}?api-version=${NIC_API}`);
    const ips = (nic?.properties?.ipConfigurations || [])
      .map((c: any) => c?.properties?.privateIPAddress)
      .filter(Boolean);
    return ips;
  } catch { return []; }
}

/**
 * Every private endpoint the Console identity can read across the target
 * subscription(s). Per-subscription failures are swallowed so one inaccessible
 * sub doesn't blank the list. Throws {@link NetworkDiscoveryError} only when the
 * initial subscription enumeration / token acquisition fails — the BFF turns
 * that into an honest MessageBar gate naming the Reader role to grant.
 */
export async function listPrivateEndpoints(): Promise<PrivateEndpointInfo[]> {
  const subs = await targetSubscriptionIds();
  const all: PrivateEndpointInfo[] = [];
  for (const sub of subs) {
    let raws: any[] = [];
    try {
      raws = await armList<any>(
        `/subscriptions/${sub}/providers/Microsoft.Network/privateEndpoints?api-version=${PE_API}`,
      );
    } catch { continue; }
    for (const r of raws) all.push(shape(r, sub));
  }
  // Second pass: for any endpoint whose DNS records have no echoed IP, resolve the
  // NIC private IP and fill it in — so EVERY endpoint contributes a hosts entry.
  await Promise.all(all.map(async (pe) => {
    const needsIp = pe.dns.some((d) => !d.ips.length);
    if (!needsIp || !pe._nicId) return;
    const ips = await nicPrivateIps(pe._nicId);
    pe.nicIps = ips;
    if (ips.length) {
      for (const d of pe.dns) if (!d.ips.length) d.ips = ips;
    }
  }));
  all.forEach((pe) => { delete pe._nicId; });
  all.sort((a, b) => (a.connectedResourceName || a.name).localeCompare(b.connectedResourceName || b.name));
  return all;
}

// ── Loom-service binding: PE → backing resource's loom-domain + type (ARG) ──
//
// A private endpoint only knows the ARM id of the resource it fronts. To answer
// "which Loom logical service / owning domain does this endpoint belong to?" we
// join each PE's connectedResourceId to that resource's ARM type + `loom-domain`
// chargeback tag (the same tag dlz-attach stamps, DOMAIN_TAG_KEY). Azure Resource
// Graph is the documented Azure-native way to resolve these relationships — it is
// exactly how Network Watcher Topology itself draws the graph — and needs only the
// Reader the PE scan already requires. Best-effort: a missing ARG read leaves the
// PE labelled by its raw name, never blanks the topology (no-vaporware honest gate
// is the route's job; here we degrade silently).
//
//   POST {arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01
//   { query: "Resources | where id in~ (...) | project id, type, tags" }
//
// Learn: https://learn.microsoft.com/azure/governance/resource-graph/overview
//        https://learn.microsoft.com/azure/network-watcher/network-insights-topology
const RESOURCE_GRAPH_API = '2022-10-01';

/** Loom-service binding for a single PE's backing resource (ARG join result). */
export interface LoomServiceBinding {
  /** Lowercased ARM id of the backing resource — the join key against the PE. */
  resourceId: string;
  /** ARM resource type, e.g. `Microsoft.Synapse/workspaces`. */
  resourceType?: string;
  /** `loom-domain` tag value (the domain id), or undefined when untagged. */
  loomDomain?: string;
}

/**
 * PURE: shape one ARG `Resources` row → a {@link LoomServiceBinding}. The
 * `loom-domain` tag value may be stamped as either `loom-domain:<id>` or the
 * bare `<id>` (both forms exist in the wild — see topology-inventory's filter),
 * so normalise to the bare domain id. Unit-testable like `shapeNsg`.
 */
export function shapeLoomBinding(row: any): LoomServiceBinding {
  const resourceId = String(row?.id || '').toLowerCase();
  const tags: Record<string, unknown> =
    row?.tags && typeof row.tags === 'object' ? row.tags : {};
  const rawTag = tags[DOMAIN_TAG_KEY];
  let loomDomain: string | undefined;
  if (typeof rawTag === 'string' && rawTag.trim()) {
    const v = rawTag.trim();
    loomDomain = v.includes(':') ? v.split(':').pop() || undefined : v;
  }
  return {
    resourceId,
    resourceType: typeof row?.type === 'string' ? row.type : undefined,
    loomDomain: loomDomain || undefined,
  };
}

/**
 * PURE: stamp each endpoint's `connectedResourceType` + `loomDomain` from the ARG
 * bindings, joining case-insensitively on the backing resource's ARM id. Mutates
 * the endpoints in place; endpoints with no matching binding are left untouched.
 */
export function applyLoomBindings(
  endpoints: PrivateEndpointInfo[],
  bindings: LoomServiceBinding[],
): void {
  const byId = new Map<string, LoomServiceBinding>();
  for (const b of bindings) if (b.resourceId) byId.set(b.resourceId, b);
  for (const pe of endpoints) {
    const key = (pe.connectedResourceId || '').toLowerCase();
    if (!key) continue;
    const b = byId.get(key);
    if (!b) continue;
    if (b.resourceType) pe.connectedResourceType = b.resourceType;
    if (b.loomDomain) pe.loomDomain = b.loomDomain;
  }
}

/** ARG query for the backing resources' type + loom-domain tag. Throws
 * {@link NetworkDiscoveryError} on a non-OK ARG response (caller swallows). */
async function queryResourceBindings(resourceIds: string[]): Promise<LoomServiceBinding[]> {
  const idList = resourceIds
    .map((id) => `'${id.replace(/'/g, "''")}'`)
    .join(', ');
  const query = [
    'Resources',
    `| where id in~ (${idList})`,
    '| project id, type, tags',
  ].join('\n');

  const out: LoomServiceBinding[] = [];
  let skipToken: string | undefined;
  let guard = 0;
  do {
    guard += 1;
    const options: Record<string, unknown> = { resultFormat: 'objectArray', $top: 1000 };
    if (skipToken) options.$skipToken = skipToken;
    const token = await armToken();
    const res = await fetchWithTimeout(
      `${armBase()}/providers/Microsoft.ResourceGraph/resources?api-version=${RESOURCE_GRAPH_API}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, options }),
        cache: 'no-store',
      },
    );
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || `ARG query failed ${res.status}`;
      throw new NetworkDiscoveryError(msg, res.status, json);
    }
    const data: any[] = Array.isArray(json?.data) ? json.data : [];
    for (const row of data) out.push(shapeLoomBinding(row));
    skipToken = (json?.$skipToken as string) || undefined;
  } while (skipToken && guard < 20);
  return out;
}

/**
 * Enrich the endpoints with the Loom service/domain each fronts, via Azure
 * Resource Graph (Reader-only). Best-effort: any ARG failure (no read, no RP)
 * leaves the endpoints with their base labels — never throws, never blanks the
 * topology. Mutates the endpoints in place.
 */
export async function bindLoomServices(endpoints: PrivateEndpointInfo[]): Promise<void> {
  const ids = Array.from(new Set(
    endpoints.map((e) => e.connectedResourceId).filter((x): x is string => Boolean(x)),
  ));
  if (!ids.length) return;
  try {
    const bindings = await queryResourceBindings(ids);
    applyLoomBindings(endpoints, bindings);
  } catch { /* ARG unreadable — keep base PE labels, topology still renders */ }
}

// ── Private DNS zones + A-records (authoritative FQDN→IP for the hosts file) ──
const PRIVATE_DNS_API = '2020-06-01';
const VNET_API = '2023-09-01';

export interface PrivateDnsZoneInfo {
  name: string; subscriptionId: string; resourceGroup?: string; records: PrivateDnsRecord[];
}
export interface SubnetInfo {
  /** Full ARM id of the subnet (key for subnet↔NSG / subnet↔PE topology edges). */
  id?: string;
  name: string; addressPrefix?: string; privateEndpointCount: number; delegations: string[];
  /** ARM id of the NSG attached to this subnet, if any. */
  nsgId?: string;
}
export interface VNetInfo {
  id: string; name: string; subscriptionId: string; resourceGroup?: string;
  addressPrefixes: string[]; subnets: SubnetInfo[];
}

/**
 * Every `privatelink.*` private DNS zone + its A recordsets across the target
 * subscription(s). This is the AUTHORITATIVE source for the hosts-file override:
 * a private endpoint registers its FQDN→IP here even when the PE's
 * customDnsConfigs echoes nothing, so enumerating these zones captures every
 * private-only service (Databricks UI, Synapse Studio, storage dfs/blob, KQL,
 * Key Vault, …) — which is what the PE-only scan was missing.
 */
export async function listPrivateDnsZones(): Promise<PrivateDnsZoneInfo[]> {
  const subs = await targetSubscriptionIds();
  const out: PrivateDnsZoneInfo[] = [];
  for (const sub of subs) {
    let zones: any[] = [];
    try {
      zones = await armList<any>(`/subscriptions/${sub}/providers/Microsoft.Network/privateDnsZones?api-version=${PRIVATE_DNS_API}`);
    } catch { continue; }
    for (const z of zones) {
      const name: string = z?.name || '';
      if (!/privatelink/i.test(name)) continue;
      const rg = /\/resourceGroups\/([^/]+)\//i.exec(z?.id || '')?.[1];
      let records: PrivateDnsRecord[] = [];
      try {
        const recs = await armList<any>(
          `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/privateDnsZones/${encodeURIComponent(name)}/A?api-version=${PRIVATE_DNS_API}`,
        );
        records = recs.map((r: any) => {
          const label: string = r?.name || '@';
          const fqdn = label === '@' ? name : `${label}.${name}`;
          const ips = (r?.properties?.aRecords || []).map((a: any) => a?.ipv4Address).filter(Boolean);
          return { fqdn, ips, zone: name };
        }).filter((r: PrivateDnsRecord) => r.ips.length > 0);
      } catch { /* zone records unreadable — skip, keep the zone listed */ }
      out.push({ name, subscriptionId: sub, resourceGroup: rg, records });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Every virtual network + its subnets (address space, delegations, PE count). */
export async function listVirtualNetworks(): Promise<VNetInfo[]> {
  const subs = await targetSubscriptionIds();
  const out: VNetInfo[] = [];
  for (const sub of subs) {
    let vnets: any[] = [];
    try {
      vnets = await armList<any>(`/subscriptions/${sub}/providers/Microsoft.Network/virtualNetworks?api-version=${VNET_API}`);
    } catch { continue; }
    for (const v of vnets) {
      const rg = /\/resourceGroups\/([^/]+)\//i.exec(v?.id || '')?.[1];
      const subnets: SubnetInfo[] = (v?.properties?.subnets || []).map((s: any) => ({
        id: s?.id,
        name: s?.name || '',
        addressPrefix: s?.properties?.addressPrefix || (s?.properties?.addressPrefixes || [])[0],
        privateEndpointCount: (s?.properties?.privateEndpoints || []).length,
        delegations: (s?.properties?.delegations || []).map((d: any) => d?.properties?.serviceName).filter(Boolean),
        nsgId: s?.properties?.networkSecurityGroup?.id,
      }));
      out.push({
        id: v?.id || '', name: v?.name || '', subscriptionId: sub, resourceGroup: rg,
        addressPrefixes: v?.properties?.addressSpace?.addressPrefixes || [], subnets,
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ── Network Security Groups (per-subnet firewall rules) ─────────────────────
//
// The hub VNet attaches an NSG (`nsg-<subnet>`) to every non-system workload
// subnet (see platform/fiab/bicep/modules/admin-plane/network.bicep). Reading
// them gives the topology its security-boundary nodes + a clickable rule table
// (priority/direction/access/protocol/source→dest:port), matching the Azure
// portal's "Network security group → Inbound/Outbound security rules" blade.
//
// Real ARM REST — no mocks:
//   GET /subscriptions/{sub}/providers/Microsoft.Network/networkSecurityGroups
//       ?api-version=2024-05-01
//   → properties.securityRules[].properties.{priority,direction,access,protocol,
//       sourceAddressPrefix(es), destinationAddressPrefix(es), destinationPortRange(s)}
//   → properties.subnets[].id   (which subnets the NSG is attached to)
//
// Needs Reader (Microsoft.Network/networkSecurityGroups/read). Best-effort per
// subscription so one inaccessible sub never blanks the topology.
// Learn: https://learn.microsoft.com/rest/api/virtualnetwork/network-security-groups/list-all

export interface NsgRule {
  name: string;
  direction: string;            // Inbound | Outbound
  access: string;               // Allow | Deny
  priority: number;
  protocol: string;             // Tcp | Udp | * ...
  sourcePrefix: string;         // single or comma-joined source address prefixes
  destPrefix: string;           // single or comma-joined destination address prefixes
  sourcePort: string;
  destPort: string;             // single or comma-joined destination ports
}

export interface NsgInfo {
  id: string;
  name: string;
  subscriptionId: string;
  resourceGroup?: string;
  location?: string;
  /** ARM ids of the subnets this NSG is attached to. */
  subnetIds: string[];
  /** Custom + default security rules, sorted by priority within each direction. */
  rules: NsgRule[];
}

/** Map a single ARM securityRule to the flat {@link NsgRule} shape. Handles the
 * singular vs. plural (`*Prefix` vs `*Prefixes`, `*PortRange` vs `*PortRanges`)
 * ARM variants. PURE — unit-testable, no ARM/identity. */
export function shapeNsgRule(raw: any): NsgRule {
  const p = raw?.properties || {};
  const join = (single: any, plural: any): string => {
    const arr = Array.isArray(plural) ? plural.filter(Boolean) : [];
    if (arr.length) return arr.join(', ');
    return single != null && single !== '' ? String(single) : '*';
  };
  return {
    name: raw?.name || '',
    direction: p.direction || '',
    access: p.access || '',
    priority: typeof p.priority === 'number' ? p.priority : Number(p.priority) || 0,
    protocol: p.protocol || '*',
    sourcePrefix: join(p.sourceAddressPrefix, p.sourceAddressPrefixes),
    destPrefix: join(p.destinationAddressPrefix, p.destinationAddressPrefixes),
    sourcePort: join(p.sourcePortRange, p.sourcePortRanges),
    destPort: join(p.destinationPortRange, p.destinationPortRanges),
  };
}

/** Map an ARM NSG resource to {@link NsgInfo}. PURE — unit-testable. */
export function shapeNsg(raw: any, subscriptionId: string): NsgInfo {
  const id: string = raw?.id || '';
  const rg = /\/resourceGroups\/([^/]+)\//i.exec(id)?.[1];
  const ruleSources: any[] = [
    ...(raw?.properties?.securityRules || []),
    ...(raw?.properties?.defaultSecurityRules || []),
  ];
  const rules = ruleSources
    .map(shapeNsgRule)
    .sort((a, b) => a.direction.localeCompare(b.direction) || a.priority - b.priority);
  const subnetIds: string[] = (raw?.properties?.subnets || [])
    .map((s: any) => s?.id)
    .filter(Boolean);
  return {
    id,
    name: raw?.name || id.split('/').pop() || 'nsg',
    subscriptionId,
    resourceGroup: rg,
    location: raw?.location,
    subnetIds,
    rules,
  };
}

/**
 * Every network security group the Console identity can read across the target
 * subscription(s). Per-subscription failures are swallowed so one inaccessible
 * sub doesn't blank the list — the topology degrades gracefully.
 */
export async function listNetworkSecurityGroups(): Promise<NsgInfo[]> {
  const subs = await targetSubscriptionIds();
  const out: NsgInfo[] = [];
  for (const sub of subs) {
    let raws: any[] = [];
    try {
      raws = await armList<any>(
        `/subscriptions/${sub}/providers/Microsoft.Network/networkSecurityGroups?api-version=${NSG_API}`,
      );
    } catch { continue; }
    for (const r of raws) out.push(shapeNsg(r, sub));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
export function buildHostsBlock(endpoints: PrivateEndpointInfo[], zones: PrivateDnsZoneInfo[]): string {
  const map = new Map<string, string>();
  for (const z of zones) for (const r of z.records) for (const ip of r.ips) {
    if (r.fqdn && !map.has(r.fqdn)) map.set(r.fqdn, ip);
  }
  for (const pe of endpoints) for (const d of pe.dns) for (const ip of d.ips) {
    if (d.fqdn && !map.has(d.fqdn)) map.set(d.fqdn, ip);
  }
  const lines = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([fqdn, ip]) => `${ip}\t${fqdn}`);
  return ['# CSA Loom — Azure private endpoints (dev hosts override)', ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Virtual Network (VNet) data gateway — Fabric / Power Platform TENANT gate
// ---------------------------------------------------------------------------
//
// A VNet data gateway is a Microsoft Fabric / Power Platform TENANT capability —
// NOT an Azure resource Loom can provision (per no-fabric-dependency.md, the
// Azure-native default for private connectivity is the private-endpoint plane
// the rest of this module discovers). Creating one requires ALL of:
//   1. The `Microsoft.PowerPlatform` resource provider registered on the sub.
//   2. A subnet delegated to `Microsoft.PowerPlatform/vnetaccesslinks`
//      (the reserved `GatewaySubnet` cannot be delegated).
//   3. A Fabric / Power BI Premium (A4+/P/F SKU) capacity in the tenant.
//   4. A Fabric administrator enabling "Manage gateway installers" (Power
//      Platform admin center → Data → Virtual network data gateways).
//   5. The gateway created from the Fabric / Power BI portal ("Manage
//      connections and gateways" → Virtual network data gateway → New).
//
// Loom can TRUTHFULLY detect (1) + (2) from ARM with Reader rights; (3)–(5) are
// tenant actions Loom cannot see or perform, so they are surfaced as honest
// "tenant-managed" prerequisites — never faked as enabled. This is read-only
// discovery + an honest tenant gate; Loom renders NO "create gateway" control.
//
// Learn:
//   https://learn.microsoft.com/data-integration/vnet/manage-data-gateways
//   https://learn.microsoft.com/data-integration/vnet/create-data-gateways
//   https://learn.microsoft.com/fabric/security/security-workspace-private-links-example-power-bi-virtual-network

const POWERPLATFORM_RP_API = '2021-04-01';
/** The subnet delegation a VNet data gateway requires. */
export const VNET_GATEWAY_DELEGATION = 'Microsoft.PowerPlatform/vnetaccesslinks';

/** Status of a single VNet-data-gateway prerequisite. */
export type VnetGatewayPrereqStatus = 'met' | 'unmet' | 'tenant' | 'unavailable';

export interface VnetGatewayPrereq {
  id: string;
  label: string;
  status: VnetGatewayPrereqStatus;
  detail: string;
  /** True when Loom can verify this prerequisite from Azure; false when it is a
   * Fabric/Power-BI tenant action Loom can neither see nor perform. */
  azureDetectable: boolean;
  /** Microsoft Learn doc for the remediation. */
  docUrl?: string;
}

export interface VnetGatewayDelegatedSubnet {
  vnet: string;
  subnet: string;
  subscriptionId: string;
  resourceGroup?: string;
}

export interface VnetDataGatewayReadiness {
  /** Friendly cloud-boundary label for the surface header. */
  cloud: string;
  /** False in sovereign clouds where Fabric/Power-Platform VNet gateways have no
   * endpoint — the Azure-native private-endpoint plane is the equivalent there. */
  capabilityAvailable: boolean;
  /** `Microsoft.PowerPlatform` RP registration state, or null when unread. */
  rpRegistrationState: string | null;
  rpRegistered: boolean;
  /** Subnets already delegated to Microsoft.PowerPlatform/vnetaccesslinks. */
  delegatedSubnets: VnetGatewayDelegatedSubnet[];
  prereqs: VnetGatewayPrereq[];
  /** The Azure-native default Loom uses for private connectivity. */
  azureNativeDefault: string;
}

const VNET_GW_MANAGE_DOC = 'https://learn.microsoft.com/data-integration/vnet/manage-data-gateways';
const VNET_GW_CREATE_DOC = 'https://learn.microsoft.com/data-integration/vnet/create-data-gateways';

/**
 * PURE evaluator (no ARM / identity) — turns the detected Azure signals into the
 * honest prerequisite checklist. Unit-testable like `isValidCidr` / `nextPriority`.
 *
 * @param cloud       active sovereign boundary (`detectLoomCloud()`).
 * @param rpState     `Microsoft.PowerPlatform` registrationState, or null if the
 *                    RP read failed / was not attempted.
 * @param vnets       VNets discovered via {@link listVirtualNetworks}.
 */
export function evaluateVnetGatewayReadiness(
  cloud: LoomCloud,
  rpState: string | null,
  vnets: VNetInfo[],
): VnetDataGatewayReadiness {
  // Fabric / Power Platform VNet data gateways are Commercial + GCC only; the
  // sovereign Azure Government clouds have no Power Platform VNet endpoint.
  const capabilityAvailable = cloud === 'Commercial' || cloud === 'GCC';

  const rpRegistered = (rpState || '').toLowerCase() === 'registered';

  const delegatedSubnets: VnetGatewayDelegatedSubnet[] = [];
  for (const v of vnets) {
    for (const sn of v.subnets) {
      const delegated = (sn.delegations || []).some(
        (d) => d.toLowerCase() === VNET_GATEWAY_DELEGATION.toLowerCase(),
      );
      // The reserved gateway subnet cannot host a delegation — never count it.
      if (delegated && sn.name.toLowerCase() !== 'gatewaysubnet') {
        delegatedSubnets.push({
          vnet: v.name, subnet: sn.name,
          subscriptionId: v.subscriptionId, resourceGroup: v.resourceGroup,
        });
      }
    }
  }

  const azureNativeDefault =
    'CSA Loom does not create VNet data gateways. Private connectivity to Loom ' +
    'backing services is delivered by the Azure-native private-endpoint plane ' +
    '(snet-private-endpoints + privatelink.* zones) shown above — no Fabric ' +
    'capacity, Power BI workspace, or gateway required.';

  if (!capabilityAvailable) {
    // Honest "unavailable in this boundary" gate — every row is `unavailable`.
    const naDetail =
      `Virtual network data gateways are a Fabric / Power Platform capability that ` +
      `is not offered in ${cloudBoundaryLabel()}. Use the Azure-native private-` +
      `endpoint connectivity above, which is the supported equivalent here.`;
    return {
      cloud: cloudBoundaryLabel(),
      capabilityAvailable: false,
      rpRegistrationState: rpState,
      rpRegistered,
      delegatedSubnets,
      azureNativeDefault,
      prereqs: [
        { id: 'cloud', label: 'Capability available in this cloud', status: 'unavailable', detail: naDetail, azureDetectable: true },
      ],
    };
  }

  const prereqs: VnetGatewayPrereq[] = [
    {
      id: 'rp',
      label: 'Microsoft.PowerPlatform resource provider registered',
      status: rpState == null ? 'unmet' : rpRegistered ? 'met' : 'unmet',
      detail: rpState == null
        ? 'Could not read the provider registration (grant the Console identity Reader on the subscription). ' +
          'Register it with: az provider register --namespace Microsoft.PowerPlatform'
        : rpRegistered
          ? 'Registered on the subscription.'
          : `Registration state is "${rpState}". Register it with: az provider register --namespace Microsoft.PowerPlatform`,
      azureDetectable: true,
      docUrl: VNET_GW_CREATE_DOC,
    },
    {
      id: 'subnet',
      label: `Subnet delegated to ${VNET_GATEWAY_DELEGATION}`,
      status: delegatedSubnets.length ? 'met' : 'unmet',
      detail: delegatedSubnets.length
        ? `Delegated subnet(s): ${delegatedSubnets.map((s) => `${s.vnet}/${s.subnet}`).join(', ')}.`
        : 'No subnet is delegated to Microsoft.PowerPlatform/vnetaccesslinks. Delegate a dedicated ' +
          'subnet (the reserved GatewaySubnet cannot be used) and grant the creator ' +
          'Microsoft.Network/virtualNetworks/subnets/join/action.',
      azureDetectable: true,
      docUrl: VNET_GW_CREATE_DOC,
    },
    {
      id: 'capacity',
      label: 'Fabric / Power BI Premium capacity (A4+ / P / F SKU)',
      status: 'tenant',
      detail: 'A Premium/Fabric capacity is required to bind a VNet data gateway. ' +
        'Loom cannot see your Fabric tenant capacity — verify it in the Fabric admin portal.',
      azureDetectable: false,
      docUrl: VNET_GW_CREATE_DOC,
    },
    {
      id: 'installers',
      label: 'Tenant admin enabled "Manage gateway installers"',
      status: 'tenant',
      detail: 'A Fabric administrator must grant gateway-installer rights in the Power Platform ' +
        'admin center (Data → Virtual network data gateways → Manage gateway installers). ' +
        'This is a tenant switch Loom cannot toggle.',
      azureDetectable: false,
      docUrl: VNET_GW_MANAGE_DOC,
    },
    {
      id: 'create',
      label: 'Gateway created in the Fabric / Power BI portal',
      status: 'tenant',
      detail: 'The gateway itself is created from "Manage connections and gateways → Virtual network ' +
        'data gateway → New" in the Fabric / Power BI portal. Loom intentionally does not provision it ' +
        '(no-fabric-dependency) — the Azure-native private-endpoint path is the default.',
      azureDetectable: false,
      docUrl: VNET_GW_MANAGE_DOC,
    },
  ];

  return {
    cloud: cloudBoundaryLabel(),
    capabilityAvailable: true,
    rpRegistrationState: rpState,
    rpRegistered,
    delegatedSubnets,
    prereqs,
    azureNativeDefault,
  };
}

/**
 * Read the REAL Azure-side prerequisites for a Fabric/Power-Platform VNet data
 * gateway (Reader-only): the `Microsoft.PowerPlatform` RP registration state +
 * any subnet already delegated to `Microsoft.PowerPlatform/vnetaccesslinks`.
 * No writes, no Fabric/Power-BI host calls — pure detection, then the pure
 * {@link evaluateVnetGatewayReadiness} builds the honest prerequisite checklist.
 *
 * Throws {@link NetworkDiscoveryError} only when subscription enumeration /
 * token acquisition fails (the BFF turns that into an honest Reader-role gate).
 * The RP read + VNet scan degrade gracefully (rpState=null / empty subnets) so
 * a partial-permission identity still gets the tenant-prerequisite guidance.
 */
export async function getVnetDataGatewayReadiness(): Promise<VnetDataGatewayReadiness> {
  const cloud = detectLoomCloud();
  const subs = await targetSubscriptionIds();

  // RP registration — best-effort across the readable subscription(s); the first
  // definitive "Registered" wins, otherwise the last-seen state is reported.
  let rpState: string | null = null;
  for (const sub of subs) {
    try {
      const rp = await armGet<{ registrationState?: string }>(
        `/subscriptions/${sub}/providers/Microsoft.PowerPlatform?api-version=${POWERPLATFORM_RP_API}`,
      );
      const state = rp?.registrationState || null;
      if (state) {
        rpState = state;
        if (state.toLowerCase() === 'registered') break;
      }
    } catch { /* RP unreadable on this sub — keep scanning, evaluator handles null */ }
  }

  // VNet/subnet delegation scan — reuse the existing discovery (best-effort).
  let vnets: VNetInfo[] = [];
  try { vnets = await listVirtualNetworks(); } catch { /* delegation list degrades to empty */ }

  return evaluateVnetGatewayReadiness(cloud, rpState, vnets);
}

