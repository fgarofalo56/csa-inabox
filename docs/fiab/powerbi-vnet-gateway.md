# Power BI private connectivity to CSA Loom — VNet data gateway

CSA Loom backs its data services (Synapse, ADLS, SQL, lakehouse) with
`publicNetworkAccess=Disabled` + private endpoints. To let **Power BI / Fabric
reach that data privately — without ever traversing the public internet** — Loom
uses a **virtual network (VNet) data gateway**, a Microsoft-managed gateway whose
containers are injected into a delegated subnet in the DLZ. All traffic stays on
the Azure backbone (an internal Microsoft tunnel), so no on-prem gateway VM and
no public exposure.

## What Loom deploys automatically

Every DLZ network (`platform/fiab/bicep/modules/landing-zone/network.bicep`)
includes a dedicated subnet **`snet-pbi-vnet-gateway`** (`<spoke>.11.0/27`):

- Delegated to **`Microsoft.PowerPlatform/vnetaccesslinks`** (the delegation the
  VNet data gateway requires).
- `Microsoft.Storage` service endpoint enabled (in-region ADLS per MS guidance).
- Not shared with any other resource (a hard requirement of the gateway).

That is the entire Azure-side enabler — it ships by default, in Commercial and
Gov (the feature is supported in sovereign clouds).

## One-time tenant action to finish (honest gate)

The gateway *registration* is a Power BI / Fabric tenant operation and can't be
done from the infra deployment. After a DLZ is deployed:

1. **Register the resource provider** (once per subscription):
   `az provider register --namespace Microsoft.PowerPlatform`
2. **Create the VNet data gateway** — in the Fabric/Power BI portal →
   **Settings → Manage connections and gateways → Virtual network data gateways
   → New** → pick the license capacity, the DLZ subscription, the DLZ resource
   group, the DLZ VNet, and the **`snet-pbi-vnet-gateway`** subnet (only
   Power-Platform-delegated subnets appear).
   - Requires a **Power BI Premium capacity (A4+/P SKU)** or **any Fabric SKU**.
   - The account needs `Microsoft.Network/virtualNetworks/subnets/join/action`
     (e.g. Azure **Network Contributor**) on the DLZ VNet.
3. **Bind a semantic model / connection** to the new gateway (Power BI dataset →
   *Gateway connections* toggle → select the VNet gateway), using the Loom
   service name + database. From then on Power BI reaches Loom data privately.

## Why not the on-premises (standard) gateway?

The on-prem gateway needs a VM and opens an Azure Relay connection back to the
Power BI service. The VNet data gateway is fully managed (no VM), keeps all
traffic on the Azure backbone, and scales its node count on demand — so it's the
default Loom recommendation. The on-prem gateway remains an option for sources
that aren't reachable from the DLZ VNet.

## References

- Create VNet data gateways — https://learn.microsoft.com/data-integration/vnet/create-data-gateways
- VNet data gateway architecture — https://learn.microsoft.com/data-integration/vnet/data-gateway-architecture
- Power BI ↔ restricted lakehouse over a VNet gateway — https://learn.microsoft.com/fabric/security/security-workspace-private-links-example-power-bi-virtual-network
