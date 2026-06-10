# workspace-networking — parity with the Fabric workspace networking pane + Azure VNet/NSG/Private Endpoint blades

**Loom surface:** `lib/panes/networking.tsx` (`NetworkingPane`), reached from
**Workspace settings → Networking** (`lib/components/workspace-settings-drawer.tsx`).
**Client:** `lib/clients/networking-client.ts`.
**Routes:** `app/api/admin/workspaces/[id]/networking/{ip-rules,inbound,outbound,trusted}/route.ts`.

Source UI:
- Fabric workspace settings → Network security (inbound public-access protection,
  outbound access rules, workspace-level private link) —
  https://learn.microsoft.com/fabric/security/security-managed-private-endpoints-overview
- Azure portal → NSG security rules —
  https://learn.microsoft.com/azure/virtual-network/network-security-groups-overview
- Azure portal → Private endpoint —
  https://learn.microsoft.com/azure/private-link/create-private-endpoint-portal

> Per `no-fabric-dependency.md`, this surface is **Azure-native by default** — it
> writes real `Microsoft.Network` NSG security rules + private endpoints over ARM
> and requires **no** Fabric capacity or workspace. There is no Fabric backend
> for networking: the hub VNet + private-link plane IS the Azure-native parity.

## Azure / Fabric feature inventory (grounded in Learn)

| # | Capability (source UI) | Notes |
|---|------------------------|-------|
| 1 | **Inbound protection** — lock inbound access behind a private endpoint | Fabric "Inbound public access" toggle ≈ Azure private endpoint protecting the bound resource |
| 2 | Show inbound PE provisioning + connection state | portal PE overview |
| 3 | **Outbound access rules** — managed private endpoints to target resources | Fabric "Managed private endpoints"; add by target ARM id + sub-resource |
| 4 | Delete an outbound rule (and its PE) | portal PE delete |
| 5 | **IP firewall** — allow/deny inbound or outbound IP ranges | Azure NSG security rules grid |
| 6 | Add an IP firewall rule (CIDR, direction, access, protocol, auto-priority) | NSG securityRules PUT |
| 7 | Delete an IP firewall rule | NSG securityRules DELETE |
| 8 | List existing rules incl. platform-managed (read-only) | NSG securityRules GET |
| 9 | **Trusted instances** — named IP allowlist | Azure SQL/Storage "trusted instances/firewall" pattern as a labeled allowlist |
| 10 | Add / remove a trusted instance (writes a real NSG allow-rule) | NSG allow-rule + Cosmos registry |
| 11 | Private DNS registration for an inbound PE (optional) | privateDnsZoneGroups PUT |
| 12 | Honest infra gate when role/env missing | per `no-vaporware.md` |

## Loom coverage

| # | Loom control | Status | Backend (real) |
|---|--------------|--------|----------------|
| 1 | Inbound-protection `Switch` + target form | ✅ built | `POST .../inbound` → `createPrivateEndpoint` (ARM PUT `privateEndpoints`) |
| 2 | PE state `Badge` (provisioning + connection) | ✅ built | `GET .../inbound` → `getPrivateEndpoint` (ARM GET) |
| 3 | Outbound-rule grid + "Add private endpoint" dialog | ✅ built | `POST .../outbound` → `addOutboundPeRule` → `createPrivateEndpoint` |
| 4 | Outbound delete | ✅ built | `DELETE .../outbound` → `removeOutboundRule` (ARM DELETE PE + Cosmos) |
| 5 | IP-firewall grid (direction / access / priority / range) | ✅ built | `GET .../ip-rules` → `listNsgRules` (ARM GET securityRules) |
| 6 | IP-firewall add row (CIDR validated, priority auto-assigned) | ✅ built | `POST .../ip-rules` → `addIpFirewallRule` → `putNsgRule` (ARM PUT securityRule) |
| 7 | IP-firewall delete (managed rules only) | ✅ built | `DELETE .../ip-rules` → `deleteNsgRule` (ARM DELETE) |
| 8 | Platform-managed rules shown read-only | ✅ built | delete disabled unless `name` starts `loom-` |
| 9 | Trusted-instances grid + add row | ✅ built | `GET/POST .../trusted` → `addTrustedInstance` (real NSG allow-rule + Cosmos) |
| 10 | Trusted-instance remove | ✅ built | `DELETE .../trusted` → `removeTrustedInstance` (ARM DELETE + Cosmos) |
| 11 | Optional DNS-zone registration field on inbound | ✅ built | `createPrivateDnsZoneGroup` (ARM PUT) |
| 12 | Honest gate MessageBars (env 503 / role 403 / PE-subnet) | ⚠️ honest-gate | `_gate.ts` maps `NetworkingNotConfiguredError`→503, ARM 403→Network Contributor remediation |

Zero ❌ — every inventory row is built ✅ or an honest gate ⚠️.

## Backend per control

- **NSG security rules** (IP firewall + trusted instances):
  `Microsoft.Network/networkSecurityGroups/securityRules` — `api-version=2024-05-01`
  (same version `network.bicep` declares). Target NSG = `LOOM_NSG_NAME`
  (default `nsg-snet-private-endpoints`).
- **Private endpoints** (inbound + outbound): `Microsoft.Network/privateEndpoints`
  + `privateDnsZoneGroups` — `api-version=2024-03-01`. Created into
  `LOOM_PE_SUBNET_ID` (`snet-private-endpoints`).
- **Registry** (trusted instances + outbound rules): Cosmos `networking-config`
  container, PK `/workspaceId`, one doc per workspace.
- **Auth:** `ChainedTokenCredential(UAMI → DefaultAzureCredential)` on the ARM
  scope. UAMI needs **Network Contributor** (`4d97b98b-1d4f-4787-a291-c67834d212e7`)
  on `LOOM_NETWORKING_RG` — granted by `network.bicep`.

## Per-cloud notes

| Cloud | ARM base (`armBase()`) | NSG / PE API | Firewall tier (network.bicep) |
|-------|------------------------|--------------|-------------------------------|
| Commercial | management.azure.com | 2024-05-01 / 2024-03-01 | Standard |
| GCC | management.azure.com | same | Standard |
| GCC-High / IL5 | management.usgovcloudapi.net | same | Premium |
| DoD | management.azure.microsoft.scloud | same | Premium |

All hosts resolve through `cloud-endpoints.armBase()` — no hard-coded
`management.azure.com`. Private DNS zone suffixes already differ correctly per
boundary in `network.bicep`; the inbound DNS-zone-group call takes the zone ARM
id as input so it is cloud-correct by construction.

## Bicep sync

- `network.bicep` — new `consolePrincipalId` + `skipRoleGrants` params; Network
  Contributor `roleAssignment` on the networking RG; new output
  `nsgPrivateEndpointsName`.
- `admin-plane/main.bicep` — `network` module now receives
  `consolePrincipalId` / `skipRoleGrants`; Console app gets
  `LOOM_NETWORKING_RG`, `LOOM_HUB_VNET_NAME`, `LOOM_PE_SUBNET_ID`, `LOOM_NSG_NAME`.
- `cosmos-client.ts` — new lazily-created `networking-config` container.

## Validation

- `lib/clients/__tests__/networking-client.test.ts` — CIDR validation, ARM-safe
  rule naming, priority allocation, honest-gate config reader.
- Live E2E (operator, post-deploy): with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET,
  add an IP firewall range → confirm a real NSG securityRule appears
  (`az network nsg rule list -g <rg> --nsg-name nsg-snet-private-endpoints`);
  enable inbound protection → confirm a real private endpoint
  (`az network private-endpoint show -g <rg> -n pe-loom-<ws>-inbound`); with the
  Network Contributor grant removed, confirm the pane shows the honest 403
  MessageBar naming the role.
