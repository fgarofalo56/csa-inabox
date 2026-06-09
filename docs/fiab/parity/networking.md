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
  `listPrivateDnsZones`, `listVirtualNetworks`, `buildHostsBlock`
- Bicep: `platform/fiab/bicep/modules/admin-plane/network.bicep`,
  `platform/fiab/bicep/modules/admin-plane/vpn-gateway.bicep`

The network surface reads the deployment's own VNet / private endpoints / private
DNS via ARM. There is **no dependency on real Microsoft Fabric** — it works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Inventory private endpoints (resource, sub-resource, FQDN, private IP, zone)
2. Private DNS zones
3. VNet / subnet topology
4. Guidance to resolve private FQDNs from on-prem / enterprise DNS
5. VPN / hybrid connectivity

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Private endpoint inventory (resource, sub-resource, FQDN, IP, zone) | ✅ Built | `GET /api/network/private-endpoints` → ARM `listPrivateEndpoints()` (UAMI) |
| Private DNS zone enumeration | ✅ Built | `listPrivateDnsZones()` |
| VNet topology view | ✅ Built | `listVirtualNetworks()` → `NetworkTopologyCanvas` |
| Copy/paste hosts-file block | ✅ Built | `buildHostsBlock(endpoints, dnsZones)` → UI copy button |
| Enterprise DNS guidance (conditional forwarders / DNS Private Resolver / VNet-links / VPN) | ✅ Built | Static guidance rendered in `NetworkPane` |
| Hub VNet + 9 subnets (Firewall, Bastion, Container-platform, Functions, APIM, Private-Endpoints, Reserved, GatewaySubnet, AppGW) | ✅ Built | `network.bicep` subnet layout |
| Honest gate when Reader role missing | ⚠️ Honest gate | `NetworkDiscoveryError` → 200 + warning MessageBar naming `Microsoft.Network/privateEndpoints/read` |

Zero ❌ rows. The single ⚠️ gate (Reader role) keeps the page rendering and
names the exact ARM action to grant, per `no-vaporware.md`.

## Backend per control

- **Inventory** — `network-discovery.ts` calls ARM with the console UAMI:
  `listPrivateEndpoints()` (each endpoint's resource, group id / sub-resource,
  custom DNS FQDN, private IP, linked zone), `listPrivateDnsZones()`,
  `listVirtualNetworks()`.
- **Hosts block** — `buildHostsBlock()` joins endpoints to their resolved IPs to
  emit a copyable `hosts` file fragment for clients that can't reach the private
  DNS zone.
- **Topology** — `NetworkTopologyCanvas` renders VNets → subnets → endpoints.
- **Gate** — when the UAMI lacks Reader on the network scope,
  `NetworkDiscoveryError` returns 200 with an honest MessageBar (not a 500).

## Per-cloud notes

| Cloud | Edge | Notes |
|---|---|---|
| Commercial / GCC | Azure Front Door private link; ARM `management.azure.com` | Full topology |
| GCC-High | ARM `management.usgovcloudapi.net`; VPN gateway available (`vpn-gateway.bicep`) | App Gateway WAF required |
| IL5 | US Gov ARM; `frontDoorEnabled=false` → App Gateway WAF only | VPN gateway path |

## Bicep sync

- `network.bicep` deploys the hub VNet + 9 subnets + private DNS zones for every
  PaaS service; `vpn-gateway.bicep` deploys the VPN gateway for hybrid boundaries.
- No new env var — the discovery routes use the console UAMI already wired in
  `admin-plane/main.bicep`.
- The UAMI needs **Reader** on the networking scope (granted in the admin-plane
  RBAC module); absent that, the surface honest-gates rather than erroring.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — ARM network
  reads only, no Fabric host.
- Live walk: open `/admin/network`, confirm the private-endpoint inventory lists
  real endpoints with FQDN/IP/zone, the topology canvas renders the hub VNet +
  subnets, and the hosts-file block copies; revoke Reader and confirm the honest
  warning MessageBar instead of an error.

Grade: **A** — live ARM network discovery + topology + hosts block, backed by a
real hub-VNet bicep; only the Reader-role infra gate.
