# networking — parity with Private Link / Private DNS topology

Source UI: Azure **Private Link Center** / Private endpoint + Private DNS blades
Reference: <https://learn.microsoft.com/azure/private-link/private-endpoint-overview>
Run date: 2026-06-09

Loom surfaces:

- Page: `/admin/network` → `app/admin/network/page.tsx` → `AdminShell` + `NetworkPane`
- Component: `lib/components/network/network-pane.tsx` → `NetworkPane`,
  `NetworkTopologyCanvas`
- BFF: `app/api/network/private-endpoints/route.ts`
- Discovery: `lib/azure/network-discovery.ts` → `listPrivateEndpoints`,
  `listPrivateDnsZones`, `listVirtualNetworks`, `listNetworkSecurityGroups`,
  `buildHostsBlock`
- Bicep: `platform/fiab/bicep/modules/admin-plane/network.bicep`,
  `platform/fiab/bicep/modules/admin-plane/vpn-gateway.bicep`

The network surface reads the deployment's own VNet / private endpoints / private
DNS via ARM. There is **no dependency on real Microsoft Fabric** — it works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Inventory private endpoints (resource, sub-resource, FQDN, private IP, zone)
2. Private DNS zones
3. VNet / subnet topology
4. **Network security groups** + their inbound/outbound security-rule grid, and
   which subnet each NSG protects —
   `learn.microsoft.com/azure/virtual-network/network-security-groups-overview`
5. **Visual topology graph** — nodes per resource (VNet/subnet/NSG/PE/DNS-zone),
   edges for real connectivity, clickable for resource detail (Azure portal
   "Network → Topology" + per-resource blades)
6. Guidance to resolve private FQDNs from on-prem / enterprise DNS
7. VPN / hybrid connectivity
8. Virtual network (VNet) data gateway prerequisites + tenant gate —
   `learn.microsoft.com/data-integration/vnet/manage-data-gateways` /
   `…/create-data-gateways`

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Private endpoint inventory (resource, sub-resource, FQDN, IP, zone) | ✅ Built | `GET /api/network/private-endpoints` → ARM `listPrivateEndpoints()` (UAMI) |
| Private DNS zone enumeration | ✅ Built | `listPrivateDnsZones()` |
| VNet topology view | ✅ Built | `listVirtualNetworks()` → `NetworkTopologyCanvas` |
| **Network security groups + rule grid** | ✅ Built | `listNetworkSecurityGroups()` → NSG inventory table + topology NSG nodes; clicking a node opens the full inbound/outbound rule grid (priority/direction/access/protocol/source→dest:port) |
| **Visual topology — real connectivity edges** | ✅ Built | `NetworkTopologyCanvas.buildTopology()` keys PE→subnet edges on the PE's real `properties.subnet.id` and subnet→NSG edges on `subnet.networkSecurityGroup.id` (no more VNet[0] decorative edges) |
| **PE → Loom service / owning domain binding** | ✅ Built | `bindLoomServices()` joins each PE's `connectedResourceId` to its backing resource's ARM type + `loom-domain` chargeback tag via **Azure Resource Graph** (`POST …/Microsoft.ResourceGraph/resources`); the PE node carries a domain badge, the inventory table a "Loom domain" column, and the detail drawer shows resource type + domain. Best-effort (Reader-only) — unbound/untagged endpoints keep their base label |
| **Clickable node detail (read-only)** | ✅ Built | `onNodeClick` → Fluent `OverlayDrawer` rendering each node's real ARM detail (VNet CIDRs+subnets, subnet prefix/delegations/NSG, NSG rule grid, PE FQDN→IP→zone + resource type + Loom domain, DNS-zone records) |
| Copy/paste hosts-file block | ✅ Built | `buildHostsBlock(endpoints, dnsZones)` → UI copy button |
| Enterprise DNS guidance (conditional forwarders / DNS Private Resolver / VNet-links / VPN) | ✅ Built | Static guidance rendered in `NetworkPane` |
| Hub VNet + 9 subnets (Firewall, Bastion, Container-platform, Functions, APIM, Private-Endpoints, Reserved, GatewaySubnet, AppGW) | ✅ Built | `network.bicep` subnet layout |
| Per-subnet NSGs (`nsg-<subnet>`) attached to non-system subnets | ✅ Built | `network.bicep` `nsgSubnets` + `subnetNsgAttach` |
| Honest gate when Reader role missing | ⚠️ Honest gate | `NetworkDiscoveryError` → 200 + warning MessageBar naming `Microsoft.Network/privateEndpoints/read` |
| **VNet data gateway tenant gate** (Fabric/Power Platform capability) | ⚠️ Honest gate | `GET /api/network/vnet-data-gateway` → `getVnetDataGatewayReadiness()`; read-only ARM detection of the `Microsoft.PowerPlatform` RP + delegated subnet, with tenant-only prereqs surfaced honestly — **no create control** |

Zero ❌ rows. The single ⚠️ gate (Reader role) keeps the page rendering and
names the exact ARM action to grant, per `no-vaporware.md`.

## VNet data gateway — honest tenant gate (no faked capability)

A **virtual network (VNet) data gateway** is a Microsoft **Fabric / Power
Platform tenant** capability, not an Azure resource Loom can provision. Per
`no-fabric-dependency.md` the surface renders **no "Create VNet data gateway"
control**; instead `VnetGatewayCard` (in `network-pane.tsx`) shows a read-only
prerequisite checklist driven by `GET /api/network/vnet-data-gateway`:

| Prerequisite | Detection | Status source |
|---|---|---|
| `Microsoft.PowerPlatform` RP registered | **Azure-detectable** (Reader) | ARM `GET …/providers/Microsoft.PowerPlatform` `registrationState` |
| Subnet delegated to `Microsoft.PowerPlatform/vnetaccesslinks` | **Azure-detectable** (Reader) | `listVirtualNetworks()` subnet-delegation scan (reserved `GatewaySubnet` excluded) |
| Fabric/Power BI Premium (A4+/P/F) capacity | **Tenant** — Loom cannot see | surfaced as a Fabric-admin action, never auto-"met" |
| "Manage gateway installers" enabled | **Tenant** — Loom cannot toggle | Power Platform admin center action |
| Gateway created in Fabric/Power BI portal | **Tenant** — Loom does not create | "Manage connections and gateways → VNet data gateway → New" |

The pure mapper `evaluateVnetGatewayReadiness(cloud, rpState, vnets)` is unit-
tested (`lib/azure/__tests__/vnet-data-gateway-readiness.test.ts`): RP states,
delegation detection, the GatewaySubnet exclusion, the no-faked-capability
guarantee (tenant rows stay `tenant`), and the sovereign-cloud unavailability
branch. The card always points the user at the **Azure-native private-endpoint
default** as the supported equivalent.

## Backend per control

- **Inventory** — `network-discovery.ts` calls ARM with the console UAMI:
  `listPrivateEndpoints()` (each endpoint's resource, group id / sub-resource,
  custom DNS FQDN, private IP, linked zone, **and the PE's `subnet.id`**),
  `listPrivateDnsZones()`, `listVirtualNetworks()` (subnets now carry their ARM
  `id` + attached `networkSecurityGroup.id`), and `listNetworkSecurityGroups()`
  (`Microsoft.Network/networkSecurityGroups` `2024-05-01` → `securityRules` +
  `subnets[]`). The pure shapers `shapeNsg` / `shapeNsgRule` are unit-tested
  (`lib/azure/__tests__/network-discovery-nsg.test.ts`).
- **Hosts block** — `buildHostsBlock()` joins endpoints to their resolved IPs to
  emit a copyable `hosts` file fragment for clients that can't reach the private
  DNS zone.
- **Topology** — `NetworkTopologyCanvas` renders VNets → subnets → NSGs →
  endpoints → DNS zones. Edges reflect **real** connectivity: PE→subnet keyed on
  `PrivateEndpointInfo.subnetId`, subnet→NSG keyed on `SubnetInfo.nsgId` /
  `NsgInfo.subnetIds`. Each PE is enriched with the **Loom service it fronts** —
  `bindLoomServices()` runs the documented ARG `Resources` query to resolve the
  backing resource's ARM type + `loom-domain` tag (`DOMAIN_TAG_KEY`), the same
  Azure-native join Network Watcher Topology uses, on the Reader the PE scan
  already requires. The pure shapers `shapeLoomBinding` / `applyLoomBindings`
  are unit-tested (`lib/azure/__tests__/network-discovery-binding.test.ts`).
  The zone drawer prefers the **authoritative private-DNS-zone A-records**
  (`PrivateDnsZoneInfo.records`, threaded through `TopologyData.dnsZones`),
  unioned with PE-derived records, so zones whose IP the PE never echoes still
  render their FQDN→IP. Every node is clickable (`onNodeClick`) and opens an
  `OverlayDrawer` with that resource's live ARM detail — read-only, no mutation.
- **Gate** — when the UAMI lacks Reader on the network scope,
  `NetworkDiscoveryError` returns 200 with an honest MessageBar (not a 500).

## Per-cloud notes

| Cloud | Edge | Notes |
|---|---|---|
| Commercial / GCC | Azure Front Door private link; ARM `management.azure.com` | Full topology; VNet data gateway capability **available** (tenant-gated) |
| GCC-High | ARM `management.usgovcloudapi.net`; VPN gateway available (`vpn-gateway.bicep`) | App Gateway WAF required; VNet data gateway **not offered** → card shows the unavailable gate + Azure-native private-endpoint equivalent |
| IL5 | US Gov ARM; `frontDoorEnabled=false` → App Gateway WAF only | VPN gateway path; VNet data gateway **not offered** (same as GCC-High) |

The VNet-gateway availability branch is driven by `detectLoomCloud()` /
`cloudBoundaryLabel()` (no hard-coded Commercial assumption), and the RP/subnet
reads go through `cloud-endpoints.armBase()` — cloud-correct by construction.

## Bicep sync

- `network.bicep` deploys the hub VNet + 9 subnets + private DNS zones for every
  PaaS service; `vpn-gateway.bicep` deploys the VPN gateway for hybrid boundaries.
- No new env var — both the private-endpoint discovery routes **and** the new
  `/api/network/vnet-data-gateway` route reuse `LOOM_SUBSCRIPTION_ID` +
  `LOOM_NETWORKING_RG` already wired in `admin-plane/main.bicep`. No new Azure
  resource or role: the VNet data gateway itself is a Fabric/Power Platform
  tenant capability Loom intentionally does not provision.
- The UAMI needs **Reader** on the networking scope (granted in the admin-plane
  RBAC module); absent that, the surface honest-gates rather than erroring. NSG
  discovery adds no new role — `Microsoft.Network/networkSecurityGroups/read` is
  already covered by Reader, and the `nsg-<subnet>` resources are already
  deployed by `network.bicep` (`nsgSubnets` + `subnetNsgAttach`), so no new
  Azure resource, env var, or grant is introduced by the topology enhancement.
- The PE→Loom-domain binding uses **Azure Resource Graph** (`Microsoft.ResourceGraph/resources`),
  which is covered by the same subscription **Reader** — no new role, env var, or
  Azure resource. The `loom-domain` tag it reads is stamped by `dlz-attach` on
  every DLZ resource (`DOMAIN_TAG_KEY`), so the binding lights up automatically
  for domain-scoped resources and stays blank (untagged) for shared/admin-plane
  ones, matching `topology-inventory.ts`'s chargeback convention.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — ARM network
  reads only, no Fabric host.
- Live walk: open `/admin/network`, confirm the private-endpoint inventory lists
  real endpoints with FQDN/IP/zone, the NSG inventory table lists the deployed
  `nsg-<subnet>` groups, and the topology canvas renders the hub VNet + subnets +
  NSG nodes + private endpoints with edges wired to the real subnet each PE lives
  in; click a node to confirm the detail drawer shows live ARM values (NSG rule
  grid, PE FQDN→IP→zone, subnet CIDR/delegations). Confirm the hosts-file block
  copies; revoke Reader and confirm the honest warning MessageBar instead of an
  error.
- VNet data gateway card: with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset, confirm the
  card reads the real `Microsoft.PowerPlatform` RP state + delegated subnet from
  ARM, shows the Azure-detectable rows as Detected/Action-needed and the
  capacity/installers/create rows as Fabric-tenant actions — and that there is
  **no create-gateway control**. `GET /api/network/vnet-data-gateway` returns
  `{ ok:true, readiness:{…} }` with no `api.fabric.microsoft.com` /
  `api.powerbi.com` call on the default path.

Grade: **A** — live ARM network discovery + topology + hosts block, backed by a
real hub-VNet bicep; only the Reader-role infra gate.
