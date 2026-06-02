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
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

const ARM_SCOPE = 'https://management.azure.com/.default';
const SUBSCRIPTIONS_API = '2022-12-01';
const PE_API = '2024-03-01';
const NIC_API = '2024-03-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
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
  const res = await fetch(`https://management.azure.com${path}`, {
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
    const path: string = next.startsWith('https://management.azure.com')
      ? next.slice('https://management.azure.com'.length) : next;
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
