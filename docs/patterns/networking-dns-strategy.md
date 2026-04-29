# Pattern — Networking & DNS Strategy

> **TL;DR:** **Private endpoints for everything that supports them**, **Private DNS zones in the hub linked to all spokes**, **no public IPs on data plane resources**, **Azure Firewall Premium** for egress + east-west inspection. Get DNS right or you'll spend a year debugging "why does Storage work in this VNet but not that one?"

## Problem

Private endpoints are the right answer for security, but DNS is where most teams get stuck. The public DNS name (`mystorage.blob.core.windows.net`) needs to resolve to the **private IP** when accessed from inside your VNet — and to the **public IP** when accessed from outside. That requires Private DNS zones, properly linked to the right VNets, with the right CNAME records.

## Architecture

```mermaid
flowchart TB
    subgraph Hub[Hub VNet — Connectivity Subscription]
        AzFW[Azure Firewall Premium<br/>+ DNS Proxy enabled]
        DNSResolver[Azure Private DNS Resolver<br/>optional, for on-prem]
        PrivateZones[Private DNS Zones:<br/>privatelink.blob.core.windows.net<br/>privatelink.dfs.core.windows.net<br/>privatelink.openai.azure.com<br/>privatelink.search.windows.net<br/>...]
    end

    subgraph Spoke1[Spoke 1 — DLZ]
        VNet1[VNet 10.20.0.0/22]
        Storage[Storage account<br/>+ Private Endpoint<br/>10.20.1.10]
        AOAI[AOAI<br/>+ Private Endpoint<br/>10.20.1.20]
    end

    subgraph Spoke2[Spoke 2 — Apps]
        VNet2[VNet 10.21.0.0/22]
        AppService[App Service<br/>+ VNet integration]
    end

    subgraph OnPrem[On-Premises]
        OnPremDNS[On-prem DNS<br/>conditional fwd<br/>privatelink.* → resolver]
        OnPremClient[Client machine]
    end

    PrivateZones -. linked to .-> VNet1
    PrivateZones -. linked to .-> VNet2
    AzFW -. uses .-> PrivateZones

    Storage -. PE registers A record<br/>mystorage.privatelink.blob... → 10.20.1.10 .-> PrivateZones
    AOAI -. PE registers A record .-> PrivateZones

    AppService -. resolves .-> PrivateZones
    AppService -. queries Storage .-> Storage

    OnPremClient -- DNS --> OnPremDNS
    OnPremDNS -- forward privatelink.* --> DNSResolver
    DNSResolver --> PrivateZones
    OnPremClient -- traffic --> AzFW
    AzFW --> Storage
```

## Pattern: one Private DNS zone per service, linked to ALL spokes

The most common anti-pattern is **per-spoke Private DNS zones** — each spoke creates its own `privatelink.blob.core.windows.net` zone. This breaks cross-spoke access because Spoke A's zone doesn't have Spoke B's PE A-records.

**Right pattern**:

```bicep
// In hub subscription / connectivity RG
resource blobZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.blob.core.windows.net'
  location: 'global'
}

// Link to every spoke VNet
resource blobZoneLinkSpoke1 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: blobZone
  name: 'spoke1-link'
  location: 'global'
  properties: {
    virtualNetwork: { id: spoke1VNet.id }
    registrationEnabled: false
  }
}
// ... repeat for every spoke
```

Then **all** private endpoints in **all** spokes register A records into the **single** zone. Resolution works everywhere.

## Pattern: required Private DNS zones (typical analytics platform)

| Service                           | Zone                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Storage Blob                      | `privatelink.blob.core.windows.net`                                                                                                                          |
| Storage DFS                       | `privatelink.dfs.core.windows.net`                                                                                                                           |
| Storage File                      | `privatelink.file.core.windows.net`                                                                                                                          |
| Storage Queue                     | `privatelink.queue.core.windows.net`                                                                                                                         |
| Key Vault                         | `privatelink.vaultcore.azure.net`                                                                                                                            |
| SQL DB                            | `privatelink.database.windows.net`                                                                                                                           |
| Synapse SQL                       | `privatelink.sql.azuresynapse.net`                                                                                                                           |
| Synapse Dev                       | `privatelink.dev.azuresynapse.net`                                                                                                                           |
| Cosmos                            | `privatelink.documents.azure.com`                                                                                                                            |
| Azure OpenAI / Cognitive Services | `privatelink.openai.azure.com`, `privatelink.cognitiveservices.azure.com`                                                                                    |
| AI Search                         | `privatelink.search.windows.net`                                                                                                                             |
| Container Registry                | `privatelink.azurecr.io`                                                                                                                                     |
| AKS                               | `privatelink.<region>.azmk8s.io`                                                                                                                             |
| Functions / App Service           | `privatelink.azurewebsites.net`                                                                                                                              |
| Event Hub                         | `privatelink.servicebus.windows.net`                                                                                                                         |
| Event Grid                        | `privatelink.eventgrid.azure.net`                                                                                                                            |
| Service Bus                       | `privatelink.servicebus.windows.net`                                                                                                                         |
| Purview                           | `privatelink.purview.azure.com`, `privatelink.purviewstudio.azure.com`                                                                                       |
| Azure Monitor                     | `privatelink.monitor.azure.com`, `privatelink.oms.opinsights.azure.com`, `privatelink.ods.opinsights.azure.com`, `privatelink.agentsvc.azure-automation.net` |

Provision **all** of these in the hub subscription up front, even if not yet used. Adding them later means re-linking all spokes.

## Pattern: DNS for on-prem clients

On-prem clients need to resolve `mystorage.privatelink.blob.core.windows.net` to the private IP across ExpressRoute. The right pattern uses **Azure Private DNS Resolver**:

```mermaid
flowchart LR
    OnPrem[On-prem client] --> OnPremDNS[On-prem DNS server]
    OnPremDNS -- conditional forwarder<br/>blob.core.windows.net --> Resolver[Private DNS Resolver<br/>inbound endpoint]
    Resolver --> PrivateZone[Private DNS Zone<br/>privatelink.blob...]
    Resolver -. answer 10.20.1.10 .-> OnPrem
    OnPrem -- traffic over ExpressRoute --> Storage[Storage PE 10.20.1.10]
```

Conditional forwarders on the on-prem DNS server forward `*.blob.core.windows.net` (and other Azure service domains) to the Private DNS Resolver inbound endpoint.

## Pattern: Azure Firewall Premium

Egress + east-west inspection should funnel through Azure Firewall:

| Capability            | Use for                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| **DNS Proxy**         | All workload DNS resolution → AzFW → Private DNS Zones (consistent resolution)                  |
| **FQDN-based egress** | Allow `*.openai.azure.com` outbound; deny `*.openai.com` (catches accidental public OpenAI use) |
| **TLS Inspection**    | For regulated workloads — inspect outbound TLS for DLP / threat                                 |
| **IDPS**              | Built-in IDS/IPS, signatures auto-updated                                                       |
| **URL filtering**     | Block known-bad categories outbound                                                             |

## Pattern: forced tunneling for on-prem proxy

If your org requires **all** Internet egress through an on-prem proxy:

- UDR on spoke subnets: 0.0.0.0/0 → AzFW
- AzFW route table: 0.0.0.0/0 → ExpressRoute → on-prem proxy
- On-prem proxy → Internet

Trade-off: latency penalty for any outbound HTTPS, including Azure SDK control-plane calls. Use `serviceEndpoints` for Azure services to avoid double-NAT.

## Pattern: NSG defaults

Every subnet has an NSG with **explicit deny by default** + **explicit allow** for required flows:

```bicep
resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-data-subnet'
  location: location
  properties: {
    securityRules: [
      {
        name: 'allow-https-inbound-from-vnet'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
        }
      }
      {
        name: 'deny-internet-inbound'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}
```

## Anti-patterns

| Anti-pattern                                            | What to do instead                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Per-spoke Private DNS zones                             | Single zone in hub, linked to all spokes                                                               |
| Public IPs on data plane resources                      | Private endpoints + AzFW for required egress                                                           |
| Custom DNS pointing at 8.8.8.8 in spokes                | Point at AzFW DNS proxy (which uses Private DNS zones)                                                 |
| `Allow Public Network Access` on Storage / KV / etc.    | Set to `Disabled` once private endpoints are wired                                                     |
| Service endpoints instead of private endpoints          | PE is strictly better — VNet integration + private IP. Use SE only as fallback for services without PE |
| Hub firewall as single point of failure                 | Zone-redundant deploy in single region; paired-region for DR                                           |
| Adding new Private DNS zones after spokes are populated | Provision all zones up front; re-linking is painful                                                    |

## Related

- [Reference Architecture — Hub-Spoke Topology](../reference-architecture/hub-spoke-topology.md)
- [Reference Architecture — Identity & Secrets Flow](../reference-architecture/identity-secrets-flow.md)
- [Best Practices — Security & Compliance](../best-practices/security-compliance.md)
- [Compliance — FedRAMP Moderate](../compliance/fedramp-moderate.md) (SC-7 Boundary Protection)
- [`deploy/bicep/landing-zone-alz/modules/networking/dns/`](https://github.com/fgarofalo56/csa-inabox/tree/main/deploy/bicep/landing-zone-alz/modules/networking/dns)
- Microsoft Private DNS for Private Endpoints: https://learn.microsoft.com/azure/private-link/private-endpoint-dns
