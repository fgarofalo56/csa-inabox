# Power BI private connectivity to CSA Loom — data gateways

CSA Loom backs its data services (Synapse serverless/dedicated SQL, ADLS, Azure
SQL, ADX) with `publicNetworkAccess=Disabled` + private endpoints in the hub
VNet. To let **Power BI reach that data privately — without ever traversing the
public internet** — Loom ships a **data gateway** so queries flow to the
PE-locked sources over the private plane.

There are two gateway kinds. As of the Weave → Power BI work (decision **D2**),
Loom's DEFAULT is the **VM-based on-premises data gateway**, which it deploys
automatically. The **managed VNet data gateway** is the preferred **auto-upgrade**
once a Fabric/Premium capacity is bound.

## Default-on: the VM on-premises data gateway

**Loom deploys this by default.**
`platform/fiab/bicep/modules/admin-plane/pbi-vm-data-gateway.bicep` is wired into
`admin-plane/main.bicep` with `pbiDataGatewayEnabled = true`, so a clean deploy
stands up:

- A small **Windows Server 2022 VM** (`vm-loom-pbigw-<location>`,
  `Standard_D2s_v5`) with **no public IP / no inbound**, its NIC joined to the
  hub **`snet-private-endpoints`** subnet — so it resolves every `privatelink.*`
  FQDN and reaches every PE-locked Loom source over the private plane.
- The **standard on-premises data gateway** installed **unattended** via a VM
  `runCommands` extension (`Install-DataGateway -AcceptConditions`, no interactive
  sign-in). The gateway opens an **outbound Azure Relay** tunnel to the Power BI
  service — Power BI never needs a public route to Loom data.
- The **recovery key** and **gateway name** stored in the admin-plane Key Vault
  (secrets `pbi-gateway-recovery-key`, `pbi-gateway-name`) for the one-time
  registration step below.
- The **Console UAMI** granted **Reader** on the VM so the admin **Network & DNS**
  pane can show the gateway's live status.

**Why the VM gateway is the default:** it works with **Power BI Pro** licenses —
no Premium/Fabric capacity required — so it is available on day one in every
deployment. It is available in **Commercial AND Gov** (GCC, GCC-High L4, DoD L5);
nothing here is Commercial-only.

To skip it (e.g. no Power BI in scope), set `pbiDataGatewayEnabled = false`.

### One-time tenant action to finish (honest gate)

The gateway software is installed by the deployment, but **registering it to the
Power BI/Fabric tenant requires an interactive Power BI admin credential**
("This command must be run with a user based credential", per Learn) — Loom
cannot do that from a deployment. Finish once, over Bastion (the VM has no public
inbound), or any machine that can reach the tenant:

```powershell
# 1. Sign in as a Power BI admin
Connect-DataGatewayServiceAccount

# 2. Register the installed gateway using the recovery key from Key Vault
#    (secret: pbi-gateway-recovery-key ; name: pbi-gateway-name)
Add-DataGatewayCluster `
  -RecoveryKey (ConvertTo-SecureString '<recovery-key-from-KV>' -AsPlainText -Force) `
  -GatewayName '<gateway-name-from-KV>'

# 3. In the Power BI service, bind Loom data-source connections to this gateway
#    (dataset/semantic model → Gateway connections → select this gateway),
#    using the Loom source's server + database.
```

This exact remediation is surfaced two ways (`no-vaporware.md`): the bicep
module's `registrationGate` output, and the Network pane's `registrationNote`
(`getPbiVmGatewayStatus()` in `apps/fiab-console/lib/azure/network-discovery.ts`).
In **GCC L2** the DataGateway PowerShell cmdlets are unsupported — the install
still lands; complete registration via the Power BI portal flow instead.

## Auto-upgrade: the managed VNet data gateway

When a **Fabric / Power BI Premium capacity** is later bound
(`LOOM_PBI_CAPACITY_ID` set), Loom **prefers the fully-managed VNet data gateway**
— it injects Microsoft-managed containers into a delegated subnet, keeps all
traffic on the Azure backbone (no VM to run), and scales node count on demand.

The selector is `LOOM_PBI_GATEWAY_MODE` (default `auto`, emitted default-on by
`admin-plane/main.bicep`):

| Mode | Behavior |
| --- | --- |
| `auto` (default) | VM gateway until `LOOM_PBI_CAPACITY_ID` binds, then the managed VNet gateway is recommended (`resolveRecommendedGatewayMode`) |
| `vm` | Force the VM on-premises gateway |
| `vnet` | Force the managed VNet gateway |

The Azure-side enabler for the VNet gateway **already ships by default**: the hub
network (`admin-plane/network.bicep`) includes a dedicated subnet
**`snet-pp-vnet-gateway`**, and the DLZ network (`landing-zone/network.bicep`)
includes **`snet-pbi-vnet-gateway`** — both delegated to
**`Microsoft.PowerPlatform/vnetaccesslinks`** (the delegation the VNet data
gateway requires). Loom reads the real prerequisite state over ARM (Reader-only)
— RP registration + subnet delegation — via `getVnetDataGatewayReadiness()`, then
shows an honest prerequisite checklist.

### One-time tenant action to bind a VNet gateway (honest gate)

The VNet gateway *itself* is created + bound as a Power BI/Fabric tenant
operation Loom can neither see nor perform:

1. **Register the resource provider** (once per subscription):
   `az provider register --namespace Microsoft.PowerPlatform`
2. **Create the VNet data gateway** — Fabric/Power BI portal →
   **Settings → Manage connections and gateways → Virtual network data gateways
   → New** → pick the capacity, the subscription, the resource group, the VNet,
   and the **`snet-pp-vnet-gateway`** subnet (only Power-Platform-delegated
   subnets appear).
   - Requires a **Power BI Premium capacity (A4+/P SKU)** or **any Fabric SKU**.
   - The account needs `Microsoft.Network/virtualNetworks/subnets/join/action`
     (e.g. Azure **Network Contributor**) on the VNet; when you create the Power
     Platform enterprise policy, grant its principal that action on the subnet.
3. **Bind a semantic model / connection** to the gateway (dataset →
   *Gateway connections* → select the VNet gateway), using the Loom source name +
   database. Power BI then reaches Loom data privately with no VM.

## Cloud availability (corrected in W4)

| Boundary | VM on-prem gateway (default) | Managed VNet data gateway |
| --- | --- | --- |
| Commercial | ✅ default-on | ✅ supported (needs Premium/Fabric capacity) |
| GCC (L2) | ✅ default-on (portal registration) | ❌ not offered — use the Azure-native PE plane |
| GCC-High (L4) | ✅ default-on | ✅ supported |
| DoD (L5) | ✅ default-on | ✅ supported |

> **Gov availability fix (W4).** `evaluateVnetGatewayReadiness()` previously had
> Gov availability inverted (GCC available, GCC-High/DoD unavailable). Microsoft
> Learn confirms the VNet data gateway is supported in Commercial, **GCC L4**
> (Texas + Virginia), and **L5** (DoD East), and is **not** offered in GCC L2.
> `apps/fiab-console/lib/azure/network-discovery.ts` now reflects this
> (`capabilityAvailable = Commercial || GCC-High || DoD`).

## Why a gateway at all — the Azure-native default still stands

Neither gateway is required for CSA Loom to function. Loom-native Power BI items
(report / paginated-report / dashboard / semantic-model minted by the Weave →
"Analyze in Power BI" edge) read the Azure-native backend directly over the
private plane — **no Fabric capacity, no Power BI workspace, and no gateway**
(`no-fabric-dependency.md`). The gateways exist only for the **opt-in real Power
BI Service** path (Weave W5), so that a Power BI report published to a real
workspace can still reach Loom's PE-locked sources.

## References

- On-premises data gateway (standard) — https://learn.microsoft.com/data-integration/gateway/service-gateway-onprem
- DataGateway PowerShell — https://learn.microsoft.com/powershell/gateway/overview?view=datagateway-ps
- `Add-DataGatewayCluster` — https://learn.microsoft.com/powershell/module/datagateway/add-datagatewaycluster
- Create VNet data gateways — https://learn.microsoft.com/data-integration/vnet/create-data-gateways
- VNet data gateway architecture — https://learn.microsoft.com/data-integration/vnet/data-gateway-architecture
- VNet gateway Azure Government support — https://learn.microsoft.com/data-integration/vnet/data-gateway-faqs#does-the-virtual-network-data-gateway-support-azure-government-cloud
- Power BI ↔ restricted lakehouse over a VNet gateway — https://learn.microsoft.com/fabric/security/security-workspace-private-links-example-power-bi-virtual-network
