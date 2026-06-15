/**
 * Full network-estate topology over Azure Resource Graph (ARG).
 *
 * Powers the `/admin/network` "CSA Loom network topology" surface with a REAL
 * resource-graph visual of the whole network estate — not just the private
 * endpoints the existing `network-discovery` helper enumerates. A single ARG
 * query (scoped to LOOM_SUBSCRIPTION_ID ∪ LOOM_EXTRA_SUBSCRIPTIONS) pulls every
 * network resource the Console identity can read and shapes it into graph
 * `nodes` + `edges` the React Flow canvas renders directly.
 *
 * Resource types mapped (all read-only, Reader on the subscription suffices):
 *   microsoft.network/virtualnetworks              → vNet container + its subnets
 *                                                    + vNet↔vNet peering edges
 *   microsoft.network/privateendpoints             → PE leaf, wired to its subnet
 *                                                    + labelled with its target
 *   microsoft.network/networksecuritygroups        → NSG, wired to its subnet(s)
 *   microsoft.network/azurefirewalls               → firewall, wired to its subnet
 *   microsoft.network/privatednszones              → private DNS zone (floating)
 *   microsoft.network/bastionhosts                 → Bastion, wired to its subnet
 *   microsoft.app/managedenvironments              → Container Apps env, wired to
 *                                                    its infrastructure subnet
 *   microsoft.network/applicationgateways          → App Gateway, wired to subnet
 *   microsoft.network/loadbalancers                → internal LB, wired to subnet
 *
 * Real ARM REST — no mocks, no `return []` placeholders:
 *   POST {arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01
 *        { subscriptions: [...], query: "Resources | where type in~ (...) ..." }
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential({clientId: UAMI}) →
 * DefaultAzureCredential) on the ARM scope — the MI-first chain every other ARM
 * client uses. A 403 / empty-subscription set is surfaced as an honest gate by
 * the route (no-vaporware): the page shows a MessageBar naming the Reader role.
 *
 * Learn: https://learn.microsoft.com/azure/governance/resource-graph/overview
 *        https://learn.microsoft.com/azure/network-watcher/network-insights-topology
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';

const ARM_SCOPE = process.env.LOOM_ARM_SCOPE || armScope();
const ARG_API = '2022-10-01';
const ARG_URL = process.env.LOOM_ARG_URL
  || `${armBase()}/providers/Microsoft.ResourceGraph/resources`;

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class TopologyGraphError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'TopologyGraphError';
    this.status = status;
    this.body = body;
  }
}

/** Graph node kinds, one per mapped Azure network resource family. */
export type TopoNodeKind =
  | 'vnet'
  | 'subnet'
  | 'pe'
  | 'nsg'
  | 'firewall'
  | 'privatednszone'
  | 'bastion'
  | 'managedenv'
  | 'appgateway'
  | 'loadbalancer';

/** Graph edge kinds, describing WHY two nodes are connected. */
export type TopoEdgeKind = 'subnet' | 'peering' | 'pe-target' | 'nsg' | 'attach';

/** A single topology node — plain data (no JSX); the client adds layout + label. */
export interface TopoNode {
  /** Stable graph-node id (`<kind>:<lowercased arm id>`). */
  id: string;
  /** Original ARM resource id. */
  armId: string;
  name: string;
  kind: TopoNodeKind;
  /** ARM resource type, e.g. `microsoft.network/virtualnetworks`. */
  type: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  /** For subnets: the graph-node id of the owning vNet (React Flow `parentId`). */
  parentNodeId?: string;
  /** Display facts surfaced in the node label + detail drawer. */
  meta?: Record<string, string | number | string[]>;
}

/** A single topology edge between two {@link TopoNode}s. */
export interface TopoEdge {
  id: string;
  source: string;
  target: string;
  kind: TopoEdgeKind;
  label?: string;
}

export interface TopologyGraph {
  nodes: TopoNode[];
  edges: TopoEdge[];
  /** Per-kind node counts for the summary header. */
  counts: Record<TopoNodeKind, number>;
  /** Subscriptions actually queried. */
  subscriptions: string[];
}

/** Raw ARG row (only the fields we project). */
interface ArgRow {
  id: string;
  name: string;
  type: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  properties?: any;
}

const NETWORK_TYPES = [
  'microsoft.network/virtualnetworks',
  'microsoft.network/privateendpoints',
  'microsoft.network/networksecuritygroups',
  'microsoft.network/azurefirewalls',
  'microsoft.network/privatednszones',
  'microsoft.network/bastionhosts',
  'microsoft.app/managedenvironments',
  'microsoft.network/applicationgateways',
  'microsoft.network/loadbalancers',
] as const;

/**
 * Resolve the set of subscriptions to query: LOOM_SUBSCRIPTION_ID (primary)
 * unioned with the comma-separated LOOM_EXTRA_SUBSCRIPTIONS. De-duplicated,
 * order preserved. Empty when neither is set — the route turns that into an
 * honest config gate instead of a 5xx.
 */
export function topologySubscriptionScope(): string[] {
  const primary = (process.env.LOOM_SUBSCRIPTION_ID || '').trim();
  const extra = (process.env.LOOM_EXTRA_SUBSCRIPTIONS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set([primary, ...extra].filter(Boolean)));
}

async function argToken(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new TopologyGraphError('Failed to acquire ARM token for Resource Graph', 401);
  return t.token;
}

/** Run the network-estate ARG query across `subscriptions`, paging on $skipToken. */
async function queryNetworkEstate(subscriptions: string[]): Promise<ArgRow[]> {
  const typeList = NETWORK_TYPES.map((t) => `'${t}'`).join(',');
  const kql = [
    'Resources',
    `| where type in~ (${typeList})`,
    '| project id, name, type, location, resourceGroup, subscriptionId, properties',
    '| order by type asc, name asc',
  ].join('\n');

  const out: ArgRow[] = [];
  let skipToken: string | undefined;
  let guard = 0;
  do {
    guard += 1;
    const body: Record<string, unknown> = { subscriptions, query: kql };
    body.options = skipToken
      ? { resultFormat: 'objectArray', $top: 1000, $skipToken: skipToken }
      : { resultFormat: 'objectArray', $top: 1000 };
    const token = await argToken();
    const r = await fetchWithTimeout(`${ARG_URL}?api-version=${ARG_API}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const text = await r.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    if (!r.ok) {
      const msg = j?.error?.message || j?.message || `Resource Graph query failed ${r.status}`;
      throw new TopologyGraphError(msg, r.status, j);
    }
    const rows: any[] = Array.isArray(j?.data) ? j.data : (Array.isArray(j?.data?.rows) ? j.data.rows : []);
    for (const row of rows) {
      if (row && typeof row === 'object' && row.id) out.push(row as ArgRow);
    }
    skipToken = j?.$skipToken ?? j?.['$skipToken'];
  } while (skipToken && guard < 20);
  return out;
}

const lc = (s?: string): string => (s || '').toLowerCase();
const lastSeg = (id?: string): string => (id ? id.split('/').filter(Boolean).pop() || id : '');

function nodeIdFor(kind: TopoNodeKind, armId: string): string {
  return `${kind}:${lc(armId)}`;
}

/**
 * PURE: shape the raw ARG rows into a {@link TopologyGraph}. Exported so the
 * mapping is unit-testable without hitting ARM. Edges key on REAL ARM ids
 * (subnet membership, vNet peering, PE→target) — never array position.
 */
export function buildTopologyGraph(rows: ArgRow[], subscriptions: string[]): TopologyGraph {
  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  const seenNode = new Set<string>();
  const seenEdge = new Set<string>();

  // Map every subnet ARM id → its graph-node id so leaf resources (PE, NSG,
  // firewall, Bastion, Container Apps env, App Gateway, LB) can wire to the
  // exact subnet they live in, across all vNets/subscriptions.
  const subnetNodeIdByArmId = new Map<string, string>();
  // vNet ARM id → graph-node id, for peering edges.
  const vnetNodeIdByArmId = new Map<string, string>();

  function pushNode(n: TopoNode): void {
    if (seenNode.has(n.id)) return;
    seenNode.add(n.id);
    nodes.push(n);
  }
  function pushEdge(e: TopoEdge): void {
    if (seenEdge.has(e.id)) return;
    seenEdge.add(e.id);
    edges.push(e);
  }

  const byType = (t: string) => rows.filter((r) => lc(r.type) === t);

  // ── Pass 1: vNets + their subnets (containers must exist before leaves) ──
  for (const v of byType('microsoft.network/virtualnetworks')) {
    const vnetNodeId = nodeIdFor('vnet', v.id);
    vnetNodeIdByArmId.set(lc(v.id), vnetNodeId);
    const prefixes: string[] = v.properties?.addressSpace?.addressPrefixes || [];
    const subnets: any[] = v.properties?.subnets || [];
    pushNode({
      id: vnetNodeId, armId: v.id, name: v.name, kind: 'vnet', type: v.type,
      location: v.location, resourceGroup: v.resourceGroup, subscriptionId: v.subscriptionId,
      meta: { addressPrefixes: prefixes, subnetCount: subnets.length },
    });

    for (const sn of subnets) {
      const snArmId = sn.id || `${v.id}/subnets/${sn.name}`;
      const subnetNodeId = nodeIdFor('subnet', snArmId);
      subnetNodeIdByArmId.set(lc(snArmId), subnetNodeId);
      const prefix = sn.properties?.addressPrefix
        || (sn.properties?.addressPrefixes || []).join(', ') || '';
      const delegations: string[] = (sn.properties?.delegations || [])
        .map((d: any) => d?.properties?.serviceName).filter(Boolean);
      const nsgId: string | undefined = sn.properties?.networkSecurityGroup?.id;
      const peCount = (sn.properties?.privateEndpoints || []).length;
      pushNode({
        id: subnetNodeId, armId: snArmId, name: sn.name || lastSeg(snArmId), kind: 'subnet',
        type: 'microsoft.network/virtualnetworks/subnets',
        resourceGroup: v.resourceGroup, subscriptionId: v.subscriptionId,
        parentNodeId: vnetNodeId,
        meta: {
          addressPrefix: prefix, vnet: v.name, delegations,
          privateEndpointCount: peCount, ...(nsgId ? { nsg: lastSeg(nsgId) } : {}),
        },
      });
      pushEdge({
        id: `vnet-subnet:${vnetNodeId}->${subnetNodeId}`,
        source: vnetNodeId, target: subnetNodeId, kind: 'subnet',
      });
    }
  }

  // ── vNet peering edges (properties.virtualNetworkPeerings[].remoteVirtualNetwork) ──
  for (const v of byType('microsoft.network/virtualnetworks')) {
    const srcNode = vnetNodeIdByArmId.get(lc(v.id));
    if (!srcNode) continue;
    for (const p of v.properties?.virtualNetworkPeerings || []) {
      const remoteId: string | undefined = p?.properties?.remoteVirtualNetwork?.id;
      if (!remoteId) continue;
      const dstNode = vnetNodeIdByArmId.get(lc(remoteId));
      // Only draw a peering edge to a vNet we can actually see; a half-edge to
      // an unseen remote vNet would dangle.
      if (!dstNode || dstNode === srcNode) continue;
      // Stable, direction-independent id so A↔B and B↔A collapse to one edge.
      const pair = [srcNode, dstNode].sort().join('==');
      pushEdge({
        id: `peering:${pair}`, source: srcNode, target: dstNode, kind: 'peering',
        label: p?.properties?.peeringState || 'Peered',
      });
    }
  }

  /** Wire a leaf node to the subnet ARM id it references (if that subnet is known). */
  function wireToSubnet(leafNodeId: string, subnetArmId: string | undefined, kind: TopoEdgeKind): void {
    if (!subnetArmId) return;
    const snNode = subnetNodeIdByArmId.get(lc(subnetArmId));
    if (!snNode) return;
    pushEdge({
      id: `${kind}:${snNode}->${leafNodeId}`, source: snNode, target: leafNodeId, kind,
    });
  }

  // ── Private endpoints — leaf wired to its subnet + labelled with its target ──
  for (const pe of byType('microsoft.network/privateendpoints')) {
    const peNodeId = nodeIdFor('pe', pe.id);
    const conns = [
      ...(pe.properties?.privateLinkServiceConnections || []),
      ...(pe.properties?.manualPrivateLinkServiceConnections || []),
    ];
    const targetId: string | undefined = conns[0]?.properties?.privateLinkServiceId;
    const groupIds: string[] = conns.flatMap((c: any) => c?.properties?.groupIds || []);
    const subnetId: string | undefined = pe.properties?.subnet?.id;
    const targetType = targetId
      ? lc((targetId.split('/providers/')[1] || '').split('/').slice(0, 2).join('/'))
      : '';
    pushNode({
      id: peNodeId, armId: pe.id, name: pe.name, kind: 'pe', type: pe.type,
      location: pe.location, resourceGroup: pe.resourceGroup, subscriptionId: pe.subscriptionId,
      meta: {
        ...(targetId ? { target: lastSeg(targetId), targetType } : {}),
        groupIds, ...(subnetId ? { subnet: lastSeg(subnetId) } : {}),
        state: pe.properties?.provisioningState || '',
      },
    });
    wireToSubnet(peNodeId, subnetId, 'pe-target');
  }

  // ── Network security groups — wired to each subnet they protect ──
  for (const nsg of byType('microsoft.network/networksecuritygroups')) {
    const nsgNodeId = nodeIdFor('nsg', nsg.id);
    const subnetIds: string[] = (nsg.properties?.subnets || []).map((s: any) => s?.id).filter(Boolean);
    const rules: any[] = nsg.properties?.securityRules || [];
    const denyCount = rules.filter((r) => r?.properties?.access === 'Deny').length;
    pushNode({
      id: nsgNodeId, armId: nsg.id, name: nsg.name, kind: 'nsg', type: nsg.type,
      location: nsg.location, resourceGroup: nsg.resourceGroup, subscriptionId: nsg.subscriptionId,
      meta: {
        ruleCount: rules.length, denyCount,
        subnets: subnetIds.map(lastSeg),
      },
    });
    for (const snId of subnetIds) wireToSubnet(nsgNodeId, snId, 'nsg');
  }

  // ── Azure Firewalls — wired to the AzureFirewallSubnet they sit in ──
  for (const fw of byType('microsoft.network/azurefirewalls')) {
    const fwNodeId = nodeIdFor('firewall', fw.id);
    const subnetId: string | undefined = (fw.properties?.ipConfigurations || [])
      .map((c: any) => c?.properties?.subnet?.id).filter(Boolean)[0];
    pushNode({
      id: fwNodeId, armId: fw.id, name: fw.name, kind: 'firewall', type: fw.type,
      location: fw.location, resourceGroup: fw.resourceGroup, subscriptionId: fw.subscriptionId,
      meta: {
        sku: fw.properties?.sku?.tier || fw.properties?.sku?.name || '',
        threatIntel: fw.properties?.threatIntelMode || '',
      },
    });
    wireToSubnet(fwNodeId, subnetId, 'attach');
  }

  // ── Bastion hosts — wired to AzureBastionSubnet ──
  for (const b of byType('microsoft.network/bastionhosts')) {
    const bNodeId = nodeIdFor('bastion', b.id);
    const subnetId: string | undefined = (b.properties?.ipConfigurations || [])
      .map((c: any) => c?.properties?.subnet?.id).filter(Boolean)[0];
    pushNode({
      id: bNodeId, armId: b.id, name: b.name, kind: 'bastion', type: b.type,
      location: b.location, resourceGroup: b.resourceGroup, subscriptionId: b.subscriptionId,
      meta: { sku: b.properties?.sku?.name || '' },
    });
    wireToSubnet(bNodeId, subnetId, 'attach');
  }

  // ── Container Apps managed environments — wired to the infrastructure subnet ──
  for (const env of byType('microsoft.app/managedenvironments')) {
    const envNodeId = nodeIdFor('managedenv', env.id);
    const subnetId: string | undefined = env.properties?.vnetConfiguration?.infrastructureSubnetId;
    pushNode({
      id: envNodeId, armId: env.id, name: env.name, kind: 'managedenv', type: env.type,
      location: env.location, resourceGroup: env.resourceGroup, subscriptionId: env.subscriptionId,
      meta: {
        internal: env.properties?.vnetConfiguration?.internal ? 'internal' : 'external',
        defaultDomain: env.properties?.defaultDomain || '',
      },
    });
    wireToSubnet(envNodeId, subnetId, 'attach');
  }

  // ── Application gateways — wired to their gatewayIPConfiguration subnet ──
  for (const agw of byType('microsoft.network/applicationgateways')) {
    const agwNodeId = nodeIdFor('appgateway', agw.id);
    const subnetId: string | undefined = (agw.properties?.gatewayIPConfigurations || [])
      .map((c: any) => c?.properties?.subnet?.id).filter(Boolean)[0];
    pushNode({
      id: agwNodeId, armId: agw.id, name: agw.name, kind: 'appgateway', type: agw.type,
      location: agw.location, resourceGroup: agw.resourceGroup, subscriptionId: agw.subscriptionId,
      meta: {
        sku: agw.properties?.sku?.name || '',
        tier: agw.properties?.sku?.tier || '',
      },
    });
    wireToSubnet(agwNodeId, subnetId, 'attach');
  }

  // ── Load balancers — wired to a frontend subnet (internal LBs only) ──
  for (const lb of byType('microsoft.network/loadbalancers')) {
    const lbNodeId = nodeIdFor('loadbalancer', lb.id);
    const subnetId: string | undefined = (lb.properties?.frontendIPConfigurations || [])
      .map((c: any) => c?.properties?.subnet?.id).filter(Boolean)[0];
    pushNode({
      id: lbNodeId, armId: lb.id, name: lb.name, kind: 'loadbalancer', type: lb.type,
      location: lb.location, resourceGroup: lb.resourceGroup, subscriptionId: lb.subscriptionId,
      meta: {
        sku: lb.properties?.sku?.name || '',
        scope: subnetId ? 'internal' : 'public',
      },
    });
    wireToSubnet(lbNodeId, subnetId, 'attach');
  }

  // ── Private DNS zones — floating info nodes (vNet links are child resources) ──
  for (const z of byType('microsoft.network/privatednszones')) {
    const zNodeId = nodeIdFor('privatednszone', z.id);
    pushNode({
      id: zNodeId, armId: z.id, name: z.name, kind: 'privatednszone', type: z.type,
      resourceGroup: z.resourceGroup, subscriptionId: z.subscriptionId,
      meta: {
        recordSets: z.properties?.numberOfRecordSets ?? 0,
        vnetLinks: z.properties?.numberOfVirtualNetworkLinksWithRegistration
          ?? z.properties?.numberOfVirtualNetworkLinks ?? 0,
      },
    });
  }

  const counts = {
    vnet: 0, subnet: 0, pe: 0, nsg: 0, firewall: 0,
    privatednszone: 0, bastion: 0, managedenv: 0, appgateway: 0, loadbalancer: 0,
  } as Record<TopoNodeKind, number>;
  for (const n of nodes) counts[n.kind] += 1;

  return { nodes, edges, counts, subscriptions };
}

/**
 * Query Azure Resource Graph and return the full network-estate topology graph.
 * Throws {@link TopologyGraphError} on a real ARG failure (auth / throttling) so
 * the route can surface an honest remediation gate. Returns an empty graph (not
 * an error) when `subscriptions` is empty.
 */
export async function getNetworkTopology(): Promise<TopologyGraph> {
  const subscriptions = topologySubscriptionScope();
  if (!subscriptions.length) {
    return {
      nodes: [], edges: [], subscriptions: [],
      counts: {
        vnet: 0, subnet: 0, pe: 0, nsg: 0, firewall: 0,
        privatednszone: 0, bastion: 0, managedenv: 0, appgateway: 0, loadbalancer: 0,
      },
    };
  }
  const rows = await queryNetworkEstate(subscriptions);
  return buildTopologyGraph(rows, subscriptions);
}
