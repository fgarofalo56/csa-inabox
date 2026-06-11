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
import {
  armBase, armScope, stripArmBase, detectLoomCloud, cloudBoundaryLabel,
  type LoomCloud,
} from './cloud-endpoints';

const ARM_SCOPE = armScope();
const SUBSCRIPTIONS_API = '2022-12-01';
const PE_API = '2024-03-01';
const NIC_API = '2024-03-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
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
  /** Sub-resource group(s), e.g. ['sqlServer'] / ['blob'] / ['Dev']. */
  groupIds: string[];
  /** Provisioning + connection state. */
  state?: string;
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

// ── Private DNS zones + A-records (authoritative FQDN→IP for the hosts file) ──
const PRIVATE_DNS_API = '2020-06-01';
const VNET_API = '2023-09-01';

export interface PrivateDnsZoneInfo {
  name: string; subscriptionId: string; resourceGroup?: string; records: PrivateDnsRecord[];
}
export interface SubnetInfo {
  name: string; addressPrefix?: string; privateEndpointCount: number; delegations: string[];
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
        name: s?.name || '',
        addressPrefix: s?.properties?.addressPrefix || (s?.properties?.addressPrefixes || [])[0],
        privateEndpointCount: (s?.properties?.privateEndpoints || []).length,
        delegations: (s?.properties?.delegations || []).map((d: any) => d?.properties?.serviceName).filter(Boolean),
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

/**
 * Build the COMPLETE hosts-file override from the union of every private DNS
 * zone A-record AND every private-endpoint DNS record (dedup by FQDN, first IP
 * wins). This guarantees every private-only service gets an `IP  FQDN` line —
 * not just the endpoints that echoed an IP in customDnsConfigs.
 */
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

